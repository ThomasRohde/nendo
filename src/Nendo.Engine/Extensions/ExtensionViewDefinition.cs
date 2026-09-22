using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Engine;

/// <summary>A durable, host-understood reference. It contains neither code nor consent.</summary>
public sealed record NendoExtensionViewDefinition(string ViewId, string Title, string PackageId,
    string PackageVersion, string PackageDigest, int ProtocolVersion, int ConfigurationVersion,
    string Configuration, NendoGraphBinding Binding)
{
    public const string NodeKind = "extensionGraphSurface";
    public bool IsSupported => ProtocolVersion == 1 && ConfigurationVersion == 1;

    public string ComputeBindingDigest() => Convert.ToHexString(SHA256.HashData(
        JsonSerializer.SerializeToUtf8Bytes(new { Binding, ProtocolVersion, ConfigurationVersion, Configuration }))).ToLowerInvariant();

    public static NendoExtensionViewDefinition Read(string viewId, IReadOnlyDictionary<string, JsonElement> properties)
    {
        string Text(string key, int maximum = 256)
        {
            if (!properties.TryGetValue(key, out var value) || value.ValueKind != JsonValueKind.String ||
                value.GetString() is not { Length: > 0 } text || text.Length > maximum || string.IsNullOrWhiteSpace(text))
                throw Invalid($"{key} must be nonempty text of at most {maximum} characters.");
            return text;
        }
        int Number(string key)
        {
            if (!properties.TryGetValue(key, out var value) || value.ValueKind != JsonValueKind.Number ||
                !value.TryGetInt32(out var number) || number < 1) throw Invalid($"{key} must be a positive integer.");
            return number;
        }
        var package = Text("packageId", 200);
        var version = Text("packageVersion", 64);
        var digest = Text("packageDigest", 64);
        if (!ValidPackageId(package)) throw Invalid("packageId must be a lowercase namespaced package identifier.");
        if (!ValidVersion(version)) throw Invalid("packageVersion must be an exact semantic version.");
        if (digest.Length != 64 || digest.Any(c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw Invalid("packageDigest must be a lowercase SHA-256 digest.");
        var protocol = Number("protocolVersion");
        var configurationVersion = Number("configurationVersion");
        var config = Text("configuration", 8192);
        if (System.Text.Encoding.UTF8.GetByteCount(config) > 8192)
            throw Invalid("configuration must contain at most 8192 UTF-8 bytes.");
        try
        {
            using var parsed = JsonDocument.Parse(config, new JsonDocumentOptions { MaxDepth = 8 });
            if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                throw Invalid("configuration must be JSON text containing an object.");
            // Future bounded configuration is retained verbatim, never interpreted by this host.
            if (configurationVersion == 1 && parsed.RootElement.EnumerateObject().Any())
                throw Invalid("Configuration version 1 is an empty object; graph bindings are declared separately.");
        }
        catch (JsonException) { throw Invalid("configuration must be valid JSON text with maximum depth 8."); }
        var binding = new NendoGraphBinding(Text("entityId"), Text("labelFieldId"), Text("edgeEntityId"),
            Text("sourceFieldId"), Text("targetFieldId"), properties.ContainsKey("statusFieldId") ? Text("statusFieldId") : null);
        if (binding.SourceFieldId == binding.TargetFieldId) throw Invalid("The two edge reference fields must differ.");
        return new(viewId, Text("title"), package, version, digest, protocol, configurationVersion, config, binding);
    }

    internal static bool ValidPackageId(string value) => value.Length is > 0 and <= 200 && value.Split('.').Length >= 2 &&
        value.Split('.').All(s => s.Length > 0 && s[0] is >= 'a' and <= 'z' && s.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'));

    internal static bool ValidVersion(string value)
    {
        if (value.Length > 64 || !Regex.IsMatch(value, @"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z", RegexOptions.CultureInvariant)) return false;
        var release = value.Split('+')[0];
        var dash = release.IndexOf('-');
        return dash < 0 || release[(dash + 1)..].Split('.').All(s => s.Length == 1 || s[0] != '0' || !s.All(char.IsAsciiDigit));
    }

    private static NendoPreconditionException Invalid(string message) => new("extension-definition-invalid", message);
}

public sealed record NendoExtensionViewSnapshot(string ApplicationId, string InstanceId,
    NendoExtensionViewDefinition Definition, NendoGraphProjection Projection);
