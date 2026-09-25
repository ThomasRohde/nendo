using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed partial class DesktopSessionController
{
    private readonly AsyncLocal<FileRequestScope?> _fileRequest = new();
    private readonly AsyncLocal<bool> _boundedReadProjection = new();

    internal IDisposable BindReadProjection(bool bounded)
    {
        var previous = _boundedReadProjection.Value;
        _boundedReadProjection.Value = bounded;
        return new ReadProjectionScope(this, previous);
    }

    private sealed class ReadProjectionScope(DesktopSessionController owner, bool previous) : IDisposable
    {
        public void Dispose() => owner._boundedReadProjection.Value = previous;
    }

    internal async Task ValidateFileRequestAsync(CancellationToken cancellationToken)
    {
        await EnterRequestGateAsync(cancellationToken);
        try { ObjectDisposedException.ThrowIf(_disposed, this); }
        finally { _gate.Release(); }
    }

    // Only host adapters create this scope. Its opaque identity is not a storage
    // capability; every service still enforces its own read/write capabilities.
    internal FileRequestScope BindFileRequest(string fileSessionId)
    {
        var scope = new FileRequestScope(this, _fileRequest.Value, fileSessionId);
        _fileRequest.Value = scope;
        return scope;
    }

    private async Task EnterRequestGateAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        if (_fileRequest.Value is { } scope && scope.FileSessionId != _fileSessionId)
        {
            _gate.Release();
            throw new NendoPreconditionException("stale-file-session",
                "This action belongs to a file session that has closed. Refresh the view before continuing.");
        }
    }

    private void RotateFileSession()
    {
        StopExtensionsForFile();
        _fileSessionId = $"file-session-{Guid.NewGuid():N}";
        // A single admitted lifecycle action may close and reopen a file. Only
        // that action follows its transition; other queued request scopes do not.
        if (_fileRequest.Value is { } scope) scope.FileSessionId = _fileSessionId;
    }

    internal sealed class FileRequestScope(
        DesktopSessionController owner, FileRequestScope? previous, string fileSessionId) : IDisposable
    {
        internal string FileSessionId { get; set; } = fileSessionId;
        internal HashSet<string> AcknowledgedLocations { get; } = new(StringComparer.OrdinalIgnoreCase);
        public void Dispose() => owner._fileRequest.Value = previous;
    }
}
