using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Custom-view packages carried in the file (ADR-0013, 2026-09-25). A package is definition:
/// its files arrive through canonical operations, are named by the SHA-256 of their bytes,
/// and stay in the file's content store once replaced, so history is small and a reversal
/// restores exactly what it replaced.
/// </summary>
[TestClass]
public sealed class ExtensionPackageTests
{
    private const string PackageId = "org.example.map";
    private const string Html = "<!doctype html>\r\n<title>Map</title>\n<script src=\"map.js\"></script>\n";
    private const string Script = "const cities = ['Århus', 'Tromsø', 'Łódź'];\nconsole.log(cities.length < 4 && \"✓\");\n";

    [TestMethod]
    public async Task APackageRaisesTheHostAndTheLayoutAndAFileWithoutOneKeepsBoth()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(Mutation("add", Package(), Put("index.html", Html), Put("map.js", Script)));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(NendoFormat.ExtensionPackagesMinimumHostVersion, after.Manifest.MinimumHostVersion);
        var package = after.ExtensionPackages.Single();
        Assert.AreEqual("Map", package.Title);
        Assert.AreEqual("index.html", package.EntryPoint);
        CollectionAssert.AreEqual(new[] { "index.html", "map.js" }, package.Files.Select(file => file.Path).ToArray());
        Assert.AreEqual("text/javascript", package.Files[1].MediaType);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1", inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        var read = await service.ReadExtensionFileAsync(PackageId, "map.js");
        Assert.IsNotNull(read);
        Assert.AreEqual(Script, Encoding.UTF8.GetString(read.Content));

        await using var empty = new EngineTestWorkspace();
        var untouched = await empty.CreateAsync();
        await untouched.DisposeAsync();
        empty.Forget(untouched);
        Assert.AreEqual("production-semantic-v1", (await NendoWriteCoordinator.InspectAsync(empty.FilePath)).Layout,
            "A file that never carried a package gained the rung.");
    }

    [TestMethod]
    public async Task BytesReadBackExactlyAndHistoryCarriesTheHashNotTheContent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var binary = RandomNumberGenerator.GetBytes(300_000);
        var request = Canonical(
            Operation("s", "extension.setPackage", new { packageId = PackageId, title = "Map" }),
            Operation("h", "extension.putFile", new { packageId = PackageId, path = "index.html", text = Html }),
            Operation("j", "extension.putFile", new { packageId = PackageId, path = "map.js", text = Script }),
            Operation("b", "extension.putFile", new { packageId = PackageId, path = "tiles/world.bin", base64 = Convert.ToBase64String(binary) }));
        var proposal = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(ProposalId(1), "Put the map in the file", "test", request));
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State, string.Join("; ", proposal.Diagnostics.Select(item => item.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);

        Assert.AreEqual(Html, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "index.html"))!.Content));
        Assert.AreEqual(Script, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "map.js"))!.Content));
        var stored = (await service.ReadExtensionFileAsync(PackageId, "tiles/world.bin"))!;
        CollectionAssert.AreEqual(binary, stored.Content);
        Assert.AreEqual(Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant(), stored.Sha256);
        Assert.AreEqual("application/octet-stream", stored.MediaType);

        var history = await service.GetHistoryAsync();
        var put = history.SelectMany(revision => revision.Operations).Single(operation => operation.CanonicalJson.Contains("world.bin", StringComparison.Ordinal));
        Assert.IsLessThan(1024, put.CanonicalJson.Length,
            $"The history row for a 300 KB file is {put.CanonicalJson.Length} characters; it carries the bytes rather than their hash.");
        StringAssert.Contains(put.CanonicalJson, stored.Sha256);
        Assert.IsFalse(history.SelectMany(revision => revision.Operations).Any(operation => operation.CanonicalJson.Contains("Tromsø", StringComparison.Ordinal)));
    }

    [TestMethod]
    public void OneByteChangesTheIdentityAndAHashSentBesideTheBytesIsChecked()
    {
        var first = PutExtensionFileOperation.FromContent("a", PackageId, "map.js", null, Encoding.UTF8.GetBytes(Script));
        var second = PutExtensionFileOperation.FromContent("a", PackageId, "map.js", null, Encoding.UTF8.GetBytes(Script.Replace('4', '5')));
        Assert.AreNotEqual(first.Sha256, second.Sha256);
        Assert.AreNotEqual(NendoCanonical.DigestOperations([first]), NendoCanonical.DigestOperations([second]));

        var refusal = Assert.ThrowsExactly<NendoValidationException>(() => NendoCanonicalOperations.Check("extension.putFile",
            JsonSerializer.SerializeToElement(new { packageId = PackageId, path = "map.js", text = Script, sha256 = new string('0', 64) })));
        StringAssert.Contains(refusal.Message, "does not match");
    }

    [TestMethod]
    public async Task CompensationRestoresTheExactBytesItReplacedAndRemoves()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var created = await coordinator.ApplyAsync(Mutation("add", Package(), Put("index.html", Html), Put("map.js", Script)));

        var replaced = await coordinator.ApplyAsync(Mutation("replace", Put("map.js", "console.log('replaced');\n")));
        await service.CompensateRevisionAsync(replaced.RevisionId, "undo-replace");
        Assert.AreEqual(Script, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "map.js"))!.Content),
            "compensation restored different bytes");

        var removed = await coordinator.ApplyAsync(Mutation("remove", new RemoveExtensionFileOperation("r", PackageId, "map.js")));
        Assert.IsNull(await service.ReadExtensionFileAsync(PackageId, "map.js"));
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        Assert.AreEqual(Script, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "map.js"))!.Content));

        // The package and its files arrived in one revision and leave in one, files first.
        await service.CompensateRevisionAsync(created.RevisionId, "undo-create");
        Assert.IsEmpty((await service.GetSnapshotAsync()).ExtensionPackages);
    }

    [TestMethod]
    public async Task AReversalRefusesAFileChangedSince()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("add", Package(), Put("map.js", Script)));
        var replaced = await coordinator.ApplyAsync(Mutation("replace", Put("map.js", "one();\n")));
        await coordinator.ApplyAsync(Mutation("again", Put("map.js", "two();\n")));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(replaced.RevisionId, "undo"));
        Assert.AreEqual("two();\n", Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "map.js"))!.Content));
    }

    [TestMethod]
    public async Task TheLargestPackageCommitStaysWellInsideTheReserve()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var files = Enumerable.Range(0, 4)
            .Select(index => (NendoOperation)PutExtensionFileOperation.FromContent($"f{index}", PackageId, $"assets/{index}.bin", null,
                RandomNumberGenerator.GetBytes(NendoExtensionLimits.ContentBytesPerChangeSet / 4)))
            .Prepend(Package())
            .ToArray();
        var before = new FileInfo(workspace.FilePath).Length;
        await coordinator.ApplyAsync(Mutation("largest", files));
        var growth = new FileInfo(workspace.FilePath).Length - before;
        Assert.IsGreaterThan(NendoExtensionLimits.ContentBytesPerChangeSet, growth, "The commit did not store its content, so this measures nothing.");
        Assert.IsLessThan(Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomFileBytes / 4, growth,
            $"A package commit of {NendoExtensionLimits.ContentBytesPerChangeSet} content bytes grew the file by {growth} bytes against a reserve of " +
            $"{Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomFileBytes}.");

        var overflow = Assert.ThrowsExactly<NendoValidationException>(() => Mutation("too-much", Package(),
            PutExtensionFileOperation.FromContent("x", PackageId, "a.bin", null, new byte[NendoExtensionLimits.ContentBytesPerChangeSet / 2 + 1]),
            PutExtensionFileOperation.FromContent("y", PackageId, "b.bin", null, new byte[NendoExtensionLimits.ContentBytesPerChangeSet / 2 + 1])).Validate());
        StringAssert.Contains(overflow.Message, "Split the files");
    }

    [TestMethod]
    public async Task AProposalShowsAOneLineEditAsOneHunkAndABinaryFileBySize()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var lines = Enumerable.Range(1, 40).Select(index => $"line {index};").ToArray();
        await coordinator.ApplyAsync(Mutation("add", Package(), Put("map.js", string.Join('\n', lines) + "\n"),
            PutExtensionFileOperation.FromContent("b", PackageId, "tiles.bin", null, [1, 2, 3])));

        var edited = lines.ToArray();
        edited[19] = "line 20 changed;";
        var request = Canonical(
            Operation("e", "extension.putFile", new { packageId = PackageId, path = "map.js", text = string.Join('\n', edited) + "\n" }),
            Operation("t", "extension.putFile", new { packageId = PackageId, path = "tiles.bin", base64 = Convert.ToBase64String(new byte[] { 4, 5, 6, 7 }) }));
        var proposal = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(ProposalId(2), "Edit the map", "test", request));

        var script = proposal.PackageChanges.Single(change => change.Path == "map.js");
        Assert.AreEqual("replaced", script.Change);
        Assert.IsTrue(script.Textual);
        Assert.HasCount(1, script.Hunks, "A one-line edit was not shown as exactly one hunk.");
        var hunk = script.Hunks[0];
        CollectionAssert.AreEqual(new[] { "context", "context", "context", "removed", "added", "context", "context", "context" },
            hunk.Lines.Select(line => line.Kind).ToArray());
        Assert.AreEqual("line 20;", hunk.Lines[3].Text);
        Assert.AreEqual("line 20 changed;", hunk.Lines[4].Text);
        Assert.AreEqual(17, hunk.OldStart);

        var binary = proposal.PackageChanges.Single(change => change.Path == "tiles.bin");
        Assert.IsFalse(binary.Textual);
        Assert.IsEmpty(binary.Hunks);
        Assert.AreEqual(3L, binary.BytesBefore);
        Assert.AreEqual(4L, binary.BytesAfter);
        Assert.IsTrue(proposal.SemanticDiff.Any(entry => entry.Summary.StartsWith("Replace map.js in the package Map", StringComparison.Ordinal)),
            string.Join(" | ", proposal.SemanticDiff.Select(entry => entry.Summary)));
    }

    [TestMethod]
    public void TheLineScriptReplaysToTheNewText()
    {
        var random = new Random(7);
        for (var trial = 0; trial < 200; trial++)
        {
            var a = Enumerable.Range(0, random.Next(0, 30)).Select(_ => random.Next(0, 6).ToString()).ToArray();
            var b = Enumerable.Range(0, random.Next(0, 30)).Select(_ => random.Next(0, 6).ToString()).ToArray();
            var rebuiltOld = new List<string>();
            var rebuiltNew = new List<string>();
            foreach (var (kind, oldIndex, newIndex) in ExtensionPackageDiff.Script(a, b))
            {
                if (kind != '+') rebuiltOld.Add(a[oldIndex]);
                if (kind != '-') rebuiltNew.Add(b[newIndex]);
                if (kind == '=') Assert.AreEqual(a[oldIndex], b[newIndex]);
            }
            CollectionAssert.AreEqual(a, rebuiltOld);
            CollectionAssert.AreEqual(b, rebuiltNew);
        }
    }

    [TestMethod]
    [DataRow("../escape.js")]
    [DataRow("/absolute.js")]
    [DataRow("a//b.js")]
    [DataRow("a\\b.js")]
    [DataRow("_nendo/api.js")]
    [DataRow("_NENDO/api.js")]
    [DataRow("con.js")]
    [DataRow("trailing.")]
    [DataRow("space here.js")]
    [DataRow("stream.js:alt")]
    public void AnUnsafePathIsRefused(string path) =>
        Assert.ThrowsExactly<NendoValidationException>(() => PutExtensionFileOperation.FromContent("p", PackageId, path, null, [1]));

    [TestMethod]
    [DataRow("map")]
    [DataRow("Org.Example.Map")]
    [DataRow("org..map")]
    [DataRow("1org.map")]
    public void AnInvalidPackageIdIsRefused(string packageId) =>
        Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionPackageOperation("s", packageId, "Map", "index.html"));

    [TestMethod]
    public async Task TheStoreRefusesWhatWouldLoseOrShadowAFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var noPackage = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(Mutation("orphan", Put("map.js", Script))));
        Assert.AreEqual("extension-package-not-found", noPackage.Code);

        await coordinator.ApplyAsync(Mutation("add", Package(), Put("Map.js", Script)));
        var clash = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(Mutation("case", Put("map.js", Script))));
        Assert.AreEqual("extension-path-conflict", clash.Code);

        var notEmpty = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(
            Mutation("drop", new RemoveExtensionPackageOperation("d", PackageId))));
        Assert.AreEqual("extension-package-not-empty", notEmpty.Code);

        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(Mutation("hash",
            PutExtensionFileOperation.FromStoredContent("h", PackageId, "copy.js", null, new string('a', 64), 3))));
        Assert.AreEqual("extension-content-missing", missing.Code);

        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(Mutation("stale",
            PutExtensionFileOperation.FromContent("s", PackageId, "Map.js", null, [1], PutExtensionFileOperation.ExpectAbsent))));
        Assert.AreEqual("extension-file-changed", stale.Code);

        Assert.ThrowsExactly<NendoValidationException>(() =>
            PutExtensionFileOperation.FromContent("big", PackageId, "big.bin", null, new byte[NendoExtensionLimits.FileBytes + 1]));
    }

    [TestMethod]
    public async Task IdenticalContentIsStoredOnceAndCopiedByItsHash()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("add", Package(), Put("map.js", Script)));
        var file = (await service.GetSnapshotAsync()).ExtensionPackages.Single().Files.Single();
        await coordinator.ApplyAsync(Mutation("copy",
            PutExtensionFileOperation.FromStoredContent("c", PackageId, "copy.js", null, file.Sha256, file.ByteLength)));
        Assert.AreEqual(Script, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "copy.js"))!.Content));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual(1L, await ScalarAsync(workspace.FilePath, "SELECT COUNT(*) FROM __nendo_extension_blob;"));
    }

    [TestMethod]
    public async Task AnExplicitIntegrityCheckReadsEveryStoredContent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(Mutation("add", Package(), Put("map.js", Script)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await ExecuteAsync(workspace.FilePath, "UPDATE __nendo_extension_blob SET content = CAST(replace(CAST(content AS TEXT), 'cities', 'CITIES') AS BLOB);");

        coordinator = await workspace.OpenAsync();
        var service = new NendoApplicationService(coordinator);
        var refusal = await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.VerifyIntegrityAsync());
        StringAssert.Contains(refusal.Message, "no longer matches its SHA-256");
    }

    [TestMethod]
    public void TheBoundsThatRefuseAreTheBoundsThatArePublished()
    {
        var published = NendoAuthoringLimits.Current.Extensions!;
        Assert.AreEqual(NendoExtensionLimits.FileBytes, published.FileBytes);
        Assert.AreEqual(NendoExtensionLimits.PackageBytes, published.PackageBytes);
        Assert.AreEqual(NendoExtensionLimits.TotalBytes, published.TotalBytes);
        Assert.AreEqual(NendoExtensionLimits.ContentBytesPerChangeSet, published.ContentBytesPerChangeSet);
    }

    private static SetExtensionPackageOperation Package() => new("package", PackageId, "Map", "index.html", "1.0.0");

    private static PutExtensionFileOperation Put(string path, string text) =>
        PutExtensionFileOperation.FromContent($"put-{Guid.NewGuid():N}", PackageId, path, null, Encoding.UTF8.GetBytes(text));

    private static NendoMutation Mutation(string key, params NendoOperation[] operations) =>
        new("extension-tests", key, "test", $"Package change {key}", operations);

    private static NendoCanonicalOperationRequest Operation(string id, string type, object payload) =>
        new(id, type, JsonSerializer.SerializeToElement(payload));

    private static NendoCanonicalChangeSetRequest Canonical(params NendoCanonicalOperationRequest[] operations) =>
        new([new NendoCanonicalMutationRequest("extension-tests", Guid.NewGuid().ToString("N"), "test", "Package change", operations)]);

    private static string ProposalId(int seed) => $"proposal-{seed:x32}";

    private static async Task<long> ScalarAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }

    private static async Task ExecuteAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }
}
