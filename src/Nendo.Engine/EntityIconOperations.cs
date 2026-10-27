using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Gives a record type an icon from Nendo's set, or clears the choice so the icon is guessed from
/// its name again (ADR-0038). The icon is part of the definition and is drawn wherever the record
/// type is: the navigation, the tabs, the breadcrumb pickers, the command box and the front page.
/// </summary>
public sealed record SetEntityIconOperation : NendoOperation
{
    public SetEntityIconOperation(string operationId, string entityId, string? icon, long expectedDefinitionRevision)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        Icon = string.IsNullOrWhiteSpace(icon) ? null : icon.Trim();
        if (Icon is not null && !NendoIconSet.Contains(Icon))
            throw new NendoValidationException($"A record type's icon is one of Nendo's icons, and {NendoIconSet.UnknownText(Icon)}");
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }

    /// <summary>The icon's name in Nendo's set, or null for the icon guessed from the record type's name.</summary>
    public string? Icon { get; }

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setEntityIcon";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;

    // Its undo puts back the icon the evidence retained, including none.
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        icon = Icon,
    });
}
