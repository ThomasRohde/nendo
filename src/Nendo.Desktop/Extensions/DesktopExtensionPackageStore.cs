using System.Security.Cryptography;
using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopExtensionPackageInfo(string Digest, string? PackageId, string? Version,
    string? License, string State);

/// <summary>Device-local content-addressed archives. Installation never grants execution.</summary>
internal sealed class DesktopExtensionPackageStore(string deviceRoot)
{
    private const int MaximumPackages = 256;
    private readonly string _root = Path.Combine(Path.GetFullPath(deviceRoot), "extension-packages");

    internal NendoExtensionViewPackage Inspect(ReadOnlySpan<byte> archive)
    {
        if (archive.Length is <= 0 or > NendoExtensionViewPackage.MaximumArchiveBytes)
            throw new InvalidDataException("The custom-view archive exceeds its size limit or is empty.");
        return NendoExtensionViewPackage.Validate(archive, Convert.ToHexString(SHA256.HashData(archive)).ToLowerInvariant());
    }

    internal NendoExtensionViewPackage Install(ReadOnlySpan<byte> archive)
    {
        // Freeze the input and validate all bytes before creating anything in the cache.
        if (archive.Length is <= 0 or > NendoExtensionViewPackage.MaximumArchiveBytes)
            throw new InvalidDataException("The custom-view archive exceeds its size limit or is empty.");
        var bytes = archive.ToArray();
        var package = Inspect(bytes);
        Directory.CreateDirectory(_root);
        RejectLink(_root);
        var lockPath = Path.Combine(_root, "mutation.lock");
        if (File.Exists(lockPath)) RejectLink(lockPath);
        using var mutation = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var target = ArchivePath(package.Digest);
        if (File.Exists(target))
        {
            try
            {
                using var existing = Acquire(package.Digest, package.PackageId, package.Version);
                return existing.Package;
            }
            catch (InvalidDataException) { } // Explicit reinstall may atomically repair this exact corrupt pin.
        }
        if (!File.Exists(target) && Directory.EnumerateFiles(_root, "*.nendoview").Take(MaximumPackages).Count() >= MaximumPackages)
            throw new IOException("Remove an unused custom-view package before installing another.");
        var stage = Path.Combine(_root, "stage-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var output = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { output.Write(bytes); output.Flush(flushToDisk: true); }
            File.Move(stage, target, overwrite: true); // Same-volume activation; only this exact pin can be replaced.
            return package;
        }
        finally { if (File.Exists(stage)) File.Delete(stage); }
    }

    internal DesktopExtensionPackageLease Acquire(string digest, string packageId, string version, int? protocolVersion = null)
    {
        RejectLink(_root);
        var path = ArchivePath(digest);
        RejectLink(path);
        // Holding this handle prevents both overwrite and removal, including from another host.
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            var bytes = ReadBounded(stream);
            var package = NendoExtensionViewPackage.Validate(bytes, digest);
            if (package.PackageId != packageId || package.Version != version)
                throw new InvalidDataException("The installed package does not match this view's exact ID and version.");
            // A digest pins bytes, and the bytes say which protocol they speak. A view at
            // another protocol would send the page a projection it was not written for.
            if (protocolVersion is { } expected && package.ProtocolVersion != expected)
                // Not a corrupt package, so not reported as one: installing the same bytes
                // again cannot help, and only a change to the view's pin can.
                throw new NendoPreconditionException("extension-protocol-mismatch",
                    $"The installed package speaks protocol {package.ProtocolVersion}, and this view declares protocol {expected}.");
            return new(stream, package, bytes);
        }
        catch { stream.Dispose(); throw; }
    }

    internal IReadOnlyList<DesktopExtensionPackageInfo> List()
    {
        if (!Directory.Exists(_root)) return [];
        RejectLink(_root);
        var paths = Directory.EnumerateFiles(_root, "*.nendoview").Take(MaximumPackages + 1).ToArray();
        if (paths.Length > MaximumPackages) throw new IOException("The custom-view package inventory exceeds its limit.");
        var result = new List<DesktopExtensionPackageInfo>();
        foreach (var path in paths.Order(StringComparer.Ordinal))
        {
            var digest = Path.GetFileNameWithoutExtension(path);
            if (!IsDigest(digest)) continue; // Unknown files are never package identities or cleanup targets.
            try
            {
                RejectLink(path);
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                var package = NendoExtensionViewPackage.Validate(ReadBounded(stream), digest);
                result.Add(new(digest, package.PackageId, package.Version, package.License, "available"));
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException)
            { result.Add(new(digest, null, null, null, "unavailable")); }
        }
        return result;
    }

    internal void Remove(string digest)
    {
        var path = ArchivePath(digest);
        if (!Directory.Exists(_root)) return;
        RejectLink(_root);
        var lockPath = Path.Combine(_root, "mutation.lock");
        if (File.Exists(lockPath)) RejectLink(lockPath);
        using var mutation = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (!File.Exists(path)) return;
        RejectLink(path);
        File.Delete(path); // Windows refuses while any running view holds its lease.
    }

    private string ArchivePath(string digest) => IsDigest(digest)
        ? Path.Combine(_root, digest + ".nendoview") : throw new ArgumentException("An exact lowercase SHA-256 package digest is required.");

    private static bool IsDigest(string value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RejectLink(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Custom-view cache links are not supported.");
    }

    internal static byte[] ReadBounded(Stream stream)
    {
        if (!stream.CanSeek || stream.Length is <= 0 or > NendoExtensionViewPackage.MaximumArchiveBytes)
            throw new InvalidDataException("The custom-view archive exceeds its size limit or is empty.");
        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        if (stream.ReadByte() != -1) throw new InvalidDataException("The custom-view archive changed while reading.");
        return bytes;
    }
}

internal sealed class DesktopExtensionPackageLease(FileStream stream, NendoExtensionViewPackage package, byte[] archive) : IDisposable
{
    internal NendoExtensionViewPackage Package { get; } = package;
    // Export returns the original archive bytes so the durable pin survives an offline transfer.
    internal byte[] ExportArchive() => archive.ToArray();
    public void Dispose() => stream.Dispose();
}
