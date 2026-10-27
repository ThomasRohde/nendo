using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// Export → Web app (ADR-0037): the exported page as <c>index.html</c> in a folder with a web app
/// manifest, the service worker and the file's icons, which a browser installs as an app and opens
/// offline once the folder is served. From disk the page behaves as the one-page export.
/// </summary>
public static class NendoWebAppExport
{
    /// <summary>The manifest's address beside the page.</summary>
    public const string ManifestName = "manifest.webmanifest";

    /// <summary>The service worker's address beside the page.</summary>
    public const string ServiceWorkerName = "sw.js";

    /// <summary>
    /// The light theme's canvas (<c>--canvas</c> under <c>:root</c> in 02-tokens.css, which a test holds
    /// this to): the colour the installed app's window and splash start in.
    /// </summary>
    public const string CanvasColour = "#f9f9fa";

    /// <summary>The icon sizes a browser asks a web app for.</summary>
    public static IReadOnlyList<int> IconSizes { get; } = [192, 512];

    /// <summary>Where the icon of a size goes in the folder.</summary>
    public static string IconPath(int size) => $"icons/icon-{size}.png";

    /// <summary>
    /// Writes the web app into <paramref name="folder"/>, which must be empty: the page at
    /// <paramref name="templatePath"/> carrying a Duplicate of the service's file, the service worker
    /// at <paramref name="serviceWorkerPath"/>, and <paramref name="icons"/>, a PNG for each of
    /// <see cref="IconSizes"/>. The files are written in a folder of their own inside it and moved out
    /// once all are written, so a failure leaves the folder as it was.
    /// </summary>
    public static async Task ExportAsync(
        NendoApplicationService service, string fileName, string templatePath, string serviceWorkerPath,
        IReadOnlyDictionary<int, byte[]> icons, string folder,
        CancellationToken cancellationToken = default, long maximumFileBytes = NendoWebPageExport.MaximumFileBytes)
    {
        ArgumentNullException.ThrowIfNull(service);
        ArgumentNullException.ThrowIfNull(icons);
        if (!File.Exists(serviceWorkerPath))
            throw new NendoPreconditionException("web-page-runtime-missing",
                "This Nendo has no web app service worker to export with. Reinstall Nendo to get it.");
        foreach (var size in IconSizes)
            if (!icons.TryGetValue(size, out var icon) || !icon.AsSpan().StartsWith(PngSignature))
                throw new ArgumentException($"The web app needs a {size} pixel PNG icon.", nameof(icons));
        if (!Directory.Exists(folder))
            throw new NendoPreconditionException("web-app-folder-missing", $"{folder} does not exist. Choose an empty folder for the web app.");
        if (Directory.EnumerateFileSystemEntries(folder).Any())
            throw new NendoPreconditionException("web-app-folder-not-empty",
                $"{Path.GetFileName(Path.TrimEndingDirectorySeparator(folder))} is not empty. Choose an empty folder for the web app.");

        var name = Path.GetFileNameWithoutExtension(fileName);
        var applicationId = (await service.GetDefinitionSnapshotAsync(cancellationToken)).Manifest.ApplicationId;
        var page = new UTF8Encoding(false).GetBytes(
            WithManifest(await NendoWebPageExport.BuildAsync(service, fileName, templatePath, cancellationToken, maximumFileBytes), name));
        var files = new List<(string Path, byte[] Bytes)>
        {
            ("index.html", page),
            (ManifestName, Manifest(name, applicationId)),
            (ServiceWorkerName, ServiceWorker(await File.ReadAllTextAsync(serviceWorkerPath, cancellationToken), page)),
        };
        files.AddRange(IconSizes.Select(size => (IconPath(size), icons[size])));

        var staged = Path.Combine(folder, $".nendo-web-app-{Guid.NewGuid():N}.partial");
        try
        {
            foreach (var (path, bytes) in files)
            {
                var target = Path.Combine(staged, path);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await File.WriteAllBytesAsync(target, bytes, cancellationToken);
            }
            foreach (var entry in Directory.EnumerateFileSystemEntries(staged).ToArray())
            {
                var target = Path.Combine(folder, Path.GetFileName(entry));
                if (Directory.Exists(entry)) Directory.Move(entry, target);
                else File.Move(entry, target, overwrite: false);
            }
        }
        finally
        {
            if (Directory.Exists(staged)) Directory.Delete(staged, recursive: true);
        }
    }

    /// <summary>
    /// The service worker stamped with the page's digest: a browser installs a newer worker only when
    /// the worker's own bytes change, so a newer page must change them.
    /// </summary>
    public static byte[] ServiceWorker(string template, byte[] page)
    {
        const string placeholder = "__NENDO_WEB_APP_VERSION__";
        if (template.Split(placeholder).Length != 2)
            throw new NendoPreconditionException("web-page-runtime-missing", "The web app service worker has no version to stamp.");
        return new UTF8Encoding(false).GetBytes(template.Replace(placeholder, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(page)), StringComparison.Ordinal));
    }

    /// <summary>The page with the manifest, the icon and the theme colour named in its head, before its title.</summary>
    public static string WithManifest(string page, string name)
    {
        var at = page.IndexOf("<title>", StringComparison.Ordinal);
        if (at < 0) throw new NendoPreconditionException("web-page-runtime-missing", "The web page runtime has no title to name its manifest beside.");
        return string.Concat(page.AsSpan(0, at),
            $"<link rel=\"manifest\" href=\"{ManifestName}\" />\n    " +
            $"<link rel=\"apple-touch-icon\" href=\"{IconPath(192)}\" />\n    " +
            $"<meta name=\"theme-color\" content=\"{CanvasColour}\" />\n    " +
            $"<meta name=\"application-name\" content=\"{System.Net.WebUtility.HtmlEncode(name)}\" />\n    ",
            page.AsSpan(at));
    }

    /// <summary>The web app manifest: the app's name, an ID of its application, and the folder as its scope.</summary>
    public static byte[] Manifest(string name, string applicationId) => JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
    {
        ["id"] = $"./?nendo-application={applicationId}",
        ["name"] = name,
        ["short_name"] = name,
        ["start_url"] = "./",
        ["scope"] = "./",
        ["display"] = "standalone",
        ["background_color"] = CanvasColour,
        ["theme_color"] = CanvasColour,
        ["icons"] = IconSizes.Select(size => new Dictionary<string, string>
        {
            ["src"] = IconPath(size),
            ["sizes"] = $"{size}x{size}",
            ["type"] = "image/png",
            ["purpose"] = "any",
        }).ToArray(),
    }, new JsonSerializerOptions { WriteIndented = true });

    private static ReadOnlySpan<byte> PngSignature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
}
