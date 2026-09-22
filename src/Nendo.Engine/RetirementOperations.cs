using System.Text.Json;

namespace Nendo.Engine;

public sealed record SetRetiredOperation : NendoOperation
{
    public SetRetiredOperation(string operationId, string entityId, string? fieldId, bool retired, long expectedDefinitionRevision) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = fieldId is null ? null : Require(fieldId, nameof(fieldId));
        Retired = retired; ExpectedDefinitionRevision = expectedDefinitionRevision;
    }
    public string EntityId { get; }
    public string? FieldId { get; }
    public bool Retired { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setRetired";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, retired = Retired, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
