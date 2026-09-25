using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Which browser process holds which view, with its private working set. Answered only when
    /// NENDO_NATIVE_DIAGNOSTICS=1, for the journeys that measure isolation and memory.
    /// </summary>
    internal const string DiagnosticsFrameProcesses = "diagnostics.frameProcesses";
}

internal sealed record ExtensionFrameProcess(int ProcessId, string Kind, long? PrivateWorkingSetBytes, IReadOnlyList<ExtensionFrameProcessFrame> Frames);

internal sealed record ExtensionFrameProcessFrame(string Name, string Source);

/// <summary>
/// The browser's processes as the views' journeys measure them: the renderer each frame is in,
/// and memory in the same terms as the spike's budget (private working set, from
/// PROCESS_MEMORY_COUNTERS_EX2; prototypes/iframe-views/FINDINGS.md S14).
/// </summary>
internal static class ExtensionFrameDiagnostics
{
    internal static async Task<IReadOnlyList<ExtensionFrameProcess>> ReadAsync(CoreWebView2 core)
    {
        var infos = await core.Environment.GetProcessExtendedInfosAsync();
        return infos.Select(info => new ExtensionFrameProcess(
                info.ProcessInfo.ProcessId,
                info.ProcessInfo.Kind.ToString(),
                PrivateWorkingSet(info.ProcessInfo.ProcessId),
                info.AssociatedFrameInfos.Select(frame => new ExtensionFrameProcessFrame(frame.Name ?? "", frame.Source ?? "")).ToArray()))
            .ToArray();
    }

    private static long? PrivateWorkingSet(int processId)
    {
        const uint QueryLimitedInformation = 0x1000;
        var handle = OpenProcess(QueryLimitedInformation, false, processId);
        if (handle == 0) return null;
        try
        {
            var counters = new MemoryCountersEx2 { Size = (uint)Marshal.SizeOf<MemoryCountersEx2>() };
            return GetProcessMemoryInfo(handle, ref counters, counters.Size) ? (long)counters.PrivateWorkingSetSize : null;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryCountersEx2
    {
        public uint Size;
        public uint PageFaultCount;
        public nuint PeakWorkingSetSize;
        public nuint WorkingSetSize;
        public nuint QuotaPeakPagedPoolUsage;
        public nuint QuotaPagedPoolUsage;
        public nuint QuotaPeakNonPagedPoolUsage;
        public nuint QuotaNonPagedPoolUsage;
        public nuint PagefileUsage;
        public nuint PeakPagefileUsage;
        public nuint PrivateUsage;
        public nuint PrivateWorkingSetSize;
        public ulong SharedCommitUsage;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint handle);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(nint process, ref MemoryCountersEx2 counters, uint size);
}
