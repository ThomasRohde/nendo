using System.Text.Json;

namespace Nendo.Engine;

public sealed record DeleteRecordOperation : NendoOperation
{
    public DeleteRecordOperation(string operationId, string entityId, string recordId, long expectedRecordVersion) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        RecordId = Require(recordId, nameof(recordId));
        if (expectedRecordVersion < 1) throw new NendoValidationException("A positive record version is required.");
        ExpectedRecordVersion = expectedRecordVersion;
    }
    public string EntityId { get; }
    public string RecordId { get; }
    public long ExpectedRecordVersion { get; }
    public override string OperationType => "data.deleteRecord";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, recordId = RecordId, expectedRecordVersion = ExpectedRecordVersion });
}

// Restoration is constructed only from retained history, never from client-supplied values.
internal sealed record RestoreDeletedRecordOperation(string Id, string EntityId, string RecordId, long DeletedVersion) : NendoOperation(Id)
{
    public override string OperationType => "data.restoreDeletedRecord";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    /// <summary>
    /// The version each reference target will hold when the restore runs, for the targets the
    /// compensated revision itself wrote: a parent whose count the deletion's automatic action
    /// updated is at the version the planned inverses leave it, not the one it held at the
    /// delete. Worked out from the revision's own evidence, never from the file now.
    /// Absent for every other target, so a restore that plans none keeps its earlier shape.
    /// </summary>
    internal IReadOnlyDictionary<string, long>? PlannedTargetVersions { get; init; }

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        if (PlannedTargetVersions is { Count: > 0 } planned)
            JsonSerializer.Serialize(writer, new { entityId = EntityId, recordId = RecordId, deletedVersion = DeletedVersion,
                plannedTargetVersions = new SortedDictionary<string, long>(planned.ToDictionary(pair => pair.Key, pair => pair.Value), StringComparer.Ordinal) });
        else
            JsonSerializer.Serialize(writer, new { entityId = EntityId, recordId = RecordId, deletedVersion = DeletedVersion });
    }
}
