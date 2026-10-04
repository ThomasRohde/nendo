using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// How every device-state store reads and replaces its one small JSON document.
/// <para>
/// A document is replaced whole: written to a stage beside it, flushed to disk and moved
/// over the old one, so a reader sees the previous document or the new one and never half
/// of either. A reader opens it shared with that move and refuses one past its limit.
/// </para>
/// </summary>
internal static class DesktopStateFile
{
    /// <summary>
    /// Replaces <paramref name="path"/> with what <paramref name="write"/> puts in a stage named
    /// after <paramref name="stem"/>. Throws <see cref="IOException"/> or
    /// <see cref="UnauthorizedAccessException"/> when it cannot; the stage never outlives the call.
    /// </summary>
    internal static void Replace(string root, string path, string stem, Action<Stream> write)
    {
        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(root);
            var stage = Path.Combine(root, $"{stem}-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                write(stream);
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, path, overwrite: true);
            ownedStage = null;
        }
        finally
        {
            if (ownedStage is not null)
            {
                try { File.Delete(ownedStage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    /// <summary>
    /// <see cref="Replace"/> for a best-effort write: true when the document was replaced,
    /// false when it could not be, which leaves the previous one in place.
    /// </summary>
    internal static bool TryReplace(string root, string path, string stem, Action<Stream> write)
    {
        try
        {
            Replace(root, path, stem, write);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>
    /// The document at <paramref name="path"/>, or null when it is larger than
    /// <paramref name="maximumBytes"/>. A missing or unreadable file, or one that is not JSON,
    /// throws as opening and deserializing it would.
    /// </summary>
    internal static T? Read<T>(string path, long maximumBytes, int maximumDepth) where T : class
    {
        using var stream = OpenForRead(path);
        if (stream.Length > maximumBytes) return null;
        return JsonSerializer.Deserialize<T>(stream, new JsonSerializerOptions { MaxDepth = maximumDepth });
    }

    /// <summary>
    /// The bytes at <paramref name="path"/>. One larger than <paramref name="maximumBytes"/> is
    /// refused as a <see cref="JsonException"/> carrying <paramref name="oversizeMessage"/>, the
    /// same refusal a document that is not JSON gets.
    /// </summary>
    internal static byte[] ReadBytes(string path, long maximumBytes, string oversizeMessage)
    {
        using var stream = OpenForRead(path);
        if (stream.Length > maximumBytes) throw new JsonException(oversizeMessage);
        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        return bytes;
    }

    /// <summary>The name an entry is kept under, to say whose it is: the file name alone, never its folder.</summary>
    internal static string? FileLabel(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return null;
        var name = Path.GetFileName(fileName.Trim());
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    private static FileStream OpenForRead(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
}
