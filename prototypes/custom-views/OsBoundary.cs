using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class OsBoundary
{
    internal static int Run(string[] args)
    {
        try
        {
            if (args[0] == "--os-child" || args[0] == "--os-descendant") return Child(args);
            return Parent(args.Contains("--control"), args.Contains("--wide-budget") ? 1024u : args.Contains("--512-mib") ? 512u : 256u, args.Contains("--terminate-tree"), args.Contains("--ipv6"), args.Contains("--http-web"), args.Contains("--breakaway"), args.Contains("--allow-breakaway"), args.Contains("--cpu-workload"), args.Contains("--cpu-control"), args.Contains("--clipboard"));
        }
        catch (Exception e) { Console.WriteLine(e); return 1; }
    }

    private static void Acl(string path, params string[] arguments)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(path);
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var p = Process.Start(info)!;
        var output = p.StandardOutput.ReadToEnd();
        var error = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception("Task-owned ACL setup failed: " + output + error);
    }

    private static int Parent(bool control, uint memoryMiB, bool terminateTree, bool ipv6, bool httpWeb, bool breakaway, bool allowBreakaway, bool cpuWorkload, bool cpuControl, bool clipboard)
    {
        if (cpuWorkload && (terminateTree || httpWeb || breakaway || clipboard)) throw new ArgumentException("CPU workload is a separate bounded lane.");
        if (clipboard && terminateTree) throw new ArgumentException("The clipboard lane needs the page to stay responsive.");
        // The supervisor owns no window; per-monitor awareness keeps injected pointer coordinates in the child's physical pixels.
        if (clipboard) OsNative.Check(OsNative.SetProcessDpiAwarenessContext(-4), "SetProcessDpiAwarenessContext");
        var run = Path.GetFullPath(Path.Combine("artifacts", "custom-view-os", Guid.NewGuid().ToString("N")));
        var payload = Path.Combine(run, "payload");
        var state = Path.Combine(run, "state");
        Directory.CreateDirectory(payload); Directory.CreateDirectory(state);
        foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(payload, Path.GetRelativePath(AppContext.BaseDirectory, file));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!); File.Copy(file, dest);
        }
        var secret = Path.Combine(run, "ungranted-synthetic-secret.txt");
        File.WriteAllText(secret, "synthetic-only");
        var name = "Nendo.W007.Probe." + Guid.NewGuid().ToString("N");
        nint sid = 0, job = 0, attributes = 0, capsBuffer = 0, environment = 0;
        OsNative.ProcessInfo process = default;
        var profileCreated = false;
        var loopback = ipv6 ? IPAddress.IPv6Loopback : IPAddress.Loopback;
        var any = ipv6 ? IPAddress.IPv6Any : IPAddress.Any;
        using var http = httpWeb ? new HttpCanary(loopback) : null;
        // Independent observer for resolver traffic: a .local query the system resolver multicasts on the page's behalf.
        using var mdns = httpWeb ? new MdnsObserver() : null;
        // Independent observer: any open of the ungranted secret by another handle breaks its oplock.
        using var opens = httpWeb ? new FileOpenObserver(secret) : null;
        var clipboardSentinel = "synthetic-clipboard-secret-" + Guid.NewGuid().ToString("N");
        DataObject? clipboardBefore = null;
        string? clipboardAfter = null;
        var clicked = false;
        int? opensBeforeBrowserNavigation = null;
        if (clipboard)
        {
            clipboardBefore = SnapshotClipboard();
            Clipboard.SetDataObject(clipboardSentinel, true);
        }
        using var udp = new UdpClient(new IPEndPoint(loopback, 0));
        using var tcp = new TcpListener(loopback, 0);
        tcp.Start();
        var udpPort = ((IPEndPoint)udp.Client.LocalEndPoint!).Port;
        var tcpPort = ((IPEndPoint)tcp.LocalEndpoint).Port;
        var packets = new List<int>();
        var browserMembership = new Dictionary<int, bool>();
        var browserTokens = new Dictionary<int, bool>();
        var suspendedMembership = new Dictionary<string, bool>();
        var suspendedChildren = new List<Process>();
        var connections = 0;
        var processors = Environment.ProcessorCount;
        Stopwatch? cpuWatch = null;
        long cpuBaseline = 0;
        Console.WriteLine("OS-PROBE " + run);
        try
        {
            var hr = OsNative.CreateAppContainerProfile(name, name, "Disposable W-007 probe; no capabilities", 0, 0, out sid);
            Marshal.ThrowExceptionForHR(hr); profileCreated = true;
            var sidText = new SecurityIdentifier(sid).Value;
            Acl(payload, "/grant", "*" + sidText + ":(OI)(CI)(RX)", "/T", "/Q");
            Acl(state, "/grant", "*" + sidText + ":(OI)(CI)(M)", "/T", "/Q");
            Acl(state, "/setintegritylevel", "(OI)(CI)L", "/T", "/Q");
            job = OsNative.CreateJobObject(0, null);
            OsNative.Check(job != 0, "CreateJobObject");
            OsNative.SetJob(job, 9, new OsNative.ExtendedLimit { basic = new() { flags = 0x2000u | 0x200u | (allowBreakaway ? 0x800u : 0u) }, jobMemory = memoryMiB * 1024 * 1024 });
            OsNative.SetJob(job, 15, new OsNative.CpuLimit { flags = 1 | 4, rate = cpuControl ? 10000u : 2000u });
            var limits = OsNative.GetJob<OsNative.ExtendedLimit>(job, 9);
            var cpu = OsNative.GetJob<OsNative.CpuLimit>(job, 15);
            Console.WriteLine(JsonSerializer.Serialize(new { jobFlags = limits.basic.flags, jobMemoryBytes = (ulong)limits.jobMemory, cpuFlags = cpu.flags, cpuRate = cpu.rate }));
            var startup = new OsNative.StartupEx();
            startup.startup.cb = Marshal.SizeOf<OsNative.StartupEx>();
            startup.startup.flags = clipboard ? 0u : 1u; // STARTF_USESHOWWINDOW, SW_HIDE, except when a real click needs the window on screen
            if (!control)
            {
                nuint size = 0;
                OsNative.InitializeProcThreadAttributeList(0, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal((nint)size);
                OsNative.Check(OsNative.InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
                var caps = new OsNative.Capabilities { sid = sid };
                capsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf<OsNative.Capabilities>());
                Marshal.StructureToPtr(caps, capsBuffer, false);
                OsNative.Check(OsNative.UpdateProcThreadAttribute(attributes, 0, 0x20009, capsBuffer, (nuint)Marshal.SizeOf<OsNative.Capabilities>(), 0, 0), "SecurityCapabilities");
                startup.attributes = attributes;
            }
            // Deliberately minimal child environment: no parent tokens, proxy settings or credentials.
            var systemRoot = Environment.GetEnvironmentVariable("SystemRoot")!;
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["SystemRoot"] = systemRoot, ["WINDIR"] = systemRoot,
                ["TEMP"] = state, ["TMP"] = state, ["LOCALAPPDATA"] = state,
                ["DOTNET_EnableDiagnostics"] = "0",
                ["PATH"] = Environment.SystemDirectory,
            };
            environment = Marshal.StringToHGlobalUni(string.Join('\0', env.Select(x => x.Key + "=" + x.Value)) + "\0\0");
            var exe = Path.Combine(payload, "BoundaryProbe.exe");
            var command = new StringBuilder($"\"{exe}\" --os-child {udpPort} {tcpPort} \"{state}\" \"{secret}\"" + (terminateTree ? " --terminate-tree" : "") + (ipv6 ? " --ipv6" : ""));
            if (http is not null) command.Append(" --http-port ").Append(http.Port).Append(" --tls-port ").Append(http.TlsPort).Append(" --mdns ").Append(mdns!.Name).Append(" --file-url \"").Append(new Uri(secret).AbsoluteUri).Append('"');
            if (clipboard) command.Append(" --clipboard");
            if (breakaway) command.Append(" --breakaway");
            if (cpuWorkload) command.Append(" --cpu-workers ").Append(processors);
            OsNative.Check(OsNative.CreateProcess(exe, command, 0, 0, false, 0x80000 | 4 | 0x400 | 0x08000000, environment, payload, ref startup, out process), "CreateProcess AppContainer");
            // Suspend first, assign before any child instruction, never permit breakaway.
            OsNative.Check(OsNative.AssignProcessToJobObject(job, process.process), "AssignProcessToJobObject");
            var isContainer = OsNative.IsAppContainer(process.process);
            OsNative.Check(OsNative.IsProcessInJob(process.process, job, out var inJob), "IsProcessInJob");
            Console.WriteLine(JsonSerializer.Serialize(new { control, pid = process.pid, isContainer, inJob }));
            if (isContainer == control || !inJob) throw new Exception("Unexpected token/job before resume");
            if (OsNative.ResumeThread(process.thread) == uint.MaxValue) throw new Exception("ResumeThread failed");
            using var child = Process.GetProcessById((int)process.pid);
            var watch = Stopwatch.StartNew();
            var treeReady = false;
            while (!child.WaitForExit(50) && watch.Elapsed < TimeSpan.FromSeconds(35))
            {
                if (cpuWorkload && cpuWatch is null && File.Exists(Path.Combine(state, "cpu-ready")))
                {
                    var accounting = OsNative.GetJob<OsNative.Accounting>(job, 1);
                    cpuBaseline = accounting.userTime + accounting.kernelTime;
                    cpuWatch = Stopwatch.StartNew();
                    File.WriteAllText(Path.Combine(state, "cpu-go"), "go");
                }
                if (breakaway)
                    foreach (var probe in new[] { "ordinary-child", "breakaway-child" })
                    {
                        var probeReport = Path.Combine(state, probe + ".json");
                        if (suspendedMembership.ContainsKey(probe) || !File.Exists(probeReport)) continue;
                        try
                        {
                            using var doc = JsonDocument.Parse(File.ReadAllText(probeReport));
                            if (!doc.RootElement.GetProperty("created").GetBoolean()) continue;
                            var candidate = Process.GetProcessById(doc.RootElement.GetProperty("pid").GetInt32());
                            suspendedChildren.Add(candidate); // Retain exact handle for final cleanup, including the control.
                            OsNative.Check(OsNative.IsProcessInJob(candidate.Handle, job, out var belongs), "Suspended child exact job");
                            suspendedMembership[probe] = belongs;
                            File.WriteAllText(Path.Combine(state, probe + ".observed"), "observed");
                        }
                        catch (JsonException) { /* Atomic report is not yet complete; retry. */ }
                    }
                while (udp.Available > 0) { IPEndPoint sender = new(any, 0); packets.Add(udp.Receive(ref sender).Length); }
                while (tcp.Pending()) { tcp.AcceptTcpClient().Dispose(); connections++; }
                var webReport = Path.Combine(state, "webview.json");
                if (File.Exists(webReport))
                {
                    try
                    {
                        // Progress is replaced by the helper; observation must not block its writes.
                        using var reportStream = new FileStream(webReport, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        using var document = JsonDocument.Parse(reportStream);
                        if (opens is not null && opensBeforeBrowserNavigation is null && document.RootElement.TryGetProperty("stage", out var stage) && stage.GetString() == "file-navigation")
                            opensBeforeBrowserNavigation = opens.Breaks; // Native attempts have finished; what follows is the browser's own open.
                        if (clipboard && !clicked && document.RootElement.TryGetProperty("click", out var click))
                        {
                            // A real pointer click from the supervisor: user activation and foreground come from the OS, not from script.
                            clicked = true;
                            OsNative.Click(click.GetProperty("x").GetInt32(), click.GetProperty("y").GetInt32());
                        }
                        if (document.RootElement.TryGetProperty("processes", out var processes))
                            foreach (var row in processes.EnumerateArray())
                            {
                                var pid = row.GetProperty("ProcessId").GetInt32();
                                if (browserMembership.ContainsKey(pid)) continue;
                                using var browserProcess = Process.GetProcessById(pid);
                                OsNative.Check(OsNative.IsProcessInJob(browserProcess.Handle, job, out var belongs), "Parent check exact job");
                                browserMembership[pid] = belongs;
                                browserTokens[pid] = OsNative.IsAppContainer(browserProcess.Handle);
                            }
                        if (terminateTree && document.RootElement.TryGetProperty("infiniteLoopStarted", out var started) && started.GetBoolean()) treeReady = true;
                    }
                    catch (JsonException) { /* Report being replaced; retry on next observation. */ }
                    catch (ArgumentException) { /* Exited process; retained report is checked below. */ }
                }
                if (treeReady) break;
            }
            var finalLimits = OsNative.GetJob<OsNative.ExtendedLimit>(job, 9);
            cpuWatch?.Stop();
            var finalAccounting = OsNative.GetJob<OsNative.Accounting>(job, 1);
            var measuredCpuSeconds = (finalAccounting.userTime + finalAccounting.kernelTime - cpuBaseline) / 10000000d;
            var cpuFraction = cpuWatch is null ? 0 : measuredCpuSeconds / cpuWatch.Elapsed.TotalSeconds / processors;
            var terminationPassed = false;
            long terminationMs = 0;
            if (treeReady)
            {
                var observedProcesses = new List<Process>();
                try
                {
                    foreach (var pid in browserMembership.Keys.Append((int)process.pid))
                    {
                        var observed = Process.GetProcessById(pid);
                        _ = observed.Handle; // Hold the exact process object through termination.
                        observedProcesses.Add(observed);
                    }
                    var timer = Stopwatch.StartNew();
                    OsNative.CloseHandle(job); job = 0;
                    terminationPassed = observedProcesses.All(p => p.WaitForExit((int)Math.Max(0, 2000 - timer.ElapsedMilliseconds)));
                    terminationMs = timer.ElapsedMilliseconds;
                }
                finally { foreach (var p in observedProcesses) p.Dispose(); }
            }
            var timedOut = !child.HasExited;
            if (timedOut) OsNative.TerminateProcess(process.process, 99);
            child.WaitForExit(5000);
            while (udp.Available > 0) { IPEndPoint sender = new(any, 0); packets.Add(udp.Receive(ref sender).Length); }
            while (tcp.Pending()) { tcp.AcceptTcpClient().Dispose(); connections++; }
            if (clipboard) clipboardAfter = Clipboard.ContainsText() ? Clipboard.GetText() : null;
            var reports = Directory.EnumerateFiles(state, "*.json").ToDictionary(p => Path.GetFileName(p), File.ReadAllText);
            OsNative.Check(OsNative.GetExitCodeProcess(process.process, out var childExit), "GetExitCodeProcess");
            bool HasValue(string file, string property, string value)
            {
                if (!reports.TryGetValue(file, out var content)) return false;
                using var doc = JsonDocument.Parse(content);
                return doc.RootElement.TryGetProperty(property, out var item) && item.ToString() == value;
            }
            bool HasPrefix(string file, string property, string prefix)
            {
                if (!reports.TryGetValue(file, out var content)) return false;
                using var doc = JsonDocument.Parse(content);
                return doc.RootElement.TryGetProperty(property, out var item) && item.ToString().StartsWith(prefix, StringComparison.Ordinal);
            }
            var checks = new Dictionary<string, bool>
            {
                ["helper-appcontainer"] = isContainer,
                ["webview-completed"] = !timedOut && (terminateTree ? terminationPassed : childExit == 0) && HasValue("webview.json", "stage", "completed"),
                ["native-and-webrtc-no-received-packets"] = packets.Count == 0 && connections == 0,
                ["helper-file-denied"] = HasValue("native.json", "ungrantedFile", "UnauthorizedAccessException"),
                ["descendant-file-denied"] = HasValue("descendant.json", "ungrantedFile", "UnauthorizedAccessException"),
                ["descendant-appcontainer"] = HasValue("descendant.json", "appContainer", "True"),
                ["browser-processes-in-exact-job"] = browserMembership.Count >= 3 && browserMembership.Values.All(v => v),
                ["browser-processes-appcontainer"] = browserTokens.Count >= 3 && browserTokens.Values.All(v => v),
                ["job-limits-readback"] = limits.jobMemory == memoryMiB * 1024 * 1024 && limits.basic.flags == 8704 && cpu.flags == 5 && cpu.rate == 2000,
            };
            if (terminateTree) checks["job-close-kills-observed-tree-within-2s"] = treeReady && terminationPassed && terminationMs <= 2000;
            if (http is not null) checks["http-web-no-received-requests"] = http.Requests.Length == 0;
            if (http is not null) checks["http-web-no-received-datagrams"] = http.Datagrams.Length == 0;
            if (http is not null) checks["websocket-no-received-messages"] = http.WebSocketMessages.Length == 0;
            if (http is not null) checks["tls-no-received-client-hello"] = http.TlsClientHellos.Length == 0;
            if (http is not null) checks["dns-native-resolution-refused"] = HasPrefix("native.json", "dns", "SocketException") && HasPrefix("descendant.json", "dns", "SocketException");
            if (mdns is not null) checks["mdns-no-resolver-query-observed"] = mdns.Queries.Length == 0;
            // Denied native opens still reach the file system and break the oplock, so the native count is reported, not asserted;
            // the ACL result is asserted by helper-file-denied and descendant-file-denied. The browser's own open is what this guard measures.
            if (opens is not null) checks["browser-file-no-open-observed"] = opensBeforeBrowserNavigation is not null && opens.Breaks == opensBeforeBrowserNavigation;
            if (clipboard)
            {
                checks["clipboard-click-delivered"] = clicked && HasValue("webview.json", "clipboardReported", "True");
                checks["clipboard-not-written"] = clipboardAfter == clipboardSentinel;
            }
            if (breakaway)
            {
                checks["ordinary-suspended-child-created-in-job"] = HasValue("ordinary-child.json", "created", "True") && suspendedMembership.GetValueOrDefault("ordinary-child");
                checks["explicit-breakaway-refused"] = HasValue("breakaway-child.json", "created", "False") && HasValue("breakaway-child.json", "error", "5");
            }
            if (cpuWorkload)
            {
                checks.Remove("webview-completed");
                checks.Remove("browser-processes-in-exact-job");
                checks.Remove("browser-processes-appcontainer");
                checks["bounded-cpu-workload-completed"] = !timedOut && childExit == 0 && File.Exists(Path.Combine(state, "cpu-done")) && cpuWatch?.Elapsed.TotalSeconds >= 8;
                // Five percentage points tolerate scheduling/measurement boundaries, not an unmeasured policy string.
                checks["measured-cpu-within-25-percent"] = cpuFraction > 0.02 && cpuFraction <= 0.25;
            }
            var result = new { control, ipv6, breakaway, allowBreakaway, cpuWorkload, cpuControl, clipboard, processors, measuredCpuSeconds, measuredWallSeconds = cpuWatch?.Elapsed.TotalSeconds, cpuFraction, isContainer, inJob, timedOut, childExit, terminateTree, terminationMs, memoryMiB, peakCommitBytes = (ulong)finalLimits.peakJobMemory, packets, connections, httpRequests = http?.Requests, httpDatagrams = http?.Datagrams, webSocketMessages = http?.WebSocketMessages, tlsClientHellos = http?.TlsClientHellos, externalName = http is null ? null : HttpCanary.ExternalName, mdnsName = mdns?.Name, mdnsQueries = mdns?.Queries, nativeFileOpenAttemptsObserved = opensBeforeBrowserNavigation, browserFileOpensObserved = opens is null || opensBeforeBrowserNavigation is null ? null : opens.Breaks - opensBeforeBrowserNavigation, fileOpensObserved = opens?.Breaks, clipboardSentinel = clipboard ? clipboardSentinel : null, clipboardAfter, clicked, browserMembership, browserTokens, suspendedMembership, checks, reports };
            var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(run, "result.json"), json); Console.WriteLine(json);
            // The same assertions run in control mode: failures must come from measurements.
            return checks.Values.All(v => v) ? 0 : 2;
        }
        finally
        {
            if (clipboard) RestoreClipboard(clipboardBefore);
            foreach (var candidate in suspendedChildren)
            {
                try { if (!candidate.HasExited) { candidate.Kill(); candidate.WaitForExit(5000); } }
                finally { candidate.Dispose(); }
            }
            if (job != 0) OsNative.CloseHandle(job); // Kills all associated descendants.
            if (process.process != 0)
            {
                // Also cover failure between suspended creation and job assignment.
                if (OsNative.GetExitCodeProcess(process.process, out var code) && code == 259)
                    OsNative.TerminateProcess(process.process, 98);
                OsNative.CloseHandle(process.process);
            }
            if (process.thread != 0) OsNative.CloseHandle(process.thread);
            if (attributes != 0) { OsNative.DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capsBuffer != 0) Marshal.FreeHGlobal(capsBuffer);
            if (environment != 0) Marshal.FreeHGlobal(environment);
            if (sid != 0) OsNative.FreeSid(sid);
            if (profileCreated) Console.WriteLine("DeleteAppContainerProfile HRESULT=0x" + OsNative.DeleteAppContainerProfile(name).ToString("X8"));
        }
    }

    /// <summary>The owner's clipboard is user state: copy every format before the lane and put it back afterwards.</summary>
    private static DataObject? SnapshotClipboard()
    {
        var current = Clipboard.GetDataObject();
        if (current is null) return null;
        var copy = new DataObject();
        foreach (var format in current.GetFormats())
        {
            try { var value = current.GetData(format); if (value is not null) copy.SetData(format, value); }
            catch (Exception e) when (e is System.Runtime.InteropServices.COMException or InvalidCastException or NotSupportedException) { }
        }
        return copy.GetFormats().Length == 0 ? null : copy;
    }

    private static void RestoreClipboard(DataObject? before)
    {
        try
        {
            if (before is null) Clipboard.Clear();
            else Clipboard.SetDataObject(before, true);
            Console.WriteLine("Clipboard restored: " + (before is null ? "empty" : string.Join(", ", before.GetFormats())));
        }
        catch (Exception e) { Console.WriteLine("Clipboard restore failed: " + e.Message); }
    }

    private static int Child(string[] args)
    {
        var udpPort = int.Parse(args[1]); var tcpPort = int.Parse(args[2]); var state = args[3]; var secret = args[4];
        var ipv6 = args.Contains("--ipv6");
        var loopback = ipv6 ? IPAddress.IPv6Loopback : IPAddress.Loopback;
        var rows = new Dictionary<string, object>();
        using var self = Process.GetCurrentProcess();
        rows["appContainer"] = OsNative.IsAppContainer(self.Handle);
        rows["pid"] = self.Id;
        try { using var socket = new UdpClient(loopback.AddressFamily); socket.Send(new byte[] { 7, 8, 9 }, new IPEndPoint(loopback, udpPort)); rows["udp"] = "sent"; }
        catch (SocketException e) { rows["udp"] = e.SocketErrorCode + ":" + e.NativeErrorCode; }
        try { using var socket = new TcpClient(loopback.AddressFamily); socket.ConnectAsync(loopback, tcpPort).WaitAsync(TimeSpan.FromSeconds(2)).GetAwaiter().GetResult(); rows["tcp"] = "connected"; }
        catch (Exception e) { rows["tcp"] = e is SocketException s ? s.SocketErrorCode + ":" + s.NativeErrorCode : e.GetType().Name; }
        try { rows["ungrantedFile"] = File.ReadAllText(secret); }
        catch (Exception e) { rows["ungrantedFile"] = e.GetType().Name; }
        // The system resolver answers on the caller's behalf; the answer says whether an AppContainer caller gets one.
        try { rows["dns"] = string.Join(",", Dns.GetHostAddresses(HttpCanary.ExternalName).Select(a => a.ToString())); }
        catch (SocketException e) { rows["dns"] = "SocketException:" + e.SocketErrorCode + ":" + e.NativeErrorCode; }
        catch (Exception e) { rows["dns"] = e.GetType().Name; }
        File.WriteAllText(Path.Combine(state, args[0] == "--os-child" ? "native.json" : "descendant.json"), JsonSerializer.Serialize(rows));
        if (args[0] == "--os-descendant") return 0;
        if (args.Contains("--breakaway"))
        {
            ProbeSuspendedChild(state, false);
            ProbeSuspendedChild(state, true);
        }
        try
        {
            var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var item in new[] { "--os-descendant", args[1], args[2], state, secret }) info.ArgumentList.Add(item);
            if (ipv6) info.ArgumentList.Add("--ipv6");
            using var p = Process.Start(info)!;
            if (!p.WaitForExit(5000)) p.Kill(true);
        }
        catch (Exception e) { File.WriteAllText(Path.Combine(state, "descendant.json"), JsonSerializer.Serialize(new { error = e.ToString() })); }
        var cpuIndex = Array.IndexOf(args, "--cpu-workers");
        if (cpuIndex >= 0) return CpuWorkload(state, int.Parse(args[cpuIndex + 1]));
        ApplicationConfiguration.Initialize();
        string? Option(string name) { var index = Array.IndexOf(args, name); return index < 0 ? null : args[index + 1]; }
        var httpPort = Option("--http-port");
        using var form = new OsWebView(state, udpPort, args.Contains("--terminate-tree"), ipv6, httpPort is null ? null : int.Parse(httpPort),
            httpPort is null ? null : new OsWebView.Extended(int.Parse(Option("--tls-port")!), Option("--mdns")!, Option("--file-url")!), args.Contains("--clipboard"));
        Application.Run(form);
        return form.ExitCode;
    }

    private static int CpuWorkload(string state, int workers)
    {
        if (workers < 1 || workers > 256) throw new ArgumentOutOfRangeException(nameof(workers));
        using var start = new ManualResetEventSlim();
        using var ready = new CountdownEvent(workers);
        var threads = Enumerable.Range(0, workers).Select(_ => new Thread(() =>
        {
            ready.Signal(); start.Wait();
            var timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < 8000) Thread.SpinWait(10000);
        }) { IsBackground = true }).ToArray();
        foreach (var thread in threads) thread.Start();
        if (!ready.Wait(5000)) throw new TimeoutException("CPU workers did not become ready.");
        File.WriteAllText(Path.Combine(state, "cpu-ready"), "ready");
        var deadline = Stopwatch.StartNew();
        while (!File.Exists(Path.Combine(state, "cpu-go")) && deadline.ElapsedMilliseconds < 5000) Thread.Sleep(10);
        if (!File.Exists(Path.Combine(state, "cpu-go"))) throw new TimeoutException("CPU supervisor did not acknowledge readiness.");
        start.Set();
        foreach (var thread in threads) thread.Join();
        File.WriteAllText(Path.Combine(state, "cpu-done"), "done");
        return 0;
    }

    private static void ProbeSuspendedChild(string state, bool breakaway)
    {
        // Never resume either synthetic child, including the deliberately escaped control.
        var startup = new OsNative.StartupEx();
        startup.startup.cb = Marshal.SizeOf<OsNative.Startup>();
        startup.startup.flags = 1;
        var exe = Environment.ProcessPath!;
        var created = OsNative.CreateProcess(exe, new StringBuilder($"\"{exe}\" --unused-suspended-canary"),
            0, 0, false, 4u | 0x08000000u | (breakaway ? 0x01000000u : 0u), 0,
            AppContext.BaseDirectory, ref startup, out var child);
        var error = created ? 0 : Marshal.GetLastWin32Error();
        try
        {
            bool? inJob = null;
            bool? appContainer = null;
            if (created)
            {
                OsNative.Check(OsNative.IsProcessInJob(child.process, 0, out var belongs), "Suspended child job membership");
                inJob = belongs;
                appContainer = OsNative.IsAppContainer(child.process);
            }
            File.WriteAllText(Path.Combine(state, breakaway ? "breakaway-child.json" : "ordinary-child.json"),
                JsonSerializer.Serialize(new { created, error, inJob, appContainer, pid = child.pid }));
            if (created)
            {
                var acknowledged = Path.Combine(state, (breakaway ? "breakaway-child" : "ordinary-child") + ".observed");
                var timer = Stopwatch.StartNew();
                while (!File.Exists(acknowledged) && timer.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                if (!File.Exists(acknowledged)) throw new Exception("Supervisor did not inspect the suspended canary.");
            }
        }
        finally
        {
            if (created)
            {
                OsNative.Check(OsNative.TerminateProcess(child.process, 0), "Terminate suspended canary");
                try
                {
                    using var observed = Process.GetProcessById((int)child.pid);
                    if (!observed.WaitForExit(5000)) throw new Exception("Suspended canary survived termination.");
                }
                catch (ArgumentException) { /* Already exited; creation handle remains held. */ }
                finally { OsNative.CloseHandle(child.thread); OsNative.CloseHandle(child.process); }
            }
        }
    }
}

internal sealed class OsWebView : Form
{
    internal sealed record Extended(int TlsPort, string MdnsName, string FileUrl);
    internal int ExitCode { get; private set; } = 1;
    // Synthetic page only. The clipboard button is a real, clickable control so user activation comes from the OS.
    private const string PageHtml = """
        <!doctype html><meta charset=utf-8><title>OS-contained synthetic graph</title>
        <h1>OS-contained synthetic graph</h1><button>Node A</button>
        <button id=clipboard style="position:fixed;left:40px;top:120px;width:200px;height:80px;font-size:20px">Clipboard</button>
        <textarea id=source style="position:fixed;left:40px;top:220px">synthetic-execcommand-canary</textarea>
        <script>
        const attempts = {};
        const note = (k, v) => { attempts[k] = String(v).slice(0, 120); };
        const post = phase => { attempts.phase = phase; chrome.webview.postMessage(JSON.stringify(attempts)); };
        document.addEventListener('pointerdown', e => note('pointerdown', e.target.id || e.target.tagName));
        document.getElementById('clipboard').addEventListener('click', async () => {
          note('isSecureContext', window.isSecureContext); note('hasClipboard', !!navigator.clipboard); note('hasFocus', document.hasFocus()); post('click');
          if (navigator.clipboard) await navigator.clipboard.readText().then(t => note('readText', t), e => note('readText', e));
          post('read');
          try { const s = document.getElementById('source'); s.focus(); s.select(); note('execCommandCopy', document.execCommand('copy')); } catch (e) { note('execCommandCopy', e); }
          post('execCommand');
          if (navigator.clipboard) await navigator.clipboard.writeText('synthetic-clipboard-canary').then(() => note('writeText', 'ok'), e => note('writeText', e));
          post('done');
        });
        </script>
        """;
    internal OsWebView(string state, int port, bool terminateTree, bool ipv6, int? httpPort, Extended? extended, bool clipboard)
    {
        ShowInTaskbar = false;
        if (clipboard) { StartPosition = FormStartPosition.Manual; Location = new Point(120, 120); Size = new Size(480, 360); TopMost = true; Text = "W-007 clipboard probe"; }
        else Opacity = 0;
        var view = new WebView2 { Dock = DockStyle.Fill }; Controls.Add(view);
        Shown += async (_, _) =>
        {
            var report = new Dictionary<string, object> { ["ready"] = false, ["stage"] = "environment" };
            void Save() => File.WriteAllText(Path.Combine(state, "webview.json"), JsonSerializer.Serialize(report));
            try
            {
                Save();
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(state, "webview-profile")).WaitAsync(TimeSpan.FromSeconds(10));
                report["stage"] = "controller"; Save();
                await view.EnsureCoreWebView2Async(env).WaitAsync(TimeSpan.FromSeconds(10));
                var core = view.CoreWebView2;
                core.ProcessFailed += (_, e) => { report["processFailure"] = e.ProcessFailedKind.ToString(); Save(); };
                // The positive control must never place a download in the owner's folders.
                core.DownloadStarting += (_, e) => { e.ResultFilePath = Path.Combine(state, "synthetic-download.txt"); e.Handled = true; };
                core.NewWindowRequested += (_, e) => e.Handled = true; // No popups from a probe; top-level file: navigation is attempted below instead.
                // Browser permissions are granted here so that only the OS boundary is measured.
                core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Allow; e.Handled = true; };
                report["stage"] = "navigation"; Save();
                var pageDirectory = Path.Combine(state, "page");
                Directory.CreateDirectory(pageDirectory);
                File.WriteAllText(Path.Combine(pageDirectory, "index.html"), PageHtml);
                core.SetVirtualHostNameToFolderMapping("probe.local", pageDirectory, CoreWebView2HostResourceAccessKind.Allow);
                TaskCompletionSource<(bool success, string status)>? pending = null;
                core.NavigationCompleted += (_, e) => pending?.TrySetResult((e.IsSuccess, e.WebErrorStatus.ToString()));
                var ready = new TaskCompletionSource<(bool success, string status)>(); pending = ready;
                core.Navigate("https://probe.local/index.html");
                if (!(await ready.Task.WaitAsync(TimeSpan.FromSeconds(5))).success) throw new Exception("Navigation failed");
                report["ready"] = true;
                report["runtime"] = env.BrowserVersionString;
                report["processes"] = env.GetProcessInfos().Select(p =>
                {
                    try { using var proc = Process.GetProcessById(p.ProcessId); OsNative.Check(OsNative.IsProcessInJob(proc.Handle, 0, out var inJob), "child job"); return (object)new { p.ProcessId, kind = p.Kind.ToString(), appContainer = OsNative.IsAppContainer(proc.Handle), inJob }; }
                    catch (Exception e) { return new { p.ProcessId, error = e.Message }; }
                }).ToArray();
                // No CSP/network hook here: this experiment measures the OS boundary alone.
                var stunHost = ipv6 ? "[::1]" : "127.0.0.1";
                await core.ExecuteScriptAsync($"window.peer=new RTCPeerConnection({{iceServers:[{{urls:'stun:{stunHost}:{port}'}}]}}); peer.createDataChannel('test'); peer.createOffer().then(o=>peer.setLocalDescription(o));");
                if (httpPort is not null)
                    await core.ExecuteScriptAsync(HttpCanary.BrowserScript(httpPort.Value, extended!.TlsPort, ipv6, extended.MdnsName, extended.FileUrl));
                if (clipboard)
                {
                    // CSS pixels become physical pixels through the page's device pixel ratio before the control maps them to the screen.
                    using var rect = JsonDocument.Parse(await core.ExecuteScriptAsync("(()=>{const r=document.getElementById('clipboard').getBoundingClientRect();const s=window.devicePixelRatio;return {x:(r.x+r.width/2)*s,y:(r.y+r.height/2)*s,ratio:s};})()"));
                    var screen = view.PointToScreen(new Point((int)rect.RootElement.GetProperty("x").GetDouble(), (int)rect.RootElement.GetProperty("y").GetDouble()));
                    report["devicePixelRatio"] = rect.RootElement.GetProperty("ratio").GetDouble();
                    var reported = new TaskCompletionSource<string>();
                    core.WebMessageReceived += (_, e) =>
                    {
                        try
                        {
                            var text = e.TryGetWebMessageAsString();
                            using var progress = JsonDocument.Parse(text);
                            report["clipboard"] = progress.RootElement.Clone(); Save(); // Every phase is durable, so a stalled step is visible.
                            if (progress.RootElement.TryGetProperty("phase", out var phase) && phase.GetString() == "done") reported.TrySetResult(text);
                        }
                        catch (Exception error) when (error is ArgumentException or JsonException) { }
                    };
                    report["stage"] = "clipboard-click";
                    report["click"] = new { x = screen.X, y = screen.Y }; Save(); // The supervisor delivers a real pointer click here.
                    try
                    {
                        using var attempts = JsonDocument.Parse(await reported.Task.WaitAsync(TimeSpan.FromSeconds(8)));
                        report["clipboard"] = attempts.RootElement.Clone(); report["clipboardReported"] = true;
                    }
                    catch (TimeoutException) { report["clipboardReported"] = false; }
                    Save();
                }
                report["stage"] = "stun-attempt"; Save();
                await Task.Delay(5000);
                report["stage"] = "close-peer"; Save();
                await core.ExecuteScriptAsync("peer.close()").WaitAsync(TimeSpan.FromSeconds(2));
                if (extended is not null && !terminateTree)
                {
                    using var attempts = JsonDocument.Parse(await core.ExecuteScriptAsync("window.fileAttempts||{}"));
                    report["fileAttempts"] = attempts.RootElement.Clone();
                    // The helper itself navigating to the ungranted file is the strongest browser-side attempt; the supervisor's oplock says whether the file was opened.
                    var navigation = new TaskCompletionSource<(bool success, string status)>(); pending = navigation;
                    report["stage"] = "file-navigation"; Save();
                    core.Navigate(extended.FileUrl);
                    var (success, status) = await navigation.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    var text = success ? await core.ExecuteScriptAsync("document.body?document.body.innerText.slice(0,64):''") : "";
                    report["fileNavigation"] = new { success, status, text };
                }
                report["stage"] = "completed";
                if (terminateTree)
                {
                    var loopStarted = new TaskCompletionSource<bool>();
                    core.WebMessageReceived += (_, e) =>
                    {
                        if (e.TryGetWebMessageAsString() == "loop-started") loopStarted.TrySetResult(true);
                    };
                    _ = core.ExecuteScriptAsync("chrome.webview.postMessage('loop-started'); while(true){}");
                    await loopStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
                    report["infiniteLoopStarted"] = true;
                }
                ExitCode = 0;
            }
            catch (Exception e) { report["error"] = e.ToString(); }
            finally { Save(); if (!terminateTree || ExitCode != 0) { view.Dispose(); Close(); } }
        };
    }
}
