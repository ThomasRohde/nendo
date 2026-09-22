using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

public sealed record NendoCanonicalProposalRequest(
    string ProposalId,
    string Title,
    string Origin,
    NendoCanonicalChangeSetRequest ChangeSet);

public sealed record NendoCanonicalChangeSetRequest(
    IReadOnlyList<NendoCanonicalMutationRequest> Mutations);

public sealed record NendoCanonicalMutationRequest(
    string IdempotencyScope,
    string IdempotencyKey,
    string Origin,
    string Description,
    IReadOnlyList<NendoCanonicalOperationRequest> Operations);

public sealed record NendoCanonicalOperationRequest(
    string OperationId,
    string OperationType,
    JsonElement Payload);

/// <summary>
/// Checks one canonical operation's shape without a file: the same typed
/// construction a proposal compiles through, run where the operation is sent.
/// <para>
/// A payload the compiler would refuse used to be discovered at validate, and a
/// validate that threw left the draft frozen, so a wrong guess at one payload key
/// cost the whole change set. Checked here, it costs one refused call that names
/// the operation — and nothing has entered the draft.
/// </para>
/// </summary>
public static class NendoCanonicalOperations
{
    public static void Check(string operationType, JsonElement payload) =>
        CanonicalChangeSetRequestCompiler.CompileOperation(
            new NendoCanonicalOperationRequest("operation.check", operationType, payload));
}

internal static class CanonicalChangeSetRequestCompiler
{
    private const int MaximumMutations = 32;

    /// <summary>
    /// The canonical ceiling, published as
    /// <see cref="NendoAuthoringLimits.CanonicalOperationsPerChangeSet"/> so an
    /// authoring client plans an inline-property expansion against the number
    /// that actually refuses.
    /// </summary>
    internal const int MaximumOperations = 512;

    internal static NendoChangeSet Compile(NendoCanonicalChangeSetRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Mutations);
        if (request.Mutations.Count is < 1 or > MaximumMutations)
        {
            throw new NendoValidationException(
                $"A canonical change set must contain 1-{MaximumMutations} mutations.");
        }
        var operationCount = request.Mutations.Sum(value => value.Operations?.Count ?? 0);
        if (operationCount is < 1 or > MaximumOperations)
        {
            throw new NendoValidationException(
                $"A canonical change set must contain 1-{MaximumOperations} operations.");
        }

        return new NendoChangeSet(request.Mutations.Select(CompileMutation).ToArray()).Validate();
    }

    private static NendoMutation CompileMutation(NendoCanonicalMutationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireText(request.IdempotencyScope, "idempotency scope", 200);
        RequireText(request.IdempotencyKey, "idempotency key", 200);
        RequireText(request.Origin, "origin", 100);
        RequireText(request.Description, "description", 500);
        ArgumentNullException.ThrowIfNull(request.Operations);
        return new NendoMutation(
            request.IdempotencyScope,
            request.IdempotencyKey,
            request.Origin,
            request.Description,
            request.Operations.Select(CompileOperation).ToArray());
    }

    internal static NendoOperation CompileOperation(NendoCanonicalOperationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireText(request.OperationId, "operation ID", 200);
        RequireText(request.OperationType, "operation type", 100);
        if (request.Payload.ValueKind != JsonValueKind.Object)
        {
            throw new NendoValidationException("A canonical operation payload must be an object.");
        }

        return request.OperationType switch
        {
            "schema.setFieldRequired" => new SetFieldRequiredOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"), Boolean(request.Payload, "required"), Long(request.Payload, "expectedDefinitionRevision")),
            "data.backfillRetiredField" => new BackfillRetiredFieldOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "recordId"), String(request.Payload, "fieldId"), Long(request.Payload, "expectedRecordVersion"),
                Value(request.Payload, "value"), OptionalLong(request.Payload, "expectedTargetRecordVersion")),
            "schema.setRetired" => new SetRetiredOperation(request.OperationId, String(request.Payload, "entityId"),
                OptionalString(request.Payload, "fieldId"), Boolean(request.Payload, "retired"), Long(request.Payload, "expectedDefinitionRevision")),
            "schema.setChoiceMetadata" => new SetChoiceMetadataOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"), String(request.Payload, "choiceId"), String(request.Payload, "displayName"),
                Boolean(request.Payload, "retired"), Long(request.Payload, "expectedDefinitionRevision"),
                OptionalString(request.Payload, "tone", 32)),
            "application.setPurpose" => new SetApplicationPurposeOperation(request.OperationId,
                OptionalString(request.Payload, "purpose", SetApplicationPurposeOperation.MaximumCharacters),
                Long(request.Payload, "expectedDefinitionRevision")),
            "data.convertLegacyReference" => new ConvertLegacyReferenceOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"), String(request.Payload, "targetEntityId"), String(request.Payload, "labelFieldId"),
                Long(request.Payload, "expectedDefinitionRevision"), ConversionRecords(request.Payload, "records")
                    ?? throw new NendoValidationException("Explicit conversion records are required.")),
            "schema.configureReference" => new ConfigureReferenceOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"), String(request.Payload, "targetEntityId"), String(request.Payload, "labelFieldId"),
                Long(request.Payload, "expectedDefinitionRevision"), ConversionRecords(request.Payload, "reviewedRecords")),
            "schema.renameEntity" => new RenameEntityOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "displayName", 200), Long(request.Payload, "expectedDefinitionRevision")),
            "schema.renameField" => new RenameFieldOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"), String(request.Payload, "displayName", 200), Long(request.Payload, "expectedDefinitionRevision")),
            "schema.createEntity" => new CreateEntityOperation(
                request.OperationId,
                String(request.Payload, "entityId"),
                String(request.Payload, "displayName", 200),
                PhysicalIdentifier(String(request.Payload, "entityId"), "entity")),
            "schema.addField" => new AddFieldOperation(
                request.OperationId,
                String(request.Payload, "entityId"),
                String(request.Payload, "fieldId"),
                String(request.Payload, "displayName", 200),
                PhysicalIdentifier(String(request.Payload, "fieldId"), "field"),
                StorageKind(request.Payload),
                Boolean(request.Payload, "required"),
                OptionalString(request.Payload, "presentation", 100),
                StringArray(request.Payload, "options", 32, 120),
                OptionalLong(request.Payload, "min"),
                OptionalLong(request.Payload, "max")),
            "ui.addNode" => new AddUiNodeOperation(
                request.OperationId,
                String(request.Payload, "surfaceId"),
                String(request.Payload, "nodeId"),
                OptionalString(request.Payload, "parentNodeId"),
                String(request.Payload, "kind", 100),
                Integer(request.Payload, "position")),
            "ui.setProperty" => new SetUiPropertyOperation(
                request.OperationId,
                String(request.Payload, "surfaceId"),
                String(request.Payload, "nodeId"),
                String(request.Payload, "propertyName", 100),
                Value(request.Payload, "value")),
            "ui.moveNode" => new MoveUiNodeOperation(
                request.OperationId,
                String(request.Payload, "surfaceId"),
                String(request.Payload, "nodeId"),
                OptionalString(request.Payload, "parentNodeId"),
                Integer(request.Payload, "position")),
            "ui.removeNode" => new RemoveUiNodeOperation(
                request.OperationId,
                String(request.Payload, "surfaceId"),
                String(request.Payload, "nodeId")),
            "data.createRecord" => new CreateRecordOperation(
                request.OperationId,
                String(request.Payload, "entityId"),
                String(request.Payload, "recordId"),
                Values(request.Payload, "values"), TargetVersions(request.Payload)),
            "data.deleteRecord" => new DeleteRecordOperation(request.OperationId, String(request.Payload, "entityId"),
                String(request.Payload, "recordId"), Long(request.Payload, "expectedRecordVersion")),
            "data.setField" => new SetFieldOperation(
                request.OperationId,
                String(request.Payload, "entityId"),
                String(request.Payload, "recordId"),
                String(request.Payload, "fieldId"),
                Long(request.Payload, "expectedRecordVersion"),
                Value(request.Payload, "value"), OptionalLong(request.Payload, "expectedTargetRecordVersion")),
            // The body is rebuilt into the same typed definition a native caller
            // constructs, and validated by it. Nothing here trusts the JSON: an
            // author cannot introduce a definition shape this host does not
            // implement by hand-writing a stored body.
            "behaviour.setDefinition" => new SetBehaviourDefinitionOperation(
                request.OperationId,
                BehaviourDefinition(request.Payload),
                Long(request.Payload, "expectedDefinitionRevision")),
            "behaviour.removeDefinition" => new RemoveBehaviourDefinitionOperation(
                request.OperationId,
                String(request.Payload, "definitionId"),
                BehaviourKind(request.Payload),
                Long(request.Payload, "expectedDefinitionRevision")),
            _ => throw new NendoValidationException(
                $"Canonical operation type {request.OperationType} is not supported."),
        };
    }

    private static NendoBehaviourKind BehaviourKind(JsonElement payload)
    {
        var declared = String(payload, "definitionKind", 40);
        return Enum.TryParse<NendoBehaviourKind>(declared, ignoreCase: true, out var kind) &&
            Enum.IsDefined(kind)
            ? kind
            : throw new NendoValidationException(
                $"Behaviour definition kind '{declared}' is not one this host implements. " +
                $"Use one of: {string.Join(", ", Enum.GetNames<NendoBehaviourKind>())}.");
    }

    private static NendoBehaviourDefinition BehaviourDefinition(JsonElement payload)
    {
        if (!payload.TryGetProperty("body", out var body) || body.ValueKind != JsonValueKind.Object)
            throw new NendoValidationException("A behaviour definition needs its body as an object.");
        return NendoBehaviourCodec.Read(
            String(payload, "definitionId"),
            BehaviourKind(payload),
            OptionalString(payload, "contractVersion", 40) ?? NendoBehaviourContract.Version,
            body.GetRawText(),
            NendoBehaviourBodySource.Authored);
    }

    private static string String(JsonElement source, string name, int maximumLength = 200)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new NendoValidationException($"Canonical operation property {name} requires text.");
        }
        var result = value.GetString() ?? string.Empty;
        RequireText(result, name, maximumLength);
        return result;
    }

    private static string? OptionalString(JsonElement source, string name, int maximumLength = 200)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        if (value.ValueKind != JsonValueKind.String)
        {
            throw new NendoValidationException($"Canonical operation property {name} requires text or null.");
        }
        var result = value.GetString();
        if (string.IsNullOrWhiteSpace(result))
        {
            return null;
        }
        RequireText(result, name, maximumLength);
        return result;
    }

    private static bool Boolean(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value) ||
            value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new NendoValidationException($"Canonical operation property {name} requires a boolean.");
        }
        return value.GetBoolean();
    }

    private static int Integer(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result))
        {
            throw new NendoValidationException($"Canonical operation property {name} requires an integer.");
        }
        return result;
    }

    private static long Long(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value) || !value.TryGetInt64(out var result))
        {
            throw new NendoValidationException($"Canonical operation property {name} requires an integer.");
        }
        return result;
    }

    private static long? OptionalLong(JsonElement source, string name) =>
        source.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? Long(source, name) : null;

    private static IReadOnlyList<NendoReferenceConversionRow>? ConversionRecords(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() is < 1 or > ConvertLegacyReferenceOperation.MaximumRecords)
            throw new NendoValidationException("Reference conversion requires a bounded record array.");
        return value.EnumerateArray().Select(row =>
        {
            if (row.ValueKind != JsonValueKind.Object || row.EnumerateObject().Any(property =>
                property.Name is not ("recordId" or "expectedRecordVersion" or "targetRecordId" or "expectedTargetRecordVersion")) ||
                !row.TryGetProperty("targetRecordId", out _))
                throw new NendoValidationException("Conversion records require explicit targets and known properties only.");
            return new NendoReferenceConversionRow(String(row, "recordId"), Long(row, "expectedRecordVersion"),
                OptionalString(row, "targetRecordId"), OptionalLong(row, "expectedTargetRecordVersion"));
        }).ToArray();
    }

    private static IReadOnlyDictionary<string, long>? TargetVersions(JsonElement source)
    {
        if (!source.TryGetProperty("expectedTargetVersions", out var values)) return null;
        if (values.ValueKind != JsonValueKind.Object || values.EnumerateObject().Count() > 128)
            throw new NendoValidationException("Target versions require a bounded field-to-version object.");
        return values.EnumerateObject().ToDictionary(pair => pair.Name, pair => Long(values, pair.Name), StringComparer.Ordinal);
    }

    private static JsonElement Value(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value))
        {
            throw new NendoValidationException($"Canonical operation property {name} is required.");
        }
        return value.Clone();
    }

    private static IReadOnlyDictionary<string, object?> Values(JsonElement source, string name)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Object)
        {
            throw new NendoValidationException($"Canonical operation property {name} requires an object.");
        }
        if (value.EnumerateObject().Count() > 128)
        {
            throw new NendoValidationException("A record operation cannot contain more than 128 fields.");
        }
        return value.EnumerateObject().ToDictionary(
            pair => pair.Name,
            pair => (object?)pair.Value.Clone(),
            StringComparer.Ordinal);
    }

    private static IReadOnlyList<string> StringArray(
        JsonElement source,
        string name,
        int maximumItems,
        int maximumItemLength)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            return [];
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            throw new NendoValidationException($"Canonical operation property {name} requires an array.");
        }
        var result = value.EnumerateArray().Select(item =>
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                throw new NendoValidationException(
                    $"Canonical operation property {name} requires text values.");
            }
            var text = item.GetString() ?? string.Empty;
            RequireText(text, name, maximumItemLength);
            return text;
        }).ToArray();
        if (result.Length > maximumItems)
        {
            throw new NendoValidationException(
                $"Canonical operation property {name} cannot contain more than {maximumItems} values.");
        }
        return result;
    }

    private static NendoStorageKind StorageKind(JsonElement source)
    {
        var value = String(source, "storageKind", 40);
        return Enum.TryParse<NendoStorageKind>(value, ignoreCase: true, out var result)
            ? result
            : throw new NendoValidationException($"Storage kind {value} is not supported.");
    }

    private static string PhysicalIdentifier(string semanticId, string prefix)
    {
        var suffix = semanticId.Split('.', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? prefix;
        var slug = new string(suffix
            .Select(character => char.IsAsciiLetterOrDigit(character) ? char.ToLowerInvariant(character) : '_')
            .ToArray()).Trim('_');
        if (slug.Length == 0)
        {
            slug = prefix;
        }
        if (!char.IsAsciiLetter(slug[0]) && slug[0] != '_')
        {
            slug = $"{prefix}_{slug}";
        }
        slug = slug[..Math.Min(slug.Length, 38)];
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(semanticId)).AsSpan(0, 4))
            .ToLowerInvariant();
        return $"{slug}_{hash}";
    }

    private static void RequireText(string value, string name, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new NendoValidationException(
                $"The {name} must contain 1-{maximumLength} characters.");
        }
    }
}
