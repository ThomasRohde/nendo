using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// Where the shared session meets what only a host does: the Windows host's agent access and
/// its shell's signals (ADR-0009, ADR-0030). Each build implements these; the browser host has
/// no agents, so its implementations do nothing.
/// </summary>
internal sealed partial class DesktopSessionController
{
    partial void BeginAgentFileSession();

    private partial Task CloseAgentFileSessionCoreAsync();

    private partial Task StopAgentAccessForReplacementAsync();

    private partial Task StopUnhealthyAgentAccessCoreAsync();

    /// <summary>Brings back the agent level this device keeps for the file just opened.</summary>
    private partial Task RestoreAgentModeAsync(bool writable, CancellationToken cancellationToken);

    /// <summary>Tells the shell the file session moved.</summary>
    partial void AnnounceFileSession();

    /// <summary>Stops listening to a file's coordinator as it closes.</summary>
    partial void DetachFileHandlers(NendoWriteCoordinator? coordinator);

    /// <summary>Keeps the consent the shell shows, read with the view.</summary>
    partial void RememberShellTrust(NendoBehaviourTrust? trust);

    /// <summary>A sentence about agent access that closed with the last file, if there was one.</summary>
    private partial string? ReadAgentCleanupNotice();

    /// <summary>Promotes the proposal through the agent that prepared it, or null when no agent did.</summary>
    private partial Task<NendoPromotionOutcome>? PromoteAgentProposal(NendoApplicationService service, string proposalId,
        string? expectedOperationDigest, CancellationToken cancellationToken);

    /// <summary>Rejects the proposal through the agent that prepared it, or null when no agent did.</summary>
    private partial Task<NendoPromotionOutcome>? RejectAgentProposal(NendoApplicationService service, string proposalId,
        CancellationToken cancellationToken);
}
