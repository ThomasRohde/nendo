using System.Security.Cryptography;
using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A custom view's code arrives through the same authoring tools as every other definition
/// (ADR-0013). A file larger than one operation's payload arrives in parts with
/// <c>append</c>, which the adapter joins before validation, and reads back a page at a time.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class ExtensionPackageProtocolTests
{
    private const string PackageId = "org.example.atlas";
    private const int ChunkBytes = 64 * 1024;

    [TestMethod]
    public async Task AMegabyteFileArrivesInPartsAndReadsBackExactly()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var scoped = await BeginAsync(client, "Put the atlas in the file");

        var content = RandomNumberGenerator.GetBytes(1024 * 1024);
        await AddAsync(client, scoped, "package", [Put("index.html", text: "<!doctype html><title>Atlas</title>"),
            new("extension.setPackage", Json(new { packageId = PackageId, title = "Atlas" }))], swap: true);
        var chunks = content.Chunk(ChunkBytes).ToArray();
        for (var index = 0; index < chunks.Length; index += 2)
        {
            var operations = chunks.Skip(index).Take(2)
                .Select((chunk, offset) => Put("tiles/world.bin", base64: Convert.ToBase64String(chunk), append: index + offset > 0))
                .ToArray();
            await AddAsync(client, scoped, $"chunks-{index:D2}", operations);
        }

        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "validate" }));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, JsonSerializer.Serialize(preview.Diagnostics, NendoMcpJson.Options));
        var put = preview.SemanticDiff.Single(entry => entry.Kind == "putExtensionFile" && entry.Summary.Contains("world.bin", StringComparison.Ordinal));
        StringAssert.Contains(put.Summary, "1 MB", "The joined put does not carry the whole file.");
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);

        var assembled = new List<byte>();
        long? offsetNext = 0;
        string? sha = null;
        var pages = 0;
        while (offsetNext is { } offset)
        {
            var page = JsonSerializer.Deserialize<NendoMcpExtensionFileContent>(
                await ProtocolResourceTests.ReadTextAsync(client, $"nendo://application/extension/{PackageId}/file?path=tiles%2Fworld.bin&offset={offset}"),
                NendoMcpJson.Options)!;
            Assert.IsNull(page.Text, "A binary page arrived as text.");
            assembled.AddRange(Convert.FromBase64String(page.Base64!));
            sha = page.Sha256;
            offsetNext = page.NextOffset;
            pages++;
        }
        Assert.AreEqual(8, pages);
        CollectionAssert.AreEqual(content, assembled.ToArray(), "The file read back differs from the file sent in parts.");
        Assert.AreEqual(Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(), sha);

        var listed = JsonSerializer.Deserialize<NendoMcpExtensionPackage[]>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extensions"), NendoMcpJson.Options)!;
        Assert.AreEqual(content.Length, listed.Single().Files.Single(file => file.Path == "tiles/world.bin").ByteLength);
    }

    [TestMethod]
    public async Task AnOversizedPartAndAnOrphanedChunkAreRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var scoped = await BeginAsync(client, "Refusals");

        var oversized = await client.CallToolAsync("nendo.change_set.add_operations", Add(scoped, "oversized",
            [new("extension.setPackage", Json(new { packageId = PackageId, title = "Atlas" })),
             Put("big.bin", base64: Convert.ToBase64String(new byte[80 * 1024]))]));
        Assert.IsTrue(oversized.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(oversized), "96 KiB one operation may carry");
        StringAssert.Contains(JsonSerializer.Serialize(oversized), "append true");

        var orphan = await client.CallToolAsync("nendo.change_set.add_operations", Add(scoped, "orphan",
            [Put("lonely.js", text: "part two", append: true)]));
        Assert.IsTrue(orphan.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(orphan), "no earlier extension.putFile in this change set began it");
    }

    private static NendoAgentOperationInput Put(string path, string? text = null, string? base64 = null, bool append = false) =>
        new("extension.putFile", Json(new Dictionary<string, object?>
        {
            ["packageId"] = PackageId,
            ["path"] = path,
            [text is null ? "base64" : "text"] = text ?? base64,
            ["append"] = append ? true : null,
        }.Where(pair => pair.Value is not null).ToDictionary()));

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static async Task<Dictionary<string, object?>> BeginAsync(McpClient client, string title)
    {
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = title, ["idempotencyKey"] = "begin" }));
        return new(owned) { ["changeSetId"] = begun.ChangeSetId };
    }

    private static Dictionary<string, object?> Add(Dictionary<string, object?> scoped, string key, NendoAgentOperationInput[] operations) =>
        new(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput($"Part {key}", operations) },
            ["idempotencyKey"] = key,
        };

    private static async Task AddAsync(McpClient client, Dictionary<string, object?> scoped, string key, NendoAgentOperationInput[] operations, bool swap = false)
    {
        // The package must exist before its first file, so a caller that listed the file first swaps them.
        var ordered = swap ? operations.Reverse().ToArray() : operations;
        var result = await client.CallToolAsync("nendo.change_set.add_operations", Add(scoped, key, ordered));
        Assert.AreNotEqual(true, result.IsError, $"{key} was refused: {JsonSerializer.Serialize(result)}");
    }

    private static T Result<T>(CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
