using System.Text.Json;
using System.Text.Json.Serialization;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

public enum NendoReplacementResolutionChoice { KeepActive, UseRetainedOriginal, UseStagedReplacement }

public sealed record NendoReplacementResolutionOption(
    NendoReplacementResolutionChoice Choice, string FileName, NendoManifestSnapshot Manifest);

public sealed record NendoReplacementResolutionPlan(
    string PlanId, string FileName, NendoReplacementRecovery Recovery,
    IReadOnlyList<NendoReplacementResolutionOption> Options, string RetentionPolicy);

public sealed record NendoReplacementResolutionResult(
    string PlanId, string FileName, NendoReplacementResolutionChoice Choice,
    string AcknowledgedReceiptFileName, bool IsIdempotentReplay)
{
    [JsonIgnore]
    public NendoFileObservation? OpenObservation { get; internal init; }
}

/// <summary>
/// Opaque native-host review, like an open observation, not deserializable
/// renderer authority. Resolution is a separate explicit owner action. Files
/// are never removed: the pending marker is archived and unused stages remain.
/// </summary>
public sealed class NendoReplacementRecoveryReview
{
    private readonly string _target;
    private readonly LocalFileIdentity _markerIdentity;
    private readonly string _markerDigest;
    private readonly IReadOnlyDictionary<NendoReplacementResolutionChoice, Candidate> _candidates;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private NendoReplacementResolutionResult? _completed;
    internal Action<string>? ResolutionCheckpoint { get; set; }

    private NendoReplacementRecoveryReview(string target, LocalFileIdentity markerIdentity, string markerDigest,
        NendoReplacementResolutionPlan plan, IReadOnlyDictionary<NendoReplacementResolutionChoice, Candidate> candidates)
    {
        _target = target;
        _markerIdentity = markerIdentity;
        _markerDigest = markerDigest;
        Plan = plan;
        _candidates = candidates;
    }

    public NendoReplacementResolutionPlan Plan { get; }

    internal static async Task<NendoReplacementRecoveryReview> PrepareAsync(string target, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await using var marker = new FileStream(FileReplacementReceipt.PendingPath(target), FileMode.Open, FileAccess.Read, FileShare.Read);
        if (marker.Length > 32 * 1024) throw Unavailable();
        FileReplacementReceipt? receipt;
        try { receipt = await JsonSerializer.DeserializeAsync<FileReplacementReceipt>(marker, cancellationToken: cancellationToken); }
        catch (JsonException) { throw Unavailable(); }
        if (receipt is null || !receipt.IsValidFor(target)) throw Unavailable();
        var markerIdentity = LocalFileIdentity.Read(marker);
        var markerDigest = VerifiedFileMove.Digest(marker);
        var recovery = await FileReplacementReceipt.InspectAsync(target, cancellationToken);
        var candidates = new Dictionary<NendoReplacementResolutionChoice, Candidate>();
        var active = await CaptureAsync(target, receipt, original: true, receipt.OriginalPhysicalKey, cancellationToken)
            ?? await CaptureAsync(target, receipt, original: false, receipt.StagePhysicalKey, cancellationToken);
        if (active is not null) candidates.Add(NendoReplacementResolutionChoice.KeepActive, active);
        else if (!File.Exists(target) && !Directory.Exists(target))
        {
            var folder = Path.GetDirectoryName(target)!;
            var original = await CaptureAsync(Path.Combine(folder, receipt.RetainedFileName), receipt, true, receipt.OriginalPhysicalKey, cancellationToken);
            var staged = await CaptureAsync(Path.Combine(folder, receipt.StagedFileName), receipt, false, receipt.StagePhysicalKey, cancellationToken);
            if (original is not null) candidates.Add(NendoReplacementResolutionChoice.UseRetainedOriginal, original);
            if (staged is not null) candidates.Add(NendoReplacementResolutionChoice.UseStagedReplacement, staged);
        }
        var plan = new NendoReplacementResolutionPlan(receipt.OperationId, Path.GetFileName(target), recovery,
            candidates.Select(pair => new NendoReplacementResolutionOption(pair.Key, Path.GetFileName(pair.Value.Path), pair.Value.Observation.Inspection.Manifest!)).ToArray(),
            "Only the selected verified file will be used. No existing target is overwritten. The recovery record is archived beside the application; unused stages, pre-change backups and retained originals are kept without automatic deletion.");
        return new(target, markerIdentity, markerDigest, plan, candidates);
    }

    internal async Task<NendoReplacementResolutionResult> ResolveAsync(NendoReplacementResolutionChoice choice, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (!_candidates.TryGetValue(choice, out var candidate)) throw Unavailable();
            var archive = _target + $".recovery-ack-{Plan.PlanId}.json";
            if (_completed is not null)
            {
                if (_completed.Choice != choice) throw new NendoIdempotencyConflictException("This recovery review already resolved a different choice.");
                VerifyUnchanged(_target, candidate.Identity, candidate.ByteDigest);
                VerifyUnchanged(archive, _markerIdentity, _markerDigest);
                return _completed with { IsIdempotentReplay = true };
            }
            // Host must close the old file session first. Same-instance/path
            // exclusion applies even when the target is currently absent.
            using var instance = InstanceOwnershipLease.Acquire(candidate.Observation.Inspection.Manifest!.InstanceId);
            using var ownership = WriteOwnershipLease.Acquire(_target, $"recovery-{Environment.ProcessId}");
            using var markerMove = VerifiedFileMove.Acquire(FileReplacementReceipt.PendingPath(_target), _markerIdentity, _markerDigest);
            RequireVacant(archive);
            RequireNoSidecars(candidate.Path);
            RequireNoSidecars(_target);
            using var selected = VerifiedFileMove.Acquire(candidate.Path, candidate.Identity, candidate.ByteDigest);
            if (choice != NendoReplacementResolutionChoice.KeepActive) RequireVacant(_target);
            cancellationToken.ThrowIfCancellationRequested();
            ResolutionCheckpoint?.Invoke("before-resolution");
            cancellationToken.ThrowIfCancellationRequested();
            RequireNoSidecars(candidate.Path);
            RequireNoSidecars(_target);
            if (choice != NendoReplacementResolutionChoice.KeepActive)
            {
                // Held-handle no-overwrite activation; cancellation after this
                // namespace change cannot mean that the old state was restored.
                selected.MoveTo(_target);
                ResolutionCheckpoint?.Invoke("resolution-file-activated");
            }
            RequireNoSidecars(_target);
            markerMove.MoveTo(archive);
            _completed = new(Plan.PlanId, Plan.FileName, choice, Path.GetFileName(archive), false)
            {
                OpenObservation = candidate.Observation,
            };
            ResolutionCheckpoint?.Invoke("resolution-acknowledged");
            return _completed;
        }
        finally { _gate.Release(); }
    }

    private static async Task<Candidate?> CaptureAsync(string path, FileReplacementReceipt receipt, bool original,
        string physicalKey, CancellationToken cancellationToken)
    {
        try
        {
            // Read-only pin prevents writes/deletion across typed inspection and
            // byte hashing. Resolution reacquires and compares that exact file.
            using var pin = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var identity = LocalFileIdentity.Read(pin);
            if (identity.Key != physicalKey) return null;
            var inspected = await SqliteNendoStore.InspectAsync(path, cancellationToken, ignoreReplacementMarker: true);
            if (!inspected.Inspection.Capabilities.Backup || inspected.Inspection.Manifest != (original ? receipt.Current : receipt.Result) ||
                inspected.ContentDigest != (original ? receipt.CurrentDigest : receipt.ResultDigest)) return null;
            return new(path, identity, VerifiedFileMove.Digest(pin), new(inspected.Inspection, identity.Key, inspected.ContentDigest));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return null; }
    }

    private static void VerifyUnchanged(string path, LocalFileIdentity identity, string digest)
    {
        using var pin = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (LocalFileIdentity.Read(pin) != identity || VerifiedFileMove.Digest(pin) != digest)
            throw new NendoIdempotencyConflictException("The acknowledged recovery result changed. It was not recreated or overwritten.");
    }

    private static void RequireVacant(string path)
    {
        if (File.Exists(path) || Directory.Exists(path))
            throw new NendoPreconditionException("recovery-destination-occupied", "An unexpected file occupies the recovery destination. It was not overwritten.");
    }

    private static void RequireNoSidecars(string path)
    {
        if (new[] { "-journal", "-wal", "-shm" }.Any(suffix => File.Exists(path + suffix) || Directory.Exists(path + suffix)))
            throw new NendoPreconditionException("recovery-storage-busy", "An unfinished storage operation prevents recovery resolution. Preserve its files and inspect again after its writer closes.");
    }

    private static NendoPreconditionException Unavailable() => new("recovery-resolution-unavailable",
        "This recovery review has no verified file for that choice. Preserve all files and inspect a verified backup separately.");

    private sealed record Candidate(string Path, LocalFileIdentity Identity, string ByteDigest, NendoFileObservation Observation);
}

public sealed partial class NendoWriteCoordinator
{
    public static Task<NendoReplacementRecoveryReview> PrepareReplacementResolutionAsync(string path, CancellationToken cancellationToken = default) =>
        NendoReplacementRecoveryReview.PrepareAsync(ValidatePath(path), cancellationToken);

    public static Task<NendoReplacementResolutionResult> ResolveReplacementAsync(NendoReplacementRecoveryReview review,
        NendoReplacementResolutionChoice choice, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(review);
        return review.ResolveAsync(choice, cancellationToken);
    }
}
