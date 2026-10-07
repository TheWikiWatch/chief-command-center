using System;
using System.IO;

namespace ChiefUpdater;

/// <summary>
/// stage: unpacks the new package next to the running one while Chief keeps working. Staging doesn't touch the
/// installed version; apply later only has to register it, which takes seconds instead of minutes.
/// stdout: {"phase":"staging","pct":N}… then {"phase":"staged",…} (exit 0) or {"phase":"error",…} (exit 1).
/// </summary>
static class StageMode
{
    public static int Run(Job job, Options options)
    {
        var output = new JsonLines();
        var log = new Log(job.LogFile);
        string file = Path.GetFileName(job.PackageFile);
        string simulated = options.Simulate ? " (simulated)" : "";
        try
        {
            if (!options.Simulate && !File.Exists(job.PackageFile))
                throw new DeploymentFailure($"The update file isn't there: {job.PackageFile}", unchecked((int)0x80070002));

            var deployment = Deployments.Create(job, options);
            var installed = deployment.FindInstalled(job.PackageName)
                ?? throw new DeploymentFailure($"{job.PackageName} isn't installed for this user.", unchecked((int)0x80073CF1));

            int last = -1;
            var progress = new InlineProgress<int>(pct =>
            {
                pct = Math.Max(0, Math.Min(100, pct));
                if (pct == last) return;
                last = pct;
                output.Write(new { phase = "staging", pct });
            });
            deployment.StageAsync(job.PackageFile, installed, progress).GetAwaiter().GetResult();
            progress.Report(100);

            string fullName = installed.FullNameFor(job.PackageVersion);
            log.Note($"staging {file}: ok{simulated} ({fullName})");
            output.Write(new { phase = "staged", fullName, family = installed.FamilyName });
            return 0;
        }
        catch (Exception e)
        {
            var (message, code) = Errors.Describe(e);
            log.Note($"staging {file}: failed{simulated}: {message} ({code})");
            output.Write(new { phase = "error", message, hresult = code });
            return 1;
        }
    }
}
