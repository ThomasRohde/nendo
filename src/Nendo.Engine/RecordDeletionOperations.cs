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
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, recordId = RecordId, deletedVersion = DeletedVersion });
}
