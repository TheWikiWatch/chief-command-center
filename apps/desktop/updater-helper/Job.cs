using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace ChiefUpdater;

/// <summary>The app window's bounds in physical pixels.</summary>
sealed class PixelRect
{
    public int X, Y, Width, Height;
}

/// <summary>The hand-off file the app writes (job.json, camelCase). Unknown fields are ignored, so the app can add some.</summary>
sealed class Job
{
    public string Mode = "update";
    public string From = "";
    public string To = "";
    public string PackageFile = "";
    public string PackageName = "ChiefCommandCenter";
    public string AppId = "ChiefCommandCenter";
    public int AppPid;
    public PixelRect? Window;
    public string Accent = "#E5484D";
    public string? FacePng;
    public string AssistantName = "Chief";
    public string LogFile = "";
    public string ResultFile = "";
    public string ShownFile = "";
    public string ReadyDir = "";
    public bool ReducedMotion;

    public bool IsRollback => Mode == "rollback";

    /// <summary>An app version x.y.z is package version x.y.z.0.</summary>
    public string PackageVersion => To + ".0";

    static readonly Regex AppVersion = new(@"^\d+\.\d+\.\d+$");

    public static Job Load(string path)
    {
        // ReadAllText skips a BOM if the writer added one.
        var root = Json.Parse(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>
            ?? throw new InvalidDataException("not a JSON object");

        var job = new Job
        {
            Mode = Str(root, "mode") ?? "update",
            From = Str(root, "from") ?? "",
            To = Str(root, "to") ?? "",
            PackageFile = Str(root, "packageFile") ?? "",
            PackageName = Str(root, "packageName") ?? "ChiefCommandCenter",
            AppId = Str(root, "appId") ?? "ChiefCommandCenter",
            AppPid = (int)(Num(root, "appPid") ?? 0),
            Accent = Str(root, "accent") ?? "#E5484D",
            FacePng = Str(root, "facePng"),
            AssistantName = Str(root, "assistantName") ?? "Chief",
            LogFile = Str(root, "logFile") ?? "",
            ResultFile = Str(root, "resultFile") ?? "",
            ShownFile = Str(root, "shownFile") ?? "",
            ReadyDir = Str(root, "readyDir") ?? "",
            ReducedMotion = root.TryGetValue("reducedMotion", out var rm) && rm is bool b && b,
        };
        if (root.TryGetValue("window", out var w) && w is Dictionary<string, object> win)
        {
            double? x = Num(win, "x"), y = Num(win, "y"), width = Num(win, "width"), height = Num(win, "height");
            if (x is not null && y is not null && width > 0 && height > 0)
                job.Window = new PixelRect { X = (int)x, Y = (int)y, Width = (int)width!, Height = (int)height! };
        }

        if (job.Mode != "update" && job.Mode != "rollback") throw new InvalidDataException($"unknown mode \"{job.Mode}\"");
        if (!AppVersion.IsMatch(job.From)) throw new InvalidDataException("\"from\" must be a version x.y.z");
        if (!AppVersion.IsMatch(job.To)) throw new InvalidDataException("\"to\" must be a version x.y.z");
        if (job.AssistantName.Trim().Length == 0) job.AssistantName = "Chief";
        return job;
    }

    static string? Str(Dictionary<string, object> o, string key) =>
        o.TryGetValue(key, out var v) && v is string s && s.Trim().Length > 0 ? s : null;

    static double? Num(Dictionary<string, object> o, string key) =>
        o.TryGetValue(key, out var v) && v is int or long or decimal or double
            ? Convert.ToDouble(v, CultureInfo.InvariantCulture)
            : null;
}
