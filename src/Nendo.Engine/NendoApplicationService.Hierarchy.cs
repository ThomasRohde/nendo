using System.Globalization;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Move a record in its record type's declared hierarchy (ADR-0019): under another parent, or to
/// the top level with a null parent, and with an order field before a named sibling or last.
/// </summary>
public sealed record NendoMoveRecordRequest(
    string EntityId,
    string RecordId,
    long ExpectedRecordVersion,
    string? ParentRecordId,
    long? ExpectedParentVersion,
    string? BeforeRecordId,
    NendoRequestContext Context);

/// <summary>What a move wrote: the moved record's new version and every record it touched.</summary>
public sealed record NendoMoveRecordResult(NendoApplyResult Applied, long RecordVersion, IReadOnlyList<string> TouchedRecordIds);

public sealed partial class NendoApplicationService
{
    /// <summary>
    /// A move is a convenience that expands into canonical <c>data.setField</c> operations in one
    /// revision, as every whole-document convenience does: the record's parent, its order, and —
    /// only when the neighbours leave no integer gap — the new siblings renumbered, each against
    /// the version this read saw. The Engine's hierarchy rule refuses a move under the record's
    /// own descendants, or deeper than the bound, whatever this computes.
    /// </summary>
    public async Task<NendoMoveRecordResult> MoveRecordAsync(NendoMoveRecordRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID");
        RequireIdentity(request.RecordId, "record ID");
        RequireContext(request.Context);
        if (request.ExpectedRecordVersion < 1) throw new NendoValidationException("Record versions begin at one.");
        var entity = await RequireEntityAsync(request.EntityId, cancellationToken);
        var hierarchy = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy, so its records cannot be moved in one.");
        if (request.BeforeRecordId is not null && hierarchy.OrderFieldId is null)
            throw new NendoPreconditionException("hierarchy-order-not-declared",
                $"{entity.DisplayName}'s hierarchy declares no order field, so a record cannot be placed before another.");
        if (request.BeforeRecordId == request.RecordId)
            throw new NendoValidationException("A record cannot be placed before itself.");
        if (request.ParentRecordId is not null && request.ExpectedParentVersion is null)
            throw new NendoPreconditionException("target-version-required", "Moving under a parent needs that parent's current version.");

        var record = (await QueryRecordsAsync(new(entity.EntityId, 1) { RecordId = request.RecordId }, cancellationToken)).Items.SingleOrDefault()
            ?? throw new NendoPreconditionException("record-not-found", $"Record {request.RecordId} does not exist.");
        var currentParent = Text(record.Values.GetValueOrDefault(hierarchy.ParentFieldId));

        var operations = new List<NendoOperation>();
        var version = request.ExpectedRecordVersion;
        NendoOperation Set(string recordId, string fieldId, long expected, object? value, long? targetVersion = null) =>
            new SetFieldOperation(
                NendoCanonical.DeterministicId("operation", request.Context.IdempotencyScope, request.Context.IdempotencyKey, operations.Count),
                entity.EntityId, recordId, fieldId, expected, value, targetVersion);

        if (currentParent != request.ParentRecordId)
        {
            operations.Add(Set(request.RecordId, hierarchy.ParentFieldId, version, request.ParentRecordId, request.ExpectedParentVersion));
            version++;
        }

        if (hierarchy.OrderFieldId is { } orderField)
        {
            var siblings = await SiblingsAsync(entity, hierarchy, request.ParentRecordId, request.RecordId, cancellationToken);
            var at = request.BeforeRecordId is null ? siblings.Count : siblings.FindIndex(sibling => sibling.RecordId == request.BeforeRecordId);
            if (at < 0)
                throw new NendoPreconditionException("hierarchy-sibling-not-found",
                    $"{request.BeforeRecordId} is not a child of {request.ParentRecordId ?? "the top level"}.");
            var lower = at > 0 ? siblings[at - 1].Order : null;
            var upper = at < siblings.Count ? siblings[at].Order : null;
            var current = Integer(record.Values.GetValueOrDefault(orderField));
            // Keep the record's order if it already falls between its new neighbours; otherwise
            // take the middle of the gap, or a step beyond the first or last sibling. A missing
            // neighbour value, or neighbours one apart, leaves no gap.
            long? placed;
            if (current is { } kept && (at == 0 || lower < kept) && (at == siblings.Count || kept < upper)) placed = kept;
            else if (siblings.Count == 0) placed = NendoHierarchyLimits.OrderGap;
            else if (at == siblings.Count) placed = lower + NendoHierarchyLimits.OrderGap;
            else if (at == 0) placed = upper - NendoHierarchyLimits.OrderGap;
            else placed = lower is { } previous && upper is { } next && next - previous >= 2 ? previous + (next - previous) / 2 : null;
            if (placed is { } value)
            {
                if (value != current) operations.Add(Set(request.RecordId, orderField, version, value));
            }
            else
            {
                // No gap: number the whole sibling list afresh, the moved record in its place.
                var ordered = siblings.Select(sibling => (sibling.RecordId, sibling.Version, sibling.Order)).ToList();
                ordered.Insert(at, (request.RecordId, version, current));
                for (var index = 0; index < ordered.Count; index++)
                {
                    var (id, expected, order) = ordered[index];
                    var renumbered = (index + 1) * NendoHierarchyLimits.OrderGap;
                    if (order != renumbered) operations.Add(Set(id, orderField, expected, renumbered));
                }
            }
        }

        if (operations.Count == 0)
            throw new NendoPreconditionException("move-unchanged", $"{request.RecordId} is already there.");
        var applied = await _coordinator.ApplyAsync(new NendoMutation(request.Context.IdempotencyScope, request.Context.IdempotencyKey,
            request.Context.Origin, $"Move {entity.DisplayName} {request.RecordId}", operations), cancellationToken);
        var touched = operations.Cast<SetFieldOperation>().Select(operation => operation.RecordId).Distinct(StringComparer.Ordinal).ToArray();
        var moved = operations.Cast<SetFieldOperation>().Count(operation => operation.RecordId == request.RecordId);
        return new(applied, request.ExpectedRecordVersion + moved, touched);
    }

    private sealed record Sibling(string RecordId, long Version, long? Order);

    /// <summary>The records under a parent, or at the top level, in sibling order, without the moved one.</summary>
    private async Task<List<Sibling>> SiblingsAsync(NendoEntitySnapshot entity, NendoHierarchy hierarchy, string? parent, string excluded,
        CancellationToken cancellationToken)
    {
        var filter = parent is null
            ? new NendoRecordFilter(hierarchy.ParentFieldId, "isNull")
            : new NendoRecordFilter(hierarchy.ParentFieldId, "eq", JsonSerializer.SerializeToElement(parent));
        var siblings = new List<Sibling>();
        string? cursor = null;
        do
        {
            var page = await QueryRecordsAsync(new(entity.EntityId, 100, cursor) { SortFieldId = hierarchy.OrderFieldId, Filters = [filter] }, cancellationToken);
            siblings.AddRange(page.Items.Where(item => item.RecordId != excluded)
                .Select(item => new Sibling(item.RecordId, item.RecordVersion, Integer(item.Values.GetValueOrDefault(hierarchy.OrderFieldId!)))));
            cursor = page.NextCursor;
            if (siblings.Count > NendoHierarchyLimits.MaximumDescendants)
                throw new NendoPreconditionException("hierarchy-too-wide",
                    $"More than {NendoHierarchyLimits.MaximumDescendants} records share this parent, which is more than a move reads.");
        } while (cursor is not null);
        // Unordered siblings sort last, then by record ID, as the tree read orders them.
        return siblings.OrderBy(sibling => sibling.Order is null).ThenBy(sibling => sibling.Order)
            .ThenBy(sibling => sibling.RecordId, StringComparer.Ordinal).ToList();
    }

    private static string? Text(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static long? Integer(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number => value.GetInt64(),
        JsonValueKind.String when long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) => parsed,
        JsonValueKind.Object when value.TryGetProperty("$nendoNumber", out var lexeme) &&
            long.TryParse(lexeme.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var exact) => exact,
        _ => null,
    };
}
