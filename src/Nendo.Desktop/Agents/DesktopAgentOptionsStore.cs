using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>One of an agent's kept settings as the Agent page and a view's launch card show it: the value to start with, and what it may be.</summary>
internal sealed record DesktopAgentSettingView(
    string Id,
    string Name,
    string? Category,
    string Value,
    IReadOnlyList<DesktopAgentSettingValueView> Values);

internal sealed record DesktopAgentSettingValueView(string Value, string Name, string? Group);

/// <summary>
/// The settings a person picked for each agent, kept for this device only, never in a file
/// (ADR-0030, ADR-0033): the values they set, and the options the agent offered when it was last
/// ready or last had one set, so a view's launch card can show them before the agent starts. The
/// kept values are sent when the agent next starts, before it is ready.
/// </summary>
internal sealed class DesktopAgentOptionsStore(string root)
{
    internal const int MaximumBytes = 256 * 1024;
    private const int MaximumDepth = 8;
    private readonly string _root = Path.GetFullPath(root);
    private string StatePath => Path.Combine(_root, "agent-options.json");

    /// <summary>What is kept for one agent: the options it last offered (empty when dropped for room) and the values the person picked.</summary>
    internal sealed record Kept(IReadOnlyList<AgentOptionView> Options, IReadOnlyDictionary<string, string> Picked);

    /// <summary>What is kept for <paramref name="agentId"/>, or null when nothing is.</summary>
    internal Kept? For(string agentId) => Load().GetValueOrDefault(agentId);

    /// <summary>
    /// The settings a launch card shows for <paramref name="agentId"/>, or null when the agent's
    /// options were never kept here. Each starts at the value the person picked while the agent
    /// offered it, otherwise at the value the agent stated.
    /// </summary>
    internal IReadOnlyList<DesktopAgentSettingView>? Settings(string agentId) => Settings(For(agentId));

    internal static IReadOnlyList<DesktopAgentSettingView>? Settings(Kept? kept)
    {
        if (kept is null || kept.Options.Count == 0) return null;
        return kept.Options.Select(option => new DesktopAgentSettingView(option.Id, option.Name, option.Category,
                kept.Picked.TryGetValue(option.Id, out var picked) && option.Values.Any(value => value.Value == picked) ? picked : option.CurrentValue,
                option.Values.Select(value => new DesktopAgentSettingValueView(value.Value, value.Name, value.Group)).ToArray()))
            .ToArray();
    }

    /// <summary>The agent offered <paramref name="options"/>; keep them for the next card. The picks stay.</summary>
    internal void Offered(string agentId, IReadOnlyList<AgentOptionView> options)
    {
        if (!DesktopAgentCatalog.CanHide(agentId) || options.Count == 0) return;
        var all = Load();
        var current = all.GetValueOrDefault(agentId);
        var next = new Kept(Trim(options), current?.Picked ?? new Dictionary<string, string>());
        if (current is not null && Same(current, next)) return;
        all[agentId] = next;
        Write(all, agentId);
    }

    /// <summary>
    /// The person picked <paramref name="picks"/> for <paramref name="agentId"/>: keep them, over
    /// any picked before for the same options, and the options the agent offers now when known.
    /// </summary>
    internal void Pick(string agentId, IReadOnlyDictionary<string, string> picks, IReadOnlyList<AgentOptionView>? options = null)
    {
        if (!DesktopAgentCatalog.CanHide(agentId) || picks.Count == 0) return;
        var all = Load();
        var current = all.GetValueOrDefault(agentId);
        var picked = new Dictionary<string, string>(current?.Picked ?? new Dictionary<string, string>(), StringComparer.Ordinal);
        foreach (var (id, value) in picks) picked[id] = value;
        var next = new Kept(options is { Count: > 0 } ? Trim(options) : current?.Options ?? [], picked.TakeLast(AgentConversation.MaximumOptions * 2).ToDictionary());
        if (current is not null && Same(current, next)) return;
        all[agentId] = next;
        Write(all, agentId);
    }

    /// <summary>Forget everything kept for <paramref name="agentId"/>: the person's own command changed, so it may be another program.</summary>
    internal void Forget(string agentId)
    {
        var all = Load();
        if (all.Remove(agentId)) Write(all, agentId);
    }

    private static IReadOnlyList<AgentOptionView> Trim(IReadOnlyList<AgentOptionView> options) =>
        options.Take(AgentConversation.MaximumOptions)
            .Select(option => option with { Description = null, Values = option.Values.Take(AgentConversation.MaximumOptionValues).Select(value => value with { Description = null }).ToArray() })
            .ToArray();

    private static bool Same(Kept a, Kept b) =>
        JsonSerializer.Serialize(Store(a)) == JsonSerializer.Serialize(Store(b));

    private Dictionary<string, Kept> Load()
    {
        try
        {
            var document = DesktopStateFile.Read<StoredSettings>(StatePath, MaximumBytes, MaximumDepth);
            if (document?.Version != 1 || document.Agents is null) return new(StringComparer.Ordinal);
            var all = new Dictionary<string, Kept>(StringComparer.Ordinal);
            // An ID this build does not know is dropped rather than trusted: the file is this
            // device's, but an older or newer Nendo may have written it.
            foreach (var (id, stored) in document.Agents.Where(pair => DesktopAgentCatalog.CanHide(pair.Key)))
            {
                var options = (stored.Options ?? [])
                    .Where(option => option is { Id.Length: > 0 and <= 200, Name.Length: > 0 and <= 120 } && option.Values is { Length: > 0 })
                    .Take(AgentConversation.MaximumOptions)
                    .Select(option => new AgentOptionView(option.Id, option.Name, null, Bounded(option.Category, 60), Bounded(option.Current, 300) ?? string.Empty,
                        option.Values!.Where(value => value is { Value.Length: > 0 and <= 300 })
                            .Take(AgentConversation.MaximumOptionValues)
                            .Select(value => new AgentOptionValueView(value.Value, Bounded(value.Name, 200) ?? value.Value, null, Bounded(value.Group, 120)))
                            .ToArray()))
                    .Where(option => option.Values.Count > 0)
                    .ToArray();
                var picked = (stored.Picked ?? new Dictionary<string, string>()).Where(pair => pair.Key is { Length: > 0 and <= 200 } && pair.Value is { Length: > 0 and <= 300 })
                    .Take(AgentConversation.MaximumOptions * 2)
                    .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
                if (options.Length > 0 || picked.Count > 0) all[id] = new Kept(options, picked);
            }
            return all;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return new(StringComparer.Ordinal);
        }
    }

    private static string? Bounded(string? text, int maximum) => text is { Length: > 0 } && text.Length <= maximum ? text : null;

    /// <summary>
    /// Write every agent's settings. Past the bound, the other agents' option lists go first,
    /// then <paramref name="writing"/>'s own; the picks stay, so the next start still sends them.
    /// </summary>
    private void Write(Dictionary<string, Kept> all, string writing)
    {
        if (all.Count == 0)
        {
            try { File.Delete(StatePath); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            return;
        }
        var bytes = Serialize(all);
        foreach (var id in all.Keys.Where(id => id != writing).Append(writing).ToArray())
        {
            if (bytes.Length <= MaximumBytes) break;
            all[id] = all[id] with { Options = [] };
            bytes = Serialize(all);
        }
        using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
        DesktopStateFile.Replace(_root, StatePath, "agent-options", stream => stream.Write(bytes));
    }

    private static byte[] Serialize(Dictionary<string, Kept> all) =>
        JsonSerializer.SerializeToUtf8Bytes(new StoredSettings(1, all.ToDictionary(pair => pair.Key, pair => Store(pair.Value))));

    private static StoredAgent Store(Kept kept) => new(
        kept.Options.Select(option => new StoredOption(option.Id, option.Name, option.Category, option.CurrentValue,
            option.Values.Select(value => new StoredValue(value.Value, value.Name, value.Group)).ToArray())).ToArray(),
        kept.Picked.ToDictionary());

    private sealed record StoredSettings(int Version, Dictionary<string, StoredAgent>? Agents);

    private sealed record StoredAgent(StoredOption[]? Options, Dictionary<string, string>? Picked);

    private sealed record StoredOption(string Id, string Name, string? Category, string? Current, StoredValue[]? Values);

    private sealed record StoredValue(string Value, string? Name, string? Group);
}
