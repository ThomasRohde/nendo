using System.Text.Json;

namespace Nendo.Engine;

public sealed record NendoReferenceConversionRow(string RecordId, long ExpectedRecordVersion,
    string? TargetRecordId, long? ExpectedTargetRecordVersion);

/// <summary>Explicitly maps every record of an unbound legacy field, without guessing a target.</summary>
public sealed record ConvertLegacyReferenceOperation : NendoOperation
{
    public const int MaximumRecords = 100;
    public ConvertLegacyReferenceOperation(string operationId, string entityId, string fieldId,
        string targetEntityId, string labelFieldId, long expectedDefinitionRevision,
        IReadOnlyList<NendoReferenceConversionRow> records) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId));
        TargetEntityId = Require(targetEntityId, nameof(targetEntityId)); LabelFieldId = Require(labelFieldId, nameof(labelFieldId));
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        Records = ValidateRecords(records);
    }
    public string EntityId { get; }
    public string FieldId { get; }
    public string TargetEntityId { get; }
    public string LabelFieldId { get; }
    public long ExpectedDefinitionRevision { get; }
    public IReadOnlyList<NendoReferenceConversionRow> Records { get; }
    public override string OperationType => "data.convertLegacyReference";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;
    internal static IReadOnlyList<NendoReferenceConversionRow> ValidateRecords(IReadOnlyList<NendoReferenceConversionRow> records)
    {
        ArgumentNullException.ThrowIfNull(records);
        if (records.Count is < 1 or > MaximumRecords || records.Any(row => row is null ||
            string.IsNullOrWhiteSpace(row.RecordId) || row.ExpectedRecordVersion is < 1 or >= long.MaxValue ||
            (row.TargetRecordId is null ? row.ExpectedTargetRecordVersion is not null :
                string.IsNullOrWhiteSpace(row.TargetRecordId) || row.ExpectedTargetRecordVersion is null or < 1)) ||
            records.Select(row => row.RecordId).Distinct(StringComparer.Ordinal).Count() != records.Count)
            throw new NendoValidationException($"Reference conversion requires 1-{MaximumRecords} distinct records with explicit source and target versions.");
        return Array.AsReadOnly(records.ToArray());
    }
    internal static object[] CanonicalRecords(IReadOnlyList<NendoReferenceConversionRow> records) => records.Select(row => (object)new
    { recordId = row.RecordId, expectedRecordVersion = row.ExpectedRecordVersion, targetRecordId = row.TargetRecordId,
        expectedTargetRecordVersion = row.ExpectedTargetRecordVersion }).ToArray();
    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { entityId = EntityId, fieldId = FieldId, targetEntityId = TargetEntityId, labelFieldId = LabelFieldId,
            expectedDefinitionRevision = ExpectedDefinitionRevision, records = CanonicalRecords(Records) });
}

/// <summary>Explicitly binds a previously unbound reference field.</summary>
public sealed record ConfigureReferenceOperation : NendoOperation
{
    public ConfigureReferenceOperation(string operationId, string entityId, string fieldId,
        string targetEntityId, string labelFieldId, long expectedDefinitionRevision,
        IReadOnlyList<NendoReferenceConversionRow>? reviewedRecords = null) : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId)); FieldId = Require(fieldId, nameof(fieldId));
        TargetEntityId = Require(targetEntityId, nameof(targetEntityId)); LabelFieldId = Require(labelFieldId, nameof(labelFieldId));
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        ReviewedRecords = reviewedRecords is null ? null : ConvertLegacyReferenceOperation.ValidateRecords(reviewedRecords);
    }
    public string EntityId { get; }
    public string FieldId { get; }
    public string TargetEntityId { get; }
    public string LabelFieldId { get; }
    public long ExpectedDefinitionRevision { get; }
    public IReadOnlyList<NendoReferenceConversionRow>? ReviewedRecords { get; }
    public override string OperationType => "schema.configureReference";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;
    internal override void WritePayload(Utf8JsonWriter writer)
    {
        // Preserve the canonical bytes of existing configure operations.
        if (ReviewedRecords is null) JsonSerializer.Serialize(writer,
            new { entityId = EntityId, fieldId = FieldId, targetEntityId = TargetEntityId,
                labelFieldId = LabelFieldId, expectedDefinitionRevision = ExpectedDefinitionRevision });
        else JsonSerializer.Serialize(writer,
            new { entityId = EntityId, fieldId = FieldId, targetEntityId = TargetEntityId,
                labelFieldId = LabelFieldId, expectedDefinitionRevision = ExpectedDefinitionRevision,
                reviewedRecords = ConvertLegacyReferenceOperation.CanonicalRecords(ReviewedRecords) });
    }
}
