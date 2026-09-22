using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Says what this file is for, or clears what it said.
/// <para>
/// The value belongs to the file rather than to a record type or a node, which is the whole
/// point of it: a file with no front page still has to be able to say what it is, and an
/// agent reading the file cold should be told before it is handed a schema to infer purpose
/// from. A null clears it, and a blank is a null — an empty purpose is an absent one, never
/// a stored row holding nothing.
/// </para>
/// </summary>
public sealed record SetApplicationPurposeOperation : NendoOperation
{
    public SetApplicationPurposeOperation(string operationId, string? purpose, long expectedDefinitionRevision)
        : base(operationId)
    {
        Purpose = string.IsNullOrWhiteSpace(purpose) ? null : purpose;
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        if (Purpose is { Length: var length } && length > MaximumCharacters)
        {
            throw new ArgumentException(
                $"A purpose is at most {MaximumCharacters} characters, and this one is {length}.",
                nameof(purpose));
        }
    }

    /// <summary>
    /// Prose the author writes, or null for a file that has not said. Not markup, not a
    /// template and never a field reference: it is stored and read back as written.
    /// </summary>
    public string? Purpose { get; }

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "application.setPurpose";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    /// <summary>
    /// The longest purpose a file may carry. A bounded product choice rather than a measured
    /// optimum: enough for what the record types are for and how the file expects to be used,
    /// and short enough that every client can show it without deciding where to cut. Declared
    /// here, published through <see cref="NendoAuthoringLimits"/>, and refused above rather
    /// than truncated, so the number that is documented is the number that refuses.
    /// </summary>
    public const int MaximumCharacters = 4000;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { purpose = Purpose, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
