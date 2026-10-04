using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// A package of one file that this device runs from a folder while somebody develops it
/// (ADR-0013 Phase 4). Device preference like the switches: never in the file, so a copy of
/// the file, or the file on another device, runs the reviewed package it carries.
/// </summary>
internal sealed record DesktopDevelopmentLink(string ApplicationId, string PackageId, string Folder);

/// <summary>
/// This device's switches for custom views: whether any run at all, and which files' views are
/// off. Device preference, never application data, so a file cannot turn its own views back on
/// and a received file cannot turn off anyone else's. Both default to on: a view that is shown runs.
/// It also holds the development links (ADR-0013 Phase 4), for the same reason.
/// </summary>
internal sealed class DesktopExtensionSettingsStore : IDisposable
{
    private const int MaximumBytes = 256 * 1024;
    private const int MaximumFiles = 4096;
    private const int MaximumLinks = 64;

    private readonly string _root;
    private readonly object _sync = new();
    private readonly List<PendingChange> _pendingChanges = [];
    private Timer? _poll;
    private Action? _changed;
    private bool _disposed;
    private bool _run = true;
    private long _runGeneration;
    private long _storedRunGeneration;
    private long _fileRevision;
    private long _storedFileRevision;
    private readonly Dictionary<string, long> _fileRevisions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _storedFileRevisions = new(StringComparer.Ordinal);
    private string _lastNotifiedState = "";
    private readonly HashSet<string> _disabledFiles = new(StringComparer.Ordinal);
    private readonly List<DesktopDevelopmentLink> _links = [];
    private byte[]? _lastReadBytes;
    private bool _readInterrupted;
    private string StatePath => Path.Combine(_root, "extension-settings.json");

    internal bool Run { get { lock (_sync) { Read(); return _run; } } }

    // Each file runs in its own process. Poll the atomically replaced document only while
    // a live controller listens; authority checks also read it synchronously.
    internal event Action Changed
    {
        add
        {
            lock (_sync)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                _changed += value;
                _poll ??= new Timer(_ => Refresh(), null, TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250));
            }
        }
        remove { lock (_sync) _changed -= value; }
    }

    internal void Refresh()
    {
        Action? changed = null;
        lock (_sync)
        {
            if (_disposed) return;
            Read();
            var current = StateKey();
            if (_lastNotifiedState != current)
            {
                _lastNotifiedState = current;
                changed = _changed;
            }
        }
        changed?.Invoke();
    }

    private string StateKey() => JsonSerializer.Serialize(new StoredExtensionSettings(1, _run,
        _disabledFiles.Order(StringComparer.Ordinal).ToArray(),
        _links.Select(link => new StoredDevelopmentLink(link.ApplicationId, link.PackageId, link.Folder)).ToArray(), _runGeneration, _fileRevision, _fileRevisions));
    internal string? Notice { get; private set; }

    internal DesktopExtensionSettingsStore(string root)
    {
        _root = Path.GetFullPath(root);
        Read();
        _lastNotifiedState = StateKey();
    }

    private void Read()
    {
        _run = true;
        _runGeneration = 0;
        _storedRunGeneration = 0;
        _fileRevision = _storedFileRevision = 0;
        _fileRevisions.Clear();
        _storedFileRevisions.Clear();
        _disabledFiles.Clear();
        _links.Clear();
        Notice = null;
        _readInterrupted = false;
        try
        {
            byte[] bytes;
            try
            {
                bytes = DesktopStateFile.ReadBytes(StatePath, MaximumBytes, "Custom view settings exceed their limit.");
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException ||
                exception is IOException and not FileNotFoundException and not DirectoryNotFoundException)
            {
                // A document that is busy or briefly unreadable is not a damaged one. Keep the
                // last one read in full, so a passing lock neither turns views back on for the
                // device nor lets the next change save the defaults over its switches.
                _readInterrupted = true;
                bytes = _lastReadBytes ?? throw new IOException("The custom view settings could not be read.", exception);
            }
            var document = JsonSerializer.Deserialize<StoredExtensionSettings>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1 || document.DisabledFiles is not { Count: <= MaximumFiles } files || document.RunGeneration < 0 || document.FileRevision < 0 ||
                document.FileRevisions is { Count: > MaximumFiles })
                throw new JsonException("Unsupported custom view settings.");
            _run = document.Run;
            _storedRunGeneration = _runGeneration = document.RunGeneration;
            _storedFileRevision = _fileRevision = document.FileRevision;
            foreach (var (file, revision) in document.FileRevisions ?? new Dictionary<string, long>())
            {
                if (file is not { Length: > 0 and <= 200 } || revision <= 0 || revision > _fileRevision)
                    throw new JsonException("Unsupported custom view file revision.");
                _storedFileRevisions[file] = _fileRevisions[file] = revision;
            }
            // A newer explicit switch supersedes an older choice this session could not
            // save. Each file has its own revision, so unrelated file/link changes preserve
            // the choice. If its bounded revision entry was evicted, discard that stale
            // pending choice as well rather than treating an unknown old revision as current.
            _pendingChanges.RemoveAll(change =>
                change.RunGeneration is { } generation && generation < _storedRunGeneration ||
                change.FileId is { } file &&
                (change.FileRevision != _storedFileRevisions.GetValueOrDefault(file) ||
                 change.FileRevision == 0 && _storedFileRevisions.Count >= MaximumFiles && change.DocumentFileRevision < _storedFileRevision));
            foreach (var file in files.Where(file => file is { Length: > 0 and <= 200 })) _disabledFiles.Add(file);
            // A link that does not read as one is dropped rather than trusted: the folder must be an
            // absolute path, and the IDs the lengths the file would allow.
            foreach (var link in (document.DevelopmentLinks ?? []).Take(MaximumLinks))
            {
                if (link is { ApplicationId.Length: > 0 and <= 200, PackageId.Length: > 0 and <= 80, Folder.Length: > 0 and <= 1024 } &&
                    Path.IsPathFullyQualified(link.Folder))
                    _links.Add(new(link.ApplicationId, link.PackageId, link.Folder));
            }
            _lastReadBytes = bytes;
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            _run = true;
            _runGeneration = _storedRunGeneration = 0;
            _fileRevision = _storedFileRevision = 0;
            _fileRevisions.Clear();
            _storedFileRevisions.Clear();
            _disabledFiles.Clear();
            _links.Clear();
            Notice = "The saved custom view settings could not be read. Views run with the defaults for this session.";
        }
        foreach (var change in _pendingChanges) change.Apply();
        if (_pendingChanges.Count != 0)
            Notice = "The custom view setting applies for this session, but could not be saved for the next launch.";
    }

    internal bool FileEnabled(string applicationId)
    {
        lock (_sync) { Read(); return !_disabledFiles.Contains(applicationId); }
    }

    /// <summary>The links for one file's packages, on this device.</summary>
    internal IReadOnlyList<DesktopDevelopmentLink> LinksFor(string applicationId)
    {
        lock (_sync) { Read(); return _links.Where(link => link.ApplicationId == applicationId).ToArray(); }
    }

    internal void SetLink(string applicationId, string packageId, string folder)
    {
        var absolute = Path.GetFullPath(folder);
        Change(() =>
        {
            _links.RemoveAll(link => link.ApplicationId == applicationId && link.PackageId == packageId);
            _links.Add(new(applicationId, packageId, absolute));
        }, () =>
        {
            if (_links.Count(link => link.ApplicationId != applicationId || link.PackageId != packageId) >= MaximumLinks)
                throw new NendoValidationException($"This device develops {MaximumLinks} packages from folders already. Stop developing one first.");
        });
    }

    internal void RemoveLink(string applicationId, string packageId) =>
        Change(() => _links.RemoveAll(link => link.ApplicationId == applicationId && link.PackageId == packageId));

    internal void SetRun(bool run) => Change(() =>
    {
        _run = run;
        _runGeneration++;
    }, runChoice: true);

    internal void SetFileEnabled(string applicationId, bool enabled) => Change(() =>
    {
        if (enabled) _disabledFiles.Remove(applicationId);
        else _disabledFiles.Add(applicationId);
        _fileRevisions[applicationId] = ++_fileRevision;
        if (_fileRevisions.Count > MaximumFiles)
            _fileRevisions.Remove(_fileRevisions.MinBy(pair => pair.Value).Key);
    }, () =>
    {
        if (!enabled && !_disabledFiles.Contains(applicationId) && _disabledFiles.Count >= MaximumFiles)
            throw new NendoValidationException($"Custom views are off for {MaximumFiles} files on this device already. Turn some back on first.");
    }, fileChoice: applicationId);

    private void Change(Action change, Action? validate = null, bool runChoice = false, string? fileChoice = null)
    {
        Action? changed;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            try
            {
                using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
                Read();
                // Saving over a document that could not be read would replace what it holds.
                if (_readInterrupted) throw new IOException("The custom view settings could not be read.");
                validate?.Invoke();
                change();
                _pendingChanges.Add(new(change, runChoice ? _storedRunGeneration : null, fileChoice,
                    fileChoice is null ? 0 : _storedFileRevisions.GetValueOrDefault(fileChoice), _storedFileRevision));
                Save();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                Read();
                validate?.Invoke();
                change();
                _pendingChanges.Add(new(change, runChoice ? _storedRunGeneration : null, fileChoice,
                    fileChoice is null ? 0 : _storedFileRevisions.GetValueOrDefault(fileChoice), _storedFileRevision));
                Notice = "The custom view setting applies for this session, but could not be saved for the next launch.";
            }
            _lastNotifiedState = StateKey();
            changed = _changed;
        }
        changed?.Invoke();
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _disposed = true;
            _poll?.Dispose();
            _poll = null;
            _changed = null;
        }
    }

    private void Save()
    {
        try
        {
            // Admit the complete document before replacing it. Count limits alone do not
            // bound bytes, especially when switch revisions also carry the file IDs.
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new StoredExtensionSettings(1, _run,
                _disabledFiles.Order(StringComparer.Ordinal).ToArray(),
                _links.Select(link => new StoredDevelopmentLink(link.ApplicationId, link.PackageId, link.Folder)).ToArray(),
                _runGeneration, _fileRevision, _fileRevisions));
            if (bytes.Length > MaximumBytes) throw new IOException("Custom view settings exceed their limit.");
            DesktopStateFile.Replace(_root, StatePath, "extension-settings", stream => stream.Write(bytes));
            _lastReadBytes = bytes;
            Notice = null;
            _pendingChanges.Clear();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Notice = "The custom view setting applies for this session, but could not be saved for the next launch.";
        }
    }

    private sealed record StoredExtensionSettings(int Version, bool Run, IReadOnlyList<string> DisabledFiles,
        IReadOnlyList<StoredDevelopmentLink>? DevelopmentLinks = null, long RunGeneration = 0,
        long FileRevision = 0, IReadOnlyDictionary<string, long>? FileRevisions = null);

    private sealed record PendingChange(Action Apply, long? RunGeneration, string? FileId,
        long FileRevision, long DocumentFileRevision);

    private sealed record StoredDevelopmentLink(string ApplicationId, string PackageId, string Folder);
}
