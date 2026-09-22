using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopRestoreView(NendoRestoreResult Restore, DesktopSessionView Session, string? Notice);
internal sealed record DesktopUpgradeView(NendoUpgradeResult Upgrade, DesktopSessionView Session, string? Notice);

internal sealed partial class DesktopSessionController
{
    private DesktopSessionView? _detachedRecovery;
    private string? _recoveryPath;
    internal Action? BeforeReplacementReopenForTest { get; set; }

    internal Task<NendoBackupPlan> PrepareBackupAsync(string path, string requestId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(path); return service.PrepareBackupAsync(path, requestId, cancellationToken); }, cancellationToken);

    internal Task<NendoBackupResult> CreateBackupAsync(string planId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.CreateBackupAsync(planId, cancellationToken), cancellationToken);

    internal Task<NendoRestorePlan> PrepareRestoreAsync(string path, string requestId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(_currentPath!); return service.PrepareRestoreAsync(path, requestId, cancellationToken); }, cancellationToken);

    internal Task<NendoUpgradePlan> PrepareUpgradeAsync(string requestId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(_currentPath!); return service.PrepareUpgradeAsync(requestId, cancellationToken); }, cancellationToken);

    internal async Task<DesktopRestoreView> RestoreAsync(string planId, bool confirmDiscardProposals, CancellationToken cancellationToken = default)
    {
        var completed = await ReplaceFileAsync(service => service.RestoreAsync(planId, confirmDiscardProposals, cancellationToken),
            result => result.OpenObservation, cancellationToken);
        return new(completed.Result, completed.Session, completed.Notice);
    }

    internal async Task<DesktopUpgradeView> UpgradeAsync(string planId, CancellationToken cancellationToken = default)
    {
        var completed = await ReplaceFileAsync(service => service.UpgradeAsync(planId, cancellationToken),
            result => result.OpenObservation, cancellationToken);
        return new(completed.Result, completed.Session, completed.Notice);
    }

    internal async Task<NendoReplacementRecovery> GetReplacementRecoveryAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var path = _currentPath ?? _recoveryPath ?? throw new NendoPreconditionException(
                "recovery-file-unavailable", "Select a file before inspecting its recovery record.");
            return await NendoWriteCoordinator.InspectReplacementRecoveryAsync(path, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopSessionView> ReinspectCurrentAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_service?.Capabilities.Mutate is true)
                throw new NendoPreconditionException("inspection-not-required", "This file is already open for editing. Restarting the view does not require reopening it.");
            var path = _currentPath ?? _recoveryPath ?? throw new NendoPreconditionException(
                "recovery-file-unavailable", "Choose a file to inspect first.");
            await CloseFileCoreAsync();
            try { return await OpenCandidateCoreAsync(await PrepareOpenCoreAsync(path, cancellationToken), true, cancellationToken); }
            catch
            {
                await DetachReplacementCoreAsync(path,
                    "This file could not be reopened for inspection. Preserve it and use Open file or backup to choose another file.",
                    "inspection-unavailable");
                throw;
            }
        }
        finally { _gate.Release(); }
    }

    private async Task<(T Result, DesktopSessionView Session, string? Notice)> ReplaceFileAsync<T>(
        Func<NendoApplicationService, Task<T>> replace, Func<T, NendoFileObservation?> observation,
        CancellationToken cancellationToken)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var service = RequireService();
            var oldCoordinator = _coordinator!;
            var path = _currentPath!;
            var previous = _currentObservation!;
            var admission = await _fileHistory.CheckAsync(previous, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            // Stop integration admission and drain admitted mutations first. Do
            // not reject submitted proposals here: the Engine rechecks the exact
            // proposal set and the owner's discard confirmation after draining.
            await StopAgentAccessCoreAsync();
            cancellationToken.ThrowIfCancellationRequested();
            T result;
            try { result = await replace(service); }
            catch when (oldCoordinator.Health == NendoSessionHealth.Closed)
            {
                await DetachReplacementCoreAsync(path,
                    "The replacement did not finish. Inspect the recovery record and retained original before choosing a file to open.");
                throw;
            }

            // Replacement has committed. Cancellation after this point cannot
            // mean undo; return its result even if fresh session admission fails.
            try
            {
                await CloseFileCoreAsync();
                BeforeReplacementReopenForTest?.Invoke();
                var expected = observation(result) ?? throw new NendoPreconditionException(
                    "replacement-observation-missing", "The completed replacement did not provide a verified reopening observation.");
                if (admission.Conflict is null)
                    _ = await _fileHistory.RememberReplacementAsync(path, previous, expected, CancellationToken.None);
                var candidate = await PrepareOpenCoreAsync(path, CancellationToken.None, expected);
                // Replacing an inspected raw copy must not promote it over a
                // separate known original. It can reopen only for inspection.
                var readOnly = admission.Conflict is not null || candidate.Assessment.KnownInstanceCollision;
                var view = await OpenCandidateCoreAsync(candidate, readOnly, CancellationToken.None);
                return (result, view, readOnly
                    ? "The replacement finished and is open read-only because another known file carries this instance identity."
                    : null);
            }
            catch (Exception)
            {
                const string notice = "The replacement finished, but the verified result could not be reopened. Editing and agent access remain off. Inspect the file and retained original before continuing.";
                await DetachReplacementCoreAsync(path, notice);
                return (result, _detachedRecovery!, notice);
            }
        }
        finally { _gate.Release(); }
    }

    private async Task DetachReplacementCoreAsync(string path, string message, string findingCode = "replacement-reopen-required")
    {
        try { await CloseFileCoreAsync(); }
        catch (Exception)
        {
            message += " Local session cleanup also needs attention; close the application before reconnecting an agent.";
        }
        _recoveryPath = path;
        NendoReplacementRecovery? recovery = null;
        try { recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(path, CancellationToken.None); }
        catch (Exception)
        {
            message += " The recovery record could not be read. Preserve the files and use Open to inspect a verified backup separately.";
        }
        _detachedRecovery = new(false, Path.GetFileName(path), "recoveryRequired", null, [], [], [], null)
        {
            FileSessionId = _fileSessionId,
            LocationWarning = _locationPolicy.Inspect(path),
            Findings = [new(findingCode, message)],
            ReplacementRecovery = recovery,
        };
    }
}
