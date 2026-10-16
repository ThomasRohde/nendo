using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed partial class DesktopSessionController
{
    /// <summary>The open file's media origin host, set when its view is built; null with no file open.</summary>
    private volatile string? _mediaHost;

    /// <summary>The folder a relative local address is read against, set with the media host.</summary>
    private volatile string? _mediaFolder;

    internal bool IsMediaHost(string host) => _mediaHost is { } current && string.Equals(current, host, StringComparison.OrdinalIgnoreCase);

    /// <summary>The page's origin for the open file's pictures, recorded for the server that answers it.</summary>
    private string MediaOriginFor(NendoManifestSnapshot manifest)
    {
        var host = DesktopMediaOrigins.Host(manifest.ApplicationId, manifest.InstanceId);
        _mediaFolder = _currentPath is null ? null : Path.GetDirectoryName(Path.GetFullPath(_currentPath));
        _mediaHost = host;
        return "https://" + host;
    }

    /// <summary>One embedded picture's metadata, for a view's description.</summary>
    internal async Task<NendoMediaItem?> ReadMediaItemAsync(string sha256, CancellationToken cancellationToken) =>
        _service is { } service ? await service.ReadMediaAsync(sha256, cancellationToken) : null;

    private void StopMediaForFile()
    {
        _mediaHost = null;
        _mediaFolder = null;
    }

    /// <summary>
    /// One request to the media origin (ADR-0031 point 10). <c>m/{sha256}</c> is an embedded picture,
    /// read from the file a buffer at a time. <c>f/?a={address}</c> is a local file the page names by
    /// its address: served only when it is a file, not a folder, its extension is a picture type's,
    /// and its first bytes begin as that type. Anything else is a 404.
    /// </summary>
    internal async Task<DesktopMediaAnswer> ResolveMediaAsync(string path, string query, CancellationToken cancellationToken = default)
    {
        var service = _service;
        if (service is null || _mediaHost is null) return DesktopMediaAnswer.NotFound;
        try
        {
            if (path.StartsWith("m/", StringComparison.Ordinal))
            {
                var sha = path[2..];
                if (await service.ReadMediaAsync(sha, cancellationToken) is not { } item) return DesktopMediaAnswer.NotFound;
                return new(200, item.MediaType, item.ByteLength,
                    (start, count) => new DesktopMediaContentStream((offset, buffer, token) => service.ReadMediaRangeAsync(sha, offset, buffer, token), start, count),
                    Immutable: true);
            }
            if (path == "f/" || path == "f")
                return await ResolveLocalAsync(QueryValue(query, "a"), cancellationToken);
            return DesktopMediaAnswer.NotFound;
        }
        catch (Exception exception) when (exception is ObjectDisposedException or NendoException or OperationCanceledException or IOException)
        {
            return DesktopMediaAnswer.NotFound;
        }
    }

    private async Task<DesktopMediaAnswer> ResolveLocalAsync(string? value, CancellationToken cancellationToken)
    {
        if (!NendoMediaAddress.TryParse(value, out var address) ||
            address!.Source is not (NendoMediaSource.LocalAbsolute or NendoMediaSource.LocalRelative)) return DesktopMediaAnswer.NotFound;
        string full;
        if (address.Source == NendoMediaSource.LocalAbsolute) full = Path.GetFullPath(address.Value);
        else if (_mediaFolder is { } folder) full = Path.GetFullPath(Path.Combine(folder, address.Value));
        else return DesktopMediaAnswer.NotFound;
        if (!File.Exists(full)) return DesktopMediaAnswer.NotFound;
        var mediaType = NendoMedia.MediaTypeForExtension(Path.GetExtension(full));
        if (mediaType is null) return DesktopMediaAnswer.NotFound;
        var head = new byte[4096];
        int read;
        await using (var probe = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            read = await probe.ReadAsync(head, cancellationToken);
        if (NendoMedia.Sniff(head.AsSpan(0, read)) != mediaType) return DesktopMediaAnswer.NotFound;
        var length = new FileInfo(full).Length;
        return new(200, mediaType, length, (start, count) =>
        {
            var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, useAsync: true);
            stream.Position = start;
            return new DesktopStreamWindow(stream, count);
        });
    }

    /// <summary>
    /// The address a linked file is named by: beside the open file's folder as a relative path, so
    /// the file and its pictures move together, and anywhere else as the absolute path.
    /// </summary>
    internal string LocalMediaAddressFor(string path)
    {
        var full = Path.GetFullPath(path);
        if (_mediaFolder is { } folder)
        {
            var relative = Path.GetRelativePath(folder, full);
            if (!Path.IsPathRooted(relative) && !relative.StartsWith("..", StringComparison.Ordinal))
                return "." + Path.DirectorySeparatorChar + relative;
        }
        return full;
    }

    /// <summary>A local address as a path on this computer, when a file is there; null otherwise.</summary>
    internal string? ResolveLocalMediaPath(NendoMediaAddress address)
    {
        string full;
        if (address.Source == NendoMediaSource.LocalAbsolute) full = Path.GetFullPath(address.Value);
        else if (address.Source == NendoMediaSource.LocalRelative && _mediaFolder is { } folder) full = Path.GetFullPath(Path.Combine(folder, address.Value));
        else return null;
        return File.Exists(full) ? full : null;
    }

    private static string? QueryValue(string query, string name)
    {
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var at = pair.IndexOf('=');
            if (at > 0 && pair[..at] == name) return Uri.UnescapeDataString(pair[(at + 1)..]);
        }
        return null;
    }
}
