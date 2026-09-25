using System.Runtime.InteropServices;
using System.Text;

namespace IframeViewsSpike;

/// <summary>The few Win32 calls the spike needs: process memory and liveness, and window snapshots.</summary>
internal static class Native
{
    public const uint WmClose = 0x0010;
    public const uint WmKeyDown = 0x0100;
    public const uint WmKeyUp = 0x0101;
    public const int VkEscape = 0x1B;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint StillActive = 259;

    private delegate bool EnumWindowsProc(nint window, nint parameter);

    public readonly record struct MemoryInfo(long PrivateWorkingSet, long PrivateBytes, long WorkingSet);

    public sealed record WindowInfo(nint Handle, int Pid, string ClassName, string Title, bool TopLevel, int Left, int Top, int Width, int Height)
    {
        public override string ToString() => $"{ClassName} '{Title}' pid={Pid} top={TopLevel} {Left},{Top} {Width}x{Height}";
    }

    /// <summary>Private working set (what Task Manager shows as memory) plus private commit and working set.</summary>
    public static MemoryInfo? Memory(int pid)
    {
        var handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == 0)
        {
            return null;
        }

        try
        {
            var counters = new MemoryCountersEx2 { Size = (uint)Marshal.SizeOf<MemoryCountersEx2>() };
            return GetProcessMemoryInfo(handle, ref counters, counters.Size)
                ? new MemoryInfo((long)counters.PrivateWorkingSetSize, (long)counters.PrivateUsage, (long)counters.WorkingSetSize)
                : null;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static bool IsAlive(int pid)
    {
        var handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == 0)
        {
            return false;
        }

        try
        {
            return GetExitCodeProcess(handle, out var code) && code == StillActive;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>Visible top-level windows of the given processes, and visible descendants of one parent window.</summary>
    public static List<WindowInfo> Windows(IReadOnlySet<int> pids, nint parent)
    {
        var list = new List<WindowInfo>();
        EnumWindows((window, _) =>
        {
            Add(list, window, pids, topLevel: true);
            return true;
        }, 0);
        if (parent != 0)
        {
            EnumChildWindows(parent, (window, _) =>
            {
                Add(list, window, null, topLevel: false);
                return true;
            }, 0);
        }

        return list;
    }

    public static void Post(nint window, uint message, nint wParam = 0) => PostMessage(window, message, wParam, 0);

    public static bool IsForeground(nint window) => GetForegroundWindow() == window;

    /// <summary>Renders one window (not the screen) into a PNG, so nothing else on the desktop is captured.</summary>
    public static bool Capture(nint window, string path)
    {
        if (!GetWindowRect(window, out var rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
        {
            return false;
        }

        using var bitmap = new Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var hdc = graphics.GetHdc();
            try
            {
                if (!PrintWindow(window, hdc, 2))
                {
                    return false;
                }
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
        }

        bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        return true;
    }

    private static void Add(List<WindowInfo> list, nint window, IReadOnlySet<int>? pids, bool topLevel)
    {
        GetWindowThreadProcessId(window, out var pid);
        if ((pids is not null && !pids.Contains(pid)) || !IsWindowVisible(window))
        {
            return;
        }

        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        var title = new StringBuilder(256);
        GetWindowText(window, title, title.Capacity);
        GetWindowRect(window, out var rect);
        list.Add(new WindowInfo(window, pid, name.ToString(), title.ToString(), topLevel, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top));
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

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(nint handle, out uint code);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(nint process, ref MemoryCountersEx2 counters, uint size);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(nint parent, EnumWindowsProc callback, nint parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out int pid);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder name, int capacity);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint window, StringBuilder text, int capacity);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint window, out Rect rect);

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    private static extern bool PostMessage(nint window, uint message, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(nint window, nint hdc, uint flags);
}
