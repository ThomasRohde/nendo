using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// The skills the open file carries (ADR-0024): each package of kind skill, listed by the
/// Skills extension beside the host's own and served under <c>skill://{packageId}/</c>. Read
/// from the file on every call, so a skill accepted a moment ago is listed, and its manifest
/// is the stored SHA-256 of each file — the hash of the very bytes a read returns.
/// <para>
/// The host vouches for nothing a file's skill says. Loading it into a model is the client's
/// act, under the client's approval; the person's protection is the review that accepted it.
/// </para>
/// </summary>
internal static class NendoFileSkills
{
    private const string Scheme = "skill://";

    internal static string SkillUri(string packageId) => $"{Scheme}{packageId}/{NendoAgentSkill.FileName}";

    internal static string FileUri(string packageId, string path) => $"{Scheme}{packageId}/{path}";

    /// <summary>
    /// Every skill package whose <c>SKILL.md</c> reads, by package ID. Validation refuses a
    /// proposal that would leave one that does not, so a skipped package is a file written
    /// some other way, and listing it without a name would break a client's manifest checks.
    /// </summary>
    internal static async Task<IReadOnlyList<FileSkill>> ReadAsync(NendoApplicationService application, CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        var skills = new List<FileSkill>();
        foreach (var package in snapshot.ExtensionPackages.Where(package => package.IsSkill).OrderBy(package => package.PackageId, StringComparer.Ordinal))
        {
            var file = await application.ReadExtensionFileAsync(package.PackageId, NendoAgentSkill.FileName, cancellationToken);
            if (NendoAgentSkill.TryRead(package.PackageId, file?.Content, out var frontmatter, out _)) skills.Add(new(package, frontmatter!));
        }
        return skills;
    }

    /// <summary>
    /// One file of a skill package, as a resource read returns it: text when its type is text
    /// and its bytes are UTF-8, base64 otherwise. Either way a client that hashes what it
    /// received gets the digest the manifest lists.
    /// </summary>
    internal static async Task<ResourceContents> ReadFileAsync(
        NendoApplicationService application, string packageId, string path, CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        if (!snapshot.ExtensionPackages.Any(package => package.PackageId == packageId && package.IsSkill))
            throw new NendoValidationException($"This file carries no skill package {packageId}; skills/list names every skill this host serves.");
        var file = await application.ReadExtensionFileAsync(packageId, path, cancellationToken)
            ?? throw new NendoValidationException($"The skill {packageId} has no file {path}; its manifest in skills/list names every file it holds.");
        var uri = FileUri(packageId, path);
        return NendoExtensionContent.IsTextual(file.MediaType) && TryUtf8(file.Content, out var text)
            ? new TextResourceContents { Uri = uri, MimeType = file.MediaType, Text = text }
            : BlobResourceContents.FromBytes(file.Content, uri, file.MediaType);
    }

    private static readonly System.Text.UTF8Encoding StrictUtf8 = new(false, true);

    private static bool TryUtf8(byte[] bytes, out string text)
    {
        try
        {
            text = StrictUtf8.GetString(bytes);
            return true;
        }
        catch (System.Text.DecoderFallbackException)
        {
            text = "";
            return false;
        }
    }

    internal sealed record FileSkill(NendoExtensionPackageSnapshot Package, NendoSkillFrontmatter Frontmatter)
    {
        internal string Uri => SkillUri(Package.PackageId);

        /// <summary>The entry as skills/list and skills/get return it: the frontmatter and every file, SKILL.md first.</summary>
        internal JsonObject Entry() => new()
        {
            ["uri"] = Uri,
            ["frontmatter"] = new JsonObject { ["name"] = Frontmatter.Name, ["description"] = Frontmatter.Description },
            ["resources"] = new JsonArray(Package.Files
                .OrderBy(file => file.Path == NendoAgentSkill.FileName ? 0 : 1).ThenBy(file => file.Path, StringComparer.Ordinal)
                .Select(file => (JsonNode)new JsonObject
                {
                    ["uri"] = FileUri(Package.PackageId, file.Path),
                    ["digest"] = "sha256:" + file.Sha256,
                    ["size"] = file.ByteLength,
                }).ToArray()),
        };
    }
}
