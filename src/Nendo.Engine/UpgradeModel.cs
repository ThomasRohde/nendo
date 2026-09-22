namespace Nendo.Engine;

public sealed record NendoUpgradePlan(
    string PlanId, string UpgradeId, string FileName, string RetainedFileName,
    string SourceLayout, string TargetLayout, NendoManifestSnapshot Current,
    NendoManifestSnapshot Upgraded, long EstimatedAdditionalBytes, string RetentionPolicy);

public sealed record NendoUpgradeResult(
    string PlanId, string UpgradeId, string FileName, string RetainedFileName,
    string ReceiptFileName, NendoManifestSnapshot Manifest)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public NendoFileObservation? OpenObservation { get; internal init; }
}
