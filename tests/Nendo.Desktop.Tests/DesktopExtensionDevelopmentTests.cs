using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Developing a view from a folder (ADR-0013): this device links a package the
/// open file carries to a folder, the package's origin answers from the folder, a save there is
/// one notice within a measured bound, and Save to file is the proposal Import would prepare.
/// The link is device state: nothing about it reaches the file.
/// </summary>
[TestClass]
public sealed class DesktopExtensionDevelopmentTests
{
    private const string PackageId = "org.example.map";
    private const string FileHtml = "<!doctype html><p>reviewed</p>";
    private const string FolderHtml = "<!doctype html><p>from the folder</p>";

    /// <summary>A save in the folder is announced within this, the settle delay included.</summary>
    private static readonly TimeSpan NoticeBound = TimeSpan.FromSeconds(5);

    [TestMethod]
    public async Task ALinkedPackageIsServedFromItsFolderAndTheFileIsUntouched()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var folder = WriteFolder(workspace, PackageId, FolderHtml);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;
        var host = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
        Assert.AreEqual(FileHtml, await ReadAsync(session, host, ""));

        var view = await session.LinkExtensionFolderAsync(PackageId, folder);
        var package = view.Extensions!.Packages.Single();
        Assert.AreEqual(Path.GetFileName(folder), package.DevelopmentFolder, "The package does not say, by name, which folder runs it.");
        Assert.AreEqual(FolderHtml, await ReadAsync(session, host, ""), "A linked package still runs the file's code.");
        Assert.AreEqual("console.log('folder');", await ReadAsync(session, host, "app.js"));
        Assert.AreEqual(404, (await session.ReadExtensionAssetAsync(host, "missing.js")).Status);
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "Developing from a folder wrote to the file.");

        var links = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot).LinksFor((await session.GetViewAsync()).Manifest!.ApplicationId);
        Assert.AreEqual(Path.GetFullPath(folder), links.Single().Folder, "The link is not kept for the next launch.");

        await session.SetExtensionSettingAsync("file", false);
        Assert.AreEqual(403, (await session.ReadExtensionAssetAsync(host, "")).Status, "A developed view ran while this file's views were off.");
        await session.SetExtensionSettingAsync("file", true);

        view = await session.UnlinkExtensionFolderAsync(PackageId);
        Assert.IsNull(view.Extensions!.Packages.Single().DevelopmentFolder);
        Assert.AreEqual(FileHtml, await ReadAsync(session, host, ""), "Stop developing left the folder's code running.");
    }

    [TestMethod]
    public async Task TheLinkOutlivesTheSessionButNotTheFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var folder = WriteFolder(workspace, PackageId, FolderHtml);
        string host;
        await using (var first = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot))
        {
            await first.OpenAsync(workspace.FilePath);
            host = new Uri((await first.LinkExtensionFolderAsync(PackageId, folder)).Extensions!.Packages.Single().Origin!).Host;
        }

        await using var second = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await second.OpenAsync(workspace.FilePath);
        Assert.AreEqual(Path.GetFileName(folder), (await second.GetViewAsync()).Extensions!.Packages.Single().DevelopmentFolder);
        Assert.AreEqual(FolderHtml, await ReadAsync(second, host, ""), "A relaunch forgot the link.");

        await second.CloseAsync();
        Assert.AreEqual(403, (await second.ReadExtensionAssetAsync(host, "")).Status, "A closed file's developed view is still served.");
    }

    [TestMethod]
    public async Task AFolderOfAnotherPackageOrAPackageTheFileLacksIsRefused()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var other = WriteFolder(workspace, "org.example.other", FolderHtml);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        var mismatch = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.LinkExtensionFolderAsync(PackageId, other));
        Assert.AreEqual("extension-link-mismatch", mismatch.Code);
        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.LinkExtensionFolderAsync("org.example.other", other));
        Assert.AreEqual("extension-package-not-found", missing.Code);
        Assert.IsNull((await session.GetViewAsync()).Extensions!.Packages.Single().DevelopmentFolder);
        Assert.IsEmpty(new DesktopExtensionSettingsStore(workspace.FileHistoryRoot).LinksFor((await session.GetViewAsync()).Manifest!.ApplicationId));
    }

    [TestMethod]
    public async Task ASaveInTheFolderIsOneNoticeAndTheNextReadHasIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var folder = WriteFolder(workspace, PackageId, FolderHtml);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var host = new Uri((await session.LinkExtensionFolderAsync(PackageId, folder)).Extensions!.Packages.Single().Origin!).Host;
        Assert.AreEqual(FolderHtml, await ReadAsync(session, host, ""));

        var notices = new List<string>();
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var next = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.ExtensionDevelopmentChanged += packageId =>
        {
            lock (notices) notices.Add(packageId);
            if (!first.TrySetResult()) next.TrySetResult();
        };
        // An editor's save is several writes; the settle delay makes it one reload. The three are
        // written beside the folder and moved in back to back, so they land as one save does: three
        // writes on a loaded machine landed more than a settle apart and read as two saves.
        var staging = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(folder)!, "staging-" + Guid.NewGuid().ToString("N"))).FullName;
        File.WriteAllText(Path.Combine(staging, "index-1.html"), "<!doctype html><p>saved</p>");
        File.WriteAllText(Path.Combine(staging, "app.js"), "console.log('saved');");
        File.WriteAllText(Path.Combine(staging, "index-2.html"), "<!doctype html><p>saved again</p>");
        var clock = Stopwatch.StartNew();
        File.Move(Path.Combine(staging, "index-1.html"), Path.Combine(folder, "index.html"), overwrite: true);
        File.Move(Path.Combine(staging, "app.js"), Path.Combine(folder, "app.js"), overwrite: true);
        File.Move(Path.Combine(staging, "index-2.html"), Path.Combine(folder, "index.html"), overwrite: true);
        var landed = clock.Elapsed;
        await first.Task.WaitAsync(NoticeBound);
        var elapsed = clock.Elapsed;
        await Task.Delay(DesktopSessionController.DevelopmentSettle * 4);

        lock (notices)
            Assert.AreEqual(PackageId, string.Join(",", notices), $"A save of three files was not one notice for the package (landed in {landed.TotalMilliseconds:F0} ms, first notice after {elapsed.TotalMilliseconds:F0} ms).");
        Assert.AreEqual("<!doctype html><p>saved again</p>", await ReadAsync(session, host, ""), "The read after the notice served the old file.");
        Assert.AreEqual("console.log('saved');", await ReadAsync(session, host, "app.js"));

        // A folder that no longer reads as a package is served as the reason, not as the old code.
        // Read once its notice has come, rather than after a fixed wait the deletion may miss.
        File.Delete(Path.Combine(folder, NendoExtensionArchives.ManifestName));
        await next.Task.WaitAsync(NoticeBound);
        var broken = await session.ReadExtensionAssetAsync(host, "");
        Assert.AreEqual(503, broken.Status);
        StringAssert.Contains(Encoding.UTF8.GetString(broken.Content), NendoExtensionArchives.ManifestName);
    }

    [TestMethod]
    public async Task SaveToFileIsTheProposalImportWouldPrepare()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var folder = WriteFolder(workspace, PackageId, FolderHtml);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        var unlinked = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareDevelopmentSaveAsync(PackageId));
        Assert.AreEqual("extension-not-linked", unlinked.Code);

        await session.LinkExtensionFolderAsync(PackageId, folder);
        var save = await session.PrepareDevelopmentSaveAsync(PackageId);
        Assert.AreEqual(NendoProposalState.Previewable, save.State, string.Join("; ", save.Diagnostics.Select(d => d.Message)));
        Assert.IsTrue((await session.PromoteProposalAsync(save.ProposalId, expectedOperationDigest: save.OperationDigest)).Promotion.Applied);

        await session.UnlinkExtensionFolderAsync(PackageId);
        var host = new Uri((await session.GetViewAsync()).Extensions!.Packages.Single().Origin!).Host;
        Assert.AreEqual(FolderHtml, await ReadAsync(session, host, ""), "The accepted save did not put the folder's code in the file.");
    }

    [TestMethod]
    public async Task TheProtocolPicksTheFolderAndReturnsItsNameOnly()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var folder = WriteFolder(workspace, PackageId, FolderHtml);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;
        var handler = new WorkbenchProtocolHandler(session, _ => { },
            extensionHost: new FolderHost(folder));

        var linked = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ExtensionDevelopLink, new { packageId = PackageId }));
        Assert.IsTrue(linked.Ok, linked.Error?.Message);
        var json = JsonSerializer.Serialize(linked.Result, JsonSerializerOptions.Web);
        StringAssert.Contains(json, "\"developmentFolder\":\"" + Path.GetFileName(folder) + "\"");
        Assert.IsFalse(json.Contains(JsonEncodedText.Encode(Path.GetDirectoryName(folder)!).ToString(), StringComparison.OrdinalIgnoreCase),
            "The Workbench was told the folder's full path.");

        var stopped = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ExtensionDevelopStop, new { packageId = PackageId }));
        Assert.IsTrue(stopped.Ok, stopped.Error?.Message);
        var cancelled = await new WorkbenchProtocolHandler(session, _ => { },
            extensionHost: new FolderHost(null)).HandleAsync(Request(fileSessionId, WorkbenchMethods.ExtensionDevelopLink, new { packageId = PackageId }));
        Assert.IsTrue(cancelled.Ok, cancelled.Error?.Message);
        StringAssert.Contains(JsonSerializer.Serialize(cancelled.Result, JsonSerializerOptions.Web), "cancelled");
    }

    private static async Task<string> ReadAsync(DesktopSessionController session, string host, string path)
    {
        var asset = await session.ReadExtensionAssetAsync(host, path);
        Assert.AreEqual(200, asset.Status, $"{path}: {Encoding.UTF8.GetString(asset.Content)}");
        return Encoding.UTF8.GetString(asset.Content);
    }

    private static string WriteFolder(DesktopTestWorkspace workspace, string packageId, string html)
    {
        var folder = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "develop-" + packageId);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, NendoExtensionArchives.ManifestName),
            JsonSerializer.Serialize(new { packageId, title = "Map", version = "1.1.0", entryPoint = "index.html" }));
        File.WriteAllText(Path.Combine(folder, "index.html"), html);
        File.WriteAllText(Path.Combine(folder, "app.js"), "console.log('folder');");
        return folder;
    }

    private static string Request(string fileSessionId, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "develop-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });

    /// <summary>A host whose folder picker answers with one folder, or cancels when it has none.</summary>
    private sealed class FolderHost(string? folder) : IWorkbenchExtensionHost
    {
        public Task<string?> PickPackageSourceAsync() => Task.FromResult<string?>(null);
        public Task<string?> PickExportFolderAsync() => Task.FromResult<string?>(null);
        public Task<string?> PickDevelopmentFolderAsync() => Task.FromResult(folder);
        public Task<IReadOnlyList<ExtensionFrameProcess>> ReadFrameProcessesAsync() => Task.FromResult<IReadOnlyList<ExtensionFrameProcess>>([]);
    }

    private static async Task SeedAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "development-test");
        await coordinator.ApplyAsync(new NendoMutation("test", "package", "test", "Map", [
            new SetExtensionPackageOperation("development-package", PackageId, "Map", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("development-index", PackageId, "index.html", null, Encoding.UTF8.GetBytes(FileHtml)),
        ]));
    }
}
