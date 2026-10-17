using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// The rules a single-choice field's options are held to, wherever an option is made or named:
/// <see cref="AddFieldOperation"/>'s options, <see cref="AddChoiceOperation"/>'s new one and
/// <see cref="SetChoiceMetadataOperation"/>'s labels and tones.
/// </summary>
internal static class NendoChoiceRules
{
    /// <summary>The most options one single-choice field holds, retired ones included.</summary>
    internal const int MaximumOptions = 32;

    /// <summary>The longest stable option ID, in characters.</summary>
    internal const int MaximumIdLength = 120;

    /// <summary>The longest option label, in characters.</summary>
    internal const int MaximumLabelLength = 200;

    internal static void RequireLabel(string displayName)
    {
        if (displayName.Length > MaximumLabelLength || string.IsNullOrWhiteSpace(displayName))
            throw new NendoValidationException("Choice labels require 1–200 characters.");
    }

    internal static void RequireTone(string? tone)
    {
        if (tone is not null && !NendoSemanticVocabulary.ChoiceTones.Contains(tone))
            throw new NendoValidationException(
                $"Choose a tone from {string.Join(", ", NendoSemanticVocabulary.ChoiceToneOrder)}, or null for no colour; a hex value is not a tone.");
    }
}

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

/// <summary>
/// Appends a new stable option to the end of an active single-choice field's options, with its
/// label and an optional tone, so a field's choices can grow after it exists (ADR-0003,
/// 2026-10-17 note). No record changes: records can take the option from the next write.
/// </summary>
public sealed record AddChoiceOperation : NendoOperation
{
    public AddChoiceOperation(string operationId, string entityId, string fieldId, string choiceId,
        string displayName, long expectedDefinitionRevision, string? tone = null) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId));
        ChoiceId = Require(choiceId, nameof(choiceId)); DisplayName = Require(displayName, nameof(displayName));
        // The shape addField holds an option to, checked where the operation is made, so an agent
        // learns it at add_operations rather than at validate.
        if (ChoiceId.Length > NendoChoiceRules.MaximumIdLength)
            throw new NendoValidationException(
                $"A choice option's ID uses at most {NendoChoiceRules.MaximumIdLength} characters, as schema.addField's options do.");
        NendoChoiceRules.RequireLabel(DisplayName);
        Tone = string.IsNullOrWhiteSpace(tone) ? null : tone;
        NendoChoiceRules.RequireTone(Tone);
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }
    public string EntityId { get; }
    public string FieldId { get; }
    public string ChoiceId { get; }
    public string DisplayName { get; }
    /// <summary>The new option's colour as a closed named hue, or null for none.</summary>
    public string? Tone { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.addChoice";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    /// <summary>
    /// Its undo takes the option away again, and is refused while any record, live or kept for a
    /// deletion's undo, holds it. The evidence keeps whether the field had any option metadata
    /// before, so the undo leaves the field's metadata as it found it.
    /// </summary>
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, choiceId = ChoiceId, displayName = DisplayName,
            tone = Tone, expectedDefinitionRevision = ExpectedDefinitionRevision });
}

/// <summary>
/// The undo of <see cref="AddChoiceOperation"/>: takes the option it added off the end of the
/// field again. Constructed only by compensation, from the added option's own payload and
/// evidence, never from a client; the canonical change-set parser does not know it.
/// </summary>
internal sealed record RemoveChoiceOperation : NendoOperation
{
    public RemoveChoiceOperation(string operationId, string entityId, string fieldId, string choiceId,
        bool clearsChoiceMetadata, long expectedDefinitionRevision) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId));
        ChoiceId = Require(choiceId, nameof(choiceId));
        ClearsChoiceMetadata = clearsChoiceMetadata; ExpectedDefinitionRevision = expectedDefinitionRevision;
    }
    public string EntityId { get; }
    public string FieldId { get; }
    public string ChoiceId { get; }
    /// <summary>
    /// True when the field had no option metadata before the option was added, so every row the
    /// addition wrote for it goes, and its options read back with their IDs as labels again.
    /// </summary>
    public bool ClearsChoiceMetadata { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.removeChoice";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, choiceId = ChoiceId, clearsChoiceMetadata = ClearsChoiceMetadata,
            expectedDefinitionRevision = ExpectedDefinitionRevision });
}
