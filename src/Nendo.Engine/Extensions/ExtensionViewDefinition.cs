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
    /// <summary>
    /// One record type as typed columns (ADR-0013, 2026-09-24 record-set amendment): no edge
    /// type, protocol 2 only, and the page receives records rather than nodes and links.
    /// </summary>
    public const string RecordsKind = "extensionRecordsSurface";
    public const int MaximumRecords = 1000;
    /// <summary>Whether a node is a custom view of either shape.</summary>
    public static bool IsViewKind(string? kind) => kind is NodeKind or RecordsKind;
    /// <summary>Which shape this view is; a graph unless it was read as a record set.</summary>
    public string Kind { get; init; } = NodeKind;
    public bool IsRecordSet => Kind == RecordsKind;
    /// <summary>Protocol 2 (ADR-0013, 2026-09-24): disclosed fields and authored filters as child nodes.</summary>
    public const int FieldsProtocolVersion = 2;
    public const int MaximumDisclosedFieldsPerType = 8;
    public const int MaximumFilters = 8;
    public bool IsSupported => ProtocolVersion is 1 or FieldsProtocolVersion && ConfigurationVersion == 1;

    public string ComputeBindingDigest() => Convert.ToHexString(SHA256.HashData(
        JsonSerializer.SerializeToUtf8Bytes(new { Binding, ProtocolVersion, ConfigurationVersion, Configuration }))).ToLowerInvariant();

    public static NendoExtensionViewDefinition Read(string viewId, IReadOnlyDictionary<string, JsonElement> properties) =>
        Read(viewId, properties, []);

    /// <summary>
    /// <paramref name="children"/> are the root's direct children in authored order. A
    /// protocol-1 view has none. A protocol-2 view may carry fieldBinding and filterClause
    /// children only; which record type each belongs to is the compiler's and the
    /// projection's to resolve, because this reader does not see the schema. A future
    /// protocol's children are preserved in the file and not interpreted here.
    /// </summary>
    public static NendoExtensionViewDefinition Read(string viewId, IReadOnlyDictionary<string, JsonElement> properties,
        IReadOnlyList<NendoUiNodeSnapshot> children, string kind = NodeKind)
    {
        if (!IsViewKind(kind)) throw Invalid($"'{kind}' is not a custom view.");
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
        // A record set has one record type and no links, so it names no edge type and no
        // endpoints; the binding's edge members stay null, which also keeps its digest apart
        // from any graph's.
        var records = kind == RecordsKind;
        if (records && (properties.ContainsKey("edgeEntityId") || properties.ContainsKey("sourceFieldId") || properties.ContainsKey("targetFieldId")))
            throw Invalid("A record-set view has no edge type: remove edgeEntityId, sourceFieldId and targetFieldId.");
        if (records && protocol != FieldsProtocolVersion && protocol <= FieldsProtocolVersion)
            throw Invalid("A record-set view speaks protocol 2: its columns are disclosed fields.");
        var binding = new NendoGraphBinding(Text("entityId"), Text("labelFieldId"), records ? null : Text("edgeEntityId"),
            records ? null : Text("sourceFieldId"), records ? null : Text("targetFieldId"), properties.ContainsKey("statusFieldId") ? Text("statusFieldId") : null);
        if (!records && binding.SourceFieldId == binding.TargetFieldId) throw Invalid("The two edge reference fields must differ.");
        if (protocol == 1 && children.Count > 0)
            throw Invalid("A protocol-1 view has no children. Declare protocolVersion 2 to disclose more fields or to filter.");
        if (protocol == FieldsProtocolVersion) binding = ReadChildren(binding, children);
        return new(viewId, Text("title"), package, version, digest, protocol, configurationVersion, config, binding) { Kind = kind };
    }

    private static NendoGraphBinding ReadChildren(NendoGraphBinding binding, IReadOnlyList<NendoUiNodeSnapshot> children)
    {
        var fields = new List<string>();
        var filters = new List<NendoGraphFilter>();
        foreach (var child in children)
        {
            string Property(string key)
            {
                if (!child.Properties.TryGetValue(key, out var value) || value.ValueKind != JsonValueKind.String ||
                    value.GetString() is not { Length: > 0 and <= 256 } text || string.IsNullOrWhiteSpace(text))
                    throw Invalid($"The {child.Kind} '{child.NodeId}' needs {key} as nonempty text of at most 256 characters.");
                return text;
            }
            if (child.Kind == "fieldBinding")
            {
                var fieldId = Property("fieldId");
                if (fields.Contains(fieldId, StringComparer.Ordinal)) throw Invalid($"The field '{fieldId}' is disclosed twice.");
                fields.Add(fieldId);
            }
            else if (child.Kind == "filterClause")
            {
                var fieldId = Property("fieldId");
                var comparison = Property("operator");
                if (child.Properties.TryGetValue("valueKind", out var kind) &&
                    (kind.ValueKind != JsonValueKind.String || kind.GetString() != "literal"))
                    throw Invalid("A custom view filters on a literal value or on presence; today and now would change what it shows without any definition change.");
                var presence = comparison is "isNull" or "isNotNull";
                var hasValue = child.Properties.TryGetValue("value", out var value);
                if (presence == hasValue)
                    throw Invalid(presence ? $"'{comparison}' does not take a value." : "The filter has no value to compare.");
                filters.Add(new(fieldId, comparison, hasValue ? value.GetRawText() : null));
            }
            else throw Invalid($"A custom view's children are fieldBinding and filterClause; '{child.Kind}' is not one of them.");
        }
        if (fields.Count > MaximumDisclosedFieldsPerType * 2) throw Invalid("A custom view discloses at most eight fields of each record type.");
        if (filters.Count > MaximumFilters) throw Invalid("A custom view has at most eight filters.");
        return binding with { FieldIds = fields, Filters = filters };
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
