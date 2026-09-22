using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// One time the app view stopped, and what the machine looked like when it did.
/// <para>
/// Deliberately small, and deliberately not identifying: no file path, no application
/// or instance identity, no record contents, the same line the saved diagnostics
/// report draws. What it does carry is the two things a person reporting this cannot
/// see — the kind the host was given, and whether the machine was actually short of
/// memory at that moment, which is the question two of these failures turned on.
/// </para>
/// </summary>
internal sealed record DesktopViewFailure(
    DateTimeOffset At,
    string Kind,
    int ViewUpSeconds,
    bool OutOfSight,
    int? AvailableMemoryMb,
    int? MemoryLoadPercent);

/// <summary>
/// A capped, device-local record of view failures, written only while the person has
/// asked for it.
/// <para>
/// Nendo keeps no log. This is the one exception, and it exists because a view that
/// stops responding leaves the person with a screenshot and nothing else: the host
/// knows the kind, knows how long the view had been up and can ask Windows how much
/// memory was free, and all three were lost the moment the window was restarted.
/// </para>
/// <para>
/// It records unless it is switched off, which is the opposite of how a log usually
/// arrives, and is the point: asking somebody to have enabled it before the failure is
/// asking them to have predicted it. The tray menu switches it off in one click, it
/// keeps the last <see cref="MaximumEntries"/> events and nothing else, and it fails
/// soft — a diagnostic that could stop the app from running would be a worse defect
/// than the one it is here to catch.
/// </para>
/// </summary>
internal sealed class DesktopViewFailureLog(string root)
{
    internal const int MaximumEntries = 50;

    private readonly string _root = Path.GetFullPath(root);

    internal static string DefaultRoot => DesktopAppearanceStore.DefaultRoot;

    internal string LogPath => Path.Combine(_root, "view-failures.jsonl");

    /// <summary>
    /// Appends one failure, keeping the newest <see cref="MaximumEntries"/>. Returns
    /// whether it was written, so a caller can say so rather than assume it.
    /// </summary>
    internal bool Record(DesktopViewFailure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);
        try
        {
            Directory.CreateDirectory(_root);
            var kept = Read().TakeLast(MaximumEntries - 1).ToList();
            kept.Add(failure);
            var text = new StringBuilder();
            foreach (var entry in kept) text.Append(JsonSerializer.Serialize(entry)).Append('\n');
            var stage = Path.Combine(_root, $"view-failures-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(stage, text.ToString(), new UTF8Encoding(false));
            File.Move(stage, LogPath, overwrite: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    /// <summary>What has been recorded, oldest first. An unreadable line is skipped rather than fatal.</summary>
    internal IReadOnlyList<DesktopViewFailure> Read()
    {
        try
        {
            if (!File.Exists(LogPath)) return [];
            var entries = new List<DesktopViewFailure>();
            foreach (var line in File.ReadAllLines(LogPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    if (JsonSerializer.Deserialize<DesktopViewFailure>(line) is { } entry) entries.Add(entry);
                }
                catch (JsonException) { }
            }
            return entries;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>
    /// How much physical memory Windows has left, and how loaded it says it is.
    /// <para>
    /// Asked at the moment of the failure, because that is the only moment it answers
    /// the question. Both of these failures were preceded by the renderer being told
    /// memory was critical while the machine had gigabytes free, and nothing recorded
    /// which of those two readings was the true one.
    /// </para>
    /// </summary>
    internal static (int? AvailableMb, int? LoadPercent) MemoryNow()
    {
        try
        {
            var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
            if (!GlobalMemoryStatusEx(ref status)) return (null, null);
            return ((int)(status.AvailablePhysical / (1024 * 1024)), (int)status.MemoryLoad);
        }
        catch (Exception exception) when (exception is EntryPointNotFoundException or DllNotFoundException)
        {
            return (null, null);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        internal uint Length;
        internal uint MemoryLoad;
        internal ulong TotalPhysical;
        internal ulong AvailablePhysical;
        internal ulong TotalPageFile;
        internal ulong AvailablePageFile;
        internal ulong TotalVirtual;
        internal ulong AvailableVirtual;
        internal ulong AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
}
