using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A custom view on a record page, in a real Nendo against an isolated profile (ADR-0013,
/// 2026-09-24; W-061). The page is driven over its debugging port and the contained view is
/// measured by Windows, so nothing here needs the pointer or the foreground.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionPanelJourneyTests
{
    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run from repository output.");
    }

    /// <summary>
    /// Tasks with a list to open them from and a record page carrying two views of the same
    /// package: one under the dates, one further down, so the page scrolls between them.
    /// </summary>
    private static async Task SeedAsync(DesktopTestWorkspace workspace, NendoExtensionViewPackage package)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "panel-journey");
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            new AddFieldOperation("ends", "tasks", "ends", "Ends", "ends", NendoStorageKind.Date, false),
            new AddFieldOperation("notes", "tasks", "notes", "Notes", "notes", NendoStorageKind.Text, false),
        ]));
        var pin = new Dictionary<string, object?>
        {
            ["packageId"] = package.PackageId, ["packageVersion"] = package.Version, ["packageDigest"] = package.Digest,
            ["protocolVersion"] = 2, ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "title",
        };
        IEnumerable<NendoOperation> Panel(string id, string parent, int position, string title, params string[] fields) => [
            new AddUiNodeOperation(id, "page", id, parent, NendoExtensionViewDefinition.PanelKind, position),
            new SetUiPropertyOperation(id + "-title", "page", id, "title", title),
            .. pin.Select(p => new SetUiPropertyOperation(id + "-" + p.Key, "page", id, p.Key, p.Value)),
            .. fields.SelectMany((field, i) => (NendoOperation[])[
                new AddUiNodeOperation($"{id}-f{i}", "page", $"{id}-f{i}", id, "fieldBinding", i),
                new SetUiPropertyOperation($"{id}-f{i}-id", "page", $"{id}-f{i}", "fieldId", field)]),
        ];
        NendoOperation[] Bind(string id, string parent, int position, string field, string surface = "page") => [
            new AddUiNodeOperation(id, surface, id, parent, "fieldBinding", position),
            new SetUiPropertyOperation(id + "-id", surface, id, "fieldId", field)];
        await coordinator.ApplyAsync(new("test", "ui", "test", "Screens", [
            new AddUiNodeOperation("list", "list", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-v", "list", "list", "definitionVersion", 3),
            new SetUiPropertyOperation("list-e", "list", "list", "entityId", "tasks"),
            .. Bind("list-title", "list", 0, "title", "list"),
            new AddUiNodeOperation("page", "page", "page", null, "detailSurface", 0),
            new SetUiPropertyOperation("page-v", "page", "page", "definitionVersion", 3),
            new SetUiPropertyOperation("page-e", "page", "page", "entityId", "tasks"),
            .. Bind("page-title", "page", 0, "title"),
            .. Bind("page-starts", "page", 1, "starts"),
            .. Bind("page-ends", "page", 2, "ends"),
            .. Panel("plan", "page", 3, "Plan", "starts", "ends"),
            new AddUiNodeOperation("more", "page", "more", "page", "section", 4),
            new SetUiPropertyOperation("more-title", "page", "more", "title", "More"),
            .. Bind("more-notes", "more", 0, "notes"),
            .. Panel("later", "more", 1, "Later", "starts"),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Tasks", [
            new CreateRecordOperation("t1", "tasks", "t1", new Dictionary<string, object?> { ["title"] = "Survey the site", ["starts"] = "2026-10-01", ["ends"] = "2026-10-20" }),
            new CreateRecordOperation("t2", "tasks", "t2", new Dictionary<string, object?> { ["title"] = "Pour the base", ["starts"] = "2026-10-21" }),
        ]));
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task ARecordPanelStartsOnRequestFollowsThePageAndLeavesItEditable()
    {
        var root = RepositoryRoot();
        var output = Path.Combine(root, "artifacts", "extension-panel-journey-" + Guid.NewGuid().ToString("N"));
        var profile = Path.Combine(output, "device-state");
        Directory.CreateDirectory(output);
        await RunTool("pwsh", root, "-NoProfile", "-File", Path.Combine(root, "tools", "Build-NendoGanttPackage.ps1"));
        var archive = File.ReadAllBytes(Directory.GetFiles(Path.Combine(root, "artifacts", "extensions"), "org.nendo.gantt-*.nendoview")
            .OrderByDescending(File.GetLastWriteTimeUtc).First());
        await using var workspace = new DesktopTestWorkspace();
        await using (var preparation = new DesktopSessionController(fileHistoryRoot: Path.Combine(profile, "file-history"), deviceStateRoot: profile))
        {
            var package = preparation.ExtensionPackages.Inspect(archive);
            await SeedAsync(workspace, package);
            await preparation.OpenAsync(workspace.FilePath);
            preparation.ExtensionPackages.Install(archive);
            foreach (var view in new[] { "plan", "later" })
                Assert.IsTrue((await preparation.ApproveExtensionAsync((await preparation.PrepareExtensionConsentAsync(view)).ReviewId)).IsApproved);
        }
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        var executable = Environment.GetEnvironmentVariable("NENDO_EXTENSION_JOURNEY_EXECUTABLE") ??
            Path.Combine(root, "artifacts", "bin", "Nendo.Desktop",
#if DEBUG
                "debug_win-x64",
#else
                "release_win-x64",
#endif
                "Nendo.Desktop.exe");
        var launch = new ProcessStartInfo(executable) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(executable)!, WindowStyle = ProcessWindowStyle.Hidden };
        launch.Environment["NENDO_DEVICE_STATE_ROOT"] = profile;
        launch.Environment["NENDO_NATIVE_DIAGNOSTICS"] = "1";
        launch.Environment["NENDO_STARTUP_CREATE"] = "";
        launch.Environment["NENDO_STARTUP_OPEN"] = workspace.FilePath;
        launch.Environment["NENDO_DESKTOP_CLOSE_ACTION"] = "exit";
        launch.Environment["WEBVIEW2_USER_DATA_FOLDER"] = Path.Combine(output, "webview");
        launch.Environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=" + port;
        using var host = Process.Start(launch)!;
        try
        {
            var probe = new ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
                RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { Path.Combine(root, "tools", "Review-ExtensionPanel.mjs"), port.ToString(), host.Id.ToString(), output }) probe.ArgumentList.Add(arg);
            probe.Environment["NENDO_RUNTIME_EXPECTED_EXECUTABLE"] = executable;
            using var child = Process.Start(probe)!;
            var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
            try
            {
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(240));
                var text = await stdout + "\n" + await stderr;
                await File.WriteAllTextAsync(Path.Combine(output, "journey.log"), text);
                Assert.AreEqual(0, child.ExitCode, text + "\nEvidence: " + output);
                StringAssert.Contains(text, "record panel ok");
            }
            finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        }
        finally
        {
            if (!host.HasExited && (!host.CloseMainWindow() || !host.WaitForExit(5000))) host.Kill(entireProcessTree: true);
            if (!host.HasExited) host.WaitForExit(5000);
        }
    }

    private static async Task RunTool(string executable, string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
            RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in arguments) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.AreEqual(0, process.ExitCode, await stdout + await stderr);
        }
        finally { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    }
}
