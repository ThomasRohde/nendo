namespace Nendo.Engine;

public enum NendoOpenClassification
{
    NormalWritable,
    NormalReadOnly,
    RecoveryRequired,
    Rejected,
}

public sealed record NendoOpenFinding(string Code, string Message);

/// <summary>
/// What an inspection that finds a save a crash left unfinished may do about it (ADR-0012,
/// 2026-10-13). SQLite cannot tell this file's journal from one a copy of it left, so the host
/// says when the person opened the file themselves, and whether it lies in a folder that may be
/// synced; everything else refuses the file untouched.
/// </summary>
public enum NendoInterruptedWrite
{
    /// <summary>Refuse untouched: an observation the person did not ask for, such as a recent-file check or a backup.</summary>
    Refuse,
    /// <summary>The person opened the file, but it is in a folder that may be synced: refuse untouched, saying why.</summary>
    RefuseInSyncedFolder,
    /// <summary>The person opened this file outside a synced folder: roll the save back, keeping the file as it was beside it.</summary>
    RollBack,
}

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

/// <summary>
/// Which file a path names and which application it says it holds, read without
/// inspecting it. Advisory, for lists that only ask whether a remembered file is still
/// the same one: it grants nothing, and opening the file still inspects it in full.
/// </summary>
public sealed record NendoFileIdentity(string PhysicalFileKey, string ApplicationId, string InstanceId);
