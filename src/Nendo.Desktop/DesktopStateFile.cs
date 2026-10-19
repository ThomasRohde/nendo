using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nendo.Desktop;

/// <summary>
/// How every device-state store reads and replaces its one small JSON document.
/// <para>
/// A document is replaced whole: written to a stage beside it, flushed to disk and moved
/// over the old one, so a reader sees the previous document or the new one and never half
/// of either. A reader refuses one past its limit.
/// </para>
/// <para>
/// Readers take no lock, and every window polls some of these documents. <c>File.Move</c> is
/// refused while any handle is open on the document, even one that shares delete, so a save
/// failed whenever it met another window's read, and was lost or kept for the session only.
/// The stage replaces the document with the POSIX rename Windows has had since
/// 10 1709, which a reader that shares delete does not block: that reader goes on reading the
/// document it opened. Where that rename is not available, or a handle that does not share
/// delete is open, the move is tried again for a short while.
/// </para>
/// </summary>
internal static class DesktopStateFile
{
    private static readonly TimeSpan MovePatience = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// Moves <paramref name="stage"/> over <paramref name="path"/>, which a reader in this or
    /// another window may have open. Throws what the last try threw.
    /// </summary>
    internal static void MoveOver(string stage, string path)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (!TryReplaceAroundReaders(stage, path)) File.Move(stage, path, overwrite: true);
                return;
            }
            catch (Exception exception) when ((exception is UnauthorizedAccessException or IOException) &&
                exception is not FileNotFoundException and not DirectoryNotFoundException &&
                clock.Elapsed < MovePatience)
            {
                Thread.Sleep(attempt < 3 ? 0 : 1);
            }
        }
    }

    /// <summary>
    /// Renames the stage over the document with POSIX semantics: true when it did, false where
    /// this Windows or file system has no such rename, or refused it, which leaves the move to
    /// <c>File.Move</c> and its retries: a handle on the document that does not share delete, or a
    /// folder that grants no rename, refuses both.
    /// </summary>
    private static bool TryReplaceAroundReaders(string stage, string path)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 16299)) return false;
        using var handle = CreateFileW(stage, DeleteAccess | SynchronizeAccess, FileShare.ReadWrite | FileShare.Delete,
            IntPtr.Zero, FileMode.Open, 0, IntPtr.Zero);
        if (handle.IsInvalid) return false;
        var target = Path.GetFullPath(path);
        // FILE_RENAME_INFO: the flags, the root directory handle, the name's length in bytes, the name.
        var rootOffset = IntPtr.Size;
        var lengthOffset = rootOffset + IntPtr.Size;
        var nameOffset = lengthOffset + sizeof(int);
        var nameBytes = target.Length * sizeof(char);
        var size = nameOffset + nameBytes + sizeof(char);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.WriteInt32(buffer, 0, (int)(ReplaceIfExists | PosixSemantics));
            Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(buffer, lengthOffset, nameBytes);
            Marshal.Copy(target.ToCharArray(), 0, buffer + nameOffset, target.Length);
            Marshal.WriteInt16(buffer, nameOffset + nameBytes, 0);
            return SetFileInformationByHandle(handle, FileRenameInfoEx, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private const uint DeleteAccess = 0x0001_0000;
    private const uint SynchronizeAccess = 0x0010_0000;
    private const int FileRenameInfoEx = 22;
    private const uint ReplaceIfExists = 0x1;
    private const uint PosixSemantics = 0x2;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, FileShare share, IntPtr security,
        FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, IntPtr information, uint size);

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
            MoveOver(stage, path);
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
