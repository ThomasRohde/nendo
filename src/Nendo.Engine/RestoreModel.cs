namespace Nendo.Engine;

/// <summary>Host-owned confirmation; contains no paths or executable authority.</summary>
public sealed record NendoRestorePlan(
    string PlanId, string BackupFileName, string RetainedFileName,
    NendoManifestSnapshot Current, NendoManifestSnapshot Restored,
    int PendingProposalCount, string RetentionPolicy);

public sealed record NendoRestoreResult(
    string PlanId, string FileName, string RetainedFileName, string ReceiptFileName,
    NendoManifestSnapshot Manifest)
{
    // Trusted native-host handoff only; never part of a renderer/tool payload.
    // Binds fresh session admission to the exact result verified at activation.
    [System.Text.Json.Serialization.JsonIgnore]
    public NendoFileObservation? OpenObservation { get; internal init; }
}

public sealed record NendoRecoveryFileStatus(string FileName, string State, NendoManifestSnapshot? Manifest);

public sealed record NendoReplacementRecovery(
    bool HasPendingReplacement, string? OperationId, string Message,
    NendoRecoveryFileStatus? Active, NendoRecoveryFileStatus? Retained, NendoRecoveryFileStatus? Staged,
    NendoRecoveryFileStatus? PreChangeBackup = null);

public sealed class NendoReplacementInterruptedException(
    string retainedFileName, string receiptFileName, Exception cause)
    : NendoException("The replacement did not finish. Editing is closed. Inspect the recovery record and retained original before choosing a file to open.")
{
    public string RetainedFileName { get; } = retainedFileName;
    public string ReceiptFileName { get; } = receiptFileName;
    // Keep raw filesystem details out of the public/user-facing exception text.
    internal Exception Cause { get; } = cause;
}
