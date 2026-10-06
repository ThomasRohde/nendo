using System.ComponentModel;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

[McpServerToolType]
internal sealed class NendoLeaseTools(NendoAgentAuthority authority)
{
    [McpServerTool(
        Name = "nendo.lease.acquire",
        Title = "Acquire the edit lease",
        Destructive = false,
        Idempotent = false,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Acquire the single edit lease and a private application handle for this open file. They are two things: the handle addresses this open file for the rest of your session and stays private; the lease is the edit authority, held by one agent at a time and revocable by the person. Owned calls take both. The lease lasts until you release it, the person revokes it, access is lowered or the file is closed or switched; closing your client does not end it. When the person has turned expiry on it also lapses unless renewed before expiresAt, and endsOn says which applies. Save receiptContext from the grant before writing. Pass idempotencyKey so a retry after a lost response returns the same grant instead of NENDO_LEASE_HELD against yourself. Pass resumeApplicationHandle, your handle from an earlier lease on this host run, to take the lease again under it: the proposals you validated, your pseudonym and your receipt scope are yours once more.")]
    public Task<NendoLeaseGrant> AcquireAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Optional stable key for this acquire. An exact retry under it returns the grant it made while that lease is held.")] string? idempotencyKey = null,
        [Description("Optional applicationHandle from an earlier grant on this host run. Grants a new lease under that handle, with the proposals, pseudonym and receipt scope it owned; a handle this run never minted is NENDO_HANDLE_UNKNOWN.")] string? resumeApplicationHandle = null,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.AcquireAsync(
            Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
            NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
            idempotencyKey,
            resumeApplicationHandle,
            cancellationToken));

    [McpServerTool(
        Name = "nendo.lease.status",
        Title = "Read who holds the edit lease",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true)]
    [Description("Read who holds the single edit lease. Needs no lease and grants none. Use it to recover after a lost acquire response, after a reconnect, or to confirm the lease is still yours. Supply your application handle to have isYou answered.")]
    public Task<NendoLeaseStatus> StatusAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Optional private application handle. Supplying it answers isYou; omitting it still reports whether a lease is held and by which client.")] string? applicationHandle = null,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.GetStatusAsync(cancellationToken, applicationHandle));

    [McpServerTool(
        Name = "nendo.lease.renew",
        Title = "Renew the edit lease",
        Destructive = false,
        Idempotent = false,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Confirm and extend this application handle's edit lease. When the person has lease expiry turned off the lease has no end time and this call only confirms ownership.")]
    public Task<NendoLeaseGrant> RenewAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.RenewAsync(
            leaseId,
            applicationHandle,
            cancellationToken));

    [McpServerTool(
        Name = "nendo.lease.release",
        Title = "Release the edit lease",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Release this handle's edit lease so another agent can acquire it. Change sets begun under the handle and never validated are discarded; validated proposals stay waiting for the person, and nendo.lease.acquire with resumeApplicationHandle takes them back on this host run. Repeating the call with the same leaseId and handle answers released again.")]
    public Task<NendoLeaseRelease> ReleaseAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.ReleaseAsync(
            leaseId,
            applicationHandle,
            cancellationToken));

    private static async Task<T> TranslateAsync<T>(Func<Task<T>> action)
    {
        try
        {
            return await action();
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw NendoToolErrors.Translate(exception);
        }
    }
}
