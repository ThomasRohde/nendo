using System.Text;
using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// What the agent tells the person outside its messages (ACP v1): a <c>notice</c>, with a severity,
/// a title and an optional description, and a context compaction, created by its first
/// <c>compaction_update</c> or <c>compaction_summary_chunk</c> and patched in place by its ID.
/// The agent sends either only to a client that declared <c>session.notices</c> or
/// <c>session.compaction</c>, which Nendo does.
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumNoticeTitleCharacters = 300;
    internal const int MaximumNoticeCharacters = 2_000;

    private static readonly HashSet<string> Severities = new(StringComparer.Ordinal) { "info", "warning", "error" };

    private readonly Dictionary<string, MutableEntry> _compactionEntries = new(StringComparer.Ordinal);

    /// <summary>
    /// The agent's notice, as a notice entry naming its severity; one the same as the notice just
    /// before it is said once. False when it has no title. Called under the lock.
    /// </summary>
    private bool ApplyNotice(JsonElement update)
    {
        var title = Text(update, "title", MaximumNoticeTitleCharacters);
        if (string.IsNullOrWhiteSpace(title)) return false;
        var description = Text(update, "description", MaximumNoticeCharacters) ?? string.Empty;
        // An unknown or future severity is shown as information.
        var severity = Text(update, "severity", 40) is { } stated && Severities.Contains(stated) ? stated : "info";
        if (_entries.LastOrDefault() is { Kind: "notice", Origin: "agent" } last && last.Title == title && last.Status == severity
            && last.Text.ToString() == description)
            return false;
        _openMessage = null;
        var entry = Add("notice", description);
        entry.Title = title;
        entry.Status = severity;
        entry.Origin = "agent";
        return true;
    }

    /// <summary>
    /// A compaction created or patched: its status, and its summary and error where the update
    /// carries them. Left out, a summary or error stays; null clears it, as does an empty summary.
    /// Called under the lock.
    /// </summary>
    private bool ApplyCompaction(JsonElement update)
    {
        if (Compaction(update) is not { } entry) return false;
        if (Text(update, "status", 40) is { } status) entry.Status = status;
        if (update.TryGetProperty("summary", out var summary))
        {
            entry.Text.Clear();
            if (summary.ValueKind == JsonValueKind.Array) entry.Text.Append(SummaryText(summary.EnumerateArray()));
        }
        if (update.TryGetProperty("error", out var error))
            entry.Error = error.ValueKind == JsonValueKind.String ? AcpConnection.Bounded(error.GetString()!, MaximumNoticeCharacters) : null;
        entry.Revision = _revision + 1;
        return true;
    }

    /// <summary>A block appended to a compaction's summary; a first-seen ID creates the compaction, in progress. Called under the lock.</summary>
    private bool ApplyCompactionChunk(JsonElement update)
    {
        if (!update.TryGetProperty("content", out var content) || Compaction(update) is not { } entry) return false;
        var text = BlockText(content);
        if (text.Length == 0) return false;
        if (entry.Text.Length > 0) entry.Text.Append('\n');
        entry.Text.Append(text);
        if (entry.Text.Length > MaximumEntryCharacters) entry.Text.Length = MaximumEntryCharacters;
        entry.Revision = _revision + 1;
        return true;
    }

    /// <summary>The compaction an update names, created where it is first seen: that fixes its place in the thread.</summary>
    private MutableEntry? Compaction(JsonElement update)
    {
        var id = Text(update, "compactionId", 200);
        if (id is null) return null;
        if (_compactionEntries.TryGetValue(id, out var entry)) return entry;
        _openMessage = null;
        entry = Add("compaction", string.Empty);
        entry.Status = "in_progress";
        _compactionEntries[id] = entry;
        return entry;
    }

    private static string SummaryText(IEnumerable<JsonElement> blocks)
    {
        var text = new StringBuilder();
        foreach (var line in blocks.Select(BlockText).Where(line => line.Length > 0))
        {
            if (text.Length > 0) text.Append('\n');
            text.Append(line);
            if (text.Length > MaximumEntryCharacters) { text.Length = MaximumEntryCharacters; break; }
        }
        return text.ToString();
    }
}
