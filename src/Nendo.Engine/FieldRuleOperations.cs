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

/// <summary>A unique Text field's sequence (ADR-0020): the prefix and the zero-padded width of the number after it.</summary>
public sealed record NendoFieldSequence(string Prefix, int Width);

/// <summary>A value the host wrote into a record because the create left a sequence field empty.</summary>
public sealed record NendoAssignedValue(string EntityId, string RecordId, string FieldId, string Value);

/// <summary>
/// Gives a unique Text field a sequence, or removes it (ADR-0020): on a create that leaves the
/// field empty, the host writes the prefix and the next number inside the same transaction. The
/// next number is one past the highest ever seen and is never reused. A null prefix removes the
/// sequence and leaves every value as it is. <see cref="MinimumNext"/> is set only by
/// compensation, so undoing a removal cannot hand out a number that was already used.
/// </summary>
public sealed record SetFieldSequenceOperation : NendoOperation
{
    public const int MaximumPrefixLength = 16;
    public const int MaximumWidth = 9;

    public SetFieldSequenceOperation(string operationId, string entityId, string fieldId, string? prefix, int? width,
        long expectedDefinitionRevision, long? minimumNext = null) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        FieldId = Require(fieldId, nameof(fieldId));
        if (prefix is null != width is null)
            throw new NendoValidationException("A sequence needs both prefix and width, or neither to remove it.");
        if (prefix is not null && (prefix.Length is < 1 or > MaximumPrefixLength || char.IsAsciiDigit(prefix[^1]) || prefix.Any(char.IsWhiteSpace)))
            throw new NendoValidationException($"A sequence prefix is 1 to {MaximumPrefixLength} characters without spaces, and cannot end in a digit.");
        if (width is < 1 or > MaximumWidth)
            throw new NendoValidationException($"A sequence width is 1 to {MaximumWidth} digits.");
        if (minimumNext is < 1) throw new NendoValidationException("A sequence starts at 1.");
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        Prefix = prefix;
        Width = width;
        MinimumNext = minimumNext;
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }
    public string FieldId { get; }
    public string? Prefix { get; }
    public int? Width { get; }
    public long? MinimumNext { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setFieldSequence";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer, new
    {
        entityId = EntityId,
        expectedDefinitionRevision = ExpectedDefinitionRevision,
        fieldId = FieldId,
        minimumNext = MinimumNext,
        prefix = Prefix,
        width = Width,
    });
}
