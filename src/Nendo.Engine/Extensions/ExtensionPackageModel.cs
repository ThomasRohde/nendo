using System.Security.Cryptography;

namespace Nendo.Engine;

/// <summary>
/// A custom-view package carried in the file (ADR-0013): its metadata and the files it holds,
/// without their contents. What a client lists; the bytes are read one file at a time.
/// </summary>
public sealed record NendoExtensionPackageSnapshot(
    string PackageId,
    string Title,
    string? Version,
    string EntryPoint,
    string? Description,
    IReadOnlyList<NendoExtensionFileSnapshot> Files)
{
    /// <summary>The bytes the package's current files hold together.</summary>
    public long TotalBytes => Files.Sum(file => file.ByteLength);
}

/// <summary>One file of a package as the file holds it now: where it is, what it is and which bytes.</summary>
public sealed record NendoExtensionFileSnapshot(
    string Path,
    string MediaType,
    string Sha256,
    long ByteLength);

/// <summary>One file of a package with its bytes.</summary>
public sealed record NendoExtensionFileContent(
    string PackageId,
    string Path,
    string MediaType,
    string Sha256,
    byte[] Content);

/// <summary>
/// How one package file differs between the active file and the file a proposal would leave,
/// so a person reviewing code reads the change rather than a sentence about it.
/// </summary>
/// <param name="Change"><c>added</c>, <c>replaced</c> or <c>removed</c>.</param>
/// <param name="Hunks">
/// The changed lines with three lines of context, for a text file of at most
/// <see cref="NendoExtensionLimits.DiffedFileBytes"/> on both sides. Empty for a binary file,
/// whose change is said by its sizes alone.
/// </param>
/// <param name="Truncated">True when the lines shown stop before the change does.</param>
public sealed record NendoExtensionFileChange(
    string PackageId,
    string Path,
    string Change,
    string? MediaTypeBefore,
    string? MediaTypeAfter,
    long? BytesBefore,
    long? BytesAfter,
    bool Textual,
    IReadOnlyList<NendoExtensionDiffHunk> Hunks,
    bool Truncated);

/// <summary>A run of changed lines and its context, numbered from one on each side.</summary>
public sealed record NendoExtensionDiffHunk(
    int OldStart,
    int OldLines,
    int NewStart,
    int NewLines,
    IReadOnlyList<NendoExtensionDiffLine> Lines);

/// <summary>One line of a hunk: <c>context</c>, <c>removed</c> or <c>added</c>.</summary>
public sealed record NendoExtensionDiffLine(string Kind, string Text);

/// <summary>
/// The bounds a package in the file keeps (ADR-0013). Bounded product choices rather than
/// measured optima: large enough for a view with a bundled library and its assets, small
/// enough that code cannot crowd the records out of a file Nendo opens up to 256 MiB.
/// Declared once here, published through <see cref="NendoAuthoringLimits"/>, and refused
/// above rather than truncated.
/// </summary>
public static class NendoExtensionLimits
{
    /// <summary>The largest single file.</summary>
    public const int FileBytes = 4 * 1024 * 1024;

    /// <summary>The most files one package holds.</summary>
    public const int PackageFiles = 512;

    /// <summary>The most bytes one package's current files hold together.</summary>
    public const long PackageBytes = 16L * 1024 * 1024;

    /// <summary>The most packages one file carries.</summary>
    public const int Packages = 64;

    /// <summary>The most bytes every package's current files hold together.</summary>
    public const long TotalBytes = 64L * 1024 * 1024;

    /// <summary>
    /// The most new file content one change set may carry. It bounds the largest commit, which
    /// is what the write reserve below the open bound has to cover.
    /// </summary>
    public const int ContentBytesPerChangeSet = 4 * 1024 * 1024;

    /// <summary>The largest text file the review diffs line by line; a larger one is said by its sizes.</summary>
    public const int DiffedFileBytes = 1024 * 1024;

    /// <summary>The most changed lines the review shows for one file.</summary>
    public const int DiffLinesPerFile = 400;

    /// <summary>The most changed lines the review shows for one proposal.</summary>
    public const int DiffLinesPerProposal = 2000;

    /// <summary>The longest path within a package.</summary>
    public const int PathCharacters = 240;

    /// <summary>The longest package ID. Short enough that <c>extension:</c> plus it fits an origin of 100.</summary>
    public const int PackageIdCharacters = 80;
}

/// <summary>
/// The rules a package's IDs, paths and media types follow, in one place, so the Engine that
/// stores a file, the host that serves it and the adapters that author it agree on them.
/// </summary>
public static class NendoExtensionContent
{
    public static string Sha256(ReadOnlySpan<byte> content) =>
        Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();

    public static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    /// <summary>
    /// A package ID names an origin and an attribution, so it is lowercase and dotted: at least
    /// two segments, each starting with a letter, of letters, digits and hyphens.
    /// </summary>
    public static bool ValidPackageId(string? value) =>
        value is { Length: >= 3 and <= NendoExtensionLimits.PackageIdCharacters } &&
        NendoExtensionViewDefinition.ValidPackageId(value);

    /// <summary>
    /// A relative path of letters, digits, <c>_ - . ~</c> and <c>/</c> between segments. No
    /// empty, <c>.</c> or <c>..</c> segment, none ending in a dot, no Windows device name, and
    /// nothing under <c>_nendo/</c>, which every view origin reserves for the host.
    /// </summary>
    public static bool ValidPath(string? path)
    {
        if (path is null || path.Length is 0 or > NendoExtensionLimits.PathCharacters) return false;
        if (path.Any(character => character is not (>= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-' or '.' or '~' or '/')))
            return false;
        var segments = path.Split('/');
        if (string.Equals(segments[0], "_nendo", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var segment in segments)
        {
            if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith('.')) return false;
            var name = segment.Split('.')[0].ToUpperInvariant();
            if (name is "CON" or "PRN" or "AUX" or "NUL" ||
                name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) && name[3] is >= '0' and <= '9')
                return false;
        }
        return true;
    }

    /// <summary>A bare <c>type/subtype</c>, lowercase, without parameters; the host adds a charset when it serves text.</summary>
    public static bool ValidMediaType(string? value)
    {
        if (value is null || value.Length is < 3 or > 100) return false;
        var slash = value.IndexOf('/');
        if (slash <= 0 || slash != value.LastIndexOf('/') || slash == value.Length - 1) return false;
        return value.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '/' or '!' or '#' or '$' or '&' or '^' or '_' or '.' or '+' or '-');
    }

    private static readonly IReadOnlyDictionary<string, string> MediaTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html", [".htm"] = "text/html", [".js"] = "text/javascript", [".mjs"] = "text/javascript",
        [".cjs"] = "text/javascript", [".css"] = "text/css", [".json"] = "application/json", [".map"] = "application/json",
        [".txt"] = "text/plain", [".md"] = "text/markdown", [".csv"] = "text/csv", [".xml"] = "application/xml",
        [".svg"] = "image/svg+xml", [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif", [".webp"] = "image/webp", [".avif"] = "image/avif", [".ico"] = "image/x-icon",
        [".bmp"] = "image/bmp", [".wasm"] = "application/wasm", [".woff"] = "font/woff", [".woff2"] = "font/woff2",
        [".ttf"] = "font/ttf", [".otf"] = "font/otf", [".mp3"] = "audio/mpeg", [".wav"] = "audio/wav", [".ogg"] = "audio/ogg",
        [".mp4"] = "video/mp4", [".webm"] = "video/webm", [".pdf"] = "application/pdf", [".geojson"] = "application/geo+json",
        [".topojson"] = "application/json", [".glb"] = "model/gltf-binary", [".gltf"] = "model/gltf+json",
        [".ts"] = "text/plain", [".tsx"] = "text/plain", [".vue"] = "text/plain", [".yaml"] = "text/yaml", [".yml"] = "text/yaml",
    };

    /// <summary>The media type a path's extension names, or <c>application/octet-stream</c> when it names none.</summary>
    public static string MediaTypeFor(string path) =>
        MediaTypes.TryGetValue(System.IO.Path.GetExtension(path), out var type) ? type : "application/octet-stream";

    /// <summary>Whether a media type is text a review can show line by line and a server should label UTF-8.</summary>
    public static bool IsTextual(string mediaType) =>
        mediaType.StartsWith("text/", StringComparison.Ordinal) ||
        mediaType is "application/json" or "application/xml" or "image/svg+xml" or "application/geo+json" or "model/gltf+json" ||
        mediaType.EndsWith("+json", StringComparison.Ordinal) || mediaType.EndsWith("+xml", StringComparison.Ordinal);
}
