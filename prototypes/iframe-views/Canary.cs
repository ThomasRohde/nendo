using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace IframeViewsSpike;

/// <summary>
/// A loopback HTTP and WebSocket listener that records every request line and header it
/// receives. It answers permissively (CORS and private/local-network allow headers) so that
/// whatever the browser decides is visible as either an arrival or an absence here.
/// </summary>
internal sealed class Canary : IDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly List<JsonObject> _hits = [];
    private readonly Func<double> _now;

    public Canary(Func<double> now)
    {
        _now = now;
        _listener.Start();
        _ = AcceptAsync();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public int Count
    {
        get
        {
            lock (_hits)
            {
                return _hits.Count;
            }
        }
    }

    public JsonArray Since(int index)
    {
        lock (_hits)
        {
            return new JsonArray(_hits.Skip(index).Select(h => (JsonNode?)h.DeepClone()).ToArray());
        }
    }

    public void Dispose() => _listener.Stop();

    private static string Cors(string origin) =>
        $"Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Allow-Local-Network: true\r\n";

    private static async Task<string> ReadHeadAsync(NetworkStream stream)
    {
        var buffer = new byte[16384];
        var length = 0;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (length < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), timeout.Token);
            if (read == 0)
            {
                break;
            }

            length += read;
            if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal))
            {
                break;
            }
        }

        var text = Encoding.ASCII.GetString(buffer, 0, length);
        var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        return end >= 0 ? text[..end] : text;
    }

    private async Task AcceptAsync()
    {
        while (true)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync();
            }
            catch (Exception ex) when (ex is SocketException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }

            _ = HandleAsync(client);
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var head = await ReadHeadAsync(stream);
                var lines = head.Split("\r\n");
                var request = lines[0].Split(' ');
                var headers = new JsonObject();
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines.Skip(1))
                {
                    var colon = line.IndexOf(':', StringComparison.Ordinal);
                    if (colon <= 0)
                    {
                        continue;
                    }

                    var name = line[..colon].Trim();
                    var value = line[(colon + 1)..].Trim();
                    map[name] = value;
                    headers[name] = value.Length > 200 ? value[..200] : value;
                }

                lock (_hits)
                {
                    _hits.Add(new JsonObject
                    {
                        ["t"] = _now(),
                        ["method"] = request[0],
                        ["path"] = request.Length > 1 ? request[1] : "",
                        ["headers"] = headers,
                    });
                }

                var origin = map.GetValueOrDefault("Origin", "*");
                if (request[0] == "OPTIONS")
                {
                    await WriteAsync(stream, "HTTP/1.1 204 No Content\r\n" + Cors(origin) +
                        "Access-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }

                if (map.TryGetValue("Upgrade", out var upgrade) && upgrade.Equals("websocket", StringComparison.OrdinalIgnoreCase))
                {
                    var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
                        map.GetValueOrDefault("Sec-WebSocket-Key", "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                    await WriteAsync(stream, $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
                    var payload = Encoding.ASCII.GetBytes("canary-ws");
                    await stream.WriteAsync(new byte[] { 0x81, (byte)payload.Length }.Concat(payload).ToArray());
                    await Task.Delay(1000);
                    await stream.WriteAsync(new byte[] { 0x88, 0x00 });
                    return;
                }

                await WriteAsync(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n" + Cors(origin) +
                    "Content-Length: 6\r\nConnection: close\r\n\r\ncanary");
            }
            catch (Exception ex) when (ex is IOException or SocketException or ObjectDisposedException or OperationCanceledException)
            {
            }
        }
    }

    private static async Task WriteAsync(NetworkStream stream, string text) =>
        await stream.WriteAsync(Encoding.ASCII.GetBytes(text));
}
