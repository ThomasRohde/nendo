namespace Nendo.Engine;

public sealed partial class NendoSemanticCompiler
{
    private static void ValidateExtensionView(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes,
        NendoSessionSnapshot source, ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var children = nodes
            .Where(value => value.ParentNodeId == node.NodeId && value.SurfaceId == node.SurfaceId)
            .OrderBy(value => value.Position).ThenBy(value => value.NodeId, StringComparer.Ordinal)
            .ToArray();
        try
        {
            var definition = NendoExtensionViewDefinition.ReadNode(node, nodes);
            // Only one runs at a time, but each is a review and a placeholder on the page.
            if (definition.IsRecordPanel && NendoExtensionViewDefinition.PageOf(node, nodes) is { } page &&
                nodes.Count(n => n.SurfaceId == page.SurfaceId && n.Kind == NendoExtensionViewDefinition.PanelKind) > NendoExtensionViewDefinition.MaximumPanelsPerPage)
                throw new NendoPreconditionException("extension-binding-invalid",
                    $"A record page carries at most {NendoExtensionViewDefinition.MaximumPanelsPerPage} custom views.");
            var b = definition.Binding;
            var nodeType = source.Entities.SingleOrDefault(e => e.EntityId == b.NodeEntityId && !e.Retired);
            var label = nodeType?.Fields.SingleOrDefault(f => f.FieldId == b.LabelFieldId && !f.Retired);
            var status = nodeType?.Fields.SingleOrDefault(f => f.FieldId == b.StatusFieldId && !f.Retired);
            if (label?.StorageKind != NendoStorageKind.Text ||
                b.StatusFieldId is not null && (status is null || status.StorageKind == NendoStorageKind.Reference || status.UnsupportedStorageKind is not null))
                throw new NendoPreconditionException("extension-binding-invalid",
                    "A custom view needs an active stored Text label on its record type; optional status must be a stored scalar.");
            NendoEntitySnapshot? edgeType = null;
            if (b.EdgeEntityId is not null)
            {
                edgeType = source.Entities.SingleOrDefault(e => e.EntityId == b.EdgeEntityId && !e.Retired);
                var from = edgeType?.Fields.SingleOrDefault(f => f.FieldId == b.SourceFieldId && !f.Retired);
                var to = edgeType?.Fields.SingleOrDefault(f => f.FieldId == b.TargetFieldId && !f.Retired);
                if (from?.StorageKind != NendoStorageKind.Reference || to?.StorageKind != NendoStorageKind.Reference ||
                    from.Reference?.TargetEntityId != b.NodeEntityId || to.Reference?.TargetEntityId != b.NodeEntityId)
                    throw new NendoPreconditionException("extension-binding-invalid",
                        "The graph needs two distinct active Reference fields on its edge type, both targeting its node type.");
            }
            ValidateDisclosure(b, nodeType!, edgeType);
            ValidateFilters(b, children, nodeType!, edgeType, diagnostics);
            if (!definition.IsSupported)
                diagnostics.Add(new("NUI451", NendoDiagnosticSeverity.Warning,
                    "This view's protocol or configuration version is preserved but cannot execute on this host.",
                    node.NodeId, "configurationVersion", "Use protocol 1 or 2 and configuration version 1, or a host that supports the declared versions. Studio remains available."));
        }
        catch (NendoPreconditionException error)
        {
            AddError(diagnostics, "NUI450", error.Message, node.NodeId, null,
                "Declare the exact package pin and valid graph bindings; installing a definition does not install a package or grant permission.");
        }
    }

    /// <summary>Which of the two record types a projected field belongs to; field IDs are unique across the file.</summary>
    internal static NendoFieldSnapshot? ProjectedField(NendoEntitySnapshot nodes, NendoEntitySnapshot? edges, string fieldId) =>
        nodes.Fields.SingleOrDefault(f => f.FieldId == fieldId && !f.Retired)
        ?? edges?.Fields.SingleOrDefault(f => f.FieldId == fieldId && !f.Retired);

    private static string Types(NendoEntitySnapshot nodes, NendoEntitySnapshot? edges) =>
        edges is null ? nodes.DisplayName : $"{nodes.DisplayName} or {edges.DisplayName}";

    /// <summary>
    /// A disclosed field is one more stored field of either record type. A Reference is
    /// disclosed as the label of the record it points at, the way every screen shows it --
    /// never as the ID -- so it needs a configured label. A field the view already binds is
    /// refused rather than sent twice under two names.
    /// </summary>
    private static void ValidateDisclosure(NendoGraphBinding binding, NendoEntitySnapshot nodes, NendoEntitySnapshot? edges)
    {
        if (binding.FieldIds is not { } fieldIds) return;
        var bound = new[] { binding.LabelFieldId, binding.SourceFieldId, binding.TargetFieldId, binding.StatusFieldId }.OfType<string>().ToArray();
        var perType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var fieldId in fieldIds)
        {
            var field = ProjectedField(nodes, edges, fieldId)
                ?? throw Refused($"The disclosed field '{fieldId}' is not an active stored field of {Types(nodes, edges)}. A calculated field is not disclosed.");
            if (bound.Contains(fieldId, StringComparer.Ordinal))
                throw Refused($"The field '{field.DisplayName}' is already bound by the view; disclose it once.");
            if (field.StorageKind == NendoStorageKind.Unsupported || field.UnsupportedStorageKind is not null ||
                field.StorageKind == NendoStorageKind.Reference && field.Reference is null)
                throw Refused($"The field '{field.DisplayName}' cannot be disclosed: a view receives Text, Integer, Decimal, Boolean or Date values, or the label of the record a configured reference points at.");
            var type = nodes.Fields.Any(f => f.FieldId == fieldId) ? nodes.EntityId : edges!.EntityId;
            if ((perType[type] = perType.GetValueOrDefault(type) + 1) > NendoExtensionViewDefinition.MaximumDisclosedFieldsPerType)
                throw Refused($"A custom view discloses at most {NendoExtensionViewDefinition.MaximumDisclosedFieldsPerType} fields of each record type.");
        }
    }

    private static void ValidateFilters(NendoGraphBinding binding, IReadOnlyList<NendoUiNodeSnapshot> children,
        NendoEntitySnapshot nodes, NendoEntitySnapshot? edges, ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (binding.Filters is null) return;
        foreach (var clause in children.Where(child => child.Kind == "filterClause"))
        {
            var fieldId = clause.Properties["fieldId"].GetString()!;
            var comparison = clause.Properties["operator"].GetString()!;
            var field = ProjectedField(nodes, edges, fieldId)
                ?? throw Refused($"The filter field '{fieldId}' is not an active stored field of {Types(nodes, edges)}.");
            if (field.StorageKind == NendoStorageKind.Unsupported || field.UnsupportedStorageKind is not null)
                throw Refused($"The filter field '{field.DisplayName}' has a type this host cannot compare.");
            if (!NendoSemanticVocabulary.FilterOperators.Contains(comparison))
                throw Refused($"Filter operator '{comparison}' is not supported. Use one of: {string.Join(", ", NendoSemanticVocabulary.FilterOperators.Order(StringComparer.Ordinal))}.");
            // The literal is checked the way every other surface's filter is, with its own codes.
            if (clause.Properties.TryGetValue("value", out var value)) ValidateLiteral(clause, field, value, diagnostics);
        }
    }

    private static NendoPreconditionException Refused(string message) => new("extension-binding-invalid", message);
}
