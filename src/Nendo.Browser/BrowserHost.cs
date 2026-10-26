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
/// file system is in memory: a file comes in through the page's file picker or a drop, goes back
/// out through the page's save, and the device folder is kept in the page's IndexedDB between
/// visits.
/// </summary>
public static partial class BrowserHost
{
    private const string FilesRoot = "/files";
    private const string DeviceStateRoot = "/device";

    /// <summary>The largest file the page opens: the file, a proposal clone and a backup share one WebAssembly memory.</summary>
    internal const long MaximumFileBytes = 256L * 1024 * 1024;

    private static DesktopSessionController? _session;
    private static WorkbenchProtocolHandler? _handler;
    private static (string Path, long Length, DateTime Written)? _handedOut;

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
        using var document = JsonDocument.Parse(message);
        var picture = document.RootElement.TryGetProperty("method", out var method) && method.GetString() == "media.embed";
        try
        {
            var path = await WriteIntoPageAsync(name, bytes);
            var response = picture
                ? await handler.HandleAsync(message, droppedPicture: path)
                : await handler.HandleAsync(message, droppedPath: path);
            return WorkbenchProtocolHandler.Serialize(response);
        }
        catch (NendoPreconditionException refusal)
        {
            var requestId = document.RootElement.TryGetProperty("requestId", out var id) ? id.GetString() : null;
            return JsonSerializer.Serialize(new
            {
                protocolVersion = DesktopShellContract.BridgeProtocolVersion, requestId, ok = false, result = (object?)null,
                error = new { code = refusal.Code, message = refusal.Message },
            });
        }
    }

    /// <summary>The open file's bytes as they stand, for the page to download; empty when nothing is open.</summary>
    [JSExport]
    public static byte[] ReadOpenFile() =>
        _session?.CurrentFilePath is { } path && File.Exists(path) ? File.ReadAllBytes(path) : [];

    /// <summary>
    /// The open file's bytes when they changed since the page last took them, for a save in place
    /// after a committed revision; empty when nothing changed or nothing is open. The handler has
    /// answered by then, so no transaction is open.
    /// </summary>
    [JSExport]
    public static byte[] ReadOpenFileIfChanged()
    {
        if (_session?.CurrentFilePath is not { } path || !File.Exists(path)) return [];
        var info = new FileInfo(path);
        var stamp = (path, info.Length, info.LastWriteTimeUtc);
        if (_handedOut == stamp) return [];
        var bytes = File.ReadAllBytes(path);
        _handedOut = stamp;
        return bytes;
    }

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

    /// <summary>
    /// One of the open file's pictures, by the address the session gave the page
    /// (<c>nendo-media://{host}/m/{sha256}</c>); empty when the file holds no such picture.
    /// </summary>
    [JSExport]
    public static async Task<string> ReadMediaAsync(string address)
    {
        if (_session is null || !Uri.TryCreate(address, UriKind.Absolute, out var uri)) return string.Empty;
        var answer = await _session.ResolveMediaAsync(uri.AbsolutePath.TrimStart('/'), uri.Query.TrimStart('?'));
        if (answer.Status != 200 || answer.Open is null) return string.Empty;
        await using var stream = answer.Open(0, answer.Length);
        using var copy = new MemoryStream();
        await stream.CopyToAsync(copy);
        return JsonSerializer.Serialize(new { mediaType = answer.MediaType, base64 = Convert.ToBase64String(copy.ToArray()) });
    }

    /// <summary>This page's device state (approvals, view switches, appearance), for the page to keep.</summary>
    [JSExport]
    public static string ExportDeviceState()
    {
        Handler();
        var files = Directory.EnumerateFiles(DeviceStateRoot, "*", SearchOption.AllDirectories)
            .ToDictionary(file => Path.GetRelativePath(DeviceStateRoot, file).Replace('\\', '/'),
                file => Convert.ToBase64String(File.ReadAllBytes(file)), StringComparer.Ordinal);
        return JsonSerializer.Serialize(files);
    }

    /// <summary>Puts back the device state the page kept from an earlier visit, before any file opens.</summary>
    [JSExport]
    public static void ImportDeviceState(string state)
    {
        Handler();
        var files = JsonSerializer.Deserialize<Dictionary<string, string>>(state) ?? [];
        var root = Path.GetFullPath(DeviceStateRoot) + Path.DirectorySeparatorChar;
        foreach (var (relative, base64) in files)
        {
            var target = Path.GetFullPath(Path.Combine(DeviceStateRoot, relative));
            if (!target.StartsWith(root, StringComparison.Ordinal)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllBytes(target, Convert.FromBase64String(base64));
        }
    }

    /// <summary>Asks the page for a file; resolves to null when the person chose none.</summary>
    [JSImport("pickFile", "nendo-browser-host")]
    private static partial Task<JSObject?> PickFileAsync();

    /// <summary>
    /// Takes the page's lock on an application instance, so one tab of this browser writes a file
    /// at a time (ADR-0036); false when another tab holds it.
    /// </summary>
    [JSImport("takeWriterLock", "nendo-browser-host")]
    private static partial Task<bool> TakeWriterLockAsync(string key);

    [JSImport("releaseWriterLock", "nendo-browser-host")]
    private static partial void ReleaseWriterLock();

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
                    notice = await OpenWithOneWriterAsync(path);
                }
                break;
            case WorkbenchFileAction.OpenDropped:
                notice = await OpenWithOneWriterAsync(request.DroppedPath!);
                break;
            case WorkbenchFileAction.Create:
                ReleaseWriterLock();
                await session.CreateAsync(Path.Combine(NewFolder(), "Untitled.nendo"));
                notice = "Nendo file created in this page. Download it to keep it.";
                break;
            case WorkbenchFileAction.Close:
                await session.CloseAsync();
                ReleaseWriterLock();
                break;
            default:
                throw new NendoPreconditionException("not-in-this-host",
                    $"{request.Action} is answered by Nendo for Windows, not by this host.");
        }
        return await DesktopFileActionView.CaptureAsync(session.GetViewAsync, notice);
    }

    /// <summary>
    /// Opens a file for editing when no other tab of this browser is editing the same application
    /// instance, and read-only when one is.
    /// </summary>
    private static async Task<string?> OpenWithOneWriterAsync(string path)
    {
        var session = _session!;
        ReleaseWriterLock();
        _handedOut = null;
        var view = await session.OpenAsync(path);
        if (view.Manifest is not { } manifest || view.Health != "normal") return null;
        if (await TakeWriterLockAsync($"nendo-writer:{manifest.ApplicationId}:{manifest.InstanceId}")) return null;
        await session.CloseAsync();
        await session.OpenReadOnlyAsync(path);
        return "This file is open for editing in another tab of this browser, so it is open read-only here.";
    }

    /// <summary>A picked file goes into a folder of its own, so its name is kept and nothing is overwritten.</summary>
    private static async Task<string> WriteIntoPageAsync(string name, byte[] bytes)
    {
        if (bytes.LongLength > MaximumFileBytes)
            throw new NendoPreconditionException("file-too-large",
                $"{name} is {bytes.LongLength / (1024.0 * 1024):0.#} MiB; a browser opens files of up to 256 MiB.");
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
