using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Nendo.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionJourneyTests
{
    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run from repository output.");
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task NativeConsentGraphAndStudioJourneyUsesOnlyAnIsolatedProfile()
    {
        var root = RepositoryRoot();
        var output = Path.Combine(root, "artifacts", "extension-journey-" + Guid.NewGuid().ToString("N"));
        var profile = Path.Combine(output, "device-state");
        Directory.CreateDirectory(output);
        await RunTool("pwsh", root, "-NoProfile", "-File", Path.Combine(root, "tools", "Build-NendoGraphPackage.ps1"));
        await using var workspace = new DesktopTestWorkspace();
        var archive = File.ReadAllBytes(Path.Combine(root, "artifacts", "extensions", "org.nendo.dependency-graph-0.1.0.nendoview"));
        await DesktopExtensionConsentTests.SeedAsync(workspace, archive);
        await using (var preparation = new DesktopSessionController(fileHistoryRoot: Path.Combine(profile, "file-history"), deviceStateRoot: profile))
        {
            await preparation.OpenAsync(workspace.FilePath);
            await preparation.CreateRecordAsync("nodes", "two", new Dictionary<string, object?> { ["label"] = "Next step" }, "journey-second-node");
            await preparation.CreateRecordAsync("edges", "depends", new Dictionary<string, object?> { ["from"] = "one", ["to"] = "two" },
                "journey-edge", expectedTargetVersions: new Dictionary<string, long> { ["from"] = 1, ["to"] = 1 });
            Assert.IsFalse((await preparation.ReadExtensionStatusAsync("graph")).IsApproved);
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
            foreach (var arg in new[] { Path.Combine(root, "tools", "Review-ExtensionDialogs.mjs"), port.ToString(), host.Id.ToString(), output, "graph" }) probe.ArgumentList.Add(arg);
            probe.Environment["NENDO_RUNTIME_EXPECTED_EXECUTABLE"] = executable;
            using var child = Process.Start(probe)!;
            var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
            try
            {
                // Each step here spawns a scoped UI Automation walk of its own, so the budget
                // grows with the journey; at 150 it was being reached rather than exceeded.
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(300));
                var text = await stdout + "\n" + await stderr;
                await File.WriteAllTextAsync(Path.Combine(output, "journey.log"), text);
                Assert.AreEqual(0, child.ExitCode, text + "\nEvidence: " + output);
            }
            finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        }
        finally
        {
            if (!host.HasExited && (!host.CloseMainWindow() || !host.WaitForExit(5000))) host.Kill(entireProcessTree: true);
            if (!host.HasExited) host.WaitForExit(5000);
        }
        await using var after = new DesktopSessionController(fileHistoryRoot: Path.Combine(profile, "file-history"), deviceStateRoot: profile);
        var snapshot = await after.OpenAsync(workspace.FilePath);
        Assert.AreEqual("Saved after renderer crash", snapshot.Records.Single(r => r.RecordId == "one").Values["label"].GetString());
        Assert.IsFalse((await after.ReadExtensionStatusAsync("graph")).IsApproved, "Reopening restored revoked permission.");
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
