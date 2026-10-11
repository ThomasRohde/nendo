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
        await editing.RevokeAllAsync();
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

    /// <summary>
    /// MHS-02. An acquire under the holder's idempotency key returned the holder's whole grant,
    /// application handle included, for as long as the lease was held. Two agents following the
    /// same skill could send the same key, and the second then wrote under the first's lease. A
    /// replay is the recovery for a lost response, so it now holds only until the lease is first
    /// used, and only for a short while after the grant.
    /// </summary>
    [TestMethod]
    public async Task AnAcquireKeyReplaysOnlyALostResponseNeverAnotherAgentsGrant()
    {
        var clock = new TestClock(new DateTimeOffset(2026, 10, 11, 10, 0, 0, TimeSpan.Zero));
        var authority = CreateAuthority(AgentAccessMode.DataMutation, clock, TimeSpan.FromHours(1));
        var first = await authority.AcquireAsync("handle-a", "Codex", "acquire-lease", null, CancellationToken.None);
        var retried = await authority.AcquireAsync("handle-x", "Codex", "acquire-lease", null, CancellationToken.None);
        Assert.AreEqual(first.LeaseId, retried.LeaseId, "A retry after a lost response still receives the same grant.");

        // Inside the window and before any use, another client sending the holder's key is refused.
        var early = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.AcquireAsync("handle-b", "Claude Code", "acquire-lease", null, CancellationToken.None),
            "Another client sending the holder's key was handed the holder's grant.");
        Assert.AreEqual("LEASE_HELD", early.Code);

        await authority.AdmitMutationAsync(first.LeaseId, "handle-a", AgentAccessMode.DataMutation, _ => Task.FromResult(1), CancellationToken.None);
        var other = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authority.AcquireAsync("handle-y", "Codex", "acquire-lease", null, CancellationToken.None),
            "Once the holder has written, even its own client's acquire under the key is not a lost response.");
        Assert.AreEqual("LEASE_HELD", other.Code);

        // A renewal is a use too.
        var renewing = CreateAuthority(AgentAccessMode.DataMutation, clock, TimeSpan.FromHours(1));
        var renewed = await renewing.AcquireAsync("handle-r", "Codex", "acquire-lease", null, CancellationToken.None);
        await renewing.RenewAsync(renewed.LeaseId, "handle-r", CancellationToken.None);
        var afterRenew = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            renewing.AcquireAsync("handle-s", "Codex", "acquire-lease", null, CancellationToken.None));
        Assert.AreEqual("LEASE_HELD", afterRenew.Code, "A renewed grant is not replayed.");

        var unused = CreateAuthority(AgentAccessMode.DataMutation, clock, TimeSpan.FromHours(1));
        await unused.AcquireAsync("handle-c", "Codex", "acquire-lease", null, CancellationToken.None);
        clock.Advance(NendoAgentAuthority.AcquireReplayWindow + TimeSpan.FromSeconds(1));
        var late = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            unused.AcquireAsync("handle-d", "Claude Code", "acquire-lease", null, CancellationToken.None));
        Assert.AreEqual("LEASE_HELD", late.Code, "Past the window an unused grant is not replayed either.");
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
