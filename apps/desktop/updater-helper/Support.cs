using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ChiefUpdater;

static class Json
{
    static readonly JavaScriptSerializer Serializer = new();

    public static object? Parse(string text) => Serializer.DeserializeObject(text);

    public static string Serialize(object value) => Serializer.Serialize(value);

    /// <summary>Writes through a temporary file, so the app never reads half a result.</summary>
    public static void WriteFile(string path, object value)
    {
        if (path.Length == 0) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        string temp = path + ".tmp";
        File.WriteAllText(temp, Serialize(value), new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temp, path, null);
        else File.Move(temp, path);
    }
}

static class Errors
{
    public static string Code(int hresult) => "0x" + hresult.ToString("X8", CultureInfo.InvariantCulture);

    /// <summary>Windows' own sentence for an error code, or null when it has none.</summary>
    public static string? SystemMessage(int hresult)
    {
        // A Win32 error wrapped as an HRESULT (0x8007xxxx, the AppX errors included) is looked up by its Win32 code.
        int code = (hresult & 0xFFFF0000) == 0x80070000 ? hresult & 0xFFFF : hresult;
        string text = new System.ComponentModel.Win32Exception(code).Message.Trim();
        if (text.Length == 0 || text.StartsWith("Unknown error", StringComparison.OrdinalIgnoreCase)) return null;
        text = OneLine(text);
        return text.EndsWith(".") ? text : text + "."; // some system strings have no full stop
    }

    /// <summary>A message for the log and the popup, on one line.</summary>
    public static string OneLine(string text) =>
        string.Join(" ", text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)).Trim();

    public static (string Message, string Code) Describe(Exception e) => e switch
    {
        DeploymentFailure d => (OneLine(d.Message), d.Code),
        AggregateException { InnerException: { } inner } => Describe(inner),
        _ => (OneLine(e.Message), Code(e.HResult)),
    };
}

/// <summary>
/// update-install.log, shared with the app and the PowerShell fallback: "yyyy-MM-ddTHH:mm:ss text" in local time, the
/// format of PowerShell's Get-Date -Format s (src/install-package.ts).
/// </summary>
sealed class Log
{
    readonly string file;
    readonly string prefix;

    public Log(string file, string prefix = "")
    {
        this.file = file;
        this.prefix = prefix;
    }

    public void Note(string text)
    {
        if (file.Length == 0) return;
        string line = DateTime.Now.ToString("s", CultureInfo.InvariantCulture) + " " + prefix + Errors.OneLine(text) + Environment.NewLine;
        // The app may be appending at the same moment: retry briefly, and never fail an update over a log line.
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
                File.AppendAllText(file, line, new UTF8Encoding(false));
                return;
            }
            catch (IOException) { Thread.Sleep(40); }
            catch (UnauthorizedAccessException) { return; }
        }
    }
}

/// <summary>An IProgress that reports on the reporting thread, in order (Progress&lt;T&gt; posts to the thread pool).</summary>
sealed class InlineProgress<T> : IProgress<T>
{
    readonly Action<T> report;
    public InlineProgress(Action<T> report) => this.report = report;
    public void Report(T value) => report(value);
}
