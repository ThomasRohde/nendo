using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;

namespace Nendo.ExtensionHost;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 5) return 64;
        try
        {
            using var process = Process.GetCurrentProcess();
            if (!OpenProcessToken(process.Handle, 8, out var token)) return 65;
            try
            {
                if (!GetTokenInformation(token, 29, out var container, 4, out _) || container != 1 ||
                    !IsProcessInJob(process.Handle, 0, out var inJob) || !inJob) return 65;
            }
            finally { CloseHandle(token); }
            using var incoming = new AnonymousPipeClientStream(PipeDirection.In, args[0]);
            using var outgoing = new AnonymousPipeClientStream(PipeDirection.Out, args[1]);
            // The browser must not inherit the host channel.
            if (!SetHandleInformation(incoming.SafePipeHandle.DangerousGetHandle(), 1, 0) ||
                !SetHandleInformation(outgoing.SafePipeHandle.DangerousGetHandle(), 1, 0)) return 66;
            ApplicationConfiguration.Initialize();
            using var window = new ExtensionWindow(incoming, outgoing, args[2], args[3], args[4]);
            Application.Run(window);
            return window.ExitCode;
        }
        catch { return 70; }
    }

    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(nint token, int kind, out int data, uint length, out uint needed);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(nint process, nint job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(nint handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
}
