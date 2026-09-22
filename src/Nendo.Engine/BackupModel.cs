namespace Nendo.Engine;

/// <summary>A session-bound confirmation, not a path or a write capability.</summary>
public sealed record NendoBackupPlan(
    string PlanId,
    string DestinationFileName,
    NendoManifestSnapshot Source);

public sealed record NendoBackupResult(
    string PlanId,
    string DestinationFileName,
    NendoManifestSnapshot Manifest,
    bool IsIdempotentReplay);
