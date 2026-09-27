using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Declares a field unique, or stops (ADR-0020): no two records of the type may hold equal
/// values in it, whoever writes them. Text compares case-insensitively for ASCII letters; an
/// empty value never collides. Declaring over data that already collides is refused, naming
/// the values; nothing is renumbered.
/// </summary>
public sealed record SetFieldUniqueOperation : NendoOperation
{
    public SetFieldUniqueOperation(string operationId, string entityId, string fieldId, bool unique, long expectedDefinitionRevision)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        FieldId = Require(fieldId, nameof(fieldId));
        Unique = unique;
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public string FieldId { get; }
    public bool Unique { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setFieldUnique";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        fieldId = FieldId,
        unique = Unique,
    });
}
