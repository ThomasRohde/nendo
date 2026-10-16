using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Media in user data, ADR-0031, pictures first (W-264). A media field is a Text field whose value
/// is an address; an embedded picture is stored once by its SHA-256, outside history, and every
/// path that writes a <c>media:</c> address is refused when the file does not hold the picture.
/// </summary>
[TestClass]
public sealed class MediaTests
{
    private const string Albums = "albums";
    private const string MediaLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-search-media-v1";

    [TestMethod]
    public void AddressesAreReadByOneGrammar()
    {
        var sha = new string('a', 64);
        foreach (var (value, source) in new (string, NendoMediaSource)[]
                 {
                     ("media:" + sha, NendoMediaSource.Embedded),
                     ("https://example.org/cover.jpg", NendoMediaSource.Web),
                     (@"C:\Pictures\cover.jpg", NendoMediaSource.LocalAbsolute),
                     ("D:/Music/Album 1/front.png", NendoMediaSource.LocalAbsolute),
                     (@".\Media\cover.jpg", NendoMediaSource.LocalRelative),
                     ("../Shared/logo.png", NendoMediaSource.LocalRelative),
                 })
        {
            Assert.IsTrue(NendoMediaAddress.TryParse(value, out var address), value);
            Assert.AreEqual(source, address!.Source, value);
        }
        foreach (var value in new[]
                 {
                     "", " media:" + sha, "media:" + sha.ToUpperInvariant(), "media:" + sha[..63],
                     "http://example.org/cover.jpg", "https://", "https://user:secret@example.org/a.png", "https://example.org/a b.png",
                     @"\\server\share\cover.jpg", "cover.jpg", @"Media\cover.jpg", @"C:\Pictures\", @"C:\Pic|tures\a.png",
                     @".\Media\..", "file:///C:/cover.jpg", "javascript:alert(1)",
                 })
            Assert.IsFalse(NendoMediaAddress.TryParse(value, out _), value);
    }

    [TestMethod]
    public void APictureIsKnownByItsFirstBytesAndItsSizeByItsHeader()
    {
        Assert.AreEqual("image/png", NendoMedia.Sniff(Png(640, 480, 64)));
        Assert.AreEqual((640, 480), NendoMedia.PictureSize("image/png", Png(640, 480, 64)));
        Assert.AreEqual("image/gif", NendoMedia.Sniff("GIF89a\x20\x03\x58\x02"u8.ToArray()));
        Assert.AreEqual((800, 600), NendoMedia.PictureSize("image/gif", "GIF89a\x20\x03\x58\x02"u8.ToArray()));
        Assert.AreEqual("image/jpeg", NendoMedia.Sniff(Jpeg(1024, 768)));
        Assert.AreEqual((1024, 768), NendoMedia.PictureSize("image/jpeg", Jpeg(1024, 768)));
        Assert.AreEqual("image/svg+xml", NendoMedia.Sniff("<?xml version=\"1.0\"?>\n<!-- a mark -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"u8.ToArray()));
        Assert.IsNull(NendoMedia.Sniff("<html><svg/></html>"u8.ToArray()));
        Assert.IsNull(NendoMedia.Sniff("MZ\x90\x00 an executable"u8.ToArray()));

        Assert.AreEqual("media-type-mismatch",
            Assert.ThrowsExactly<NendoPreconditionException>(() => PutMediaOperation.FromContent("op", Png(4, 4, 16), "image/jpeg")).Code);
        Assert.AreEqual("media-type-mismatch",
            Assert.ThrowsExactly<NendoPreconditionException>(() => PutMediaOperation.FromContent("op", "plain text"u8.ToArray())).Code);
    }

    [TestMethod]
    public async Task APutAndTheFieldThatNamesItAreOneRevisionAndRaiseTheLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await service.CreateRecordAsync(new(Albums, "a1", new Dictionary<string, object?> { ["album.title"] = "Blue" }, Context("a1")));
        var before = await service.GetSnapshotAsync();
        Assert.IsTrue(Version.Parse(before.Manifest.MinimumHostVersion) < Version.Parse(NendoFormat.MediaMinimumHostVersion) ||
            before.Manifest.MinimumHostVersion == NendoFormat.MediaMinimumHostVersion, "the media field itself states the host");

        var picture = Png(1200, 1200, 1024 * 1024);
        var put = await service.PutMediaAsync(new(picture, null, "front.png", Context("put"), new(Albums, "a1", "album.cover", 1)));
        Assert.AreEqual(NendoMediaAddress.Embedded(NendoExtensionContent.Sha256(picture)), put.Address);
        var record = await RecordAsync(service, "a1");
        Assert.AreEqual(put.Address, record.Values["album.cover"].GetString());
        Assert.AreEqual(2, record.RecordVersion, "one set, one revision");

        var item = await service.ReadMediaAsync(put.Address["media:".Length..]);
        Assert.AreEqual(new NendoMediaItem(put.Address["media:".Length..], "image/png", picture.Length, "front.png", 1200, 1200), item);
        CollectionAssert.AreEqual(picture, await service.ReadMediaContentAsync(item!.Sha256));
        Assert.AreEqual(NendoFormat.MediaMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        // The same bytes again are not stored twice.
        var again = await service.PutMediaAsync(new(picture, "image/png", "copy.png", Context("again")));
        Assert.AreEqual(put.Address, again.Address);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(MediaLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "unsupported-field-semantics"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        // History holds the hash and the field's address, never the picture.
        await using var sqlite = new SqliteConnection($"Data Source={workspace.FilePath};Mode=ReadOnly;Pooling=False");
        await sqlite.OpenAsync();
        await using (var rows = sqlite.CreateCommand())
        {
            rows.CommandText = "SELECT MAX(length(canonical_json) + length(inverse_evidence_json)) FROM __nendo_operation;";
            Assert.IsLessThan(4096L, (long)(await rows.ExecuteScalarAsync())!, "an operation row does not grow with the picture");
        }
        await using (var stored = sqlite.CreateCommand())
        {
            stored.CommandText = "SELECT COUNT(*) FROM __nendo_media_content;";
            Assert.AreEqual(1L, (long)(await stored.ExecuteScalarAsync())!);
        }
        sqlite.Close();
        SqliteConnection.ClearAllPools();

        coordinator = await workspace.OpenAsync();
        CollectionAssert.AreEqual(picture, await new NendoApplicationService(coordinator).ReadMediaContentAsync(item.Sha256));
    }

    [TestMethod]
    public async Task AFileThatNeverEmbedsKeepsItsLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await service.CreateRecordAsync(new(Albums, "a1", new Dictionary<string, object?>
        {
            ["album.title"] = "Linked", ["album.cover"] = "https://example.org/cover.jpg",
        }, Context("a1")));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.IsFalse((await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout!.Contains("-media-", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task EveryPathThatNamesAPictureTheFileDoesNotHoldIsRefusedAndNothingChanges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await service.CreateRecordAsync(new(Albums, "a1", new Dictionary<string, object?> { ["album.title"] = "Blue" }, Context("a1")));
        var absent = NendoMediaAddress.Embedded(new string('b', 64));
        var sequence = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;

        foreach (var (path, write) in new (string, Func<Task>)[]
                 {
                     ("create", () => service.CreateRecordAsync(new(Albums, "a2", new Dictionary<string, object?> { ["album.title"] = "x", ["album.cover"] = absent }, Context("c")))),
                     ("set", () => service.SetFieldAsync(new(Albums, "a1", "album.cover", 1, absent, Context("s")))),
                     ("form", () => service.SetFieldsAsync(new(Albums, "a1", 1, new Dictionary<string, object?> { ["album.title"] = "y", ["album.cover"] = absent }, Context("f")))),
                     ("batch", () => service.CreateRecordsAsync(new(Albums, [new("b1", new Dictionary<string, object?> { ["album.title"] = "b", ["album.cover"] = absent })], Context("b")))),
                 })
        {
            var refused = await Refused(write);
            Assert.AreEqual("media-missing", refused.Code, path);
            StringAssert.Contains(refused.Message, "Albums", path);
        }
        Assert.AreEqual(sequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence, "nothing was written");

        // Within one mutation the set may come before the put that it names.
        var picture = Png(8, 8, 128);
        var address = NendoMediaAddress.Embedded(NendoExtensionContent.Sha256(picture));
        await coordinator.ApplyAsync(new("test", "set-then-put", "test", "Set, then embed",
            [new SetFieldOperation("set-first", Albums, "a1", "album.cover", 1, address), PutMediaOperation.FromContent("put-second", picture)]));
        Assert.AreEqual(address, (await RecordAsync(service, "a1")).Values["album.cover"].GetString());
    }

    [TestMethod]
    public async Task AValueThatIsNotAnAddressIsRefusedOnAMediaFieldOnly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        foreach (var value in new[] { "", "cover.jpg", "http://example.org/a.png", @"\\nas\photos\a.jpg" })
        {
            var refused = await Refused(() => service.CreateRecordAsync(new(Albums, "x", new Dictionary<string, object?>
            {
                ["album.title"] = "x", ["album.cover"] = value,
            }, Context("bad-" + value.GetHashCode()))));
            Assert.AreEqual("media-address-invalid", refused.Code, value);
        }
        // The same text is fine in an ordinary text field.
        await service.CreateRecordAsync(new(Albums, "ok", new Dictionary<string, object?> { ["album.title"] = "cover.jpg", ["album.note"] = "http://example.org" }, Context("ok")));
    }

    [TestMethod]
    public async Task ATextFieldBecomesMediaOnlyWhileEveryValueIsAnAddress()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await service.CreateRecordAsync(new(Albums, "a1", new Dictionary<string, object?> { ["album.title"] = "a", ["album.note"] = "https://example.org/a.png" }, Context("a1")));
        await service.CreateRecordAsync(new(Albums, "a2", new Dictionary<string, object?> { ["album.title"] = "b", ["album.note"] = "liner notes" }, Context("a2")));

        var refused = await Refused(() => SetPresentationAsync(coordinator, "media", "p1"));
        Assert.AreEqual("media-address-invalid", refused.Code);
        StringAssert.Contains(refused.Message, "Albums a2");
        Assert.IsFalse(refused.Message.Contains("liner", StringComparison.Ordinal), "a refusal names records, never stored text");

        await service.SetFieldAsync(new(Albums, "a2", "album.note", 1, null, Context("clear")));
        await SetPresentationAsync(coordinator, "media", "p2");
        Assert.AreEqual("media", (await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == Albums).Fields.Single(f => f.FieldId == "album.note").Presentation);
        await SetPresentationAsync(coordinator, "longText", "p3");
    }

    [TestMethod]
    public async Task UndoingAPutAndItsSetGivesTheFieldBackAndKeepsThePicture()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await service.CreateRecordAsync(new(Albums, "a1", new Dictionary<string, object?> { ["album.title"] = "Blue", ["album.cover"] = "https://example.org/old.jpg" }, Context("a1")));
        var picture = Png(16, 16, 256);
        var put = await service.PutMediaAsync(new(picture, null, "new.png", Context("put"), new(Albums, "a1", "album.cover", 1)));

        await service.CompensateRevisionAsync(put.Result.RevisionId, "undo-put");
        Assert.AreEqual("https://example.org/old.jpg", (await RecordAsync(service, "a1")).Values["album.cover"].GetString());
        CollectionAssert.AreEqual(picture, await service.ReadMediaContentAsync(NendoExtensionContent.Sha256(picture)), "the picture stays until unused media is removed");

        var alone = await service.PutMediaAsync(new(Png(2, 2, 32), null, null, Context("alone")));
        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(alone.Result.RevisionId, "undo-alone"));
        StringAssert.Contains(refused.Message, "only embedded a picture");
    }

    [TestMethod]
    public async Task OneChangeEmbedsAtMostOnePicturesWorth()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var half = (int)(NendoMedia.MaximumItemBytes / 2) + 1;
        var refused = await Refused(() => coordinator.ApplyAsync(new("test", "two", "test", "Two large pictures",
            [PutMediaOperation.FromContent("p1", Png(4, 4, half)), PutMediaOperation.FromContent("p2", Png(5, 5, half))])));
        Assert.AreEqual("media-too-large", refused.Code);
        Assert.AreEqual("media-too-large", Assert.ThrowsExactly<NendoPreconditionException>(() =>
            PutMediaOperation.FromContent("big", Png(4, 4, (int)NendoMedia.MaximumItemBytes + 1))).Code);
    }

    [TestMethod]
    public async Task AFileWhosePicturesPassTheOpenBoundStillOpensAndIsCheckedWithoutThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        // Five 60 MiB pictures: the file passes 256 MiB, all of it media content.
        for (var index = 0; index < 5; index++)
            await service.PutMediaAsync(new(Png(100 + index, 100, 60 * 1024 * 1024), null, $"p{index}.png", Context("big" + index)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.IsGreaterThan(Nendo.Engine.Storage.SqliteNendoStore.MaximumInspectionFileBytes, new FileInfo(workspace.FilePath).Length);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(MediaLayout, inspection.Layout, string.Join("; ", inspection.Findings.Select(finding => finding.Code + ": " + finding.Message)));
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        await service.CreateRecordAsync(new(Albums, "after", new Dictionary<string, object?> { ["album.title"] = "still writable" }, Context("after")));
        Assert.AreEqual("ok", (await service.VerifyIntegrityAsync()).IntegrityResult);
    }

    [TestMethod]
    public async Task TheExplicitIntegrityCheckHashesEveryPictureThatOpeningDoesNotRead()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var picture = Png(8, 8, 4096);
        await service.PutMediaAsync(new(picture, null, null, Context("put")));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // A changed byte that SQLite's own pages still agree with.
        await using (var sqlite = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await sqlite.OpenAsync();
            await using var change = sqlite.CreateCommand();
            change.CommandText = "UPDATE __nendo_media_content SET content = zeroblob(length(content));";
            await change.ExecuteNonQueryAsync();
        }
        SqliteConnection.ClearAllPools();

        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        var refused = await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.VerifyIntegrityAsync());
        StringAssert.Contains(refused.Message, NendoMediaAddress.Embedded(NendoExtensionContent.Sha256(picture)));
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "Albums with covers",
        [
            new CreateEntityOperation("e-albums", Albums, "Albums", "albums"),
            new AddFieldOperation("f-title", Albums, "album.title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-cover", Albums, "album.cover", "Cover", "cover", NendoStorageKind.Text, false, NendoMedia.Presentation),
            new AddFieldOperation("f-note", Albums, "album.note", "Note", "note", NendoStorageKind.Text, false),
        ]));

    private static async Task SetPresentationAsync(NendoWriteCoordinator coordinator, string presentation, string key)
    {
        var revision = (await new NendoApplicationService(coordinator).GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", key, "test", "Show the note another way",
            [new SetFieldPresentationOperation("op-" + key, Albums, "album.note", presentation, revision)]));
    }

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

    /// <summary>A JPEG start, an APP0 segment and a baseline frame header.</summary>
    private static byte[] Jpeg(int width, int height) =>
    [
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        0xFF, 0xC0, 0x00, 0x11, 0x08, (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    ];

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Albums, 1) { RecordId = id })).Items.Single();

    private static NendoRequestContext Context(string key) => new("media-tests", key, "test");

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);
}
