using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// CSV with pictures (ADR-0031 point 14, W-272): an export with pictures writes the file's pictures
/// beside the CSV, a file in that folder imports the CSV and embeds the linked pictures, and every
/// picture arrives with the same bytes. A CSV naming a picture the file does not hold is refused
/// before review, by its row.
/// </summary>
[TestClass]
public sealed class CsvPicturesTests
{
    private const string Albums = "albums";

    [TestMethod]
    public async Task APictureMakesTheRoundTripThroughACsvAndItsFolderWithTheSameBytes()
    {
        await using var source = new EngineTestWorkspace();
        await using var target = new EngineTestWorkspace();
        var from = await ServiceAsync(source);
        // Two different pictures under one name, one the same picture twice, a web link and none.
        var blue = Png(640, 480, 4096); var green = Png(320, 200, 2048);
        await CreateAsync(from, "a1", "Blue", null); await CreateAsync(from, "a2", "Green", null); await CreateAsync(from, "a3", "Blue again", null);
        await from.PutMediaAsync(new(blue, null, "front.png", Context("p1"), new(Albums, "a1", "album.cover", 1)));
        await from.PutMediaAsync(new(green, null, "front.png", Context("p2"), new(Albums, "a2", "album.cover", 1)));
        await from.PutMediaAsync(new(blue, null, "front.png", Context("p3"), new(Albums, "a3", "album.cover", 1)));
        await CreateAsync(from, "a4", "Web", "https://pictures.example.org/web.png");
        await CreateAsync(from, "a5", "None", null);

        var folder = Path.GetDirectoryName(target.FilePath)!;
        var written = await from.ExportCsvPicturesAsync(Albums, folder);
        Assert.HasCount(2, written, "each picture once");
        Assert.AreEqual(@".\Media\front.png", written[NendoExtensionContent.Sha256(blue)]);
        Assert.AreEqual($@".\Media\front-{NendoExtensionContent.Sha256(green)[..8]}.png", written[NendoExtensionContent.Sha256(green)],
            "a different picture under a taken name keeps its own file");
        var csvPath = Path.Combine(folder, "albums.csv");
        await using (var csv = File.Create(csvPath)) Assert.AreEqual(5, await from.ExportCsvFileAsync(Albums, csv, pictureAddresses: written));
        var text = await File.ReadAllTextAsync(csvPath);
        Assert.DoesNotContain("media:", text, "an exported picture is named by its file");

        var to = await ServiceAsync(target);
        var document = NendoCsvProfile.Parse(await File.ReadAllBytesAsync(csvPath));
        var batch = await to.PrepareCsvBatchAsync(document, Albums, [new(0, "album.title"), new(1, "album.cover")], new(true), 0, Guid.NewGuid().ToString("N"));
        Assert.IsTrue((await to.PromoteProposalAsync(batch.Proposal.ProposalId)).Applied);
        var embedded = await to.EmbedLinkedPicturesAsync(Albums, folder, Context("embed"));
        Assert.AreEqual(3, embedded.Embedded, string.Join("; ", embedded.Left.Select(left => left.Reason)));
        Assert.IsEmpty(embedded.Left);

        var before = await CoversAsync(from); var after = await CoversAsync(to);
        Assert.HasCount(5, after);
        foreach (var (title, address) in before)
        {
            var arrived = after[title];
            if (address is null || !address.StartsWith(NendoMedia.EmbeddedScheme, StringComparison.Ordinal)) { Assert.AreEqual(address, arrived, title); continue; }
            var sha = address[NendoMedia.EmbeddedScheme.Length..];
            CollectionAssert.AreEqual(await from.ReadMediaContentAsync(sha), await to.ReadMediaContentAsync(arrived![NendoMedia.EmbeddedScheme.Length..]), title);
            Assert.AreEqual(address, arrived, $"{title}: the same bytes are the same address");
        }
    }

    [TestMethod]
    public async Task ACsvNamingAPictureTheFileDoesNotHoldIsRefusedByItsRow()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await ServiceAsync(workspace);
        var missing = NendoMediaAddress.Embedded(new string('b', 64));
        var document = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes($"Title,Cover\r\nKept,\\N\r\nGone,{missing}\r\n"));
        var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            service.PrepareCsvBatchAsync(document, Albums, [new(0, "album.title"), new(1, "album.cover")], new(true), 0, Guid.NewGuid().ToString("N")));
        StringAssert.StartsWith(refusal.Message, "CSV row 3, Cover: this file does not hold the picture " + missing);
        Assert.IsEmpty((await service.QueryRecordsAsync(new(Albums, 10))).Items, "nothing was written");

        var notAnAddress = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("Title,Cover\r\nOdd,cover.png\r\n"));
        refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            service.PrepareCsvBatchAsync(notAnAddress, Albums, [new(0, "album.title"), new(1, "album.cover")], new(true), 0, Guid.NewGuid().ToString("N")));
        StringAssert.StartsWith(refusal.Message, "CSV row 2, Cover: “cover.png” is not a picture's address");
    }

    [TestMethod]
    public async Task ALinkThatIsNotThereOrNotAPictureIsLeftLinkedAndSaysWhy()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await ServiceAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        Directory.CreateDirectory(Path.Combine(folder, "Media"));
        await File.WriteAllTextAsync(Path.Combine(folder, "Media", "notes.png"), "plain text, not a picture");
        await CreateAsync(service, "a1", "Gone", @".\Media\gone.png");
        await CreateAsync(service, "a2", "Text", @".\Media\notes.png");
        var result = await service.EmbedLinkedPicturesAsync(Albums, folder, Context("embed"));
        Assert.AreEqual(0, result.Embedded);
        CollectionAssert.AreEquivalent(new[] { @".\Media\gone.png", @".\Media\notes.png" }, result.Left.Select(left => left.Address).ToArray());
        Assert.AreEqual("The file is not there.", result.Left.Single(left => left.RecordId == "a1").Reason);
        var covers = await CoversAsync(service);
        Assert.AreEqual(@".\Media\notes.png", covers["Text"], "a refused link stays as it was");
    }

    private static async Task<NendoApplicationService> ServiceAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Albums with covers",
        [
            new CreateEntityOperation("e-albums", Albums, "Albums", "albums"),
            new AddFieldOperation("f-title", Albums, "album.title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-cover", Albums, "album.cover", "Cover", "cover", NendoStorageKind.Text, false, NendoMedia.Presentation),
        ]));
        return new NendoApplicationService(coordinator);
    }

    private static Task CreateAsync(NendoApplicationService service, string id, string title, string? cover) =>
        service.CreateRecordAsync(new(Albums, id, new Dictionary<string, object?> { ["album.title"] = title, ["album.cover"] = cover }, Context(id)));

    private static async Task<Dictionary<string, string?>> CoversAsync(NendoApplicationService service) =>
        (await service.QueryRecordsAsync(new(Albums, 50))).Items.ToDictionary(
            record => record.Values["album.title"].GetString()!,
            record => record.Values.TryGetValue("album.cover", out var cover) && cover.ValueKind == System.Text.Json.JsonValueKind.String ? cover.GetString() : null);

    /// <summary>A PNG signature and IHDR, then filler: enough for the type and size to be read.</summary>
    private static byte[] Png(int width, int height, int length)
    {
        var bytes = new byte[Math.Max(length, 33)];
        new Random(width * 31 + height).NextBytes(bytes);
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(bytes, 0);
        bytes[8] = 0; bytes[9] = 0; bytes[10] = 0; bytes[11] = 13;
        "IHDR"u8.CopyTo(bytes.AsSpan(12));
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(16), (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(20), (uint)height);
        return bytes;
    }

    private static NendoRequestContext Context(string key) => new("csv-pictures-tests", key, "test");
}
