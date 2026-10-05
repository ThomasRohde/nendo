using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Changes how a Text field is shown and edited, between the text presentations: a single line,
/// long text and Markdown (W-173). No stored value changes, which is what keeps it to these three:
/// a choice or a date would make values invalid that were valid a moment before. A field written
/// as long text before Markdown existed can be shown formatted without being copied into a new one.
/// </summary>
public sealed record SetFieldPresentationOperation : NendoOperation
{
    /// <summary>The presentations a Text field may move between; every value stays valid in each.</summary>
    public static readonly IReadOnlySet<string> TextPresentations = new HashSet<string>(["singleLine", "longText", "markdown"], StringComparer.Ordinal);

    public SetFieldPresentationOperation(string operationId, string entityId, string fieldId, string presentation, long expectedDefinitionRevision)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        FieldId = Require(fieldId, nameof(fieldId));
        Presentation = Require(presentation, nameof(presentation));
        if (!TextPresentations.Contains(Presentation))
            throw new NendoValidationException(
                $"A field's presentation can change only between singleLine, longText and markdown, which keep every value valid; {Presentation} is not one of them.");
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public string FieldId { get; }
    public string Presentation { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setFieldPresentation";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.Reversible;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        fieldId = FieldId,
        presentation = Presentation,
    });
}
