namespace Nendo.Engine;

/// <summary>A bounded position in a typed query. A null token opens a new revision.</summary>
public sealed record NendoRecordWindowQuery(NendoRecordQuery Query, int Start = 0, int Limit = 100,
    string? QueryToken = null, string? LocateRecordId = null);

/// <summary>One block, optionally relocated to contain the named record. End is exclusive.</summary>
public sealed record NendoRecordWindow(IReadOnlyList<NendoRecordSnapshot> Items, int Start,
    bool HasMore, long ChangeSequence, string QueryToken, int? LocatedIndex);

internal sealed record NendoRecordRead(NendoPage<NendoRecordSnapshot> Page, int Start = 0,
    string? QueryToken = null, int? LocatedIndex = null);

internal static class RecordWindowSemantics
{
    internal static void Validate(NendoRecordWindowQuery window)
    {
        ArgumentNullException.ThrowIfNull(window);
        ArgumentNullException.ThrowIfNull(window.Query);
        NendoQueryCursor.RequireLimit(window.Limit);
        if (window.Start < 0 || window.Start > int.MaxValue - window.Limit || window.Query.Cursor is not null)
            throw new NendoValidationException("A record window needs a nonnegative bounded position and no page cursor.");
        if (window.LocateRecordId is not null && (string.IsNullOrWhiteSpace(window.LocateRecordId) || window.LocateRecordId.Length > 200))
            throw new NendoValidationException("A record lookup requires a stable ID of 1–200 characters.");
    }

    internal static string Token(NendoRecordWindowQuery window, NendoQueryCursor cursors, NendoManifestSnapshot manifest)
    {
        var scope = RecordQuerySemantics.Scope(window.Query) + "/window";
        if (window.QueryToken is not null) _ = cursors.Decode(window.QueryToken, manifest, scope);
        return cursors.Encode(manifest, scope, "window");
    }
}
