using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

/// <summary>
/// Immutable host receipt, not embedded semantic history. A pending marker is
/// never authority to roll forward/back, delete files or repair their contents.
/// Evidence is re-read and compared explicitly after interruption.
/// </summary>
internal sealed record FileReplacementReceipt(
    int Version, string OperationId, string Kind, string TargetFileName,
    string RetainedFileName, string StagedFileName, string CurrentBackupFileName,
    NendoManifestSnapshot Current, NendoManifestSnapshot Result,
    string CurrentDigest, string ResultDigest, string OriginalPhysicalKey, string StagePhysicalKey, string CurrentBackupPhysicalKey,
    DateTimeOffset PreparedAt)
{
    internal static string PendingPath(string target) => target + ".recovery.json";

    internal async Task<LocalFileIdentity> WriteNewAsync(string path, CancellationToken cancellationToken)
    {
        // Never replace an earlier or unrelated recovery record.
        await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
        var identity = LocalFileIdentity.Read(stream);
        await JsonSerializer.SerializeAsync(stream, this, cancellationToken: cancellationToken);
        await stream.FlushAsync(cancellationToken);
        stream.Flush(flushToDisk: true);
        return identity;
    }

    internal static async Task<NendoReplacementRecovery> InspectAsync(string target, CancellationToken cancellationToken)
    {
        var pending = PendingPath(target);
        if (!File.Exists(pending)) return new(false, null, "No pending file replacement was found.", null, null, null);
        try
        {
            await using var stream = new FileStream(pending, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length > 32 * 1024) return Invalid();
            var receipt = await JsonSerializer.DeserializeAsync<FileReplacementReceipt>(stream, cancellationToken: cancellationToken);
            if (receipt is null || !receipt.IsValidFor(target)) return Invalid();
            var folder = Path.GetDirectoryName(target)!;
            var active = await InspectEvidenceAsync(target, receipt.Current, receipt.CurrentDigest, receipt.OriginalPhysicalKey,
                receipt.Result, receipt.ResultDigest, receipt.StagePhysicalKey, cancellationToken);
            var retained = await InspectEvidenceAsync(Path.Combine(folder, receipt.RetainedFileName),
                receipt.Current, receipt.CurrentDigest, receipt.OriginalPhysicalKey, null, null, null, cancellationToken);
            var staged = await InspectEvidenceAsync(Path.Combine(folder, receipt.StagedFileName),
                null, null, null, receipt.Result, receipt.ResultDigest, receipt.StagePhysicalKey, cancellationToken);
            var preChangeBackup = await InspectEvidenceAsync(Path.Combine(folder, receipt.CurrentBackupFileName),
                receipt.Current, receipt.CurrentDigest, receipt.CurrentBackupPhysicalKey, null, null, null, cancellationToken);
            return new(true, receipt.OperationId,
                "A file replacement was interrupted. These are verified observations, not permission to resume it automatically. Keep the recovery copies until you have chosen and checked the file to use.",
                active, retained, staged, preChangeBackup);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return Invalid();
        }
    }

    internal bool IsValidFor(string target) =>
        Version == 1 && Kind is "restore" or "upgrade" && OperationId is not null &&
        OperationId.StartsWith(Kind + "-", StringComparison.Ordinal) && OperationId.Length == 40 && OperationId[8..].All(Uri.IsHexDigit) &&
        TargetFileName == Path.GetFileName(target) && SafeName(TargetFileName) && SafeName(RetainedFileName) &&
        SafeName(StagedFileName) && SafeName(CurrentBackupFileName) &&
        RetainedFileName == $"{Path.GetFileNameWithoutExtension(target)}.pre-{Kind}-{OperationId[8..]}.nendo" &&
        StagedFileName == $".nendo-stage-{Kind}-{OperationId[8..]}.nendo" &&
        CurrentBackupFileName == $".nendo-stage-current-{OperationId[8..]}.nendo" &&
        Current is not null && Result is not null && Current.ApplicationId == Result.ApplicationId && Current.InstanceId == Result.InstanceId &&
        ValidDigest(CurrentDigest) && ValidDigest(ResultDigest) &&
        !string.IsNullOrWhiteSpace(OriginalPhysicalKey) && OriginalPhysicalKey.Length <= 100 &&
        !string.IsNullOrWhiteSpace(StagePhysicalKey) && StagePhysicalKey.Length <= 100 &&
        !string.IsNullOrWhiteSpace(CurrentBackupPhysicalKey) && CurrentBackupPhysicalKey.Length <= 100 &&
        new[] { TargetFileName, RetainedFileName, StagedFileName, CurrentBackupFileName }.Distinct(StringComparer.OrdinalIgnoreCase).Count() == 4;

    private static bool SafeName(string? name) => !string.IsNullOrWhiteSpace(name) && name.Length <= 255 &&
        name == Path.GetFileName(name) && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 &&
        name.EndsWith(NendoFormat.FileExtension, StringComparison.OrdinalIgnoreCase);

    private static bool ValidDigest(string? digest) => digest is { Length: 64 } && digest.All(Uri.IsHexDigit);

    private static NendoReplacementRecovery Invalid() => new(true, null,
        "A recovery record is unreadable or unrecognised. It was preserved without following any recorded paths. Preserve the files and inspect a verified backup separately.", null, null, null);

    private static async Task<NendoRecoveryFileStatus> InspectEvidenceAsync(
        string path, NendoManifestSnapshot? original, string? originalDigest, string? originalPhysical,
        NendoManifestSnapshot? result, string? resultDigest, string? resultPhysical, CancellationToken cancellationToken)
    {
        try
        {
            using var pin = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var physical = LocalFileIdentity.Read(pin).Key;
            var inspected = await SqliteNendoStore.InspectAsync(path, cancellationToken, ignoreReplacementMarker: true);
            var state = inspected.ContentDigest is not null && physical == originalPhysical &&
                inspected.ContentDigest == originalDigest && inspected.Inspection.Manifest == original ? "verifiedOriginal" :
                inspected.ContentDigest is not null && physical == resultPhysical &&
                inspected.ContentDigest == resultDigest && inspected.Inspection.Manifest == result ? "verifiedReplacement" :
                inspected.Inspection.Manifest is null ? "unavailable" : "changed";
            return new(Path.GetFileName(path), state, inspected.Inspection.Manifest);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return new(Path.GetFileName(path), File.Exists(path) ? "unavailable" : "missing", null);
        }
    }
}
