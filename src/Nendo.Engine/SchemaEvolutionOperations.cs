using System.Text.Json;

namespace Nendo.Engine;

public sealed record RenameEntityOperation : NendoOperation
{
    public RenameEntityOperation(string operationId, string entityId, string displayName, long expectedDefinitionRevision) : base(operationId)
    { EntityId = Require(entityId, nameof(entityId)); DisplayName = Require(displayName, nameof(displayName)); ExpectedDefinitionRevision = expectedDefinitionRevision; }
    public string EntityId { get; }
    public string DisplayName { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.renameEntity";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new { entityId = EntityId, displayName = DisplayName, expectedDefinitionRevision = ExpectedDefinitionRevision });
}

public sealed record RenameFieldOperation : NendoOperation
{
    public RenameFieldOperation(string operationId, string entityId, string fieldId, string displayName, long expectedDefinitionRevision) : base(operationId)
    { EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId)); DisplayName = Require(displayName, nameof(displayName)); ExpectedDefinitionRevision = expectedDefinitionRevision; }
    public string EntityId { get; }
    public string FieldId { get; }
    public string DisplayName { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.renameField";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new { entityId = EntityId, fieldId = FieldId, displayName = DisplayName, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
