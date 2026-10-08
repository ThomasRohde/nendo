using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Nendo.Desktop;

/// <summary>
/// One agent program, started for one conversation (ADR-0030).
/// <para>
/// It runs in a Job Object that ends it, and every process it starts, when the job's handle
/// closes: when the conversation ends, and when the host itself ends for any reason. The
/// program is assigned to the job straight after it starts; a child it started in that first
/// instant would escape the job, which is why the handle is closed only after the program is
/// asked to stop.
/// </para>
/// <para>
/// Its working directory is an empty folder made for it. Its environment is the person's own,
/// because that is where the program finds its sign-in. Its error output is kept as a short
/// tail, so a program that stops at once can say why.
/// </para>
/// </summary>
internal sealed class AgentProcess : IAsyncDisposable
{
    private const int StandardErrorTailCharacters = 4000;

    private readonly Process _process;
    private readonly SafeJobHandle _job;
    private readonly StringBuilder _stderr = new();
    private readonly Task _stderrPump;
    private int _disposed;

    private AgentProcess(Process process, SafeJobHandle job)
    {
        _process = process;
        _job = job;
        ProcessId = process.Id;
        _stderrPump = Task.Run(PumpStandardErrorAsync);
    }

    internal Stream StandardOutput => _process.StandardOutput.BaseStream;
    internal Stream StandardInput => _process.StandardInput.BaseStream;
    /// <summary>The program's process ID, kept so it can still be named once the program has ended.</summary>
    internal int ProcessId { get; }
    internal Task Exited => _process.WaitForExitAsync();
    /// <summary>The exit code once the program has ended, or null while it runs or once it is disposed.</summary>
    internal int? ExitCode
    {
        get
        {
            try { return _process.HasExited ? _process.ExitCode : null; }
            catch (InvalidOperationException) { return null; }
        }
    }

    /// <summary>The last of what the program wrote to its error output.</summary>
    internal string StandardErrorTail
    {
        get { lock (_stderr) return _stderr.ToString().Trim(); }
    }

    /// <summary>
    /// Start <paramref name="command"/> in <paramref name="workingDirectory"/>. Throws
    /// <see cref="Win32Exception"/> when Windows cannot start it.
    /// </summary>
    internal static AgentProcess Start(DesktopAgentCommand command, string workingDirectory)
    {
        var job = SafeJobHandle.CreateKillOnClose();
        var start = command.StartInfo();
        start.WorkingDirectory = workingDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = new UTF8Encoding(false);
        start.StandardErrorEncoding = new UTF8Encoding(false);
        start.StandardInputEncoding = new UTF8Encoding(false);
        Process? process = null;
        try
        {
            process = Process.Start(start) ?? throw new Win32Exception("The agent program did not start.");
            if (!AssignProcessToJobObject(job, process.SafeHandle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The agent program could not be placed in its job.");
            return new AgentProcess(process, job);
        }
        catch
        {
            try { process?.Kill(entireProcessTree: true); } catch (Exception) { }
            process?.Dispose();
            job.Dispose();
            throw;
        }
    }

    private async Task PumpStandardErrorAsync()
    {
        var buffer = new char[1024];
        try
        {
            while (true)
            {
                var read = await _process.StandardError.ReadAsync(buffer);
                if (read == 0) return;
                lock (_stderr)
                {
                    _stderr.Append(buffer, 0, read);
                    if (_stderr.Length > StandardErrorTailCharacters)
                        _stderr.Remove(0, _stderr.Length - StandardErrorTailCharacters);
                }
            }
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    /// <summary>End the program and everything it started. Safe to call more than once.</summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _process.StandardInput.Close(); } catch (Exception) { }
        // Closing the job's only handle ends every process in it: the program, a shim's
        // interpreter and whatever either of them started.
        _job.Dispose();
        try
        {
            if (!_process.HasExited) _process.Kill(entireProcessTree: true);
            await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception) { }
        try { await _stderrPump.WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception) { }
        _process.Dispose();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeJobHandle job, SafeProcessHandle process);

    /// <summary>A Job Object whose processes all end when this handle closes.</summary>
    internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        public SafeJobHandle() : base(ownsHandle: true) { }

        internal static SafeJobHandle CreateKillOnClose()
        {
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "The agent's job could not be created.");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
            };
            var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                {
                    var error = Marshal.GetLastWin32Error();
                    job.Dispose();
                    throw new Win32Exception(error, "The agent's job could not be limited.");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
            return job;
        }

        protected override bool ReleaseHandle() => CloseHandle(handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeJobHandle CreateJobObjectW(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(SafeJobHandle job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
