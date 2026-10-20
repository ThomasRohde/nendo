using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopFileOpenAssessment(
    string AssessmentId, string FileName, NendoFileInspection Inspection,
    bool KnownInstanceCollision, string? KnownOriginalRecentId, string? KnownOriginalFileName, string? Notice)
{
    public DesktopLocationWarning? LocationWarning { get; init; }

    /// <summary>Where the assessed file is, for the host alone: never serialized, since an assessment's refusal can reach the Workbench.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string FilePath { get; init; } = string.Empty;
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

    /// <summary>
    /// The Workbench's recent list. Outside the request gate, for the reason
    /// <see cref="GetShellRecentFilesAsync"/> gives: each entry is opened to read who it says it
    /// is, and one on a disconnected share held the gate, and every read queued behind it, for
    /// as long as the share took to answer. Nothing here needs the gate: the history
    /// file is replaced whole and the notice is one field.
    /// </summary>
    internal async Task<DesktopRecentFiles> GetRecentFilesAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        // Read without the gate, so the two can belong to different sessions during an open or
        // a close. A pair that disagrees confirms nothing, and the entry is identified as any other.
        var openPath = _currentPath;
        var openObservation = _currentObservation;
        var files = await _fileHistory.ListAsync(cancellationToken, openPath, openObservation);
        return files with { Notice = files.Notice ?? _fileHistoryNotice };
    }

    /// <summary>
    /// The recent files the taskbar menu may offer, paths included. Inside the host
    /// only: see <see cref="DesktopShellRecentFile"/> for why this is not the list the
    /// Workbench gets.
    /// <para>
    /// Outside the request gate. The menu refreshes at startup and on every open, and
    /// each refresh opens up to ten other files: inside the gate, when each check was a
    /// full inspection, that held the startup open and the Workbench's first reads
    /// behind it for seconds. Nothing here needs the gate. The history file is replaced
    /// whole, so a read never sees half of one; the open file is confirmed from the
    /// observation it was opened with rather than opened again; every other check reads
    /// a file this session does not hold.
    /// </para>
    /// </summary>
    internal Task<IReadOnlyList<DesktopShellRecentFile>> GetShellRecentFilesAsync(int wanted, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        // Read without the gate, so the two can belong to different sessions during an
        // open or a close. A pair that disagrees confirms nothing, and the entry is
        // inspected as any other would be.
        var openPath = _currentPath;
        var openObservation = _currentObservation;
        return _fileHistory.ListForShellAsync(wanted, openPath, openObservation, cancellationToken);
    }

    /// <summary>
    /// Whether <paramref name="path"/> is the file open in this window. Choosing it again is not
    /// a reason to close it and open it again, which discarded pending proposals for no change.
    /// </summary>
    internal bool IsOpenFile(string path) =>
        _currentPath is { } current && string.Equals(current, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Inspects a file somebody chose, ahead of the questions about it. Allowed while another
    /// file is open: it reads only the candidate, so the open file is closed only once the
    /// person has answered them. Not for the open file itself.
    /// </summary>
    internal async Task<DesktopFileOpenAssessment> AssessOpenAsync(string path, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RefuseOpenFile(path);
            return (await PrepareOpenCoreAsync(path, cancellationToken, explicitOpen: true)).Assessment;
        }
        finally { _gate.Release(); }
    }

    /// <param name="replaceCurrent">
    /// The person was told the open file closes and agreed: it is closed here, under the same
    /// gate as the open, once the assessment is known to be this session's. Without it a file
    /// that is open refuses the open, as it always has.
    /// </param>
    internal async Task<DesktopSessionView> OpenAssessedAsync(string assessmentId, bool readOnly, CancellationToken cancellationToken = default,
        bool replaceCurrent = false)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_openCandidates.TryGetValue(assessmentId, out var candidate))
                throw new NendoPreconditionException("open-assessment-unavailable", "Inspect the selected file again before opening it.");
            if (replaceCurrent && _coordinator is not null)
            {
                RefuseOpenFile(candidate.Path);
                // Closing forgets every candidate. This one was taken first and is kept, so a
                // writable open another session refuses can still fall back to read-only.
                await CloseFileCoreAsync();
                _openCandidates[assessmentId] = candidate;
            }
            EnsureAvailableForOpen();
            return await OpenCandidateCoreAsync(candidate, readOnly, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    private void RefuseOpenFile(string path)
    {
        if (IsOpenFile(path))
            throw new NendoPreconditionException("file-already-open", "This file is already open in this window.");
    }

    internal async Task<DesktopSessionView> OpenReadOnlyAsync(string path, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            return await OpenCandidateCoreAsync(await PrepareOpenCoreAsync(path, cancellationToken, explicitOpen: true), readOnly: true, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Where a recent file is, without opening it: asked first, so a file another window has
    /// open can be handed to that window. Null for an entry that no longer resolves, which the
    /// open that follows reports in its own words.
    /// </summary>
    internal async Task<string?> ResolveRecentPathAsync(string recentId, CancellationToken cancellationToken = default)
    {
        // Where it was remembered, without observing it: the assessment that follows observes
        // it once, and doing it here as well was a second full inspection before the dialog
        // appeared, only to learn the path.
        try { return await _fileHistory.PathOfAsync(recentId, cancellationToken); }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal async Task<DesktopFileOpenAssessment> AssessRecentAsync(string recentId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (await _fileHistory.PathOfAsync(recentId, cancellationToken) is { } remembered) RefuseOpenFile(remembered);
            var resolved = await _fileHistory.ResolveAsync(recentId, cancellationToken, InterruptedWriteFor);
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

    // A new file of the same application (ADR-0022): what it would keep, then the file itself.
    internal Task<NendoNewFilePreview> PreviewNewFileAsync(CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.PreviewNewFileAsync(cancellationToken), cancellationToken);

    internal Task<NendoNewFileResult> CreateNewFileAsync(string path, string requestId, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(path); return service.CreateNewFileAsync(path, requestId, cancellationToken); }, cancellationToken);

    internal Task<NendoRecoveryExportPlan> PrepareRecoveryExportAsync(string entityId, string path, string requestId,
        string? afterRecordId = null, CancellationToken cancellationToken = default) =>
        QueryAsync(service => { RequireWritableLocation(path); return service.PrepareRecoveryExportAsync(entityId, path, requestId, afterRecordId, cancellationToken); }, cancellationToken);

    internal Task<NendoRecoveryExportResult> CreateRecoveryExportAsync(string planId, bool confirmPartial,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.CreateRecoveryExportAsync(planId, confirmPartial, cancellationToken), cancellationToken);

    /// <summary>
    /// What an observation may do about a save a crash left unfinished (ADR-0012): roll
    /// it back only for a file the person opened themselves, outside a folder that may be synced,
    /// where a journal could have come from another computer.
    /// </summary>
    private NendoInterruptedWrite InterruptedWriteFor(string path) =>
        _locationPolicy.Inspect(path) is null ? NendoInterruptedWrite.RollBack : NendoInterruptedWrite.RefuseInSyncedFolder;

    private async Task<OpenCandidate> PrepareOpenCoreAsync(string path, CancellationToken cancellationToken, NendoFileObservation? observation = null,
        bool explicitOpen = false)
    {
        if (_openCandidates.Count >= 8) _openCandidates.Clear();
        var fullPath = Path.GetFullPath(path);
        DesktopStartupTiming.Mark("session.observe.begin");
        observation ??= await NendoWriteCoordinator.ObserveAsync(fullPath,
            explicitOpen ? InterruptedWriteFor(fullPath) : NendoInterruptedWrite.Refuse, cancellationToken);
        DesktopStartupTiming.Mark("session.observe.end");
        DesktopStartupTiming.Mark("session.history.check.begin");
        var admission = await _fileHistory.CheckAsync(observation, cancellationToken, _currentPath, _currentObservation);
        DesktopStartupTiming.Mark("session.history.check.end");
        var assessment = new DesktopFileOpenAssessment($"open-{Guid.NewGuid():N}", Path.GetFileName(fullPath),
            observation.Inspection, admission.Conflict is not null, admission.Conflict?.RecentId,
            admission.Conflict?.FileName, admission.Notice) { LocationWarning = _locationPolicy.Inspect(fullPath), FilePath = fullPath };
        var candidate = new OpenCandidate(fullPath, observation, assessment);
        _openCandidates.Add(assessment.AssessmentId, candidate);
        return candidate;
    }

    /// <param name="restoreAgent">
    /// False where a restore or a replacement reopens the file: those are recovery acts, and a
    /// recovery open begins at Off (ADR-0009).
    /// </param>
    private async Task<DesktopSessionView> OpenCandidateCoreAsync(OpenCandidate candidate, bool readOnly, CancellationToken cancellationToken,
        bool restoreAgent = true)
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
        return await FinishOpenAsync(candidate.Path, !readOnly, cancellationToken, candidate.Observation, restoreAgent);
    }

    private async Task<DesktopSessionView> FinishOpenAsync(string path, bool writable, CancellationToken cancellationToken,
        NendoFileObservation? openedObservation = null, bool restoreAgent = true)
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
            // The level this device remembers for this file comes back with it (ADR-0009).
            if (restoreAgent) await RestoreAgentModeAsync(writable, cancellationToken);
            AnnounceFileSession();
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
