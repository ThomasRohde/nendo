using System.Security.Cryptography;

namespace Nendo.LocalMcp;

internal interface INendoClock
{
    DateTimeOffset UtcNow { get; }
}

internal sealed class SystemNendoClock : INendoClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

internal sealed class NendoAgentAuthorityException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}

public sealed record NendoLeaseGrant(
    string LeaseId,
    DateTimeOffset? ExpiresAt,
    AgentAccessMode Mode,
    string Owner)
{
    public string? ReceiptContext { get; init; }
    public string ApplicationHandle { get; init; } = string.Empty;

    /// <summary>"explicitRelease" when this lease never expires, "expiry" when ExpiresAt is enforced.</summary>
    public string EndsOn { get; init; } = "explicitRelease";
}

public sealed record NendoLeaseRelease(string LeaseId, string State);

/// <summary>
/// Who holds the single edit lease, readable without holding it. This is the
/// recovery path when a grant is minted but its response never arrives: the lease
/// is really taken, and without this a client has no way to learn that, let alone
/// that it is the holder.
/// </summary>
public sealed record NendoLeaseStatus(
    bool HasLease,
    string? Owner,
    string? ClientDisplayName,
    DateTimeOffset? ExpiresAt)
{
    /// <summary>"explicitRelease" when the held lease never expires, "expiry" when ExpiresAt is enforced.</summary>
    public string? EndsOn { get; init; }

    /// <summary>
    /// True when the supplied application handle is the holder, false when it is
    /// not, null when no handle was supplied or no lease is held.
    /// </summary>
    public bool? IsYou { get; init; }
}

internal sealed class NendoAgentAuthority(
    NendoHostAuthority host,
    INendoClock clock,
    TimeSpan? leaseTtl)
{
    internal static readonly TimeSpan ProductionLeaseTtl = TimeSpan.FromSeconds(60);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private ActiveLease? _activeLease;
    private ReleasedLease? _released;

    /// <summary>
    /// The last published answer to "who is editing", readable without the gate.
    /// <para>
    /// <see cref="GetStatusAsync"/> takes <c>_gate</c>, and so does every write, so the
    /// host asking who holds the lease used to wait for the write it was describing to
    /// finish -- and it held the Desktop's own gate while it waited, so one long agent
    /// call stopped the whole window rather than one panel. This field is written under
    /// the gate with every change to the lease and read outside it, which is what lets a
    /// window procedure answer immediately.
    /// </para>
    /// </summary>
    private volatile NendoLeaseStatus _peek = new(false, null, null, null);
    private Func<string, Task>? _leaseEnded;

    /// <summary>
    /// The one place the lease changes, so the gate-free snapshot cannot drift from it.
    /// Every assignment goes through here; there is no second way to move the lease.
    /// </summary>
    private ActiveLease? Active
    {
        get => _activeLease;
        set
        {
            _activeLease = value;
            _peek = value is null
                ? new NendoLeaseStatus(false, null, null, null)
                : new NendoLeaseStatus(
                    true,
                    value.Grant.Owner,
                    value.ClientDisplayName,
                    value.Grant.ExpiresAt)
                {
                    EndsOn = value.Grant.EndsOn,
                };
        }
    }

    /// <summary>
    /// Who holds the lease, answered without waiting for whatever they are doing with it.
    /// It carries no <c>IsYou</c>: that needs a session ID compared under the gate, and an
    /// agent asking about its own lease can afford to wait for the real answer.
    /// <para>
    /// A lapsed lease is reported as no lease here. Ending it is a gated act that has not
    /// happened yet, but saying it is still held would put a name on the window that the
    /// next request will refuse.
    /// </para>
    /// </summary>
    internal NendoLeaseStatus PeekStatus()
    {
        var peek = _peek;
        return leaseTtl is not null && peek.ExpiresAt is { } expiresAt && expiresAt <= clock.UtcNow
            ? new NendoLeaseStatus(false, null, null, null)
            : peek;
    }

    internal void SetLeaseEndedHandler(Func<string, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        if (Interlocked.CompareExchange(ref _leaseEnded, handler, null) is not null)
        {
            throw new InvalidOperationException("The lease-ended handler is already configured.");
        }
    }

    internal async Task<NendoLeaseGrant> AcquireAsync(
        string sessionId,
        string clientDisplayName,
        CancellationToken cancellationToken)
    {
        RequireMutationMode();
        await _gate.WaitAsync(cancellationToken);
        try
        {
            host.RequireActive();
            await ExpireIfNeededAsync();
            if (Active is not null)
            {
                throw new NendoAgentAuthorityException(
                    "LEASE_HELD",
                    "Another local agent currently has edit access.");
            }
            var grant = new NendoLeaseGrant(
                RandomLeaseId(),
                NextExpiry(),
                host.Mode,
                NendoTransportIdentity.Pseudonym(sessionId))
            {
                ReceiptContext = NendoReceiptContext.Create(host, sessionId),
                ApplicationHandle = sessionId,
                EndsOn = leaseTtl is null ? "explicitRelease" : "expiry",
            };
            Active = new ActiveLease(
                grant,
                sessionId,
                host.HostRunId,
                host.ApplicationId,
                host.InstanceId,
                clientDisplayName);
            _released = null;
            return grant;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoLeaseGrant> RenewAsync(
        string leaseId,
        string sessionId,
        CancellationToken cancellationToken)
    {
        RequireMutationMode();
        await _gate.WaitAsync(cancellationToken);
        try
        {
            host.RequireActive();
            if (await ExpireIfNeededAsync())
            {
                throw new NendoAgentAuthorityException("LEASE_EXPIRED", "The edit lease expired.");
            }
            var active = RequireActive(leaseId, sessionId);
            var renewed = active.Grant with { ExpiresAt = NextExpiry() };
            Active = active with { Grant = renewed };
            return renewed;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoLeaseRelease> ReleaseAsync(
        string leaseId,
        string sessionId,
        CancellationToken cancellationToken)
    {
        RequireMutationMode();
        await _gate.WaitAsync(cancellationToken);
        try
        {
            host.RequireActive();
            if (Active is null &&
                _released is not null &&
                _released.LeaseId == leaseId &&
                _released.SessionId == sessionId)
            {
                return new NendoLeaseRelease(leaseId, "released");
            }
            if (await ExpireIfNeededAsync())
            {
                throw new NendoAgentAuthorityException("LEASE_EXPIRED", "The edit lease expired.");
            }
            _ = RequireActive(leaseId, sessionId);
            Active = null;
            _released = new ReleasedLease(leaseId, sessionId);
            await NotifyLeaseEndedAsync(sessionId);
            return new NendoLeaseRelease(leaseId, "released");
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<T> AdmitMutationAsync<T>(
        string leaseId,
        string sessionId,
        AgentAccessMode requiredMode,
        Func<NendoLeaseGrant, Task<T>> action,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(action);
        RequireMode(requiredMode);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            host.RequireActive();
            if (await ExpireIfNeededAsync())
            {
                throw new NendoAgentAuthorityException("LEASE_EXPIRED", "The edit lease expired.");
            }
            var active = RequireActive(leaseId, sessionId);
            return await action(active.Grant);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task RevokeSessionAsync(string sessionId)
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            var ended = false;
            if (Active?.SessionId == sessionId)
            {
                Active = null;
                ended = true;
            }
            if (_released?.SessionId == sessionId)
            {
                _released = null;
            }
            if (ended)
            {
                await NotifyLeaseEndedAsync(sessionId);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task RevokeAllAsync()
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            var sessionId = Active?.SessionId;
            Active = null;
            _released = null;
            if (sessionId is not null)
            {
                await NotifyLeaseEndedAsync(sessionId);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoLeaseStatus> GetStatusAsync(
        CancellationToken cancellationToken,
        string? sessionId = null)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await ExpireIfNeededAsync();
            return Active is null
                ? new NendoLeaseStatus(false, null, null, null)
                : new NendoLeaseStatus(
                    true,
                    Active.Grant.Owner,
                    Active.ClientDisplayName,
                    Active.Grant.ExpiresAt)
                {
                    EndsOn = Active.Grant.EndsOn,
                    IsYou = string.IsNullOrWhiteSpace(sessionId) ? null : Active.SessionId == sessionId,
                };
        }
        finally
        {
            _gate.Release();
        }
    }

    private ActiveLease RequireActive(string leaseId, string sessionId)
    {
        if (Active is null ||
            Active.Grant.LeaseId != leaseId ||
            Active.SessionId != sessionId ||
            Active.HostRunId != host.HostRunId ||
            Active.ApplicationId != host.ApplicationId ||
            Active.InstanceId != host.InstanceId)
        {
            throw new NendoAgentAuthorityException(
                "INVALID_LEASE",
                "A valid application handle and edit lease are required.");
        }
        return Active;
    }

    // Null TTL means the lease never expires. Keying off the configuration rather than only off the stored
    // timestamp means a grant carrying a stale expiry still cannot lapse while expiry is switched off.
    private DateTimeOffset? NextExpiry() => leaseTtl is { } ttl ? clock.UtcNow.Add(ttl) : null;

    private async Task<bool> ExpireIfNeededAsync()
    {
        if (leaseTtl is not null && Active?.Grant.ExpiresAt is { } expiresAt && expiresAt <= clock.UtcNow)
        {
            var sessionId = Active.SessionId;
            Active = null;
            _released = null;
            await NotifyLeaseEndedAsync(sessionId);
            return true;
        }
        return false;
    }

    private async Task NotifyLeaseEndedAsync(string sessionId)
    {
        if (_leaseEnded is not null)
        {
            await _leaseEnded(sessionId);
        }
    }

    private void RequireMutationMode() => RequireMode(AgentAccessMode.DataMutation);

    private void RequireMode(AgentAccessMode requiredMode)
    {
        host.RequireActive();
        if (host.Mode < requiredMode)
        {
            // A table, not a ternary. The previous two-way test read "authoring or else
            // data", so a fourth level added above it would have been refused by the name
            // of a level two rungs below -- an agent told to ask for Edit data when it
            // already had Shape app and needed something else entirely.
            var (code, message) = requiredMode switch
            {
                AgentAccessMode.Unattended =>
                    ("UNATTENDED_REQUIRED", "Unattended access is required."),
                AgentAccessMode.ApplicationAuthoring =>
                    ("SHAPE_APP_REQUIRED", "Shape app access is required."),
                _ => ("EDIT_DATA_REQUIRED", "Edit data access is required."),
            };
            throw new NendoAgentAuthorityException(code, message);
        }
    }

    private static string RandomLeaseId() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    private sealed record ActiveLease(
        NendoLeaseGrant Grant,
        string SessionId,
        string HostRunId,
        string ApplicationId,
        string InstanceId,
        string ClientDisplayName);

    private sealed record ReleasedLease(string LeaseId, string SessionId);
}
