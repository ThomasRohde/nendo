using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopLocationWarning(string Code, string Message);

/// <summary>Conservative local path hints only: no provider APIs, scanning, sync
/// engine or claim that an unrecognised location is safe.</summary>
internal sealed class DesktopLocationPolicy
{
    private readonly string[] _roots;
    internal DesktopLocationPolicy(IEnumerable<string> knownRoots)
    {
        _roots = knownRoots.Select(NormalizeRoot).OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase).Take(64).ToArray();
    }

    private static string? NormalizeRoot(string root)
    {
        try { return !string.IsNullOrWhiteSpace(root) && Path.IsPathFullyQualified(root) ? Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) : null; }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
    }

    internal static DesktopLocationPolicy ForDevice()
    {
        var roots = new List<string>();
        foreach (var name in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 } root) roots.Add(root);
        // Standard folder names are hints, not proof of an active provider.
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(profile))
            foreach (var leaf in new[] { "OneDrive", "Dropbox", "Google Drive" }) roots.Add(Path.Combine(profile, leaf));
        return new(roots);
    }

    internal DesktopLocationWarning? Inspect(string path)
    {
        var fullPath = Path.GetFullPath(path);
        return _roots.Any(root => fullPath.Equals(root, StringComparison.OrdinalIgnoreCase) ||
            fullPath.StartsWith(Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            ? new("unsupported-sync-location", "This location may be managed by cloud sync. Nendo does not support writable use in synced folders. Choose another location or inspect read-only. Continue only if you explicitly accept unsupported use; pausing sync is not a safety guarantee. Detection is incomplete, so a missing warning does not prove a location safe.")
            : null;
    }
}

internal sealed partial class DesktopSessionController
{
    private readonly DesktopLocationPolicy _locationPolicy;
    private bool _currentWritableLocationAcknowledged;

    internal DesktopLocationWarning? InspectDestinationLocation(string path) => _locationPolicy.Inspect(path);

    internal async Task AcknowledgeDestinationLocationAsync(string path, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try { AcknowledgeLocationCore(path); }
        finally { _gate.Release(); }
    }

    internal async Task AcknowledgeOpenLocationAsync(string assessmentId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            if (!_openCandidates.TryGetValue(assessmentId, out var candidate))
                throw new NendoPreconditionException("open-assessment-unavailable", "Inspect the selected file again before confirming its location.");
            AcknowledgeLocationCore(candidate.Path);
        }
        finally { _gate.Release(); }
    }

    internal async Task AcknowledgeCurrentLocationAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try { AcknowledgeLocationCore(_currentPath ?? throw new NendoPreconditionException("no-file-open", "Open a file before confirming its location.")); }
        finally { _gate.Release(); }
    }

    private void AcknowledgeLocationCore(string path)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var scope = _fileRequest.Value ?? throw new NendoPreconditionException("location-confirmation-context", "Confirm the location in the current native file action.");
        if (_locationPolicy.Inspect(path) is not null) scope.AcknowledgedLocations.Add(Path.GetFullPath(path));
    }

    private bool HasLocationAcknowledgement(string path) =>
        _currentWritableLocationAcknowledged && string.Equals(_currentPath, path, StringComparison.OrdinalIgnoreCase) ||
        _fileRequest.Value?.AcknowledgedLocations.Contains(Path.GetFullPath(path)) is true;

    private void RequireWritableLocation(string path)
    {
        if (_locationPolicy.Inspect(path) is not { } warning) return;
        if (!HasLocationAcknowledgement(path)) throw new NendoPreconditionException(warning.Code, warning.Message);
        // An admitted replacement can follow its own same-location reopen even
        // after closing the old session. This never grants another path.
        _fileRequest.Value?.AcknowledgedLocations.Add(Path.GetFullPath(path));
    }
}
