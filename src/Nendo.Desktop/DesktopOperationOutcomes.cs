using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed partial class DesktopSessionController
{
    internal Task<NendoApplyResult?> GetMutationReceiptAsync(string idempotencyKey, bool compensation,
        CancellationToken cancellationToken = default) => QueryAsync(service => service.GetMutationReceiptAsync(
            new NendoOperationIdentity(compensation ? "studio.p2.compensation" : "desktop.p2.5", idempotencyKey),
            cancellationToken), cancellationToken);

    internal Task<NendoChangeSetApplyResult?> GetProposalReceiptAsync(string proposalId,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.GetProposalReceiptAsync(proposalId, cancellationToken), cancellationToken);

    private async Task<(DesktopSessionView? Session, string? Notice)> RefreshAfterOutcomeAsync(
        CancellationToken cancellationToken)
    {
        using var refresh = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        refresh.CancelAfter(TimeSpan.FromSeconds(2));
        try { return (await ReadViewAsync(refresh.Token), null); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or
            OperationCanceledException or NendoException)
        {
            // This read cannot change the outcome already returned by the
            // application service. The caller receives that receipt separately.
            return (null, "The operation outcome is available. Refresh the view to see the current file state.");
        }
    }
}
