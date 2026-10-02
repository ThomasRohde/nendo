using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Show a file a view saved in its folder, in Explorer, by the identifier its downloadSaved
    /// event named. Only a download this window saved can be shown, so the page never hands the
    /// host a path (F-237).
    /// </summary>
    internal const string DownloadsShow = "downloads.show";
}

/// <summary>A file a view saved, as the Workbench says it: an identifier to show it by, its name and its folder's.</summary>
internal sealed record DownloadSavedPayload(string Id, string FileName, string Folder);

/// <summary>Whether Explorer was asked to show the file: false when it is no longer there, or was never saved here.</summary>
internal sealed record DownloadShownView(bool Shown);

/// <summary>What the downloads need from the page that owns the window.</summary>
internal interface IWorkbenchDownloadHost
{
    /// <summary>Open Explorer on the saved file the identifier names; false when there is none.</summary>
    bool ShowDownload(string id);
}

internal sealed partial class WorkbenchProtocolHandler
{
    private DownloadShownView ShowDownload(JsonElement payload)
    {
        var id = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("id", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;
        if (id is not { Length: > 0 and <= 64 }) throw new NendoValidationException("A download is named by the identifier its downloadSaved event gave.");
        return new DownloadShownView(_windowHost is IWorkbenchDownloadHost downloads && downloads.ShowDownload(id));
    }
}
