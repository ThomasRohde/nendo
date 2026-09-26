using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Custom views running inline in a real Nendo against an isolated profile (ADR-0013,
/// 2026-09-25). The page and every view frame are driven over the browser's debugging port,
/// and which process holds which frame comes from the host's own diagnostics, so nothing
/// here needs the pointer or the foreground. tools/Review-ExtensionViews.mjs holds the
/// measurements; this class builds the file and runs the app.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionViewJourneyTests
{
    internal static readonly string[] ProbePackages = ["org.nendo.test.probe-a", "org.nendo.test.probe-b", "org.nendo.test.probe-c"];

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run from repository output.");
    }

    private const string ProbeHtml = """
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>Probe</title></head>
        <body><h1 id="title">Probe</h1><p id="status">Waiting</p>
        <script src="/_nendo/api.js"></script><script src="probe.js"></script></body></html>
        """;

    /// <summary>
    /// A view that does what a view may do and tries what it may not, on request, so the
    /// journey can ask it from inside its own frame and measure the answer.
    /// </summary>
    private const string ProbeScript = """
        const state = { changes: 0, themes: 0, ready: false };
        window.probe = {
          state,
          async reads() {
            const view = await nendo.ready;
            const page = await nendo.records.query({ entityId: 'tasks', limit: 200 });
            return { view: { viewId: view.viewId, placement: view.placement, recordId: view.recordId, packageId: view.packageId }, items: page.items };
          },
          spin() { setTimeout(() => { for (;;) {} }, 0); return 'spinning'; },
          async fetchText(url) { const response = await fetch(url); return response.status + ':' + await response.text(); },
          socket(url) {
            return new Promise(resolve => {
              const socket = new WebSocket(url);
              socket.onopen = () => socket.send('ping');
              socket.onmessage = event => { resolve('echo:' + event.data); socket.close(); };
              socket.onerror = () => resolve('error');
              setTimeout(() => resolve('timeout'), 5000);
            });
          },
          parentDocument() { try { return parent.document ? 'reachable' : 'none'; } catch (error) { return 'blocked:' + error.name; } },
          navigateTop() { try { top.location.href = 'https://example.com/'; return 'navigated'; } catch (error) { return 'blocked:' + error.name; } },
          nestWorkbench() {
            return new Promise(resolve => {
              const frame = document.createElement('iframe');
              frame.src = 'https://app.nendo.local/index.html?nested=1';
              document.body.append(frame);
              setTimeout(() => { try { resolve(frame.contentWindow.location.href); } catch { resolve('cross-origin'); } }, 3000);
            });
          },
          forgeHello() {
            return new Promise(resolve => {
              const frame = document.createElement('iframe');
              document.body.append(frame);
              let answered = false;
              frame.contentWindow.addEventListener('message', event => { if (event.data?.nendo === 'connect') answered = true; });
              frame.contentWindow.top.postMessage({ nendo: 'hello', apiVersion: 1 }, '*');
              setTimeout(() => resolve(answered ? 'answered' : 'ignored'), 1500);
            });
          },
          storage(value) { if (value !== undefined) localStorage.setItem('probe', value); return localStorage.getItem('probe'); },
        };
        nendo.on('changes', () => { state.changes += 1; });
        nendo.on('theme', () => { state.themes += 1; });
        nendo.ready.then(view => {
          state.ready = true;
          document.getElementById('title').textContent = view.title;
          document.getElementById('status').textContent = 'Ready';
        }, error => { document.getElementById('status').textContent = 'Failed: ' + error.message; });
        """;

    /// <summary>
    /// Tasks with a calculated field, a decimal and a reference, a list to open them from, a
    /// record page carrying six views from three packages, and a screen drawn by one of them.
    /// </summary>
    internal static async Task SeedAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "view-journey");
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            new AddFieldOperation("estimate", "tasks", "estimate", "Estimate", "estimate", NendoStorageKind.Decimal, false),
            new AddFieldOperation("notes", "tasks", "notes", "Notes", "notes", NendoStorageKind.Text, false),
        ]));
        var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "calculation", "test", "Title length", [
            new SetBehaviourDefinitionOperation("length", new NendoCalculationDefinition("tasks.titleLength", "tasks", "titleLength",
                "Title length", NendoBehaviourScalar.Integer, true, "TextLength(title)",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        var packages = new List<NendoOperation>();
        foreach (var (packageId, index) in ProbePackages.Select((id, i) => (id, i)))
        {
            packages.Add(new SetExtensionPackageOperation($"probe-{index}", packageId, $"Probe {(char)('A' + index)}", "index.html", "1.0.0"));
            packages.Add(PutExtensionFileOperation.FromContent($"probe-{index}-html", packageId, "index.html", null, Encoding.UTF8.GetBytes(ProbeHtml)));
            packages.Add(PutExtensionFileOperation.FromContent($"probe-{index}-js", packageId, "probe.js", null, Encoding.UTF8.GetBytes(ProbeScript)));
        }
        await coordinator.ApplyAsync(new("test", "packages", "test", "Probes", packages));

        NendoOperation[] Bind(string id, string surface, string parent, int position, string field) => [
            new AddUiNodeOperation(id, surface, id, parent, "fieldBinding", position),
            new SetUiPropertyOperation(id + "-id", surface, id, "fieldId", field)];
        NendoOperation[] Panel(string id, int position, string packageId) => [
            new AddUiNodeOperation(id, "page", id, "page", NendoExtensionViewDefinition.PanelKind, position),
            new SetUiPropertyOperation(id + "-title", "page", id, "title", "Panel " + id),
            new SetUiPropertyOperation(id + "-package", "page", id, "packageId", packageId),
            new SetUiPropertyOperation(id + "-label", "page", id, "labelFieldId", "title"),
            .. Bind(id + "-f", "page", id, 0, "titleLength"),
        ];
        await coordinator.ApplyAsync(new("test", "ui", "test", "Screens", [
            new AddUiNodeOperation("list", "list", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-v", "list", "list", "definitionVersion", 3),
            new SetUiPropertyOperation("list-e", "list", "list", "entityId", "tasks"),
            new SetUiPropertyOperation("list-t", "list", "list", "title", "Tasks"),
            .. Bind("list-title", "list", "list", 0, "title"),
            new AddUiNodeOperation("probe", "probe", "probe", null, NendoExtensionViewDefinition.RecordsKind, 1),
            new SetUiPropertyOperation("probe-v", "probe", "probe", "definitionVersion", 3),
            new SetUiPropertyOperation("probe-e", "probe", "probe", "entityId", "tasks"),
            new SetUiPropertyOperation("probe-t", "probe", "probe", "title", "Probe screen"),
            new SetUiPropertyOperation("probe-p", "probe", "probe", "packageId", ProbePackages[0]),
            new SetUiPropertyOperation("probe-l", "probe", "probe", "labelFieldId", "title"),
            new SetUiPropertyOperation("probe-c", "probe", "probe", "configuration", "{\"probe\":true}"),
            .. Bind("probe-f1", "probe", "probe", 0, "estimate"),
            .. Bind("probe-f2", "probe", "probe", 1, "titleLength"),
            // A record command a view may run (ADR-0013 Phase 3, W-065): Mark reviewed sets the notes.
            new AddUiNodeOperation("cmd", "commands", "cmd", null, "recordCommand", 3),
            new SetUiPropertyOperation("cmd-v", "commands", "cmd", "definitionVersion", 3),
            new SetUiPropertyOperation("cmd-e", "commands", "cmd", "entityId", "tasks"),
            new SetUiPropertyOperation("cmd-l", "commands", "cmd", "label", "Mark reviewed"),
            new AddUiNodeOperation("cmd-step", "commands", "cmd-step", "cmd", "commandStep", 0),
            new SetUiPropertyOperation("cmd-step-f", "commands", "cmd-step", "fieldId", "notes"),
            new SetUiPropertyOperation("cmd-step-k", "commands", "cmd-step", "valueKind", "literal"),
            new SetUiPropertyOperation("cmd-step-x", "commands", "cmd-step", "value", "Reviewed by a view"),
            new AddUiNodeOperation("page", "page", "page", null, "detailSurface", 2),
            new SetUiPropertyOperation("page-v", "page", "page", "definitionVersion", 3),
            new SetUiPropertyOperation("page-e", "page", "page", "entityId", "tasks"),
            .. Bind("page-title", "page", "page", 0, "title"),
            .. Bind("page-notes", "page", "page", 1, "notes"),
            .. Panel("panel1", 2, ProbePackages[0]),
            .. Panel("panel2", 3, ProbePackages[0]),
            .. Panel("panel3", 4, ProbePackages[1]),
            .. Panel("panel4", 5, ProbePackages[1]),
            .. Panel("panel5", 6, ProbePackages[2]),
            .. Panel("panel6", 7, ProbePackages[2]),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Tasks", [
            new CreateRecordOperation("t1", "tasks", "t1", new Dictionary<string, object?> { ["title"] = "Survey the site", ["starts"] = "2026-10-01", ["estimate"] = 12.50m }),
            new CreateRecordOperation("t2", "tasks", "t2", new Dictionary<string, object?> { ["title"] = "Pour the base", ["starts"] = "2026-10-21", ["estimate"] = 3.25m }),
        ]));
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task ViewsRunInlineIsolatedFromTheWorkbenchAndStopWhenSwitchedOff()
    {
        var root = RepositoryRoot();
        var output = Path.Combine(root, "artifacts", "extension-view-journey-" + Guid.NewGuid().ToString("N"));
        var profile = Path.Combine(output, "device-state");
        Directory.CreateDirectory(output);
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
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
        // G20 develops probe A from this folder; the host's picker answers with it under diagnostics.
        var develop = Path.Combine(output, "develop-probe");
        Directory.CreateDirectory(develop);
        await File.WriteAllTextAsync(Path.Combine(develop, NendoExtensionArchives.ManifestName),
            $$"""{ "packageId": "{{ProbePackages[0]}}", "title": "Probe A", "version": "1.1.0", "entryPoint": "index.html" }""");
        await File.WriteAllTextAsync(Path.Combine(develop, "index.html"), ProbeHtml.Replace("<html lang=\"en\">", "<html lang=\"en\" data-source=\"folder-1\">", StringComparison.Ordinal));
        await File.WriteAllTextAsync(Path.Combine(develop, "probe.js"), ProbeScript);
        launch.Environment["NENDO_DIAGNOSTICS_DEVELOPMENT_FOLDER"] = develop;
        launch.Environment["WEBVIEW2_USER_DATA_FOLDER"] = Path.Combine(output, "webview");
        launch.Environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=" + port;
        using var host = Process.Start(launch)!;
        try
        {
            var probe = new ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
                RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { Path.Combine(root, "tools", "Review-ExtensionViews.mjs"), port.ToString(), host.Id.ToString(), output }) probe.ArgumentList.Add(arg);
            using var child = Process.Start(probe)!;
            var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
            try
            {
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(300));
                var text = await stdout + "\n" + await stderr;
                await File.WriteAllTextAsync(Path.Combine(output, "journey.log"), text);
                // Each guard's measured line, in the test log whether it passes or not.
                Console.WriteLine(text);
                Assert.AreEqual(0, child.ExitCode, text + "\nEvidence: " + output);
                StringAssert.Contains(text, "extension views ok");
            }
            finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        }
        finally
        {
            if (!host.HasExited && (!host.CloseMainWindow() || !host.WaitForExit(5000))) host.Kill(entireProcessTree: true);
            if (!host.HasExited) host.WaitForExit(5000);
        }
        // Evidence on a failure only; a pass leaves nothing behind.
        try { Directory.Delete(output, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
