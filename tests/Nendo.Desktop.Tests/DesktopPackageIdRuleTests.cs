using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// WXS-12. The host admitted a view's write only for a package ID matching a stricter pattern
/// than the Engine's, so a package the file carries under an ID such as <c>org.view-</c> ran its
/// views, and every write, state change and proposal they made was refused as
/// actor-not-allowed. One table holds the Engine's rule, the host's actor check and Studio's
/// Add view form (custom-view-recipe.test.mjs) to the same answers. Pure functions: no session,
/// no window.
/// </summary>
[TestClass]
public sealed class DesktopPackageIdRuleTests
{
    [TestMethod]
    public void TheHostAdmitsAViewActorForExactlyThePackageIdsTheEngineTakes()
    {
        var table = Path.Combine(TestRepository.Root(), "src", "Nendo.Workbench", "scripts", "package-ids.json");
        using var document = JsonDocument.Parse(File.ReadAllText(table));
        var disagreements = new List<string>();
        var rows = 0;
        foreach (var row in document.RootElement.GetProperty("ids").EnumerateArray())
        {
            rows++;
            var id = row.GetProperty("id").GetString()!;
            var valid = row.GetProperty("valid").GetBoolean();
            if (NendoExtensionContent.ValidPackageId(id) != valid) disagreements.Add($"Engine on '{id}'");
            var admitted = WorkbenchProtocolHandler.ExtensionActorPackage("extension:" + id);
            if ((admitted is not null) != valid || (admitted is not null && admitted != id)) disagreements.Add($"host actor check on '{id}'");
        }
        Assert.IsGreaterThan(10, rows, "The package ID table is missing or nearly empty.");
        Assert.IsEmpty(disagreements, "These disagree with the table: " + string.Join(", ", disagreements));
        Assert.IsNull(WorkbenchProtocolHandler.ExtensionActorPackage("org.example.glance"), "An actor without extension: was taken.");
        Assert.IsNull(WorkbenchProtocolHandler.ExtensionActorPackage("studio"));
        Assert.IsNull(WorkbenchProtocolHandler.ExtensionActorPackage(null));
    }
}
