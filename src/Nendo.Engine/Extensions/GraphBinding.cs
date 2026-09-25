namespace Nendo.Engine;

/// <summary>
/// What a custom view is about, as its definition names it: the record type it shows, the
/// field that labels a record, and for a graph the record type whose two references are its
/// links. A record-set view or a record-page view has no edge type, so its edge members are
/// null. <see cref="FieldIds"/> are the further fields it shows and <see cref="Filters"/> what
/// narrows it, both in authored order and each resolved to the node or the edge type by the
/// field's own record type. The view's code reads through the file's typed API; this record
/// is what the definition says, not a list of what the code may read.
/// </summary>
public sealed record NendoGraphBinding(string NodeEntityId, string LabelFieldId, string? EdgeEntityId,
    string? SourceFieldId, string? TargetFieldId, string? StatusFieldId = null)
{
    public IReadOnlyList<string> FieldIds { get; init; } = [];

    public IReadOnlyList<NendoGraphFilter> Filters { get; init; } = [];
}

/// <summary>
/// One authored narrowing of a view's record type. <paramref name="Value"/> is the literal's
/// exact JSON text, or null for a presence test or a relative value.
/// </summary>
public sealed record NendoGraphFilter(string FieldId, string Operator, string? Value)
{
    /// <summary><c>literal</c>, or a relative value kind such as <c>today</c> that the vocabulary accepts.</summary>
    public string ValueKind { get; init; } = "literal";
}
