using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// A file's own picture as its icon (ADR-0004): a square PNG the
/// file embeds, named by a row in its own protected table on the rung above media, drawn instead
/// of the tone and letter, and kept by everything that keeps the file's pictures.
/// </summary>
[TestClass]
public sealed class ApplicationIconTests
{
    private const string IconLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-search-media-icon-v1";

    private const string Albums = "albums";

    [TestMethod]
    public async Task AChosenIconIsStoredReadBackAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var icon = await PutAsync(service, Png(256, 256, 4_000), "icon");

        await SetIconAsync(coordinator, service, icon, "choose");
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoApplicationLook(null, null, icon), after.Manifest.Look);
        Assert.AreEqual(NendoFormat.ApplicationIconMinimumHostVersion, after.Manifest.MinimumHostVersion);
        var resolved = NendoLook.Resolve(after.Manifest.ApplicationId, "Albums.nendo", after.Manifest.Look);
        Assert.AreEqual(icon, resolved.Icon, "The drawn look carries the picture.");
        Assert.AreEqual("A", resolved.Letter, "The tone and letter stay, for when the picture is taken away.");

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(IconLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding =>
            finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        Assert.AreEqual(new NendoApplicationLook(null, null, icon), (await service.GetSnapshotAsync()).Manifest.Look);

        // The tone and letter are their own choice, beside the picture.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "look", "test", "And a tone", [new SetApplicationLookOperation("l", "violet", null, revision)]));
        Assert.AreEqual(new NendoApplicationLook("violet", null, icon), (await service.GetSnapshotAsync()).Manifest.Look);
    }

    /// <summary>
    /// A colour and a picture in one mutation apply together. About this file sends them as two
    /// mutations of one proposal, so each revision stays undoable on its own.
    /// </summary>
    [TestMethod]
    public async Task AColourAndAPictureCanBeChosenInOneMutation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var icon = await PutAsync(service, Png(256, 256, 2_000), "icon");
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "both", "test", "Give this file its own icon",
        [
            new SetApplicationLookOperation("look", "teal", null, revision),
            new SetApplicationIconOperation("icon", icon, revision),
        ]));
        Assert.AreEqual(new NendoApplicationLook("teal", null, icon), (await service.GetSnapshotAsync()).Manifest.Look);
    }

    /// <summary>
    /// The proposal About this file sends for a colour and a picture: two mutations, the second at
    /// the revision the first leaves. It is reviewed with the picture in lookAfter, accepted, and
    /// the picture, the later revision, is undone without the colour.
    /// </summary>
    [TestMethod]
    public async Task TheAboutPagesProposalIsReviewedAcceptedAndThePictureUndoneAlone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var icon = await PutAsync(service, Png(256, 256, 2_500), "icon");
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        using var look = System.Text.Json.JsonDocument.Parse($$"""{"tone":"teal","letter":null,"expectedDefinitionRevision":{{revision}}}""");
        using var picture = System.Text.Json.JsonDocument.Parse($$"""{"icon":"{{icon}}","expectedDefinitionRevision":{{revision + 1}}}""");
        var preview = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Give this file its own icon", "test", new NendoCanonicalChangeSetRequest([
                new NendoCanonicalMutationRequest("look-key", "proposal-look", "test", "Give this file its own icon",
                    [new NendoCanonicalOperationRequest("op-look", "application.setLook", look.RootElement.Clone())]),
                new NendoCanonicalMutationRequest("icon-key", "proposal-icon", "test", "Give this file its own icon",
                    [new NendoCanonicalOperationRequest("op-icon", "application.setIcon", picture.RootElement.Clone())]),
            ])));
        Assert.AreEqual(new NendoApplicationLook("teal", null, icon), preview.LookAfter);
        Assert.IsNull(preview.LookBefore);
        Assert.IsTrue(preview.SemanticDiff.Any(entry => entry.Summary == "Give this file its own picture as its icon."));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        Assert.AreEqual(new NendoApplicationLook("teal", null, icon), (await service.GetSnapshotAsync()).Manifest.Look);

        var latest = (await service.GetHistoryAsync()).MaxBy(entry => entry.ChangeSequence)!;
        await service.CompensateRevisionAsync(latest.RevisionId, "undo-picture");
        Assert.AreEqual(new NendoApplicationLook("teal", null), (await service.GetSnapshotAsync()).Manifest.Look, "the picture is undone alone");
    }

    [TestMethod]
    public async Task TakingThePictureAwayKeepsTheRungAndTheStatedHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SetIconAsync(coordinator, service, await PutAsync(service, Png(64, 64, 900), "icon"), "choose");
        await SetIconAsync(coordinator, service, null, "away");

        var after = await service.GetSnapshotAsync();
        Assert.IsNull(after.Manifest.Look, "A file with neither a picture nor a chosen tone or letter carries no look.");
        Assert.AreEqual(NendoFormat.ApplicationIconMinimumHostVersion, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual(IconLayout, (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout);
    }

    /// <summary>Taking away a picture nobody chose takes no rung, for the look's reason.</summary>
    [TestMethod]
    public async Task TakingAwayAPictureNobodyChoseTakesNoRung()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SetIconAsync(coordinator, service, null, "away");
        Assert.AreEqual(NendoFormat.MinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual("production-semantic-v1", (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout);
    }

    [TestMethod]
    public async Task ChoosingAPictureCanBeCompensatedBackToTheOneBefore()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var first = await PutAsync(service, Png(32, 32, 500), "first");
        var second = await PutAsync(service, Png(48, 48, 600), "second");
        await SetIconAsync(coordinator, service, first, "first");
        var changed = await SetIconAsync(coordinator, service, second, "second");

        await service.CompensateRevisionAsync(changed.RevisionId, "undo-icon");
        Assert.AreEqual(first, (await service.GetSnapshotAsync()).Manifest.Look?.Icon);
    }

    [TestMethod]
    public async Task OnlyASquarePngWithinTheBoundsTheFileHoldsCanBeAnIcon()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        var missing = NendoMediaAddress.Embedded(new string('a', 64));
        Assert.AreEqual("media-missing", (await Refused(() => SetIconAsync(coordinator, service, missing, "missing"))).Code);

        async Task<string> RefusalAsync(byte[] picture, string key) =>
            (await Refused(() => SetIconAsync(coordinator, service, PutAsync(service, picture, key).Result, key))).Message;
        StringAssert.Contains(await RefusalAsync(Jpeg(64, 64), "jpeg"), "is a PNG, and this picture is image/jpeg");
        StringAssert.Contains(await RefusalAsync(Png(64, 32, 600), "wide"), "is square, and this picture is 64 by 32 pixels");
        StringAssert.Contains(await RefusalAsync(Png(8, 8, 600), "tiny"), "16 to 1024 pixels a side, and this picture is 8");
        StringAssert.Contains(await RefusalAsync(Png(2048, 2048, 600), "huge"), "16 to 1024 pixels a side, and this picture is 2048");
        StringAssert.Contains(await RefusalAsync(Png(256, 256, 1024 * 1024 + 1), "heavy"), "holds at most 1024 KiB");

        var after = await service.GetSnapshotAsync();
        Assert.IsNull(after.Manifest.Look, "A refused icon writes nothing.");
        Assert.AreEqual(NendoFormat.MediaMinimumHostVersion, after.Manifest.MinimumHostVersion);

        foreach (var address in new[] { "https://example.org/icon.png", @"C:\icons\a.png", "media:short" })
        {
            var refusal = Assert.ThrowsExactly<NendoValidationException>(() => new SetApplicationIconOperation("i", address, 0));
            StringAssert.StartsWith(refusal.Message, "A file's icon is a picture embedded in the file");
        }
    }

    /// <summary>
    /// The icon's picture is in use (ADR-0031 point 8): once history no longer names it, only the
    /// icon row does, and removing unused media must keep it.
    /// </summary>
    [TestMethod]
    public async Task RemovingUnusedMediaKeepsTheIconOnceHistoryNoLongerNamesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        coordinator.HistoryFoldPolicy = new SqliteNendoStore.HistoryFoldPolicy(5, 1_000, 2);
        await SchemaAsync(coordinator);
        var picture = Png(128, 128, 3_000);
        var icon = await PutAsync(service, picture, "icon");
        await SetIconAsync(coordinator, service, icon, "choose");
        await PutAsync(service, Png(20, 20, 2_000), "stray");
        for (var index = 0; index < 12; index++)
            await service.CreateRecordAsync(new(Albums, $"filler-{index}", new Dictionary<string, object?> { ["album.title"] = $"{index}" }, Context($"filler-{index}")));

        await service.FoldHistoryAsync(await BackupAsync(coordinator, workspace, "before-fold"));
        var usage = await service.ReadMediaUsageAsync();
        Assert.AreEqual(1L, usage.UnusedCount, "Only the stray picture is unused; the icon is named by its row.");
        await service.RemoveUnusedMediaAsync(await BackupAsync(coordinator, workspace, "before-removal"));

        CollectionAssert.AreEqual(picture, await service.ReadMediaContentAsync(NendoExtensionContent.Sha256(picture)));
        Assert.AreEqual(icon, (await service.GetSnapshotAsync()).Manifest.Look?.Icon);
        Assert.AreEqual("ok", (await service.VerifyIntegrityAsync()).IntegrityResult);
    }

    [TestMethod]
    public async Task ANewFileKeepsTheIconWithTheLook()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var picture = Png(96, 96, 1_500);
        var icon = await PutAsync(service, picture, "icon");
        await SetIconAsync(coordinator, service, icon, "choose");

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "fresh.nendo");
        await service.CreateNewFileAsync(destination, "new-icon");
        await using var opened = await NendoWriteCoordinator.OpenAsync(destination, "test-new");
        var fresh = new NendoApplicationService(opened);
        Assert.AreEqual(icon, (await fresh.GetSnapshotAsync()).Manifest.Look?.Icon);
        CollectionAssert.AreEqual(picture, await fresh.ReadMediaContentAsync(NendoExtensionContent.Sha256(picture)));
        Assert.AreEqual("ok", (await fresh.VerifyIntegrityAsync()).IntegrityResult);
    }

    /// <summary>
    /// An icon row that names a picture that cannot be an icon is refused at open as drift, rather
    /// than drawn wrong: the inspection checks the row against the media it names.
    /// </summary>
    [TestMethod]
    public async Task AnIconRowNamingAPictureThatCannotBeOneIsDriftAtOpen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SetIconAsync(coordinator, service, await PutAsync(service, Png(64, 64, 700), "icon"), "choose");
        var jpeg = NendoExtensionContent.Sha256(Jpeg(64, 64));
        await PutAsync(service, Jpeg(64, 64), "jpeg");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_application_icon SET sha256 = $sha;";
            command.Parameters.AddWithValue("$sha", jpeg);
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(inspection.Findings.Any(finding => finding.Code == "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
    }

    [TestMethod]
    public void TheDiffSaysChoosingAndTakingAwayInAPersonsWords()
    {
        var chosen = SemanticDiff.From(ChangeSet(new SetApplicationIconOperation("i", NendoMediaAddress.Embedded(new string('b', 64)), 0)), Active());
        Assert.AreEqual("setApplicationIcon", chosen[0].Kind);
        Assert.AreEqual("Give this file its own picture as its icon.", chosen[0].Summary);
        var away = SemanticDiff.From(ChangeSet(new SetApplicationIconOperation("i", null, 0)), Active());
        Assert.AreEqual("Take this file's picture away, so it shows its colour and letter again.", away[0].Summary);
    }

    [TestMethod]
    public void ACanonicalChangeSetCarriesTheIcon()
    {
        var address = NendoMediaAddress.Embedded(new string('c', 64));
        var operation = (SetApplicationIconOperation)CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
            "i", "application.setIcon", System.Text.Json.JsonDocument.Parse($$"""{"icon":"{{address}}","expectedDefinitionRevision":4}""").RootElement));
        Assert.AreEqual((address, 4L), (operation.Icon, operation.ExpectedDefinitionRevision));
    }

    private static async Task<NendoApplyResult> SetIconAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string? icon, string key)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", "icon-" + key, "test", "Give the file its own picture",
            [new SetApplicationIconOperation("i-" + key, icon, revision)]));
    }

    private static async Task<string> PutAsync(NendoApplicationService service, byte[] picture, string key) =>
        (await service.PutMediaAsync(new(picture, null, key + ".png", Context("put-" + key)))).Address;

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "Albums",
        [
            new CreateEntityOperation("e-albums", Albums, "Albums", "albums"),
            new AddFieldOperation("f-title", Albums, "album.title", "Title", "title", NendoStorageKind.Text, true),
        ]));

    private static async Task<string> BackupAsync(NendoWriteCoordinator coordinator, EngineTestWorkspace workspace, string name)
    {
        var plan = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, name + ".nendo"), name);
        await coordinator.CreateBackupAsync(plan.PlanId);
        return plan.PlanId;
    }

    /// <summary>A PNG signature and IHDR, then filler: enough for the type and size to be read.</summary>
    private static byte[] Png(int width, int height, int length)
    {
        var bytes = new byte[Math.Max(length, 33)];
        new Random(width * 31 + height + length).NextBytes(bytes);
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

    private static NendoChangeSet ChangeSet(params NendoOperation[] operations) => new(
    [
        new NendoMutation("icon-diff", "diff-definition", "test", "Give the file its own picture", operations),
    ]);

    private static NendoSessionSnapshot Active()
    {
        var now = new DateTimeOffset(2026, 10, 19, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "albums.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.SemanticMinimumHostVersion,
                "application-test", "instance-test", now, now, 1, 0, 1),
            [],
            [],
            [],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoRequestContext Context(string key) => new("application-icon-tests", key, "test");

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);
}
