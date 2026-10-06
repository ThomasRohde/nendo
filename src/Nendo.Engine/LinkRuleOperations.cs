using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// A link record type's rule (ADR-0026): which kinds of link may join which kinds of record. A
/// link is a record with a source, a target and a kind; it is allowed when a record of the table
/// holds its source's kind, its target's kind and its own kind.
/// </summary>
/// <param name="SourceFieldId">The link type's reference to the record it starts at.</param>
/// <param name="TargetFieldId">The link type's reference to the record it ends at.</param>
/// <param name="KindFieldId">The link type's own kind.</param>
/// <param name="SourceKindFieldId">The kind field of the record type the source points at.</param>
/// <param name="TargetKindFieldId">The kind field of the record type the target points at.</param>
/// <param name="TableEntityId">The record type whose records are the allowed combinations.</param>
/// <param name="TableSourceFieldId">The table's field matched against the source's kind.</param>
/// <param name="TableTargetFieldId">The table's field matched against the target's kind.</param>
/// <param name="TableKindFieldId">The table's field matched against the link's kind.</param>
public sealed record NendoLinkRule(
    string SourceFieldId,
    string TargetFieldId,
    string KindFieldId,
    string SourceKindFieldId,
    string TargetKindFieldId,
    string TableEntityId,
    string TableSourceFieldId,
    string TableTargetFieldId,
    string TableKindFieldId)
{
    /// <summary>How many links a refusal over existing data names before it says how many more.</summary>
    public const int MaximumLinksNamed = 20;
}

/// <summary>
/// Declares a link record type's rule (ADR-0026). From then on every mutation that leaves a link
/// whose combination of kinds no table record holds is refused, whoever writes it. Declaring over
/// links that already break it is refused, naming them; nothing is changed.
/// </summary>
public sealed record DeclareLinkRuleOperation : NendoOperation
{
    public DeclareLinkRuleOperation(string operationId, string entityId, NendoLinkRule rule, long expectedDefinitionRevision)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        ArgumentNullException.ThrowIfNull(rule);
        Rule = new(
            Require(rule.SourceFieldId, "sourceFieldId"),
            Require(rule.TargetFieldId, "targetFieldId"),
            Require(rule.KindFieldId, "kindFieldId"),
            Require(rule.SourceKindFieldId, "sourceKindFieldId"),
            Require(rule.TargetKindFieldId, "targetKindFieldId"),
            Require(rule.TableEntityId, "tableEntityId"),
            Require(rule.TableSourceFieldId, "tableSourceFieldId"),
            Require(rule.TableTargetFieldId, "tableTargetFieldId"),
            Require(rule.TableKindFieldId, "tableKindFieldId"));
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public NendoLinkRule Rule { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.declareLinkRule";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        kindFieldId = Rule.KindFieldId,
        sourceFieldId = Rule.SourceFieldId,
        sourceKindFieldId = Rule.SourceKindFieldId,
        tableEntityId = Rule.TableEntityId,
        tableKindFieldId = Rule.TableKindFieldId,
        tableSourceFieldId = Rule.TableSourceFieldId,
        tableTargetFieldId = Rule.TableTargetFieldId,
        targetFieldId = Rule.TargetFieldId,
        targetKindFieldId = Rule.TargetKindFieldId,
    });
}

/// <summary>
/// Removes a link record type's rule. Every link and every table record stays as it is; only the
/// check stops applying.
/// </summary>
public sealed record RemoveLinkRuleOperation : NendoOperation
{
    public RemoveLinkRuleOperation(string operationId, string entityId, long expectedDefinitionRevision) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.removeLinkRule";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
    });
}
