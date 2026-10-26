using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Nendo.Engine;
using Nendo.Session;

[assembly: SupportedOSPlatform("browser")]

namespace Nendo.Browser;

/// <summary>
/// The browser host (ADR-0036): one session and one protocol handler in the page, reached through
/// one exported method that takes the bridge's message and returns its answer. The page's own
/// file system is in memory; a file comes in through the page's file picker.
/// </summary>
public static partial class BrowserHost
{
    private const string FilesRoot = "/files";
    private const string DeviceStateRoot = "/device";
    private static DesktopSessionController? _session;
    private static WorkbenchProtocolHandler? _handler;

    public static void Main()
    {
    }

    /// <summary>One message of the Workbench's bridge, answered as the Windows host answers it.</summary>
    [JSExport]
    public static async Task<string> InvokeAsync(string message)
    {
        var handler = Handler();
        return WorkbenchProtocolHandler.Serialize(await handler.HandleAsync(message));
    }

    /// <summary>
    /// A message with a file the person dropped on the page: a Nendo file to open, or a picture for
    /// a media field. The bytes go into the page's file system and the handler gets that path, as
    /// the Windows host's handler gets the path Windows names.
    /// </summary>
    [JSExport]
    public static async Task<string> InvokeWithFileAsync(string message, byte[] bytes, string name)
    {
        var handler = Handler();
        var path = await WriteIntoPageAsync(name, bytes);
        using var document = JsonDocument.Parse(message);
        var picture = document.RootElement.TryGetProperty("method", out var method) && method.GetString() == "media.embed";
        var response = picture
            ? await handler.HandleAsync(message, droppedPicture: path)
            : await handler.HandleAsync(message, droppedPath: path);
        return WorkbenchProtocolHandler.Serialize(response);
    }

    /// <summary>The open file's bytes as they stand, for the page to save; empty when nothing is open.</summary>
    [JSExport]
    public static byte[] ReadOpenFile() =>
        _session?.CurrentFilePath is { } path && File.Exists(path) ? File.ReadAllBytes(path) : [];

    /// <summary>
    /// A view package's files, for the frame the page loads it into: a page has no origin of its
    /// own to serve them from (ADR-0035), so the frame is handed all of them at once.
    /// </summary>
    [JSExport]
    public static async Task<string> ReadViewPackageAsync(string packageId)
    {
        var (_, files) = await _session!.ReadExtensionPackageAsync(packageId);
        return JsonSerializer.Serialize(files.ToDictionary(file => file.Path,
            file => new { mediaType = file.MediaType, base64 = Convert.ToBase64String(file.Content) }, StringComparer.Ordinal));
    }

    /// <summary>Asks the page for a file; resolves to null when the person chose none.</summary>
    [JSImport("pickFile", "nendo-browser-host")]
    private static partial Task<JSObject?> PickFileAsync();

    private static WorkbenchProtocolHandler Handler()
    {
        if (_handler is not null) return _handler;
        Directory.CreateDirectory(FilesRoot);
        Directory.CreateDirectory(DeviceStateRoot);
        _session = new DesktopSessionController(deviceStateRoot: DeviceStateRoot);
        _handler = new WorkbenchProtocolHandler(_session, _ => { }, RunFileActionAsync);
        return _handler;
    }

    private static async Task<DesktopFileActionView> RunFileActionAsync(WorkbenchFileActionRequest request)
    {
        var session = _session!;
        string? notice = null;
        switch (request.Action)
        {
            case WorkbenchFileAction.Open:
                using (var picked = await PickFileAsync())
                {
                    if (picked is null) break;
                    var path = await WriteIntoPageAsync(picked.GetPropertyAsString("name") ?? "file.nendo",
                        Convert.FromBase64String(picked.GetPropertyAsString("base64") ?? string.Empty));
                    await session.OpenAsync(path);
                }
                break;
            case WorkbenchFileAction.OpenDropped:
                await session.OpenAsync(request.DroppedPath!);
                break;
            case WorkbenchFileAction.Create:
                await session.CreateAsync(Path.Combine(NewFolder(), "Untitled.nendo"));
                notice = "Nendo file created in this page. Download it to keep it.";
                break;
            case WorkbenchFileAction.Close:
                await session.CloseAsync();
                break;
            default:
                throw new NendoPreconditionException("not-in-this-host",
                    $"{request.Action} is answered by Nendo for Windows, not by this host.");
        }
        return await DesktopFileActionView.CaptureAsync(session.GetViewAsync, notice);
    }

    /// <summary>A picked file goes into a folder of its own, so its name is kept and nothing is overwritten.</summary>
    private static async Task<string> WriteIntoPageAsync(string name, byte[] bytes)
    {
        var fileName = Path.GetFileName(name);
        if (string.IsNullOrWhiteSpace(fileName)) fileName = "file.nendo";
        var path = Path.Combine(NewFolder(), fileName);
        await File.WriteAllBytesAsync(path, bytes);
        return path;
    }

    private static string NewFolder()
    {
        var folder = Path.Combine(FilesRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }
}
