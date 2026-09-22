using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopReplacementReview(string ReviewId, NendoReplacementResolutionPlan Plan,
    DesktopLocationWarning? LocationWarning, bool ClosesCurrentFile);
internal sealed record DesktopReplacementResolutionView(NendoReplacementResolutionResult Resolution,
    DesktopSessionView Session, string? Notice);

internal sealed partial class DesktopSessionController
{
    private readonly Dictionary<string, ReplacementReviewContext> _replacementReviews = new(StringComparer.Ordinal);

    // A selected receipt is a host-owned picker result, never a renderer path.
    // Preparing a review does not close a file, revoke an agent or modify bytes.
    internal async Task<DesktopReplacementReview> PrepareReplacementResolutionAsync(string? selectedReceipt = null,
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_replacementReviews.Count >= 8) _replacementReviews.Clear();
            var path = selectedReceipt is null
                ? _currentPath ?? _recoveryPath ?? throw new NendoPreconditionException("recovery-file-unavailable", "Choose a pending recovery record first.")
                : RecoveryTargetFromReceipt(selectedReceipt);
            var review = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(path, cancellationToken);
            var id = $"recovery-review-{Guid.NewGuid():N}";
            _replacementReviews.Add(id, new(path, _fileSessionId, review));
            return new(id, review.Plan, _locationPolicy.Inspect(path), _currentPath is not null);
        }
        finally { _gate.Release(); }
    }

    internal async Task AcknowledgeRecoveryLocationAsync(string reviewId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try { AcknowledgeLocationCore(RequireReplacementReview(reviewId).Path); }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopReplacementResolutionView> ResolveReplacementAsync(string reviewId,
        NendoReplacementResolutionChoice choice, bool ownerConfirmed, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var context = RequireReplacementReview(reviewId);
            if (!ownerConfirmed)
                throw new NendoPreconditionException("recovery-confirmation-required", "Review and confirm which file to use before resolving recovery.");
            if (!context.Review.Plan.Options.Any(option => option.Choice == choice))
                throw new NendoPreconditionException("recovery-choice-unavailable", "That file is not a verified choice in this review.");
            RequireWritableLocation(context.Path);
            cancellationToken.ThrowIfCancellationRequested();
            // Explicit confirmation authorizes closing the current file and
            // discarding its proposals. Old agent admission and queued requests
            // cannot follow the fresh session. Keep the captured review locally.
            await CloseFileCoreAsync();
            NendoReplacementResolutionResult result;
            try { result = await NendoWriteCoordinator.ResolveReplacementAsync(context.Review, choice, cancellationToken); }
            catch
            {
                await DetachReplacementCoreAsync(context.Path,
                    "Recovery was not acknowledged. Keep all recovery files and review the record again before choosing a file.", "recovery-resolution-incomplete");
                throw;
            }
            try
            {
                BeforeReplacementReopenForTest?.Invoke();
                var expected = result.OpenObservation ?? throw new NendoPreconditionException("recovery-observation-missing", "Inspect the acknowledged file before opening it.");
                var candidate = await PrepareOpenCoreAsync(context.Path, CancellationToken.None, expected);
                var readOnly = !expected.Inspection.CanAcquireWriteAuthority || candidate.Assessment.KnownInstanceCollision;
                var view = await OpenCandidateCoreAsync(candidate, readOnly, CancellationToken.None);
                return new(result, view, readOnly ? "Recovery was acknowledged. The selected file is open read-only; check File health before editing. Agent access is off." : null);
            }
            catch
            {
                const string notice = "Recovery was acknowledged, but the verified file could not be reopened. Keep the recovery copies and inspect the file again. Editing and agent access remain off.";
                await DetachReplacementCoreAsync(context.Path, notice, "recovery-reopen-required");
                return new(result, _detachedRecovery!, notice);
            }
        }
        finally { _gate.Release(); }
    }

    private ReplacementReviewContext RequireReplacementReview(string reviewId)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _replacementReviews.TryGetValue(reviewId, out var context) && context.FileSessionId == _fileSessionId
            ? context : throw new NendoPreconditionException("recovery-review-stale", "The file session changed or this recovery review expired. Review the record again.");
    }

    private static string RecoveryTargetFromReceipt(string receiptPath)
    {
        var path = Path.GetFullPath(receiptPath);
        const string suffix = ".recovery.json";
        if (!path.EndsWith(".nendo" + suffix, StringComparison.OrdinalIgnoreCase))
            throw new NendoPreconditionException("recovery-record-name", "Choose the pending record named application.nendo.recovery.json, not an archived receipt or another JSON file.");
        return path[..^suffix.Length];
    }

    private sealed record ReplacementReviewContext(string Path, string FileSessionId, NendoReplacementRecoveryReview Review);
}
