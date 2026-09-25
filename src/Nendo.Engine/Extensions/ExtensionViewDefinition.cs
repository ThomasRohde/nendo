using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// A custom view as the file declares it (ADR-0013): which package draws it, what it is
/// about, and the configuration its code reads. The code itself is a package in the file;
/// nothing here grants or pins anything.
/// </summary>
public sealed record NendoExtensionViewDefinition(string ViewId, string Title, string PackageId,
    string Configuration, NendoGraphBinding Binding)
{
    public const string NodeKind = "extensionGraphSurface";
    /// <summary>One record type as typed columns: no edge type, and the page reads records rather than nodes and links.</summary>
    public const string RecordsKind = "extensionRecordsSurface";
    /// <summary>A view on a record page, scoped to that page's one record; its record type is the page's.</summary>
    public const string PanelKind = "extensionRecordPanel";
    /// <summary>Whether a node is a custom view of any shape or placement.</summary>
    public static bool IsViewKind(string? kind) => kind is NodeKind or RecordsKind or PanelKind;
    /// <summary>Whether a node is a custom view with a screen of its own, rather than a place on a record page.</summary>
    public static bool IsRootViewKind(string? kind) => kind is NodeKind or RecordsKind;
    /// <summary>Which shape this view is; a graph unless it was read as a record set or a record panel.</summary>
    public string Kind { get; init; } = NodeKind;
    public bool IsRecordSet => Kind == RecordsKind;
    public bool IsRecordPanel => Kind == PanelKind;

    /// <summary>The most UTF-8 bytes a view's configuration may hold. A bound, not an optimum: room for a view's settings, not its data.</summary>
    public const int MaximumConfigurationBytes = 16 * 1024;
    /// <summary>The most fieldBinding and filterClause children one view carries together.</summary>
    public const int MaximumChildren = 64;

    public static NendoExtensionViewDefinition Read(string viewId, IReadOnlyDictionary<string, JsonElement> properties) =>
        Read(viewId, properties, []);

    /// <summary>
    /// <paramref name="children"/> are the view's direct children in authored order:
    /// fieldBinding children name the fields it shows, filterClause children narrow what it
    /// reads. Which record type each belongs to is the compiler's to resolve, because this
    /// reader does not see the schema. The package pin, protocol and configuration version
    /// that earlier hosts required are kept in the file when present and read by nothing.
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
        var package = Text("packageId", NendoExtensionLimits.PackageIdCharacters);
        if (!NendoExtensionContent.ValidPackageId(package))
            throw Invalid("packageId must name a package in lowercase dotted segments, such as org.example.map.");
        var configuration = "{}";
        if (properties.ContainsKey("configuration"))
        {
            configuration = Text("configuration", MaximumConfigurationBytes);
            if (System.Text.Encoding.UTF8.GetByteCount(configuration) > MaximumConfigurationBytes)
                throw Invalid($"configuration holds at most {MaximumConfigurationBytes} UTF-8 bytes.");
            try
            {
                using var parsed = JsonDocument.Parse(configuration, new JsonDocumentOptions { MaxDepth = 32 });
                if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                    throw Invalid("configuration must be JSON text containing an object.");
            }
            catch (JsonException) { throw Invalid("configuration must be valid JSON text, at most 32 levels deep."); }
        }
        // A record set has one record type and no links, so it names no edge type and no
        // endpoints. A record panel is the same with one record, and its record type is the
        // page's: the reader takes it from the page and passes it in as entityId.
        var records = kind is RecordsKind or PanelKind;
        if (records && (properties.ContainsKey("edgeEntityId") || properties.ContainsKey("sourceFieldId") || properties.ContainsKey("targetFieldId")))
            throw Invalid("A record-set view has no edge type: remove edgeEntityId, sourceFieldId and targetFieldId.");
        if (kind == PanelKind && children.Any(child => child.Kind == "filterClause"))
            throw Invalid("A view on a record page shows that one record, so it has no filters.");
        var binding = new NendoGraphBinding(Text("entityId"), Text("labelFieldId"), records ? null : Text("edgeEntityId"),
            records ? null : Text("sourceFieldId"), records ? null : Text("targetFieldId"), properties.ContainsKey("statusFieldId") ? Text("statusFieldId") : null);
        if (!records && binding.SourceFieldId == binding.TargetFieldId) throw Invalid("The two edge reference fields must differ.");
        binding = ReadChildren(binding, children);
        return new(viewId, Text("title"), package, configuration, binding) { Kind = kind };
    }

    /// <summary>
    /// Reads a view node where it stands in the file: its direct children in authored order
    /// and, for a record panel, the record type of the page it is on. A panel names no
    /// record type of its own, because a page that disagreed with it would have two answers.
    /// </summary>
    public static NendoExtensionViewDefinition ReadNode(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes)
    {
        var children = nodes.Where(n => n.ParentNodeId == node.NodeId && n.SurfaceId == node.SurfaceId)
            .OrderBy(n => n.Position).ThenBy(n => n.NodeId, StringComparer.Ordinal).ToArray();
        if (node.Kind != PanelKind) return Read(node.NodeId, node.Properties, children, node.Kind);
        if (node.Properties.ContainsKey("entityId"))
            throw Invalid("A view on a record page takes its record type from the page; remove entityId.");
        var page = PageOf(node, nodes) ?? throw Invalid("A view on a record page belongs inside a record page or a record form.");
        if (!page.Properties.TryGetValue("entityId", out var entity))
            throw Invalid("The record page this view is on names no record type.");
        var properties = new Dictionary<string, JsonElement>(node.Properties, StringComparer.Ordinal) { ["entityId"] = entity };
        return Read(node.NodeId, properties, children, node.Kind);
    }

    /// <summary>The record page or record form a node sits in, through any sections and tabs; null elsewhere.</summary>
    public static NendoUiNodeSnapshot? PageOf(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes)
    {
        var current = node;
        for (var depth = 0; current.ParentNodeId is { } parentId && depth < 64; depth++)
        {
            current = nodes.SingleOrDefault(n => n.NodeId == parentId && n.SurfaceId == node.SurfaceId);
            if (current is null) return null;
            if (current.ParentNodeId is null) return current.Kind is "detailSurface" or "recordForm" ? current : null;
            if (current.Kind is not ("section" or "tabGroup")) return null;
        }
        return null;
    }

    private static NendoGraphBinding ReadChildren(NendoGraphBinding binding, IReadOnlyList<NendoUiNodeSnapshot> children)
    {
        if (children.Count > MaximumChildren)
            throw Invalid($"A custom view carries at most {MaximumChildren} fieldBinding and filterClause children together.");
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
                if (fields.Contains(fieldId, StringComparer.Ordinal)) throw Invalid($"The field '{fieldId}' is shown twice.");
                fields.Add(fieldId);
            }
            else if (child.Kind == "filterClause")
            {
                var fieldId = Property("fieldId");
                var comparison = Property("operator");
                var valueKind = child.Properties.TryGetValue("valueKind", out var declared) && declared.ValueKind == JsonValueKind.String
                    ? declared.GetString()! : "literal";
                var presence = comparison is "isNull" or "isNotNull";
                var hasValue = child.Properties.TryGetValue("value", out var value);
                if (presence && hasValue) throw Invalid($"'{comparison}' does not take a value.");
                if (!presence && valueKind == "literal" && !hasValue) throw Invalid("The filter has no value to compare.");
                filters.Add(new(fieldId, comparison, hasValue ? value.GetRawText() : null) { ValueKind = valueKind });
            }
            else throw Invalid($"A custom view's children are fieldBinding and filterClause; '{child.Kind}' is not one of them.");
        }
        return binding with { FieldIds = fields, Filters = filters };
    }

    private static NendoPreconditionException Invalid(string message) => new("extension-definition-invalid", message);
}
