using System.Globalization;
using Microsoft.Web.WebView2.Core;
using Nendo.Engine;
using Windows.Storage.Streams;

namespace Nendo.Desktop;

/// <summary>
/// Answers every view origin from the open file, inside the Workbench's own browser.
/// <para>
/// Nothing is written to disk and nothing leaves the machine: the browser asks, this handler
/// answers from the file, and a host it does not know gets a 404 rather than a network lookup.
/// The API script is the one thing a view origin serves that the file does not carry. It
/// comes from the installed Workbench, so a view always talks to the broker it runs beside.
/// </para>
/// </summary>
internal sealed class ExtensionAssetServer
{
    internal const string Filter = "https://*" + ExtensionOrigins.Suffix + "/*";

    private readonly CoreWebView2 _core;
    private readonly DesktopSessionController _session;
    private readonly string _apiPath;

    private ExtensionAssetServer(CoreWebView2 core, DesktopSessionController session, string workbenchRoot)
    {
        _core = core;
        _session = session;
        _apiPath = Path.Combine(workbenchRoot, "_nendo", "api.js");
    }

    /// <summary>
    /// Every request kind from every frame and worker, which only the three-argument filter
    /// covers: the two-argument one sees the main document's requests alone.
    /// </summary>
    internal static ExtensionAssetServer Attach(CoreWebView2 core, DesktopSessionController session, string workbenchRoot)
    {
        var server = new ExtensionAssetServer(core, session, workbenchRoot);
        core.AddWebResourceRequestedFilter(Filter, CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += server.OnRequested;
        return server;
    }

    internal void Detach()
    {
        _core.WebResourceRequested -= OnRequested;
        try { _core.RemoveWebResourceRequestedFilter(Filter, CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All); }
        catch (Exception) { /* The browser is already gone; there is nothing left to filter. */ }
    }

    private async void OnRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !ExtensionOrigins.IsViewHost(uri.Host))
            return;
        var deferral = args.GetDeferral();
        try
        {
            var method = args.Request.Method.ToUpperInvariant();
            var range = args.Request.Headers.Contains("Range") ? args.Request.Headers.GetHeader("Range") : null;
            var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
            var host = uri.Host.ToLowerInvariant();
            // The Engine read and any hashing run away from the UI thread; the response is made
            // back on it, which is where the browser's objects live.
            var asset = method is "GET" or "HEAD"
                ? await Task.Run(() => ResolveAsync(host, path))
                : new DesktopExtensionAsset(405, "text/plain", "Views are served, not posted to."u8.ToArray());
            args.Response = Respond(sender.Environment, asset, method == "HEAD", range);
        }
        catch (Exception)
        {
            try { args.Response = Respond(sender.Environment, new(500, "text/plain", "The view could not be served."u8.ToArray()), false, null); }
            catch (Exception) { /* The browser went away while the file was read. */ }
        }
        finally
        {
            deferral.Complete();
        }
    }

    private async Task<DesktopExtensionAsset> ResolveAsync(string host, string path)
    {
        if (path != ExtensionOrigins.ApiPath) return await _session.ReadExtensionAssetAsync(host, path);
        var status = _session.ExtensionOriginStatus(host);
        if (status != 200) return status == 403 ? DesktopExtensionAsset.Forbidden : DesktopExtensionAsset.NotFound;
        try { return new(200, "text/javascript", await File.ReadAllBytesAsync(_apiPath)); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return new(500, "text/plain", "The view API is missing from this installation. Reinstall Nendo."u8.ToArray());
        }
    }

    private static CoreWebView2WebResourceResponse Respond(CoreWebView2Environment environment, DesktopExtensionAsset asset, bool head, string? range)
    {
        var content = asset.Content;
        var status = asset.Status;
        var headers = new List<string>
        {
            "Content-Type: " + ContentType(asset.MediaType ?? "application/octet-stream"),
            "Cache-Control: no-store",
            "X-Content-Type-Options: nosniff",
        };
        var offset = 0;
        var count = content.Length;
        if (status == 200)
        {
            headers.Add("Accept-Ranges: bytes");
            if (range is not null)
            {
                if (TryRange(range, content.Length, out var start, out var end))
                {
                    status = 206;
                    offset = start;
                    count = end - start + 1;
                    headers.Add(string.Create(CultureInfo.InvariantCulture, $"Content-Range: bytes {start}-{end}/{content.Length}"));
                }
                else
                {
                    status = 416;
                    count = 0;
                    headers.Add(string.Create(CultureInfo.InvariantCulture, $"Content-Range: bytes */{content.Length}"));
                }
            }
        }
        else if (status == 405)
        {
            headers.Add("Allow: GET, HEAD");
        }
        var body = head ? new MemoryStream([], writable: false) : new MemoryStream(content, offset, count, writable: false);
        return environment.CreateWebResourceResponse(body.AsRandomAccessStream(), status, Reason(status), string.Join("\r\n", headers));
    }

    private static string ContentType(string mediaType) =>
        NendoExtensionContent.IsTextual(mediaType) && !mediaType.Contains(';') ? mediaType + "; charset=utf-8" : mediaType;

    /// <summary>One range, the only kind a media element asks for: <c>bytes=a-b</c>, <c>bytes=a-</c> or <c>bytes=-n</c>.</summary>
    internal static bool TryRange(string header, int length, out int start, out int end)
    {
        start = end = 0;
        if (!header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase) || header.Contains(',') || length == 0) return false;
        var parts = header[6..].Trim().Split('-', 2);
        if (parts.Length != 2) return false;
        if (parts[0].Length == 0)
        {
            if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var suffix) || suffix <= 0) return false;
            start = Math.Max(0, length - suffix);
            end = length - 1;
            return true;
        }
        if (!int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out start) || start >= length) return false;
        if (parts[1].Length == 0) { end = length - 1; return true; }
        if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out end) || end < start) return false;
        end = Math.Min(end, length - 1);
        return true;
    }

    private static string Reason(int status) => status switch
    {
        200 => "OK",
        206 => "Partial Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
}
