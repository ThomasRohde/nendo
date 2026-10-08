using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Desktop;

/// <summary>
/// A refusal the other side of an ACP connection sent: its JSON-RPC code and its sentence.
/// </summary>
internal sealed class AcpRemoteException(int code, string message) : Exception(message)
{
    internal int Code { get; } = code;
}

/// <summary>The connection ended before an answer came.</summary>
internal sealed class AcpConnectionClosedException(string message) : Exception(message);

/// <summary>A method this client does not serve. Answered as JSON-RPC's method-not-found.</summary>
internal sealed class AcpMethodNotFoundException(string method) : Exception($"Nendo does not serve {method}.");

/// <summary>
/// JSON-RPC 2.0 over two streams, one message per line, as the Agent Client Protocol carries it
/// on an agent's stdin and stdout (ADR-0030).
/// <para>
/// Both sides ask and both sides answer. Requests this side sends wait for their reply by ID;
/// requests and notifications the agent sends go to the two handlers, each request on a task of
/// its own, so a request that waits for a person (a permission prompt) never holds up the read
/// loop that delivers everything else.
/// </para>
/// <para>
/// A line is bounded. One longer than <see cref="MaximumLineBytes"/> ends the connection rather
/// than being buffered without end: the agent is a program Nendo did not write.
/// </para>
/// </summary>
internal sealed class AcpConnection : IAsyncDisposable
{
    internal const int MaximumLineBytes = 8 * 1024 * 1024;

    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly byte[] NewLine = [(byte)'\n'];

    private readonly PipeReader _input;
    private readonly Stream _output;
    private readonly Func<string, JsonElement, CancellationToken, Task<object?>> _onRequest;
    private readonly Action<string, JsonElement> _onNotification;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly CancellationTokenSource _closing = new();
    private readonly TaskCompletionSource<string> _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private long _nextId;
    private Task? _reader;

    /// <param name="input">What the agent writes: its stdout.</param>
    /// <param name="output">What the agent reads: its stdin.</param>
    internal AcpConnection(
        Stream input,
        Stream output,
        Func<string, JsonElement, CancellationToken, Task<object?>> onRequest,
        Action<string, JsonElement> onNotification)
    {
        _input = PipeReader.Create(input, new StreamPipeReaderOptions(leaveOpen: true));
        _output = output;
        _onRequest = onRequest;
        _onNotification = onNotification;
    }

    /// <summary>Completes with the reason once the connection has ended, for any reason.</summary>
    internal Task<string> Closed => _closed.Task;

    internal void Start() => _reader ??= Task.Run(ReadLoopAsync);

    /// <summary>Ask the agent something and wait for its answer.</summary>
    internal async Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken cancellationToken)
    {
        var id = Interlocked.Increment(ref _nextId);
        var answer = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = answer;
        try
        {
            if (_closed.Task.IsCompleted) throw new AcpConnectionClosedException(_closed.Task.Result);
            await WriteAsync(new { jsonrpc = "2.0", id, method, @params = parameters }, cancellationToken);
            using var registration = cancellationToken.Register(() => answer.TrySetCanceled(cancellationToken));
            return await answer.Task;
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    /// <summary>Tell the agent something that has no answer.</summary>
    internal Task NotifyAsync(string method, object? parameters, CancellationToken cancellationToken = default) =>
        WriteAsync(new { jsonrpc = "2.0", method, @params = parameters }, cancellationToken);

    private async Task WriteAsync(object message, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        await _writeLock.WaitAsync(cancellationToken);
        try
        {
            await _output.WriteAsync(bytes, cancellationToken);
            await _output.WriteAsync(NewLine, cancellationToken);
            await _output.FlushAsync(cancellationToken);
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            throw new AcpConnectionClosedException("The agent stopped reading.");
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task ReadLoopAsync()
    {
        var reason = "The agent closed its output.";
        try
        {
            while (true)
            {
                var read = await _input.ReadAsync(_closing.Token);
                var buffer = read.Buffer;
                while (TryReadLine(ref buffer, out var line))
                {
                    if (line.Length > MaximumLineBytes)
                    {
                        reason = "The agent sent a message larger than Nendo accepts.";
                        return;
                    }
                    if (line.Length > 0) Dispatch(line);
                }
                if (buffer.Length > MaximumLineBytes)
                {
                    reason = "The agent sent a message larger than Nendo accepts.";
                    return;
                }
                _input.AdvanceTo(buffer.Start, buffer.End);
                if (read.IsCompleted) return;
            }
        }
        catch (OperationCanceledException)
        {
            reason = "The connection to the agent was closed.";
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            reason = "The agent's output ended.";
        }
        finally
        {
            _closed.TrySetResult(reason);
            foreach (var pending in _pending.Values)
                pending.TrySetException(new AcpConnectionClosedException(reason));
        }
    }

    private static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
    {
        var position = buffer.PositionOf((byte)'\n');
        if (position is null)
        {
            line = default;
            return false;
        }
        line = buffer.Slice(0, position.Value);
        buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
        // A CRLF writer is still one message per line.
        if (line.Length > 0 && line.Slice(line.Length - 1).FirstSpan[0] == (byte)'\r')
            line = line.Slice(0, line.Length - 1);
        return true;
    }

    private void Dispatch(ReadOnlySequence<byte> line)
    {
        JsonDocument document;
        try
        {
            var reader = new Utf8JsonReader(line, new JsonReaderOptions { MaxDepth = 64 });
            document = JsonDocument.ParseValue(ref reader);
        }
        catch (JsonException)
        {
            // Not a message. Some agents print a banner before they speak the protocol.
            return;
        }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            var hasMethod = root.TryGetProperty("method", out var method) && method.ValueKind == JsonValueKind.String;
            var hasId = root.TryGetProperty("id", out var id) && id.ValueKind is JsonValueKind.Number or JsonValueKind.String;
            var parameters = root.TryGetProperty("params", out var value) ? value.Clone() : default;
            if (hasMethod && hasId)
            {
                var requestId = id.Clone();
                var name = method.GetString()!;
                _ = Task.Run(() => AnswerAsync(requestId, name, parameters));
            }
            else if (hasMethod)
            {
                try { _onNotification(method.GetString()!, parameters); }
                catch (Exception) { /* One bad update must not end the conversation. */ }
            }
            else if (hasId && id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var number) &&
                _pending.TryGetValue(number, out var pending))
            {
                if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
                {
                    var code = error.TryGetProperty("code", out var c) && c.TryGetInt32(out var parsed) ? parsed : -32603;
                    var message = error.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                        ? Bounded(m.GetString()!) : "The agent refused.";
                    pending.TrySetException(new AcpRemoteException(code, message));
                }
                else
                {
                    pending.TrySetResult(root.TryGetProperty("result", out var result) ? result.Clone() : default);
                }
            }
        }
    }

    private async Task AnswerAsync(JsonElement id, string method, JsonElement parameters)
    {
        object reply;
        try
        {
            var result = await _onRequest(method, parameters, _closing.Token);
            reply = new { jsonrpc = "2.0", id, result };
        }
        catch (AcpMethodNotFoundException exception)
        {
            reply = new { jsonrpc = "2.0", id, error = new { code = -32601, message = exception.Message } };
        }
        catch (AcpRemoteException exception)
        {
            reply = new { jsonrpc = "2.0", id, error = new { code = exception.Code, message = exception.Message } };
        }
        catch (Exception)
        {
            reply = new { jsonrpc = "2.0", id, error = new { code = -32603, message = "Nendo could not answer." } };
        }
        try { await WriteAsync(reply, CancellationToken.None); }
        catch (AcpConnectionClosedException) { }
    }

    /// <summary>A sentence from the agent, kept to a length a page can show.</summary>
    internal static string Bounded(string text, int maximum = 2000) =>
        text.Length <= maximum ? text : string.Concat(text.AsSpan(0, maximum), "…");

    public async ValueTask DisposeAsync()
    {
        await _closing.CancelAsync();
        if (_reader is not null)
        {
            try { await _reader.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TimeoutException) { }
        }
        _closed.TrySetResult("The connection to the agent was closed.");
        await _input.CompleteAsync();
        _closing.Dispose();
    }
}
