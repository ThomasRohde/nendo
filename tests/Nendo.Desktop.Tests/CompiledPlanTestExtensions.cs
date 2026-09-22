using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Reads the compiled surface tree the way the removed version 1 and 2 slots used
/// to be read, so an assertion names a surface rather than walking the tree.
/// </summary>
internal static class CompiledPlanTestExtensions
{
    internal static NendoApplicationPlan App(this NendoCompileResult result) => result.Applications.Single();

    internal static NendoSurfaceNodePlan Root(this NendoCompileResult result, string kind) =>
        result.App().Surfaces.Single(node => node.Kind == kind);

    internal static NendoSurfaceNodePlan Root(this NendoProposalPreview preview, string kind) =>
        preview.PreviewApplications.Single().Surfaces.Single(node => node.Kind == kind);

    internal static string? Title(this NendoSurfaceNodePlan node) =>
        node.Properties.TryGetValue("title", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
