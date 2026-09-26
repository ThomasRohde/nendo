using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Keeps one small JSON value for a custom view, with the file (ADR-0013 Phase 3,
/// <c>nendo.state</c>). A null value removes the key. Data, not definition: it changes no
/// record and no screen, and it is reversed by setting the value it replaced.
/// </summary>
public sealed record SetExtensionStateOperation : NendoOperation
{
    /// <summary>The version that means the key must not exist yet.</summary>
    public const long ExpectAbsent = 0;

    public SetExtensionStateOperation(
        string operationId, string packageId, string viewId, string key, string? valueJson, long? expectedVersion = null)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException($"Package ID '{packageId}' is not valid.");
        ArgumentNullException.ThrowIfNull(viewId);
        if (viewId.Length > NendoExtensionLimits.StateViewIdCharacters)
            throw new NendoValidationException($"A view ID is at most {NendoExtensionLimits.StateViewIdCharacters} characters.");
        ViewId = viewId;
        if (string.IsNullOrEmpty(key) || key.Length > NendoExtensionLimits.StateKeyCharacters || key.Any(char.IsControl))
            throw new NendoValidationException($"A state key is 1 to {NendoExtensionLimits.StateKeyCharacters} characters, with no control characters.");
        Key = key;
        if (valueJson is not null)
        {
            if (System.Text.Encoding.UTF8.GetByteCount(valueJson) > NendoExtensionLimits.StateValueBytes)
                throw new NendoValidationException($"A state value is at most {NendoExtensionLimits.StateValueBytes / 1024} KiB of JSON.");
            try
            {
                using var document = JsonDocument.Parse(valueJson);
                // Stored as the writer spells it, without whitespace: one spelling for one value.
                using var stream = new MemoryStream();
                using (var compact = new Utf8JsonWriter(stream)) document.RootElement.WriteTo(compact);
                valueJson = document.RootElement.ValueKind == JsonValueKind.Null ? null : System.Text.Encoding.UTF8.GetString(stream.ToArray());
            }
            catch (JsonException)
            {
                throw new NendoValidationException("A state value must be JSON.");
            }
        }
        ValueJson = valueJson;
        if (expectedVersion is < ExpectAbsent)
            throw new NendoValidationException("An expected state version is 0, for a key that must not exist yet, or the key's version.");
        ExpectedVersion = expectedVersion;
    }

    public string PackageId { get; }

    /// <summary>The view definition's node ID, or the empty string for state the package's views share.</summary>
    public string ViewId { get; }

    public string Key { get; }

    /// <summary>The value as JSON, or null to remove the key.</summary>
    public string? ValueJson { get; }

    /// <summary>When set, the write applies only while the key is at this version (0: absent).</summary>
    public long? ExpectedVersion { get; }

    public override string OperationType => "extension.setState";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.Reversible;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        if (ExpectedVersion is { } expected) writer.WriteNumber("expectedVersion", expected);
        writer.WriteString("key", Key);
        writer.WriteString("packageId", PackageId);
        writer.WritePropertyName("value");
        if (ValueJson is null) writer.WriteNullValue();
        else writer.WriteRawValue(ValueJson, skipInputValidation: true);
        writer.WriteString("viewId", ViewId);
        writer.WriteEndObject();
    }
}

/// <summary>One kept value of a custom view: its key, its JSON and its version.</summary>
public sealed record NendoExtensionStateEntry(string ViewId, string Key, string ValueJson, long Version);
