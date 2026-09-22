using System.Text.Json;

namespace Nendo.Engine;

public sealed record SetFieldRequiredOperation : NendoOperation
{
    public SetFieldRequiredOperation(string operationId, string entityId, string fieldId, bool required, long expectedDefinitionRevision) : base(operationId)
    { EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId)); Required = required; ExpectedDefinitionRevision = expectedDefinitionRevision; }
    public string EntityId { get; }
    public string FieldId { get; }
    public bool Required { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setFieldRequired";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, required = Required, expectedDefinitionRevision = ExpectedDefinitionRevision });
}

/// <summary>Explicit proposal repair of a retained field; ordinary data adapters cannot invoke this operation.</summary>
public sealed record BackfillRetiredFieldOperation : NendoOperation
{
    public BackfillRetiredFieldOperation(string operationId, string entityId, string recordId, string fieldId,
        long expectedRecordVersion, object? value, long? expectedTargetRecordVersion = null) : base(operationId)
    { Edit = new(operationId, entityId, recordId, fieldId, expectedRecordVersion, value, expectedTargetRecordVersion); }
    internal SetFieldOperation Edit { get; }
    public override string OperationType => "data.backfillRetiredField";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => Edit.WritePayload(writer);
}
