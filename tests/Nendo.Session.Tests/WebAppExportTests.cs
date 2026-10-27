using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Session.Tests;

/// <summary>Export → Web app (ADR-0037): the exported page in a folder with a manifest, the service worker and icons.</summary>
[TestClass]
public sealed class WebAppExportTests
{
    private const string Runtime = "<!doctype html><html><head><meta charset=\"UTF-8\" /><title>Nendo Studio</title><script type=\"application/json\" id=\"nendo-runtime\">{}</script></head><body><script type=\"module\">start()</script></body></html>";

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

    private static IReadOnlyDictionary<int, byte[]> Icons => NendoWebAppExport.IconSizes.ToDictionary(size => size, size => Png.Append((byte)(size % 251)).ToArray());

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx")) || Directory.Exists(Path.Combine(directory.FullName, ".git"))) return directory.FullName;
        throw new InvalidOperationException("The repository root was not found.");
    }

    private static string ServiceWorker => Path.Combine(RepositoryRoot(), "src", "Nendo.Workbench", "web-app", "sw.js");

    [TestMethod]
    public async Task TheFolderHoldsThePageTheManifestTheStampedWorkerAndTheIcons()
    {
        await using var workspace = new Workspace();
        await using var source = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "web-app-test");
        var template = Path.Combine(workspace.Root, "Nendo.html");
        await File.WriteAllTextAsync(template, Runtime);
        var folder = Directory.CreateDirectory(Path.Combine(workspace.Root, "app")).FullName;

        await NendoWebAppExport.ExportAsync(new NendoApplicationService(source), "Station.nendo", template, ServiceWorker, Icons, folder);

        CollectionAssert.AreEquivalent(
            new[] { "index.html", "manifest.webmanifest", "sw.js", "icons/icon-192.png", "icons/icon-512.png" },
            Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories).Select(file => Path.GetRelativePath(folder, file).Replace('\\', '/')).ToArray());
        var page = await File.ReadAllBytesAsync(Path.Combine(folder, "index.html"));
        var text = System.Text.Encoding.UTF8.GetString(page);
        StringAssert.Contains(text, "<link rel=\"manifest\" href=\"manifest.webmanifest\" />");
        Assert.IsLessThan(text.IndexOf("<title>", StringComparison.Ordinal), text.IndexOf("rel=\"manifest\"", StringComparison.Ordinal), "The manifest is not named in the head.");
        StringAssert.Matches(text, new Regex("<script type=\"application/octet-stream\" id=\"nendo-file\" data-name=\"Station.nendo\">[A-Za-z0-9+/=]+</script>\n<script type=\"module\">"));

        using var manifest = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(folder, "manifest.webmanifest")));
        var root = manifest.RootElement;
        Assert.AreEqual("Station", root.GetProperty("name").GetString());
        Assert.AreEqual("./", root.GetProperty("start_url").GetString());
        Assert.AreEqual("./", root.GetProperty("scope").GetString());
        Assert.AreEqual("standalone", root.GetProperty("display").GetString());
        Assert.AreEqual($"./?nendo-application={(await source.GetSnapshotAsync()).Manifest.ApplicationId}", root.GetProperty("id").GetString());
        foreach (var size in NendoWebAppExport.IconSizes)
        {
            var icon = root.GetProperty("icons").EnumerateArray().Single(entry => entry.GetProperty("sizes").GetString() == $"{size}x{size}");
            CollectionAssert.AreEqual(Icons[size], await File.ReadAllBytesAsync(Path.Combine(folder, icon.GetProperty("src").GetString()!)));
        }

        var worker = await File.ReadAllTextAsync(Path.Combine(folder, "sw.js"));
        StringAssert.Contains(worker, $"const version = '{Convert.ToHexStringLower(SHA256.HashData(page))}';");
        Assert.IsFalse(worker.Contains("__NENDO_WEB_APP_VERSION__", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task AFolderThatIsNotEmptyIsRefusedAndLeftAsItWas()
    {
        await using var workspace = new Workspace();
        await using var source = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "web-app-test");
        var template = Path.Combine(workspace.Root, "Nendo.html");
        await File.WriteAllTextAsync(template, Runtime);
        var folder = Directory.CreateDirectory(Path.Combine(workspace.Root, "site")).FullName;
        await File.WriteAllTextAsync(Path.Combine(folder, "index.html"), "mine");

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            NendoWebAppExport.ExportAsync(new NendoApplicationService(source), "Station.nendo", template, ServiceWorker, Icons, folder));
        Assert.AreEqual("web-app-folder-not-empty", refused.Code);
        Assert.AreEqual("site is not empty. Choose an empty folder for the web app.", refused.Message);
        CollectionAssert.AreEqual(new[] { Path.Combine(folder, "index.html") }, Directory.EnumerateFileSystemEntries(folder).ToArray());
        Assert.AreEqual("mine", await File.ReadAllTextAsync(Path.Combine(folder, "index.html")));
    }

    [TestMethod]
    public void TheServiceWorkerKeepsExactlyTheFolderItIsExportedWith()
    {
        var worker = File.ReadAllText(ServiceWorker);
        Assert.HasCount(1, Regex.Matches(worker, "__NENDO_WEB_APP_VERSION__"), "The worker has no single version to stamp.");
        foreach (var path in NendoWebAppExport.IconSizes.Select(NendoWebAppExport.IconPath).Append(NendoWebAppExport.ManifestName).Append("index.html"))
            StringAssert.Contains(worker, $"'{path}'", $"The service worker does not keep {path}.");
    }

    [TestMethod]
    public void TheAppStartsInTheLightThemesCanvas()
    {
        var tokens = File.ReadAllText(Path.Combine(RepositoryRoot(), "src", "Nendo.Workbench", "src", "styles", "02-tokens.css"));
        var light = tokens[..tokens.IndexOf(":root[data-theme=\"dark\"]", StringComparison.Ordinal)];
        Assert.AreEqual(NendoWebAppExport.CanvasColour, Regex.Match(light, @"--canvas:\s*(#[0-9a-fA-F]{6});").Groups[1].Value,
            "--canvas and the web app's colour have drifted apart.");
    }
}
