using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Disposable boundary experiment, never linked into the application.
// Listeners bind loopback only. No real file, MCP endpoint or Internet target is used.
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && args[0].StartsWith("--os-", StringComparison.Ordinal))
        {
            Environment.ExitCode = OsBoundary.Run(args);
            return;
        }
        ApplicationConfiguration.Initialize();
        using var form = new ProbeForm(args.Contains("--shared-environment"));
        Application.Run(form);
        Environment.ExitCode = form.ExitCode;
    }
}

internal sealed class ProbeForm : Form
{
    private readonly bool _shared;
    private readonly string _root = Path.GetFullPath(Path.Combine("artifacts", "custom-view-probe", Guid.NewGuid().ToString("N")));
    private readonly List<object> _results = [];
    private readonly List<uint> _browsers = [];
    private readonly WebView2 _host = new() { Dock = DockStyle.Left, Width = 400 };
    private readonly WebView2 _extension = new() { Dock = DockStyle.Fill };
    private readonly HashSet<string> _requests = [];
    private bool _allPassed = true;
    public int ExitCode { get; private set; } = 1;

    public ProbeForm(bool shared)
    {
        _shared = shared;
        Text = "W-007 disposable boundary probe";
        Width = 820; Height = 500;
        ShowInTaskbar = false;
        // The runner starts hidden; WebView2 still receives a real HWND/message loop.
        Opacity = 0;
        Controls.Add(_extension); Controls.Add(_host);
        Shown += async (_, _) => await RunAsync();
    }

    private void Record(string check, bool passed, object detail)
    {
        var row = new { check, passed, detail };
        _results.Add(row);
        _allPassed &= passed;
        Console.WriteLine(JsonSerializer.Serialize(row));
    }

    private async Task<WebView2> InitializeAsync(WebView2 view, string directory)
    {
        Console.WriteLine("INITIALIZE " + Path.GetFileName(directory));
        var env = await CoreWebView2Environment.CreateAsync(null, directory).WaitAsync(TimeSpan.FromSeconds(15));
        await view.EnsureCoreWebView2Async(env).WaitAsync(TimeSpan.FromSeconds(15));
        _browsers.Add(view.CoreWebView2.BrowserProcessId);
        var core = view.CoreWebView2;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.IsWebMessageEnabled = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.NavigationStarting += (_, e) => e.Cancel = e.Uri != "https://probe.invalid/";
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All,
            CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += (_, e) =>
        {
            Console.WriteLine("REQUEST " + e.Request.Uri);
            _requests.Add(e.Request.Uri);
            if (e.Request.Uri == "https://probe.invalid/")
            {
                // Hash-free inline script is deliberately permitted: package JS is the
                // adversary. All other sources including connect-src are denied.
                const string html = "<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'\"></head><body><h1>Synthetic records</h1><input id='record' value='Before'></body></html>";
                e.Response = env.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(html)), 200, "OK", "Content-Type: text/html");
            }
            else
                e.Response = env.CreateWebResourceResponse(new MemoryStream(), 403, "Blocked", "Content-Type: text/plain");
        };
        var ready = new TaskCompletionSource<bool>();
        core.NavigationCompleted += (_, e) => { Console.WriteLine("NAVIGATION " + e.WebErrorStatus); ready.TrySetResult(e.IsSuccess); };
        core.Navigate("https://probe.invalid/");
        if (!await ready.Task.WaitAsync(TimeSpan.FromSeconds(15))) throw new Exception("Probe document failed to load");
        return view;
    }

    private async Task RunAsync()
    {
        Directory.CreateDirectory(_root);
        try
        {
            await InitializeAsync(_host, Path.Combine(_root, "host"));
            await InitializeAsync(_extension, Path.Combine(_root, _shared ? "host" : "extension"));
            var hostId = _host.CoreWebView2.BrowserProcessId;
            var extensionId = _extension.CoreWebView2.BrowserProcessId;
            Record("independent-browser-processes", hostId != extensionId,
                new { hostId, extensionId, sharedEnvironment = _shared, runtime = _host.CoreWebView2.Environment.BrowserVersionString });

            using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
            var port = ((IPEndPoint)udp.Client.LocalEndPoint!).Port;
            // First prove the packet observer can see an ordinary local datagram.
            using (var control = new UdpClient())
                await control.SendAsync(new byte[] { 1, 2, 3 }, new IPEndPoint(IPAddress.Loopback, port));
            var calibration = await udp.ReceiveAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Record("udp-observer-control", calibration.Buffer.SequenceEqual(new byte[] { 1, 2, 3 }), new { port });

            using var tcp = new TcpListener(IPAddress.Loopback, 0);
            tcp.Start();
            var tcpPort = ((IPEndPoint)tcp.LocalEndpoint).Port;
            var tcpAccept = tcp.AcceptTcpClientAsync();
            await _extension.CoreWebView2.ExecuteScriptAsync($"fetch('http://127.0.0.1:{tcpPort}/synthetic').catch(()=>{{}}); new WebSocket('ws://127.0.0.1:{tcpPort}/synthetic');");
            await Task.Delay(500);
            Record("fetch-websocket-no-loopback-connection", !tcpAccept.IsCompleted,
                new { port = tcpPort, observationMs = 500 });
            if (tcpAccept.IsCompletedSuccessfully) tcpAccept.Result.Dispose();

            // CSP and WebResourceRequested may not mediate WebRTC UDP traffic.
            // Keep the peer alive; no microphone/camera permissions are requested.
            var launch = await _extension.CoreWebView2.ExecuteScriptAsync($"window.peer = new RTCPeerConnection({{iceServers:[{{urls:'stun:127.0.0.1:{port}'}}]}}); peer.createDataChannel('synthetic'); peer.createOffer().then(o=>peer.setLocalDescription(o)); 'started';");
            byte[]? packet = null;
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            {
                try { packet = (await udp.ReceiveAsync(timeout.Token)).Buffer; }
                catch (OperationCanceledException) { }
            }
            var stun = packet is { Length: >= 20 } && packet[4] == 0x21 && packet[5] == 0x12 && packet[6] == 0xa4 && packet[7] == 0x42;
            Record("deny-webrtc-loopback-egress", packet is null,
                new { launch, receivedBytes = packet?.Length ?? 0, stunMagicCookie = stun, interceptedStun = _requests.Any(x => x.Contains($":{port}")) });
            await _extension.CoreWebView2.ExecuteScriptAsync("peer.close()");

            if (hostId != extensionId)
            {
                // Synthetic host sentinel, not a claim about the actual Studio bridge.
                var failed = new TaskCompletionSource<bool>();
                _extension.CoreWebView2.ProcessFailed += (_, _) => failed.TrySetResult(true);
                _ = _extension.CoreWebView2.ExecuteScriptAsync("while(true){}");
                await Task.Delay(250);
                var hostRead = await _host.CoreWebView2.ExecuteScriptAsync("document.querySelector('#record').value='After'; document.querySelector('#record').value").WaitAsync(TimeSpan.FromSeconds(2));
                Record("host-script-during-extension-loop", hostRead == "\"After\"", new { hostRead });
                var timer = Stopwatch.StartNew();
                using var process = Process.GetProcessById((int)extensionId);
                process.Kill(entireProcessTree: true);
                await failed.Task.WaitAsync(TimeSpan.FromSeconds(5));
                var after = await _host.CoreWebView2.ExecuteScriptAsync("document.querySelector('#record').value").WaitAsync(TimeSpan.FromSeconds(2));
                Record("host-survives-extension-termination", after == "\"After\"" && timer.ElapsedMilliseconds < 2000,
                    new { after, elapsedMs = timer.ElapsedMilliseconds });
            }
            else
                Record("termination-skipped", false, "Shared browser process: killing it would also kill the host sentinel.");

            // A detected isolation failure is a failed boundary, even when the probe ran correctly.
            ExitCode = _allPassed ? 0 : 2;
        }
        catch (Exception ex)
        {
            Record("harness-error", false, ex.ToString());
            ExitCode = 1;
        }
        finally
        {
            _extension.Dispose(); _host.Dispose();
            File.WriteAllText(Path.Combine(_root, "results.json"), JsonSerializer.Serialize(_results, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"RESULTS {_root}");
            // Only browser IDs obtained from environments this probe created are stopped.
            foreach (var id in _browsers.Distinct())
            {
                try { using var p = Process.GetProcessById((int)id); if (!p.HasExited) p.Kill(true); }
                catch (ArgumentException) { }
            }
            Close();
        }
    }
}
