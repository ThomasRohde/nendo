using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>Verified immutable package bytes. Reading a package never installs it or grants execution.</summary>
public sealed class NendoExtensionViewPackage
{
    public const int MaximumArchiveBytes = 10 * 1024 * 1024;
    public const int MaximumExpandedBytes = 30 * 1024 * 1024;
    public const int MaximumFiles = 200;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly Dictionary<string, byte[]> _assets;
    public string PackageId { get; }
    public string Version { get; }
    public string Digest { get; }
    public string EntryPoint { get; }
    public string License { get; }
    public IReadOnlyList<string> AssetPaths => Array.AsReadOnly(_assets.Keys.Order(StringComparer.Ordinal).ToArray());

    private NendoExtensionViewPackage(string id, string version, string digest, string entry, string license, Dictionary<string, byte[]> assets)
    { PackageId = id; Version = version; Digest = digest; EntryPoint = entry; License = license; _assets = assets; }

    public byte[] ReadAsset(string path) => _assets.TryGetValue(path, out var bytes) ? bytes.ToArray() : throw new ArgumentException("The asset is not declared by the package.");

    public static NendoExtensionViewPackage Validate(ReadOnlySpan<byte> archiveBytes, string expectedDigest)
    {
        if (archiveBytes.Length == 0 || archiveBytes.Length > MaximumArchiveBytes) throw Invalid("archive-size");
        var digest = Convert.ToHexString(SHA256.HashData(archiveBytes)).ToLowerInvariant();
        if (digest != expectedDigest) throw Invalid("archive-digest");
        try
        {
            using var source = new MemoryStream(archiveBytes.ToArray(), writable: false);
            using var archive = new ZipArchive(source, ZipArchiveMode.Read);
            if (archive.Entries.Count is 0 or > MaximumFiles) throw Invalid("file-count");
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var assets = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            long total = 0;
            foreach (var item in archive.Entries)
            {
                if (!SafePath(item.FullName) || !names.Add(item.FullName)) throw Invalid("asset-path");
                // No Unix symlink/special file or Windows reparse point, irrespective of host OS.
                var unixType = ((uint)item.ExternalAttributes >> 16) & 0xf000;
                if (unixType is not (0 or 0x8000) || (item.ExternalAttributes & 0x400) != 0) throw Invalid("asset-link");
                if (item.Length < 0 || item.Length > MaximumExpandedBytes || total + item.Length > MaximumExpandedBytes) throw Invalid("expanded-size");
                if (item.FullName == "manifest.json" && item.Length > 64 * 1024) throw Invalid("manifest-size");
                using var input = item.Open();
                using var output = new MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = input.Read(buffer)) != 0)
                {
                    total += count;
                    if (total > MaximumExpandedBytes || output.Length + count > item.Length) throw Invalid("expanded-size");
                    output.Write(buffer, 0, count);
                }
                if (output.Length != item.Length) throw Invalid("asset-size");
                var bytes = output.ToArray();
                _ = Utf8.GetString(bytes); // Assets are text; malformed UTF-8 never reaches a browser.
                assets.Add(item.FullName, bytes);
            }
            if (!assets.Remove("manifest.json", out var manifest)) throw Invalid("manifest-missing");
            using var document = JsonDocument.Parse(manifest, new JsonDocumentOptions { MaxDepth = 8 });
            var root = Object(document.RootElement, ["manifestVersion", "packageId", "version", "protocolVersion", "entryPoint", "capabilities", "assets", "license"]);
            if (!root["manifestVersion"].TryGetInt32(out var mv) || mv != 1 || !root["protocolVersion"].TryGetInt32(out var pv) || pv != 1) throw Invalid("manifest-version");
            var id = String(root["packageId"], 200);
            if (!NendoExtensionViewDefinition.ValidPackageId(id)) throw Invalid("package-id");
            var version = String(root["version"], 64);
            if (!NendoExtensionViewDefinition.ValidVersion(version)) throw Invalid("package-version");
            var license = String(root["license"], 256);
            if (root["capabilities"].ValueKind != JsonValueKind.Array) throw Invalid("capabilities");
            var capabilities = root["capabilities"].EnumerateArray().Select(c => String(c, 32)).ToArray();
            if (capabilities.Length != 2 || !capabilities.ToHashSet(StringComparer.Ordinal).SetEquals(["projection.read", "record.select"])) throw Invalid("capabilities");
            if (root["assets"].ValueKind != JsonValueKind.Array) throw Invalid("asset-inventory");
            var declared = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in root["assets"].EnumerateArray())
            {
                var entry = Object(item, ["path", "bytes", "sha256"]);
                var path = String(entry["path"], 240);
                if (!declared.Add(path) || !assets.TryGetValue(path, out var bytes)) throw Invalid("asset-inventory");
                if (!entry["bytes"].TryGetInt64(out var length) || length != bytes.Length) throw Invalid("asset-size");
                var hash = String(entry["sha256"], 64);
                if (hash != Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()) throw Invalid("asset-digest");
                if (Path.GetExtension(path) is not (".html" or ".css" or ".js" or ".txt")) throw Invalid("asset-type");
            }
            if (declared.Count != assets.Count) throw Invalid("asset-inventory");
            var entryPoint = String(root["entryPoint"], 240);
            if (!assets.ContainsKey(entryPoint) || !entryPoint.EndsWith(".html", StringComparison.Ordinal)) throw Invalid("entry-point");
            return new(id, version, digest, entryPoint, license, assets);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or DecoderFallbackException or EncoderFallbackException or OverflowException)
        { throw new InvalidDataException("Invalid extension package: malformed-content.", ex); }
    }

    private static Dictionary<string, JsonElement> Object(JsonElement value, string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw Invalid("manifest-object");
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject()) if (!result.TryAdd(property.Name, property.Value)) throw Invalid("duplicate-property");
        if (result.Count != keys.Length || keys.Any(key => !result.ContainsKey(key))) throw Invalid("manifest-properties");
        return result;
    }
    private static string String(JsonElement value, int max)
    {
        if (value.ValueKind != JsonValueKind.String || value.GetString() is not { Length: > 0 } text || text.Length > max) throw Invalid("manifest-string");
        _ = Utf8.GetByteCount(text);
        return text;
    }
    private static bool SafePath(string path)
    {
        if (path.Length is 0 or > 240 || path.Any(c => c is not (>= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-' or '.' or '/'))) return false;
        foreach (var part in path.Split('/'))
        {
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.')) return false;
            var name = part.Split('.')[0].ToUpperInvariant();
            if (name is "CON" or "PRN" or "AUX" or "NUL" || name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) && name[3] is >= '0' and <= '9') return false;
        }
        return true;
    }
    private static InvalidDataException Invalid(string code) => new($"Invalid extension package: {code}.");
}
