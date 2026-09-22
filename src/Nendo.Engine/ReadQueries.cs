namespace Nendo.Engine;

internal sealed record NendoReadDiagnostics(long FullAuthorityScans, long FullRecordReads, long FullHistoryReads, long IntegrityChecks);

/// <summary>Bounded typed query. Continuations bind the complete query and file change sequence.</summary>
public sealed record NendoRecordQuery(string EntityId, int Limit = 50, string? Cursor = null)
{
    public string? SortFieldId { get; init; }
    public string? RecordId { get; init; }
    public bool Descending { get; init; }
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

/// <summary>AND predicates: eq, ne, lt, le, gt, ge, contains, isNull, isNotNull.</summary>
public sealed record NendoRecordFilter(string FieldId, string Operator, System.Text.Json.JsonElement Value = default);

/// <summary>An exact count of the records a filtered query would return.</summary>
public sealed record NendoRecordCountQuery(string EntityId)
{
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

public sealed record NendoRecordCount(string EntityId, long Count, long ChangeSequence);

/// <summary>
/// An exact numeric aggregate over the records a filtered query would return.
/// The host folds the stored values itself; see <see cref="ExactAggregate"/> for
/// why a SQL aggregate over a Decimal column would be wrong rather than merely
/// imprecise.
/// </summary>
public sealed record NendoRecordAggregateQuery(string EntityId, string Aggregate, string FieldId)
{
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

/// <summary>
/// The exact aggregate, with <see cref="Value"/> null over a set that
/// contributed no value. An empty set is stated as empty, never as zero.
/// </summary>
public sealed record NendoRecordAggregate(
    string EntityId,
    string Aggregate,
    string FieldId,
    System.Text.Json.JsonElement? Value,
    long ContributingRecords,
    long ChangeSequence)
{
    /// <summary>
    /// The exact numeric lexeme, or null over an empty set. A client that parses
    /// <see cref="Value"/> as a floating-point number loses digits and trailing
    /// zeros; this is the projection to display and to round-trip, matching
    /// numericLexemes on the records resource.
    /// </summary>
    public string? ValueLexeme => Value?.GetRawText();
}

/// <summary>
/// An exact aggregate over the records a filtered query would return, answered as
/// one number per group of a closed grouping — the options of a single-choice
/// field, or false and true for a Boolean — plus the unset group (ADR-0004,
/// 2026-09-14 amendment). The grouping is not a filter and spends none of the
/// query's filter budget. <see cref="FieldId"/> is the numeric field a sum, min or
/// max reads, and null for a count.
/// </summary>
public sealed record NendoRecordGroupedAggregateQuery(string EntityId, string GroupByFieldId, string Aggregate, string? FieldId = null)
{
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

/// <summary>
/// One group of a grouped aggregate. <see cref="Key"/> is the stored choice ID,
/// "true" or "false", or null for the unset group. <see cref="Value"/> is null
/// over a group that contributed no value, which is stated as empty, never as zero.
/// </summary>
public sealed record NendoRecordAggregateGroup(string? Key, System.Text.Json.JsonElement? Value, long ContributingRecords)
{
    /// <summary>The exact numeric lexeme, or null over an empty group; see <see cref="NendoRecordAggregate.ValueLexeme"/>.</summary>
    public string? ValueLexeme => Value?.GetRawText();
}

/// <summary>
/// The groups in the field's configured order, then the unset group, and one
/// count of records whose stored value is none of them. Such a value is a data
/// issue the renderer states; it is never folded into a group nobody configured.
/// </summary>
public sealed record NendoRecordGroupedAggregate(
    string EntityId,
    string GroupByFieldId,
    string Aggregate,
    string? FieldId,
    IReadOnlyList<NendoRecordAggregateGroup> Groups,
    long Unrecognised,
    long ChangeSequence);

/// <summary>
/// One exact number per civil-date bucket of a resolved range (ADR-0004, 2026-09-16
/// amendment). <see cref="Range"/> and <see cref="Bucket"/> are closed words, never dates:
/// the host resolves them against today each time it reads, so the query a stored screen
/// asks does not go stale. The two bounds it resolves to are predicates the host adds, and
/// they count against the query's filter budget, which is why the compiler gives a trend
/// two fewer authored clauses than a tile elsewhere.
/// </summary>
public sealed record NendoRecordDateBucketQuery(
    string EntityId,
    string DateFieldId,
    string Bucket,
    string Range,
    string Aggregate,
    string? FieldId = null)
{
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

/// <summary>
/// The buckets of the resolved range in order, every one of them present. A bucket over
/// which nothing contributed carries a null <see cref="NendoRecordAggregateGroup.Value"/>
/// and a zero count — stated as empty, never as a missing bucket, because the shape a
/// person reads is the shape of the range rather than of the data that happens to exist.
/// <see cref="Start"/> and <see cref="End"/> are the civil bounds the words resolved to, so
/// a caller can label the axis without resolving them a second time.
/// </summary>
public sealed record NendoRecordDateBucketAggregate(
    string EntityId,
    string DateFieldId,
    string Bucket,
    string Range,
    string Aggregate,
    string? FieldId,
    string Start,
    string End,
    IReadOnlyList<NendoRecordAggregateGroup> Groups,
    long ChangeSequence);

/// <summary>
/// One exact number per cell of two crossed closed groupings (ADR-0004, 2026-09-17
/// amendment, S6). The two axes must be different fields: a field against itself is a
/// diagonal with empty corners, which states nothing a grouped aggregate does not state
/// better. Neither grouping is a filter, so between them they spend none of the query's
/// filter budget.
/// </summary>
public sealed record NendoRecordCellAggregateQuery(
    string EntityId,
    string RowByFieldId,
    string ColumnByFieldId,
    string Aggregate,
    string? FieldId = null)
{
    public IReadOnlyList<NendoRecordFilter> Filters { get; init; } = [];
}

/// <summary>
/// One cell of a grid. <see cref="RowKey"/> and <see cref="ColumnKey"/> are stored choice
/// IDs, "true" or "false", or null for that axis's unset lane. <see cref="Value"/> is null
/// over a cell that contributed no value, which is stated as empty, never as zero.
/// </summary>
public sealed record NendoRecordAggregateCell(
    string? RowKey,
    string? ColumnKey,
    System.Text.Json.JsonElement? Value,
    long ContributingRecords)
{
    /// <summary>The exact numeric lexeme, or null over an empty cell; see <see cref="NendoRecordAggregate.ValueLexeme"/>.</summary>
    public string? ValueLexeme => Value?.GetRawText();
}

/// <summary>
/// Every cell of the grid, in row-major order: each configured row in the field's order
/// and then the unset row, and within a row each configured column and then the unset
/// column. <see cref="RowKeys"/> and <see cref="ColumnKeys"/> carry the configured keys
/// without their unset lanes, so a caller draws the grid from the shape rather than
/// inferring it from which cells carry a number. <see cref="Unrecognised"/> counts records
/// whose stored value on either axis is none of that field's options; such a value is a
/// data issue the renderer states, never a cell nobody configured.
/// </summary>
public sealed record NendoRecordCellAggregate(
    string EntityId,
    string RowByFieldId,
    string ColumnByFieldId,
    string Aggregate,
    string? FieldId,
    IReadOnlyList<string> RowKeys,
    IReadOnlyList<string> ColumnKeys,
    IReadOnlyList<NendoRecordAggregateCell> Cells,
    long Unrecognised,
    long ChangeSequence);

public sealed record NendoHistoryQuery(int Limit = 50, string? Cursor = null, bool NewestFirst = true);

public sealed record NendoRevisionOperationsQuery(string RevisionId, int Limit = 50, string? Cursor = null);

public sealed record NendoPage<T>(IReadOnlyList<T> Items, string? NextCursor, long ChangeSequence);

/// <summary>A bounded history entry. Operation payloads are deliberately absent.</summary>
public sealed record NendoRevisionSummary(
    string RevisionId,
    DateTimeOffset CreatedAt,
    string Origin,
    string Description,
    NendoRevisionLane Lane,
    long DefinitionRevisionBefore,
    long DefinitionRevisionAfter,
    long DataRevisionBefore,
    long DataRevisionAfter,
    long ChangeSequence,
    string OperationDigest,
    string? ProposalId,
    string? ProposalDigest,
    string? CompensationOfRevisionId,
    long OperationCount,
    bool CanRequestCompensation);
