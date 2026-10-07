using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Foundation.Metadata;
using Windows.Management.Deployment;

namespace ChiefUpdater;

/// <summary>A failed Windows call: the text Windows gave (DeploymentResult.ErrorText when there is one) and its HRESULT.</summary>
sealed class DeploymentFailure : Exception
{
    readonly int detail;

    /// <param name="detail">DeploymentResult.ExtendedErrorCode when Windows gives one: the specific cause.</param>
    public DeploymentFailure(string message, int hresult, int detail = 0) : base(message)
    {
        HResult = hresult;
        this.detail = detail;
    }

    public string Code => Errors.Code(HResult);

    /// <summary>
    /// A sentence for the popup. ErrorText is a paragraph naming volumes, manifests and a help link (it stays in the
    /// log and the result file); Windows' own message for the specific error is what fits in two lines.
    /// </summary>
    public string Summary => Errors.SystemMessage(detail != 0 ? detail : HResult) ?? Errors.OneLine(Message);
}

/// <summary>The package Chief runs from now.</summary>
sealed class InstalledPackage
{
    public string Name = "";
    public string PublisherId = "";
    public string Architecture = "";
    public string Version = "";
    public string FamilyName = "";
    public string Location = "";
    public PackageVolume? Volume;

    /// <summary>The same identity at another version: Name_Version_Arch__PublisherId (no resource id).</summary>
    public string FullNameFor(string version) => $"{Name}_{version}_{Architecture}__{PublisherId}";
}

interface IDeployment
{
    InstalledPackage? FindInstalled(string packageName);
    Task StageAsync(string packageFile, InstalledPackage installed, IProgress<int> progress);
    Task RegisterAsync(string fullName, IProgress<int> progress);
    Task AddAsync(string packageFile, InstalledPackage installed, IProgress<int> progress);
    Task<uint> ActivateAsync(string aumid);
}

static class Deployments
{
    public static IDeployment Create(Job job, Options options) =>
        options.Simulate ? new SimulatedDeployment(job, options) : new WindowsDeployment();
}

/// <summary>Windows.Management.Deployment.PackageManager for the current user (no elevation).</summary>
sealed class WindowsDeployment : IDeployment
{
    const string ManagerType = "Windows.Management.Deployment.PackageManager";
    readonly PackageManager manager = new();

    public InstalledPackage? FindInstalled(string packageName)
    {
        Windows.ApplicationModel.Package? best = null;
        foreach (var p in manager.FindPackagesForUser(string.Empty))
        {
            if (!string.Equals(p.Id.Name, packageName, StringComparison.OrdinalIgnoreCase)) continue;
            if (best is null || Compare(p.Id.Version, best.Id.Version) > 0) best = p;
        }
        if (best is null) return null;

        string location = "";
        try { location = best.InstalledLocation.Path; }
        catch (Exception) { /* a package being serviced can refuse this; the volume and the quiet check then go without */ }

        var v = best.Id.Version;
        return new InstalledPackage
        {
            Name = best.Id.Name,
            PublisherId = best.Id.PublisherId,
            Architecture = ArchitectureName(best.Id.Architecture),
            Version = $"{v.Major}.{v.Minor}.{v.Build}.{v.Revision}",
            FamilyName = best.Id.FamilyName,
            Location = location,
            Volume = VolumeOf(location),
        };
    }

    /// <summary>
    /// An update stays on the drive Chief was installed on (the installer can put it on another one); Windows would
    /// otherwise stage it on its default app drive. Same rule as the PowerShell in src/install-package.ts.
    /// </summary>
    PackageVolume? VolumeOf(string location)
    {
        if (location.Length == 0) return null;
        try
        {
            foreach (var volume in manager.FindPackageVolumes())
            {
                string store = volume.PackageStorePath ?? "";
                if (store.Length > 0 && location.StartsWith(store.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return volume;
            }
        }
        catch (Exception) { /* no volume list: Windows picks the drive */ }
        return null;
    }

    public Task StageAsync(string packageFile, InstalledPackage installed, IProgress<int> progress)
    {
        var uri = new Uri(packageFile);
        if (ApiInformation.IsMethodPresent(ManagerType, "StagePackageByUriAsync"))
        {
            var options = new StagePackageOptions { ForceUpdateFromAnyVersion = true };
            if (installed.Volume is not null) options.TargetVolume = installed.Volume;
            return Run(manager.StagePackageByUriAsync(uri, options), progress);
        }
        return Run(manager.StagePackageAsync(uri, null), progress);
    }

    public Task RegisterAsync(string fullName, IProgress<int> progress) =>
        Run(manager.RegisterPackageByFullNameAsync(fullName, null, DeploymentOptions.ForceApplicationShutdown | DeploymentOptions.ForceUpdateFromAnyVersion), progress);

    public Task AddAsync(string packageFile, InstalledPackage installed, IProgress<int> progress)
    {
        var uri = new Uri(packageFile);
        if (ApiInformation.IsMethodPresent(ManagerType, "AddPackageByUriAsync"))
        {
            var options = new AddPackageOptions { ForceAppShutdown = true, ForceUpdateFromAnyVersion = true };
            if (installed.Volume is not null) options.TargetVolume = installed.Volume;
            return Run(manager.AddPackageByUriAsync(uri, options), progress);
        }
        return Run(manager.AddPackageAsync(uri, null, DeploymentOptions.ForceApplicationShutdown | DeploymentOptions.ForceUpdateFromAnyVersion), progress);
    }

    public Task<uint> ActivateAsync(string aumid) => Task.Run(() =>
    {
        // Lets the app take the foreground: it wasn't started by a click, so Windows would otherwise open it behind.
        Native.AllowSetForegroundWindow(Native.ASFW_ANY);
        var activation = (Native.IApplicationActivationManager)new Native.ApplicationActivationManager();
        try
        {
            int hr = activation.ActivateApplication(aumid, null, Native.AO_NONE, out uint pid);
            if (hr < 0) throw new DeploymentFailure(Errors.SystemMessage(hr) ?? "Windows couldn't start the app.", hr);
            return pid;
        }
        finally
        {
            Marshal.ReleaseComObject(activation);
        }
    });

    /// <summary>
    /// Awaits a deployment operation. Not AsTask(): on failure it drops the DeploymentResult, whose ErrorText is the
    /// only place Windows says what went wrong in words.
    /// </summary>
    static Task Run(IAsyncOperationWithProgress<DeploymentResult, DeploymentProgress> operation, IProgress<int> progress)
    {
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        operation.Progress = (_, p) => progress.Report((int)Math.Min(100u, p.percentage));
        operation.Completed = (op, status) =>
        {
            switch (status)
            {
                case AsyncStatus.Completed:
                    done.TrySetResult(true);
                    break;
                case AsyncStatus.Error:
                    int hr = op.ErrorCode?.HResult ?? unchecked((int)0x80004005);
                    string text = "";
                    int detail = 0;
                    try
                    {
                        var result = op.GetResults();
                        text = result?.ErrorText ?? "";
                        detail = result?.ExtendedErrorCode?.HResult ?? 0;
                    }
                    catch (Exception) { /* no result object for this failure */ }
                    if (text.Trim().Length == 0) text = op.ErrorCode?.Message ?? "The deployment failed.";
                    done.TrySetException(new DeploymentFailure(text, hr, detail));
                    break;
                default:
                    done.TrySetException(new DeploymentFailure("The deployment was cancelled.", unchecked((int)0x800704C7)));
                    break;
            }
        };
        return done.Task;
    }

    static int Compare(Windows.ApplicationModel.PackageVersion a, Windows.ApplicationModel.PackageVersion b) =>
        a.Major != b.Major ? a.Major.CompareTo(b.Major)
        : a.Minor != b.Minor ? a.Minor.CompareTo(b.Minor)
        : a.Build != b.Build ? a.Build.CompareTo(b.Build)
        : a.Revision.CompareTo(b.Revision);

    static string ArchitectureName(Windows.System.ProcessorArchitecture a) => a switch
    {
        Windows.System.ProcessorArchitecture.X64 => "x64",
        Windows.System.ProcessorArchitecture.X86 => "x86",
        Windows.System.ProcessorArchitecture.Arm => "arm",
        Windows.System.ProcessorArchitecture.Arm64 => "arm64",
        Windows.System.ProcessorArchitecture.Neutral => "neutral",
        _ => a.ToString().ToLowerInvariant(),
    };
}

/// <summary>
/// --simulate: plausible timings and progress, no package touched. --simulate-fail picks the step that fails:
/// "register" (the staged copy is gone and there's no package file to fall back on), "add" (the fallback runs and
/// fails too), "launch" (the AppModel refuses to start the app), "stage".
/// </summary>
sealed class SimulatedDeployment : IDeployment
{
    readonly Job job;
    readonly string? fail;
    readonly double slow;

    public SimulatedDeployment(Job job, Options options)
    {
        this.job = job;
        fail = options.SimulateFail;
        slow = options.Slow;
    }

    public bool SkipFallback => fail == "register";

    int Ms(double ms) => (int)(ms * slow);

    public InstalledPackage? FindInstalled(string packageName) => new()
    {
        Name = packageName,
        PublisherId = "simulated0000",
        Architecture = "x64",
        Version = job.From + ".0",
        FamilyName = packageName + "_simulated0000",
        Location = $@"C:\Program Files\WindowsApps\{packageName}_{job.From}.0_x64__simulated0000",
    };

    public async Task StageAsync(string packageFile, InstalledPackage installed, IProgress<int> progress)
    {
        for (int pct = 0; pct <= 100; pct += 2)
        {
            if (fail == "stage" && pct == 64) throw new DeploymentFailure("There is not enough space on the disk.", unchecked((int)0x80070070));
            progress.Report(pct);
            await Task.Delay(Ms(58));
        }
    }

    public Task RegisterAsync(string fullName, IProgress<int> progress) =>
        Deploy(progress, fail is "register" or "add" ? 35 : -1,
            new DeploymentFailure($"Windows couldn't find the prepared update {fullName}. The package could not be found.", unchecked((int)0x80073CF1)));

    public Task AddAsync(string packageFile, InstalledPackage installed, IProgress<int> progress) =>
        Deploy(progress, fail == "add" ? 52 : -1,
            new DeploymentFailure("Deployment failed with HRESULT: 0x80070070, There is not enough space on the disk.", unchecked((int)0x80070070)));

    /// <summary>A second of 0 % (Windows' own pause before it reports), then a steady climb; fails at failAt when set.</summary>
    async Task Deploy(IProgress<int> progress, int failAt, Exception failure)
    {
        progress.Report(0);
        await Task.Delay(Ms(1000));
        for (int pct = 4; pct <= 100; pct += 4)
        {
            if (failAt >= 0 && pct >= failAt)
            {
                await Task.Delay(Ms(300));
                throw failure;
            }
            progress.Report(pct);
            await Task.Delay(Ms(100));
        }
    }

    public async Task<uint> ActivateAsync(string aumid)
    {
        await Task.Delay(Ms(300));
        if (fail == "launch") throw new DeploymentFailure("The process cannot access the file because it is being used by another process.", unchecked((int)0x80070020));
        return 4242;
    }
}
