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
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId"], ["resultType", "nullable"],
            "Counts the records pointing back at this one. The result is always Integer and never null; " +
            "resultType and nullable may be sent, and must say so. Past the row ceiling it refuses rather than counting part."),
        new(NendoBindingKind.RelatedAggregate, NendoAggregateFunction.FilteredCount,
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId", "predicateFieldId"], ["resultType", "nullable"],
            "Counts the records pointing back at this one whose Boolean predicateFieldId is true. " +
            "The result is always Integer and never null."),
        new(NendoBindingKind.RelatedAggregate, NendoAggregateFunction.Sum,
            ["bindingId", "kind", "aggregate", "entityId", "relatedEntityId", "relatedReferenceFieldId", "valueFieldId", "resultType"], ["nullable"],
            "Totals valueFieldId over the records pointing back at this one, exactly. resultType is Integer or Decimal " +
            "and matches the field; the result is never null, and an empty collection totals zero."),
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
        "valueFieldId" => "the Integer or Decimal field it totals",
        "resultType" => "the scalar the value has: " + string.Join(", ", Enum.GetNames<NendoBehaviourScalar>()),
        "nullable" => "whether the value may be empty",
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
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, NendoBehaviourScalar.Integer, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.Count,
        };

    /// <summary>Counts related records whose Boolean field is true. The result is a non-null Int64.</summary>
    public static NendoBehaviourBinding RelatedFilteredCount(
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId, string predicateFieldId) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, NendoBehaviourScalar.Integer, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.FilteredCount,
            PredicateFieldId = NendoOperation.Require(predicateFieldId, nameof(predicateFieldId)),
        };

    /// <summary>Sums a numeric field over related records, with checked arithmetic.</summary>
    public static NendoBehaviourBinding RelatedSum(
        string bindingId, string entityId, string relatedEntityId, string relatedReferenceFieldId,
        string valueFieldId, NendoBehaviourScalar resultType) =>
        new(bindingId, NendoBindingKind.RelatedAggregate, resultType, false)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            RelatedEntityId = NendoOperation.Require(relatedEntityId, nameof(relatedEntityId)),
            RelatedReferenceFieldId = NendoOperation.Require(relatedReferenceFieldId, nameof(relatedReferenceFieldId)),
            Aggregate = NendoAggregateFunction.Sum,
            ValueFieldId = NendoOperation.Require(valueFieldId, nameof(valueFieldId)),
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
                if (Aggregate == NendoAggregateFunction.FilteredCount && PredicateFieldId is null)
                    throw new NendoValidationException("A filtered count needs the Boolean field it tests.");
                if (Aggregate == NendoAggregateFunction.Sum && ValueFieldId is null)
                    throw new NendoValidationException("A sum needs the numeric field it accumulates.");
                if (Aggregate == NendoAggregateFunction.Sum &&
                    ResultType is not (NendoBehaviourScalar.Integer or NendoBehaviourScalar.Decimal))
                    throw new NendoValidationException("A sum produces a whole number or a decimal.");
                if (Nullable)
                    throw new NendoValidationException("An aggregate is never null; an empty collection totals zero.");
                break;
            default:
                throw new NendoValidationException("The binding kind is not supported by this contract.");
        }
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("bindingId", BindingId);
        if (Aggregate is { } aggregate) writer.WriteString("aggregate", aggregate.ToString());
        if (CalculationId is not null) writer.WriteString("calculationId", CalculationId);
        writer.WriteString("entityId", EntityId);
        if (FieldId is not null) writer.WriteString("fieldId", FieldId);
        writer.WriteString("kind", Kind.ToString());
        writer.WriteBoolean("nullable", Nullable);
        if (PredicateFieldId is not null) writer.WriteString("predicateFieldId", PredicateFieldId);
        if (ReferenceFieldId is not null) writer.WriteString("referenceFieldId", ReferenceFieldId);
        if (RelatedEntityId is not null) writer.WriteString("relatedEntityId", RelatedEntityId);
        if (RelatedReferenceFieldId is not null) writer.WriteString("relatedReferenceFieldId", RelatedReferenceFieldId);
        writer.WriteString("resultType", ResultType.ToString());
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

    public static NendoActionStep SetField(string stepId, NendoActionTarget target, NendoActionAssignment assignment) =>
        new(stepId, NendoActionStepKind.SetField) { Target = target, Assignments = [assignment] };

    /// <summary>Sets several fields on one record as a single logical change.</summary>
    public static NendoActionStep SetFields(string stepId, NendoActionTarget target, IReadOnlyList<NendoActionAssignment> assignments) =>
        new(stepId, NendoActionStepKind.SetField) { Target = target, Assignments = assignments };

    public static NendoActionStep CreateRecord(string stepId, string entityId, IReadOnlyList<NendoActionAssignment> assignments) =>
        new(stepId, NendoActionStepKind.CreateRecord)
        {
            EntityId = NendoOperation.Require(entityId, nameof(entityId)),
            Assignments = assignments,
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
                if (Assignments.Count == 0) throw new NendoValidationException("A create step needs at least one field value.");
                break;
            case NendoActionStepKind.DeleteRecord:
                if (Assignments.Count != 0) throw new NendoValidationException("A delete step writes no field values.");
                break;
            default:
                throw new NendoValidationException("The step kind is not supported by this contract.");
        }
        if (Assignments.Select(assignment => assignment.FieldId).Distinct(StringComparer.Ordinal).Count() != Assignments.Count)
            throw new NendoValidationException("One step cannot write the same field twice.");
        foreach (var assignment in Assignments) assignment.Validate();
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

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        CallAliases.Select(alias => alias.FunctionId)
            .Concat(Bindings.Where(binding => binding.CalculationId is not null).Select(binding => binding.CalculationId!));

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
            if (string.Equals(binding.CalculationId, DefinitionId, StringComparison.Ordinal))
                throw new NendoValidationException("A calculation cannot read itself.");
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

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        ReferencedAliases.Select(alias => alias.FunctionId)
            .Concat(Steps.SelectMany(step => step.Assignments)
                .SelectMany(assignment => assignment.Bindings)
                .Where(binding => binding.CalculationId is not null)
                .Select(binding => binding.CalculationId!));

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

    internal override IEnumerable<string> ReferencedDefinitionIds =>
        CallAliases.Select(alias => alias.FunctionId)
            .Concat(ConditionBindings.Where(binding => binding.CalculationId is not null).Select(binding => binding.CalculationId!))
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
