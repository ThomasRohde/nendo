using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using Microsoft.Win32.SafeHandles;

namespace Nendo.Engine;

/// <summary>
/// Local namespace evidence, never a global application ID: the Windows volume and file index, or
/// the browser page's own index of its in-memory files (<see cref="BrowserFileSystem"/>).
/// </summary>
internal sealed record LocalFileIdentity(uint VolumeSerialNumber, ulong FileIndex, bool InPage = false)
{
    internal string Key => InPage ? $"browser-file-v1:{FileIndex:x16}" : $"windows-file-v1:{VolumeSerialNumber:x8}:{FileIndex:x16}";

    internal static LocalFileIdentity Read(FileStream file)
    {
        if (BrowserFileSystem.Active) return BrowserFileSystem.Identity(file);
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("This file-identity workflow currently supports Windows only.");
        }
        if (!GetFileInformationByHandle(file.SafeFileHandle, out var info))
        {
            throw new IOException("The selected file's local identity could not be verified.", new Win32Exception(Marshal.GetLastWin32Error()));
        }
        return new(info.VolumeSerialNumber, ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }
}
