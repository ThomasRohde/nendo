using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Installs one behaviour definition at its stable ID, creating it or replacing the
/// definition already there.
/// <para>
/// The definition travels as a typed value, not as a JSON blob the store trusts:
/// the payload is written from the validated record, and reading it back rebuilds
/// the same record. A file therefore cannot introduce a definition shape this host
/// does not implement by hand-writing the stored body.
/// </para>
/// <para>
/// Whole-definition convenience requests expand into these operations before any
/// diff, digest, history entry or promotion sees them.
/// </para>
/// </summary>
public sealed record SetBehaviourDefinitionOperation : NendoOperation
{
    public SetBehaviourDefinitionOperation(
        string operationId,
        NendoBehaviourDefinition definition,
        long expectedDefinitionRevision)
        : base(operationId)
    {
        Definition = definition ?? throw new ArgumentNullException(nameof(definition));
        Definition.Validate();
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public NendoBehaviourDefinition Definition { get; }

    public long ExpectedDefinitionRevision { get; }

    public override string OperationType => "behaviour.setDefinition";

    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;

    /// <summary>
    /// The inverse is the definition that was there before, or its removal when there
    /// was none. Both are recorded in the operation's evidence.
    /// </summary>
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("contractVersion", Definition.ContractVersion);
        writer.WriteString("definitionId", Definition.DefinitionId);
        writer.WriteString("definitionKind", Definition.Kind.ToString());
        writer.WriteNumber("expectedDefinitionRevision", ExpectedDefinitionRevision);
        if (Definition.OwningEntityId is { } entityId) writer.WriteString("owningEntityId", entityId);
        writer.WritePropertyName("body");
        using (var body = JsonDocument.Parse(Definition.CanonicalBody()))
        {
            body.RootElement.WriteTo(writer);
        }
        writer.WriteEndObject();
    }
}

/// <summary>
/// Removes one behaviour definition by stable ID.
/// <para>
/// Removing a definition something else still references is refused unless the same
/// ordered change set also removes or rewires that reference, so the file never holds
/// a calculation reading a function that is gone.
/// </para>
/// </summary>
public sealed record RemoveBehaviourDefinitionOperation : NendoOperation
{
    public RemoveBehaviourDefinitionOperation(
        string operationId,
        string definitionId,
        NendoBehaviourKind definitionKind,
        long expectedDefinitionRevision)
        : base(operationId)
    {
        DefinitionId = Require(definitionId, nameof(definitionId));
        DefinitionKind = definitionKind;
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string DefinitionId { get; }

    /// <summary>Stated by the author so a removal cannot silently hit a different kind.</summary>
    public NendoBehaviourKind DefinitionKind { get; }

    public long ExpectedDefinitionRevision { get; }

    public override string OperationType => "behaviour.removeDefinition";

    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;

    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new
        {
            definitionId = DefinitionId,
            definitionKind = DefinitionKind.ToString(),
            expectedDefinitionRevision = ExpectedDefinitionRevision,
        });
}
