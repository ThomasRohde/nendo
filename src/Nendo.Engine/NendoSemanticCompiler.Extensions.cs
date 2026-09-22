namespace Nendo.Engine;

public sealed partial class NendoSemanticCompiler
{
    private static void ValidateExtensionView(NendoUiNodeSnapshot node, NendoSessionSnapshot source,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        try
        {
            var definition = NendoExtensionViewDefinition.Read(node.NodeId, node.Properties);
            var b = definition.Binding;
            var nodes = source.Entities.SingleOrDefault(e => e.EntityId == b.NodeEntityId && !e.Retired);
            var edges = source.Entities.SingleOrDefault(e => e.EntityId == b.EdgeEntityId && !e.Retired);
            var label = nodes?.Fields.SingleOrDefault(f => f.FieldId == b.LabelFieldId && !f.Retired);
            var from = edges?.Fields.SingleOrDefault(f => f.FieldId == b.SourceFieldId && !f.Retired);
            var to = edges?.Fields.SingleOrDefault(f => f.FieldId == b.TargetFieldId && !f.Retired);
            var status = nodes?.Fields.SingleOrDefault(f => f.FieldId == b.StatusFieldId && !f.Retired);
            if (label?.StorageKind != NendoStorageKind.Text || from?.StorageKind != NendoStorageKind.Reference ||
                to?.StorageKind != NendoStorageKind.Reference || from.Reference?.TargetEntityId != b.NodeEntityId ||
                to.Reference?.TargetEntityId != b.NodeEntityId ||
                b.StatusFieldId is not null && (status is null || status.StorageKind == NendoStorageKind.Reference || status.UnsupportedStorageKind is not null))
                throw new NendoPreconditionException("extension-binding-invalid",
                    "The graph needs an active stored Text label and two distinct active Reference fields targeting its node type; optional status must be a stored scalar.");
            if (!definition.IsSupported)
                diagnostics.Add(new("NUI451", NendoDiagnosticSeverity.Warning,
                    "This view's protocol or configuration version is preserved but cannot execute on this host.",
                    node.NodeId, "configurationVersion", "Use protocol 1 and configuration version 1, or a host that supports the declared versions. Studio remains available."));
        }
        catch (NendoPreconditionException error)
        {
            AddError(diagnostics, "NUI450", error.Message, node.NodeId, null,
                "Declare the exact package pin and valid graph bindings; installing a definition does not install a package or grant permission.");
        }
    }
}
