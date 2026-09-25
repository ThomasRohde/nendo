using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

public abstract record NendoOperation
{
    protected NendoOperation(string operationId)
    {
        OperationId = Require(operationId, nameof(operationId));
    }

    public string OperationId { get; }

    public abstract string OperationType { get; }

    public abstract NendoRevisionLane Lane { get; }

    public abstract NendoReversibilityClass Reversibility { get; }

    internal abstract void WritePayload(Utf8JsonWriter writer);

    internal string CanonicalJson()
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer);
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    internal void WriteCanonical(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("operationId", OperationId);
        writer.WriteString("operationType", OperationType);
        writer.WriteString("lane", Lane.ToString());
        writer.WriteString("reversibility", Reversibility.ToString());
        writer.WritePropertyName("payload");
        WritePayload(writer);
        writer.WriteEndObject();
    }

    internal static string Require(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Value must not be blank.", name);
        }

        return value;
    }
}

public sealed record CreateEntityOperation : NendoOperation
{
    public CreateEntityOperation(
        string operationId,
        string entityId,
        string displayName,
        string physicalTableName)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        DisplayName = Require(displayName, nameof(displayName));
        PhysicalTableName = Require(physicalTableName, nameof(physicalTableName));
    }

    public string EntityId { get; }
    public string DisplayName { get; }
    internal string PhysicalTableName { get; }
    public override string OperationType => "schema.createEntity";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("displayName", DisplayName);
        writer.WriteString("entityId", EntityId);
        writer.WriteString("physicalTableName", PhysicalTableName);
        writer.WriteEndObject();
    }
}

public sealed record AddFieldOperation : NendoOperation
{
    public AddFieldOperation(
        string operationId,
        string entityId,
        string fieldId,
        string displayName,
        string physicalColumnName,
        NendoStorageKind storageKind,
        bool required,
        string? presentation = null,
        IReadOnlyList<string>? options = null,
        long? min = null,
        long? max = null)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        FieldId = Require(fieldId, nameof(fieldId));
        DisplayName = Require(displayName, nameof(displayName));
        PhysicalColumnName = Require(physicalColumnName, nameof(physicalColumnName));
        StorageKind = storageKind;
        Required = required;
        Presentation = string.IsNullOrWhiteSpace(presentation) ? null : presentation;
        Options = (options ?? [])
            .Select(value => Require(value, nameof(options)))
            .ToArray();
        Min = min;
        Max = max;
        ValidatePresentation();
    }

    public string EntityId { get; }
    public string FieldId { get; }
    public string DisplayName { get; }
    internal string PhysicalColumnName { get; }
    public NendoStorageKind StorageKind { get; }
    public bool Required { get; }
    public string? Presentation { get; }
    public IReadOnlyList<string> Options { get; }
    public long? Min { get; }
    public long? Max { get; }

    /// <summary>The closed scale a rating field is drawn on, or null for every other presentation.</summary>
    public NendoRatingScale? Scale => Min is { } min && Max is { } max ? new NendoRatingScale(min, max) : null;

    public override string OperationType => "schema.addField";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("displayName", DisplayName);
        writer.WriteString("entityId", EntityId);
        writer.WriteString("fieldId", FieldId);
        writer.WriteString("physicalColumnName", PhysicalColumnName);
        if (Presentation is not null)
        {
            writer.WriteString("presentation", Presentation);
        }
        writer.WriteBoolean("required", Required);
        writer.WriteString("storageKind", StorageKind.ToString());
        if (Options.Count != 0)
        {
            writer.WriteStartArray("options");
            foreach (var option in Options)
            {
                writer.WriteStringValue(option);
            }
            writer.WriteEndArray();
        }
        // The scale is written after options, where options themselves sit outside the
        // alphabetical block, and omitted when absent: an operation that declares no
        // scale keeps the exact bytes it hashed before ratings existed.
        if (Max is { } maximum)
        {
            writer.WriteNumber("max", maximum);
        }
        if (Min is { } minimum)
        {
            writer.WriteNumber("min", minimum);
        }
        writer.WriteEndObject();
    }

    private void ValidatePresentation()
    {
        if (!Enum.IsDefined(StorageKind) || StorageKind == NendoStorageKind.Unsupported)
        {
            throw new ArgumentException("Unsupported field kinds are inspection-only and cannot be authored.", nameof(StorageKind));
        }
        var supported = new HashSet<string>(
            ["singleLine", "longText", "singleChoice", "date", "rating"],
            StringComparer.Ordinal);
        if (Presentation is not null && !supported.Contains(Presentation))
        {
            throw new ArgumentException("The field presentation is not part of semantic contract version 1.", nameof(Presentation));
        }
        if (Presentation == "singleChoice")
        {
            if (StorageKind != NendoStorageKind.Text || Options.Count == 0)
            {
                throw new ArgumentException("A singleChoice field must be Text with at least one option.", nameof(Options));
            }
            if (Options.Count > 32 || Options.Distinct(StringComparer.Ordinal).Count() != Options.Count ||
                Options.Any(value => value.Length > 120))
            {
                throw new ArgumentException("Single-choice options must be unique, contain at most 32 values and use at most 120 characters each.", nameof(Options));
            }
        }
        else if (Options.Count != 0)
        {
            throw new ArgumentException("Only singleChoice fields can declare options.", nameof(Options));
        }
        if (Presentation == "date" && StorageKind != NendoStorageKind.Date)
        {
            throw new ArgumentException("The date presentation requires Date storage.", nameof(Presentation));
        }
        ValidateScale();
    }

    /// <summary>
    /// A rating is a whole number drawn on a closed scale, ADR-0004 2026-09-14 amendment
    /// (S2). Both bounds are required, because dots nobody bounded cannot be drawn, and the
    /// span is at most ten values: a scale a person cannot count at a glance is a number,
    /// which the Integer presentation already shows. The bounds are refused on every other
    /// presentation the way options are refused off a single choice, so a field carrying one
    /// is never a field that quietly ignores it.
    /// </summary>
    private void ValidateScale()
    {
        if (Presentation == "rating")
        {
            if (StorageKind != NendoStorageKind.Integer)
            {
                throw new ArgumentException("The rating presentation requires Integer storage.", nameof(Presentation));
            }
            if (Min is null || Max is null)
            {
                throw new ArgumentException("A rating field must declare both min and max.", nameof(Min));
            }
            if (Max <= Min)
            {
                throw new ArgumentException($"A rating's max ({Max}) must be greater than its min ({Min}).", nameof(Max));
            }
            if (Max - Min > MaximumRatingSpan)
            {
                throw new ArgumentException(
                    $"A rating scale carries at most {MaximumRatingSpan + 1} values, and {Min} to {Max} is {Max - Min + 1}.",
                    nameof(Max));
            }
        }
        else if (Min is not null || Max is not null)
        {
            throw new ArgumentException("Only rating fields can declare a scale.", nameof(Min));
        }
    }

    /// <summary>
    /// The greatest difference between a rating's bounds, so at most ten values counting
    /// both ends. A bounded initial product choice, not a measured optimum: ten dots are
    /// countable at a glance, and a wider scale is a number rather than a picture.
    /// </summary>
    internal const long MaximumRatingSpan = 9;
}

public sealed record AddUiNodeOperation : NendoOperation
{
    public AddUiNodeOperation(
        string operationId,
        string surfaceId,
        string nodeId,
        string? parentNodeId,
        string kind,
        int position)
        : base(operationId)
    {
        SurfaceId = Require(surfaceId, nameof(surfaceId));
        NodeId = Require(nodeId, nameof(nodeId));
        ParentNodeId = string.IsNullOrWhiteSpace(parentNodeId) ? null : parentNodeId;
        Kind = Require(kind, nameof(kind));
        if (position < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(position), "UI node positions cannot be negative.");
        }
        Position = position;
    }

    public string SurfaceId { get; }
    public string NodeId { get; }
    public string? ParentNodeId { get; }
    public string Kind { get; }
    public int Position { get; }
    public override string OperationType => "ui.addNode";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.Reversible;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", Kind);
        if (ParentNodeId is null)
        {
            writer.WriteNull("parentNodeId");
        }
        else
        {
            writer.WriteString("parentNodeId", ParentNodeId);
        }
        writer.WriteString("nodeId", NodeId);
        writer.WriteNumber("position", Position);
        writer.WriteString("surfaceId", SurfaceId);
        writer.WriteEndObject();
    }
}

public sealed record SetUiPropertyOperation : NendoOperation
{
    public SetUiPropertyOperation(
        string operationId,
        string surfaceId,
        string nodeId,
        string propertyName,
        object? value)
        : base(operationId)
    {
        SurfaceId = Require(surfaceId, nameof(surfaceId));
        NodeId = Require(nodeId, nameof(nodeId));
        PropertyName = Require(propertyName, nameof(propertyName));
        Value = value is JsonElement element
            ? element.Clone()
            : JsonSerializer.SerializeToElement(value, value?.GetType() ?? typeof(object));
    }

    public string SurfaceId { get; }
    public string NodeId { get; }
    public string PropertyName { get; }
    public JsonElement Value { get; }
    public override string OperationType => "ui.setProperty";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("nodeId", NodeId);
        writer.WriteString("propertyName", PropertyName);
        writer.WriteString("surfaceId", SurfaceId);
        writer.WritePropertyName("value");
        Value.WriteTo(writer);
        writer.WriteEndObject();
    }
}

public sealed record MoveUiNodeOperation : NendoOperation
{
    public MoveUiNodeOperation(
        string operationId,
        string surfaceId,
        string nodeId,
        string? parentNodeId,
        int position)
        : base(operationId)
    {
        SurfaceId = Require(surfaceId, nameof(surfaceId));
        NodeId = Require(nodeId, nameof(nodeId));
        ParentNodeId = string.IsNullOrWhiteSpace(parentNodeId) ? null : parentNodeId;
        if (position < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(position), "UI node positions cannot be negative.");
        }
        Position = position;
    }

    public string SurfaceId { get; }
    public string NodeId { get; }
    public string? ParentNodeId { get; }
    public int Position { get; }
    public override string OperationType => "ui.moveNode";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        if (ParentNodeId is null)
        {
            writer.WriteNull("parentNodeId");
        }
        else
        {
            writer.WriteString("parentNodeId", ParentNodeId);
        }
        writer.WriteString("nodeId", NodeId);
        writer.WriteNumber("position", Position);
        writer.WriteString("surfaceId", SurfaceId);
        writer.WriteEndObject();
    }
}

public sealed record RemoveUiNodeOperation : NendoOperation
{
    public RemoveUiNodeOperation(string operationId, string surfaceId, string nodeId)
        : base(operationId)
    {
        SurfaceId = Require(surfaceId, nameof(surfaceId));
        NodeId = Require(nodeId, nameof(nodeId));
    }

    public string SurfaceId { get; }
    public string NodeId { get; }
    public override string OperationType => "ui.removeNode";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("nodeId", NodeId);
        writer.WriteString("surfaceId", SurfaceId);
        writer.WriteEndObject();
    }
}

public sealed record CreateRecordOperation : NendoOperation
{
    public CreateRecordOperation(
        string operationId,
        string entityId,
        string recordId,
        IReadOnlyDictionary<string, object?> values,
        IReadOnlyDictionary<string, long>? expectedTargetVersions = null)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        RecordId = Require(recordId, nameof(recordId));
        ArgumentNullException.ThrowIfNull(values);
        ExpectedTargetVersions = (expectedTargetVersions ?? new Dictionary<string, long>())
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        Values = values
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(
                pair => Require(pair.Key, nameof(values)),
                pair => JsonSerializer.SerializeToElement(pair.Value, pair.Value?.GetType() ?? typeof(object)),
                StringComparer.Ordinal);
    }

    public string EntityId { get; }
    public string RecordId { get; }
    public IReadOnlyDictionary<string, JsonElement> Values { get; }
    public IReadOnlyDictionary<string, long> ExpectedTargetVersions { get; }
    public override string OperationType => "data.createRecord";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("entityId", EntityId);
        writer.WriteString("recordId", RecordId);
        writer.WriteStartObject("values");
        foreach (var pair in Values.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            writer.WritePropertyName(pair.Key);
            pair.Value.WriteTo(writer);
        }
        writer.WriteEndObject();
        if (ExpectedTargetVersions.Count > 0)
        {
            writer.WriteStartObject("expectedTargetVersions");
            foreach (var pair in ExpectedTargetVersions.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                writer.WriteNumber(pair.Key, pair.Value);
            writer.WriteEndObject();
        }
        writer.WriteEndObject();
    }
}

public sealed record SetFieldOperation : NendoOperation
{
    public SetFieldOperation(
        string operationId,
        string entityId,
        string recordId,
        string fieldId,
        long expectedRecordVersion,
        object? value,
        long? expectedTargetRecordVersion = null)
        : base(operationId)
    {
        EntityId = Require(entityId, nameof(entityId));
        RecordId = Require(recordId, nameof(recordId));
        FieldId = Require(fieldId, nameof(fieldId));
        if (expectedRecordVersion < 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(expectedRecordVersion),
                "Record versions begin at one.");
        }
        ExpectedRecordVersion = expectedRecordVersion;
        ExpectedTargetRecordVersion = expectedTargetRecordVersion;
        Value = value is JsonElement element
            ? element.Clone()
            : JsonSerializer.SerializeToElement(value, value?.GetType() ?? typeof(object));
    }

    public string EntityId { get; }
    public string RecordId { get; }
    public string FieldId { get; }
    public long ExpectedRecordVersion { get; }
    public JsonElement Value { get; }
    public long? ExpectedTargetRecordVersion { get; }
    public override string OperationType => "data.setField";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("entityId", EntityId);
        writer.WriteNumber("expectedRecordVersion", ExpectedRecordVersion);
        writer.WriteString("fieldId", FieldId);
        writer.WriteString("recordId", RecordId);
        writer.WritePropertyName("value");
        Value.WriteTo(writer);
        if (ExpectedTargetRecordVersion is long targetVersion)
            writer.WriteNumber("expectedTargetRecordVersion", targetVersion);
        writer.WriteEndObject();
    }
}

public sealed record NendoMutation(
    string IdempotencyScope,
    string IdempotencyKey,
    string Origin,
    string Description,
    IReadOnlyList<NendoOperation> Operations)
{
    public NendoMutation Validate()
    {
        NendoOperation.Require(IdempotencyScope, nameof(IdempotencyScope));
        NendoOperation.Require(IdempotencyKey, nameof(IdempotencyKey));
        NendoOperation.Require(Origin, nameof(Origin));
        NendoOperation.Require(Description, nameof(Description));
        ArgumentNullException.ThrowIfNull(Operations);
        if (Operations.Count == 0)
        {
            throw new NendoValidationException("A mutation must contain at least one operation.");
        }
        if (Operations.Any(operation => operation is IdentityTransitionOperation || operation.OperationType == "identity.transition"))
        {
            throw new NendoValidationException("Identity transitions require the dedicated file-copy lifecycle and cannot be submitted as mutations or proposals.");
        }
        if (Operations.Select(operation => operation.Lane).Distinct().Count() != 1)
        {
            throw new NendoValidationException("A mutation cannot mix definition and data operations.");
        }
        if (Operations.Select(operation => operation.OperationId).Distinct(StringComparer.Ordinal).Count() != Operations.Count)
        {
            throw new NendoValidationException("Operation IDs must be unique within a mutation.");
        }
        RequireExtensionContentWithinBound(Operations);

        return this;
    }

    /// <summary>
    /// Refuses more new package content than one commit may carry. Counted over the bytes the
    /// operations bring with them, so content the file already holds costs nothing.
    /// </summary>
    internal static void RequireExtensionContentWithinBound(IEnumerable<NendoOperation> operations)
    {
        var carried = operations.OfType<PutExtensionFileOperation>().Sum(operation => (long)operation.CarriedBytes);
        if (carried > NendoExtensionLimits.ContentBytesPerChangeSet)
        {
            throw new NendoValidationException(
                $"A change carries at most {NendoExtensionLimits.ContentBytesPerChangeSet} bytes of new package content, and this one carries {carried}. " +
                "Split the files across several change sets.");
        }
    }

    internal string OperationDigest => NendoCanonical.DigestOperations(Operations);

    internal string PayloadDigest => NendoCanonical.DigestMutation(this);
}

public sealed record NendoChangeSet(IReadOnlyList<NendoMutation> Mutations)
{
    public NendoChangeSet Validate()
    {
        ArgumentNullException.ThrowIfNull(Mutations);
        if (Mutations.Count == 0)
        {
            throw new NendoValidationException("A change set must contain at least one mutation.");
        }
        foreach (var mutation in Mutations)
        {
            mutation.Validate();
        }
        var operations = Mutations.SelectMany(mutation => mutation.Operations).ToArray();
        // A change set commits in one transaction, so its content is bounded as a whole.
        NendoMutation.RequireExtensionContentWithinBound(operations);
        if (operations.OfType<ConvertLegacyReferenceOperation>().Any())
        {
            if (Mutations.Count != 2 || Mutations.Any(mutation => mutation.Operations.Count != 1) ||
                operations[0] is not ConvertLegacyReferenceOperation conversion ||
                operations[1] is not ConfigureReferenceOperation binding || binding.ReviewedRecords is null ||
                conversion.EntityId != binding.EntityId || conversion.FieldId != binding.FieldId ||
                conversion.TargetEntityId != binding.TargetEntityId || conversion.LabelFieldId != binding.LabelFieldId ||
                conversion.ExpectedDefinitionRevision != binding.ExpectedDefinitionRevision ||
                !conversion.Records.Select(row => row with
                {
                    ExpectedRecordVersion = checked(row.ExpectedRecordVersion + 1),
                    ExpectedTargetRecordVersion = row.ExpectedTargetRecordVersion is long version && conversion.EntityId == conversion.TargetEntityId
                        ? checked(version + 1) : row.ExpectedTargetRecordVersion,
                }).SequenceEqual(binding.ReviewedRecords))
                throw new NendoValidationException("Legacy conversion requires its own two-mutation proposal: convert all explicitly mapped records, then bind the same reference using the resulting record versions.");
        }
        if (operations.Select(operation => operation.OperationId)
                .Distinct(StringComparer.Ordinal).Count() != operations.Length)
        {
            throw new NendoValidationException("Operation IDs must be unique across a change set.");
        }
        var idempotency = Mutations
            .Select(mutation => (mutation.IdempotencyScope, mutation.IdempotencyKey))
            .ToArray();
        if (idempotency.Distinct().Count() != idempotency.Length)
        {
            throw new NendoValidationException("Idempotency scope/key pairs must be unique across a change set.");
        }
        return this;
    }

    public string OperationDigest => NendoCanonical.DigestChangeSet(Validate().Mutations);
}

internal static class NendoCanonical
{
    internal static string DigestOperations(IReadOnlyList<NendoOperation> operations) =>
        Digest(writer => WriteOperations(writer, operations));

    internal static string DigestMutation(NendoMutation mutation) =>
        Digest(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("description", mutation.Description);
            writer.WriteString("idempotencyKey", mutation.IdempotencyKey);
            writer.WriteString("idempotencyScope", mutation.IdempotencyScope);
            writer.WritePropertyName("operations");
            WriteOperations(writer, mutation.Operations);
            writer.WriteString("origin", mutation.Origin);
            writer.WriteEndObject();
        });

    internal static string DigestChangeSet(IReadOnlyList<NendoMutation> mutations) =>
        Digest(writer =>
        {
            writer.WriteStartArray();
            foreach (var mutation in mutations)
            {
                writer.WriteStartObject();
                writer.WriteString("lane", mutation.Operations[0].Lane.ToString());
                writer.WritePropertyName("operations");
                WriteOperations(writer, mutation.Operations);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        });

    internal static string DeterministicId(string prefix, string scope, string key, int ordinal)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{scope}\n{key}\n{ordinal}"));
        return $"{prefix}-{Convert.ToHexString(bytes.AsSpan(0, 12)).ToLowerInvariant()}";
    }

    private static void WriteOperations(Utf8JsonWriter writer, IReadOnlyList<NendoOperation> operations)
    {
        writer.WriteStartArray();
        foreach (var operation in operations)
        {
            operation.WriteCanonical(writer);
        }
        writer.WriteEndArray();
    }

    private static string Digest(Action<Utf8JsonWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            write(writer);
        }

        return Convert.ToHexString(SHA256.HashData(stream.ToArray())).ToLowerInvariant();
    }
}
