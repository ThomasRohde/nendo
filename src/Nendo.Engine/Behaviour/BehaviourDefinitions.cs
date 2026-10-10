using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// The execution contract a stored behaviour definition was written against.
/// <para>
/// A file records the contract its definitions expect rather than inheriting
/// whatever the opening host happens to implement. That is what lets an older
/// host recognise a definition it cannot evaluate and block editing while keeping
/// the file inspectable, instead of quietly evaluating it under different rules.
/// </para>
/// </summary>
public static class NendoBehaviourContract
{
    /// <summary>The only contract this host validates and evaluates.</summary>
    public const string Version = "behaviour-1";

    internal static bool IsSupported(string version) =>
        string.Equals(version, Version, StringComparison.Ordinal);
}

/// <summary>The closed set of definitions the protected behaviour table holds.</summary>
public enum NendoBehaviourKind
{
    Calculation,
    Function,
    Action,
    Trigger,
}

/// <summary>
/// The scalar domains a calculation reads and produces. Deliberately narrower than
/// <see cref="NendoStorageKind"/>: stored DateTime, Uuid and Reference values remain
/// valid data, but they are not expression values. Reference IDs resolve bindings;
/// they are not objects an expression can reach into.
/// </summary>
public enum NendoBehaviourScalar
{
    Integer,
    Decimal,
    Boolean,
    Text,
    Date,
}

/// <summary>How a declared name in an expression reaches a value.</summary>
public enum NendoBindingKind
{
    /// <summary>A stored field on the record being calculated.</summary>
    SameRecordField,

    /// <summary>Another calculated field on the same record.</summary>
    SameRecordCalculation,

    /// <summary>One declared hop along a reference field, then a stored field on the target.</summary>
    ReferenceTraversal,

    /// <summary>A bounded aggregate over the records that reference this one.</summary>
    RelatedAggregate,

    /// <summary>
    /// A bounded aggregate over this record's descendants in its record type's declared
    /// hierarchy (ADR-0019), optionally with the record itself.
    /// </summary>
    SubtreeAggregate,

    /// <summary>
    /// The record's place in its record type's declared hierarchy as a dotted path of 1-based
    /// sibling positions, 1.2.3, with an optional literal prefix (ADR-0020). It changes when a
    /// record moves, so it is never stored and is not an identity.
    /// </summary>
    HierarchyPath,
}

/// <summary>The initial aggregate catalogue. Widening it needs its own semantics and tests.</summary>
public enum NendoAggregateFunction
{
    /// <summary>Counts members. Returns Int64 zero for an empty collection.</summary>
    Count,

    /// <summary>Counts members whose Boolean field is true. A null member value is an error.</summary>
    FilteredCount,

    /// <summary>Checked typed sum. Returns typed zero for empty; a null member value is an error.</summary>
    Sum,
}

/// <summary>
/// The keys one binding shape takes on the wire, and what each one is for.
/// <para>
/// One table, three readers: the codec refuses a key that is not in it and names the
/// ones that are, the vocabulary publishes it, and a test holds the two together. The
/// published list of required keys used to be written out by hand, and omitted the
/// key a sum needs — so a client could learn it only by reading this source.
/// </para>
/// </summary>
public sealed record NendoBindingShape(
    NendoBindingKind Kind,
    NendoAggregateFunction? Aggregate,
    IReadOnlyList<string> RequiredKeys,
    IReadOnlyList<string> OptionalKeys,
    string Summary)
{
    /// <summary>Every key this shape accepts, required ones first.</summary>
    public IReadOnlyList<string> Keys { get; } = [.. RequiredKeys, .. OptionalKeys];

    /// <summary>The shape's name as a refusal writes it: the kind, then the aggregate if it has one.</summary>
    public string Name => Aggregate is { } aggregate ? $"{Kind} {aggregate}" : Kind.ToString();

    public static IReadOnlyList<NendoBindingShape> All { get; } =
    [
        new(NendoBindingKind.SameRecordField, null,
            ["bindingId", "kind", "entityId", "fieldId", "resultType", "nullable"], [],
            "A stored field of the record being calculated."),
        new(NendoBindingKind.SameRecordCalculation, null,
            ["bindingId", "kind", "entityId", "calculationId", "resultType", "nullable"], [],
            "Another calculated field of the same record. Cycles are refused before installation."),
        new(NendoBindingKind.ReferenceTraversal, null,
            ["bindingId", "kind", "entityId", "referenceFieldId", "relatedEntityId", "fieldId", "resultType", "nullable"], [],
            "One declared hop along a configured reference, to one stored field of the target."),
        new(NendoBindingKind.RelatedAggregate, NendoAggregateFunction.Count,
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId"], ["acrossSubtree", "resultType", "nullable"],
            "Counts the records pointing back at this one. The result is always Integer and never null; " +
            "resultType and nullable may be sent, and must say so. Past the row ceiling it refuses rather than counting part."),
        new(NendoBindingKind.RelatedAggregate, NendoAggregateFunction.FilteredCount,
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId"], ["predicateFieldId", "predicateCalculationId", "acrossSubtree", "resultType", "nullable"],
            "Counts the records pointing back at this one whose Boolean is true: a stored field named by predicateFieldId, " +
            "or a calculated field of theirs named by its calculation ID in predicateCalculationId. Exactly one of the two. " +
            "The result is always Integer and never null."),
        new(NendoBindingKind.RelatedAggregate, NendoAggregateFunction.Sum,
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId", "resultType"], ["valueFieldId", "valueCalculationId", "acrossSubtree", "nullable"],
            "Totals a number over the records pointing back at this one, exactly: a stored field named by valueFieldId, or a " +
            "calculated field of theirs named by its calculation ID in valueCalculationId. Exactly one of the two. resultType " +
            "is Integer or Decimal and matches what is totalled; the result is never null, and an empty collection totals zero. " +
            "A calculated member is worked out for each record, and each one counts against the related-row ceiling."),
        new(NendoBindingKind.HierarchyPath, null,
            ["bindingId", "kind", "entityId"], ["prefix", "resultType", "nullable"],
            "The record's place in the record type's declared hierarchy: its 1-based position among its siblings, and each " +
            "ancestor's, joined with dots from the top (1.2.3), after an optional literal prefix (CAP-1.2.3). Siblings count " +
            "in the hierarchy's order. Always Text and never null. It changes when a record moves, so it is a display code, " +
            "not an identity: a code people must repeat next week is a sequence (schema.setFieldSequence)."),
        new(NendoBindingKind.SubtreeAggregate, NendoAggregateFunction.Count,
            ["bindingId", "kind", "aggregate", "entityId"], ["includeSelf", "resultType", "nullable"],
            "Counts the records under this one in the record type's declared hierarchy, at every level; includeSelf counts " +
            "the record too. The result is always Integer and never null. Past the hierarchy's descendant bound it refuses."),
        new(NendoBindingKind.SubtreeAggregate, NendoAggregateFunction.FilteredCount,
            ["bindingId", "kind", "aggregate", "entityId"], ["predicateFieldId", "predicateCalculationId", "includeSelf", "resultType", "nullable"],
            "Counts the records under this one whose Boolean is true: predicateFieldId, or a calculated field named by " +
            "predicateCalculationId (not this calculation itself). Exactly one of the two. The result is always Integer and never null."),
        new(NendoBindingKind.SubtreeAggregate, NendoAggregateFunction.Sum,
            ["bindingId", "kind", "aggregate", "entityId", "resultType"], ["valueFieldId", "valueCalculationId", "includeSelf", "nullable"],
            "Totals a number over the records under this one, exactly: valueFieldId, or a calculated field named by " +
            "valueCalculationId (not this calculation itself). Exactly one of the two. includeSelf adds the record's own value. " +
            "resultType is Integer or Decimal and matches what is totalled; the result is never null, and an empty subtree totals zero."),
    ];

    /// <summary>What a key is for, in the words a refusal uses to ask for it.</summary>
    public static string Purpose(string key) => key switch
    {
        "bindingId" => "the alias the formula uses",
        "kind" => "one of " + string.Join(", ", Enum.GetNames<NendoBindingKind>()),
        "aggregate" => "one of " + string.Join(", ", Enum.GetNames<NendoAggregateFunction>()),
        "entityId" => "the record type this binding starts from",
        "fieldId" => "the stored field it reads",
        "calculationId" => "the calculated field it reads",
        "referenceFieldId" => "the reference field it follows",
        "relatedEntityId" => "the record type on the other side of the reference",
        "relatedReferenceFieldId" => "the reference field on the related record that points back at this one",
        "predicateFieldId" => "the Boolean field it tests",
        "predicateCalculationId" => "the calculation ID of a Boolean calculated field it tests, instead of predicateFieldId",
        "valueFieldId" => "the Integer or Decimal field it totals",
        "valueCalculationId" => "the calculation ID of an Integer or Decimal calculated field it totals, instead of valueFieldId",
        "resultType" => "the scalar the value has: " + string.Join(", ", Enum.GetNames<NendoBehaviourScalar>()),
        "nullable" => "whether the value may be empty",
        "includeSelf" => "true to count or total the record itself as well as everything under it",
        "acrossSubtree" => "true to fold the records pointing at this record or at anything under it in its declared hierarchy",
        "prefix" => $"literal text before the path, at most {NendoBehaviourBinding.MaximumPathPrefixLength} characters",
        _ => "a key this contract defines",
    };

    internal static NendoBindingShape For(NendoBindingKind kind, NendoAggregateFunction? aggregate) =>
        All.First(shape => shape.Kind == kind && shape.Aggregate == aggregate);
}

/// <summary>
/// One name an expression may use, and exactly where its value comes from. Bindings
/// carry stable entity/field IDs, never display labels, so renaming a field in the UI
/// cannot silently change or break what a formula reads.
/// </summary>
public sealed record NendoBehaviourBinding
{
    private NendoBehaviourBinding(string bindingId, NendoBindingKind kind, NendoBehaviourScalar resultType, bool nullable)
    {
        BindingId = NendoOperation.Require(bindingId, nameof(bindingId));
        Kind = kind;
        ResultType = resultType;
        Nullable = nullable;
    }

    /// <summary>The alias the expression uses. Unique within one definition.</summary>
    public string BindingId { get; }

    public NendoBindingKind Kind { get; }

    public NendoBehaviourScalar ResultType { get; }

    public bool Nullable { get; }

    /// <summary>The record type the binding starts from.</summary>
    public string EntityId { get; private init; } = "";

    /// <summary>The stored field read on the same record, or on the reference target.</summary>
    public string? FieldId { get; private init; }

    /// <summary>The reference field traversed, on the starting record.</summary>
    public string? ReferenceFieldId { get; private init; }

    /// <summary>The record type reached by a traversal, or aggregated over.</summary>
    public string? RelatedEntityId { get; private init; }

    /// <summary>The reference field on the related record that points back at this one.</summary>
    public string? RelatedReferenceFieldId { get; private init; }

    public NendoAggregateFunction? Aggregate { get; private init; }

    /// <summary>The Boolean field a filtered count tests.</summary>
    public string? PredicateFieldId { get; private init; }

    /// <summary>The numeric field a sum accumulates.</summary>
    public string? ValueFieldId { get; private init; }

    /// <summary>The calculation read from the same record.</summary>
    public string? CalculationId { get; private init; }

    /// <summary>A calculated field of each member that a sum totals, instead of <see cref="ValueFieldId"/>.</summary>
    public string? ValueCalculationId { get; private init; }

    /// <summary>A Boolean calculated field of each member that a filtered count tests, instead of <see cref="PredicateFieldId"/>.</summary>
    public string? PredicateCalculationId { get; private init; }

    /// <summary>The calculation each member of an aggregate is read through, or null when it reads a stored field.</summary>
    public string? MemberCalculationId => ValueCalculationId ?? PredicateCalculationId;

    /// <summary>Every calculation this binding reads: on the same record, or on each member of an aggregate.</summary>
    internal IEnumerable<string> ReadCalculations
    {
        get
        {
            if (CalculationId is not null) yield return CalculationId;
            if (MemberCalculationId is not null) yield return MemberCalculationId;
        }
    }

    /// <summary>
    /// The same aggregate reading each member through a calculation rather than a stored field.
    /// The member's stored field ID is cleared: the two are alternatives, never both.
    /// </summary>
    public NendoBehaviourBinding WithMemberCalculation(string calculationId)
    {
        NendoOperation.Require(calculationId, nameof(calculationId));
        return Aggregate switch
        {
            NendoAggregateFunction.Sum => this with { ValueFieldId = null, ValueCalculationId = calculationId },
            NendoAggregateFunction.FilteredCount => this with { PredicateFieldId = null, PredicateCalculationId = calculationId },
            _ => throw new NendoValidationException("Only a sum or a filtered count reads each member through a calculation."),
        };
    }

    /// <summary>A subtree aggregate that folds the record itself as well as its descendants.</summary>
    public bool IncludeSelf { get; private init; }

    /// <summary>A related aggregate over the records pointing at this record or anything under it (ADR-0019).</summary>
    public bool AcrossSubtree { get; private init; }

    /// <summary>The literal text a hierarchy path starts with, or null (ADR-0020).</summary>
    public string? Prefix { get; private init; }

    public const int MaximumPathPrefixLength = 16;

    /// <summary>The record's dotted position in its declared hierarchy, 1.2.3, after an optional prefix (ADR-0020).</summary>
    public static NendoBehaviourBinding HierarchyPath(string bindingId, string entityId, string? prefix = null) =>
        new(bindingId, NendoBindingKind.HierarchyPath, NendoBehaviourScalar.Text, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            Prefix = string.IsNullOrEmpty(prefix) ? null : prefix,
        };

    public static NendoBehaviourBinding SameRecordField(
        string bindingId, string entityId, string fieldId, NendoBehaviourScalar resultType, bool nullable) =>
        new(bindingId, NendoBindingKind.SameRecordField, resultType, nullable)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            FieldId = NendoOperation.Require(fieldId, nameof(fieldId)),
        };

    /// <summary>
    /// Reads another calculated field on the same record. The dependency is declared
    /// rather than discovered, so the order calculations must run in is known before
    /// any of them runs, and a loop is refused at installation.
    /// </summary>
    public static NendoBehaviourBinding SameRecordCalculation(
        string bindingId, string entityId, string calculationId, NendoBehaviourScalar resultType, bool nullable) =>
        new(bindingId, NendoBindingKind.SameRecordCalculation, resultType, nullable)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            CalculationId = NendoOperation.Require(calculationId, nameof(calculationId)),
        };

    public static NendoBehaviourBinding ReferenceTraversal(
        string bindingId, string entityId, string referenceFieldId, string relatedEntityId, string fieldId,
        NendoBehaviourScalar resultType, bool nullable) =>
        new(bindingId, NendoBindingKind.ReferenceTraversal, resultType, nullable)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            ReferenceFieldId = NendoOperation.Require(referenceFieldId, nameof(referenceFieldId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            FieldId = NendoOperation.Require(fieldId, nameof(fieldId)),
        };

    /// <summary>Counts every related record. The result is a non-null Int64.</summary>
    public static NendoBehaviourBinding RelatedCount(
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId, bool acrossSubtree = false) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, NendoBehaviourScalar.Integer, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.Count,
            AcrossSubtree = acrossSubtree,
        };

    /// <summary>Counts, counts where a Boolean holds, or totals a number over this record's descendants (ADR-0019).</summary>
    public static NendoBehaviourBinding Subtree(
        string bindingId, string entityId, NendoAggregateFunction aggregate, string? memberFieldId = null,
        NendoBehaviourScalar resultType = NendoBehaviourScalar.Integer, bool includeSelf = false) =>
        new(bindingId, NendoBindingKind.SubtreeAggregate, aggregate == NendoAggregateFunction.Sum ? resultType : NendoBehaviourScalar.Integer, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            Aggregate = aggregate,
            PredicateFieldId = aggregate == NendoAggregateFunction.FilteredCount ? memberFieldId : null,
            ValueFieldId = aggregate == NendoAggregateFunction.Sum ? memberFieldId : null,
            IncludeSelf = includeSelf,
        };

    /// <summary>Counts related records whose Boolean field is true. The result is a non-null Int64.</summary>
    public static NendoBehaviourBinding RelatedFilteredCount(
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId, string? predicateFieldId,
        bool acrossSubtree = false) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, NendoBehaviourScalar.Integer, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.FilteredCount,
            PredicateFieldId = predicateFieldId,
            AcrossSubtree = acrossSubtree,
        };

    /// <summary>Sums a numeric field over related records, with checked arithmetic.</summary>
    public static NendoBehaviourBinding RelatedSum(
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId,
        string? valueFieldId, NendoBehaviourScalar resultType, bool acrossSubtree = false) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, resultType, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.Sum,
            ValueFieldId = valueFieldId,
            AcrossSubtree = acrossSubtree,
        };

    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(BindingId, "binding alias");
        switch (Kind)
        {
            case NendoBindingKind.SameRecordField:
                if (FieldId is null) throw new NendoValidationException("A same-record binding needs a field.");
                break;
            case NendoBindingKind.SameRecordCalculation:
                if (CalculationId is null) throw new NendoValidationException("A calculation binding needs the calculation it reads.");
                break;
            case NendoBindingKind.ReferenceTraversal:
                if (ReferenceFieldId is null || RelatedEntityId is null || FieldId is null)
                    throw new NendoValidationException("A reference binding needs a reference field, a target record type and a target field.");
                break;
            case NendoBindingKind.RelatedAggregate:
                if (RelatedEntityId is null || RelatedReferenceFieldId is null || Aggregate is null)
                    throw new NendoValidationException("A related binding needs a record type, the reference field pointing back and an aggregate.");
                RequireAggregateArguments("collection");
                break;
            case NendoBindingKind.SubtreeAggregate:
                if (Aggregate is null)
                    throw new NendoValidationException("A subtree binding needs an aggregate.");
                RequireAggregateArguments("subtree");
                break;
            case NendoBindingKind.HierarchyPath:
                if (ResultType != NendoBehaviourScalar.Text || Nullable)
                    throw new NendoValidationException("A hierarchy path is Text and never empty.");
                if (Prefix is { Length: > MaximumPathPrefixLength })
                    throw new NendoValidationException($"A hierarchy path's prefix is at most {MaximumPathPrefixLength} characters.");
                break;
            default:
                throw new NendoValidationException("The binding kind is not supported by this contract.");
        }
    }

    /// <summary>What an aggregate needs besides its function: the field it tests or sums, a numeric result, never null.</summary>
    private void RequireAggregateArguments(string emptyWhole)
    {
        if (Aggregate == NendoAggregateFunction.FilteredCount && (PredicateFieldId is null) == (PredicateCalculationId is null))
            throw new NendoValidationException(
                "A filtered count tests one Boolean: a stored field in predicateFieldId, or a calculated field in predicateCalculationId, not both.");
        if (Aggregate == NendoAggregateFunction.Sum && (ValueFieldId is null) == (ValueCalculationId is null))
            throw new NendoValidationException(
                "A sum totals one number: a stored field in valueFieldId, or a calculated field in valueCalculationId, not both.");
        if (Aggregate == NendoAggregateFunction.Count && MemberCalculationId is not null)
            throw new NendoValidationException("A count reads no member value, so it names no calculation.");
        if (Aggregate == NendoAggregateFunction.Sum &&
            ResultType is not (NendoBehaviourScalar.Integer or NendoBehaviourScalar.Decimal))
            throw new NendoValidationException("A sum produces a whole number or a decimal.");
        if (Nullable)
            throw new NendoValidationException($"An aggregate is never null; an empty {emptyWhole} totals zero.");
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        if (AcrossSubtree) writer.WriteBoolean("acrossSubtree", true);
        writer.WriteString("bindingId", BindingId);
        if (Aggregate is { } aggregate) writer.WriteString("aggregate", aggregate.ToString());
        if (CalculationId is not null) writer.WriteString("calculationId", CalculationId);
        writer.WriteString("entityId", EntityId);
        if (FieldId is not null) writer.WriteString("fieldId", FieldId);
        if (IncludeSelf) writer.WriteBoolean("includeSelf", true);
        writer.WriteString("kind", Kind.ToString());
        writer.WriteBoolean("nullable", Nullable);
        if (PredicateCalculationId is not null) writer.WriteString("predicateCalculationId", PredicateCalculationId);
        if (PredicateFieldId is not null) writer.WriteString("predicateFieldId", PredicateFieldId);
        if (Prefix is not null) writer.WriteString("prefix", Prefix);
        if (ReferenceFieldId is not null) writer.WriteString("referenceFieldId", ReferenceFieldId);
        if (RelatedEntityId is not null) writer.WriteString("relatedEntityId", RelatedEntityId);
        if (RelatedReferenceFieldId is not null) writer.WriteString("relatedReferenceFieldId", RelatedReferenceFieldId);
        writer.WriteString("resultType", ResultType.ToString());
        if (ValueCalculationId is not null) writer.WriteString("valueCalculationId", ValueCalculationId);
        if (ValueFieldId is not null) writer.WriteString("valueFieldId", ValueFieldId);
        writer.WriteEndObject();
    }
}

/// <summary>One alias an expression may call, bound to a stable reusable function ID.</summary>
public sealed record NendoFunctionCallAlias(string Alias, string FunctionId)
{
    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(Alias, "function alias");
        NendoBehaviourValidation.RequireIdentifier(FunctionId, "function");
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("alias", Alias);
        writer.WriteString("functionId", FunctionId);
        writer.WriteEndObject();
    }
}

/// <summary>One typed parameter of a reusable function, in declaration order.</summary>
public sealed record NendoFunctionParameter(
    string ParameterId,
    string DisplayName,
    NendoBehaviourScalar ParameterType,
    bool Nullable)
{
    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(ParameterId, "parameter");
        NendoBehaviourValidation.RequireLabel(DisplayName, "parameter name");
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("parameterId", ParameterId);
        writer.WriteString("displayName", DisplayName);
        writer.WriteBoolean("nullable", Nullable);
        writer.WriteString("parameterType", ParameterType.ToString());
        writer.WriteEndObject();
    }
}

/// <summary>The record an action step writes to, relative to the record that raised the event.</summary>
public enum NendoActionTargetKind
{
    /// <summary>The record whose create, update or delete raised the event.</summary>
    EventRecord,

    /// <summary>The record reached by following one declared reference field from the event record.</summary>
    ReferencedRecord,
}

public sealed record NendoActionTarget(NendoActionTargetKind Kind, string? ReferenceFieldId)
{
    public static NendoActionTarget EventRecord { get; } = new(NendoActionTargetKind.EventRecord, null);

    public static NendoActionTarget Referenced(string referenceFieldId) =>
        new(NendoActionTargetKind.ReferencedRecord, NendoOperation.Require(referenceFieldId, nameof(referenceFieldId)));

    internal void Validate()
    {
        if (Kind == NendoActionTargetKind.ReferencedRecord && ReferenceFieldId is null)
            throw new NendoValidationException("A referenced target needs the reference field to follow.");
        if (Kind == NendoActionTargetKind.EventRecord && ReferenceFieldId is not null)
            throw new NendoValidationException("The event record is reached without following a reference.");
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", Kind.ToString());
        if (ReferenceFieldId is not null) writer.WriteString("referenceFieldId", ReferenceFieldId);
        writer.WriteEndObject();
    }
}

/// <summary>
/// A reference a create step sets on the record it creates: to the record that raised the
/// event, or to the record one of its references names. A formula has no reference values, so
/// without this a created record could not point back at what caused it — a project's kickoff
/// task could not name its project (2026-10-10).
/// </summary>
public sealed record NendoActionLink(string FieldId, NendoActionTarget Target)
{
    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(FieldId, "field");
        Target.Validate();
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("fieldId", FieldId);
        writer.WritePropertyName("target");
        Target.WriteCanonical(writer);
        writer.WriteEndObject();
    }
}

/// <summary>The closed set of effects one action step may have. All are local typed data writes.</summary>
public enum NendoActionStepKind
{
    SetField,
    CreateRecord,
    DeleteRecord,
}

/// <summary>One assignment inside an action step: a field, and the expression producing its value.</summary>
public sealed record NendoActionAssignment(
    string FieldId,
    string Expression,
    IReadOnlyList<NendoBehaviourBinding> Bindings,
    IReadOnlyList<NendoFunctionCallAlias> CallAliases)
{
    public NendoActionAssignment(string fieldId, string expression)
        : this(fieldId, expression, [], []) { }

    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(FieldId, "field");
        NendoBehaviourValidation.RequireExpression(Expression);
        NendoBehaviourValidation.RequireDistinctBindings(Bindings);
        NendoBehaviourValidation.RequireDistinctAliases(CallAliases);
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("fieldId", FieldId);
        NendoBehaviourValidation.WriteAliases(writer, CallAliases);
        NendoBehaviourValidation.WriteBindings(writer, Bindings);
        writer.WriteString("expression", Expression);
        writer.WriteEndObject();
    }
}

/// <summary>
/// One ordered step of a local action. A step observes the effects of the steps before
/// it, and can only create, set or delete ordinary records — never a definition, an
/// identity, a grant, a schema change or anything outside the file.
/// </summary>
public sealed record NendoActionStep
{
    private NendoActionStep(string stepId, NendoActionStepKind kind)
    {
        StepId = NendoOperation.Require(stepId, nameof(stepId));
        Kind = kind;
    }

    public string StepId { get; }

    public NendoActionStepKind Kind { get; }

    public NendoActionTarget Target { get; private init; } = NendoActionTarget.EventRecord;

    /// <summary>The record type a create step adds to.</summary>
    public string? EntityId { get; private init; }

    public IReadOnlyList<NendoActionAssignment> Assignments { get; private init; } = [];

    /// <summary>The references a create step sets on its new record. Empty for every other step.</summary>
    public IReadOnlyList<NendoActionLink> Links { get; private init; } = [];

    public static NendoActionStep SetField(string stepId, NendoActionTarget target, NendoActionAssignment assignment) =>
        new(stepId, NendoActionStepKind.SetField) { Target = target, Assignments = [assignment] };

    /// <summary>Sets several fields on one record as a single logical change.</summary>
    public static NendoActionStep SetFields(string stepId, NendoActionTarget target, IReadOnlyList<NendoActionAssignment> assignments) =>
        new(stepId, NendoActionStepKind.SetField) { Target = target, Assignments = assignments };

    public static NendoActionStep CreateRecord(
        string stepId, string entityId, IReadOnlyList<NendoActionAssignment> assignments, IReadOnlyList<NendoActionLink>? links = null) =>
        new(stepId, NendoActionStepKind.CreateRecord)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            Assignments = assignments,
            Links = links ?? [],
        };

    public static NendoActionStep DeleteRecord(string stepId, NendoActionTarget target) =>
        new(stepId, NendoActionStepKind.DeleteRecord) { Target = target };

    internal void Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(StepId, "step");
        Target.Validate();
        switch (Kind)
        {
            case NendoActionStepKind.SetField:
                if (Assignments.Count == 0) throw new NendoValidationException("A set step needs at least one field to write.");
                break;
            case NendoActionStepKind.CreateRecord:
                if (EntityId is null) throw new NendoValidationException("A create step needs the record type it adds to.");
                if (Assignments.Count == 0 && Links.Count == 0)
                    throw new NendoValidationException("A create step needs at least one field value or link.");
                break;
            case NendoActionStepKind.DeleteRecord:
                if (Assignments.Count != 0) throw new NendoValidationException("A delete step writes no field values.");
                break;
            default:
                throw new NendoValidationException("The step kind is not supported by this contract.");
        }
        if (Links.Count != 0 && Kind != NendoActionStepKind.CreateRecord)
            throw new NendoValidationException("Only a create step sets links; a set step writes a formula's value.");
        var written = Assignments.Select(assignment => assignment.FieldId).Concat(Links.Select(link => link.FieldId)).ToArray();
        if (written.Distinct(StringComparer.Ordinal).Count() != written.Length)
            throw new NendoValidationException("One step cannot write the same field twice, whether by a value or a link.");
        foreach (var assignment in Assignments) assignment.Validate();
        foreach (var link in Links) link.Validate();
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("stepId", StepId);
        writer.WriteStartArray("assignments");
        foreach (var assignment in Assignments) assignment.WriteCanonical(writer);
        writer.WriteEndArray();
        if (EntityId is not null) writer.WriteString("entityId", EntityId);
        writer.WriteString("kind", Kind.ToString());
        // Written only when there are some, so a step stored before links existed keeps its digest.
        if (Links.Count != 0)
        {
            writer.WriteStartArray("links");
            foreach (var link in Links) link.WriteCanonical(writer);
            writer.WriteEndArray();
        }
        writer.WritePropertyName("target");
        Target.WriteCanonical(writer);
        writer.WriteEndObject();
    }
}

/// <summary>The record events a trigger subscribes to.</summary>
[Flags]
public enum NendoTriggerEvents
{
    None = 0,
    Created = 1,
    Updated = 2,
    Deleted = 4,
}

/// <summary>
/// One stored behaviour definition. A single closed shape keyed by stable ID keeps the
/// protected table readable and the digest deterministic; <see cref="Kind"/> says which
/// of the bodies below is populated.
/// </summary>
public abstract record NendoBehaviourDefinition
{
    private protected NendoBehaviourDefinition(string definitionId, string contractVersion)
    {
        DefinitionId = NendoOperation.Require(definitionId, nameof(definitionId));
        ContractVersion = NendoOperation.Require(contractVersion, nameof(contractVersion));
    }

    public string DefinitionId { get; }

    public string ContractVersion { get; }

    public abstract NendoBehaviourKind Kind { get; }

    /// <summary>The record type this definition belongs to, when it has one.</summary>
    public abstract string? OwningEntityId { get; }

    internal abstract void ValidateShape();

    internal abstract void WriteBody(Utf8JsonWriter writer);

    /// <summary>Every function alias this definition calls, for cycle and existence checks.</summary>
    internal abstract IEnumerable<NendoFunctionCallAlias> ReferencedAliases { get; }

    /// <summary>
    /// Every definition this one depends on, whatever the kind of dependency: the
    /// functions it calls, the calculations it reads and, for a trigger, the action it
    /// runs. The cycle and depth checks walk these, because a loop through a
    /// calculated field is as real as a loop through a function call.
    /// </summary>
    internal virtual IEnumerable<string> ReferencedDefinitionIds =>
        ReferencedAliases.Select(alias => alias.FunctionId);

    /// <summary>Every formula this definition holds, wherever it sits.</summary>
    internal abstract IEnumerable<string> Expressions { get; }

    /// <summary>Every binding this definition declares, wherever it sits.</summary>
    internal abstract IEnumerable<NendoBehaviourBinding> AllBindings { get; }

    private static readonly System.Text.RegularExpressions.Regex IsEmptyCall =
        new(@"\bIsEmpty\s*\(", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// The host this definition needs (ADR-0008, 2026-10-10): a link, a calculated aggregate
    /// member or IsEmpty is refused by an older host, which would read the file as damaged.
    /// </summary>
    internal string RequiredHostVersion =>
        AllBindings.Any(binding => binding.MemberCalculationId is not null) ||
        (this is NendoActionDefinition action && action.Steps.Any(step => step.Links.Count != 0)) ||
        Expressions.Any(expression => IsEmptyCall.IsMatch(expression))
            ? NendoFormat.BehaviourLinksMinimumHostVersion
            : NendoFormat.BehaviourMinimumHostVersion;

    /// <summary>Validates everything checkable without the rest of the file.</summary>
    public NendoBehaviourDefinition Validate()
    {
        NendoBehaviourValidation.RequireIdentifier(DefinitionId, "definition");
        if (!NendoBehaviourContract.IsSupported(ContractVersion))
            throw new NendoValidationException(
                $"This definition needs behaviour contract {ContractVersion}, and this version of Nendo implements {NendoBehaviourContract.Version}.");
        ValidateShape();
        return this;
    }

    /// <summary>The canonical body stored in the protected table and covered by the digest.</summary>
    public string CanonicalBody()
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteBody(writer);
        }
        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }
}

/// <summary>A field whose value is computed rather than stored and edited.</summary>
public sealed record NendoCalculationDefinition : NendoBehaviourDefinition
{
    public NendoCalculationDefinition(
        string calculationId,
        string entityId,
        string fieldId,
        string displayName,
        NendoBehaviourScalar resultType,
        bool resultNullable,
        string expression,
        IReadOnlyList<NendoBehaviourBinding> bindings,
        IReadOnlyList<NendoFunctionCallAlias>? callAliases = null,
        string contractVersion = NendoBehaviourContract.Version)
        : base(calculationId, contractVersion)
    {
        EntityId = NendoOperation.Require(entityId, nameof(entityId));
        FieldId = NendoOperation.Require(fieldId, nameof(fieldId));
        DisplayName = NendoOperation.Require(displayName, nameof(displayName));
        ResultType = resultType;
        ResultNullable = resultNullable;
        Expression = expression ?? throw new ArgumentNullException(nameof(expression));
        Bindings = bindings ?? throw new ArgumentNullException(nameof(bindings));
        CallAliases = callAliases ?? [];
    }

    public string EntityId { get; }

    /// <summary>The derived field's stable ID. It never names a physical column.</summary>
    public string FieldId { get; }

    public string DisplayName { get; }

    public NendoBehaviourScalar ResultType { get; }

    public bool ResultNullable { get; }

    public string Expression { get; }

    public IReadOnlyList<NendoBehaviourBinding> Bindings { get; }

    public IReadOnlyList<NendoFunctionCallAlias> CallAliases { get; }

    public override NendoBehaviourKind Kind => NendoBehaviourKind.Calculation;

    public override string? OwningEntityId => EntityId;

    internal override IEnumerable<NendoFunctionCallAlias> ReferencedAliases => CallAliases;

    internal override IEnumerable<string> Expressions => [Expression];

    internal override IEnumerable<NendoBehaviourBinding> AllBindings => Bindings;

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        CallAliases.Select(alias => alias.FunctionId)
            .Concat(Bindings.SelectMany(binding => binding.ReadCalculations));

    internal override void ValidateShape()
    {
        NendoBehaviourValidation.RequireIdentifier(EntityId, "record type");
        NendoBehaviourValidation.RequireIdentifier(FieldId, "field");
        NendoBehaviourValidation.RequireLabel(DisplayName, "calculation name");
        NendoBehaviourValidation.RequireExpression(Expression);
        NendoBehaviourValidation.RequireDistinctBindings(Bindings);
        NendoBehaviourValidation.RequireDistinctAliases(CallAliases);
        foreach (var binding in Bindings)
        {
            if (!string.Equals(binding.EntityId, EntityId, StringComparison.Ordinal))
                throw new NendoValidationException("A calculation's bindings must start from the record type it belongs to.");
            if (binding.ReadCalculations.Contains(DefinitionId, StringComparer.Ordinal))
                throw new NendoValidationException("A calculation cannot read itself, on its own record or on the records it totals.");
        }
    }

    internal override void WriteBody(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        NendoBehaviourValidation.WriteAliases(writer, CallAliases);
        NendoBehaviourValidation.WriteBindings(writer, Bindings);
        writer.WriteString("displayName", DisplayName);
        writer.WriteString("entityId", EntityId);
        writer.WriteString("expression", Expression);
        writer.WriteString("fieldId", FieldId);
        writer.WriteBoolean("resultNullable", ResultNullable);
        writer.WriteString("resultType", ResultType.ToString());
        writer.WriteEndObject();
    }
}

/// <summary>A named pure expression other definitions can call with typed arguments.</summary>
public sealed record NendoFunctionDefinition : NendoBehaviourDefinition
{
    public NendoFunctionDefinition(
        string functionId,
        string displayName,
        IReadOnlyList<NendoFunctionParameter> parameters,
        NendoBehaviourScalar resultType,
        bool resultNullable,
        string expression,
        IReadOnlyList<NendoFunctionCallAlias>? callAliases = null,
        string contractVersion = NendoBehaviourContract.Version)
        : base(functionId, contractVersion)
    {
        DisplayName = NendoOperation.Require(displayName, nameof(displayName));
        Parameters = parameters ?? throw new ArgumentNullException(nameof(parameters));
        ResultType = resultType;
        ResultNullable = resultNullable;
        Expression = expression ?? throw new ArgumentNullException(nameof(expression));
        CallAliases = callAliases ?? [];
    }

    public string DisplayName { get; }

    /// <summary>Typed parameters in call order. Arguments bind by position.</summary>
    public IReadOnlyList<NendoFunctionParameter> Parameters { get; }

    public NendoBehaviourScalar ResultType { get; }

    public bool ResultNullable { get; }

    public string Expression { get; }

    /// <summary>Functions this body calls, by the alias its source uses.</summary>
    public IReadOnlyList<NendoFunctionCallAlias> CallAliases { get; }

    public override NendoBehaviourKind Kind => NendoBehaviourKind.Function;

    public override string? OwningEntityId => null;

    internal override IEnumerable<NendoFunctionCallAlias> ReferencedAliases => CallAliases;

    internal override IEnumerable<string> Expressions => [Expression];

    internal override IEnumerable<NendoBehaviourBinding> AllBindings => [];

    internal override void ValidateShape()
    {
        NendoBehaviourValidation.RequireLabel(DisplayName, "function name");
        NendoBehaviourValidation.RequireExpression(Expression);
        NendoBehaviourValidation.RequireDistinctAliases(CallAliases);
        if (Parameters.Select(parameter => parameter.ParameterId).Distinct(StringComparer.Ordinal).Count() != Parameters.Count)
            throw new NendoValidationException("Parameter IDs must be unique within a function.");
        foreach (var parameter in Parameters) parameter.Validate();
        if (CallAliases.Any(alias => string.Equals(alias.FunctionId, DefinitionId, StringComparison.Ordinal)))
            throw new NendoValidationException("A function cannot call itself.");
    }

    internal override void WriteBody(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        NendoBehaviourValidation.WriteAliases(writer, CallAliases);
        writer.WriteString("displayName", DisplayName);
        writer.WriteString("expression", Expression);
        writer.WriteStartArray("parameters");
        foreach (var parameter in Parameters) parameter.WriteCanonical(writer);
        writer.WriteEndArray();
        writer.WriteBoolean("resultNullable", ResultNullable);
        writer.WriteString("resultType", ResultType.ToString());
        writer.WriteEndObject();
    }
}

/// <summary>An ordered list of local data writes a trigger can select.</summary>
public sealed record NendoActionDefinition : NendoBehaviourDefinition
{
    public NendoActionDefinition(
        string actionId,
        string displayName,
        IReadOnlyList<NendoActionStep> steps,
        string contractVersion = NendoBehaviourContract.Version)
        : base(actionId, contractVersion)
    {
        DisplayName = NendoOperation.Require(displayName, nameof(displayName));
        Steps = steps ?? throw new ArgumentNullException(nameof(steps));
    }

    public string DisplayName { get; }

    public IReadOnlyList<NendoActionStep> Steps { get; }

    public override NendoBehaviourKind Kind => NendoBehaviourKind.Action;

    public override string? OwningEntityId => null;

    internal override IEnumerable<NendoFunctionCallAlias> ReferencedAliases =>
        Steps.SelectMany(step => step.Assignments).SelectMany(assignment => assignment.CallAliases);

    internal override IEnumerable<string> Expressions =>
        Steps.SelectMany(step => step.Assignments).Select(assignment => assignment.Expression);

    internal override IEnumerable<NendoBehaviourBinding> AllBindings =>
        Steps.SelectMany(step => step.Assignments).SelectMany(assignment => assignment.Bindings);

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        ReferencedAliases.Select(alias => alias.FunctionId)
            .Concat(Steps.SelectMany(step => step.Assignments)
                .SelectMany(assignment => assignment.Bindings)
                .SelectMany(binding => binding.ReadCalculations));

    internal override void ValidateShape()
    {
        NendoBehaviourValidation.RequireLabel(DisplayName, "action name");
        if (Steps.Count == 0) throw new NendoValidationException("An action needs at least one step.");
        if (Steps.Select(step => step.StepId).Distinct(StringComparer.Ordinal).Count() != Steps.Count)
            throw new NendoValidationException("Step IDs must be unique within an action.");
        foreach (var step in Steps) step.Validate();
    }

    internal override void WriteBody(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("displayName", DisplayName);
        writer.WriteStartArray("steps");
        foreach (var step in Steps) step.WriteCanonical(writer);
        writer.WriteEndArray();
        writer.WriteEndObject();
    }
}

/// <summary>
/// Subscribes an action to record events on one record type, behind an optional
/// Boolean condition. A blocked condition is a visible outcome, not a silent skip.
/// </summary>
public sealed record NendoTriggerDefinition : NendoBehaviourDefinition
{
    public NendoTriggerDefinition(
        string triggerId,
        string entityId,
        string displayName,
        NendoTriggerEvents events,
        string actionId,
        IReadOnlyList<string>? relevantFieldIds = null,
        string? conditionExpression = null,
        IReadOnlyList<NendoBehaviourBinding>? conditionBindings = null,
        IReadOnlyList<NendoFunctionCallAlias>? callAliases = null,
        string contractVersion = NendoBehaviourContract.Version)
        : base(triggerId, contractVersion)
    {
        EntityId = NendoOperation.Require(entityId, nameof(entityId));
        DisplayName = NendoOperation.Require(displayName, nameof(displayName));
        Events = events;
        ActionId = NendoOperation.Require(actionId, nameof(actionId));
        RelevantFieldIds = relevantFieldIds ?? [];
        ConditionExpression = conditionExpression;
        ConditionBindings = conditionBindings ?? [];
        CallAliases = callAliases ?? [];
    }

    public string EntityId { get; }

    public string DisplayName { get; }

    public NendoTriggerEvents Events { get; }

    /// <summary>
    /// The stored fields whose net change makes an update relevant. Empty means any
    /// stored change on the record type.
    /// </summary>
    public IReadOnlyList<string> RelevantFieldIds { get; }

    /// <summary>A Boolean expression, or null to run whenever the event occurs.</summary>
    public string? ConditionExpression { get; }

    public IReadOnlyList<NendoBehaviourBinding> ConditionBindings { get; }

    public IReadOnlyList<NendoFunctionCallAlias> CallAliases { get; }

    public string ActionId { get; }

    public override NendoBehaviourKind Kind => NendoBehaviourKind.Trigger;

    public override string? OwningEntityId => EntityId;

    internal override IEnumerable<NendoFunctionCallAlias> ReferencedAliases => CallAliases;

    internal override IEnumerable<string> Expressions => ConditionExpression is null ? [] : [ConditionExpression];

    internal override IEnumerable<NendoBehaviourBinding> AllBindings => ConditionBindings;

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        CallAliases.Select(alias => alias.FunctionId)
            .Concat(ConditionBindings.SelectMany(binding => binding.ReadCalculations))
            .Append(ActionId);

    internal override void ValidateShape()
    {
        NendoBehaviourValidation.RequireIdentifier(EntityId, "record type");
        NendoBehaviourValidation.RequireIdentifier(ActionId, "action");
        NendoBehaviourValidation.RequireLabel(DisplayName, "trigger name");
        if (Events == NendoTriggerEvents.None)
            throw new NendoValidationException("A trigger needs at least one of created, updated or deleted.");
        if ((Events & ~(NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted)) != 0)
            throw new NendoValidationException("The trigger subscribes to an event this contract does not define.");
        if (RelevantFieldIds.Count != 0 && !Events.HasFlag(NendoTriggerEvents.Updated))
            throw new NendoValidationException("Relevant fields narrow an update subscription, so the trigger must subscribe to updates.");
        if (RelevantFieldIds.Distinct(StringComparer.Ordinal).Count() != RelevantFieldIds.Count)
            throw new NendoValidationException("Relevant field IDs must be distinct.");
        foreach (var fieldId in RelevantFieldIds) NendoBehaviourValidation.RequireIdentifier(fieldId, "field");
        if (ConditionExpression is null)
        {
            if (ConditionBindings.Count != 0 || CallAliases.Count != 0)
                throw new NendoValidationException("A trigger without a condition declares no bindings or calls.");
            return;
        }
        NendoBehaviourValidation.RequireExpression(ConditionExpression);
        NendoBehaviourValidation.RequireDistinctBindings(ConditionBindings);
        NendoBehaviourValidation.RequireDistinctAliases(CallAliases);
        foreach (var binding in ConditionBindings)
        {
            if (!string.Equals(binding.EntityId, EntityId, StringComparison.Ordinal))
                throw new NendoValidationException("A condition's bindings must start from the record type the trigger watches.");
        }
    }

    internal override void WriteBody(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("actionId", ActionId);
        NendoBehaviourValidation.WriteAliases(writer, CallAliases);
        NendoBehaviourValidation.WriteBindings(writer, ConditionBindings, "conditionBindings");
        if (ConditionExpression is not null) writer.WriteString("conditionExpression", ConditionExpression);
        writer.WriteString("displayName", DisplayName);
        writer.WriteString("entityId", EntityId);
        writer.WriteString("events", Events.ToString());
        writer.WriteStartArray("relevantFieldIds");
        foreach (var fieldId in RelevantFieldIds) writer.WriteStringValue(fieldId);
        writer.WriteEndArray();
        writer.WriteEndObject();
    }
}
