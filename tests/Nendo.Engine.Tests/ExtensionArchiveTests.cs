using System.IO.Compression;
using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// A package arriving from outside a file (ADR-0013): a folder or a zip with a
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

    /// <summary>
    /// A zip is bounded by the files it keeps. Entries an import leaves out, such as a
    /// node_modules folder or the shadow tree Finder adds, counted towards the 512 files, so a small
    /// package was refused as too many files. The entries a zip lists have a bound of their own.
    /// </summary>
    [TestMethod]
    public void AZipIsBoundedByTheFilesItKeepsAndNotByTheEntriesItLeavesOut()
    {
        var modules = Enumerable.Range(0, 600).Select(index => ($"map/node_modules/lib/{index}.js", "x"));
        var withModules = Zip([("map/nendo-package.json", Manifest), ("map/index.html", "<p></p>"), ("map/app.js", "go();"), .. modules]);
        CollectionAssert.AreEqual(new[] { "app.js", "index.html" },
            NendoExtensionArchives.ReadZip(new MemoryStream(withModules)).Files.Select(file => file.Path).ToArray());

        var files = Enumerable.Range(0, 300).Select(index => $"tiles/{index}.txt").Append("index.html").ToArray();
        var finder = Zip([("map/nendo-package.json", Manifest), ("__MACOSX/map/._nendo-package.json", "x"),
            .. files.Select(file => ("map/" + file, "t")), .. files.Select(file => ("__MACOSX/map/._" + file.Replace("/", "/._"), "x"))]);
        Assert.HasCount(301, NendoExtensionArchives.ReadZip(new MemoryStream(finder)).Files);

        var flood = Zip([("nendo-package.json", Manifest), ("index.html", "<p></p>"),
            .. Enumerable.Range(0, NendoExtensionArchives.ZipEntries).Select(index => ($".cache/{index}", ""))]);
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(flood))).Message,
            "entries");
    }

    /// <summary>A directory entry written with backslashes, as Windows PowerShell 5.1 writes an empty folder, is a folder.</summary>
    [TestMethod]
    public void AZipWhoseFoldersAreWrittenWithBackslashesReadsLikeAnyOther()
    {
        var zip = Zip(("pkg\\nendo-package.json", Manifest), ("pkg\\index.html", "<p></p>"), ("pkg\\assets\\", ""));
        CollectionAssert.AreEqual(new[] { "index.html" }, NendoExtensionArchives.ReadZip(new MemoryStream(zip)).Files.Select(file => file.Path).ToArray());
    }

    /// <summary>
    /// An entry the zip cannot give is refused by its name: a compression method .NET does
    /// not read, or a damaged stream. They escaped as raw exceptions and reached the person as a host fault.
    /// </summary>
    [TestMethod]
    public void AnEntryTheZipCannotGiveIsRefusedByItsName()
    {
        var bzip2 = Stored(("nendo-package.json", Manifest), ("index.html", "<p>map</p>"));
        foreach (var header in new[] { (Signature: new byte[] { 0x50, 0x4B, 0x03, 0x04 }, Method: 8), (Signature: new byte[] { 0x50, 0x4B, 0x01, 0x02 }, Method: 10) })
        {
            // The second entry's headers: index.html. Method 12 is BZip2.
            var at = -1;
            for (var found = 0; found < 2; found++) at = bzip2.AsSpan(at + 1).IndexOf(header.Signature) + at + 1;
            bzip2[at + header.Method] = 12;
        }
        var unsupported = Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(bzip2)));
        StringAssert.Contains(unsupported.Message, "index.html");

        var text = string.Concat(Enumerable.Range(0, 2_000).Select(index => $"line {index} of the page\n"));
        var damaged = Zip(("nendo-package.json", Manifest), ("index.html", text));
        var local = damaged.AsSpan().LastIndexOf(new byte[] { 0x50, 0x4B, 0x03, 0x04 });
        var data = local + 30 + "index.html".Length;
        for (var index = data + 20; index < data + 60; index++) damaged[index] ^= 0x5A;
        var corrupt = Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(damaged)));
        StringAssert.Contains(corrupt.Message, "index.html");
    }

    /// <summary>
    /// A package cannot hold a file and a folder of one name, in any case. Export writes files
    /// in path order, so 'lib' and then 'lib/a.js' failed half-written and could never be exported.
    /// </summary>
    [TestMethod]
    public async Task APackageCannotHoldAFileAndAFolderOfOneName()
    {
        foreach (var name in new[] { "lib", "Lib" })
        {
            var zip = Zip(("nendo-package.json", Manifest), ("index.html", "<p></p>"), (name, "x"), ("lib/a.js", "a"));
            StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(zip))).Message,
                "a file and a folder");
        }

        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new NendoMutation("test", "add", "test", "Add", [
            new SetExtensionPackageOperation("p", "org.example.map", "Map", "index.html"),
            PutExtensionFileOperation.FromContent("f", "org.example.map", "index.html", null, "<p>map</p>"u8.ToArray()),
            PutExtensionFileOperation.FromContent("lib", "org.example.map", "lib", null, "x"u8.ToArray()),
            PutExtensionFileOperation.FromContent("tiles", "org.example.map", "tiles/a.png", null, "x"u8.ToArray()),
        ]));
        foreach (var (key, path) in new[] { ("under-a-file", "LIB/a.js"), ("over-a-folder", "Tiles") })
        {
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new NendoMutation("test", key, "test", "Put",
                [PutExtensionFileOperation.FromContent(key, "org.example.map", path, null, "y"u8.ToArray())])));
            Assert.AreEqual("extension-path-conflict", refused.Code, $"{path}: {refused.Message}");
        }
    }

    /// <summary>
    /// A package stored before the rule may already hold a file and a folder of one
    /// name. A path it holds is put again as before; only a new path is judged.
    /// </summary>
    [TestMethod]
    public async Task APathAStoredPackageAlreadyHoldsIsPutAgainWhateverElseItHolds()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new NendoMutation("test", "add", "test", "Add", [
            new SetExtensionPackageOperation("p", "org.example.map", "Map", "index.html"),
            PutExtensionFileOperation.FromContent("f", "org.example.map", "index.html", null, "<p>map</p>"u8.ToArray()),
            PutExtensionFileOperation.FromContent("lib", "org.example.map", "lib", null, "x"u8.ToArray()),
        ]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO __nendo_extension_file(package_id, path, media_type, sha256)
                SELECT package_id, 'lib/a.js', 'text/javascript', sha256 FROM __nendo_extension_file WHERE path = 'lib';
                """;
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        coordinator = await workspace.OpenAsync();
        var service = new NendoApplicationService(coordinator);
        var held = (await service.ReadExtensionFileAsync("org.example.map", "lib"))!.Sha256;
        await coordinator.ApplyAsync(new NendoMutation("test", "again", "test", "Put again",
            [PutExtensionFileOperation.FromContent("again", "org.example.map", "lib", null, "y"u8.ToArray(), held)]));
        Assert.AreEqual("y", Encoding.UTF8.GetString((await service.ReadExtensionFileAsync("org.example.map", "lib"))!.Content),
            "A path the stored package already held could not be put again.");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new NendoMutation("test", "new", "test", "Put",
            [PutExtensionFileOperation.FromContent("new", "org.example.map", "lib/b.js", null, "z"u8.ToArray())])));
        Assert.AreEqual("extension-path-conflict", refused.Code);
    }

    /// <summary>
    /// What an import leaves out cannot be put, and a manifest spelled in another case is the
    /// manifest, so a package exported and imported again is the same package.
    /// </summary>
    [TestMethod]
    public async Task WhatAnImportLeavesOutCannotBePutAndTheManifestIsTheManifestInAnyCase()
    {
        using var folder = new TemporaryFolder();
        folder.Write("Nendo-Package.json", Manifest);
        folder.Write("index.html", "<p></p>");
        CollectionAssert.AreEqual(new[] { "index.html" }, NendoExtensionArchives.Read(folder.Path).Files.Select(file => file.Path).ToArray(),
            "A manifest spelled in another case was carried as a package file.");

        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new NendoMutation("test", "add", "test", "Add", [
            new SetExtensionPackageOperation("p", "org.example.map", "Map", "index.html"),
            PutExtensionFileOperation.FromContent("f", "org.example.map", "index.html", null, "<p>map</p>"u8.ToArray()),
        ]));
        var paths = new[] { "node_modules/lit/index.js", ".well-known/app.json", "NENDO-PACKAGE.json" };
        for (var index = 0; index < paths.Length; index++)
        {
            var path = paths[index];
            var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new NendoMutation("test", $"put-{index}", "test", "Put",
                [PutExtensionFileOperation.FromContent($"put-{index}", "org.example.map", path, null, "x"u8.ToArray())])));
            StringAssert.Contains(refused.Message, "export and import", path);
        }
        Assert.HasCount(1, (await new NendoApplicationService(coordinator).GetDefinitionSnapshotAsync()).ExtensionPackages.Single().Files);
    }

    private static byte[] Stored(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var stream = zip.CreateEntry(name, CompressionLevel.NoCompression).Open();
                stream.Write(Encoding.UTF8.GetBytes(text));
            }
        }
        return buffer.ToArray();
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
