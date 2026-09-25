using System.IO.Compression;
using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// A package arriving from outside a file (ADR-0013, 2026-09-25): a folder or a zip with a
/// nendo-package.json, or a legacy .nendoview. Importing proposes only what differs from the
/// package the file already carries, so a re-import after a one-line edit is a one-file review.
/// </summary>
[TestClass]
public sealed class ExtensionArchiveTests
{
    private const string Manifest = """{ "packageId": "org.example.map", "title": "Map", "version": "1.0.0", "entryPoint": "index.html" }""";

    [TestMethod]
    public void AFolderBringsItsFilesButNotItsManifestHiddenFilesOrModules()
    {
        using var folder = new TemporaryFolder();
        folder.Write("nendo-package.json", Manifest);
        folder.Write("index.html", "<!doctype html><script src=\"js/app.js\"></script>");
        folder.Write("js/app.js", "nendo.view.loadGraph();");
        folder.Write(".git/config", "[core]");
        folder.Write("node_modules/leaflet/leaflet.js", "L");

        var archive = NendoExtensionArchives.Read(folder.Path);

        Assert.AreEqual("org.example.map", archive.PackageId);
        Assert.AreEqual("Map", archive.Title);
        Assert.AreEqual("1.0.0", archive.Version);
        CollectionAssert.AreEqual(new[] { "index.html", "js/app.js" }, archive.Files.Select(file => file.Path).ToArray());
    }

    [TestMethod]
    public void AZipOfAFolderIsReadFromInsideItsTopFolder()
    {
        var zip = Zip(("map/nendo-package.json", Manifest), ("map/index.html", "<p>map</p>"), ("map/tiles/a.txt", "a"));

        var archive = NendoExtensionArchives.ReadZip(new MemoryStream(zip));

        CollectionAssert.AreEqual(new[] { "index.html", "tiles/a.txt" }, archive.Files.Select(file => file.Path).ToArray());
        Assert.AreEqual("<p>map</p>", Encoding.UTF8.GetString(archive.Files[0].Content));
    }

    [TestMethod]
    public void ALegacyArchiveKeepsItsFilesAndTakesItsIdentityFromItsManifest()
    {
        var legacy = """{ "manifestVersion": 1, "packageId": "org.nendo.graph", "version": "0.4.0", "protocolVersion": 1, "entryPoint": "index.html", "capabilities": [], "assets": [], "license": "MIT" }""";
        var zip = Zip(("manifest.json", legacy), ("index.html", "<p>graph</p>"));

        var archive = NendoExtensionArchives.ReadZip(new MemoryStream(zip));

        Assert.AreEqual("org.nendo.graph", archive.PackageId);
        Assert.AreEqual("org.nendo.graph", archive.Title);
        Assert.AreEqual("0.4.0", archive.Version);
        CollectionAssert.AreEqual(new[] { "index.html" }, archive.Files.Select(file => file.Path).ToArray());
    }

    [TestMethod]
    public void APackageThatCannotBeCarriedIsRefusedByName()
    {
        using var noManifest = new TemporaryFolder();
        noManifest.Write("index.html", "<p></p>");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.Read(noManifest.Path)).Message,
            "nendo-package.json");

        var noEntry = Zip(("nendo-package.json", Manifest), ("main.html", "<p></p>"));
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(noEntry))).Message,
            "index.html");

        var reserved = Zip(("nendo-package.json", Manifest), ("index.html", "<p></p>"), ("_nendo/api.js", "fake"));
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(reserved))).Message,
            "_nendo/api.js");

        var twins = Zip(("nendo-package.json", Manifest), ("index.html", "<p></p>"), ("Index.html", "<p></p>"));
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(twins))).Message,
            "apart from case");

        Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream("not a zip"u8.ToArray())));
    }

    [TestMethod]
    public async Task ReimportingProposesOnlyWhatChangedAndNothingWhenNothingDid()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        using var folder = new TemporaryFolder();
        folder.Write("nendo-package.json", Manifest);
        folder.Write("index.html", "<!doctype html><script src=\"app.js\"></script>");
        folder.Write("app.js", "one();\ntwo();\n");
        folder.Write("old.css", "p {}");

        var first = NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), null);
        CollectionAssert.AreEqual(new[] { "extension.setPackage", "extension.putFile", "extension.putFile", "extension.putFile" },
            first.Mutations.Single().Operations.Select(operation => operation.OperationType).ToArray());
        await coordinator.ApplyAsync(first.Mutations.Single());

        var current = (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single();
        var unchanged = Assert.ThrowsExactly<NendoPreconditionException>(() =>
            NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), current));
        Assert.AreEqual("extension-unchanged", unchanged.Code);

        folder.Write("app.js", "one();\nthree();\n");
        File.Delete(System.IO.Path.Combine(folder.Path, "old.css"));
        var edit = NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), current);
        var operations = edit.Mutations.Single().Operations;
        CollectionAssert.AreEqual(new[] { "extension.setPackage", "extension.removeFile", "extension.putFile" },
            operations.Select(operation => operation.OperationType).ToArray());
        var put = operations.OfType<PutExtensionFileOperation>().Single();
        Assert.AreEqual("app.js", put.Path);
        var replaced = current.Files.Single(file => file.Path == "app.js").Sha256;
        var named = put.ExpectedSha256;
        Assert.AreEqual(replaced, named, "A re-import must name the content it replaces, so it is refused over a newer edit.");
        await coordinator.ApplyAsync(edit.Mutations.Single());

        var after = (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single();
        CollectionAssert.AreEqual(new[] { "app.js", "index.html" }, after.Files.Select(file => file.Path).ToArray());
        Assert.AreEqual("one();\nthree();\n", Encoding.UTF8.GetString((await service.ReadExtensionFileAsync("org.example.map", "app.js"))!.Content));
    }

    [TestMethod]
    public async Task AnExportedManifestImportsAsTheSamePackage()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("test", "add", "test", "Add", [
            new SetExtensionPackageOperation("p", "org.example.map", "Map", "index.html", "2.1.0", "Where things are."),
            PutExtensionFileOperation.FromContent("f", "org.example.map", "index.html", null, "<p>map</p>"u8.ToArray()),
        ]));
        var package = (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single();

        using var folder = new TemporaryFolder();
        folder.Write("nendo-package.json", Encoding.UTF8.GetString(NendoExtensionArchives.Manifest(package)));
        folder.Write("index.html", "<p>map</p>");
        var archive = NendoExtensionArchives.Read(folder.Path);

        Assert.AreEqual((package.PackageId, package.Title, package.Version, package.EntryPoint, package.Description),
            (archive.PackageId, archive.Title, archive.Version, archive.EntryPoint, archive.Description));
        Assert.AreEqual("extension-unchanged",
            Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionArchives.ChangeSet(archive, package)).Code);
    }

    private static byte[] Zip(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var stream = zip.CreateEntry(name).Open();
                stream.Write(Encoding.UTF8.GetBytes(text));
            }
        }
        return buffer.ToArray();
    }

    private sealed class TemporaryFolder : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nendo-archive-" + Guid.NewGuid().ToString("N"));

        internal TemporaryFolder() => Directory.CreateDirectory(Path);

        internal void Write(string relative, string text)
        {
            var target = System.IO.Path.Combine(Path, relative.Replace('/', System.IO.Path.DirectorySeparatorChar));
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
            File.WriteAllText(target, text);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch (IOException) { }
        }
    }
}
