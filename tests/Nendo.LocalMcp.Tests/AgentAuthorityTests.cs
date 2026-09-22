namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class AgentAuthorityTests
{
    [TestMethod]
    public async Task ExactlyOneSessionCanRenewReleaseAndExpireTheLease()
    {
        Assert.AreEqual(TimeSpan.FromSeconds(60), NendoAgentAuthority.ProductionLeaseTtl);
        var clock = new TestClock(new DateTimeOffset(2026, 9, 3, 10, 0, 0, TimeSpan.Zero));
        var authority = CreateAuthority(AgentAccessMode.DataMutation, clock, TimeSpan.FromSeconds(10));
        var first = await authority.AcquireAsync("session-a", "Codex test", CancellationToken.None);

        var held = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.AcquireAsync("session-b", "Other test", CancellationToken.None));
        Assert.AreEqual("LEASE_HELD", held.Code);
        Assert.AreEqual("agent-", first.Owner[..6]);
        Assert.AreEqual(clock.UtcNow.AddSeconds(10), first.ExpiresAt);

        var copied = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.RenewAsync(first.LeaseId, "session-b", CancellationToken.None));
        Assert.AreEqual("INVALID_LEASE", copied.Code);

        clock.Advance(TimeSpan.FromSeconds(5));
        var renewed = await authority.RenewAsync(first.LeaseId, "session-a", CancellationToken.None);
        Assert.AreEqual(clock.UtcNow.AddSeconds(10), renewed.ExpiresAt);
        var released = await authority.ReleaseAsync(first.LeaseId, "session-a", CancellationToken.None);
        var replay = await authority.ReleaseAsync(first.LeaseId, "session-a", CancellationToken.None);
        Assert.AreEqual("released", released.State);
        Assert.AreEqual(released, replay);

        var second = await authority.AcquireAsync("session-b", "Other test", CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(11));
        var expired = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.RenewAsync(second.LeaseId, "session-b", CancellationToken.None));
        Assert.AreEqual("LEASE_EXPIRED", expired.Code);
        var successor = await authority.AcquireAsync("session-c", "Successor", CancellationToken.None);
        Assert.AreNotEqual(second.LeaseId, successor.LeaseId);
    }

    [TestMethod]
    public async Task ReadOnlyModeAndSessionRevocationFailClosed()
    {
        var clock = new TestClock(DateTimeOffset.UtcNow);
        var readOnly = CreateAuthority(AgentAccessMode.ReadOnly, clock, TimeSpan.FromMinutes(1));
        var denied = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            readOnly.AcquireAsync("session-a", "Codex", CancellationToken.None));
        Assert.AreEqual("EDIT_DATA_REQUIRED", denied.Code);

        var editing = CreateAuthority(AgentAccessMode.ApplicationAuthoring, clock, TimeSpan.FromMinutes(1));
        var lease = await editing.AcquireAsync("session-a", "Codex", CancellationToken.None);
        await editing.RevokeSessionAsync("session-a");
        var revoked = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            editing.RenewAsync(lease.LeaseId, "session-a", CancellationToken.None));
        Assert.AreEqual("INVALID_LEASE", revoked.Code);
        Assert.IsFalse((await editing.GetStatusAsync(CancellationToken.None)).HasLease);
    }

    [TestMethod]
    public async Task RevocationWaitsForAnAdmittedMutationToFinish()
    {
        var authority = CreateAuthority(
            AgentAccessMode.DataMutation,
            new TestClock(DateTimeOffset.UtcNow),
            TimeSpan.FromMinutes(1));
        var lease = await authority.AcquireAsync("session-a", "Codex", CancellationToken.None);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var mutation = authority.AdmitMutationAsync(
            lease.LeaseId,
            "session-a",
            AgentAccessMode.DataMutation,
            async _ =>
            {
                entered.SetResult();
                await finish.Task;
                return "committed";
            },
            CancellationToken.None);
        await entered.Task;

        var revoke = authority.RevokeAllAsync();
        Assert.IsFalse(revoke.IsCompleted);
        finish.SetResult();

        Assert.AreEqual("committed", await mutation);
        await revoke;
        Assert.IsFalse((await authority.GetStatusAsync(CancellationToken.None)).HasLease);
    }

    private static NendoAgentAuthority CreateAuthority(
        AgentAccessMode mode,
        INendoClock clock,
        TimeSpan ttl) => new(
        new NendoHostAuthority(
            "host-run",
            mode,
            new byte[32],
            "application-test",
            "instance-test"),
        clock,
        ttl);

    [TestMethod]
    public async Task ClosingHostAdmissionRejectsAlreadyQueuedAndNewMutationsWhileDrainingTheAdmittedOne()
    {
        var host = new NendoHostAuthority("closing-host", AgentAccessMode.DataMutation,
            new byte[32], "application", "instance");
        var authority = new NendoAgentAuthority(host, new TestClock(DateTimeOffset.UtcNow), TimeSpan.FromMinutes(1));
        var lease = await authority.AcquireAsync("session", "Test client", CancellationToken.None);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = authority.AdmitMutationAsync(lease.LeaseId, "session", AgentAccessMode.DataMutation,
            async _ => { entered.SetResult(); await finish.Task; return "admitted-result"; }, CancellationToken.None);
        await entered.Task;
        var called = false;
        var queued = authority.AdmitMutationAsync(lease.LeaseId, "session", AgentAccessMode.DataMutation,
            _ => { called = true; return Task.FromResult("must-not-run"); }, CancellationToken.None);
        host.CloseAdmission();
        Assert.IsFalse(host.IsActive);
        var revoke = authority.RevokeAllAsync();
        Assert.IsFalse(revoke.IsCompleted);
        finish.SetResult();
        Assert.AreEqual("admitted-result", await first);
        var denied = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() => queued);
        Assert.AreEqual("HOST_CLOSED", denied.Code);
        Assert.IsFalse(called);
        await revoke;
        Assert.IsFalse((await authority.GetStatusAsync(CancellationToken.None)).HasLease);
        var successor = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.AcquireAsync("new-session", "Successor", CancellationToken.None));
        Assert.AreEqual("HOST_CLOSED", successor.Code);
        var renewal = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.RenewAsync(lease.LeaseId, "session", CancellationToken.None));
        Assert.AreEqual("HOST_CLOSED", renewal.Code);
    }

    private sealed class TestClock(DateTimeOffset current) : INendoClock
    {
        public DateTimeOffset UtcNow { get; private set; } = current;

        internal void Advance(TimeSpan duration) => UtcNow = UtcNow.Add(duration);
    }
}
