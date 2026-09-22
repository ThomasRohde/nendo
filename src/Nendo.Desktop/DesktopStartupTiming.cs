using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Desktop;

// Opt-in local qualification only: no paths, file contents or protocol payloads
// are recorded. Buffer markers so disk I/O does not interrupt measured stages.
internal static class DesktopStartupTiming
{
    private static readonly string? Output = Environment.GetEnvironmentVariable("NENDO_STARTUP_TIMING_OUTPUT");
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static readonly List<object> Markers = [];
    private static readonly object Gate = new();
    private static bool _written;

    static DesktopStartupTiming()
    {
        if (string.IsNullOrWhiteSpace(Output)) return;
        ActivitySource.AddActivityListener(new ActivityListener
        {
            ShouldListenTo = source => source.Name == "Nendo.Engine.Startup",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStarted = activity => Mark(activity.OperationName + ".begin"),
            ActivityStopped = activity => Mark(activity.OperationName + ".end"),
        });
    }

    internal static void Mark(string stage)
    {
        if (string.IsNullOrWhiteSpace(Output)) return;
        lock (Gate)
        {
            if (_written) return;
            Markers.Add(new { stage, utcMilliseconds = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), elapsedMilliseconds = Clock.Elapsed.TotalMilliseconds });
        }
    }

    internal static void Write()
    {
        if (string.IsNullOrWhiteSpace(Output)) return;
        object[] markers;
        lock (Gate)
        {
            if (_written) return;
            _written = true;
            markers = Markers.ToArray();
        }
        try
        {
            using var stream = new FileStream(Output, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            JsonSerializer.Serialize(stream, new { processId = Environment.ProcessId, markers });
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // Diagnostics must never change the normal startup/recovery result.
        }
    }
}
