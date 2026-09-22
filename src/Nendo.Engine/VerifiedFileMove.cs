using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Nendo.Engine;

/// <summary>
/// Holds the verified physical file against writes/deletion while renaming that
/// handle, not a re-resolved path. Windows/local-filesystem lifecycle primitive;
/// callers must close SQLite and their old path pin before acquiring it.
/// </summary>
internal sealed class VerifiedFileMove : IDisposable
{
    private readonly FileStream _file;

    private VerifiedFileMove(FileStream file) => _file = file;

    internal static VerifiedFileMove Acquire(string path, LocalFileIdentity identity, string byteDigest)
    {
        var file = OpenExclusive(path);
        try
        {
            if (LocalFileIdentity.Read(file) != identity || Digest(file) != byteDigest)
                throw new NendoPreconditionException("replacement-target-changed", "The selected file changed before replacement. No unexpected file was moved or overwritten.");
            return new(file);
        }
        catch { file.Dispose(); throw; }
    }

    internal static void DeleteOwnedFile(string path, LocalFileIdentity identity)
    {
        using var file = OpenExclusive(path);
        if (LocalFileIdentity.Read(file) != identity)
            throw new IOException("The owned recovery file was replaced; it was not removed.");
        // FileDispositionInfo operates on this held identity, not a path that
        // another process could replace between verification and deletion.
        if (!SetFileInformationByHandle(file.SafeFileHandle, 4, [1], 1))
            throw new IOException("The owned recovery file could not be removed.", new Win32Exception(Marshal.GetLastWin32Error()));
    }

    private static FileStream OpenExclusive(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var handle = CreateFileW(Path.GetFullPath(path), 0x80000000 | 0x00010000, // GENERIC_READ | DELETE
            1, IntPtr.Zero, 3, 0, IntPtr.Zero); // share read only, OPEN_EXISTING
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException("Exclusive lifecycle access to the selected file is unavailable.", new Win32Exception(error));
        }
        try { return new FileStream(handle, FileAccess.Read); }
        catch { handle.Dispose(); throw; }
    }

    internal void MoveTo(string destination)
    {
        var name = Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
        // FILE_RENAME_INFO: zero ReplaceIfExists/flags, aligned null root
        // handle, byte length, UTF-16 name. FileRenameInfo (3), not Ex.
        var nameOffset = 2 * IntPtr.Size + sizeof(int);
        var buffer = new byte[nameOffset + name.Length + sizeof(char)];
        BitConverter.GetBytes(name.Length).CopyTo(buffer, 2 * IntPtr.Size);
        name.CopyTo(buffer, nameOffset);
        if (!SetFileInformationByHandle(_file.SafeFileHandle, 3, buffer, (uint)buffer.Length))
            throw new IOException("The file could not be activated at the selected name. Existing files were not overwritten.",
                new Win32Exception(Marshal.GetLastWin32Error()));
    }

    internal static string Digest(FileStream file)
    {
        file.Position = 0;
        return Convert.ToHexString(SHA256.HashData(file));
    }

    public void Dispose() => _file.Dispose();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, byte[] information, uint length);
}
