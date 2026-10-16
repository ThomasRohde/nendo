using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Pictures for agents (ADR-0031 point 12, W-269): a picture sent in chunks, each inside one
/// request, embedded on the final chunk with its field set in the same revision; a picture that
/// never commits leaves nothing; the picture is read back as an image; refusals keep their words.
/// </summary>
[TestClass]
public sealed class McpMediaTests
{
    [TestMethod]
    public async Task APictureSentInChunksIsEmbeddedAndItsFieldSetInOneRevision()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAlbumsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var picture = Png(1600, 900, 5 * 1024 * 1024);
        const int Chunk = 110 * 1024;
        NendoMediaPutResult? last = null;
        for (var offset = 0; offset < picture.Length; offset += Chunk)
        {
            var final = offset + Chunk >= picture.Length;
            var arguments = new Dictionary<string, object?>(session)
            {
                ["idempotencyKey"] = "cover-1", ["offset"] = offset, ["final"] = final, ["name"] = "front.png",
                ["base64"] = Convert.ToBase64String(picture, offset, Math.Min(Chunk, picture.Length - offset)),
            };
            if (final)
            {
                arguments["entityId"] = "albums"; arguments["recordId"] = "a1"; arguments["fieldId"] = "cover"; arguments["expectedRecordVersion"] = 1;
            }
            last = await CallAsync<NendoMediaPutResult>(client, "nendo.data.put_media", arguments);
            if (!final) Assert.AreEqual((long)Math.Min(offset + Chunk, picture.Length), last.Bytes);
        }
        var sha = NendoExtensionContent.Sha256(picture);
        Assert.IsTrue(last!.Committed);
        Assert.AreEqual("media:" + sha, last.Address);
        var record = (await workspace.Service.QueryRecordsAsync(new("albums", 1) { RecordId = "a1" })).Items.Single();
        Assert.AreEqual("media:" + sha, record.Values["cover"].GetString());
        Assert.AreEqual(2, record.RecordVersion, "the put and the set are one revision");

        // The final call again answers with the same commit.
        var again = await CallAsync<NendoMediaPutResult>(client, "nendo.data.put_media", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "cover-1", ["offset"] = picture.Length - picture.Length % Chunk, ["final"] = true,
            ["base64"] = Convert.ToBase64String(picture, picture.Length - picture.Length % Chunk, picture.Length % Chunk),
        });
        Assert.AreEqual(last.Write!.RevisionId, again.Write!.RevisionId);

        // The description, and too large to read whole.
        var described = JsonDocument.Parse(((TextResourceContents)(await client.ReadResourceAsync($"nendo://application/media/{sha}")).Contents.Single()).Text).RootElement;
        Assert.AreEqual("image/png", described.GetProperty("mediaType").GetString());
        Assert.AreEqual(1600, described.GetProperty("width").GetInt32());
        await Assert.ThrowsAsync<Exception>(() => client.ReadResourceAsync($"nendo://application/media/{sha}?content=true").AsTask());
    }

    [TestMethod]
    public async Task ASmallPictureIsReadBackAsAnImageAndAnUnfinishedOneLeavesNothing()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAlbumsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var small = Png(8, 8, 2048);
        var put = await CallAsync<NendoMediaPutResult>(client, "nendo.data.put_media", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "small", ["base64"] = Convert.ToBase64String(small),
        });
        var blob = (BlobResourceContents)(await client.ReadResourceAsync($"nendo://application/media/{put.Address![6..]}?content=true")).Contents.Single();
        Assert.AreEqual("image/png", blob.MimeType);
        // The SDK holds a blob as its base64 text's bytes.
        CollectionAssert.AreEqual(small, Convert.FromBase64String(System.Text.Encoding.UTF8.GetString(blob.Blob.Span)));

        var unfinished = Png(9, 9, 300_000);
        await CallAsync<NendoMediaPutResult>(client, "nendo.data.put_media", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "unfinished", ["final"] = false, ["base64"] = Convert.ToBase64String(unfinished, 0, 100_000),
        });
        Assert.IsNull(await workspace.Service.ReadMediaAsync(NendoExtensionContent.Sha256(unfinished)), "a picture that never committed is in the file");
        var gap = await client.CallToolAsync("nendo.data.put_media", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "unfinished", ["offset"] = 200_000, ["base64"] = Convert.ToBase64String(unfinished, 200_000, 100_000),
        });
        Assert.IsTrue(gap.IsError);
        StringAssert.Contains(Text(gap), "the next chunk starts at offset 100000");
    }

    [TestMethod]
    public async Task ARefusedPictureReachesTheAgentInItsOwnWords()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAlbumsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var text = await client.CallToolAsync("nendo.data.put_media", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "text", ["base64"] = Convert.ToBase64String("just some words"u8.ToArray()),
        });
        Assert.IsTrue(text.IsError);
        StringAssert.Contains(Text(text), "NENDO_MEDIA_TYPE_MISMATCH");
        StringAssert.Contains(Text(text), "does not begin as any picture type");

        var missing = await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "missing", ["entityId"] = "albums", ["recordId"] = "a1", ["fieldId"] = "cover",
            ["expectedRecordVersion"] = 1, ["value"] = JsonSerializer.SerializeToElement("media:" + new string('c', 64)),
        });
        Assert.IsTrue(missing.IsError);
        StringAssert.Contains(Text(missing), "NENDO_MEDIA_MISSING");
        StringAssert.Contains(Text(missing), "Albums a1 names a picture in Cover");
    }

    private static async Task PrepareAlbumsAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Albums", "test", new([new("test", "schema", "test", "Albums", [
                new CreateEntityOperation("albums", "albums", "Albums", "albums"),
                new AddFieldOperation("a-title", "albums", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("a-cover", "albums", "cover", "Cover", "cover", NendoStorageKind.Text, false, NendoMedia.Presentation),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("albums", "a1", new Dictionary<string, object?> { ["title"] = "Blue" }, new("test", "a1", "test")));
    }

    private static byte[] Png(int width, int height, int length)
    {
        var bytes = new byte[Math.Max(length, 33)];
        new Random(width * 31 + height).NextBytes(bytes);
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52 }.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(16), (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(20), (uint)height);
        return bytes;
    }

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal) { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {Text(result)}");
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
