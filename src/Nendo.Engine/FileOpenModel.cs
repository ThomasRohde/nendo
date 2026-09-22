namespace Nendo.Engine;

public enum NendoOpenClassification
{
    NormalWritable,
    NormalReadOnly,
    RecoveryRequired,
    Rejected,
}

public sealed record NendoOpenFinding(string Code, string Message);

public sealed record NendoFileCapabilities(
    bool ReadData,
    bool ReadHistory,
    bool Backup,
    bool Export,
    bool CustomSurfaces,
    bool Mutate,
    bool AgentAccess)
{
    internal static NendoFileCapabilities None { get; } = new(false, false, false, false, false, false, false);
    internal static NendoFileCapabilities Writable { get; } = new(true, true, true, true, true, true, true);
}

/// <summary>
/// A read-only observation, not a grant of write ownership. Paths and storage
/// schema details stay in the host/storage boundary.
/// </summary>
public sealed record NendoFileInspection(
    NendoOpenClassification Classification,
    NendoFileCapabilities Capabilities,
    IReadOnlyList<NendoOpenFinding> Findings,
    NendoManifestSnapshot? Manifest,
    string? Layout,
    bool CanAcquireWriteAuthority,
    DateTimeOffset ObservedAt);

public sealed class NendoFileOpenException(NendoFileInspection inspection)
    : NendoException(inspection.Findings.FirstOrDefault()?.Message ?? "This file cannot be opened for writing.")
{
    public NendoFileInspection Inspection { get; } = inspection;
}

/// <summary>
/// Host-only observation for recent-file admission. It is not a write grant;
/// the coordinator pins and revalidates it before opening writable storage.
/// </summary>
public sealed class NendoFileObservation
{
    internal NendoFileObservation(NendoFileInspection inspection, string? physicalFileKey, string? contentDigest)
    {
        Inspection = inspection;
        PhysicalFileKey = physicalFileKey;
        ContentDigest = contentDigest;
    }

    public NendoFileInspection Inspection { get; }
    public string? PhysicalFileKey { get; }
    internal string? ContentDigest { get; }
}
