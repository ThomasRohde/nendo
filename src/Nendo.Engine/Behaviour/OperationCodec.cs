using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Rebuilds a generated operation from the canonical JSON a reviewed plan stored.
/// <para>
/// Deliberately narrow: only the three local data writes an action is allowed to
/// make. A reviewed plan is replayed through the ordinary operation dispatch, and
/// this is the gate that decides what a plan is even able to ask for — so widening
/// it would widen what a promoted proposal could do, not just what it could express.
/// </para>
/// <para>
/// Round-tripping through canonical JSON rather than keeping the objects in memory
/// is what lets a plan outlive the session that reviewed it, and it means a
/// workspace somebody edited is parsed and re-validated like anything else rather
/// than trusted because it came off disk.
/// </para>
/// </summary>
internal static class NendoOperationCodec
{
    internal static NendoOperation Read(string canonicalJson)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(canonicalJson);
        }
        catch (JsonException)
        {
            throw Damaged();
        }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Damaged();
            var operationId = Text(root, "operationId");
            var payload = root.TryGetProperty("payload", out var value) && value.ValueKind == JsonValueKind.Object
                ? value
                : throw Damaged();
            return Text(root, "operationType") switch
            {
                "data.setField" => new SetFieldOperation(
                    operationId,
                    Text(payload, "entityId"),
                    Text(payload, "recordId"),
                    Text(payload, "fieldId"),
                    Number(payload, "expectedRecordVersion"),
                    payload.TryGetProperty("value", out var scalar) ? scalar.Clone() : default,
                    payload.TryGetProperty("expectedTargetRecordVersion", out var target) && target.ValueKind == JsonValueKind.Number
                        ? target.GetInt64()
                        : null),
                "data.createRecord" => new CreateRecordOperation(
                    operationId,
                    Text(payload, "entityId"),
                    Text(payload, "recordId"),
                    Values(payload),
                    TargetVersions(payload)),
                "data.deleteRecord" => new DeleteRecordOperation(
                    operationId,
                    Text(payload, "entityId"),
                    Text(payload, "recordId"),
                    Number(payload, "expectedRecordVersion")),
                _ => throw new NendoValidationException(
                    "A reviewed plan names an operation an automatic action is not allowed to make."),
            };
        }
    }

    private static IReadOnlyDictionary<string, object?> Values(JsonElement payload)
    {
        // Carried as JsonElement, which is what the operation stores a scalar as.
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (!payload.TryGetProperty("values", out var element) || element.ValueKind != JsonValueKind.Object) throw Damaged();
        foreach (var property in element.EnumerateObject()) values[property.Name] = property.Value.Clone();
        return values;
    }

    private static IReadOnlyDictionary<string, long>? TargetVersions(JsonElement payload)
    {
        if (!payload.TryGetProperty("expectedTargetVersions", out var element) || element.ValueKind != JsonValueKind.Object)
            return null;
        var versions = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.Number) throw Damaged();
            versions[property.Name] = property.Value.GetInt64();
        }
        return versions.Count == 0 ? null : versions;
    }

    private static string Text(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw Damaged();

    private static long Number(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64()
            : throw Damaged();

    private static NendoValidationException Damaged() => new(
        "The reviewed plan for this proposal could not be read. Prepare a new proposal and review it again.");
}
