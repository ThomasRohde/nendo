using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    // Opening a file: inspecting it without taking it, observing it, taking it
    // read-only, creating one, and taking one for writing. Every route ends in a
    // Core method so the path pin, the ownership lease and the store are acquired
    // in one order and released in one order however the caller arrived.
    public static async Task<NendoFileInspection> InspectAsync(
        string path,
        CancellationToken cancellationToken = default) =>
        (await InspectToOpenAsync(ValidatePath(path), NendoInterruptedWrite.Refuse, cancellationToken)).Inspection;

    /// <summary>
    /// Inspects a file a host is about to open (ADR-0012, 2026-10-13, ESC-01). A save a crash left
    /// unfinished is rolled back only when the host says the person opened this file themselves,
    /// outside a synced folder; anything else refuses it untouched, saying why. A copy kept before
    /// an earlier playback is named on every inspection until the person removes it.
    /// </summary>
    private static async Task<InspectedNendoFile> InspectToOpenAsync(string fullPath, NendoInterruptedWrite interruptedWrite,
        CancellationToken cancellationToken)
    {
        var inspected = SqliteNendoStore.HasLoneRollbackJournal(fullPath)
            ? await InterruptedWriteAsync(fullPath, interruptedWrite, cancellationToken)
            : await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
        var held = SqliteNendoStore.HeldStages(fullPath);
        return held.Length == 0 ? inspected : inspected with
        {
            Inspection = inspected.Inspection with
            {
                Findings = [.. inspected.Inspection.Findings, .. held.Select(SqliteNendoStore.HeldStageFinding)],
            },
        };
    }

    /// <summary>
    /// A lone rollback journal beside the file. SQLite's format cannot tell this file's journal from
    /// one a copy of the same file left, so the playback runs only on the person's own open outside a
    /// synced folder, after checks that rule out another file's journal, under the file's
    /// write-ownership lease, and after the file and journal are kept beside it. The kept copy is
    /// never removed automatically once anything was played back.
    /// </summary>
    private static async Task<InspectedNendoFile> InterruptedWriteAsync(string fullPath, NendoInterruptedWrite interruptedWrite,
        CancellationToken cancellationToken)
    {
        if (interruptedWrite != NendoInterruptedWrite.RollBack)
            return SqliteNendoStore.JournalRefusal(interruptedWrite == NendoInterruptedWrite.RefuseInSyncedFolder
                ? SqliteNendoStore.JournalSyncedFolderText
                : SqliteNendoStore.JournalOpenToRollBackText);
        var check = await SqliteNendoStore.CheckInterruptedWriteAsync(fullPath, cancellationToken);
        if (check.Verdict == SqliteNendoStore.JournalVerdict.Gone) return await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
        if (check.Verdict == SqliteNendoStore.JournalVerdict.Refused) return SqliteNendoStore.JournalRefusal(check.Message!);
        WriteOwnershipLease lease;
        try
        {
            lease = WriteOwnershipLease.Acquire(fullPath, $"interrupted-write-{Environment.ProcessId}");
        }
        catch (NendoWriteOwnershipException exception)
        {
            return SqliteNendoStore.JournalRefusal(exception.Code == "write-ownership-denied"
                ? SqliteNendoStore.JournalFolderReadOnlyText
                : SqliteNendoStore.JournalAnotherWindowText);
        }
        using (lease)
        {
            if (check.Verdict == SqliteNendoStore.JournalVerdict.Empty)
            {
                // Nothing to roll back: the file was never changed, so nothing needs keeping.
                var notCleared = await SqliteNendoStore.ClearEmptyJournalAsync(fullPath, cancellationToken);
                return notCleared is null
                    ? await SqliteNendoStore.InspectAsync(fullPath, cancellationToken)
                    : SqliteNendoStore.JournalRefusal(notCleared);
            }
            var held = SqliteNendoStore.HeldStagePath(fullPath);
            try
            {
                await SqliteNendoStore.KeepBeforePlaybackAsync(fullPath, held, cancellationToken);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // A host that rolled the journal back meanwhile leaves a file to inspect as it is.
                if (!File.Exists(fullPath + "-journal")) return await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
                return SqliteNendoStore.JournalRefusal(SqliteNendoStore.JournalCouldNotKeepText(exception));
            }
            try
            {
                var failure = await SqliteNendoStore.RollBackHotJournalAsync(fullPath, cancellationToken);
                if (File.Exists(fullPath + "-journal"))
                    return SqliteNendoStore.JournalRefusal(failure ?? SqliteNendoStore.JournalWriterText);
                return await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
            }
            finally
            {
                // Only a playback that did not happen leaves the kept copy without purpose; once
                // anything was played back, a throw included, the copy stays for the person.
                if (File.Exists(fullPath + "-journal")) SqliteNendoStore.DiscardHeldStage(held);
            }
        }
    }

    /// <summary>
    /// Observes a file the host is about to open, saying whether the person opened it themselves
    /// and where (<see cref="NendoInterruptedWrite"/>): only then may a save a crash left unfinished
    /// be rolled back.
    /// </summary>
    public static async Task<NendoFileObservation> ObserveAsync(string path, NendoInterruptedWrite interruptedWrite,
        CancellationToken cancellationToken = default)
    {
        var fullPath = ValidatePath(path);
        try
        {
            using var pin = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var identity = LocalFileIdentity.Read(pin);
            var inspected = await InspectToOpenAsync(fullPath, interruptedWrite, cancellationToken);
            return new(inspected.Inspection, identity.Key, inspected.ContentDigest);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            var inspected = await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
            return new(inspected.Inspection, null, null);
        }
    }

    public static Task<NendoFileObservation> ObserveAsync(string path, CancellationToken cancellationToken = default) =>
        ObserveAsync(path, NendoInterruptedWrite.Refuse, cancellationToken);

    /// <summary>
    /// Which file this is and which application it declares, without inspecting it: no
    /// integrity check, classification or digest, which on a large file is nearly all of
    /// an observation's cost. Null when the file is missing or does not read as a Nendo
    /// file of this format. It grants nothing; see <see cref="NendoFileIdentity"/>.
    /// </summary>
    public static async Task<NendoFileIdentity?> IdentifyAsync(string path, CancellationToken cancellationToken = default)
    {
        var fullPath = ValidatePath(path);
        try
        {
            using var pin = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var key = LocalFileIdentity.Read(pin).Key;
            return await SqliteNendoStore.ReadDeclaredIdentityAsync(fullPath, cancellationToken) is { } declared
                ? new(key, declared.ApplicationId, declared.InstanceId)
                : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Holds a read-only, coherent observation of the file. A later refresh must
    /// explicitly reclassify it; outside changes are never silently adopted.
    /// </summary>
    public static async Task<NendoWriteCoordinator> OpenReadOnlyAsync(
        string path,
        CancellationToken cancellationToken = default) =>
        await OpenReadOnlyCoreAsync(path, null, cancellationToken);

    public static Task<NendoWriteCoordinator> OpenReadOnlyObservedAsync(
        string path, NendoFileObservation observation, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observation);
        return OpenReadOnlyCoreAsync(path, observation, cancellationToken);
    }

    private static async Task<NendoWriteCoordinator> OpenReadOnlyCoreAsync(
        string path, NendoFileObservation? observation, CancellationToken cancellationToken)
    {
        var fullPath = ValidatePath(path);
        var pin = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        try
        {
            var observed = await InspectToOpenAsync(fullPath, NendoInterruptedWrite.Refuse, cancellationToken);
            if (observation is not null &&
                (observation.PhysicalFileKey != LocalFileIdentity.Read(pin).Key ||
                 observation.Inspection.Manifest != observed.Inspection.Manifest ||
                 observation.ContentDigest is not null && observation.ContentDigest != observed.ContentDigest))
                throw new NendoPreconditionException("file-changed-before-open", "The selected file changed after inspection. Review it again before opening.");
            if (observed.Snapshot is null)
            {
                throw new NendoFileOpenException(observed.Inspection);
            }
            return new NendoWriteCoordinator(fullPath, pin, observed);
        }
        catch
        {
            pin.Dispose();
            throw;
        }
    }

    public static async Task<NendoWriteCoordinator> CreateAsync(
        string path,
        string ownerId,
        CancellationToken cancellationToken = default)
    {
        return await CreateCoreAsync(
            path,
            ownerId,
            FileMode.CreateNew,
            requireEmptyTarget: false,
            cancellationToken);
    }

    public static async Task<NendoWriteCoordinator> CreateOrInitializeEmptyAsync(
        string path,
        string ownerId,
        CancellationToken cancellationToken = default)
    {
        return await CreateCoreAsync(
            path,
            ownerId,
            FileMode.OpenOrCreate,
            requireEmptyTarget: true,
            cancellationToken);
    }

    private static async Task<NendoWriteCoordinator> CreateCoreAsync(
        string path,
        string ownerId,
        FileMode fileMode,
        bool requireEmptyTarget,
        CancellationToken cancellationToken)
    {
        var fullPath = ValidatePath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)
            ?? throw new NendoValidationException("The Nendo file needs a parent directory."));
        var ownership = WriteOwnershipLease.Acquire(fullPath, ownerId);
        InstanceOwnershipLease? instanceOwnership = null;
        FileStream? pathPin = null;
        SqliteNendoStore? store = null;
        var ownsTarget = false;
        try
        {
            pathPin = OpenPathPin(fullPath, fileMode);
            if (requireEmptyTarget && pathPin.Length != 0)
            {
                throw new IOException(
                    $"The file '{fullPath}' already exists and is not empty. Choose a new name or open it instead.");
            }
            ownsTarget = true;
            store = await SqliteNendoStore.CreateAsync(fullPath, cancellationToken);
            var authority = await store.GetAuthoritySnapshotAsync(cancellationToken);
            instanceOwnership = InstanceOwnershipLease.Acquire(authority.InstanceId);
            return new NendoWriteCoordinator(fullPath, ownership, instanceOwnership, pathPin, store, authority);
        }
        catch
        {
            try
            {
                if (store is not null) await store.DisposeAsync();
            }
            finally
            {
                pathPin?.Dispose();
                ownership.Dispose();
                instanceOwnership?.Dispose();
                if (ownsTarget) DeletePartialCreation(fullPath);
            }
            throw;
        }
    }

    public static async Task<NendoWriteCoordinator> OpenAsync(
        string path,
        string ownerId,
        CancellationToken cancellationToken = default) =>
        await OpenCoreAsync(path, ownerId, null, cancellationToken);

    public static Task<NendoWriteCoordinator> OpenObservedAsync(
        string path, string ownerId, NendoFileObservation observation, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observation);
        return OpenCoreAsync(path, ownerId, observation, cancellationToken);
    }

    private static async Task<NendoWriteCoordinator> OpenCoreAsync(
        string path, string ownerId, NendoFileObservation? observation, CancellationToken cancellationToken)
    {
        var fullPath = ValidatePath(path);
        if (!File.Exists(fullPath))
        {
            throw new FileNotFoundException("The selected Nendo file does not exist.", fullPath);
        }
        // A raw copy carries the same instance ID even at a different path. Its
        // guard is acquired before creating the path's writer sidecar or opening
        // writable SQLite. Inspection alone never grants this authority.
        InstanceOwnershipLease? instanceOwnership = null;
        WriteOwnershipLease? ownership = null;
        FileStream? pathPin = null;
        SqliteNendoStore? store = null;
        try
        {
            pathPin = OpenPathPin(fullPath, FileMode.Open, FileAccess.Read);
            // Pin the namespace before classification. The pin is read-only and
            // creates no writer sidecar; no writable connection exists yet.
            NendoFileInspection inspection;
            string expectedDigest;
            var confirming = observation is { ContentDigest: not null, PhysicalFileKey: not null } &&
                observation.Inspection.CanAcquireWriteAuthority &&
                observation.PhysicalFileKey == LocalFileIdentity.Read(pathPin).Key;
            if (confirming)
            {
                // The Engine inspected these bytes moments ago; only it can make an
                // observation. Classifying them a second time was the largest cost of
                // an open (W-026). The pinned file's physical facts are checked here,
                // and once the write lease is held the content digest must equal the
                // observed one, and the first authority read runs SQLite's integrity
                // check, so a file that changed in between is refused rather than trusted.
                SqliteNendoStore.RequireUnchangedPhysicalFile(fullPath, pathPin);
                inspection = observation!.Inspection;
                expectedDigest = observation.ContentDigest!;
            }
            else
            {
                var inspected = await InspectToOpenAsync(fullPath, NendoInterruptedWrite.Refuse, cancellationToken);
                if (!inspected.Inspection.CanAcquireWriteAuthority)
                {
                    throw new NendoFileOpenException(inspected.Inspection);
                }
                if (observation is not null &&
                    (observation.PhysicalFileKey != LocalFileIdentity.Read(pathPin).Key ||
                     observation.Inspection.Manifest != inspected.Inspection.Manifest ||
                     observation.ContentDigest is null || observation.ContentDigest != inspected.ContentDigest))
                    throw new NendoPreconditionException("file-changed-before-open", "The selected file changed after inspection. Review it again before opening.");
                inspection = inspected.Inspection;
                expectedDigest = inspected.ContentDigest!;
            }
            var expectedInstance = inspection.Manifest!.InstanceId;
            instanceOwnership = InstanceOwnershipLease.Acquire(expectedInstance);
            ownership = WriteOwnershipLease.Acquire(fullPath, ownerId);
            using var storeTiming = NendoStartupDiagnostics.Source.StartActivity("engine.coordinator.store-open");
            store = await SqliteNendoStore.OpenAsync(fullPath, cancellationToken);
            storeTiming?.Dispose();
            using var authorityTiming = NendoStartupDiagnostics.Source.StartActivity("engine.coordinator.authority");
            var authority = await store.GetAuthoritySnapshotAsync(cancellationToken);
            if (authority.InstanceId != expectedInstance || await store.GetContentDigestAsync(cancellationToken) != expectedDigest)
                throw new NendoPreconditionException("file-changed-before-open", "The selected instance changed before authority was established.");
            // The cold authority read above has just run SQLite's integrity_check on this
            // connection and refused anything but ok; a second scan here bought nothing (ESC-09).
            var opened = new NendoWriteCoordinator(fullPath, ownership, instanceOwnership, pathPin, store, authority)
            {
                _inspection = inspection with
                {
                    Classification = NendoOpenClassification.NormalWritable,
                    Capabilities = NendoFileCapabilities.Writable,
                },
            };
            // Read here rather than on demand. The requirement follows from the file,
            // not from who is asking, and a coordinator that reported "nothing needs
            // approval" until somebody thought to refresh would fail open — which is
            // the one direction this must never fail.
            await opened.RefreshBehaviourRequirementAsync(cancellationToken);
            return opened;
        }
        catch
        {
            try
            {
                if (store is not null) await store.DisposeAsync();
            }
            finally
            {
                pathPin?.Dispose();
                ownership?.Dispose();
                instanceOwnership?.Dispose();
            }
            throw;
        }
    }
}
