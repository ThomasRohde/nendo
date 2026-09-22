using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>Disposable loopback receiver; serves synthetic bytes only.</summary>
internal sealed class HttpCanary : IDisposable
{
    private readonly TcpListener _listener;
    private readonly TcpListener _tls;
    private readonly UdpClient _udp;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _clients = [];
    private readonly ConcurrentQueue<string> _requests = [];
    private readonly ConcurrentQueue<int> _datagrams = [];
    private readonly ConcurrentQueue<string> _webSocketMessages = [];
    private readonly ConcurrentQueue<string> _tlsClientHellos = [];
    private readonly Task _accept;
    private readonly Task _acceptTls;
    private readonly Task _receive;
    internal int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    internal int TlsPort => ((IPEndPoint)_tls.LocalEndpoint).Port;
    internal string[] Requests => _requests.ToArray();
    internal int[] Datagrams => _datagrams.ToArray();
    internal string[] WebSocketMessages => _webSocketMessages.ToArray();
    /// <summary>First bytes of each connection to the TLS port: record-type byte and length read.</summary>
    internal string[] TlsClientHellos => _tlsClientHellos.ToArray();
    /// <summary>A public IANA-operated name on a closed port: the name must be resolved, at most one connection attempt leaves, and no payload can follow.</summary>
    internal const string ExternalName = "www.example.com";
    internal string BrowserScript(bool ipv6, string mdnsName, string? fileUrl) => BrowserScript(Port, TlsPort, ipv6, mdnsName, fileUrl);
    internal static string BrowserScript(int port, int tlsPort, bool ipv6, string mdnsName, string? fileUrl)
    {
        var host = ipv6 ? "[::1]" : "127.0.0.1";
        var address = JsonSerializer.Serialize($"http://{host}:{port}");
        var tls = JsonSerializer.Serialize($"https://{host}:{tlsPort}");
        var dns = JsonSerializer.Serialize($"http://{ExternalName}:65535/dns?probe-canary");
        var mdns = JsonSerializer.Serialize($"http://{mdnsName}:65535/mdns?probe-canary");
        var file = JsonSerializer.Serialize(fileUrl ?? "");
        return $$"""
            (() => {
              const base = {{address}};
              const attempt = run => { try { run(); } catch {} };
              attempt(() => { window.egressPeer = new RTCPeerConnection({iceServers:[{urls:'stun:{{host}}:{{port}}'}]}); egressPeer.createDataChannel('egress'); egressPeer.createOffer().then(o=>egressPeer.setLocalDescription(o)).catch(()=>{}); setTimeout(()=>egressPeer.close(),5000); });
              attempt(() => fetch(base + '/fetch?probe-canary', {mode:'no-cors'}).catch(()=>{}));
              attempt(() => fetch(base + '/redirect?probe-canary', {mode:'no-cors'}).catch(()=>{}));
              attempt(() => fetch('http://localhost:{{port}}/host-name?probe-canary', {mode:'no-cors'}).catch(()=>{}));
              attempt(() => fetch(base + '/mcp?probe-canary', {method:'POST', mode:'no-cors', headers:{'content-type':'text/plain'}, body:JSON.stringify({jsonrpc:'2.0', id:1, method:'initialize', params:{ } }) }).catch(()=>{ }));
              attempt(() => fetch({{tls}} + '/tls?probe-canary', {mode:'no-cors'}).catch(()=>{}));
              attempt(() => fetch({{dns}}, {mode:'no-cors'}).catch(()=>{}));
              attempt(() => fetch({{mdns}}, {mode:'no-cors'}).catch(()=>{}));
              attempt(() => { window.socket = new WebSocket(base.replace('http:', 'ws:') + '/socket?probe-canary'); socket.onopen = () => socket.send('synthetic-websocket-canary'); });
              attempt(() => { const frame = document.createElement('iframe'); frame.src = base + '/frame?probe-canary'; document.body.append(frame); });
              attempt(() => { const code = 'fetch(' + JSON.stringify(base + '/worker?probe-canary') + ',{mode:"no-cors"}).catch(()=>{})'; window.worker = new Worker(URL.createObjectURL(new Blob([code], {type:'text/javascript'}))); });
              attempt(() => { const link = document.createElement('a'); link.href = base + '/download?probe-canary'; link.download = 'synthetic-download.txt'; document.body.append(link); link.click(); });
              const fileUrl = {{file}};
              if (fileUrl) {
                window.fileAttempts = {};
                const note = (name, value) => { window.fileAttempts[name] = String(value).slice(0, 120); };
                attempt(() => fetch(fileUrl).then(r => r.text()).then(t => note('fetch', 'read:' + t)).catch(e => note('fetch', e)));
                attempt(() => { const frame = document.createElement('iframe'); frame.src = fileUrl; frame.onload = () => note('iframe', 'load'); frame.onerror = () => note('iframe', 'error'); document.body.append(frame); });
                attempt(() => { const image = new Image(); image.onload = () => note('img', 'load'); image.onerror = () => note('img', 'error'); image.src = fileUrl; });
                attempt(() => { const script = document.createElement('script'); script.onload = () => note('script', 'load'); script.onerror = () => note('script', 'error'); script.src = fileUrl; document.head.append(script); });
                attempt(() => { try { window.fileWorker = new Worker(fileUrl); note('worker', 'constructed'); } catch (e) { note('worker', e); } });
                attempt(() => { const x = new XMLHttpRequest(); x.onload = () => note('xhr', 'read:' + x.responseText); x.onerror = () => note('xhr', 'error'); x.open('GET', fileUrl); x.send(); });
              }
            })();
            """;
    }
    internal HttpCanary(IPAddress address)
    {
        // The UDP receiver shares the HTTP port number. Windows excludes UDP port ranges that TCP does not
        // (Hyper-V reservations), so an ephemeral TCP port can be unbindable for UDP: take another one.
        TcpListener? listener = null; UdpClient? udp = null;
        for (var attempt = 0; ; attempt++)
        {
            listener = new(address, 0);
            udp = new(address.AddressFamily) { ExclusiveAddressUse = true };
            try { listener.Start(); udp.Client.Bind(new IPEndPoint(address, ((IPEndPoint)listener.LocalEndpoint).Port)); break; }
            catch (SocketException) when (attempt < 32) { listener.Stop(); udp.Dispose(); }
            catch { listener.Stop(); udp.Dispose(); throw; }
        }
        _listener = listener; _udp = udp;
        _tls = new(address, 0);
        try { _tls.Start(); }
        catch { _listener.Stop(); _udp.Dispose(); throw; }
        _accept = AcceptAsync(); _acceptTls = AcceptTlsAsync(); _receive = ReceiveAsync();
    }
    private async Task ReceiveAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
                _datagrams.Enqueue((await _udp.ReceiveAsync(_stop.Token)).Buffer.Length);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) when (_stop.IsCancellationRequested) { }
        catch (SocketException) when (_stop.IsCancellationRequested) { }
    }
    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                _clients.Add(ServeAsync(client));
            }
        }
        catch (OperationCanceledException) { }
        catch (SocketException) when (_stop.IsCancellationRequested) { }
        catch (InvalidOperationException) when (_stop.IsCancellationRequested) { }
    }
    private async Task AcceptTlsAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _tls.AcceptTcpClientAsync(_stop.Token);
                _clients.Add(RecordClientHelloAsync(client));
            }
        }
        catch (OperationCanceledException) { }
        catch (SocketException) when (_stop.IsCancellationRequested) { }
        catch (InvalidOperationException) when (_stop.IsCancellationRequested) { }
    }
    /// <summary>Records the TLS record header a client sends; no certificate or handshake is ever completed.</summary>
    private async Task RecordClientHelloAsync(TcpClient client)
    {
        using (client)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                var bytes = new byte[64];
                var read = await client.GetStream().ReadAsync(bytes, timeout.Token);
                if (read > 0) _tlsClientHellos.Enqueue($"0x{bytes[0]:x2}:{read}");
            }
            catch (Exception error) when (error is IOException or SocketException or OperationCanceledException) { }
        }
    }
    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                var stream = client.GetStream();
                var bytes = new byte[4096]; var length = 0;
                while (length < bytes.Length)
                {
                    var read = await stream.ReadAsync(bytes.AsMemory(length), timeout.Token);
                    if (read == 0) return;
                    length += read;
                    if (Encoding.ASCII.GetString(bytes, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal)) break;
                }
                var lines = Encoding.ASCII.GetString(bytes, 0, length).Split("\r\n");
                var first = lines[0].Split(' ');
                if (first.Length != 3 || first[0] is not ("GET" or "POST")) return;
                var path = first[1]; _requests.Enqueue(first[0] == "POST" ? "POST " + path : path);
                if (path.StartsWith("/socket?", StringComparison.Ordinal))
                {
                    var key = lines.FirstOrDefault(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))?.Split(':', 2)[1].Trim();
                    if (key is null) return;
                    // SHA-1 here is the WebSocket handshake protocol, never a security digest.
                    var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                    await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"), timeout.Token);
                    using var socket = WebSocket.CreateFromStream(stream, true, null, Timeout.InfiniteTimeSpan);
                    var message = new byte[256];
                    var received = await socket.ReceiveAsync(message.AsMemory(), timeout.Token);
                    if (received.MessageType == WebSocketMessageType.Text && received.EndOfMessage)
                        _webSocketMessages.Enqueue(Encoding.UTF8.GetString(message, 0, received.Count));
                    return;
                }
                var redirect = path.StartsWith("/redirect?", StringComparison.Ordinal);
                var body = redirect ? "" : "synthetic-only";
                var header = redirect ? "HTTP/1.1 302 Found\r\nLocation: /redirected?probe-canary\r\n" : "HTTP/1.1 200 OK\r\n";
                header += "Access-Control-Allow-Origin: *\r\nContent-Type: " +
                    (path.StartsWith("/download?", StringComparison.Ordinal) ? "application/octet-stream" : "text/plain") +
                    "\r\nConnection: close\r\nContent-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\n\r\n";
                await stream.WriteAsync(Encoding.UTF8.GetBytes(header + body), timeout.Token);
            }
            catch (Exception error) when (error is IOException or SocketException or WebSocketException or OperationCanceledException) { }
        }
    }
    public void Dispose()
    {
        _stop.Cancel(); _listener.Stop(); _tls.Stop(); _udp.Dispose();
        Task.WhenAll(_accept, _acceptTls, _receive).GetAwaiter().GetResult();
        Task.WhenAll(_clients).GetAwaiter().GetResult(); _stop.Dispose();
    }
}

/// <summary>
/// Listens on the mDNS multicast group. Windows resolves a .local name by multicasting a query from the DNS
/// Client service, and the sender's own host receives a copy, so a query carrying this observer's unique label
/// was issued by the system resolver on the page's behalf. This never answers a query.
/// </summary>
internal sealed class MdnsObserver : IDisposable
{
    private readonly UdpClient _socket = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentQueue<string> _queries = [];
    private readonly Task _receive;
    private readonly byte[] _labelBytes;
    internal string Name { get; }
    /// <summary>Datagrams carrying the label, as sender and length.</summary>
    internal string[] Queries => _queries.ToArray();
    internal MdnsObserver(string prefix = "probe-canary")
    {
        Name = prefix + "-" + Guid.NewGuid().ToString("N")[..12] + ".local";
        _labelBytes = Encoding.ASCII.GetBytes(Name[..Name.IndexOf('.')]);
        _socket.ExclusiveAddressUse = false;
        _socket.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _socket.Client.Bind(new IPEndPoint(IPAddress.Any, 5353));
        _socket.JoinMulticastGroup(IPAddress.Parse("224.0.0.251"));
        _receive = ReceiveAsync();
    }
    private async Task ReceiveAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var result = await _socket.ReceiveAsync(_stop.Token);
                if (result.Buffer.AsSpan().IndexOf(_labelBytes) >= 0) _queries.Enqueue(result.RemoteEndPoint + ":" + result.Buffer.Length);
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) when (_stop.IsCancellationRequested) { }
        catch (SocketException) when (_stop.IsCancellationRequested) { }
    }
    public void Dispose()
    {
        _stop.Cancel(); _socket.Dispose();
        _receive.GetAwaiter().GetResult(); _stop.Dispose();
    }
}

/// <summary>
/// Counts opens of one file by any other handle, using a batch oplock the file system breaks
/// before it lets another open proceed. The observer never reads the file and acknowledges each
/// break by closing its handle, so the opener is delayed by microseconds, not blocked.
/// </summary>
internal sealed class FileOpenObserver : IDisposable
{
    private const uint FsctlRequestBatchOplock = 0x00090008;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(nint handle, uint code, nint input, uint inputSize, nint output, uint outputSize, out uint returned, nint overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);
    private readonly string _path;
    private readonly Thread _thread;
    private nint _handle;
    private int _breaks;
    private volatile bool _stop;
    private int _granted;
    internal int Breaks => Volatile.Read(ref _breaks);
    internal bool EverGranted => Volatile.Read(ref _granted) != 0;
    internal FileOpenObserver(string path)
    {
        _path = Path.GetFullPath(path);
        _thread = new Thread(Observe) { IsBackground = true, Name = "file-open-observer" };
        _thread.Start();
        var timer = Stopwatch.StartNew();
        while (!EverGranted && timer.ElapsedMilliseconds < 5000) Thread.Sleep(10);
        if (!EverGranted) throw new InvalidOperationException("The file-open observer never obtained its oplock: " + _path);
    }
    private void Observe()
    {
        using var signal = new ManualResetEvent(false);
        // The handle is never bound to the thread pool, so this plain overlapped block is safe.
        var overlapped = Marshal.AllocHGlobal(Marshal.SizeOf<NativeOverlapped>());
        try
        {
            while (!_stop)
            {
                var handle = CreateFileW(_path, 0x80000000 /* GENERIC_READ */, 7 /* read, write, delete */, 0, 3 /* OPEN_EXISTING */, 0x40000000 /* FILE_FLAG_OVERLAPPED */, 0);
                if (handle == -1) { Thread.Sleep(20); continue; }
                Volatile.Write(ref _handle, handle);
                signal.Reset();
                Marshal.StructureToPtr(new NativeOverlapped { EventHandle = signal.SafeWaitHandle.DangerousGetHandle() }, overlapped, false);
                var immediate = DeviceIoControl(handle, FsctlRequestBatchOplock, 0, 0, 0, 0, out _, overlapped);
                var error = immediate ? 0 : Marshal.GetLastWin32Error();
                if (!immediate && error == 997 /* ERROR_IO_PENDING: the oplock is held until another open breaks it */)
                {
                    Interlocked.Exchange(ref _granted, 1);
                    signal.WaitOne();
                    if (!_stop) Interlocked.Increment(ref _breaks);
                }
                // 300 is ERROR_OPLOCK_NOT_GRANTED: another handle is open right now; retry shortly.
                if (Interlocked.Exchange(ref _handle, 0) == handle) CloseHandle(handle); // Closing acknowledges a break.
                if (!_stop) Thread.Sleep(20);
            }
        }
        finally { Marshal.FreeHGlobal(overlapped); }
    }
    public void Dispose()
    {
        _stop = true;
        var handle = Interlocked.Exchange(ref _handle, 0);
        if (handle != 0) CloseHandle(handle); // Cancels the pending request and wakes the observer.
        _thread.Join(5000);
    }
}
