using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// The person's picture actions on a media field (ADR-0031, W-266). Each reads a file, the
    /// clipboard or the web on the host, so no picture crosses the bridge and no page names a path
    /// it may read: a picked file comes from the native picker, a dropped one from WebView2's own
    /// file object, and only the person's press starts a download.
    /// </summary>
    internal const string MediaEmbed = "media.embed";
    internal const string MediaLink = "media.link";
    internal const string MediaEmbedCopy = "media.embedCopy";
    internal const string MediaSaveCopy = "media.saveCopy";
    internal const string MediaReveal = "media.reveal";

    /// <summary>
    /// What a custom view reads and writes of pictures (ADR-0031 point 12, W-270): a picture's
    /// description and page address, a window of an embedded picture's bytes, and a picture it
    /// holds, staged in chunks and committed in its package's name. No view reads a local file
    /// or the web through these: describe names a link's page address, which shows it and no more.
    /// </summary>
    internal const string MediaDescribe = "media.describe";
    internal const string MediaReadWindow = "media.readWindow";
    internal const string MediaStage = "media.stage";
    internal const string MediaCommit = "media.commit";
}

/// <summary>The window's half of the picture actions: its pickers and the clipboard.</summary>
internal interface IWorkbenchMediaHost
{
    /// <summary>A picture file the person picks; null when they cancel.</summary>
    Task<string?> PickPictureAsync(string commitText);

    /// <summary>Where to save a copy of a picture; null when they cancel.</summary>
    Task<string?> PickPictureSaveAsync(string suggestedName, string extension);

    /// <summary>A picture on the clipboard, as a picture type Nendo stores, or null when there is none.</summary>
    Task<(byte[] Content, string Name)?> ReadClipboardPictureAsync();
}

/// <summary>A picture as a view reads it: where it comes from, its page address, and what the file knows of it.</summary>
internal sealed record DesktopMediaDescription(string Address, string Source, string? Url, string? MediaType, long? ByteLength,
    string? Name, int? Width, int? Height);

/// <summary>A window of an embedded picture's bytes; nextOffset is null on the last.</summary>
internal sealed record DesktopMediaWindow(string Base64, long ByteLength, string MediaType, long? NextOffset);

/// <summary>How many bytes of a view's picture are staged.</summary>
internal sealed record DesktopMediaStaged(long Bytes);

/// <summary>What a picture action did: the address the field now holds, and the write, or that the person cancelled.</summary>
internal sealed record DesktopMediaActionView(bool Cancelled, string? Address = null, DesktopMutationView? Write = null);

internal sealed partial class WorkbenchProtocolHandler
{
    private IWorkbenchMediaHost? _mediaHost;
    private readonly NendoMediaUploads<DesktopMediaActionView> _viewUploads = new();

    /// <summary>The most of a picture one window carries: base64 of it stays inside one message.</summary>
    internal const int MediaWindowBytes = 160 * 1024;
    private static readonly HttpClient WebPictures = new() { Timeout = TimeSpan.FromSeconds(30) };

    internal IWorkbenchMediaHost? MediaHost { set => _mediaHost = value; }

    private IWorkbenchMediaHost RequireMediaHost() =>
        _mediaHost ?? throw new NendoPreconditionException("media-unavailable", "Pictures can be added only in the Nendo window.");

    private static NendoMediaTarget MediaTarget(JsonElement payload) => new(
        RequiredString(payload, "entityId", 200), RequiredString(payload, "recordId", 200), RequiredString(payload, "fieldId", 200),
        payload.TryGetProperty("expectedRecordVersion", out var version) && version.TryGetInt64(out var expected) && expected >= 1
            ? expected
            : throw new NendoValidationException("Request property expectedRecordVersion is required."));

    private async Task<object> EmbedMediaAsync(JsonElement payload, string? droppedPicture, CancellationToken cancellationToken)
    {
        var target = MediaTarget(payload);
        var source = RequiredString(payload, "source", 16);
        byte[] content;
        string name;
        switch (source)
        {
            case "drop":
                if (droppedPicture is null) throw new NendoValidationException("No picture arrived with that request.");
                (content, name) = await ReadPictureFileAsync(droppedPicture, cancellationToken);
                break;
            case "pick":
                var picked = await RequireMediaHost().PickPictureAsync("Embed");
                if (picked is null) return new DesktopMediaActionView(true);
                (content, name) = await ReadPictureFileAsync(picked, cancellationToken);
                break;
            case "paste":
                var pasted = await RequireMediaHost().ReadClipboardPictureAsync()
                    ?? throw new NendoPreconditionException("media-clipboard-empty", "The clipboard holds no picture.");
                (content, name) = pasted;
                break;
            default:
                throw new NendoValidationException("A picture is embedded from a pick, a drop or the clipboard.");
        }
        return await PutPictureAsync(content, name, target, cancellationToken);
    }

    private async Task<object> LinkMediaAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var target = MediaTarget(payload);
        var picked = await RequireMediaHost().PickPictureAsync("Link");
        if (picked is null) return new DesktopMediaActionView(true);
        var address = _session.LocalMediaAddressFor(picked);
        var write = await _session.SetFieldAsync(target.EntityId, target.RecordId, target.FieldId, target.ExpectedRecordVersion, address,
            "media-link-" + Guid.NewGuid().ToString("N"), cancellationToken);
        return new DesktopMediaActionView(false, address, write);
    }

    /// <summary>Embeds what a link names: a local file read here, or a web picture downloaded on the person's press.</summary>
    private async Task<object> EmbedMediaCopyAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var target = MediaTarget(payload);
        if (!NendoMediaAddress.TryParse(RequiredString(payload, "address", NendoMedia.MaximumAddressCharacters), out var address))
            throw new NendoPreconditionException("media-address-invalid", "That is not a picture's address.");
        (byte[] Content, string Name) picture;
        if (address!.Source == NendoMediaSource.Web)
        {
            using var response = await WebPictures.GetAsync(new Uri(address.Value), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new NendoPreconditionException("media-download-failed", $"The web address answered {(int)response.StatusCode}; nothing was embedded.");
            if (response.Content.Headers.ContentLength is > NendoMedia.MaximumItemBytes)
                throw new NendoPreconditionException("media-too-large", $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB.");
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var copy = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
            {
                if (copy.Length + read > NendoMedia.MaximumItemBytes)
                    throw new NendoPreconditionException("media-too-large", $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB.");
                copy.Write(buffer, 0, read);
            }
            picture = (copy.ToArray(), Path.GetFileName(new Uri(address.Value).AbsolutePath) is { Length: > 0 } file ? file : "picture");
        }
        else if (address.Source is NendoMediaSource.LocalAbsolute or NendoMediaSource.LocalRelative)
        {
            picture = await ReadPictureFileAsync(_session.ResolveLocalMediaPath(address)
                ?? throw new NendoPreconditionException("media-missing", "The linked file is not there."), cancellationToken);
        }
        else
        {
            throw new NendoPreconditionException("media-already-embedded", "That picture is already in the file.");
        }
        return await PutPictureAsync(picture.Content, picture.Name, target, cancellationToken);
    }

    private async Task<object> SaveMediaCopyAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (!NendoMediaAddress.TryParse(RequiredString(payload, "address", NendoMedia.MaximumAddressCharacters), out var address) ||
            address!.Source != NendoMediaSource.Embedded)
            throw new NendoPreconditionException("media-address-invalid", "Only a picture in the file is saved this way.");
        var answer = await _session.ResolveMediaAsync("m/" + address.Sha256, "", cancellationToken);
        if (answer.Status != 200) throw new NendoPreconditionException("media-missing", "The file does not hold that picture.");
        var extension = NendoMedia.PictureTypes[answer.MediaType!][0];
        var name = payload.TryGetProperty("name", out var given) && given.ValueKind == JsonValueKind.String && given.GetString() is { Length: > 0 } text
            ? Path.GetFileNameWithoutExtension(text) : "picture";
        var path = await RequireMediaHost().PickPictureSaveAsync(name, extension);
        if (path is null) return new DesktopMediaActionView(true);
        await using (var source = answer.Open!(0, answer.Length))
        await using (var destination = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            await source.CopyToAsync(destination, cancellationToken);
        return new DesktopMediaActionView(false, address.Value);
    }

    private object RevealMedia(JsonElement payload)
    {
        if (!NendoMediaAddress.TryParse(RequiredString(payload, "address", NendoMedia.MaximumAddressCharacters), out var address) ||
            _session.ResolveLocalMediaPath(address!) is not { } path)
            throw new NendoPreconditionException("media-missing", "The linked file is not there.");
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
        return new DesktopMediaActionView(false, address!.Value);
    }

    private async Task<object> DescribeMediaAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (!NendoMediaAddress.TryParse(RequiredString(payload, "address", NendoMedia.MaximumAddressCharacters), out var address))
            throw new NendoPreconditionException("media-address-invalid", "That is not a picture's address.");
        var origin = (await _session.GetViewAsync(cancellationToken)).MediaOrigin;
        var path = DesktopMediaOrigins.PathFor(address!);
        var url = address!.Source == NendoMediaSource.Web ? address.Value : origin is null || path is null ? null : origin + path;
        if (address.Source != NendoMediaSource.Embedded)
            return new DesktopMediaDescription(address.Value, SourceWord(address.Source), url, null, null, null, null, null);
        var item = await _session.ResolveMediaAsync("m/" + address.Sha256, "", cancellationToken);
        if (item.Status != 200) return new DesktopMediaDescription(address.Value, "embedded", null, null, null, null, null, null);
        var metadata = await _session.ReadMediaItemAsync(address.Sha256!, cancellationToken);
        return new DesktopMediaDescription(address.Value, "embedded", url, item.MediaType, item.Length, metadata?.Name, metadata?.Width, metadata?.Height);
    }

    private static string SourceWord(NendoMediaSource source) => source switch
    {
        NendoMediaSource.Embedded => "embedded",
        NendoMediaSource.Web => "web",
        _ => "local",
    };

    private async Task<object> ReadMediaWindowAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var sha = RequiredString(payload, "sha256", 64);
        var offset = payload.TryGetProperty("offset", out var given) && given.TryGetInt64(out var at) && at >= 0 ? at : 0;
        var answer = await _session.ResolveMediaAsync("m/" + sha, "", cancellationToken);
        if (answer.Status != 200) throw new NendoPreconditionException("media-missing", "The file does not hold that picture.");
        var count = (int)Math.Min(MediaWindowBytes, Math.Max(0, answer.Length - offset));
        var buffer = new byte[count];
        var read = 0;
        await using (var stream = answer.Open!(offset, count))
            while (read < count && await stream.ReadAsync(buffer.AsMemory(read)) is var got and > 0) read += got;
        var next = offset + read;
        return new DesktopMediaWindow(Convert.ToBase64String(buffer, 0, read), answer.Length, answer.MediaType!, next >= answer.Length ? null : next);
    }

    private object StageViewMedia(JsonElement payload, string? writer)
    {
        if (writer is null) throw new NendoPreconditionException("actor-not-allowed", "Only a custom view stages a picture this way.");
        var key = writer + "\n" + RequiredString(payload, "uploadKey", 200);
        var offset = payload.TryGetProperty("offset", out var given) && given.TryGetInt64(out var at) ? at : 0;
        byte[] chunk;
        try { chunk = Convert.FromBase64String(RequiredString(payload, "base64", MaximumMessageCharacters)); }
        catch (FormatException) { throw new NendoValidationException("base64 is not valid base64."); }
        return new DesktopMediaStaged(_viewUploads.Stage(key, offset, chunk));
    }

    private async Task<object> CommitViewMediaAsync(JsonElement payload, string? writer, CancellationToken cancellationToken)
    {
        if (writer is null) throw new NendoPreconditionException("actor-not-allowed", "Only a custom view commits a picture this way.");
        var uploadKey = RequiredString(payload, "uploadKey", 200);
        var key = writer + "\n" + uploadKey;
        if (_viewUploads.Committed(key) is { } done) return done;
        var content = _viewUploads.Take(key);
        if (content.Length == 0) throw new NendoValidationException("Nothing was staged under that uploadKey.");
        var name = payload.TryGetProperty("name", out var given) && given.ValueKind == JsonValueKind.String ? given.GetString() : null;
        var mediaType = payload.TryGetProperty("mediaType", out var stated) && stated.ValueKind == JsonValueKind.String ? stated.GetString() : null;
        var target = payload.TryGetProperty("entityId", out _) ? MediaTarget(payload) : null;
        string? address = null;
        var write = await _session.MutateAsync(async service =>
        {
            var put = await service.PutMediaAsync(new NendoPutMediaRequest(content, mediaType, name,
                new NendoRequestContext("desktop.p2.5", "view-media-" + uploadKey, writer), target), cancellationToken);
            address = put.Address;
            return put.Result;
        }, cancellationToken, writer);
        var result = new DesktopMediaActionView(false, address, write);
        _viewUploads.Remember(key, result);
        return result;
    }

    private async Task<object> PutPictureAsync(byte[] content, string name, NendoMediaTarget target, CancellationToken cancellationToken)
    {
        var shortName = name.Length > NendoMedia.MaximumNameCharacters ? name[..NendoMedia.MaximumNameCharacters] : name;
        string? address = null;
        var write = await _session.MutateAsync(async service =>
        {
            var put = await service.PutMediaAsync(new NendoPutMediaRequest(content, null, shortName,
                new NendoRequestContext("desktop.p2.5", "media-embed-" + Guid.NewGuid().ToString("N"), "surface"), target), cancellationToken);
            address = put.Address;
            return put.Result;
        }, cancellationToken);
        return new DesktopMediaActionView(false, address, write);
    }

    /// <summary>A picture file's bytes, within the item bound; its type is the Engine's to read from them.</summary>
    private static async Task<(byte[] Content, string Name)> ReadPictureFileAsync(string path, CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new NendoPreconditionException("media-missing", "The picture file is not there.");
        if (info.Length > NendoMedia.MaximumItemBytes)
            throw new NendoPreconditionException("media-too-large",
                $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB, and {info.Name} is {info.Length / (1024 * 1024)} MiB.");
        return (await File.ReadAllBytesAsync(path, cancellationToken), info.Name);
    }
}
