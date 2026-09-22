using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopFileOpenAssessment(
    string AssessmentId, string FileName, NendoFileInspection Inspection,
    bool KnownInstanceCollision, string? KnownOriginalRecentId, string? KnownOriginalFileName, string? Notice)
{
    public DesktopLocationWarning? LocationWarning { get; init; }
}

internal sealed class DesktopFileCollisionException(DesktopFileOpenAssessment assessment)
    : NendoException("Another known file carries this instance identity. Open this file read-only, open the known original, or create a Duplicate or Fork.")
{
    internal DesktopFileOpenAssessment Assessment { get; } = assessment;
}

internal sealed partial class DesktopSessionController
{
    private readonly DesktopFileHistory _fileHistory;
    private readonly Dictionary<string, OpenCandidate> _openCandidates = new(StringComparer.Ordinal);
    private string? _currentPath;
    private string? _fileHistoryNotice;
    private NendoFileObservation? _currentObservation;

    /// <summary>
    /// Name of the open file, for the window title bar. Null when no file is open.
    /// </summary>
    internal string? CurrentFileName => _currentPath is null ? null : Path.GetFileName(_currentPath);

    /// <summary>
    /// Where the open file is, for the host alone — the window uses it to tell one
    /// open file from another. Two files can share a name, and the name is all the
    /// title bar has, so anything that keys off the caption cannot see the difference.
    /// Never serialised, never across the bridge: see <see cref="DesktopShellRecentFile"/>.
    /// </summary>
    internal string? CurrentFilePath => _currentPath;

    internal async Task<DesktopRecentFiles> GetRecentFilesAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var files = await _fileHistory.ListAsync(cancellationToken);
            return files with { Notice = files.Notice ?? _fileHistoryNotice };
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// The recent files the taskbar menu may offer, paths included. Inside the host
    /// only: see <see cref="DesktopShellRecentFile"/> for why this is not the list the
    /// Workbench gets.
    /// </summary>
    internal async Task<IReadOnlyList<DesktopShellRecentFile>> GetShellRecentFilesAsync(int wanted, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await _fileHistory.ListForShellAsync(wanted, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopFileOpenAssessment> AssessOpenAsync(string path, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            return (await PrepareOpenCoreAsync(path, cancellationToken)).Assessment;
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopSessionView> OpenAssessedAsync(string assessmentId, bool readOnly, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            if (!_openCandidates.TryGetValue(assessmentId, out var candidate))
                throw new NendoPreconditionException("open-assessment-unavailable", "Inspect the selected file again before opening it.");
            return await OpenCandidateCoreAsync(candidate, readOnly, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopSessionView> OpenReadOnlyAsync(string path, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            return await OpenCandidateCoreAsync(await PrepareOpenCoreAsync(path, cancellationToken), readOnly: true, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopSessionView> OpenRecentAsync(string recentId, bool readOnly = false, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            var resolved = await _fileHistory.ResolveAsync(recentId, cancellationToken);
            var candidate = await PrepareOpenCoreAsync(resolved.Path, cancellationToken, resolved.Observation);
            return await OpenCandidateCoreAsync(candidate, readOnly, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopFileOpenAssessment> AssessRecentAsync(string recentId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            var resolved = await _fileHistory.ResolveAsync(recentId, cancellationToken);
            return (await PrepareOpenCoreAsync(resolved.Path, cancellationToken, resolved.Observation)).Assessment;
        }
        finally { _gate.Release(); }
    }

    // Host-only copy entry points; native destination selection supplies the path.
    internal Task<NendoIdentityCopyPlan> PrepareIdentityCopyAsync(
        NendoIdentityCopyKind kind, string path, string requestId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(path); return service.PrepareIdentityCopyAsync(kind, path, requestId, cancellationToken); }, cancellationToken);

    internal Task<NendoIdentityCopyResult> CreateIdentityCopyAsync(string planId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.CreateIdentityCopyAsync(planId, cancellationToken), cancellationToken);

    internal Task<NendoRecoveryExportPlan> PrepareRecoveryExportAsync(string entityId, string path, string requestId,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(path); return service.PrepareRecoveryExportAsync(entityId, path, requestId, cancellationToken); }, cancellationToken);

    internal Task<NendoRecoveryExportResult> CreateRecoveryExportAsync(string planId, bool confirmPartial,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.CreateRecoveryExportAsync(planId, confirmPartial, cancellationToken), cancellationToken);

    private async Task<OpenCandidate> PrepareOpenCoreAsync(string path, CancellationToken cancellationToken, NendoFileObservation? observation = null)
    {
        if (_openCandidates.Count >= 8) _openCandidates.Clear();
        var fullPath = Path.GetFullPath(path);
        DesktopStartupTiming.Mark("session.observe.begin");
        observation ??= await NendoWriteCoordinator.ObserveAsync(fullPath, cancellationToken);
        DesktopStartupTiming.Mark("session.observe.end");
        DesktopStartupTiming.Mark("session.history.check.begin");
        var admission = await _fileHistory.CheckAsync(observation, cancellationToken);
        DesktopStartupTiming.Mark("session.history.check.end");
        var assessment = new DesktopFileOpenAssessment($"open-{Guid.NewGuid():N}", Path.GetFileName(fullPath),
            observation.Inspection, admission.Conflict is not null, admission.Conflict?.RecentId,
            admission.Conflict?.FileName, admission.Notice) { LocationWarning = _locationPolicy.Inspect(fullPath) };
        var candidate = new OpenCandidate(fullPath, observation, assessment);
        _openCandidates.Add(assessment.AssessmentId, candidate);
        return candidate;
    }

    private async Task<DesktopSessionView> OpenCandidateCoreAsync(OpenCandidate candidate, bool readOnly, CancellationToken cancellationToken)
    {
        if (!readOnly) RequireWritableLocation(candidate.Path);
        // Recheck advisory history; the Engine separately pins and compares the
        // captured file observation before granting actual writable authority.
        DesktopStartupTiming.Mark("session.history.recheck.begin");
        var admission = await _fileHistory.CheckAsync(candidate.Observation, cancellationToken);
        DesktopStartupTiming.Mark("session.history.recheck.end");
        if (!readOnly && admission.Conflict is { } conflict)
            throw new DesktopFileCollisionException(candidate.Assessment with
            {
                KnownInstanceCollision = true, KnownOriginalRecentId = conflict.RecentId, KnownOriginalFileName = conflict.FileName,
            });
        DesktopStartupTiming.Mark("session.coordinator.open.begin");
        _coordinator = readOnly
            ? await NendoWriteCoordinator.OpenReadOnlyObservedAsync(candidate.Path, candidate.Observation, cancellationToken)
            : await NendoWriteCoordinator.OpenObservedAsync(candidate.Path, $"desktop-{Environment.ProcessId}", candidate.Observation, cancellationToken);
        DesktopStartupTiming.Mark("session.coordinator.open.end");
        _service = new NendoApplicationService(_coordinator);
        BeginAgentFileSession();
        return await FinishOpenAsync(candidate.Path, !readOnly, cancellationToken, candidate.Observation);
    }

    private async Task<DesktopSessionView> FinishOpenAsync(string path, bool writable, CancellationToken cancellationToken,
        NendoFileObservation? openedObservation = null)
    {
        try
        {
            // Before the first view is read, so a file that needs approval reports that
            // it cannot be edited from the very first thing the shell sees, rather than
            // offering editing and refusing on save.
            _coordinator!.BehaviourAuthority = BehaviourGrants;
            _currentWritableLocationAcknowledged = writable && HasLocationAcknowledgement(path);
            _currentPath = path;
            DesktopStartupTiming.Mark("session.view.read.begin");
            var view = await ReadViewAsync(cancellationToken);
            DesktopStartupTiming.Mark("session.view.read.end");
            _openCandidates.Clear();
            // Opening succeeded. Advisory device-state failure must not make the
            // open application disappear or pretend a committed creation failed.
            // OpenObserved already compared this complete observation under its
            // pinned classification and active authority. Reuse it only for
            // advisory device history; never use it to grant another write.
            DesktopStartupTiming.Mark("session.finish.observe.begin");
            var observed = openedObservation ?? await NendoWriteCoordinator.ObserveAsync(path, CancellationToken.None);
            DesktopStartupTiming.Mark("session.finish.observe.end");
            _currentObservation = observed;
            DesktopStartupTiming.Mark("session.history.remember.begin");
            _fileHistoryNotice = await _fileHistory.RememberAsync(path, observed, writable, CancellationToken.None)
                ? null : "Recent-file history could not be saved. The application is open; detection of older local copies may be incomplete.";
            DesktopStartupTiming.Mark("session.history.remember.end");
            _detachedRecovery = null;
            _recoveryPath = null;
            return view;
        }
        catch
        {
            await CloseFileCoreAsync();
            throw;
        }
    }

    private sealed record OpenCandidate(string Path, NendoFileObservation Observation, DesktopFileOpenAssessment Assessment);
}
