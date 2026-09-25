namespace Nendo.Engine;

public sealed partial class NendoSemanticCompiler
{
    /// <summary>
    /// A custom view compiles when it names its package and a record type that exists, a
    /// label and fields that exist on it — stored or calculated — and filters the file's own
    /// queries can apply. Whether the package is in the file is a warning, not an error: the
    /// definition is sound and waits for its code, and the view says so where it is shown.
    /// </summary>
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
            var b = definition.Binding;
            var nodeType = source.Entities.SingleOrDefault(e => e.EntityId == b.NodeEntityId && !e.Retired)
                ?? throw Refused($"The record type '{b.NodeEntityId}' does not exist or is retired.");
            if (!IsShowable(nodeType, b.LabelFieldId))
                throw Refused($"The label field '{b.LabelFieldId}' is not an active field of {nodeType.DisplayName}.");
            if (b.StatusFieldId is not null && !IsShowable(nodeType, b.StatusFieldId))
                throw Refused($"The status field '{b.StatusFieldId}' is not an active field of {nodeType.DisplayName}.");
            NendoEntitySnapshot? edgeType = null;
            if (b.EdgeEntityId is not null)
            {
                edgeType = source.Entities.SingleOrDefault(e => e.EntityId == b.EdgeEntityId && !e.Retired);
                var from = edgeType?.Fields.SingleOrDefault(f => f.FieldId == b.SourceFieldId && !f.Retired);
                var to = edgeType?.Fields.SingleOrDefault(f => f.FieldId == b.TargetFieldId && !f.Retired);
                if (from?.StorageKind != NendoStorageKind.Reference || to?.StorageKind != NendoStorageKind.Reference ||
                    from.Reference?.TargetEntityId != b.NodeEntityId || to.Reference?.TargetEntityId != b.NodeEntityId)
                    throw Refused("The graph needs two distinct active Reference fields on its edge type, both targeting its node type.");
            }
            foreach (var fieldId in b.FieldIds)
            {
                if (!IsShowable(nodeType, fieldId) && (edgeType is null || !IsShowable(edgeType, fieldId)))
                    throw Refused($"The field '{fieldId}' is not an active field of {Types(nodeType, edgeType)}.");
            }
            ValidateFilters(children, nodeType, edgeType, diagnostics);
            if (!source.ExtensionPackages.Any(package => package.PackageId == definition.PackageId))
                diagnostics.Add(new("NUI452", NendoDiagnosticSeverity.Warning,
                    $"The package {definition.PackageId} is not in this file, so the view has no code to run yet.",
                    node.NodeId, "packageId", "Add the package to the file: Studio → Surfaces → Custom views → Import, or extension.setPackage and extension.putFile in a change set."));
        }
        catch (NendoPreconditionException error)
        {
            AddError(diagnostics, "NUI450", error.Message, node.NodeId, null,
                "Name a package, a record type and fields that exist; the view's code reads the rest through the file's API.");
        }
    }

    /// <summary>A field a view may show: an active stored field of a type the host reads, or a calculated field.</summary>
    private static bool IsShowable(NendoEntitySnapshot entity, string fieldId) =>
        entity.Fields.Any(f => f.FieldId == fieldId && !f.Retired && f.StorageKind != NendoStorageKind.Unsupported && f.UnsupportedStorageKind is null) ||
        entity.DerivedFields.Any(f => f.FieldId == fieldId);

    private static string Types(NendoEntitySnapshot nodes, NendoEntitySnapshot? edges) =>
        edges is null ? nodes.DisplayName : $"{nodes.DisplayName} or {edges.DisplayName}";

    /// <summary>
    /// A view's filters feed the same record query every screen uses, so they follow the same
    /// rules: a stored field of the view's record types, an operator and a value kind from the
    /// vocabulary, and a literal of the field's kind. A calculated field is shown, not filtered.
    /// </summary>
    private static void ValidateFilters(IReadOnlyList<NendoUiNodeSnapshot> children,
        NendoEntitySnapshot nodes, NendoEntitySnapshot? edges, ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        foreach (var clause in children.Where(child => child.Kind == "filterClause"))
        {
            var fieldId = clause.Properties["fieldId"].GetString()!;
            var comparison = clause.Properties["operator"].GetString()!;
            var field = nodes.Fields.SingleOrDefault(f => f.FieldId == fieldId && !f.Retired)
                ?? edges?.Fields.SingleOrDefault(f => f.FieldId == fieldId && !f.Retired)
                ?? throw Refused($"The filter field '{fieldId}' is not an active stored field of {Types(nodes, edges)}; a calculated field is shown, not filtered.");
            if (field.StorageKind == NendoStorageKind.Unsupported || field.UnsupportedStorageKind is not null)
                throw Refused($"The filter field '{field.DisplayName}' has a type this host cannot compare.");
            if (!NendoSemanticVocabulary.FilterOperators.Contains(comparison))
                throw Refused($"Filter operator '{comparison}' is not supported. Use one of: {string.Join(", ", NendoSemanticVocabulary.FilterOperators.Order(StringComparer.Ordinal))}.");
            if (clause.Properties.TryGetValue("valueKind", out var kind) &&
                (kind.ValueKind != System.Text.Json.JsonValueKind.String || !NendoSemanticVocabulary.ValueKinds.Contains(kind.GetString()!)))
                throw Refused($"Value kind '{kind}' is not supported. Use one of: {string.Join(", ", NendoSemanticVocabulary.ValueKinds.Order(StringComparer.Ordinal))}.");
            var literal = !clause.Properties.TryGetValue("valueKind", out var declared) || declared.GetString() == "literal";
            if (literal && clause.Properties.TryGetValue("value", out var value)) ValidateLiteral(clause, field, value, diagnostics);
        }
    }

    private static NendoPreconditionException Refused(string message) => new("extension-binding-invalid", message);
}
