using System.Diagnostics;

namespace Nendo.Desktop;

/// <summary>
/// The person's notice of a view's download (F-237). WebView2's own downloads panel is never shown,
/// so when a file a view saved is complete, the Workbench is told its name and folder, and can ask
/// for it to be shown in Explorer. The page names a file by an identifier this window gave it,
/// never by a path.
/// </summary>
public sealed partial class MainPage : IWorkbenchDownloadHost
{
    /// <summary>The files this window saved, newest last; a few are enough for a notice the person acts on now.</summary>
    private readonly List<(string Id, string Path)> _savedDownloads = [];
    private const int KeptDownloads = 32;

    /// <summary>A view's download is complete at <paramref name="path"/>.</summary>
    internal void DownloadSaved(string path)
    {
        if (!DispatcherQueue.HasThreadAccess)
        {
            DispatcherQueue.TryEnqueue(() => DownloadSaved(path));
            return;
        }
        var id = Guid.NewGuid().ToString("N");
        _savedDownloads.Add((id, path));
        if (_savedDownloads.Count > KeptDownloads) _savedDownloads.RemoveAt(0);
        PostWorkbenchEvent(WorkbenchEvents.DownloadSaved, new DownloadSavedPayload(id, System.IO.Path.GetFileName(path),
            System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path) ?? string.Empty)));
    }

    bool IWorkbenchDownloadHost.ShowDownload(string id)
    {
        var saved = _savedDownloads.FirstOrDefault(entry => entry.Id == id);
        if (saved.Path is null || !File.Exists(saved.Path)) return false;
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{saved.Path}\"") { UseShellExecute = true });
        return true;
    }
}
