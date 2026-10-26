using Nendo.Engine;

namespace Nendo.Session;

/// <summary>This build has no agents and no shell to signal (ADR-0036).</summary>
internal sealed partial class DesktopSessionController
{
    /// <summary>Never fetched: the page answers these addresses itself from the file's pictures.</summary>
    private static partial string MediaScheme() => "nendo-media://";

    private partial Task CloseAgentFileSessionCoreAsync() => Task.CompletedTask;

    private partial Task StopAgentAccessForReplacementAsync() => Task.CompletedTask;

    private partial Task StopUnhealthyAgentAccessCoreAsync() => Task.CompletedTask;

    private partial Task RestoreAgentModeAsync(bool writable, CancellationToken cancellationToken) => Task.CompletedTask;

    private partial string? ReadAgentCleanupNotice() => null;

    private partial Task<NendoPromotionOutcome>? PromoteAgentProposal(NendoApplicationService service, string proposalId,
        string? expectedOperationDigest, CancellationToken cancellationToken) => null;

    private partial Task<NendoPromotionOutcome>? RejectAgentProposal(NendoApplicationService service, string proposalId,
        CancellationToken cancellationToken) => null;
}
