using System.IO.Compression;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// A custom-view package as it arrives from outside a file: a folder or a zip with a
/// <c>nendo-package.json</c>, or a legacy <c>.nendoview</c> archive. Read in full and bounded
/// before anything is proposed, so a package that cannot fit the file is refused by name here
/// rather than part of the way through a change set.
/// </summary>
public sealed record NendoExtensionArchive(
    string PackageId,
    string Title,
    string? Version,
    string? EntryPoint,
    string? Description,
    IReadOnlyList<NendoExtensionArchiveFile> Files)
{
    /// <summary><see cref="NendoExtensionPackageKind.View"/>, or <see cref="NendoExtensionPackageKind.Skill"/> for a package with no entry point (ADR-0024).</summary>
    public string Kind { get; init; } = NendoExtensionPackageKind.View;
}

public sealed record NendoExtensionArchiveFile(string Path, byte[] Content);

public static class NendoExtensionArchives
{
    /// <summary>The description a package folder carries. Never stored as a file: the package row holds it.</summary>
    public const string ManifestName = "nendo-package.json";
    private const string LegacyManifestName = "manifest.json";
    private const int ManifestBytes = 64 * 1024;

    /// <summary>
    /// The most entries a zip may list, counting the ones an import leaves out: a bound on the work
    /// of reading its directory, not on the package. The package's own bound is on the files it
    /// keeps, so a zip of a folder that still holds node_modules or a Finder shadow tree is read for
    /// the files it carries.
    /// </summary>
    internal const int ZipEntries = 16 * NendoExtensionLimits.PackageFiles;

    /// <summary>Reads a folder, a zip or a legacy archive, whichever the path names.</summary>
    public static NendoExtensionArchive Read(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (Directory.Exists(path)) return ReadFolder(path);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return ReadZip(stream);
    }

    /// <summary>
    /// Every file under the folder except hidden ones, <c>node_modules</c> and the manifest
    /// itself. Links are not followed, so a folder cannot bring in files from elsewhere.
    /// </summary>
    public static NendoExtensionArchive ReadFolder(string folder)
    {
        var root = new DirectoryInfo(Path.GetFullPath(folder));
        if (!root.Exists) throw new NendoValidationException($"The folder {folder} does not exist.");
        var manifestPath = Path.Combine(root.FullName, ManifestName);
        if (!File.Exists(manifestPath))
            throw new NendoValidationException($"The folder has no {ManifestName}. Add one that names the package, such as {{ \"packageId\": \"org.example.map\", \"title\": \"Map\" }}.");
        var manifest = ReadBounded(File.OpenRead(manifestPath), ManifestBytes, ManifestName);
        var files = new List<NendoExtensionArchiveFile>();
        long total = 0;
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint,
            IgnoreInaccessible = false,
        };
        foreach (var file in root.EnumerateFiles("*", options))
        {
            var relative = Path.GetRelativePath(root.FullName, file.FullName).Replace('\\', '/');
            if (Skipped(relative)) continue;
            if (file.Length > NendoExtensionLimits.FileBytes) throw TooLarge(relative);
            Add(files, relative, ReadBounded(file.OpenRead(), NendoExtensionLimits.FileBytes, relative), ref total);
        }
        return Describe(manifest, files);
    }

    /// <summary>
    /// A zip whose manifest sits at its root or inside its single top-level folder, the way
    /// zipping a folder leaves it; or a legacy <c>.nendoview</c>, read for its files alone.
    /// </summary>
    public static NendoExtensionArchive ReadZip(Stream stream)
    {
        ZipArchive archive;
        try { archive = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true); }
        catch (InvalidDataException) { throw new NendoValidationException("The file is not a folder, a zip or a .nendoview archive."); }
        using (archive)
        {
            if (archive.Entries.Count > ZipEntries)
                throw new NendoValidationException(
                    $"The zip lists {archive.Entries.Count} entries, and Nendo reads at most {ZipEntries} from one package zip, counting folders and the files an import leaves out. Zip the package's folder without node_modules or other folders it does not need.");
            // Separators first: a directory entry written with backslashes ends in one, and read
            // as a file it was refused as a path rule the person never broke.
            var entries = archive.Entries.Where(entry => !entry.FullName.Replace('\\', '/').EndsWith('/')).ToArray();
            var names = entries.Select(entry => entry.FullName.Replace('\\', '/')).ToArray();
            var prefix = ManifestPrefix(names, ManifestName);
            var legacy = prefix is null && ManifestPrefix(names, LegacyManifestName) is not null;
            prefix ??= ManifestPrefix(names, LegacyManifestName)
                ?? throw new NendoValidationException($"The zip has no {ManifestName} at its root or in its top folder.");
            byte[]? manifest = null;
            var files = new List<NendoExtensionArchiveFile>();
            long total = 0;
            for (var index = 0; index < entries.Length; index++)
            {
                if (!names[index].StartsWith(prefix, StringComparison.Ordinal)) continue;
                var relative = names[index][prefix.Length..];
                var entry = entries[index];
                if (relative == (legacy ? LegacyManifestName : ManifestName))
                {
                    manifest = ReadEntry(entry, ManifestBytes, relative);
                    continue;
                }
                if (Skipped(relative)) continue;
                if (entry.Length > NendoExtensionLimits.FileBytes) throw TooLarge(relative);
                Add(files, relative, ReadEntry(entry, NendoExtensionLimits.FileBytes, relative), ref total);
            }
            return legacy ? DescribeLegacy(manifest!, files) : Describe(manifest!, files);
        }
    }

    /// <summary>
    /// What the file must change to carry this package: its description, then removals of files
    /// the package no longer has, then the files that are new or different. A file the file
    /// already holds byte for byte is left alone, so re-importing an edit proposes only the edit.
    /// Every put and removal names the content it expects, so a proposal prepared against an
    /// older package is refused rather than replayed over a newer one.
    /// </summary>
    public static NendoChangeSet ChangeSet(NendoExtensionArchive archive, NendoExtensionPackageSnapshot? current)
    {
        ArgumentNullException.ThrowIfNull(archive);
        // Operation IDs are unique across the file's whole history, not just this change.
        var stem = "import-" + Guid.NewGuid().ToString("N");
        var operations = new List<NendoOperation>
        {
            new SetExtensionPackageOperation(stem + "-package", archive.PackageId, archive.Title, archive.EntryPoint, archive.Version, archive.Description, archive.Kind),
        };
        var incoming = archive.Files.Select(file => file.Path).ToHashSet(StringComparer.Ordinal);
        var existing = (current?.Files ?? []).ToDictionary(file => file.Path, StringComparer.Ordinal);
        var index = 0;
        foreach (var file in current?.Files ?? [])
        {
            if (!incoming.Contains(file.Path))
                operations.Add(new RemoveExtensionFileOperation($"{stem}-remove-{++index}", archive.PackageId, file.Path, file.Sha256));
        }
        foreach (var file in archive.Files)
        {
            var had = existing.GetValueOrDefault(file.Path);
            if (had is not null && had.Sha256 == NendoExtensionContent.Sha256(file.Content) &&
                had.MediaType == NendoExtensionContent.MediaTypeFor(file.Path))
                continue;
            operations.Add(PutExtensionFileOperation.FromContent($"{stem}-put-{++index}", archive.PackageId, file.Path, null, file.Content,
                had?.Sha256 ?? PutExtensionFileOperation.ExpectAbsent));
        }
        if (current is not null && operations.Count == 1 && current.Title == archive.Title && current.Version == archive.Version &&
            current.EntryPoint == archive.EntryPoint && current.Description == archive.Description && current.Kind == archive.Kind)
            throw new NendoPreconditionException("extension-unchanged", $"The file already carries {archive.Title} exactly as it is here.");
        var verb = current is null ? "Add" : "Update";
        var noun = archive.Kind == NendoExtensionPackageKind.Skill ? "skill package" : "custom-view package";
        return new NendoChangeSet(
        [
            new NendoMutation("desktop.extension", stem, "workbench",
                $"{verb} the {noun} {archive.Title} ({archive.PackageId})", operations),
        ]).Validate();
    }

    /// <summary>The manifest an exported package carries, so exporting and importing again gives the same package.</summary>
    public static byte[] Manifest(NendoExtensionPackageSnapshot package)
    {
        ArgumentNullException.ThrowIfNull(package);
        var manifest = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["packageId"] = package.PackageId,
            ["title"] = package.Title,
        };
        if (package.Version is { } version) manifest["version"] = version;
        if (package.IsSkill) manifest["kind"] = package.Kind;
        else manifest["entryPoint"] = package.EntryPoint!;
        if (package.Description is { } description) manifest["description"] = description;
        return JsonSerializer.SerializeToUtf8Bytes(manifest, new JsonSerializerOptions { WriteIndented = true });
    }

    private static NendoExtensionArchive Describe(byte[] manifest, List<NendoExtensionArchiveFile> files)
    {
        using var document = Parse(manifest, ManifestName);
        var root = document.RootElement;
        var packageId = Text(root, "packageId", required: true)!;
        var title = Text(root, "title") ?? packageId;
        var kind = Text(root, "kind") ?? NendoExtensionPackageKind.View;
        if (!NendoExtensionPackageKind.IsKnown(kind))
            throw new NendoValidationException($"The package manifest's kind '{kind}' is not one of: {NendoExtensionPackageKind.View}, {NendoExtensionPackageKind.Skill}.");
        if (kind == NendoExtensionPackageKind.Skill)
            return FinishSkill(packageId, title, Text(root, "version"), Text(root, "entryPoint"), Text(root, "description"), files);
        var entryPoint = Text(root, "entryPoint") ?? "index.html";
        return Finish(packageId, title, Text(root, "version"), entryPoint, Text(root, "description"), files);
    }

    /// <summary>A package built for the retired helper. Its code used an older protocol; it is kept, not converted.</summary>
    private static NendoExtensionArchive DescribeLegacy(byte[] manifest, List<NendoExtensionArchiveFile> files)
    {
        using var document = Parse(manifest, LegacyManifestName);
        var root = document.RootElement;
        var packageId = Text(root, "packageId", required: true)!;
        return Finish(packageId, packageId, Text(root, "version"), Text(root, "entryPoint") ?? "index.html", null, files);
    }

    private static NendoExtensionArchive Finish(string packageId, string title, string? version, string entryPoint, string? description,
        List<NendoExtensionArchiveFile> files)
    {
        if (!NendoExtensionContent.ValidPackageId(packageId))
            throw new NendoValidationException($"Package ID '{packageId}' is not valid. Use lowercase dotted segments such as org.example.map.");
        if (files.Count == 0) throw new NendoValidationException("The package has no files.");
        if (!files.Any(file => file.Path == entryPoint))
            throw new NendoValidationException($"The entry point {entryPoint} is not one of the package's files.");
        return new(packageId, title, version, entryPoint, description, files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray());
    }

    /// <summary>
    /// A skill package (ADR-0024) names no entry point and carries a <c>SKILL.md</c> whose
    /// frontmatter names it, refused here by the file's name rather than at validate.
    /// </summary>
    private static NendoExtensionArchive FinishSkill(string packageId, string title, string? version, string? entryPoint, string? description,
        List<NendoExtensionArchiveFile> files)
    {
        if (!NendoExtensionContent.ValidPackageId(packageId))
            throw new NendoValidationException($"Package ID '{packageId}' is not valid. Use lowercase dotted segments such as org.example.planner.");
        if (entryPoint is not null)
            throw new NendoValidationException($"The skill package {packageId} names {entryPoint} as its entry point, and a skill package has none: nothing in it runs. Remove entryPoint from {ManifestName}.");
        var skill = files.SingleOrDefault(file => file.Path == NendoAgentSkill.FileName);
        if (!NendoAgentSkill.TryRead(packageId, skill?.Content, out _, out var problem))
            throw new NendoValidationException(problem!);
        return new(packageId, title, version, null, description, files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray())
        {
            Kind = NendoExtensionPackageKind.Skill,
        };
    }

    private static void Add(List<NendoExtensionArchiveFile> files, string path, byte[] content, ref long total)
    {
        if (!NendoExtensionContent.ValidPath(path))
            throw new NendoValidationException($"The package path {path} is not allowed. Paths use letters, digits and - _ . ~ /, and never start with _nendo/.");
        if (files.Any(file => string.Equals(file.Path, path, StringComparison.OrdinalIgnoreCase)))
            throw new NendoValidationException($"The package has two files named {path} apart from case.");
        // A folder cannot hold a file and a folder of one name, so export could not write it.
        if (files.FirstOrDefault(file => NendoExtensionContent.FileAndFolderClash(file.Path, path)) is { } clash)
            throw new NendoValidationException($"The package has a file and a folder both named {FolderName(clash.Path, path)}, apart from case. A folder cannot hold both; rename one.");
        if (files.Count >= NendoExtensionLimits.PackageFiles)
            throw new NendoValidationException($"A package holds at most {NendoExtensionLimits.PackageFiles} files.");
        total += content.Length;
        if (total > NendoExtensionLimits.PackageBytes)
            throw new NendoValidationException($"A package holds at most {NendoExtensionLimits.PackageBytes / (1024 * 1024)} MiB.");
        files.Add(new(path, content));
    }

    private static bool Skipped(string path) => NendoExtensionContent.LeftOutOnImport(path);

    private static string FolderName(string one, string other) => one.Length < other.Length ? one : other;

    private static string? ManifestPrefix(IReadOnlyList<string> names, string manifest)
    {
        if (names.Contains(manifest, StringComparer.Ordinal)) return "";
        var nested = names.Where(name => name.EndsWith("/" + manifest, StringComparison.Ordinal) && name.Count(c => c == '/') == 1).ToArray();
        return nested.Length == 1 ? nested[0][..^manifest.Length] : null;
    }

    /// <summary>
    /// One entry's bytes, refused by its name when the zip cannot give them: a compression method
    /// .NET does not read, encryption, or a damaged stream. They reached the Workbench as a host
    /// fault with nothing named.
    /// </summary>
    private static byte[] ReadEntry(ZipArchiveEntry entry, int limit, string name)
    {
        try
        {
            return ReadBounded(entry.Open(), limit, name);
        }
        catch (Exception exception) when (exception is InvalidDataException or NotSupportedException)
        {
            throw new NendoValidationException($"{name} in the zip cannot be read: {exception.Message} Zip the package again with ordinary compression and no password.");
        }
    }

    /// <summary>Reads at most <paramref name="limit"/> bytes whatever a header claimed, and refuses one more.</summary>
    private static byte[] ReadBounded(Stream stream, int limit, string name)
    {
        using (stream)
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = stream.Read(chunk, 0, chunk.Length)) > 0)
            {
                if (buffer.Length + read > limit) throw TooLarge(name);
                buffer.Write(chunk, 0, read);
            }
            return buffer.ToArray();
        }
    }

    private static JsonDocument Parse(byte[] manifest, string name)
    {
        try
        {
            var document = JsonDocument.Parse(manifest, new JsonDocumentOptions { MaxDepth = 16, CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            if (document.RootElement.ValueKind == JsonValueKind.Object) return document;
            document.Dispose();
        }
        catch (JsonException) { }
        throw new NendoValidationException($"{name} is not a JSON object.");
    }

    private static string? Text(JsonElement root, string name, bool required = false)
    {
        if (root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()))
            return value.GetString()!.Trim();
        return required ? throw new NendoValidationException($"The package manifest needs a {name}.") : null;
    }

    private static NendoValidationException TooLarge(string path) =>
        new($"{path} is larger than {NendoExtensionLimits.FileBytes / (1024 * 1024)} MiB, the most one package file may hold.");
}
