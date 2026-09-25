using System.Text;
using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The host half of custom views running inside the Workbench (ADR-0013, 2026-09-25): an origin
/// for each package in each file, content served from the open file, and the device's switches.
/// </summary>
[TestClass]
public sealed class DesktopExtensionServingTests
{
    private const string PackageId = "org.example.map";
    private const string Html = "<!doctype html><script src=\"/_nendo/api.js\"></script><script src=\"app.js\"></script>";
    private const string Script = "nendo.view.loadRecords().then(console.log);";

    [TestMethod]
    public void EveryPackageIsASiteOfItsOwnBoundToItsFile()
    {
        var host = ExtensionOrigins.Host("app-one", PackageId);
        StringAssert.Matches(host, new Regex(@"^org-example-map-[0-9a-f]{10}\.example$"));
        Assert.AreEqual(host, ExtensionOrigins.Host("app-one", PackageId), "An origin that moved would lose the view's storage.");
        Assert.AreNotEqual(host, ExtensionOrigins.Host("app-two", PackageId), "Two files carrying one package must not share storage.");
        Assert.AreNotEqual(host, ExtensionOrigins.Host("app-one", "org.example.chart"));

        var awkward = ExtensionOrigins.Host("app-one", "org.a--b-.c" + new string('d', 60));
        var label = awkward[..^ExtensionOrigins.Suffix.Length];
        Assert.IsFalse(label.Contains("--", StringComparison.Ordinal), awkward);
        Assert.IsLessThanOrEqualTo(63, label.Length, awkward);
        Assert.IsTrue(ExtensionOrigins.IsViewHost(awkward));

        Assert.IsFalse(ExtensionOrigins.IsViewHost("example.org"));
        Assert.IsFalse(ExtensionOrigins.IsViewHost("a.b.example"), "Only a single label under the suffix is a view.");
        Assert.IsFalse(ExtensionOrigins.IsViewHost(".example"));
        Assert.IsFalse(ExtensionOrigins.IsViewHost(DesktopShellContract.WorkbenchHostName));
    }

    [TestMethod]
    public async Task AViewIsServedFromTheOpenFileAndRefusedWhileViewsAreOff()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        var view = await session.GetViewAsync();
        var runtime = view.Extensions!;
        Assert.IsTrue(runtime.Run);
        Assert.IsNull(runtime.OffReason);
        var package = runtime.Packages.Single();
        Assert.AreEqual(PackageId, package.PackageId);
        Assert.AreEqual("https://" + ExtensionOrigins.Host(view.Manifest!.ApplicationId, PackageId), package.Origin);
        var host = new Uri(package.Origin).Host;

        var entry = await session.ReadExtensionAssetAsync(host, "");
        Assert.AreEqual(200, entry.Status);
        Assert.AreEqual("text/html", entry.MediaType);
        Assert.AreEqual(Html, Encoding.UTF8.GetString(entry.Content));
        var script = await session.ReadExtensionAssetAsync(host, "app.js");
        Assert.AreEqual((200, "text/javascript"), (script.Status, script.MediaType));
        Assert.AreEqual(404, (await session.ReadExtensionAssetAsync(host, "missing.js")).Status);
        Assert.AreEqual(404, (await session.ReadExtensionAssetAsync("org-example-map-0000000000.example", "")).Status,
            "An origin the open file does not have is not served, whatever its name says.");
        Assert.AreEqual(200, session.ExtensionOriginStatus(host));

        view = await session.SetExtensionSettingAsync("file", false);
        Assert.AreEqual((false, "file", true, false), (view.Extensions!.Run, view.Extensions.OffReason, view.Extensions.DeviceEnabled, view.Extensions.FileEnabled));
        Assert.AreEqual(403, (await session.ReadExtensionAssetAsync(host, "")).Status);
        Assert.AreEqual(403, session.ExtensionOriginStatus(host), "The API script is refused with the rest.");

        await session.SetExtensionSettingAsync("file", true);
        view = await session.SetExtensionSettingAsync("device", false);
        Assert.AreEqual("device", view.Extensions!.OffReason);
        Assert.AreEqual(403, (await session.ReadExtensionAssetAsync(host, "app.js")).Status);
        Assert.IsFalse(new DesktopExtensionSettingsStore(workspace.FileHistoryRoot).Run, "The device switch is kept for the next launch.");

        await session.SetExtensionSettingAsync("device", true);
        session.SuspendExtensions();
        Assert.AreEqual(403, (await session.ReadExtensionAssetAsync(host, "")).Status, "A restart without views takes effect before the next read.");
        Assert.AreEqual("recovery", (await session.GetViewAsync()).Extensions!.OffReason);
        view = await session.SetExtensionSettingAsync("device", true);
        Assert.IsTrue(view.Extensions!.Run, "Turning views on ends a restart without them.");
        Assert.AreEqual(200, (await session.ReadExtensionAssetAsync(host, "")).Status);
    }

    [TestMethod]
    public async Task ClosingTheFileStopsItsOrigins()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var host = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin).Host;
        Assert.AreEqual(200, (await session.ReadExtensionAssetAsync(host, "")).Status);

        await session.CloseAsync();

        Assert.AreEqual(403, (await session.ReadExtensionAssetAsync(host, "")).Status);
        Assert.IsNull((await session.GetViewAsync()).Extensions);
    }

    [TestMethod]
    public async Task ImportIsAProposalAndSoIsRemoval()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "serving-test")) { }
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var archive = new NendoExtensionArchive(PackageId, "Map", "1.0.0", "index.html", null,
            [new("app.js", Encoding.UTF8.GetBytes(Script)), new("index.html", Encoding.UTF8.GetBytes(Html))]);

        var import = await session.PrepareExtensionImportAsync(archive);
        Assert.AreEqual(NendoProposalState.Previewable, import.State, string.Join("; ", import.Diagnostics.Select(d => d.Message)));
        var view = await session.GetViewAsync();
        Assert.IsFalse(view.Extensions!.Packages.Any(), "A prepared import changes nothing until it is accepted.");
        var host = ExtensionOrigins.Host(view.Manifest!.ApplicationId, PackageId);
        Assert.AreEqual(404, (await session.ReadExtensionAssetAsync(host, "")).Status, "Code waiting for acceptance must not be served.");
        Assert.IsTrue((await session.PromoteProposalAsync(import.ProposalId, expectedOperationDigest: import.OperationDigest)).Promotion.Applied);
        Assert.AreEqual(PackageId, (await session.GetViewAsync()).Extensions!.Packages.Single().PackageId);
        Assert.AreEqual(Html, Encoding.UTF8.GetString((await session.ReadExtensionAssetAsync(host, "")).Content), "Accepted code runs.");

        var removal = await session.PrepareExtensionRemovalAsync(PackageId);
        Assert.AreEqual(NendoProposalState.Previewable, removal.State, string.Join("; ", removal.Diagnostics.Select(d => d.Message)));
        Assert.IsTrue((await session.PromoteProposalAsync(removal.ProposalId, expectedOperationDigest: removal.OperationDigest)).Promotion.Applied);
        Assert.IsFalse((await session.GetViewAsync()).Extensions!.Packages.Any());
    }

    [TestMethod]
    public async Task TheJourneyFileCompilesWithAViewOfEachKindAndThreePackages()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        var view = await session.GetViewAsync();
        CollectionAssert.AreEquivalent(DesktopExtensionViewJourneyTests.ProbePackages, view.Extensions!.Packages.Select(p => p.PackageId).ToArray());
        Assert.AreEqual(3, view.Extensions.Packages.Select(p => p.Origin).Distinct().Count(), "Each package is its own origin.");
        var compiled = await session.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.Diagnostics.Any(d => d.Severity == NendoDiagnosticSeverity.Error),
            string.Join("; ", compiled.Diagnostics.Select(d => d.Code + " " + d.Message)));
    }

    [TestMethod]
    [DataRow("bytes=0-9", 0, 9)]
    [DataRow("bytes=90-", 90, 99)]
    [DataRow("bytes=-10", 90, 99)]
    [DataRow("bytes=0-1000", 0, 99)]
    public void AMediaElementGetsTheRangeItAskedFor(string header, int start, int end)
    {
        Assert.IsTrue(ExtensionAssetServer.TryRange(header, 100, out var from, out var to));
        Assert.AreEqual((start, end), (from, to));
    }

    [TestMethod]
    [DataRow("bytes=100-")]
    [DataRow("bytes=5-2")]
    [DataRow("bytes=0-5,10-20")]
    [DataRow("items=0-5")]
    [DataRow("bytes=-0")]
    public void ARangeTheContentCannotAnswerIsRefused(string header) =>
        Assert.IsFalse(ExtensionAssetServer.TryRange(header, 100, out _, out _));

    private static async Task SeedAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "serving-test");
        await coordinator.ApplyAsync(new NendoMutation("test", "package", "test", "Map", [
            new SetExtensionPackageOperation("serving-package", PackageId, "Map", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("serving-index", PackageId, "index.html", null, Encoding.UTF8.GetBytes(Html)),
            PutExtensionFileOperation.FromContent("serving-app", PackageId, "app.js", null, Encoding.UTF8.GetBytes(Script)),
        ]));
    }
}
