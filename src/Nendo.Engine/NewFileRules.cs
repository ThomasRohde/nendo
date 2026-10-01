using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Whether a record type's records are kept in a new file of this application (ADR-0022).
/// A type nobody has set leaves its records out, so a record nobody thought about is never
/// carried into a new file by accident. A record may say otherwise with
/// <see cref="SetRecordKeptInNewFilesOperation"/>.
/// <para>
/// Part of the definition: it says what the application ships with, so it is authored in a
/// change set like any other shape change, and reversed from History like one.
/// </para>
/// </summary>
public sealed record SetKeptInNewFilesDefaultOperation : NendoOperation
{
    public SetKeptInNewFilesDefaultOperation(string operationId, string entityId, bool kept, long expectedDefinitionRevision)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        Kept = kept;
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string EntityId { get; }

    /// <summary>True keeps the type's records in a new file; false, the default, leaves them out.</summary>
    public bool Kept { get; }

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "schema.setKeptInNewFiles";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, kept = Kept, expectedDefinitionRevision = ExpectedDefinitionRevision });
}

/// <summary>
/// One record's own say in whether a new file of this application keeps it (ADR-0022): kept,
/// left out, or null to follow its record type.
/// <para>
/// A fact about the record rather than a value in it. It changes no field and no record
/// version, so it never makes somebody's edit stale and no automatic action fires on it.
/// </para>
/// </summary>
public sealed record SetRecordKeptInNewFilesOperation : NendoOperation
{
    public SetRecordKeptInNewFilesOperation(string operationId, string entityId, string recordId, bool? kept)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        RecordId = Require(recordId, nameof(recordId));
        Kept = kept;
    }

    public string EntityId { get; }
    public string RecordId { get; }

    /// <summary>True keeps the record, false leaves it out, null follows its record type.</summary>
    public bool? Kept { get; }

    public override string OperationType => "data.setKeptInNewFiles";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, recordId = RecordId, kept = Kept });
}

/// <summary>
/// The application's own name for one new file of it, such as "Archi model" (ADR-0022): the
/// File menu offers "New Archi model…" rather than "New empty copy…". Null clears it.
/// </summary>
public sealed record SetNewFileLabelOperation : NendoOperation
{
    /// <summary>A label names a thing in a menu; anything longer is a sentence.</summary>
    public const int MaximumCharacters = 40;

    public SetNewFileLabelOperation(string operationId, string? label, long expectedDefinitionRevision)
        : base(operationId)
    {
        Label = string.IsNullOrWhiteSpace(label) ? null : label.Trim();
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        if (Label is not null && !NendoNewFile.IsLabel(Label))
        {
            throw new NendoValidationException(
                $"A new-file label is a short name of 1-{MaximumCharacters} characters on one line, such as \"Archi model\"; '{Label}' is not.");
        }
    }

    public string? Label { get; }
    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "application.setNewFileLabel";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { label = Label, expectedDefinitionRevision = ExpectedDefinitionRevision });
}

/// <summary>What a new file of this application would hold, and what stops one (ADR-0022).</summary>
public static class NendoNewFile
{
    /// <summary>The menu entry when the application has given itself no label.</summary>
    public const string DefaultMenuLabel = "New empty copy…";

    /// <summary>Whether this is a label a file may carry: trimmed, one line, 1 to 40 characters.</summary>
    public static bool IsLabel(string? label) =>
        label is { Length: >= 1 and <= SetNewFileLabelOperation.MaximumCharacters } &&
        string.Equals(label, label.Trim(), StringComparison.Ordinal) &&
        !label.Any(char.IsControl);

    /// <summary>The File menu's words for a file with this label.</summary>
    public static string MenuLabel(string? label) => label is null ? DefaultMenuLabel : $"New {label}…";
}

/// <summary>How many of one record type's records a new file would keep and leave out.</summary>
public sealed record NendoNewFileTypeCount(string EntityId, string DisplayName, bool KeptByDefault, long Kept, long LeftOut);

/// <summary>
/// A kept record that points at a record a new file would leave out, through one field. A new
/// file is refused while one exists, because it would hold a reference to nothing, and
/// nothing is cleared to make the rule hold.
/// </summary>
public sealed record NendoNewFileConflict(string EntityId, string RecordId, string FieldId, string TargetEntityId, string TargetRecordId);

/// <summary>
/// What a new file of the open application would hold, for the person to read first.
/// <paramref name="Conflicts"/> names at most <see cref="MaximumConflictsNamed"/> of them, and
/// <paramref name="ConflictCount"/> says how many there are; <paramref name="Revisions"/> is how
/// many changes of this file's history the new file folds into one.
/// </summary>
public sealed record NendoNewFilePreview(
    string MenuLabel,
    string? Label,
    IReadOnlyList<NendoNewFileTypeCount> Types,
    IReadOnlyList<NendoNewFileConflict> Conflicts,
    long ConflictCount,
    long Revisions)
{
    public const int MaximumConflictsNamed = 20;
    public long Kept => Types.Sum(type => type.Kept);
    public long LeftOut => Types.Sum(type => type.LeftOut);
    public bool CanCreate => ConflictCount == 0;
}

/// <summary>A new file of this application, made and activated (ADR-0022).</summary>
public sealed record NendoNewFileResult(
    string DestinationFileName,
    NendoManifestSnapshot Manifest,
    long KeptRecords,
    long LeftOutRecords,
    long FoldedRevisions,
    string TransitionRevisionId);
