using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>One contained renderer and its private channels. Callers provide native-owned paths only.</summary>
internal sealed class DesktopExtensionProcess : IDisposable
{
    private readonly string _run;
    private readonly string _profile = "Nendo.View." + Guid.NewGuid().ToString("N");
    private readonly AnonymousPipeServerStream _toChild = new(PipeDirection.Out, HandleInheritability.Inheritable);
    private readonly AnonymousPipeServerStream _fromChild = new(PipeDirection.In, HandleInheritability.Inheritable);
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private SafeFileHandle? _job;
    private SafeFileHandle? _jobEvents;
    private string? _resourceStopReason;
    private Process? _process;
    private readonly List<Process> _browserProcesses = [];
    private NendoExtensionViewSession? _session;
    private bool _profileCreated;
    private int _disposed;
    private int _stopped;
    private readonly CancellationTokenSource _lifetime = new();
    internal nint WindowHandle { get; private set; }
    internal int ProcessId => _process?.Id ?? 0;
    internal int[] BrowserProcessIds { get; private set; } = [];
    internal string? CleanupNotice { get; private set; }
    internal string? ResourceStopReason => Volatile.Read(ref _resourceStopReason);
    internal NendoExtensionViewSession Session => _session ?? throw new InvalidOperationException("Renderer has not completed its handshake.");

    private DesktopExtensionProcess(string scratchRoot)
    {
        var root = Path.GetFullPath(scratchRoot);
        _run = Path.Combine(root, "view-" + Guid.NewGuid().ToString("N"));
        if (!Path.GetFullPath(_run).StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Invalid renderer scratch root.");
    }

    internal static async Task<DesktopExtensionProcess> StartAsync(string helperDirectory, string scratchRoot,
        NendoExtensionViewPackage package, NendoExtensionGrant grant, INendoExtensionAuthority authority,
        NendoGraphProjection projection, string theme, string locale, CancellationToken cancellationToken = default)
    {
        if (grant.PackageDigest != package.Digest || !authority.IsGranted(grant))
            throw new NendoPreconditionException("extension-not-approved", "Approve this exact view and package before opening it.");
        var generation = authority.RevocationGeneration;
        var renderer = new DesktopExtensionProcess(scratchRoot);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            // Killing the only process owning the client pipe handles also unblocks synchronous anonymous-pipe IO.
            using var registration = timeout.Token.Register(renderer.Kill);
            renderer.Launch(helperDirectory, package, () => authority.RevocationGeneration == generation && authority.IsGranted(grant), timeout.Token);
            _ = renderer.WatchAuthorityAsync(grant, authority, generation);
            var ready = await renderer.ReadEnvelopeAsync(timeout.Token);
            renderer.ValidateNativeReady(ready);
            if (authority.RevocationGeneration != generation || !authority.IsGranted(grant))
                throw new NendoPreconditionException("extension-not-approved", "The view's approval changed during startup.");
            renderer._session = new(grant, authority, projection);
            await renderer.SendAsync(renderer.Session.GetInitialization(theme, locale), timeout.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            var response = await renderer.ReceiveAsync(timeout.Token);
            if (!response.Accepted || response.Code != "ready") throw new InvalidDataException("The view did not complete its ready handshake.");
            timeout.Token.ThrowIfCancellationRequested();
            return renderer;
        }
        catch { renderer.Dispose(); throw; }
    }

    private void Launch(string helperDirectory, NendoExtensionViewPackage package, Func<bool> approved, CancellationToken cancellationToken)
    {
        var payload = Path.Combine(_run, "helper");
        var assets = Path.Combine(_run, "assets");
        var state = Path.Combine(_run, "state");
        Directory.CreateDirectory(payload); Directory.CreateDirectory(assets); Directory.CreateDirectory(state);
        CopyHelper(Path.GetFullPath(helperDirectory), payload);
        foreach (var path in package.AssetPaths)
        {
            var destination = Path.Combine(assets, path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.WriteAllBytes(destination, package.ReadAsset(path));
        }
        nint sid = 0, attributes = 0, capabilities = 0, handles = 0, environment = 0;
        var child = new ExtensionNative.ProcessInfo();
        try
        {
            Marshal.ThrowExceptionForHR(ExtensionNative.CreateAppContainerProfile(_profile, _profile, "Nendo isolated custom view", 0, 0, out sid));
            _profileCreated = true;
            var sidText = new SecurityIdentifier(sid).Value;
            Acl(payload, "/grant", "*" + sidText + ":(OI)(CI)(RX)", "/T", "/Q");
            Acl(assets, "/grant", "*" + sidText + ":(OI)(CI)(RX)", "/T", "/Q");
            Acl(state, "/grant", "*" + sidText + ":(OI)(CI)(M)", "/T", "/Q");
            Acl(state, "/setintegritylevel", "(OI)(CI)L", "/T", "/Q");
            var job = ExtensionNative.CreateJobObject(0, null);
            ExtensionNative.Check(job != 0, "CreateJobObject");
            _job = new(job, ownsHandle: true);
            var port = ExtensionNative.CreateIoCompletionPort(-1, 0, 0, 1);
            ExtensionNative.Check(port != 0, "CreateIoCompletionPort");
            _jobEvents = new(port, ownsHandle: true);
            ExtensionNative.SetJob(job, 7, new ExtensionNative.CompletionPort { key = 1, port = port });
            ExtensionNative.SetJob(job, 9, new ExtensionNative.ExtendedLimit { basic = new() { flags = 0x2000 | 0x200 | 8, activeProcesses = 32 }, jobMemory = 512u * 1024 * 1024 });
            ExtensionNative.SetJob(job, 15, new ExtensionNative.CpuLimit { flags = 5, rate = 2000 });
            // Notification-limit delivery is guaranteed; ordinary hard-limit messages are not.
            // Leave32MiB between the pressure notification and the unchanged OS hard cap.
            ExtensionNative.SetJob(job, 12, new ExtensionNative.NotificationLimit { flags = 0x200, jobMemory = 480u * 1024 * 1024 });
            var limits = ExtensionNative.GetJob<ExtensionNative.ExtendedLimit>(job, 9);
            var cpu = ExtensionNative.GetJob<ExtensionNative.CpuLimit>(job, 15);
            var notification = ExtensionNative.GetJob<ExtensionNative.NotificationLimit>(job, 12);
            if (limits.basic.flags != (0x2000 | 0x200 | 8) || limits.basic.activeProcesses != 32 || limits.jobMemory != 512u * 1024 * 1024 || cpu.flags != 5 || cpu.rate != 2000)
                throw new InvalidOperationException("The renderer resource policy was not established.");
            if (notification.flags != 0x200 || notification.jobMemory != 480u * 1024 * 1024)
                throw new InvalidOperationException("The renderer pressure notification was not established.");
            var lifetime = _lifetime.Token;
            _ = Task.Run(() => WatchResources(_jobEvents, lifetime));
            nuint size = 0;
            ExtensionNative.InitializeProcThreadAttributeList(0, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal((nint)size);
            ExtensionNative.Check(ExtensionNative.InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf<ExtensionNative.Capabilities>());
            Marshal.StructureToPtr(new ExtensionNative.Capabilities { sid = sid }, capabilities, false);
            ExtensionNative.Check(ExtensionNative.UpdateProcThreadAttribute(attributes, 0, 0x20009, capabilities, (nuint)Marshal.SizeOf<ExtensionNative.Capabilities>(), 0, 0), "SecurityCapabilities");
            handles = Marshal.AllocHGlobal(2 * nint.Size);
            Marshal.WriteIntPtr(handles, _toChild.ClientSafePipeHandle.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, nint.Size, _fromChild.ClientSafePipeHandle.DangerousGetHandle());
            ExtensionNative.Check(ExtensionNative.UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, (nuint)(2 * nint.Size), 0, 0), "HandleList");
            var systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? throw new InvalidOperationException("Windows environment is unavailable.");
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["SystemRoot"] = systemRoot, ["WINDIR"] = systemRoot, ["TEMP"] = state, ["TMP"] = state,
                ["LOCALAPPDATA"] = state, ["DOTNET_EnableDiagnostics"] = "0", ["PATH"] = Environment.SystemDirectory,
            };
            environment = Marshal.StringToHGlobalUni(string.Join('\0', env.Select(p => p.Key + "=" + p.Value)) + "\0\0");
            var executable = Path.Combine(payload, "Nendo.ExtensionHost.exe");
            var command = new StringBuilder(string.Join(' ', new[] { executable, _toChild.GetClientHandleAsString(), _fromChild.GetClientHandleAsString(), assets, state, package.EntryPoint }.Select(QuoteArgument)));
            var startup = new ExtensionNative.StartupEx { attributes = attributes };
            startup.startup.cb = Marshal.SizeOf<ExtensionNative.StartupEx>();
            startup.startup.flags = 1; // Start hidden, with no inherited standard handles.
            ExtensionNative.Check(ExtensionNative.CreateProcess(executable, command, 0, 0, true, 0x80000 | 4 | 0x400 | 0x08000000, environment, payload, ref startup, out child), "CreateProcess AppContainer");
            ExtensionNative.Check(ExtensionNative.AssignProcessToJobObject(job, child.process), "AssignProcessToJobObject");
            ExtensionNative.Check(ExtensionNative.IsProcessInJob(child.process, job, out var inJob), "IsProcessInJob");
            if (!inJob || !ExtensionNative.IsAppContainer(child.process) || ExtensionNative.AppContainerSid(child.process) != sidText)
                throw new InvalidOperationException("The suspended helper did not match its AppContainer and Job identity.");
            _process = Process.GetProcessById((int)child.pid);
            cancellationToken.ThrowIfCancellationRequested();
            if (Volatile.Read(ref _stopped) != 0 || !approved())
                throw new NendoPreconditionException("extension-not-approved", "The view's approval changed before the helper could run.");
            if (ExtensionNative.ResumeThread(child.thread) == uint.MaxValue) throw new InvalidOperationException("The contained helper could not start.");
            _toChild.DisposeLocalCopyOfClientHandle(); _fromChild.DisposeLocalCopyOfClientHandle();
        }
        catch { if (child.process != 0) ExtensionNative.TerminateProcess(child.process, 70); throw; }
        finally
        {
            if (child.thread != 0) ExtensionNative.CloseHandle(child.thread);
            if (child.process != 0) ExtensionNative.CloseHandle(child.process);
            if (attributes != 0) { ExtensionNative.DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capabilities != 0) Marshal.FreeHGlobal(capabilities);
            if (handles != 0) Marshal.FreeHGlobal(handles);
            if (environment != 0) Marshal.FreeHGlobal(environment);
            if (sid != 0) ExtensionNative.FreeSid(sid);
        }
    }

    private void ValidateNativeReady(JsonElement message)
    {
        if (message.GetProperty("type").GetString() != "ready" || message.GetProperty("processId").GetInt32() != ProcessId)
            throw new InvalidDataException("Unexpected renderer bootstrap message.");
        WindowHandle = (nint)message.GetProperty("windowHandle").GetInt64();
        ExtensionNative.GetWindowThreadProcessId(WindowHandle, out var owner);
        if (owner != ProcessId) throw new InvalidDataException("The renderer window does not belong to the contained helper.");
        BrowserProcessIds = message.GetProperty("browserProcessIds").EnumerateArray().Select(p => p.GetInt32()).ToArray();
        if (BrowserProcessIds.Length is 0 or > 31) throw new InvalidDataException("Invalid renderer process inventory.");
        foreach (var id in BrowserProcessIds)
        {
            var process = Process.GetProcessById(id);
            try
            {
                ExtensionNative.Check(ExtensionNative.IsProcessInJob(process.Handle, _job!.DangerousGetHandle(), out var inJob), "Browser job membership");
                if (!inJob || !ExtensionNative.IsAppContainer(process.Handle)) throw new InvalidOperationException("A browser process escaped containment.");
                _browserProcesses.Add(process); // Pin the observed process object, not a reusable PID.
            }
            catch { process.Dispose(); throw; }
        }
    }

    private async Task<JsonElement> ReadEnvelopeAsync(CancellationToken cancellationToken)
    {
        var bytes = await NendoExtensionFrameCodec.ReadAsync(_fromChild, 96 * 1024, cancellationToken)
            ?? throw new EndOfStreamException("The contained renderer exited.");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
        return document.RootElement.Clone();
    }

    internal async Task<NendoExtensionMessageResult> ReceiveAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var registration = cancellationToken.Register(Kill);
            var message = await ReadEnvelopeAsync(cancellationToken);
            if (message.GetProperty("type").GetString() == "focusHost" && message.EnumerateObject().Count() == 1)
                return new(true, "focus-host");
            if (message.GetProperty("type").GetString() != "view") throw new InvalidDataException("Unexpected renderer envelope.");
            var bytes = Convert.FromBase64String(message.GetProperty("data").GetString()!);
            var result = Session.Receive(bytes);
            if (Session.IsClosed) Dispose();
            return result;
        }
        catch { Dispose(); throw; }
    }

    internal async Task SendAsync(byte[] message, CancellationToken cancellationToken = default)
    {
        await _writeGate.WaitAsync(cancellationToken);
        try
        {
            using var registration = cancellationToken.Register(Kill);
            await NendoExtensionFrameCodec.WriteAsync(_toChild, message, 2 * 1024 * 1024, cancellationToken);
        }
        catch { Dispose(); throw; }
        finally { _writeGate.Release(); }
    }

    private void Kill() => Stop();

    private void WatchResources(SafeFileHandle port, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                if (!ExtensionNative.GetQueuedCompletionStatus(port, out var message, out var key, out _, 100))
                {
                    if (Marshal.GetLastWin32Error() == 258 || cancellationToken.IsCancellationRequested) continue;
                    throw new IOException("The renderer resource monitor stopped.");
                }
                if (key != 1) throw new InvalidDataException("Unexpected renderer resource notification.");
                if (message == 11) // JOB_OBJECT_MSG_NOTIFICATION_LIMIT
                {
                    var held = false;
                    ExtensionNative.LimitViolation violation;
                    try
                    {
                        _job!.DangerousAddRef(ref held);
                        violation = ExtensionNative.GetJob<ExtensionNative.LimitViolation>(_job.DangerousGetHandle(), 13);
                    }
                    finally { if (held) _job!.DangerousRelease(); }
                    if ((violation.violated & 0x200) == 0) throw new InvalidDataException("Unexpected renderer pressure limit.");
                    Volatile.Write(ref _resourceStopReason, "memory-pressure");
                    Stop(); return;
                }
                if (message is 9 or 10 or 3) // Memory or active-process hard-limit notification.
                {
                    Volatile.Write(ref _resourceStopReason, message == 3 ? "process-limit" : "memory-pressure");
                    Stop(); return;
                }
            }
        }
        catch
        {
            if (!cancellationToken.IsCancellationRequested)
            { Volatile.Write(ref _resourceStopReason, "resource-monitor-failed"); Stop(); }
        }
    }

    private async Task WatchAuthorityAsync(NendoExtensionGrant grant, INendoExtensionAuthority authority, long generation)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
            while (await timer.WaitForNextTickAsync(_lifetime.Token))
                if (authority.RevocationGeneration != generation || !authority.IsGranted(grant)) { Stop(); return; }
        }
        catch (OperationCanceledException) { }
        catch { Stop(); }
    }

    internal void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) == 0) _lifetime.Cancel();
        _session?.Dispose();
        _job?.Dispose();
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _session?.Dispose(); Kill();
        _jobEvents?.Dispose();
        _lifetime.Dispose();
        _toChild.Dispose(); _fromChild.Dispose();
        var deadline = Stopwatch.StartNew();
        try
        {
            _process?.WaitForExit(2000);
            foreach (var browser in _browserProcesses) browser.WaitForExit((int)Math.Max(0, 2000 - deadline.ElapsedMilliseconds));
        }
        catch (InvalidOperationException) { }
        foreach (var browser in _browserProcesses) browser.Dispose();
        _process?.Dispose();
        // Windows may briefly retain WebView cache handles after process termination.
        for (var attempt = 0; attempt < 20; attempt++)
        {
            CleanupNotice = null;
            if (_profileCreated)
            {
                var result = ExtensionNative.DeleteAppContainerProfile(_profile);
                if (result >= 0) _profileCreated = false;
                else CleanupNotice = "Renderer profile cleanup pending: " + result.ToString("X8");
            }
            try { if (Directory.Exists(_run)) Directory.Delete(_run, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { CleanupNotice = "The closed renderer scratch files await cleanup."; }
            if (CleanupNotice is null) break;
            Thread.Sleep(50);
        }
    }

    private static void CopyHelper(string source, string destination)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("Helper payload links are not supported.");
        foreach (var item in Directory.EnumerateFileSystemEntries(source))
        {
            var attributes = File.GetAttributes(item);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Helper payload links are not supported.");
            var target = Path.Combine(destination, Path.GetFileName(item));
            if ((attributes & FileAttributes.Directory) != 0) { Directory.CreateDirectory(target); CopyHelper(item, target); }
            else File.Copy(item, target);
        }
    }

    private static string QuoteArgument(string value) => "\"" + value.Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    private static void Acl(string path, params string[] arguments)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(path); foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Cannot configure the renderer directories.");
        var output = process.StandardOutput.ReadToEnd(); var error = process.StandardError.ReadToEnd(); process.WaitForExit();
        if (process.ExitCode != 0) throw new IOException("Cannot configure renderer access: " + output + error);
    }
}
