using System.IO.Compression;
using System.Net;
using System.Text;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// Export → Web page (ADR-0035): the browser host's page with a Duplicate of the open file carried
/// in it, gzipped and base64 in a <c>nendo-file</c> script element, which the page opens as it
/// starts. The Duplicate's identity transition is the export point Apply changes reads back.
/// </summary>
public static class NendoWebPageExport
{
    /// <summary>The largest file a page opens: the file, a proposal clone and a backup share one WebAssembly memory.</summary>
    public const long MaximumFileBytes = 256L * 1024 * 1024;

    /// <summary>Where the module script starts: the carried file goes before it, beside the runtime.</summary>
    private const string ModuleScript = "<script type=\"module\">";

    /// <summary>
    /// Writes the page to <paramref name="destination"/>: a Duplicate of the service's file, made in a
    /// folder of its own under the temporary folder and removed after, carried in the page at
    /// <paramref name="templatePath"/>. A file larger than a page opens is refused with its size.
    /// </summary>
    public static async Task ExportAsync(
        NendoApplicationService service, string fileName, string templatePath, string destination,
        CancellationToken cancellationToken = default, long maximumFileBytes = MaximumFileBytes)
    {
        ArgumentNullException.ThrowIfNull(service);
        if (!File.Exists(templatePath))
            throw new NendoPreconditionException("web-page-runtime-missing",
                "This Nendo has no web page runtime to export with. Reinstall Nendo to get it.");
        var folder = Path.Combine(Path.GetTempPath(), "nendo-web-page", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var copy = Path.Combine(folder, fileName);
            var plan = await service.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, copy, $"web-page-{Guid.NewGuid():N}", cancellationToken);
            await service.CreateIdentityCopyAsync(plan.PlanId, cancellationToken);
            var length = new FileInfo(copy).Length;
            if (length > maximumFileBytes)
                throw new NendoPreconditionException("file-too-large",
                    $"{fileName} is {Mebibytes(length)} MiB; a web page opens files of up to {Mebibytes(maximumFileBytes)} MiB.");
            var page = Carry(await File.ReadAllTextAsync(templatePath, cancellationToken), await File.ReadAllBytesAsync(copy, cancellationToken), fileName);
            // Written beside the destination and moved into place, so a failure leaves no half page,
            // and an existing file is never replaced.
            var staged = destination + $".{Guid.NewGuid():N}.partial";
            try
            {
                await File.WriteAllTextAsync(staged, page, new UTF8Encoding(false), cancellationToken);
                File.Move(staged, destination, overwrite: false);
            }
            finally
            {
                if (File.Exists(staged)) File.Delete(staged);
            }
        }
        finally
        {
            try { Directory.Delete(folder, recursive: true); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // A copy the system still holds is left in the temporary folder, which Windows clears.
            }
        }
    }

    /// <summary>The page carrying a file, before its module script.</summary>
    public static string Carry(string page, byte[] file, string fileName)
    {
        var at = page.IndexOf(ModuleScript, StringComparison.Ordinal);
        if (at < 0) throw new NendoPreconditionException("web-page-runtime-missing", "The web page runtime has no module script to carry a file beside.");
        using var packed = new MemoryStream();
        using (var gzip = new GZipStream(packed, CompressionLevel.SmallestSize, leaveOpen: true)) gzip.Write(file);
        return string.Concat(page.AsSpan(0, at),
            $"<script type=\"application/octet-stream\" id=\"nendo-file\" data-name=\"{WebUtility.HtmlEncode(fileName)}\">{Convert.ToBase64String(packed.ToArray())}</script>\n",
            page.AsSpan(at));
    }

    private static string Mebibytes(long bytes) => (bytes / (1024.0 * 1024)).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
}
