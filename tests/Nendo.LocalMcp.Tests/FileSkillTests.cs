using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-160, ADR-0024: a file carries its own agent skill as a package of kind skill. It enters
/// only by an accepted proposal, skills/list then offers it beside the host's skill with a
/// manifest whose digests are the bytes served, and a package that names an entry point or
/// whose SKILL.md lacks its frontmatter does not validate, naming the file.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class FileSkillTests
{
    private const string PackageId = "org.example.tasks";
    private const string SkillMarkdown =
        "---\nname: tasks\ndescription: How to work this file's task list.\n---\n\n# Working the task list\n\nA new task starts as Open.\n";

    [TestMethod]
    public async Task AnAcceptedSkillIsListedBesideTheHostsAndItsManifestMatchesTheBytesServed()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        using var http = LatestProtocolTests.Client(host);
        var image = RandomNumberGenerator.GetBytes(300);

        var scoped = await BeginAsync(client, "Teach an agent the task list");
        await AddAsync(client, scoped, "skill",
        [
            new("extension.setPackage", Json(new { packageId = PackageId, title = "Working the task list", kind = "skill", version = "1.0.0" })),
            Put("SKILL.md", text: SkillMarkdown),
            Put("references/statuses.md", text: "Open, Doing, Done.\n"),
            Put("images/flow.png", base64: Convert.ToBase64String(image)),
        ]);
        var preview = await ValidateAsync(client, scoped);
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, JsonSerializer.Serialize(preview.Diagnostics, NendoMcpJson.Options));
        StringAssert.Contains(preview.SemanticDiff.Single(entry => entry.Kind == "setExtensionPackage").Summary, "skill package", StringComparison.Ordinal);
        Assert.IsTrue(preview.SemanticDiff.Any(entry => entry.Kind == "extensionSkill"), "The review does not say what accepting a skill means.");
        Assert.IsFalse(preview.SemanticDiff.Any(entry => entry.Kind == "extensionCode"), "The review calls a skill code that runs.");

        // Nothing is listed before the person accepts.
        var before = (await LatestProtocolTests.Send(http, "skills/list", new())).GetProperty("result");
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", before.GetProperty("skills").EnumerateArray().Single().GetProperty("uri").GetString());
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);

        var list = (await LatestProtocolTests.Send(http, "skills/list", new())).GetProperty("result");
        Assert.AreEqual("private", list.GetProperty("cacheScope").GetString(), "A list that changes with the file was offered for sharing.");
        Assert.AreEqual(0, list.GetProperty("ttlMs").GetInt64());
        var skills = list.GetProperty("skills").EnumerateArray().ToArray();
        Assert.HasCount(2, skills);
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", skills[0].GetProperty("uri").GetString());
        var skill = skills[1];
        Assert.AreEqual($"skill://{PackageId}/SKILL.md", skill.GetProperty("uri").GetString());
        Assert.AreEqual("tasks", skill.GetProperty("frontmatter").GetProperty("name").GetString());
        Assert.AreEqual("How to work this file's task list.", skill.GetProperty("frontmatter").GetProperty("description").GetString());
        var manifest = skill.GetProperty("resources").EnumerateArray().ToArray();
        CollectionAssert.AreEqual(
            new[] { $"skill://{PackageId}/SKILL.md", $"skill://{PackageId}/images/flow.png", $"skill://{PackageId}/references/statuses.md" },
            manifest.Select(file => file.GetProperty("uri").GetString()).ToArray());

        // Every file: the digest and size are those of the bytes a read returns.
        foreach (var file in manifest)
        {
            var uri = file.GetProperty("uri").GetString()!;
            var read = await client.ReadResourceAsync(uri);
            var bytes = read.Contents.Single() switch
            {
                TextResourceContents text => Encoding.UTF8.GetBytes(text.Text),
                BlobResourceContents blob => blob.DecodedData.ToArray(),
                var other => throw new AssertFailedException($"{uri} arrived as {other.GetType().Name}."),
            };
            Assert.AreEqual("sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), file.GetProperty("digest").GetString(), uri);
            Assert.AreEqual(bytes.LongLength, file.GetProperty("size").GetInt64(), uri);
            Assert.AreEqual(TimeSpan.Zero, read.TimeToLive, uri);
        }
        Assert.IsInstanceOfType<BlobResourceContents>((await client.ReadResourceAsync($"skill://{PackageId}/images/flow.png")).Contents.Single());
        Assert.AreEqual(SkillMarkdown, await ProtocolResourceTests.ReadTextAsync(client, $"skill://{PackageId}/SKILL.md"));

        // By URI, both; the file's skill is never cached, the host's keeps its hour.
        var got = (await LatestProtocolTests.Send(http, "skills/get", new() { ["uri"] = $"skill://{PackageId}/SKILL.md" })).GetProperty("result");
        Assert.AreEqual(skill.GetRawText(), got.GetProperty("skill").GetRawText());
        Assert.AreEqual("private", got.GetProperty("cacheScope").GetString());
        var hostSkill = (await LatestProtocolTests.Send(http, "skills/get", new() { ["uri"] = "skill://nendo-authoring/SKILL.md" })).GetProperty("result");
        Assert.AreEqual("public", hostSkill.GetProperty("cacheScope").GetString());
        var missing = await LatestProtocolTests.Send(http, "resources/read", new() { ["uri"] = $"skill://{PackageId}/secrets.md" });
        Assert.IsTrue(missing.TryGetProperty("error", out var error), missing.GetRawText());
        StringAssert.Contains(error.GetProperty("message").GetString(), "has no file secrets.md", StringComparison.Ordinal);

        // The package list says what it is, and that it has no entry point.
        var listed = JsonSerializer.Deserialize<NendoMcpExtensionPackage[]>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extensions"), NendoMcpJson.Options)!.Single();
        Assert.AreEqual("skill", listed.Kind);
        Assert.IsNull(listed.EntryPoint);
    }

    [TestMethod]
    public async Task ASkillThatNamesAnEntryPointOrLacksItsFrontmatterIsRefusedByTheFilesName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        // An entry point is refused where it is sent, naming the file it names.
        var scoped = await BeginAsync(client, "A skill that runs");
        var named = await client.CallToolAsync("nendo.change_set.add_operations", Add(scoped, "entry",
            [new("extension.setPackage", Json(new { packageId = PackageId, title = "Tasks", kind = "skill", entryPoint = "index.html" }))]));
        Assert.IsTrue(named.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(named), "names index.html as its entry point", StringComparison.Ordinal);

        // Each way a SKILL.md can be wrong fails validation with NPROP012, naming the file.
        foreach (var (key, text, expected) in new[]
        {
            ("absent", (string?)null, $"has no {NendoAgentSkill.FileName} at its root"),
            ("no-frontmatter", "# Tasks\n\nNo frontmatter here.\n", $"{PackageId}/SKILL.md does not open with frontmatter"),
            ("no-description", "---\nname: tasks\n---\n", $"{PackageId}/SKILL.md has no description"),
            ("other-name", "---\nname: chores\ndescription: Chores.\n---\n", $"{PackageId}/SKILL.md names the skill 'chores'"),
        })
        {
            var draft = await BeginAsync(client, $"A skill, {key}", lease: false, owned: scoped);
            var operations = new List<NendoAgentOperationInput>
            {
                new("extension.setPackage", Json(new { packageId = PackageId, title = "Tasks", kind = "skill" })),
                Put("references/notes.md", text: "Notes.\n"),
            };
            if (text is not null) operations.Add(Put("SKILL.md", text: text));
            await AddAsync(client, draft, key, [.. operations]);
            var preview = await ValidateAsync(client, draft);
            Assert.AreEqual(NendoProposalState.Invalid, preview.State, key);
            var diagnostic = preview.Diagnostics.Single(item => item.Code == "NPROP012");
            StringAssert.Contains(diagnostic.Message, expected, StringComparison.Ordinal);
            Assert.AreEqual(PackageId, diagnostic.SemanticId, key);
            Assert.AreEqual("SKILL.md", diagnostic.PropertyPath, key);
        }
    }

    [TestMethod]
    public async Task AFileWithAViewPackageAndNoSkillServesOnlyTheHostsSkill()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        using var http = LatestProtocolTests.Client(host);
        var scoped = await BeginAsync(client, "A view");
        await AddAsync(client, scoped, "view",
        [
            new("extension.setPackage", Json(new { packageId = "org.example.hello", title = "Hello" })),
            new("extension.putFile", Json(new { packageId = "org.example.hello", path = "index.html", text = "<!doctype html><title>Hello</title>" })),
            new("extension.putFile", Json(new { packageId = "org.example.hello", path = "SKILL.md", text = SkillMarkdown })),
        ]);
        var preview = await ValidateAsync(client, scoped);
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);

        var skills = (await LatestProtocolTests.Send(http, "skills/list", new())).GetProperty("result").GetProperty("skills").EnumerateArray().ToArray();
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", skills.Single().GetProperty("uri").GetString(), "A view package was offered as a skill.");
        var read = await LatestProtocolTests.Send(http, "resources/read", new() { ["uri"] = "skill://org.example.hello/SKILL.md" });
        Assert.IsTrue(read.TryGetProperty("error", out var error), read.GetRawText());
        StringAssert.Contains(error.GetProperty("message").GetString(), "no skill package org.example.hello", StringComparison.Ordinal);
    }

    private static NendoAgentOperationInput Put(string path, string? text = null, string? base64 = null) =>
        new("extension.putFile", Json(new Dictionary<string, object?>
        {
            ["packageId"] = PackageId,
            ["path"] = path,
            [text is null ? "base64" : "text"] = text ?? base64,
        }));

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static async Task<Dictionary<string, object?>> BeginAsync(
        McpClient client, string title, bool lease = true, Dictionary<string, object?>? owned = null)
    {
        Dictionary<string, object?> handle;
        if (lease)
        {
            var grant = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
            handle = new() { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        }
        else
        {
            handle = new() { ["applicationHandle"] = owned!["applicationHandle"], ["leaseId"] = owned["leaseId"] };
        }
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(handle) { ["title"] = title, ["idempotencyKey"] = "begin-" + title }));
        return new(handle) { ["changeSetId"] = begun.ChangeSetId };
    }

    private static Dictionary<string, object?> Add(Dictionary<string, object?> scoped, string key, NendoAgentOperationInput[] operations) =>
        new(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput($"Part {key}", operations) },
            ["idempotencyKey"] = key,
        };

    private static async Task AddAsync(McpClient client, Dictionary<string, object?> scoped, string key, NendoAgentOperationInput[] operations)
    {
        var result = await client.CallToolAsync("nendo.change_set.add_operations", Add(scoped, key, operations));
        Assert.AreNotEqual(true, result.IsError, $"{key} was refused: {JsonSerializer.Serialize(result)}");
    }

    private static async Task<NendoAgentProposalPreview> ValidateAsync(McpClient client, Dictionary<string, object?> scoped) =>
        Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "validate-" + scoped["changeSetId"] }));

    private static T Result<T>(CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
