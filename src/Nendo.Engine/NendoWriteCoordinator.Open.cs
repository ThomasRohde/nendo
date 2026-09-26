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
        (await SqliteNendoStore.InspectAsync(ValidatePath(path), cancellationToken)).Inspection;

    public static async Task<NendoFileObservation> ObserveAsync(string path, CancellationToken cancellationToken = default)
    {
        var fullPath = ValidatePath(path);
        try
        {
            using var pin = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var identity = LocalFileIdentity.Read(pin);
            var inspected = await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
            return new(inspected.Inspection, identity.Key, inspected.ContentDigest);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            var inspected = await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
            return new(inspected.Inspection, null, null);
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
            var observed = await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
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
                // observed one and SQLite's integrity check must pass, so a file that
                // changed in between is refused rather than trusted.
                SqliteNendoStore.RequireUnchangedPhysicalFile(fullPath, pathPin);
                inspection = observation!.Inspection;
                expectedDigest = observation.ContentDigest!;
            }
            else
            {
                var inspected = await SqliteNendoStore.InspectAsync(fullPath, cancellationToken);
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
            if (confirming && !await store.PassesIntegrityCheckAsync(cancellationToken))
                throw new NendoPreconditionException("file-changed-before-open", "The selected file no longer passes its integrity check. Review it again before opening.");
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
