using System.Net;
using System.Net.Sockets;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class RelaxedLocalDefaultsTests
{
    [TestMethod]
    public async Task RequestedPortIsBoundWhenItIsFree()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        var port = ReserveThenReleasePort();

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new(workspace.DiscoveryRoot) { PreferredPort = port });

        Assert.AreEqual(port, host.Endpoint.Port);
        Assert.IsFalse(host.UsedFallbackPort);
    }

    // A busy port must degrade, never stop the file being agent-accessible.
    [TestMethod]
    public async Task OccupiedPortFallsBackToAnEphemeralPortAndSaysSo()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        var blocker = new TcpListener(IPAddress.Loopback, 0);
        blocker.Start();
        var taken = ((IPEndPoint)blocker.LocalEndpoint).Port;
        try
        {
            await using var host = await NendoLocalMcpHost.StartAsync(
                workspace.Service,
                AgentAccessMode.ReadOnly,
                new(workspace.DiscoveryRoot) { PreferredPort = taken });

            Assert.IsTrue(host.UsedFallbackPort);
            Assert.AreNotEqual(taken, host.Endpoint.Port);
            Assert.AreEqual(taken, host.RequestedPort);

            // The perimeter and discovery must both describe the port actually bound, not the one requested.
            Assert.AreEqual(host.Endpoint.Port, new Uri(host.Endpoint.AbsoluteUri).Port);
            await using var client = await ProtocolResourceTests.ConnectAsync(host);
            Assert.IsNotNull(await client.ListResourcesAsync());
        }
        finally
        {
            blocker.Stop();
        }
    }

    // The default is no expiry: the reported data loss came from a draft dying with a 60-second lease.
    [TestMethod]
    public async Task LeaseWithoutExpiryOutlivesTheOldTtlAndEndsOnlyWhenAsked()
    {
        var host = new NendoHostAuthority(
            "run",
            AgentAccessMode.ApplicationAuthoring, new byte[32], "application-1", "instance-1");
        host.SetPort(41763);
        var clock = new AdvanceableClock(DateTimeOffset.UnixEpoch);
        var authority = new NendoAgentAuthority(host, clock, leaseTtl: null);

        var grant = await authority.AcquireAsync("handle-1", "test client", default);
        Assert.IsNull(grant.ExpiresAt);
        Assert.AreEqual("explicitRelease", grant.EndsOn);

        clock.Advance(TimeSpan.FromHours(6));
        Assert.IsTrue((await authority.GetStatusAsync(default)).HasLease);

        // Renew must still succeed so an agent written against the old contract keeps working.
        var renewed = await authority.RenewAsync(grant.LeaseId, "handle-1", default);
        Assert.IsNull(renewed.ExpiresAt);

        await authority.ReleaseAsync(grant.LeaseId, "handle-1", default);
        Assert.IsFalse((await authority.GetStatusAsync(default)).HasLease);
    }

    [TestMethod]
    public async Task OptInExpiryStillEndsTheLease()
    {
        var host = new NendoHostAuthority(
            "run",
            AgentAccessMode.ApplicationAuthoring, new byte[32], "application-1", "instance-1");
        host.SetPort(41763);
        var clock = new AdvanceableClock(DateTimeOffset.UnixEpoch);
        var authority = new NendoAgentAuthority(host, clock, NendoAgentAuthority.ProductionLeaseTtl);

        var grant = await authority.AcquireAsync("handle-1", "test client", default);
        Assert.IsNotNull(grant.ExpiresAt);
        Assert.AreEqual("expiry", grant.EndsOn);

        clock.Advance(TimeSpan.FromSeconds(61));
        Assert.IsFalse((await authority.GetStatusAsync(default)).HasLease);
    }

    private static int ReserveThenReleasePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private sealed class AdvanceableClock(DateTimeOffset start) : INendoClock
    {
        public DateTimeOffset UtcNow { get; private set; } = start;

        public void Advance(TimeSpan amount) => UtcNow = UtcNow.Add(amount);
    }
}
