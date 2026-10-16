using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// Removing unused pictures (ADR-0031 point 8, W-273): a picture a current value, a deleted record
/// or a retained operation names is never removed; one only folded history named is removed after
/// the fold, behind a backup made first; and the file's size falls by what was removed.
/// </summary>
[TestClass]
public sealed class MediaRemovalTests
{
    private const string Albums = "albums";
    private static readonly SqliteNendoStore.HistoryFoldPolicy Small = new(5, 1_000, 2);

    [TestMethod]
    public async Task OnlyAPictureNothingNamesIsRemovedAfterABackupAndTheFileShrinksByIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        coordinator.HistoryFoldPolicy = Small;
        await coordinator.ApplyAsync(new("test", "schema", "test", "Albums with covers",
        [
            new CreateEntityOperation("e-albums", Albums, "Albums", "albums"),
            new AddFieldOperation("f-title", Albums, "album.title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-cover", Albums, "album.cover", "Cover", "cover", NendoStorageKind.Text, false, NendoMedia.Presentation),
        ]));
        var current = Png(10, 10, 300_000); var folded = Png(20, 20, 2 * 1024 * 1024);
        var deleted = Png(30, 30, 200_000); var retained = Png(40, 40, 100_000);

        // Early, and folded later: a picture still a value, one cleared, and one on a deleted record.
        await CreateAsync(service, "a1"); await PutAsync(service, "a1", current, 1);
        await CreateAsync(service, "a3"); await PutAsync(service, "a3", folded, 1);
        await service.SetFieldAsync(new(Albums, "a3", "album.cover", 2, null, Context("clear-a3")));
        await CreateAsync(service, "a4"); await PutAsync(service, "a4", deleted, 1);
        await service.DeleteRecordAsync(new(Albums, "a4", 2, Context("delete-a4")));
        for (var index = 0; index < 12; index++) await CreateAsync(service, $"filler-{index}");
        // Late, and kept by the fold: a picture cleared, whose undo still needs it.
        await CreateAsync(service, "a2"); await PutAsync(service, "a2", retained, 1);
        await service.SetFieldAsync(new(Albums, "a2", "album.cover", 2, null, Context("clear-a2")));

        var usage = await service.ReadMediaUsageAsync();
        Assert.AreEqual((4L, 0L, 0L), (usage.Count, usage.UnusedCount, usage.UnusedBytes), "every picture is named while its history is kept");
        Assert.AreEqual(NendoMedia.MaximumFileBytes, usage.BudgetBytes);
        Assert.AreEqual("media-removal-needs-backup",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.RemoveUnusedMediaAsync("no-such-backup"))).Code);
        var early = await BackupAsync(coordinator, workspace, "before-anything");
        Assert.AreEqual("media-removal-nothing",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.RemoveUnusedMediaAsync(early))).Code);

        await service.FoldHistoryAsync(await BackupAsync(coordinator, workspace, "before-fold"));
        usage = await service.ReadMediaUsageAsync();
        Assert.AreEqual((1L, (long)folded.Length), (usage.UnusedCount, usage.UnusedBytes), "only the picture folded history alone named is unused");
        Assert.AreEqual("media-removal-backup-stale",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.RemoveUnusedMediaAsync(early))).Code, "a backup from before the fold");

        var backupPath = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-removal.nendo");
        var plan = await coordinator.PrepareBackupAsync(backupPath, "before-removal");
        await coordinator.CreateBackupAsync(plan.PlanId);
        var result = await service.RemoveUnusedMediaAsync(plan.PlanId);

        Assert.AreEqual((1L, (long)folded.Length, "before-removal.nendo"), (result.Removed, result.RemovedBytes, result.BackupLabel));
        Assert.IsTrue(result.SpaceReclaimed);
        Assert.IsNull(await service.ReadMediaAsync(NendoExtensionContent.Sha256(folded)));
        foreach (var kept in new[] { current, deleted, retained })
            CollectionAssert.AreEqual(kept, await service.ReadMediaContentAsync(NendoExtensionContent.Sha256(kept)));
        // The file's own size, by its pages: down by the picture, give or take the pages around it.
        var fell = result.FileBytesBefore - result.FileBytesAfter;
        Assert.IsTrue(fell >= folded.Length && fell < folded.Length + 256 * 1024,
            $"The file fell by {fell:N0} bytes for {folded.Length:N0} removed ({result.FileBytesBefore:N0} to {result.FileBytesAfter:N0}).");
        Assert.AreEqual(0L, (await service.ReadMediaUsageAsync()).UnusedCount);

        // The backup, made before anything was removed, still holds it. It is the same instance, so
        // the file closes first.
        workspace.Forget(coordinator);
        await coordinator.DisposeAsync();
        await using var backup = await NendoWriteCoordinator.OpenAsync(backupPath, "backup-reader");
        CollectionAssert.AreEqual(folded, await new NendoApplicationService(backup).ReadMediaContentAsync(NendoExtensionContent.Sha256(folded)));
    }

    private static async Task<string> BackupAsync(NendoWriteCoordinator coordinator, EngineTestWorkspace workspace, string name)
    {
        var plan = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, name + ".nendo"), name);
        await coordinator.CreateBackupAsync(plan.PlanId);
        return plan.PlanId;
    }

    private static Task CreateAsync(NendoApplicationService service, string id) =>
        service.CreateRecordAsync(new(Albums, id, new Dictionary<string, object?> { ["album.title"] = id }, Context(id)));

    private static Task PutAsync(NendoApplicationService service, string id, byte[] picture, long version) =>
        service.PutMediaAsync(new(picture, null, id + ".png", Context("put-" + id), new(Albums, id, "album.cover", version)));

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

    private static NendoRequestContext Context(string key) => new("media-removal-tests", key, "test");
}
