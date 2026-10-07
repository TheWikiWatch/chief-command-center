using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Shell;
using System.Windows.Threading;

namespace ChiefUpdater;

/// <summary>
/// apply: the popup's flow. Close (0–10 %) → install (10–90 %) → open (90–100 %) → wait for the new app's ready file.
/// Whatever happens Chief is reopened, the outcome lands in resultFile for the next boot's card, and the process
/// ends on its own (a hard cap of six minutes).
/// </summary>
static class ApplyMode
{
    public static readonly TimeSpan HardCap = TimeSpan.FromMinutes(6);

    public static int Run(Job job, Options options)
    {
        var log = new Log(job.LogFile, $"apply {job.From} -> {job.To}: ");
        // One popup at a time: a second click on "Restart now" must not start a second install.
        using var single = new Mutex(true, @"Local\ChiefCommandCenter.Updater.Apply", out bool first);
        if (!first)
        {
            log.Note("another update is already being applied; this one stops");
            return 1;
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var flow = new ApplyFlow(job, options, log, app);
        app.DispatcherUnhandledException += (_, e) =>
        {
            e.Handled = true;
            flow.Crash(e.Exception);
        };
        app.Startup += (_, _) => flow.Start();
        return app.Run();
    }
}

sealed class ApplyFlow
{
    readonly Job job;
    readonly Options options;
    readonly Log log;
    readonly Application app;
    readonly IDeployment deployment;
    readonly PopupWindow window;
    readonly double slow;
    InstalledPackage? installed;
    string step = "close";
    bool resultWritten;
    bool exiting;

    public ApplyFlow(Job job, Options options, Log log, Application app)
    {
        this.job = job;
        this.options = options;
        this.log = log;
        this.app = app;
        deployment = Deployments.Create(job, options);
        window = new PopupWindow(job);
        slow = options.Simulate ? options.Slow : 1;
    }

    string Assistant => job.AssistantName;

    public void Start()
    {
        var cap = new DispatcherTimer { Interval = ApplyMode.HardCap };
        cap.Tick += (_, _) =>
        {
            cap.Stop();
            log.Note($"stopped after {ApplyMode.HardCap.TotalMinutes:0} minutes (step {step})");
            WriteResult(false, step, "The updater stopped after six minutes.", "");
            Exit(1);
        };
        cap.Start();
        _ = RunGuarded();
    }

    async Task RunGuarded()
    {
        int code;
        try
        {
            code = await RunAsync();
        }
        catch (Exception e)
        {
            Crash(e);
            return;
        }
        Exit(code);
    }

    public void Crash(Exception e)
    {
        if (exiting) return;
        var (message, code) = Errors.Describe(e);
        log.Note($"unexpected error at step {step}: {message} ({code})");
        WriteResult(false, step, message, code);
        // Chief is never left closed: once it has been asked to close, try to open whatever version is installed.
        if (step != "close")
        {
            try
            {
                var family = installed?.FamilyName ?? "";
                if (family.Length > 0 && !options.Simulate) deployment.ActivateAsync($"{family}!{job.AppId}").Wait(TimeSpan.FromSeconds(15));
            }
            catch (Exception reopen)
            {
                log.Note($"reopening failed: {Errors.OneLine(reopen.Message)}");
            }
        }
        Exit(1);
    }

    static DeploymentFailure AsFailure(Exception e) =>
        e as DeploymentFailure ?? (e is AggregateException { InnerException: { } inner } ? AsFailure(inner) : new DeploymentFailure(e.Message, e.HResult));

    async Task<int> RunAsync()
    {
        log.Note($"{(job.IsRollback ? "rollback" : "update")} started{(options.Simulate ? " (simulated" + (options.SimulateFail is { } f ? ", fail " + f : "") + ")" : "")}");
        window.SetStep($"Closing {Assistant}…");
        window.Show();
        await window.Shown;
        Touch(job.ShownFile);
        log.Note("popup shown");

        // 1. Closing (0–10 %).
        installed = await Task.Run(() => deployment.FindInstalled(job.PackageName));
        if (installed is null) log.Note($"{job.PackageName} isn't installed for this user; installing from the package file");
        await WaitForAppExit();
        if (installed is not null) await WaitForQuiet(installed.Location);
        // A ready file from an earlier start would end the wait at once.
        DeleteReady(job.To);
        DeleteReady(job.From);
        window.SetProgress(10);

        // 2. Installing (10–90 %).
        step = "register";
        window.SetStep("Installing…");
        window.SetIndeterminate();
        var progress = new Progress<int>(pct =>
        {
            if (pct > 0) window.SetProgress(10 + pct * 0.8);
        });
        DeploymentFailure? failure = null;
        if (installed is not null)
        {
            string fullName = installed.FullNameFor(job.PackageVersion);
            try
            {
                log.Note($"registering the staged package {fullName}");
                await deployment.RegisterAsync(fullName, progress);
                log.Note("registered the staged package");
            }
            catch (Exception e)
            {
                failure = AsFailure(e);
                log.Note($"registering failed: {Errors.OneLine(failure.Message)} ({failure.Code})");
            }
        }
        if (failure is not null || installed is null)
        {
            bool canAdd = options.Simulate ? !(deployment is SimulatedDeployment { SkipFallback: true }) : File.Exists(job.PackageFile);
            if (!canAdd)
            {
                log.Note($"no package file to fall back on: {job.PackageFile}");
                failure ??= new DeploymentFailure($"{job.PackageName} isn't installed, and the update file is missing.", unchecked((int)0x80070002));
                return await Failed("register", failure);
            }
            step = "add";
            try
            {
                log.Note($"installing from the package file {Path.GetFileName(job.PackageFile)}");
                await deployment.AddAsync(job.PackageFile, installed ?? new InstalledPackage(), progress);
                log.Note("installed from the package file");
            }
            catch (Exception e)
            {
                var add = AsFailure(e);
                log.Note($"installing from the package file failed: {Errors.OneLine(add.Message)} ({add.Code})");
                return await Failed("add", add);
            }
        }

        // 3. Opening (90–100 %): creeps toward 98 while the new version starts.
        step = "launch";
        window.SetStep($"Opening {Assistant}…");
        window.SetProgress(90);
        var opening = Stopwatch.StartNew();
        var creep = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        creep.Tick += (_, _) => window.SetProgress(90 + 8 * (1 - Math.Exp(-opening.Elapsed.TotalSeconds / 12)));
        creep.Start();
        try
        {
            string aumid = await Aumid(installed);
            log.Note($"opening {aumid}");
            uint pid = await deployment.ActivateAsync(aumid);
            log.Note($"opened (pid {pid}); waiting for its window");
        }
        catch (Exception e)
        {
            creep.Stop();
            return await LaunchFailed(AsFailure(e));
        }
        SimulateReady(job.To);

        // 4. Ready: the new app writes ready-<version> once its window shows.
        step = "ready";
        bool ready = await WaitForFile(ReadyFile(job.To), ReadyTimeout);
        creep.Stop();
        if (!ready) return await TimedOut();

        log.Note($"ready after {opening.Elapsed.TotalSeconds:0.0} s");
        WriteResult(true, "ready", "", "");
        window.SetProgress(100);
        await Task.Delay(450); // let the bar visibly reach the end
        await window.CloseAsync();
        return 0;
    }

    // ---- Steps ---------------------------------------------------------------------------------------------------

    async Task WaitForAppExit()
    {
        if (options.Simulate) await Task.Delay(Ms(1200));
        if (job.AppPid <= 0) return;
        Process? process = null;
        try { process = Process.GetProcessById(job.AppPid); }
        catch (ArgumentException) { return; } // already gone
        using (process)
        {
            log.Note($"waiting for {Assistant} (pid {job.AppPid}) to close");
            var watch = Stopwatch.StartNew();
            while (!HasExited(process) && watch.Elapsed < TimeSpan.FromSeconds(30)) await Task.Delay(200);
            log.Note(HasExited(process) ? $"{Assistant} closed" : $"{Assistant} is still running after 30 s; going ahead");
        }
    }

    static bool HasExited(Process p)
    {
        try { return p.HasExited; }
        catch (Exception) { return false; } // no right to ask: assume it runs, the 30 s cap still applies
    }

    /// <summary>
    /// Waits until nothing runs from the old package folder (Hermes, the dashboard server, helpers). Registering
    /// while the old desktop container is alive is a known failure (0x80070020 at launch, until sign-out). After
    /// 20 s it goes ahead: ForceApplicationShutdown stops what's left.
    /// </summary>
    async Task WaitForQuiet(string location)
    {
        if (options.Simulate)
        {
            await Task.Delay(Ms(500));
            return;
        }
        if (location.Length == 0) return;
        var watch = Stopwatch.StartNew();
        var busy = await Task.Run(() => Native.ProcessesUnder(location));
        while (busy.Count > 0 && watch.Elapsed < TimeSpan.FromSeconds(20))
        {
            await Task.Delay(250);
            busy = await Task.Run(() => Native.ProcessesUnder(location));
        }
        log.Note(busy.Count == 0
            ? $"package folder quiet after {watch.Elapsed.TotalSeconds:0.0} s"
            : $"still running from the package after 20 s: {string.Join(", ", busy)}; going ahead");
    }

    async Task<string> Aumid(InstalledPackage? before)
    {
        // The family doesn't change between versions, but ask again: the package now installed is the authority.
        string family = options.Simulate ? before?.FamilyName ?? "" : (await Task.Run(() => deployment.FindInstalled(job.PackageName)))?.FamilyName ?? before?.FamilyName ?? "";
        if (family.Length == 0) throw new DeploymentFailure($"{job.PackageName} isn't installed.", unchecked((int)0x80073CF1));
        return $"{family}!{job.AppId}";
    }

    // ---- Outcomes ------------------------------------------------------------------------------------------------

    /// <summary>The install failed: say so, reopen the old version, close once it shows (the message stays ≥ 2.5 s).</summary>
    async Task<int> Failed(string failedStep, DeploymentFailure e)
    {
        step = failedStep;
        WriteResult(false, failedStep, Errors.OneLine(e.Message), e.Code);
        window.ShowMessage(job.IsRollback ? $"{Assistant} couldn't go back" : $"{Assistant} couldn't update", true, e.Summary,
            $"Your version {job.From} is reopening.", TaskbarItemProgressState.Error);
        var visible = Stopwatch.StartNew();
        try
        {
            string aumid = await Aumid(installed);
            log.Note($"reopening {job.From}: {aumid}");
            await deployment.ActivateAsync(aumid);
            SimulateReady(job.From);
            bool ready = await WaitForFile(ReadyFile(job.From), ReadyTimeout);
            log.Note(ready ? $"{job.From} is open again" : $"{job.From} didn't report ready in time");
        }
        catch (Exception reopen)
        {
            var launch = AsFailure(reopen);
            log.Note($"reopening {job.From} failed: {Errors.OneLine(launch.Message)} ({launch.Code})");
        }
        var minimum = TimeSpan.FromSeconds(2.5 * slow) - visible.Elapsed;
        if (minimum > TimeSpan.Zero) await Task.Delay(minimum);
        await window.CloseAsync();
        return 1;
    }

    /// <summary>The package is in place but Windows won't start it. Never retried in a loop.</summary>
    async Task<int> LaunchFailed(DeploymentFailure e)
    {
        log.Note($"opening failed: {Errors.OneLine(e.Message)} ({e.Code})");
        WriteResult(false, "launch", Errors.OneLine(e.Message), e.Code);
        var closed = new TaskCompletionSource<bool>();
        if (NeedsRestart(e.HResult))
        {
            window.ShowMessage("Restart needed", false, "Windows needs a restart to finish the update.", $"{Assistant} opens on {job.To} after the restart.",
                TaskbarItemProgressState.Paused, new PopupButton("Restart later", true, () => closed.TrySetResult(true)));
        }
        else
        {
            window.ShowMessage($"{Assistant} didn't open", true, e.Summary, $"Open {Assistant} from the Start menu.", TaskbarItemProgressState.Error,
                new PopupButton("Open log", false, OpenLog), new PopupButton("Close", true, () => closed.TrySetResult(true)));
        }
        await closed.Task;
        await window.CloseAsync();
        return 1;
    }

    /// <summary>Installed and started, but no window yet. It may still come: the popup goes away if it does.</summary>
    async Task<int> TimedOut()
    {
        log.Note($"{job.To} didn't report ready within {ReadyTimeout.TotalSeconds:0} s");
        WriteResult(true, "ready", "timeout", "");
        var closed = new TaskCompletionSource<bool>();
        window.ShowMessage(window.Title, false, $"{Assistant} is taking longer than usual to open.", null, TaskbarItemProgressState.Paused,
            new PopupButton("Open log", false, OpenLog), new PopupButton("Close", true, () => closed.TrySetResult(true)));
        var late = WaitForFile(ReadyFile(job.To), ApplyMode.HardCap);
        if (await Task.WhenAny(closed.Task, late) == late && late.Result) log.Note("ready after all");
        await window.CloseAsync();
        return 0;
    }

    /// <summary>A sharing violation, "in use", or an AppModel refusal: what a restart (or sign-out) clears.</summary>
    static bool NeedsRestart(int hr)
    {
        uint code = unchecked((uint)hr);
        return code is 0x80070020 or 0x80070021 // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
            or 0x80073D02 // ERROR_PACKAGES_IN_USE
            || (code >= 0x80073D54 && code <= 0x80073D5F); // APPMODEL_ERROR_*
    }

    // ---- Files ---------------------------------------------------------------------------------------------------

    TimeSpan ReadyTimeout => options.Simulate ? TimeSpan.FromSeconds(6 * slow) : TimeSpan.FromSeconds(120);

    string ReadyFile(string version) => Path.Combine(job.ReadyDir, "ready-" + version);

    void DeleteReady(string version)
    {
        if (job.ReadyDir.Length == 0) return;
        try { File.Delete(ReadyFile(version)); }
        catch (Exception) { /* not there, or the app holds it: the wait below decides */ }
    }

    async Task<bool> WaitForFile(string path, TimeSpan timeout)
    {
        if (job.ReadyDir.Length == 0) return false;
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed < timeout)
        {
            if (File.Exists(path)) return true;
            await Task.Delay(250);
        }
        return File.Exists(path);
    }

    /// <summary>--simulate: the "app" reports ready 2 s after it's opened, unless the ready step is meant to fail.</summary>
    void SimulateReady(string version)
    {
        if (!options.Simulate || options.SimulateFail == "ready" || job.ReadyDir.Length == 0) return;
        string path = ReadyFile(version);
        _ = Task.Delay(Ms(2000)).ContinueWith(_ => Touch(path), TaskScheduler.Default);
    }

    void Touch(string path)
    {
        if (path.Length == 0) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllBytes(path, Array.Empty<byte>());
        }
        catch (Exception e)
        {
            log.Note($"couldn't write {path}: {e.Message}");
        }
    }

    void OpenLog()
    {
        try { Process.Start(new ProcessStartInfo(job.LogFile) { UseShellExecute = true }); }
        catch (Exception e) { log.Note($"couldn't open the log: {e.Message}"); }
    }

    void WriteResult(bool ok, string resultStep, string message, string hresult)
    {
        if (resultWritten) return;
        resultWritten = true;
        try
        {
            Json.WriteFile(job.ResultFile, new
            {
                version = 1,
                ok,
                from = job.From,
                to = job.To,
                step = resultStep,
                message,
                hresult,
                finishedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            });
        }
        catch (Exception e)
        {
            log.Note($"couldn't write the result file: {e.Message}");
        }
    }

    int Ms(double ms) => (int)(ms * slow);

    void Exit(int code)
    {
        if (exiting) return;
        exiting = true;
        window.AllowClose();
        app.Shutdown(code);
    }
}
