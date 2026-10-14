using Nendo.LocalMcp;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The suite's client waits out a slow first answer for the whole handshake bound.
/// <para>
/// Under load a fresh host's first answer took 5.1 to 7.2 s, and the handshake failed with "The
/// server does not support the requested protocol version" although ConnectAsync allowed 10 s:
/// the client's <c>server/discover</c> probe has a bound of its own, 5 s by default, and reads a
/// probe that ran out as a server that predates the revision. Measured here against a real host
/// whose first answer is held for 6 s on its way back.
/// </para>
/// </summary>
[TestClass]
public sealed class HandshakeBoundTests
{
    private static readonly TimeSpan FirstAnswerDelay = TimeSpan.FromSeconds(6);

    [TestMethod]
    public async Task AFirstAnswerSlowerThanTheProbesDefaultStillConnects()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        var held = new HoldFirstAnswer(FirstAnswerDelay);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        await using var client = await ProtocolResourceTests.ConnectAsync(host.Endpoint, held);
        Assert.IsTrue(held.Held, "The first answer was not held.");
        Assert.IsGreaterThanOrEqualTo(FirstAnswerDelay, watch.Elapsed);
        Assert.AreEqual("2026-07-28", client.NegotiatedProtocolVersion);
        Assert.AreEqual("nendo-local", client.ServerInfo.Name);
    }

    /// <summary>Passes every request to the host, and holds the first answer before returning it.</summary>
    private sealed class HoldFirstAnswer(TimeSpan delay) : DelegatingHandler(new SocketsHttpHandler())
    {
        private int _requests;

        internal bool Held { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            if (Interlocked.Increment(ref _requests) == 1)
            {
                Held = true;
                await Task.Delay(delay, cancellationToken);
            }
            return response;
        }
    }
}
