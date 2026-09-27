using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// A record type's declared hierarchy (ADR-0019): the self-reference that names each record's
/// parent, and optionally the Integer field that orders siblings.
/// </summary>
public sealed record NendoHierarchy(string ParentFieldId, string? OrderFieldId);

/// <summary>The bounds ADR-0019 states, measured in its stage 1 note.</summary>
public static class NendoHierarchyLimits
{
    /// <summary>The deepest a record may sit: a top-level record is at depth 1.</summary>
    public const int MaximumDepth = 32;

    /// <summary>The most descendants a subtree read or aggregate folds before it refuses.</summary>
    public const int MaximumDescendants = 10_000;

    /// <summary>The spacing a move leaves between sibling order values, so most moves write one record.</summary>
    public const long OrderGap = 1024;
}

/// <summary>
/// Declares one self-reference of a record type as that type's hierarchy (ADR-0019). From then
/// on the Engine refuses any write that would put a record under itself or one of its own
/// descendants, or deeper than <see cref="NendoHierarchyLimits.MaximumDepth"/>. Declaring on
/// data that already breaks either rule is refused, naming the records; nothing is repaired.
/// </summary>
public sealed record DeclareHierarchyOperation : NendoOperation
{
    public DeclareHierarchyOperation(string operationId, string entityId, string parentFieldId, string? orderFieldId,
        long expectedDefinitionRevision) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        ParentFieldId = Require(parentFieldId, nameof(parentFieldId));
        OrderFieldId = string.IsNullOrWhiteSpace(orderFieldId) ? null : orderFieldId;
        if (OrderFieldId == ParentFieldId)
            throw new NendoValidationException("The order field must be a different field from the parent field.");
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public string ParentFieldId { get; }
    public string? OrderFieldId { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.declareHierarchy";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        orderFieldId = OrderFieldId,
        parentFieldId = ParentFieldId,
    });
}

/// <summary>
/// Removes a record type's hierarchy declaration. The parent and order fields stay ordinary
/// fields with every value they hold; only the rules stop applying.
/// </summary>
public sealed record RemoveHierarchyOperation : NendoOperation
{
    public RemoveHierarchyOperation(string operationId, string entityId, long expectedDefinitionRevision) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.removeHierarchy";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
    });
}
