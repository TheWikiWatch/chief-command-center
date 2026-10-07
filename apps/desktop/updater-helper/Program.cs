// Chief Updater: puts a new Chief Command Center package in place outside the app (PLAN 2026-10-07 §1).
//
//   ChiefUpdater.exe stage --job <job.json>   headless, a child of the app: unpacks the update while Chief keeps
//                                             working and reports progress as JSON lines on stdout
//   ChiefUpdater.exe apply --job <job.json>   the "Updating Chief" popup, started through WMI so it outlives the app:
//                                             waits for Chief to close, registers the staged package, reopens Chief
//
//   --simulate               fake every Windows deployment call; the window, files and log are real
//   --simulate-fail <step>   make one step fail: stage | register | add | launch | ready
//   --simulate-slow          stretch the simulated timings about 3x, for screenshots
using System;
using System.IO;

namespace ChiefUpdater;

sealed class Options
{
    public string Mode = "";
    public string JobFile = "";
    public bool Simulate;
    public string? SimulateFail;
    public double Slow = 1;

    static readonly string[] FailSteps = { "stage", "register", "add", "launch", "ready" };

    public static Options? Parse(string[] args, out string error)
    {
        var o = new Options();
        error = "";
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            switch (a)
            {
                case "stage":
                case "apply":
                    o.Mode = a;
                    break;
                case "--job" when i + 1 < args.Length:
                    o.JobFile = args[++i];
                    break;
                case "--simulate":
                    o.Simulate = true;
                    break;
                case "--simulate-fail" when i + 1 < args.Length:
                    o.Simulate = true;
                    o.SimulateFail = args[++i].ToLowerInvariant();
                    if (Array.IndexOf(FailSteps, o.SimulateFail) < 0) { error = $"unknown step for --simulate-fail: {o.SimulateFail}"; return null; }
                    break;
                case "--simulate-slow":
                    o.Simulate = true;
                    o.Slow = 3;
                    break;
                default:
                    error = $"unexpected argument: {a}";
                    return null;
            }
        }
        if (o.Mode.Length == 0 || o.JobFile.Length == 0)
        {
            error = "usage: ChiefUpdater.exe stage|apply --job <job.json> [--simulate] [--simulate-fail <step>] [--simulate-slow]";
            return null;
        }
        return o;
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        var options = Options.Parse(args, out string error);
        if (options is null)
        {
            Console.Error.WriteLine(error);
            return 2;
        }

        Job job;
        try
        {
            job = Job.Load(options.JobFile);
        }
        catch (Exception e)
        {
            // The app reads stage's stdout, so a bad job is reported there too.
            if (options.Mode == "stage")
                new JsonLines().Write(new { phase = "error", message = $"Can't read the job file: {e.Message}", hresult = Errors.Code(e.HResult) });
            Console.Error.WriteLine($"Can't read the job file {options.JobFile}: {e.Message}");
            return 2;
        }

        return options.Mode == "stage" ? StageMode.Run(job, options) : ApplyMode.Run(job, options);
    }
}

/// <summary>Stage's stdout: one JSON object per line, flushed at once, UTF-8 whatever the console code page.</summary>
sealed class JsonLines
{
    readonly StreamWriter? writer;
    readonly object gate = new();

    public JsonLines()
    {
        try
        {
            writer = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        }
        catch (IOException)
        {
            writer = null; // started without a stdout; the log still has the outcome
        }
    }

    public void Write(object value)
    {
        lock (gate)
        {
            try { writer?.WriteLine(Json.Serialize(value)); }
            catch (IOException) { /* the app went away; the log has the outcome */ }
        }
    }
}
