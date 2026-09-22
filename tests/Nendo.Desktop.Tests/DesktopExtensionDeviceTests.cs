using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopExtensionDeviceTests
{
    private static NendoExtensionGrant Grant() => new("app", "instance", "view", new string('a', 64), new string('b', 64));
    internal static byte[] Archive(string version = "1.0.0", string? script = null)
    {
        var html = Encoding.UTF8.GetBytes("<!doctype html><title>Offline graph</title><p>Version " + version + "</p>" +
            (script is null ? "" : "<script src='view.js'></script>"));
        var assets = new Dictionary<string, byte[]> { ["index.html"] = html };
        if (script is not null) assets["view.js"] = Encoding.UTF8.GetBytes(script);
        using var bytes = new MemoryStream();
        using (var zip = new ZipArchive(bytes, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var pair in assets) { using var asset = zip.CreateEntry(pair.Key).Open(); asset.Write(pair.Value); }
            using var manifest = zip.CreateEntry("manifest.json").Open();
            JsonSerializer.Serialize(manifest, new { manifestVersion = 1, packageId = "org.nendo.offline-test", version, protocolVersion = 1,
                entryPoint = "index.html", license = "MIT", capabilities = new[] { "projection.read", "record.select" },
                assets = assets.Select(p => new { path = p.Key, bytes = p.Value.Length, sha256 = Convert.ToHexString(SHA256.HashData(p.Value)).ToLowerInvariant() }) });
        }
        return bytes.ToArray();
    }

    [TestMethod]
    public async Task InspectionAndInstallationNeverGrantExecutionOrCreateReadSideState()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = Path.Combine(workspace.FileHistoryRoot, "extensions");
        var packages = new DesktopExtensionPackageStore(root);
        var authority = new DesktopExtensionGrantStore(root).ForFile("file-one");
        Assert.IsEmpty(packages.List());
        var package = packages.Inspect(Archive());
        Assert.IsFalse(authority.IsGranted(Grant() with { PackageDigest = package.Digest }));
        Assert.IsFalse(Directory.Exists(root));
        packages.Install(Archive());
        Assert.IsFalse(authority.IsGranted(Grant() with { PackageDigest = package.Digest }));
    }

    [TestMethod]
    public async Task OfflineExportPreservesExactPinAndActiveLeasePreventsRemovalAcrossStores()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopExtensionPackageStore(workspace.FileHistoryRoot);
        var original = Archive();
        var first = store.Install(original);
        var second = store.Install(Archive("2.0.0"));
        using (var held = store.Acquire(first.Digest, first.PackageId, first.Version))
        {
            CollectionAssert.AreEqual(original, held.ExportArchive());
            var otherHost = new DesktopExtensionPackageStore(workspace.FileHistoryRoot);
            Assert.ThrowsExactly<IOException>(() => otherHost.Remove(first.Digest));
            Assert.ThrowsExactly<InvalidDataException>(() => store.Acquire(first.Digest, first.PackageId, "2.0.0"));
            var export = held.ExportArchive();
            export[0] ^= 1;
            CollectionAssert.AreEqual(original, held.ExportArchive());
            var offline = new DesktopExtensionPackageStore(Path.Combine(workspace.FileHistoryRoot, "another-device"));
            Assert.AreEqual(first.Digest, offline.Install(held.ExportArchive()).Digest);
        }
        store.Remove(first.Digest);
        Assert.AreEqual(second.Digest, store.List().Single().Digest);
    }

    [TestMethod]
    public async Task CorruptPinIsUnavailableAndExplicitReinstallRepairsItWithoutLosingOtherVersions()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopExtensionPackageStore(workspace.FileHistoryRoot);
        var bytes = Archive();
        var first = store.Install(bytes);
        var second = store.Install(Archive("2.0.0"));
        var root = Path.Combine(workspace.FileHistoryRoot, "extension-packages");
        File.WriteAllBytes(Path.Combine(root, first.Digest + ".nendoview"), [1, 2, 3]);
        File.WriteAllBytes(Path.Combine(root, "stage-interrupted.tmp"), [4, 5]);
        Assert.AreEqual("unavailable", store.List().Single(p => p.Digest == first.Digest).State);
        Assert.ThrowsExactly<InvalidDataException>(() => store.Acquire(first.Digest, first.PackageId, first.Version));
        Assert.AreEqual(first.Digest, store.Install(bytes).Digest);
        using var restored = store.Acquire(first.Digest, first.PackageId, first.Version);
        CollectionAssert.AreEqual(bytes, restored.ExportArchive());
        Assert.HasCount(2, store.List());
        Assert.IsTrue(store.List().Any(p => p.Digest == second.Digest));
        Assert.ThrowsExactly<InvalidDataException>(() => store.Install(new byte[NendoExtensionViewPackage.MaximumArchiveBytes + 1]));
        Assert.ThrowsExactly<ArgumentException>(() => store.Remove("../outside"));
    }

    [TestMethod]
    public async Task ConsentSurvivesReopenButNeverCoversACopyOrChangedBindingOrPackage()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        var grant = Grant();
        store.Approve("physical-one", grant);
        var reopened = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        var authority = reopened.ForFile("physical-one");
        Assert.IsTrue(authority.IsGranted(grant));
        Assert.IsFalse(reopened.ForFile("physical-copy").IsGranted(grant), "A raw copy inherited execution approval.");
        foreach (var different in new[] { grant with { ApplicationId = "other" }, grant with { InstanceId = "other" },
            grant with { ViewId = "other" }, grant with { PackageDigest = new string('c', 64) },
            grant with { BindingDigest = new string('d', 64) }, grant with { ProtocolVersion = 2 } })
            Assert.IsFalse(authority.IsGranted(different), "Changed execution authority inherited approval.");
    }

    [TestMethod]
    public async Task AnotherHostRevokesALiveAuthorityAndReapprovalCannotReviveItsSession()
    {
        await using var workspace = new DesktopTestWorkspace();
        var writer = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        writer.Approve("physical", Grant());
        var authority = new DesktopExtensionGrantStore(workspace.FileHistoryRoot).ForFile("physical");
        using var session = new NendoExtensionViewSession(Grant(), authority, new(1, [], []));
        var before = authority.RevocationGeneration;
        writer.Revoke("physical", "app", "instance", "view");
        Assert.IsGreaterThan(before, authority.RevocationGeneration);
        Assert.IsFalse(authority.IsGranted(Grant()));
        Assert.ThrowsExactly<InvalidOperationException>(() => session.GetInitialization("light", "en"));
        Assert.IsTrue(session.IsClosed);
        writer.Approve("physical", Grant());
        Assert.IsTrue(authority.IsGranted(Grant()));
        Assert.ThrowsExactly<InvalidOperationException>(() => session.GetInitialization("light", "en"));
    }

    [TestMethod]
    public async Task InterleavedHostsPreserveOtherApprovalsAndChangingAPinWithdrawsTheOldOne()
    {
        await using var workspace = new DesktopTestWorkspace();
        var first = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        var second = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        var other = Grant() with { ViewId = "other" };
        first.Approve("physical", Grant());
        second.Approve("physical", other);
        var changed = Grant() with { PackageDigest = new string('e', 64) };
        first.Approve("physical", changed);
        var authority = second.ForFile("physical");
        Assert.IsTrue(authority.IsGranted(other));
        Assert.IsTrue(authority.IsGranted(changed));
        Assert.IsFalse(authority.IsGranted(Grant()));
        second.Revoke("physical", "app", "instance", "view");
        Assert.IsTrue(authority.IsGranted(other));
        Assert.IsFalse(authority.IsGranted(changed));
    }

    [TestMethod]
    public async Task MalformedOrDeletedDeviceStateRevokesAnAlreadyLoadedApproval()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        var authority = store.ForFile("physical");
        var state = Path.Combine(workspace.FileHistoryRoot, "extension-grants.json");
        foreach (var corrupt in new[] { "{", "{\"Version\":1,\"Version\":1,\"Grants\":[]}", "{\"Version\":99,\"Grants\":[]}",
            "{\"Version\":1,\"Grants\":[null]}", "{\"Version\":1,\"Grants\":[],\"Unknown\":true}" })
        {
            store.Approve("physical", Grant());
            Assert.IsTrue(authority.IsGranted(Grant()));
            var before = authority.RevocationGeneration;
            File.WriteAllText(state, corrupt);
            Assert.IsFalse(authority.IsGranted(Grant()));
            Assert.IsGreaterThan(before, authority.RevocationGeneration);
            Assert.IsFalse(store.Persisted);
        }
        store.Approve("physical", Grant());
        File.Delete(state);
        Assert.IsFalse(authority.IsGranted(Grant()));
    }

    [TestMethod]
    public async Task FailedWithdrawalDisablesThisSessionAndNeverClaimsToHavePersisted()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopExtensionGrantStore(workspace.FileHistoryRoot);
        store.Approve("physical", Grant());
        var unrelated = Grant() with { ViewId = "unrelated" };
        store.Approve("physical", unrelated);
        var authority = store.ForFile("physical");
        using (var busy = new FileStream(Path.Combine(workspace.FileHistoryRoot, "extension-grants.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.ThrowsExactly<IOException>(() => store.Revoke("physical", "app", "instance", "view"));
            Assert.IsFalse(authority.IsGranted(Grant()));
            Assert.IsFalse(store.Persisted);
            Assert.Contains("withdrawal could not be saved", store.Notice!);
        }
        store.Revoke("physical", "app", "instance", "view");
        Assert.IsTrue(store.Persisted);
        Assert.IsFalse(new DesktopExtensionGrantStore(workspace.FileHistoryRoot).ForFile("physical").IsGranted(Grant()));
        Assert.IsTrue(new DesktopExtensionGrantStore(workspace.FileHistoryRoot).ForFile("physical").IsGranted(unrelated),
            "Retrying a failed withdrawal erased another view's saved approval.");
    }
}
