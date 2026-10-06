using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Builds the file's full-text index, or rebuilds it from the records (ADR-0028).
/// <para>
/// The first build adds the search rung to the protected layout; from then on every commit keeps
/// the index in step with the records, so the operation is needed again only to repair it. The
/// index is derived from records the history already holds, so building it changes no record and
/// no definition, and there is nothing to undo: it declares itself irreversible rather than
/// pretending an inverse.
/// </para>
/// </summary>
public sealed record BuildSearchIndexOperation : NendoOperation
{
    public BuildSearchIndexOperation(string operationId) : base(operationId) { }

    public override string OperationType => "application.buildSearchIndex";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteEndObject();
    }
}

/// <summary>
/// A full-text search over the file's text fields (ADR-0028). Words are matched across all of a
/// record's searched fields, so one word may sit in the title and another in the body.
/// </summary>
/// <param name="Text">
/// Words, all required; <c>"a phrase"</c> in double quotes; <c>-word</c> to leave out records that
/// contain it. The last word also matches as a prefix, so a search can run as someone types.
/// Nothing else is syntax: an operator a search engine would read is searched for as a word.
/// </param>
public sealed record NendoSearchQuery(string Text, int Limit = 20, string? Cursor = null)
{
    /// <summary>Only these record types; empty for every record type.</summary>
    public IReadOnlyList<string> EntityIds { get; init; } = [];

    /// <summary>Only these fields; empty for every searched field.</summary>
    public IReadOnlyList<string> FieldIds { get; init; } = [];
}

/// <summary>One record a search found, best match first.</summary>
/// <param name="Label">The record's first searched field, as a title to show; null when it is empty.</param>
/// <param name="Score">Higher is a better match. Comparable only within one result.</param>
/// <param name="Fields">The fields that matched, each with a short excerpt.</param>
public sealed record NendoSearchHit(
    string EntityId,
    string RecordId,
    long Version,
    string? Label,
    double Score,
    IReadOnlyList<NendoSearchFieldMatch> Fields);

/// <summary>
/// A field that matched, with an excerpt around the match. <paramref name="Ranges"/> are the matched
/// words as start and length in UTF-16 code units of <paramref name="Snippet"/>; the excerpt is plain
/// text, never markup.
/// </summary>
public sealed record NendoSearchFieldMatch(string FieldId, string Snippet, IReadOnlyList<NendoTextRange> Ranges);

public sealed record NendoTextRange(int Start, int Length);

/// <summary>The bounds of a search that are not a page's.</summary>
public static class NendoSearchLimits
{
    public const int MaximumTextLength = 256;
    public const int MaximumTerms = 16;
    public const int MaximumPage = 100;
    public const int MaximumScope = 64;
}

/// <summary>
/// Turns what a person typed into a safe FTS5 query. Every term is quoted, so FTS5 never sees an
/// operator, a column filter or a bare asterisk that it would read as syntax.
/// </summary>
internal sealed record SearchTerms(IReadOnlyList<string> Required, IReadOnlyList<string> Excluded)
{
    /// <summary>Any one required term, for ranking and excerpts.</summary>
    internal string Any => string.Join(" OR ", Required);

    internal static SearchTerms Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length > NendoSearchLimits.MaximumTextLength)
            throw new NendoPreconditionException("search-too-long",
                $"A search is at most {NendoSearchLimits.MaximumTextLength} characters.");
        var tokens = new List<(string Text, bool Phrase, bool Excluded)>();
        var index = 0;
        while (index < text.Length)
        {
            if (char.IsWhiteSpace(text[index])) { index++; continue; }
            var excluded = false;
            if (text[index] == '-' && index + 1 < text.Length && !char.IsWhiteSpace(text[index + 1]))
            {
                excluded = true;
                index++;
            }
            if (text[index] == '"')
            {
                var close = text.IndexOf('"', index + 1);
                var end = close < 0 ? text.Length : close;
                tokens.Add((text[(index + 1)..end], true, excluded));
                index = close < 0 ? text.Length : close + 1;
                continue;
            }
            var start = index;
            while (index < text.Length && !char.IsWhiteSpace(text[index]) && text[index] != '"') index++;
            tokens.Add((text[start..index], false, excluded));
        }
        var searchable = tokens.Where(token => token.Text.Any(char.IsLetterOrDigit)).ToArray();
        if (searchable.Length > NendoSearchLimits.MaximumTerms)
            throw new NendoPreconditionException("search-too-many-terms",
                $"A search takes at most {NendoSearchLimits.MaximumTerms} words or phrases.");
        var lastRequired = Array.FindLastIndex(searchable, token => !token.Excluded);
        var required = new List<string>();
        var leftOut = new List<string>();
        for (var position = 0; position < searchable.Length; position++)
        {
            var token = searchable[position];
            // The last word typed is still being typed, so it also matches as a prefix. A
            // phrase was closed on purpose and a left-out word means exactly that word.
            var prefix = position == lastRequired && !token.Phrase && !text.EndsWith(' ');
            (token.Excluded ? leftOut : required).Add(Quote(token.Text) + (prefix ? "*" : ""));
        }
        return new(required, leftOut);
    }

    private static string Quote(string term)
    {
        var builder = new StringBuilder(term.Length + 2).Append('"');
        foreach (var character in term)
        {
            if (char.IsControl(character)) builder.Append(' ');
            else if (character == '"') builder.Append("\"\"");
            else builder.Append(character);
        }
        return builder.Append('"').ToString();
    }
}

internal static class SearchSemantics
{
    internal static void Validate(NendoSearchQuery query)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.Limit is < 1 or > NendoSearchLimits.MaximumPage)
            throw new NendoPreconditionException("invalid-limit",
                $"A search page must request between 1 and {NendoSearchLimits.MaximumPage} records.");
        if (query.EntityIds is null || query.FieldIds is null ||
            query.EntityIds.Count > NendoSearchLimits.MaximumScope || query.FieldIds.Count > NendoSearchLimits.MaximumScope ||
            query.EntityIds.Concat(query.FieldIds).Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 200))
            throw new NendoValidationException(
                $"A search names at most {NendoSearchLimits.MaximumScope} record types and {NendoSearchLimits.MaximumScope} fields, each by its ID.");
    }

    internal static string Scope(NendoSearchQuery query) => "search/" + Convert.ToHexString(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            query.Text,
            EntityIds = query.EntityIds.Order(StringComparer.Ordinal).ToArray(),
            FieldIds = query.FieldIds.Order(StringComparer.Ordinal).ToArray(),
        })));

    internal static int Offset(string? after) =>
        after is null ? 0 : int.Parse(after, NumberStyles.None, CultureInfo.InvariantCulture);

    /// <summary>The marker characters FTS5 wraps a matched word in, turned into ranges.</summary>
    internal const char MatchStart = '\u0002';
    internal const char MatchEnd = '\u0003';

    internal static NendoSearchFieldMatch Excerpt(string fieldId, string marked)
    {
        var text = new StringBuilder(marked.Length);
        var ranges = new List<NendoTextRange>();
        var start = -1;
        foreach (var character in marked)
        {
            if (character == MatchStart) start = text.Length;
            else if (character == MatchEnd)
            {
                if (start >= 0 && text.Length > start) ranges.Add(new(start, text.Length - start));
                start = -1;
            }
            else text.Append(character);
        }
        return new(fieldId, text.ToString(), ranges);
    }
}
