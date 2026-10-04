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
/// <summary>RecordVersion is null when an automatic action deleted the moved record.</summary>
public sealed record NendoMoveRecordResult(NendoApplyResult Applied, long? RecordVersion, IReadOnlyList<string> TouchedRecordIds);

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
        // Sibling geometry is mutable, so the operation expansion is not the request's
        // stable identity. Bind every move input into the canonical operation IDs and
        // recognize its saved receipt before looking at the tree it left behind.
        var identity = JsonSerializer.Serialize(request);
        if (await ReplayMoveAsync(request, identity, cancellationToken) is { } replay) return replay;
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
                MoveOperationId(identity, operations.Count),
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
            else if (at == siblings.Count) placed = lower is { } last ? RepresentableOrder((Int128)last + NendoHierarchyLimits.OrderGap) : null;
            else if (at == 0) placed = upper is { } first ? RepresentableOrder((Int128)first - NendoHierarchyLimits.OrderGap) : null;
            else placed = lower is { } previous && upper is { } next && (Int128)next - previous >= 2
                ? RepresentableOrder(previous + ((Int128)next - previous) / 2) : null;
            if (placed is { } value)
            {
                if (value != current) operations.Add(Set(request.RecordId, orderField, version, value));
            }
            else
            {
                // No gap at the insertion point: number afresh the smallest run of siblings
                // around it that fits between its ordered neighbours, the moved record in its
                // place. Until 2026-10-04 the whole level was renumbered, so one move past a
                // sibling without an order rewrote every record at that level (F-260).
                var ordered = siblings.Select(sibling => (sibling.RecordId, sibling.Version, sibling.Order)).ToList();
                ordered.Insert(at, (request.RecordId, version, current));
                foreach (var (index, renumbered) in RenumberedWindow(ordered.Select(entry => entry.Order).ToList(), at))
                {
                    var (id, expected, order) = ordered[index];
                    if (order != renumbered) operations.Add(Set(id, orderField, expected, renumbered));
                }
            }
        }

        // Another identical caller may have committed while these reads were in flight.
        if (await ReplayMoveAsync(request, identity, cancellationToken) is { } concurrentReplay) return concurrentReplay;
        if (operations.Count == 0)
            throw new NendoPreconditionException("move-unchanged", $"{request.RecordId} is already there.");
        var applied = await _coordinator.ApplyAsync(new NendoMutation(request.Context.IdempotencyScope, request.Context.IdempotencyKey,
            request.Context.Origin, $"Move {entity.DisplayName} {request.RecordId}", operations), cancellationToken);
        if (applied.IsIdempotentReplay)
            return await ReplayMoveAsync(request, identity, cancellationToken)
                ?? throw new NendoPreconditionException("move-receipt-unavailable", "The committed move's history is no longer available.");
        var touched = operations.Cast<SetFieldOperation>().Select(operation => operation.RecordId).Distinct(StringComparer.Ordinal).ToArray();
        var moved = operations.Cast<SetFieldOperation>().Count(operation => operation.RecordId == request.RecordId);
        var authoredVersion = request.ExpectedRecordVersion + moved;
        var generated = applied.GeneratedChanges.LastOrDefault(change => change.EntityId == request.EntityId && change.RecordId == request.RecordId);
        long? committedVersion = generated is null ? authoredVersion
            : generated.RecordVersion is { } written ? Math.Max(written, authoredVersion) : null;
        return new(applied, committedVersion, touched);
    }

    private static long? RepresentableOrder(Int128 order) => order >= long.MinValue && order <= long.MaxValue ? (long)order : null;

    /// <summary>
    /// The siblings to renumber around position <paramref name="at"/> of <paramref name="orders"/>,
    /// each with its new order: the smallest window containing <paramref name="at"/> whose
    /// members fit strictly between the ordered neighbours outside it. A neighbour without
    /// an order is taken into the window, since nothing can be placed relative to it; a
    /// window that reaches either end of the list is open on that side and always fits.
    /// </summary>
    internal static IReadOnlyList<(int Index, long Order)> RenumberedWindow(IReadOnlyList<long?> orders, int at)
    {
        var last = orders.Count - 1;
        int from = at, to = at;
        while (true)
        {
            var lowOpen = from == 0;
            var highOpen = to == last;
            if (!lowOpen && orders[from - 1] is null) { from--; continue; }
            if (!highOpen && orders[to + 1] is null) { to++; continue; }
            var size = to - from + 1;
            if (lowOpen || highOpen) break;
            if ((Int128)orders[to + 1]!.Value - orders[from - 1]!.Value - 1 >= size) break;
            // Grow towards the nearer end, so a run in the middle stays centred on the move.
            if (to - at <= at - from) to++; else from--;
        }
        return Assign(orders, from, to) ?? Assign(orders, 0, last)!;
    }

    /// <summary>The new orders of the window, or null when a step past a bound does not fit in a long.</summary>
    private static IReadOnlyList<(int Index, long Order)>? Assign(IReadOnlyList<long?> orders, int from, int to)
    {
        var size = to - from + 1;
        Int128? low = from > 0 ? orders[from - 1] : null;
        Int128? high = to < orders.Count - 1 ? orders[to + 1] : null;
        var step = low is { } l && high is { } h ? (h - l) / (size + 1) : NendoHierarchyLimits.OrderGap;
        var assigned = new List<(int, long)>(size);
        for (var index = from; index <= to; index++)
        {
            var position = index - from + 1;
            var order = low is { } start ? start + step * position
                : high is { } end ? end - step * (size - position + 1)
                : step * position;
            if (RepresentableOrder(order) is not { } representable) return null;
            assigned.Add((index, representable));
        }
        return assigned;
    }

    private static string MoveOperationId(string identity, int ordinal) =>
        NendoCanonical.DeterministicId("operation", "data.moveRecord", identity, ordinal);

    private async Task<NendoMoveRecordResult?> ReplayMoveAsync(NendoMoveRecordRequest request, string identity,
        CancellationToken cancellationToken)
    {
        var receipt = await _coordinator.GetMutationReceiptAsync(new(request.Context.IdempotencyScope, request.Context.IdempotencyKey), cancellationToken);
        if (receipt is null) return null;
        var page = await QueryRevisionOperationsAsync(new(receipt.RevisionId, 100), cancellationToken);
        if (page.Items.FirstOrDefault()?.OperationId != MoveOperationId(identity, 0))
            throw new NendoIdempotencyConflictException("This move request already identifies different inputs.");

        var touched = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var authored = 0;
        var version = request.ExpectedRecordVersion;
        var deleted = false;
        do
        {
            foreach (var stored in page.Items)
            {
                var operation = NendoOperationCodec.Read(stored.CanonicalJson);
                if (operation is DeleteRecordOperation deletion && deletion.EntityId == request.EntityId && deletion.RecordId == request.RecordId)
                    deleted = true;
                if (operation is not SetFieldOperation field) continue;
                if (field.OperationId == MoveOperationId(identity, authored))
                {
                    authored++;
                    if (seen.Add(field.RecordId)) touched.Add(field.RecordId);
                }
                // Rebuild this revision's version, including action writes, rather than
                // substituting the current version of a record edited since the move.
                if (field.EntityId == request.EntityId && field.RecordId == request.RecordId)
                    version = Math.Max(version, field.ExpectedRecordVersion + 1);
            }
            if (page.NextCursor is null) break;
            page = await QueryRevisionOperationsAsync(new(receipt.RevisionId, 100, page.NextCursor), cancellationToken);
        } while (true);
        return new(receipt, deleted ? null : version, touched);
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
