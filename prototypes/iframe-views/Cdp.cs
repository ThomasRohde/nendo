using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace IframeViewsSpike;

/// <summary>
/// A minimal Chrome DevTools Protocol client on the browser endpoint of the debugging port.
/// Targets are reached through flattened sessions (Target.attachToTarget with flatten).
/// </summary>
internal sealed class Cdp : IDisposable
{
    private readonly ClientWebSocket _socket = new();
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> _pending = new();
    private readonly SemaphoreSlim _send = new(1, 1);
    private readonly Action<string, JsonNode?, string?> _onEvent;
    private int _next;

    private Cdp(Action<string, JsonNode?, string?> onEvent) => _onEvent = onEvent;

    public static async Task<Cdp> ConnectAsync(int port, Action<string, JsonNode?, string?> onEvent)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        JsonNode? version = null;
        for (var attempt = 0; version is null; attempt++)
        {
            try
            {
                version = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/json/version"));
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && attempt < 40)
            {
                await Task.Delay(250);
            }
        }

        var cdp = new Cdp(onEvent);
        await cdp._socket.ConnectAsync(new Uri((string)version!["webSocketDebuggerUrl"]!), CancellationToken.None);
        _ = Task.Run(cdp.ReceiveAsync);
        return cdp;
    }

    public async Task<JsonNode?> SendAsync(string method, JsonObject? parameters = null, string? sessionId = null, int timeoutMs = 15000)
    {
        var id = Interlocked.Increment(ref _next);
        var message = new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters ?? new JsonObject() };
        if (sessionId is not null)
        {
            message["sessionId"] = sessionId;
        }

        var waiter = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = waiter;
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await _send.WaitAsync();
        try
        {
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }
        finally
        {
            _send.Release();
        }

        try
        {
            return await waiter.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs));
        }
        catch (TimeoutException)
        {
            _pending.TryRemove(id, out _);
            throw new TimeoutException($"CDP {method} timed out after {timeoutMs} ms");
        }
    }

    public void Dispose()
    {
        _socket.Abort();
        _socket.Dispose();
    }

    private async Task ReceiveAsync()
    {
        var buffer = new byte[1 << 16];
        using var message = new MemoryStream();
        try
        {
            while (_socket.State == WebSocketState.Open)
            {
                message.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return;
                    }

                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                var node = JsonNode.Parse(message.GetBuffer().AsSpan(0, (int)message.Length));
                if (node?["id"] is JsonNode idNode)
                {
                    if (_pending.TryRemove(idNode.GetValue<int>(), out var waiter))
                    {
                        if (node["error"] is JsonNode error)
                        {
                            waiter.TrySetException(new InvalidOperationException("CDP error " + error.ToJsonString()));
                        }
                        else
                        {
                            waiter.TrySetResult(node["result"]?.DeepClone());
                        }
                    }
                }
                else if (node?["method"] is JsonNode method)
                {
                    try
                    {
                        _onEvent((string)method!, node["params"]?.DeepClone(), (string?)node["sessionId"]);
                    }
                    catch (Exception)
                    {
                        // Recording must never stop the receive loop.
                    }
                }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or OperationCanceledException)
        {
        }
        finally
        {
            foreach (var waiter in _pending.Values)
            {
                waiter.TrySetException(new InvalidOperationException("CDP connection closed"));
            }
        }
    }
}
