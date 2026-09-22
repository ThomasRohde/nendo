using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionProcessTests
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(nint handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(nint sourceProcess, nint sourceHandle, nint targetProcess,
        out nint targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernelbase.dll")]
    private static extern bool CompareObjectHandles(nint first, nint second);

    private sealed class Authority(NendoExtensionGrant granted) : INendoExtensionAuthority
    {
        private long _generation;
        public long RevocationGeneration { get => Interlocked.Read(ref _generation); set => Interlocked.Exchange(ref _generation, value); }
        public bool IsGranted(NendoExtensionGrant grant) => grant == granted && RevocationGeneration == 0;
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run this qualification from the repository output.");
    }

    private static string HelperDirectory => Path.Combine(RepositoryRoot(), "artifacts", "bin", "Nendo.ExtensionHost",
#if DEBUG
        "debug");
#else
        "release");
#endif

    private static NendoExtensionViewPackage Package(string script)
    {
        var assets = new Dictionary<string, byte[]>
        {
            ["index.html"] = Encoding.UTF8.GetBytes("<!doctype html><meta charset=utf-8><title>Synthetic graph</title><h1>Node One</h1><script src='view.js'></script>"),
            ["view.js"] = Encoding.UTF8.GetBytes(script),
        };
        using var bytes = new MemoryStream();
        using (var zip = new ZipArchive(bytes, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var asset in assets) { using var output = zip.CreateEntry(asset.Key).Open(); output.Write(asset.Value); }
            using var manifest = zip.CreateEntry("manifest.json").Open();
            JsonSerializer.Serialize(manifest, new { manifestVersion = 1, packageId = "org.nendo.test", version = "1.0.0", protocolVersion = 1,
                entryPoint = "index.html", capabilities = new[] { "projection.read", "record.select" }, license = "MIT",
                assets = assets.Select(a => new { path = a.Key, bytes = a.Value.Length, sha256 = Convert.ToHexString(SHA256.HashData(a.Value)).ToLowerInvariant() }) });
        }
        var archive = bytes.ToArray();
        return NendoExtensionViewPackage.Validate(archive, Convert.ToHexString(SHA256.HashData(archive)).ToLowerInvariant());
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task ParentInheritableEventDoesNotCrossThePrivateHandleList()
    {
        using var canary = new EventWaitHandle(false, EventResetMode.ManualReset);
        var handle = canary.SafeWaitHandle.DangerousGetHandle();
        ExtensionNative.Check(SetHandleInformation(handle, 1, 1), "Make synthetic event inheritable");
        try
        {
            var package = Package("chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){const b={version:1,session:m.session,generation:m.generation};chrome.webview.postMessage({...b,method:'ready'});chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'});}});");
            var grant = new NendoExtensionGrant("app", "instance", "handles", package.Digest, new string('d', 64));
            using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
                package, grant, new Authority(grant), new(1, [new("one", "Normal selection")], []), "light", "en", cancellation.Token);
            Assert.IsTrue((await renderer.ReceiveAsync(cancellation.Token)).Accepted);
            using var child = Process.GetProcessById(renderer.ProcessId);
            // Inherited handles preserve their value. Compare kernel identity, not just a reused numeric slot.
            if (DuplicateHandle(child.Handle, handle, -1, out var duplicate, 0, false, 2))
            {
                try { Assert.IsFalse(CompareObjectHandles(handle, duplicate), "The production helper inherited the unrelated parent event."); }
                finally { ExtensionNative.CloseHandle(duplicate); }
            }
            else Assert.AreEqual(6, Marshal.GetLastWin32Error(), "Handle inspection failed for a reason other than an absent handle.");
            GC.KeepAlive(canary);
        }
        finally { ExtensionNative.Check(SetHandleInformation(handle, 1, 0), "Restore synthetic event flags"); }
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task PrivateChannelReachesContainedBrowserAndClosingKillsItsTree()
    {
        var package = Package("chrome.webview.addEventListener('message', e => { const m=e.data; if(m.method==='initialize'){ const base={version:1,session:m.session,generation:m.generation}; chrome.webview.postMessage({...base,method:'ready'}); chrome.webview.postMessage({...base,method:'selectRecord',recordId:'one'}); while(true){} }});");
        var grant = new NendoExtensionGrant("application-test", "instance-test", "view-test", package.Digest, new string('b', 64));
        var scratch = Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, scratch, package, grant, new Authority(grant),
            new(1, [new("one", "One")], []), "light", "en", cancellation.Token);
        var selected = await renderer.ReceiveAsync(cancellation.Token);
        Assert.IsTrue(selected.Accepted, selected.Code);
        Assert.AreEqual("one", renderer.Session.GetSelection(grant, 1)?.RecordId);
        Assert.IsNotEmpty(renderer.BrowserProcessIds);
        var processes = renderer.BrowserProcessIds.Append(renderer.ProcessId).Distinct().Select(Process.GetProcessById).ToArray();
        try
        {
            foreach (var process in processes) Assert.IsTrue(ExtensionNative.IsAppContainer(process.Handle), $"Process {process.Id} is not in AppContainer.");
            var watch = Stopwatch.StartNew();
            renderer.Stop();
            foreach (var process in processes) Assert.IsTrue(process.WaitForExit((int)Math.Max(0, 2000 - watch.ElapsedMilliseconds)), $"Process {process.Id} survived job close.");
            Assert.IsTrue(renderer.Session.IsClosed);
            renderer.Dispose();
            Assert.IsNull(renderer.CleanupNotice);
        }
        finally
        {
            foreach (var process in processes)
            {
                // The deliberately broken job-close qualification must not leave its fixture running.
                if (!process.HasExited) process.Kill();
                process.Dispose();
            }
        }
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task PageCannotImpersonateTheNativeFocusEnvelope()
    {
        var package = Package("chrome.webview.addEventListener('message', e => { const m=e.data; if(m.method==='initialize'){ chrome.webview.postMessage({version:1,session:m.session,generation:m.generation,method:'ready'}); chrome.webview.postMessage({type:'focusHost'}); }});");
        var grant = new NendoExtensionGrant("application-test", "instance-test", "view-test", package.Digest, new string('b', 64));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
            package, grant, new Authority(grant), new(1, [new("one", "One")], []), "light", "en", cancellation.Token);
        var forged = await renderer.ReceiveAsync(cancellation.Token);
        Assert.IsFalse(forged.Accepted, "A page forged a native focus event.");
        Assert.AreNotEqual("focus-host", forged.Code);
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    [DataRow(false)]
    [DataRow(true)]
    public async Task BrowserEgressAttemptsDoNotReachTheLoopbackCanary(bool ipv6)
    {
        var address = ipv6 ? System.Net.IPAddress.IPv6Loopback : System.Net.IPAddress.Loopback;
        var scratch = Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime");
        Directory.CreateDirectory(scratch);
        // Outside every renderer's own run directory, so no AppContainer profile is granted access to it.
        var secret = Path.Combine(scratch, "ungranted-" + Guid.NewGuid().ToString("N") + ".txt");
        File.WriteAllText(secret, "synthetic-only");
        try
        {
            // Every automated run proves each observer works before trusting its silence.
            using (var positive = new HttpCanary(address))
            using (var positiveOpens = new FileOpenObserver(secret))
            using (var positiveMdns = new MdnsObserver("control-canary"))
            {
                using var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var host = ipv6 ? "[::1]" : "127.0.0.1";
                Assert.AreEqual("synthetic-only", await http.GetStringAsync($"http://{host}:{positive.Port}/receiver-control"));
                Assert.AreEqual("synthetic-only", await (await http.PostAsync($"http://{host}:{positive.Port}/mcp?receiver-control", new System.Net.Http.StringContent("{}"))).Content.ReadAsStringAsync());
                using var socket = new System.Net.WebSockets.ClientWebSocket();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await socket.ConnectAsync(new Uri($"ws://{host}:{positive.Port}/socket?receiver-control"), timeout.Token);
                await socket.SendAsync(Encoding.UTF8.GetBytes("synthetic-websocket-canary"), System.Net.WebSockets.WebSocketMessageType.Text, true, timeout.Token);
                using var udp = new System.Net.Sockets.UdpClient(address.AddressFamily);
                udp.Send(new byte[20], new System.Net.IPEndPoint(address, positive.Port));
                using (var tls = new System.Net.Sockets.TcpClient(address.AddressFamily))
                {
                    await tls.ConnectAsync(address, positive.TlsPort, timeout.Token);
                    await tls.GetStream().WriteAsync(new byte[] { 0x16, 3, 1, 0, 5, 1, 2, 3, 4, 5 }, timeout.Token);
                }
                File.ReadAllText(secret);
                try { System.Net.Dns.GetHostAddresses(positiveMdns.Name); } catch (System.Net.Sockets.SocketException) { }
                var timer = Stopwatch.StartNew();
                while ((positive.Datagrams.Length == 0 || positive.WebSocketMessages.Length == 0 || positive.TlsClientHellos.Length == 0 || positiveOpens.Breaks == 0 || positiveMdns.Queries.Length == 0)
                    && timer.Elapsed < TimeSpan.FromSeconds(3)) await Task.Delay(10);
                CollectionAssert.Contains(positive.Requests, "/receiver-control", "The HTTP receiver positive control was not observed.");
                CollectionAssert.Contains(positive.Requests, "POST /mcp?receiver-control", "The JSON-RPC receiver positive control was not observed.");
                Assert.IsNotEmpty(positive.Datagrams, "The UDP receiver positive control was not observed.");
                CollectionAssert.Contains(positive.WebSocketMessages, "synthetic-websocket-canary", "The WebSocket receiver positive control was not observed.");
                CollectionAssert.Contains(positive.TlsClientHellos, "0x16:10", "The TLS receiver positive control was not observed.");
                Assert.IsGreaterThanOrEqualTo(1, positiveOpens.Breaks, "The file-open observer positive control was not observed.");
                Assert.IsNotEmpty(positiveMdns.Queries, "The mDNS observer positive control was not observed; the system resolver did not multicast for this process.");
            }
            using var canary = new HttpCanary(address);
            using var opens = new FileOpenObserver(secret);
            using var mdns = new MdnsObserver();
            var script = "chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){const b={version:1,session:m.session,generation:m.generation};chrome.webview.postMessage({...b,method:'ready'});" +
                HttpCanary.BrowserScript(canary.Port, canary.TlsPort, ipv6, mdns.Name, new Uri(secret).AbsoluteUri) +
                "setTimeout(()=>chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'}),5000);}});";
            var package = Package(script);
            var grant = new NendoExtensionGrant("app", "instance", "egress", package.Digest, new string('f', 64));
            using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, scratch,
                package, grant, new Authority(grant), new(1, [new("one", "Still working")], []), "light", "en", cancellation.Token);
            Assert.IsTrue((await renderer.ReceiveAsync(cancellation.Token)).Accepted);
            Assert.AreEqual("one", renderer.Session.GetSelection(grant, 1)?.RecordId, "Normal selection failed after refused egress attempts.");
            Assert.IsEmpty(canary.Requests, "A browser request reached the receiver: " + string.Join(", ", canary.Requests));
            Assert.IsEmpty(canary.Datagrams, "A WebRTC datagram reached the receiver.");
            Assert.IsEmpty(canary.WebSocketMessages, "A WebSocket message reached the receiver.");
            Assert.IsEmpty(canary.TlsClientHellos, "A TLS client hello reached the receiver.");
            Assert.IsEmpty(mdns.Queries, "The system resolver multicast a query for the page's .local name.");
            Assert.AreEqual(0, opens.Breaks, "A browser attempt on the ungranted file reached the file system.");
        }
        finally { File.Delete(secret); }
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task MemoryPressureClosesTheContainedRendererAndItsObservedTree()
    {
        // Bounded even in a negative-control build:640MiB, not an unbounded host allocation.
        var package = Package("chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){const b={version:1,session:m.session,generation:m.generation};chrome.webview.postMessage({...b,method:'ready'});setTimeout(()=>{chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'});window.pressure=[];for(let i=0;i<40;i++){const block=new Uint8Array(16*1024*1024);block.fill(7);window.pressure.push(block)}chrome.webview.postMessage({...b,method:'selectRecord',recordId:'two'});},1000);}});");
        var grant = new NendoExtensionGrant("app", "instance", "pressure", package.Digest, new string('e', 64));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
            package, grant, new Authority(grant), new(1, [new("one", "Starting"), new("two", "Over budget")], []), "light", "en", cancellation.Token);
        var processes = renderer.BrowserProcessIds.Append(renderer.ProcessId).Distinct().Select(Process.GetProcessById).ToArray();
        try
        {
            Assert.IsTrue((await renderer.ReceiveAsync(cancellation.Token)).Accepted);
            Assert.AreEqual("one", renderer.Session.GetSelection(grant, 1)?.RecordId, "The memory workload did not begin.");
            try
            {
                var survived = await renderer.ReceiveAsync(cancellation.Token).WaitAsync(TimeSpan.FromSeconds(20));
                Assert.Fail("The renderer completed640MiB of retained allocations under its512MiB Job limit: " + survived.Code);
            }
            catch (EndOfStreamException) { }
            Assert.AreEqual("memory-pressure", renderer.ResourceStopReason, "The resource monitor did not observe memory pressure.");
            Assert.IsTrue(renderer.Session.IsClosed);
            var deadline = Stopwatch.StartNew();
            foreach (var process in processes)
                Assert.IsTrue(process.WaitForExit((int)Math.Max(0, 5000 - deadline.ElapsedMilliseconds)), "A renderer process survived memory-pressure cleanup.");
            Assert.IsNull(renderer.CleanupNotice);
        }
        finally
        {
            renderer.Dispose();
            foreach (var process in processes) process.Dispose();
        }
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task RevocationStopsASilentRendererWithoutWaitingForAnotherMessage()
    {
        var package = Package("chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize')chrome.webview.postMessage({version:1,session:m.session,generation:m.generation,method:'ready'});});");
        var grant = new NendoExtensionGrant("app", "instance", "view", package.Digest, new string('c', 64));
        var authority = new Authority(grant);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
            package, grant, authority, new(1, [], []), "dark", "da", cancellation.Token);
        using var process = Process.GetProcessById(renderer.ProcessId);
        authority.RevocationGeneration = 1;
        Assert.IsTrue(process.WaitForExit(2000), "Revocation left the silent helper running.");
        Assert.IsTrue(renderer.Session.IsClosed);
        renderer.Dispose();
        Assert.IsNull(renderer.CleanupNotice);
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task MissingReadyTimesOutAndCleansUpTheContainedHelper()
    {
        var package = Package("/* Deliberately never sends ready. */");
        var grant = new NendoExtensionGrant("app", "instance", "view", package.Digest, new string('d', 64));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var watch = Stopwatch.StartNew();
        var refused = false;
        try
        {
            using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
                package, grant, new Authority(grant), new(1, [], []), "light", "en", cancellation.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException) { refused = true; }
        Assert.IsTrue(refused, "A silent package completed its handshake.");
        Assert.IsLessThan(20000L, watch.ElapsedMilliseconds, "The five-second ready timeout did not bound startup.");
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task OfflineGraphArchiveCompletesHandshakeInTheProductionHelper()
    {
        var start = new ProcessStartInfo("pwsh") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-File"); start.ArgumentList.Add(Path.Combine(RepositoryRoot(), "tools", "Build-NendoGraphPackage.ps1"));
        using (var builder = Process.Start(start)!)
        {
            try
            {
                Assert.IsTrue(builder.WaitForExit(30000), "The graph package build did not finish.");
                Assert.AreEqual(0, builder.ExitCode, builder.StandardError.ReadToEnd());
            }
            finally { if (!builder.HasExited) builder.Kill(entireProcessTree: true); }
        }
        var archive = File.ReadAllBytes(Path.Combine(RepositoryRoot(), "artifacts", "extensions", "org.nendo.dependency-graph-0.1.0.nendoview"));
        var package = NendoExtensionViewPackage.Validate(archive, Convert.ToHexString(SHA256.HashData(archive)).ToLowerInvariant());
        Assert.AreEqual("org.nendo.dependency-graph", package.PackageId);
        Assert.AreEqual("0.1.0", package.Version);
        var grant = new NendoExtensionGrant("app", "instance", "graph", package.Digest, new string('f', 64));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
            package, grant, new Authority(grant), new(1, [new("a", "One"), new("b", "Two")], [new("edge", "a", "b")]), "dark", "en", cancellation.Token);
        Assert.IsFalse(renderer.Session.IsClosed);
        renderer.Dispose();
        Assert.IsNull(renderer.CleanupNotice);
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public void HelperRefusesAnUncontainedLaunchBeforeCreatingAWindow()
    {
        var start = new ProcessStartInfo(Path.Combine(HelperDirectory, "Nendo.ExtensionHost.exe")) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "0", "0", "unused", "unused", "index.html" }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        Assert.IsTrue(process.WaitForExit(5000));
        Assert.AreEqual(65, process.ExitCode);
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task PageFloodIsCutOffBeforeHostActionAndTheTreeExits()
    {
        // One ordinary selection first, then two hundred messages in a burst. Either the helper's bounded queue
        // ends the channel or the session's sixty-per-second window refuses; both must close the session and tree.
        var package = Package("chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){const b={version:1,session:m.session,generation:m.generation};chrome.webview.postMessage({...b,method:'ready'});chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'});setTimeout(()=>{for(let i=0;i<200;i++)chrome.webview.postMessage({...b,method:'selectRecord',recordId:'two'});},500);}});");
        var grant = new NendoExtensionGrant("app", "instance", "flood", package.Digest, new string('9', 64));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
            package, grant, new Authority(grant), new(1, [new("one", "First"), new("two", "Flood")], []), "light", "en", cancellation.Token);
        var processes = renderer.BrowserProcessIds.Append(renderer.ProcessId).Distinct().Select(Process.GetProcessById).ToArray();
        try
        {
            Assert.IsTrue((await renderer.ReceiveAsync(cancellation.Token)).Accepted, "The ordinary selection before the flood was refused.");
            Assert.AreEqual("one", renderer.Session.GetSelection(grant, 1)?.RecordId);
            var accepted = 0; string? refusal = null; var channelEnded = false;
            try
            {
                while (refusal is null && accepted < 200)
                {
                    var result = await renderer.ReceiveAsync(cancellation.Token).WaitAsync(TimeSpan.FromSeconds(10));
                    if (result.Accepted) accepted++; else refusal = result.Code;
                }
            }
            catch (Exception error) when (error is EndOfStreamException or IOException or ObjectDisposedException) { channelEnded = true; }
            Console.WriteLine($"flood: accepted {accepted}, refusal {refusal ?? "none"}, channel ended {channelEnded}");
            Assert.IsTrue(refusal is not null || channelEnded, $"All {accepted} flood messages were accepted and the channel stayed open.");
            if (refusal is not null) Assert.AreEqual("message-rate-exceeded", refusal);
            Assert.IsLessThan(200, accepted, "The whole burst reached the host.");
            Assert.IsTrue(renderer.Session.IsClosed, "The session stayed open after the flood.");
            var deadline = Stopwatch.StartNew();
            foreach (var process in processes)
                Assert.IsTrue(process.WaitForExit((int)Math.Max(0, 5000 - deadline.ElapsedMilliseconds)), $"Process {process.Id} survived the flood cut-off.");
        }
        finally
        {
            renderer.Dispose();
            foreach (var process in processes) { if (!process.HasExited) process.Kill(); process.Dispose(); }
        }
    }

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task PageClipboardAccessIsRefusedAfterARealClick()
    {
        // The AppContainer boundary does not cover the clipboard (prototype clipboard lane, 2026-09-20), so this
        // measures the helper's own policy from outside the page: a real pointer click, then the system clipboard.
        var sentinel = "synthetic-clipboard-secret-" + Guid.NewGuid().ToString("N");
        var script = """
            chrome.webview.addEventListener('message', e => {
              const m = e.data; if (m.method !== 'initialize') return;
              const b = {version:1, session:m.session, generation:m.generation};
              chrome.webview.postMessage({...b, method:'ready'});
              const button = document.createElement('button');
              button.textContent = 'Clipboard';
              button.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;font-size:32px';
              document.body.append(button);
              button.addEventListener('pointerdown', () => chrome.webview.postMessage({...b, method:'selectRecord', recordId:'clicked'}));
              button.addEventListener('click', async () => {
                let read = 0, copy = 0, write = 0, frame = 0;
                try { if (navigator.clipboard) { await navigator.clipboard.readText(); read = 1; } } catch { }
                try { const t = document.createElement('textarea'); t.value = 'synthetic-execcommand-canary'; document.body.append(t); t.focus(); t.select(); copy = document.execCommand('copy') ? 1 : 0; } catch { }
                try { if (navigator.clipboard) { await navigator.clipboard.writeText('synthetic-clipboard-canary'); write = 1; } } catch { }
                try { const f = document.createElement('iframe'); document.body.append(f); const c = f.contentWindow.navigator.clipboard; if (c) { await c.writeText('synthetic-frame-canary'); frame = 1; } } catch { }
                chrome.webview.postMessage({...b, method:'selectRecord', recordId:'r' + read + 'c' + copy + 'w' + write + 'f' + frame});
              });
            });
            """;
        var package = Package(script);
        var outcomes = (from read in new[] { 0, 1 } from copy in new[] { 0, 1 } from write in new[] { 0, 1 } from frame in new[] { 0, 1 }
                        select new NendoGraphNode($"r{read}c{copy}w{write}f{frame}", "Outcome")).Append(new NendoGraphNode("clicked", "Clicked")).ToList();
        var grant = new NendoExtensionGrant("app", "instance", "clipboard", package.Digest, new string('a', 64));
        var before = Win32Clipboard.Snapshot();
        try
        {
            Win32Clipboard.SetText(sentinel);
            Assert.AreEqual(sentinel, Win32Clipboard.GetText(), "The clipboard sentinel could not be placed.");
            using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            using var renderer = await DesktopExtensionProcess.StartAsync(HelperDirectory, Path.Combine(RepositoryRoot(), "artifacts", "extension-runtime"),
                package, grant, new Authority(grant), new(1, outcomes, []), "light", "en", cancellation.Token);
            var dpi = SetThreadDpiAwarenessContext(-4);
            try
            {
                // The helper window is transparent until a host composes it; show it on its own and click its middle.
                Assert.IsTrue(SetLayeredWindowAttributes(renderer.WindowHandle, 0, 255, 2), "The helper window could not be made opaque.");
                Assert.IsTrue(SetWindowPos(renderer.WindowHandle, -1, 120, 120, 600, 400, 0x40), "The helper window could not be placed.");
                await Task.Delay(500);
                Assert.IsTrue(GetWindowRect(renderer.WindowHandle, out var bounds));
                var x = (bounds.Left + bounds.Right) / 2; var y = (bounds.Top + bounds.Bottom) / 2;
                // This test owns a point on a real desktop that it does not own. Anything else
                // topmost over that point -- another Chromium window, a notification, an
                // installer -- swallows the click, and the failure then arrives fifteen seconds
                // later as a timeout on a receive, which says nothing about what happened. So
                // the window under the pointer is checked before the click rather than logged
                // after it, the helper is raised again between attempts, and a window that will
                // not move out of the way is named.
                nint under = 0, owner = 0;
                var className = new StringBuilder(128);
                for (var attempt = 0; attempt < 10 && owner != renderer.WindowHandle; attempt++)
                {
                    if (attempt != 0)
                    {
                        SetWindowPos(renderer.WindowHandle, -1, 120, 120, 600, 400, 0x40);
                        await Task.Delay(200);
                    }
                    Assert.IsTrue(SetCursorPos(x, y), "The pointer could not be moved.");
                    await Task.Delay(50);
                    under = WindowFromPoint(new PointStruct { X = x, Y = y });
                    // The point lands on WebView2's own render-widget window, whose process is
                    // the browser's and not the helper's. The root window is what identifies it.
                    owner = GetAncestor(under, 2);
                }
                GetWindowThreadProcessId(under, out var underProcess);
                GetClassName(under, className, 128);
                GetLayeredWindowAttributes(renderer.WindowHandle, out _, out var alpha, out _);
                Console.WriteLine($"click at {x},{y}; window under pointer {under} class {className} process {underProcess} root {owner}; helper window {renderer.WindowHandle} process {renderer.ProcessId} visible {IsWindowVisible(renderer.WindowHandle)} alpha {alpha} rect {bounds.Left},{bounds.Top},{bounds.Right},{bounds.Bottom}");
                Assert.AreEqual(renderer.WindowHandle, owner,
                    $"Another window covered the helper at {x},{y} after ten attempts: {className} in process {underProcess}. "
                    + "This measures a real click, so it needs that point on the desktop.");
                var inputs = new[] { new Input { mouse = new MouseInput { flags = 2 } }, new Input { mouse = new MouseInput { flags = 4 } } };
                Assert.AreEqual(2u, SendInput(2, inputs, Marshal.SizeOf<Input>()), "The click could not be injected.");
                await Task.Delay(1000);
            }
            finally { SetThreadDpiAwarenessContext(dpi); }
            var clicked = await renderer.ReceiveAsync(cancellation.Token).WaitAsync(TimeSpan.FromSeconds(15));
            Assert.IsTrue(clicked.Accepted, clicked.Code);
            Assert.AreEqual("clicked", renderer.Session.GetSelection(grant, 1)?.RecordId, "The real click did not reach the page.");
            var selected = await renderer.ReceiveAsync(cancellation.Token).WaitAsync(TimeSpan.FromSeconds(15));
            Assert.IsTrue(selected.Accepted, selected.Code);
            var outcome = renderer.Session.GetSelection(grant, 1)?.RecordId;
            Assert.AreEqual(sentinel, Win32Clipboard.GetText(), "The clipboard was written by the page; the page reported " + outcome + ".");
            Assert.AreEqual("r0c0w0f0", outcome, "The page reached a clipboard entry point (read, copy, write, frame).");
        }
        finally { Win32Clipboard.Restore(before); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int dx, dy; public uint mouseData, flags, time; public nint extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public MouseInput mouse; }
    [DllImport("user32.dll")] private static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetLayeredWindowAttributes(nint window, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] private struct PointStruct { public int X, Y; }
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(PointStruct point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint window, StringBuilder name, int max);
    [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(nint window, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);

    /// <summary>Raw Win32 clipboard: the owner's contents are copied format by format and put back after the lane.</summary>
    private static class Win32Clipboard
    {
        [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint owner);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint data);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint EnumClipboardFormats(uint format);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint bytes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(nint handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nuint GlobalSize(nint handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalFree(nint handle);
        private static readonly HashSet<uint> HandleFormats = [2, 3, 9, 14, 0x80, 0x82, 0x8E]; // Bitmap, metafile, palette and owner-display formats are not global memory.

        [DllImport("user32.dll", SetLastError = true)] private static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(nint desktop);

        private static void Open()
        {
            for (var attempt = 0; attempt < 20; attempt++) { if (OpenClipboard(0)) return; Thread.Sleep(50); }
            // A locked workstation makes the clipboard unreachable from this session; say so rather than blaming another process.
            var input = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
            if (input == 0) throw new InvalidOperationException("The interactive desktop is locked: this lane needs it unlocked, like the native journey.");
            CloseDesktop(input);
            throw new InvalidOperationException("The clipboard stayed open in another process.");
        }

        internal static List<(uint format, byte[] bytes)> Snapshot()
        {
            var formats = new List<(uint, byte[])>();
            Open();
            try
            {
                for (var format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format))
                {
                    if (HandleFormats.Contains(format)) continue;
                    var handle = GetClipboardData(format);
                    if (handle == 0) continue;
                    var pointer = GlobalLock(handle);
                    if (pointer == 0) continue;
                    try { var bytes = new byte[(int)GlobalSize(handle)]; Marshal.Copy(pointer, bytes, 0, bytes.Length); formats.Add((format, bytes)); }
                    finally { GlobalUnlock(handle); }
                }
            }
            finally { CloseClipboard(); }
            return formats;
        }

        internal static void Restore(List<(uint format, byte[] bytes)> formats)
        {
            Open();
            try
            {
                EmptyClipboard();
                foreach (var (format, bytes) in formats)
                {
                    var handle = GlobalAlloc(0x42, (nuint)bytes.Length);
                    var pointer = GlobalLock(handle);
                    Marshal.Copy(bytes, 0, pointer, bytes.Length);
                    GlobalUnlock(handle);
                    if (SetClipboardData(format, handle) == 0) GlobalFree(handle);
                }
            }
            finally { CloseClipboard(); }
        }

        internal static void SetText(string text) => Restore([(13, Encoding.Unicode.GetBytes(text + "\0"))]);

        internal static string? GetText()
        {
            Open();
            try
            {
                var handle = GetClipboardData(13);
                if (handle == 0) return null;
                var pointer = GlobalLock(handle);
                try { return Marshal.PtrToStringUni(pointer); }
                finally { GlobalUnlock(handle); }
            }
            finally { CloseClipboard(); }
        }
    }
}
