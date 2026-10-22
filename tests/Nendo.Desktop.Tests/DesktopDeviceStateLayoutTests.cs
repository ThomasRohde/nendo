using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The device-state root holds one folder per concern and nothing else (ADR-0034).
/// <para>
/// Each store named its own document in the root, so the person's folder collected sixteen loose
/// files whose names no longer said what they held, and a lane's root named two folders
/// differently from the person's. Every store writes here through the composition the window
/// uses, and the tree it leaves is compared with the ADR's table.
/// </para>
/// </summary>
[TestClass]
public sealed class DesktopDeviceStateLayoutTests
{
    /// <summary>The documents ADR-0034 lists, relative to the root.</summary>
    private static readonly string[] Documents =
    [
        @"actions\consent.json",
        @"agents\access.json",
        @"agents\connection.json",
        @"agents\launch.json",
        @"agents\ports.json",
        @"agents\settings.json",
        @"files\recent.json",
        @"logs\agent-failures.jsonl",
        @"logs\view-failures.jsonl",
        @"views\origin-carry.json",
        @"views\settings.json",
        @"window\appearance.json",
        @"window\places.json",
        @"window\tray.json",
    ];

    /// <summary>Folders whose contents are many entries of one kind, named by what they hold.</summary>
    private static readonly string[] Collections = [@"files\icons\", @"Mcp\active\"];

    [TestMethod]
    public async Task EveryStoreWritesInItsConcernsFolderAndNothingElseReachesTheRoot()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;

        // The window's composition: one root, from which the controller finds recent files and discovery.
        await using (var session = new DesktopSessionController(deviceStateRoot: root))
        {
            await session.SetAgentSettingsAsync(false, 60, true, FreePort());
            await session.CreateAsync(workspace.FilePath);
            await session.SetAgentModeAsync("editData");
            var discovery = DesktopDeviceStateLayout.Discovery(root);
            Assert.IsTrue(Directory.Exists(discovery) && Directory.GetFiles(discovery, "*.json").Length > 0,
                @"The running file published no endpoint under the root's Mcp\active folder.");
            AssertLayout(root, whileRunning: true);
        }

        new DesktopAppearanceStore(root).Save("dark");
        new DesktopShellStore(root).SetCloseAction("exit");
        new DesktopWindowStore(root).Save(new DesktopWindowState(10, 10, 1200, 800, false), workspace.FilePath);
        new DesktopBehaviourGrantStore(root).Approve(new NendoBehaviourGrant(
            "application-one", "instance-one", new string('0', 64), "behaviour-1", 3, NendoBehaviourCapabilities.UpdateRecords));
        using (var views = new DesktopExtensionSettingsStore(root)) views.SetFileEnabled("application-one", false);
        new ExtensionOriginCarry(root, () => new Dictionary<string, string>()).Holders();
        var launch = new DesktopAgentLaunchStore(root);
        launch.SetLastAgent("claude");
        new DesktopAgentOptionsStore(root).Pick("claude", new Dictionary<string, string> { ["model"] = "default" });
        Assert.IsTrue(new DesktopViewFailureLog(root).Record(new DesktopViewFailure(DateTimeOffset.UtcNow, "BrowserProcessExited", 1, true, 1024, 50)));
        Assert.IsTrue(new DesktopAgentFailureLog(root).Record(new NendoAgentFailure(
            DateTimeOffset.UtcNow, "0000beef", "tool", "nendo.change_set.accept", "System.IO.IOException", "at Nendo.LocalMcp")));
        await DesktopFileIcon.EnsureAsync(DesktopFileIcon.CacheRoot(root), new NendoResolvedLook("teal", "P", true, true), Mark);

        AssertLayout(root, whileRunning: false);
    }

    private static void AssertLayout(string root, bool whileRunning)
    {
        var written = Directory.GetFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(root, path))
            .ToArray();
        var outside = written
            .Where(path => !Documents.Contains(path, StringComparer.OrdinalIgnoreCase) &&
                !Collections.Any(folder => path.StartsWith(folder, StringComparison.OrdinalIgnoreCase)))
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.IsEmpty(outside, $"Device state was written outside ADR-0034's layout: {string.Join(", ", outside)}");

        var folders = Directory.GetDirectories(root).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray();
        Assert.IsEmpty(folders.Except(["actions", "agents", "files", "logs", "Mcp", "views", "window"], StringComparer.Ordinal).ToArray(),
            $"The root holds a folder ADR-0034 does not name: {string.Join(", ", folders)}");
        if (whileRunning) return;

        var missing = Documents.Where(document => !written.Contains(document, StringComparer.OrdinalIgnoreCase)).ToArray();
        Assert.IsEmpty(missing, $"A store did not write its document where ADR-0034 says: {string.Join(", ", missing)}");
        Assert.IsNotEmpty(Directory.GetFiles(DesktopFileIcon.CacheRoot(root)), "No icon was drawn under files\\icons.");
    }

    private static string Mark => File.Exists(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"))
        ? Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico")
        : Path.Combine(RepositoryRoot(), "src", "Nendo.Desktop", "Assets", "AppIcon.ico");

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("The repository root was not found.");
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return Math.Min(port, 65000);
    }
}
