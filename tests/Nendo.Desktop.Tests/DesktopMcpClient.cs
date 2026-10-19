using System.Diagnostics;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The one way this suite's tests connect an MCP client to a host they started.
///
/// Three copies each allowed 5 s for the host's first answer, half of what the LocalMcp suite
/// allows, and under the full gate a fresh host took longer: "Initialization timed out" in
/// DesktopAgentSettingsTests on 2026-10-05, 2026-10-10 and 2026-10-12, never alone. The bound is
/// now the LocalMcp suite's, and a slow handshake says how long it took and what this process's
/// thread pool was doing, so a stall shows rather than hides behind the longer bound.
/// </summary>
internal static class DesktopMcpClient
{
    internal static readonly TimeSpan HandshakeBound = TimeSpan.FromSeconds(10);

    internal static async Task<McpClient> ConnectAsync(string endpoint, string name)
    {
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri(endpoint),
            TransportMode = HttpTransportMode.StreamableHttp,
            ConnectionTimeout = HandshakeBound,
        });
        var elapsed = Stopwatch.StartNew();
        McpClient client;
        try
        {
            client = await McpClient.CreateAsync(transport, Options(name));
        }
        catch (Exception error) when (error is McpException or TimeoutException)
        {
            throw new InvalidOperationException($"{error.Message} [after {elapsed.ElapsedMilliseconds} ms; {PoolState()}]", error);
        }
        if (elapsed.Elapsed > TimeSpan.FromSeconds(1)) Console.WriteLine($"HANDSHAKE {elapsed.ElapsedMilliseconds} ms; {PoolState()}");
        return client;
    }

    internal static McpClientOptions Options(string name) => new()
    {
        ClientInfo = new Implementation { Name = name, Version = "1.0.0" },
        ProtocolVersion = "2026-07-28",
        InitializationTimeout = HandshakeBound,
        // The server/discover probe had its own 5 s default and reported a slow first answer
        // as an unsupported protocol version; infinite puts it under the bound above.
        DiscoverProbeTimeout = Timeout.InfiniteTimeSpan,
    };

    /// <summary>Connects to the endpoint a host's discovery entry names.</summary>
    internal static async Task<McpClient> ConnectFromDiscoveryAsync(string discoveryPath, string name)
    {
        using var discovery = JsonDocument.Parse(await File.ReadAllTextAsync(discoveryPath));
        return await ConnectAsync(discovery.RootElement.GetProperty("endpoint").GetString()!, name);
    }

    private static string PoolState()
    {
        ThreadPool.GetAvailableThreads(out var available, out _);
        ThreadPool.GetMaxThreads(out var maximum, out _);
        ThreadPool.GetMinThreads(out var minimum, out _);
        return $"pool {ThreadPool.ThreadCount} threads, minimum {minimum}, {maximum - available} busy, {ThreadPool.PendingWorkItemCount} queued";
    }
}
