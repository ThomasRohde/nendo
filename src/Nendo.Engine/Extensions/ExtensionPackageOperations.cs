using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Creates a custom-view package in the file, or changes its title, version, entry point or
/// description (ADR-0013). The package is definition: it changes through a proposal like any
/// screen, and it holds no permission — a view that names it runs it when shown.
/// </summary>
public sealed record SetExtensionPackageOperation : NendoOperation
{
    public SetExtensionPackageOperation(
        string operationId,
        string packageId,
        string title,
        string entryPoint,
        string? version = null,
        string? description = null)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException(
                $"Package ID '{packageId}' is not valid. Use 3-{NendoExtensionLimits.PackageIdCharacters} lowercase characters in at least two dotted segments, each starting with a letter, such as org.example.map.");
        Title = string.IsNullOrWhiteSpace(title) || title.Length > 200
            ? throw new NendoValidationException("A package title must contain 1-200 characters.")
            : title;
        EntryPoint = NendoExtensionContent.ValidPath(entryPoint)
            ? entryPoint
            : throw new NendoValidationException($"Entry point '{entryPoint}' is not a valid package path.");
        Version = string.IsNullOrWhiteSpace(version) ? null : version;
        if (Version is not null && (Version.Length > 40 || !NendoExtensionContent.ValidVersion(Version)))
            throw new NendoValidationException($"Package version '{Version}' is not a semantic version such as 1.0.0.");
        Description = string.IsNullOrWhiteSpace(description) ? null : description;
        if (Description is { Length: > 1000 })
            throw new NendoValidationException("A package description is at most 1000 characters.");
    }

    public string PackageId { get; }
    public string Title { get; }
    public string EntryPoint { get; }
    public string? Version { get; }
    public string? Description { get; }
    public override string OperationType => "extension.setPackage";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        if (Description is not null) writer.WriteString("description", Description);
        writer.WriteString("entryPoint", EntryPoint);
        writer.WriteString("packageId", PackageId);
        writer.WriteString("title", Title);
        if (Version is not null) writer.WriteString("version", Version);
        writer.WriteEndObject();
    }
}

/// <summary>
/// Puts one file into a package, adding it or replacing what the path held.
/// <para>
/// The operation is identified by the SHA-256 of the bytes rather than by the bytes: the
/// canonical form, its digest and the history row carry the hash, the size and the media
/// type, and the bytes travel beside the operation into the file's content store, where each
/// distinct content is kept once. A replaced version stays in that store, so reversing the
/// put restores the exact bytes it replaced. An operation that carries no bytes names content
/// the file already holds — which is how a reversal, and a copy between packages, is written.
/// </para>
/// </summary>
public sealed record PutExtensionFileOperation : NendoOperation
{
    /// <summary>The expected-content marker that says the path must not hold a file yet.</summary>
    public const string ExpectAbsent = "absent";

    private readonly byte[]? _content;

    private PutExtensionFileOperation(
        string operationId, string packageId, string path, string mediaType,
        string sha256, long byteLength, byte[]? content, string? expectedSha256)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException($"Package ID '{packageId}' is not valid.");
        Path = NendoExtensionContent.ValidPath(path)
            ? path
            : throw new NendoValidationException(
                $"Path '{path}' is not a valid package path. Use letters, digits, _ - . ~ and / between segments, at most {NendoExtensionLimits.PathCharacters} characters; nothing under _nendo/.");
        MediaType = NendoExtensionContent.ValidMediaType(mediaType)
            ? mediaType
            : throw new NendoValidationException($"Media type '{mediaType}' is not a lowercase type/subtype such as text/javascript.");
        if (!NendoExtensionContent.IsSha256(sha256))
            throw new NendoValidationException("A file's SHA-256 must be 64 lowercase hexadecimal characters.");
        if (byteLength is < 0 or > NendoExtensionLimits.FileBytes)
            throw new NendoValidationException(
                $"A package file is at most {NendoExtensionLimits.FileBytes} bytes, and {path} is {byteLength}.");
        if (expectedSha256 is not null && expectedSha256 != ExpectAbsent && !NendoExtensionContent.IsSha256(expectedSha256))
            throw new NendoValidationException("An expected SHA-256 must be 64 lowercase hexadecimal characters or \"absent\".");
        Sha256 = sha256;
        ByteLength = byteLength;
        ExpectedSha256 = expectedSha256;
        _content = content;
    }

    /// <summary>Puts these bytes at the path. The hash and size are computed here, never taken on trust.</summary>
    public static PutExtensionFileOperation FromContent(
        string operationId, string packageId, string path, string? mediaType, byte[] content, string? expectedSha256 = null)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (content.Length > NendoExtensionLimits.FileBytes)
            throw new NendoValidationException(
                $"A package file is at most {NendoExtensionLimits.FileBytes} bytes, and {path} is {content.Length}.");
        return new(operationId, packageId, path, mediaType ?? NendoExtensionContent.MediaTypeFor(path),
            NendoExtensionContent.Sha256(content), content.Length, content.ToArray(), expectedSha256);
    }

    /// <summary>Puts content the file already holds, named by its hash, at the path.</summary>
    public static PutExtensionFileOperation FromStoredContent(
        string operationId, string packageId, string path, string? mediaType, string sha256, long byteLength, string? expectedSha256 = null) =>
        new(operationId, packageId, path, mediaType ?? NendoExtensionContent.MediaTypeFor(path), sha256, byteLength, null, expectedSha256);

    public string PackageId { get; }
    public string Path { get; }
    public string MediaType { get; }
    public string Sha256 { get; }
    public long ByteLength { get; }

    /// <summary>
    /// A precondition on what the path holds before the put: null checks nothing, <see cref="ExpectAbsent"/>
    /// requires no file there, and a hash requires exactly that content. A reversal always states one,
    /// so it refuses rather than overwriting a later change.
    /// </summary>
    public string? ExpectedSha256 { get; }

    /// <summary>Whether this operation carries its bytes, rather than naming content the file already holds.</summary>
    public bool CarriesContent => _content is not null;

    /// <summary>A copy of the bytes this operation carries, or null when it names stored content.</summary>
    public byte[]? CopyContent() => _content?.ToArray();

    /// <summary>The new content bytes this operation brings with it, for the per-change-set bound.</summary>
    internal int CarriedBytes => _content?.Length ?? 0;

    internal byte[]? ContentArray => _content;

    public override string OperationType => "extension.putFile";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteNumber("byteLength", ByteLength);
        if (ExpectedSha256 is not null) writer.WriteString("expectedSha256", ExpectedSha256);
        writer.WriteString("mediaType", MediaType);
        writer.WriteString("packageId", PackageId);
        writer.WriteString("path", Path);
        writer.WriteString("sha256", Sha256);
        writer.WriteEndObject();
    }
}

/// <summary>Removes one file from a package. Its content stays in the file's store, so the removal can be reversed.</summary>
public sealed record RemoveExtensionFileOperation : NendoOperation
{
    public RemoveExtensionFileOperation(string operationId, string packageId, string path, string? expectedSha256 = null)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException($"Package ID '{packageId}' is not valid.");
        Path = NendoExtensionContent.ValidPath(path)
            ? path
            : throw new NendoValidationException($"Path '{path}' is not a valid package path.");
        if (expectedSha256 is not null && !NendoExtensionContent.IsSha256(expectedSha256))
            throw new NendoValidationException("An expected SHA-256 must be 64 lowercase hexadecimal characters.");
        ExpectedSha256 = expectedSha256;
    }

    public string PackageId { get; }
    public string Path { get; }

    /// <summary>When set, the file is removed only while it holds exactly this content.</summary>
    public string? ExpectedSha256 { get; }

    public override string OperationType => "extension.removeFile";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        if (ExpectedSha256 is not null) writer.WriteString("expectedSha256", ExpectedSha256);
        writer.WriteString("packageId", PackageId);
        writer.WriteString("path", Path);
        writer.WriteEndObject();
    }
}

/// <summary>Removes an empty package. A package that still holds files is refused, so no file is lost by accident.</summary>
public sealed record RemoveExtensionPackageOperation : NendoOperation
{
    public RemoveExtensionPackageOperation(string operationId, string packageId)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException($"Package ID '{packageId}' is not valid.");
    }

    public string PackageId { get; }
    public override string OperationType => "extension.removePackage";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("packageId", PackageId);
        writer.WriteEndObject();
    }
}
