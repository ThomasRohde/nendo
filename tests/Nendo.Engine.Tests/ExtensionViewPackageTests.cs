using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ExtensionViewPackageTests
{
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static byte[] Package(string path = "index.html", byte[]? content = null, Action<Dictionary<string, object>>? amend = null,
        Action<ZipArchive>? extra = null, int? attributes = null)
    {
        content ??= "<!doctype html><h1>Graph</h1>"u8.ToArray();
        var manifest = new Dictionary<string, object> {
            ["manifestVersion"] = 1, ["packageId"] = "org.nendo.graph", ["version"] = "0.1.0",
            ["protocolVersion"] = 1, ["entryPoint"] = path, ["license"] = "MIT",
            ["capabilities"] = new[] { "projection.read", "record.select" },
            ["assets"] = new[] { new { path, bytes = content.Length, sha256 = Hash(content) } },
        };
        amend?.Invoke(manifest);
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            using (var target = zip.CreateEntry("manifest.json").Open()) target.Write(JsonSerializer.SerializeToUtf8Bytes(manifest));
            var entry = zip.CreateEntry(path);
            if (attributes is not null) entry.ExternalAttributes = attributes.Value;
            using (var target = entry.Open()) target.Write(content);
            extra?.Invoke(zip);
        }
        return stream.ToArray();
    }

    [TestMethod]
    public void VerifiedPackageIsImmutableAndHasNoInstallationSideEffect()
    {
        var bytes = Package();
        var package = NendoExtensionViewPackage.Validate(bytes, Hash(bytes));
        Assert.AreEqual("org.nendo.graph", package.PackageId);
        Assert.AreEqual("index.html", package.EntryPoint);
        Array.Fill(bytes, (byte)0);
        var asset = package.ReadAsset("index.html"); Array.Fill(asset, (byte)0);
        Assert.IsTrue(Encoding.UTF8.GetString(package.ReadAsset("index.html")).StartsWith("<!doctype", StringComparison.Ordinal));
    }

    [TestMethod]
    public void ChangedArchiveOrAssetsCannotReuseDigest()
    {
        var bytes = Package();
        Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bytes, new string('0', 64)));
        var bad = Package(amend: m => m["assets"] = new[] { new { path = "index.html", bytes = 27, sha256 = new string('0', 64) } });
        Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bad, Hash(bad)));
    }

    [TestMethod]
    public void ArchivePathsNeverBecomeFilesystemAuthority()
    {
        foreach (var path in new[] { "../escape.html", "/index.html", "dir/../index.html", "C:/index.html", "dir\\index.html", "CON.html", "LPT1/file.html", "x./index.html", "x//index.html", "index.html:stream" })
        {
            var bytes = Package(path);
            Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bytes, Hash(bytes)), path);
        }
    }

    [TestMethod]
    public void SymlinksReparsePointsAndCaseCollisionsAreRejected()
    {
        foreach (var attributes in new[] { unchecked((int)0xa0000000), 0x400 })
        {
            var bytes = Package(attributes: attributes);
            Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bytes, Hash(bytes)));
        }
        var duplicate = Package(extra: zip => zip.CreateEntry("INDEX.html"));
        Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(duplicate, Hash(duplicate)));
    }

    [TestMethod]
    public void UnknownCapabilitiesFilesAndNativePayloadsAreRejected()
    {
        var samples = new[] {
            Package(amend: m => m["capabilities"] = new[] { "projection.read", "network" }),
            Package(amend: m => m["hostInvoke"] = "anything"),
            Package(extra: zip => zip.CreateEntry("hidden.js")),
            Package("index.exe"),
            Package(content: [0xff, 0xfe]),
            Package(amend: m => m["protocolVersion"] = 2),
            Package(amend: m => m["entryPoint"] = "missing.html"),
        };
        foreach (var bytes in samples) Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bytes, Hash(bytes)));
    }

    [TestMethod]
    public void ZipBombAndFileFloodStopAtDeclaredBounds()
    {
        var bomb = Package(content: new byte[NendoExtensionViewPackage.MaximumExpandedBytes + 1]);
        Assert.IsLessThan(NendoExtensionViewPackage.MaximumArchiveBytes, bomb.Length);
        Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(bomb, Hash(bomb)));
        var flood = Package(extra: zip => { for (var i = 0; i < 200; i++) zip.CreateEntry($"x{i}.js"); });
        Assert.ThrowsExactly<InvalidDataException>(() => NendoExtensionViewPackage.Validate(flood, Hash(flood)));
    }
}
