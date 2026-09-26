using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Nendo.Engine.Tests;

/// <summary>
/// Reads a file's bytes to look at them, not to test who may open it.
///
/// The process tests hash every file in a folder straight after a child is killed, to prove
/// that nothing the parent does afterwards changes them. <c>File.ReadAllBytes</c> opens with
/// <c>FileShare.Read</c>, so any other handle with write access -- a scanner, the indexer, a
/// dying child's last handle -- failed the read with "being used by another process", and
/// under the full gate that happened in four runs of six on 2026-09-26. Which process held
/// the file is not what these tests are about; what the file contains is. So this opens the
/// file sharing everything, and if it is still refused, retries for a bounded time and says
/// who held it. Whether the writer released the file is asserted separately, by
/// <see cref="RestoreInterruptionTests.AssertExitedWriterReleasedAsync"/>, and is untouched.
/// </summary>
internal static class ObservedFile
{
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(15);

    public static byte[] ReadAllBytes(string path)
    {
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var copy = new MemoryStream();
                stream.CopyTo(copy);
                return copy.ToArray();
            }
            catch (IOException error) when (error is not FileNotFoundException and not DirectoryNotFoundException && elapsed.Elapsed < Bound)
            {
                Console.WriteLine($"ObservedFile: {Path.GetFileName(path)} refused after {elapsed.ElapsedMilliseconds} ms, held by {Holders(path)}: {error.Message}");
                Thread.Sleep(100);
            }
        }
    }

    public static Task<byte[]> ReadAllBytesAsync(string path) => Task.Run(() => ReadAllBytes(path));

    public static string Sha256(string path) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(ReadAllBytes(path)));

    /// <summary>The processes Windows' Restart Manager says have the file open, for the log line only.</summary>
    private static string Holders(string path)
    {
        try
        {
            if (RmStartSession(out var session, 0, Guid.NewGuid().ToString("N")) != 0) return "unknown";
            try
            {
                if (RmRegisterResources(session, 1, [path], 0, null, 0, null) != 0) return "unknown";
                uint needed = 0, count = 0, reasons = 0;
                RmGetList(session, out needed, ref count, null, ref reasons);
                if (needed == 0) return "nobody Restart Manager can see";
                var list = new RmProcessInfo[needed];
                count = needed;
                if (RmGetList(session, out needed, ref count, list, ref reasons) != 0) return "unknown";
                return string.Join(", ", list.Take((int)count).Select(item => $"{item.strAppName} (pid {item.Process.dwProcessId})"));
            }
            finally { RmEndSession(session); }
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            return "unknown";
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
        public RmUniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications,
        RmUniqueProcess[]? rgApplications, uint nServices, string[]? rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RmProcessInfo[]? rgAffectedApps, ref uint lpdwRebootReasons);
}
