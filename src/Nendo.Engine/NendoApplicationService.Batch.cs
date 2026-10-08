using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

/// <summary>What one record's part of a batch does.</summary>
public enum NendoRecordWriteKind
{
    Create,
    Update,
    Delete,
}

/// <summary>
/// One record's part of a batch: a create with its values, an update of some fields against the
/// version the caller read, or a delete against that version. <c>KeptInNewFiles</c> marks a
/// created or updated record in the same revision (ADR-0022): true keeps it in a new file, false
/// leaves it out, and null changes nothing, so a create follows its record type.
/// </summary>
public sealed record NendoRecordWrite(
    NendoRecordWriteKind Kind,
    string EntityId,
    string RecordId,
    IReadOnlyDictionary<string, object?>? Values = null,
    long? ExpectedRecordVersion = null,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null,
    bool? KeptInNewFiles = null);

/// <summary>
/// Several records written as one revision. <c>Label</c> is what History calls the revision; a
/// batch without one is described by what it does.
/// </summary>
public sealed record NendoRecordWritesRequest(
    IReadOnlyList<NendoRecordWrite> Writes,
    NendoRequestContext Context,
    string? Label = null);

/// <summary>A record a batch wrote and the version it now holds; null once deleted, and on a replay.</summary>
public sealed record NendoWrittenRecord(string EntityId, string RecordId, long? RecordVersion);

/// <summary>What a batch wrote: the revision, and each record in the order it was written.</summary>
public sealed record NendoRecordWritesResult(NendoApplyResult Applied, IReadOnlyList<NendoWrittenRecord> Records);

/// <summary>
/// A view undoing a batch it wrote, or with <c>Redo</c> redoing an undo (ADR-0023). The context's
/// origin must be the revision's; <c>Label</c> names the step in History, and without one it is
/// "Undo" or "Redo" and the gesture's name.
/// </summary>
public sealed record NendoUndoRecordWritesRequest(
    string RevisionId,
    NendoRequestContext Context,
    bool Redo,
    string? Label = null);

public sealed partial class NendoApplicationService
{
    /// <summary>Bounded so one batch stays one gesture's worth of writes, not an import.</summary>
    public const int MaximumRecordWrites = 200;

    /// <summary>The longest name a batch may give its revision in History.</summary>
    public const int MaximumRecordWritesLabelCharacters = 80;

    /// <summary>
    /// Creates, updates and deletes across record types as one mutation, so they commit together
    /// or not at all and read as one revision in History. Each expands to the canonical
    /// operations its single-record form makes: a create is one <c>data.createRecord</c>, an
    /// update one <c>data.setField</c> per value against consecutive versions, a delete one
    /// <c>data.deleteRecord</c>.
    /// <para>
    /// A record is written at most once in a batch, so the version a caller read is the version
    /// its write expects. A reference to a record written earlier in the same batch is checked
    /// against the version that write leaves, which the caller cannot know: this fills it in, as
    /// it would be after the earlier write committed on its own. A reference to a record the
    /// batch deletes earlier is refused by the store as a missing target.
    /// </para>
    /// </summary>
    public async Task<NendoRecordWritesResult> ApplyRecordWritesAsync(
        NendoRecordWritesRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Writes);
        RequireContext(request.Context);
        if (request.Writes.Count is < 1 or > MaximumRecordWrites)
        {
            throw new NendoValidationException(
                $"A batch carries 1-{MaximumRecordWrites} record writes; this one carries {request.Writes.Count}.");
        }
        if (request.Label is { } label &&
            (string.IsNullOrWhiteSpace(label) || label.Length > MaximumRecordWritesLabelCharacters))
        {
            throw new NendoValidationException(
                $"A batch's label is text of 1 to {MaximumRecordWritesLabelCharacters} characters.");
        }

        var snapshot = await _coordinator.GetDefinitionSnapshotAsync(cancellationToken);
        var entities = snapshot.Entities.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        var seen = new HashSet<(string EntityId, string RecordId)>();
        // The version each record holds once the writes before it have run; a deleted one leaves.
        var versions = new Dictionary<(string EntityId, string RecordId), long>();
        var written = new List<NendoWrittenRecord>(request.Writes.Count);
        var operations = new List<NendoOperation>();
        string NextOperationId() => NendoCanonical.DeterministicId(
            "operation", request.Context.IdempotencyScope, request.Context.IdempotencyKey, operations.Count);

        for (var index = 0; index < request.Writes.Count; index++)
        {
            var write = request.Writes[index] ?? throw new NendoValidationException($"Write {index} is missing.");
            RequireIdentity(write.EntityId, "entity ID");
            RequireIdentity(write.RecordId, "record ID");
            if (!entities.TryGetValue(write.EntityId, out var entity))
                throw new NendoPreconditionException("entity-not-found", $"Entity {write.EntityId} does not exist.");
            if (!seen.Add((write.EntityId, write.RecordId)))
            {
                throw new NendoValidationException(
                    $"Record {write.RecordId} is written twice in one batch; put its changes in one write.");
            }
            switch (write.Kind)
            {
                case NendoRecordWriteKind.Create:
                    if (write.Values is null) throw new NendoValidationException($"Write {index} creates a record without values.");
                    if (write.ExpectedRecordVersion is not null)
                        throw new NendoValidationException($"Write {index} creates a record, which has no version yet.");
                    operations.Add(new CreateRecordOperation(NextOperationId(), write.EntityId, write.RecordId, write.Values,
                        TargetVersionsWithin(entity, write, versions)));
                    versions[(write.EntityId, write.RecordId)] = 1;
                    break;
                case NendoRecordWriteKind.Update:
                    if (write.Values is null || write.Values.Count is < 1 or > MaximumFieldsPerUpdate)
                        throw new NendoValidationException($"Write {index} updates 1-{MaximumFieldsPerUpdate} fields.");
                    var expected = RequireWriteVersion(write, index);
                    var targets = TargetVersionsWithin(entity, write, versions);
                    var ordinal = 0;
                    foreach (var pair in write.Values.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                    {
                        operations.Add(new SetFieldOperation(NextOperationId(), write.EntityId, write.RecordId, pair.Key,
                            expected + ordinal, pair.Value, targets.TryGetValue(pair.Key, out var target) ? target : null));
                        ordinal++;
                    }
                    versions[(write.EntityId, write.RecordId)] = expected + ordinal;
                    break;
                case NendoRecordWriteKind.Delete:
                    if (write.Values is not null || write.ExpectedTargetVersions is not null)
                        throw new NendoValidationException($"Write {index} deletes a record and carries no values.");
                    if (write.KeptInNewFiles is not null)
                        throw new NendoValidationException($"Write {index} deletes a record, which no new file can keep.");
                    operations.Add(new DeleteRecordOperation(NextOperationId(), write.EntityId, write.RecordId,
                        RequireWriteVersion(write, index)));
                    versions.Remove((write.EntityId, write.RecordId));
                    break;
                default:
                    throw new NendoValidationException($"Write {index} is not a create, an update or a delete.");
            }
            // The mark is a fact about the record, not a value: it moves no version (ADR-0022).
            if (write.KeptInNewFiles is { } kept)
                operations.Add(new SetRecordKeptInNewFilesOperation(NextOperationId(), write.EntityId, write.RecordId, kept));
            written.Add(new NendoWrittenRecord(write.EntityId, write.RecordId,
                versions.TryGetValue((write.EntityId, write.RecordId), out var version) ? version : null));
        }

        var applied = await _coordinator.ApplyAsync(
            new NendoMutation(
                request.Context.IdempotencyScope,
                request.Context.IdempotencyKey,
                request.Context.Origin,
                request.Label ?? DescribeRecordWrites(request.Writes, entities),
                operations),
            cancellationToken);
        if (applied.IsIdempotentReplay)
            return new NendoRecordWritesResult(applied, [.. written.Select(record => record with { RecordVersion = null })]);

        // An automatic action can write back to a record of the batch inside the same revision;
        // the store states the version it left, which wins over the arithmetic above.
        var committed = applied.GeneratedChanges
            .GroupBy(change => (change.EntityId, change.RecordId))
            .ToDictionary(group => group.Key, group => group.Last().RecordVersion);
        return new NendoRecordWritesResult(applied, [.. written.Select(record =>
            committed.TryGetValue((record.EntityId, record.RecordId), out var actual)
                ? record with { RecordVersion = actual }
                : record)]);
    }

    /// <summary>
    /// Reverses a revision of record changes its own origin wrote, as one new revision linked to
    /// it (ADR-0023): updates put back, deletes restored, creates and restores deleted, in the
    /// opposite order and against the versions the revision left. A record changed, deleted or
    /// newly pointed at since refuses the whole step, and nothing is written. Redo is the same
    /// call on the undo's revision.
    /// </summary>
    public async Task<NendoRecordWritesResult> UndoRecordWritesAsync(
        NendoUndoRecordWritesRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireContext(request.Context);
        RequireIdentity(request.RevisionId, "revision ID");
        if (request.Label is { } label &&
            (string.IsNullOrWhiteSpace(label) || label.Length > MaximumRecordWritesLabelCharacters))
        {
            throw new NendoValidationException(
                $"An undo's label is text of 1 to {MaximumRecordWritesLabelCharacters} characters.");
        }
        var (applied, mutation) = await _coordinator.CompensateRevisionAsync(
            request.RevisionId,
            request.Context.IdempotencyKey,
            new NendoCompensationCaller(request.Context.IdempotencyScope, request.Context.Origin, request.Redo, request.Label),
            cancellationToken);

        // Each record once, where it first appears, at the version its last inverse leaves.
        var order = new List<(string EntityId, string RecordId)>();
        var versions = new Dictionary<(string EntityId, string RecordId), long?>();
        foreach (var operation in mutation.Operations)
        {
            ((string EntityId, string RecordId) Key, long? Version) planned = operation switch
            {
                SetFieldOperation edit => ((edit.EntityId, edit.RecordId), edit.ExpectedRecordVersion + 1),
                BackfillRetiredFieldOperation backfill => ((backfill.Edit.EntityId, backfill.Edit.RecordId), backfill.Edit.ExpectedRecordVersion + 1),
                RestoreDeletedRecordOperation restore => ((restore.EntityId, restore.RecordId), restore.DeletedVersion + 1),
                DeleteRecordOperation delete => ((delete.EntityId, delete.RecordId), null),
                _ => throw new InvalidOperationException($"A view's undo planned {operation.OperationType}."),
            };
            if (!versions.ContainsKey(planned.Key)) order.Add(planned.Key);
            versions[planned.Key] = planned.Version;
        }
        if (applied.IsIdempotentReplay)
            return new NendoRecordWritesResult(applied, [.. order.Select(key => new NendoWrittenRecord(key.EntityId, key.RecordId, null))]);
        var committed = applied.GeneratedChanges
            .GroupBy(change => (change.EntityId, change.RecordId))
            .ToDictionary(group => group.Key, group => group.Last().RecordVersion);
        return new NendoRecordWritesResult(applied, [.. order.Select(key => new NendoWrittenRecord(key.EntityId, key.RecordId,
            committed.TryGetValue(key, out var actual) ? actual : versions[key]))]);
    }

    private static long RequireWriteVersion(NendoRecordWrite write, int index) =>
        write.ExpectedRecordVersion is >= 1 and var version
            ? version
            : throw new NendoValidationException($"Write {index} needs the record's version, a whole number from 1.");

    /// <summary>
    /// The caller's target versions, with each reference to a record written earlier in the
    /// batch checked against the version that write leaves.
    /// </summary>
    private static IReadOnlyDictionary<string, long> TargetVersionsWithin(
        NendoEntitySnapshot entity,
        NendoRecordWrite write,
        IReadOnlyDictionary<(string EntityId, string RecordId), long> versions)
    {
        var targets = new Dictionary<string, long>(
            write.ExpectedTargetVersions ?? new Dictionary<string, long>(), StringComparer.Ordinal);
        foreach (var field in entity.Fields.Where(field => field.StorageKind == NendoStorageKind.Reference))
        {
            if (write.Values is null || !write.Values.TryGetValue(field.FieldId, out var value)) continue;
            var targetId = value switch
            {
                string text => text,
                JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
                _ => null,
            };
            if (targetId is not null && field.Reference is { } reference &&
                versions.TryGetValue((reference.TargetEntityId, targetId), out var version)) targets[field.FieldId] = version;
        }
        return targets;
    }

    private static string DescribeRecordWrites(
        IReadOnlyList<NendoRecordWrite> writes,
        IReadOnlyDictionary<string, NendoEntitySnapshot> entities)
    {
        if (writes.Count == 1)
        {
            var only = writes[0];
            return $"{Verb(only.Kind)} {entities[only.EntityId].DisplayName}";
        }
        var kinds = writes.Select(write => write.Kind).Distinct().ToArray();
        var types = writes.Select(write => write.EntityId).Distinct(StringComparer.Ordinal).ToArray();
        return kinds.Length == 1 && types.Length == 1
            ? $"{Verb(kinds[0])} {writes.Count} {entities[types[0]].DisplayName}"
            : $"Change {writes.Count} records";

        static string Verb(NendoRecordWriteKind kind) => kind switch
        {
            NendoRecordWriteKind.Create => "Create",
            NendoRecordWriteKind.Update => "Edit",
            _ => "Delete",
        };
    }
}
