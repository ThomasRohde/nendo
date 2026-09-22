using System.Text.Json;

namespace Nendo.Engine;

/// <summary>Changes an existing stable choice's label/availability without rewriting record values.</summary>
public sealed record SetChoiceMetadataOperation : NendoOperation
{
    public SetChoiceMetadataOperation(string operationId, string entityId, string fieldId, string choiceId,
        string displayName, bool retired, long expectedDefinitionRevision, string? tone = null) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId));
        ChoiceId = Require(choiceId, nameof(choiceId)); DisplayName = Require(displayName, nameof(displayName));
        Retired = retired; ExpectedDefinitionRevision = expectedDefinitionRevision;
        Tone = string.IsNullOrWhiteSpace(tone) ? null : tone;
    }
    public string EntityId { get; }
    public string FieldId { get; }
    public string ChoiceId { get; }
    public string DisplayName { get; }
    public bool Retired { get; }
    /// <summary>
    /// The option's colour as a closed named hue, or null for none. The operation sets
    /// the whole of an option's metadata, so a rename that omits the tone clears it —
    /// and the review line says so.
    /// </summary>
    public string? Tone { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setChoiceMetadata";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, choiceId = ChoiceId, displayName = DisplayName,
            retired = Retired, tone = Tone, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
