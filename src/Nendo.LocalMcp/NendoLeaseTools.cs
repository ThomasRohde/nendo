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
        Destructive = false,
        Idempotent = false,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Acquire the single edit lease and a private application handle for this open file. They are two things: the handle addresses this open file for the rest of your session and stays private; the lease is the edit authority, held by one agent at a time and revocable by the person. Owned calls take both.")]
    public Task<NendoLeaseGrant> AcquireAsync(
        RequestContext<CallToolRequestParams> context,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.AcquireAsync(
            Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
            NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
            cancellationToken));

    [McpServerTool(
        Name = "nendo.lease.status",
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
        Destructive = false,
        Idempotent = false,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Confirm and extend this application handle's edit lease. When the person has lease expiry turned off the lease has no end time and this call only confirms ownership.")]
    public Task<NendoLeaseGrant> RenewAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        CancellationToken cancellationToken = default) => TranslateAsync(() =>
        authority.RenewAsync(
            leaseId,
            applicationHandle,
            cancellationToken));

    [McpServerTool(
        Name = "nendo.lease.release",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Release the current application handle's edit lease.")]
    public Task<NendoLeaseRelease> ReleaseAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
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
