using System.Text.Json;

namespace Nendo.Engine;

/// <summary>One icon of Nendo's set: its name, the group the picker files it under, and its search words.</summary>
public sealed record NendoIcon(string Name, string Group, string Words);

/// <summary>
/// The icons a record type, a screen or a custom view may carry (ADR-0038): a curated selection
/// of Lucide outline icons, named by Lucide's own names. The Workbench draws them and this host
/// checks a name against the same list, <c>src/Nendo.Engine/icon-set.json</c>, which this assembly
/// carries as it was built. Read once.
/// </summary>
public static class NendoIconSet
{
    /// <summary>The read that lists the set over MCP.</summary>
    public const string ResourceUri = "nendo://application/icons";

    /// <summary>The longest name an icon has, with room to spare; a stored name past it is not one.</summary>
    public const int MaximumNameLength = 64;

    private const string ResourceName = "Nendo.Engine.icon-set.json";

    private static readonly Lazy<(string Source, IReadOnlyList<NendoIcon> Icons, IReadOnlySet<string> Names)> Set = new(() =>
    {
        using var stream = typeof(NendoIconSet).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"This build carries no {ResourceName}.");
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;
        var icons = root.GetProperty("icons").EnumerateArray()
            .Select(icon => new NendoIcon(
                icon.GetProperty("name").GetString()!,
                icon.GetProperty("group").GetString()!,
                icon.GetProperty("words").GetString() ?? ""))
            .ToArray();
        return (root.GetProperty("source").GetString() ?? "", icons,
            new HashSet<string>(icons.Select(icon => icon.Name), StringComparer.Ordinal));
    });

    /// <summary>Where the icons come from, with the version and licence.</summary>
    public static string Source => Set.Value.Source;

    /// <summary>Every icon, in the set's own order.</summary>
    public static IReadOnlyList<NendoIcon> Icons => Set.Value.Icons;

    /// <summary>Whether this version of Nendo knows an icon by this name.</summary>
    public static bool Contains(string? name) => name is not null && Set.Value.Names.Contains(name);

    /// <summary>
    /// Whether text has the shape of an icon name: lower-case words of letters and digits joined by
    /// hyphens. A stored name of that shape this version does not know is read as no choice; one of
    /// any other shape is damage.
    /// </summary>
    public static bool IsWellFormed(string? name) =>
        name is { Length: > 0 and <= MaximumNameLength } &&
        name.Split('-').All(word => word.Length > 0 && word.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9'));

    /// <summary>The refusal for a name the set does not hold, saying where the names are listed.</summary>
    internal static string UnknownText(string name) =>
        $"'{name}' is not an icon in Nendo's set. {ResourceUri} lists every icon by name, with its group and search words.";
}
