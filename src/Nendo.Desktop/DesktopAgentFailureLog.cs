using Nendo.LocalMcp;

namespace Nendo.Desktop;

/// <summary>
/// A capped, device-local record of agent requests that failed inside Nendo, kept under
/// the same switch and the same bounds as <see cref="DesktopViewFailureLog"/>
/// (ADR-0002, 2026-09-27 amendment).
/// <para>
/// An agent told <c>NENDO_INTERNAL_ERROR</c> could report a type name and nothing else,
/// and the host kept nothing it could be matched against. Each line here carries the
/// reference the agent was given, the request, the exception types and the frames — no
/// exception message, no argument, no handle, no lease and no path. It keeps the newest
/// <see cref="MaximumEntries"/> lines and fails soft.
/// </para>
/// </summary>
internal sealed class DesktopAgentFailureLog(string root)
{
    internal const int MaximumEntries = 50;

    // Failures arrive on agent request threads, possibly two at once; the read, trim and
    // replace below must not interleave.
    private static readonly object Gate = new();

    private readonly DesktopCappedJsonlLog<NendoAgentFailure> _log = new(root, "agent-failures", MaximumEntries);

    internal string LogPath => _log.LogPath;

    /// <summary>Appends one failure, keeping the newest <see cref="MaximumEntries"/>. Returns whether it was written.</summary>
    internal bool Record(NendoAgentFailure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);
        lock (Gate) return _log.Record(failure);
    }

    /// <summary>What has been recorded, oldest first. An unreadable line is skipped rather than fatal.</summary>
    internal IReadOnlyList<NendoAgentFailure> Read() => _log.Read();
}
