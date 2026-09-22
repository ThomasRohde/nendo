using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class OsNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct Startup
    {
        public int cb;
        public nint reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort show, reservedBytes;
        public nint reserved2, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupEx { public Startup startup; public nint attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public nint process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] internal struct Capabilities { public nint sid, capabilities; public uint count, reserved; }
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimit
    {
        public long processTime, jobTime;
        public uint flags;
        public nuint minWorkingSet, maxWorkingSet;
        public uint activeProcesses;
        public nuint affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimit
    {
        public BasicLimit basic;
        public IoCounters io;
        public nuint processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct CpuLimit { public uint flags, rate; }
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting
    {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int CreateAppContainerProfile(string name, string display, string description, nint caps, uint count, out nint sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] internal static extern nint FreeSid(nint sid);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(nint list, int count, int flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(nint list, uint flags, nuint attribute, nint value, nuint size, nint previous, nint returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(nint list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcess(string application, StringBuilder command, nint processAttributes, nint threadAttributes, bool inherit, uint flags, nint environment, string directory, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(nint process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(nint process, out uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern nint CreateJobObject(nint security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(nint job, int kind, nint data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(nint job, int kind, nint data, uint size, out uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(nint job, nint process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(nint process, nint job, out bool result);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(nint process, uint desired, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(nint token, int kind, nint data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput { public int dx, dy; public uint mouseData, flags, time; public nint extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { public uint type; public MouseInput mouse; }

    /// <summary>A real left click at screen coordinates, injected by the supervisor process.</summary>
    internal static void Click(int x, int y)
    {
        Check(SetCursorPos(x, y), "SetCursorPos");
        Thread.Sleep(50);
        var inputs = new[] { new Input { mouse = new MouseInput { flags = 2 } }, new Input { mouse = new MouseInput { flags = 4 } } };
        Check(SendInput(2, inputs, Marshal.SizeOf<Input>()) == 2, "SendInput");
    }

    internal static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    internal static bool IsAppContainer(nint process)
    {
        Check(OpenProcessToken(process, 8, out var token), "OpenProcessToken");
        var buffer = Marshal.AllocHGlobal(4);
        try { Check(GetTokenInformation(token, 29, buffer, 4, out _), "TokenIsAppContainer"); return Marshal.ReadInt32(buffer) != 0; }
        finally { Marshal.FreeHGlobal(buffer); CloseHandle(token); }
    }

    internal static void SetJob<T>(nint job, int kind, T value) where T : struct
    {
        var length = Marshal.SizeOf<T>();
        var buffer = Marshal.AllocHGlobal(length);
        try { Marshal.StructureToPtr(value, buffer, false); Check(SetInformationJobObject(job, kind, buffer, (uint)length), "SetInformationJobObject"); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static T GetJob<T>(nint job, int kind) where T : struct
    {
        var length = Marshal.SizeOf<T>();
        var buffer = Marshal.AllocHGlobal(length);
        try { Check(QueryInformationJobObject(job, kind, buffer, (uint)length, out _), "QueryInformationJobObject"); return Marshal.PtrToStructure<T>(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}
