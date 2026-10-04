using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-154: the host declares the Skills extension and serves one skill whose manifest
/// digests and sizes are the bytes resources/read serves.
/// </summary>
[TestClass]
public sealed class HostSkillTests
{
    [TestMethod]
    public async Task TheSkillIsListedFetchedByUriAndItsManifestMatchesTheBytesServed()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = LatestProtocolTests.Client(host);

        var discovery = await LatestProtocolTests.Send(http, "server/discover", new());
        var extensions = discovery.GetProperty("result").GetProperty("capabilities").GetProperty("extensions");
        Assert.IsTrue(extensions.TryGetProperty("io.modelcontextprotocol/skills", out _), discovery.GetRawText());
        Assert.IsTrue(discovery.GetProperty("result").GetProperty("capabilities").TryGetProperty("resources", out _));

        var listed = await LatestProtocolTests.Send(http, "skills/list", new());
        var list = listed.GetProperty("result");
        Assert.AreEqual("complete", list.GetProperty("resultType").GetString());
        Assert.AreEqual("public", list.GetProperty("cacheScope").GetString());
        Assert.AreEqual(3_600_000, list.GetProperty("ttlMs").GetInt64());
        var skill = list.GetProperty("skills").EnumerateArray().Single();
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", skill.GetProperty("uri").GetString());
        Assert.AreEqual("nendo-authoring", skill.GetProperty("frontmatter").GetProperty("name").GetString());
        var manifest = skill.GetProperty("resources").EnumerateArray().ToArray();
        Assert.HasCount(4, manifest);
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", manifest[0].GetProperty("uri").GetString());

        // Every file: the digest and size are the bytes served, and the read is build-static.
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        foreach (var file in manifest)
        {
            var uri = file.GetProperty("uri").GetString()!;
            var read = await client.ReadResourceAsync(uri);
            var content = (TextResourceContents)read.Contents.Single();
            var bytes = Encoding.UTF8.GetBytes(content.Text);
            Assert.AreEqual("sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), file.GetProperty("digest").GetString(), uri);
            Assert.AreEqual(bytes.LongLength, file.GetProperty("size").GetInt64(), uri);
            Assert.AreEqual(uri.EndsWith("SKILL.md", StringComparison.Ordinal) ? "text/markdown" : "application/json", content.MimeType, uri);
            Assert.AreEqual(TimeSpan.FromHours(1), read.TimeToLive, uri);
        }

        // The frontmatter in the file is the entry's, field for field, and the directory is the name.
        var markdown = ((TextResourceContents)(await client.ReadResourceAsync("skill://nendo-authoring/SKILL.md")).Contents.Single()).Text;
        StringAssert.StartsWith(markdown, "---\nname: nendo-authoring\ndescription: " + skill.GetProperty("frontmatter").GetProperty("description").GetString() + "\n---\n", StringComparison.Ordinal);
        StringAssert.Contains(markdown, "`nendo.change_set.begin`", StringComparison.Ordinal);
        StringAssert.Contains(markdown, "`validate`", StringComparison.Ordinal);
        StringAssert.Contains(markdown, "`schema.createEntity` takes entityId, displayName", StringComparison.Ordinal);
        StringAssert.Contains(markdown, "`create-entity-with-required-fields`", StringComparison.Ordinal);
        var vocabulary = ((TextResourceContents)(await client.ReadResourceAsync("skill://nendo-authoring/references/vocabulary.json")).Contents.Single()).Text;
        Assert.AreEqual(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"), vocabulary, "The supporting file is the vocabulary read, byte for byte.");

        // By URI, and an unknown one.
        var got = await LatestProtocolTests.Send(http, "skills/get", new() { ["uri"] = "skill://nendo-authoring/SKILL.md" });
        Assert.AreEqual(skill.GetRawText(), got.GetProperty("result").GetProperty("skill").GetRawText());
        var unknown = await LatestProtocolTests.Send(http, "skills/get", new() { ["uri"] = "skill://other/SKILL.md" });
        Assert.AreEqual(-32602, unknown.GetProperty("error").GetProperty("code").GetInt32());
        StringAssert.Contains(unknown.GetProperty("error").GetProperty("message").GetString(), "NENDO_SKILL_NOT_FOUND", StringComparison.Ordinal);
        var missing = await LatestProtocolTests.Send(http, "resources/read", new() { ["uri"] = "skill://nendo-authoring/references/secrets.json" });
        Assert.IsTrue(missing.TryGetProperty("error", out var error), missing.GetRawText());
        StringAssert.Contains(error.GetProperty("message").GetString(), "has no file secrets.json", StringComparison.Ordinal);
    }
}
