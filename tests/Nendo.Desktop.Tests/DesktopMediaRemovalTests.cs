using Microsoft.Data.Sqlite;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Removing unused pictures from History (ADR-0031 point 8): the host asks first, so a file
/// with nothing to remove gets no backup; otherwise it backs the file up beside itself and only
/// then removes what nothing names.
/// </summary>
[TestClass]
public sealed class DesktopMediaRemovalTests
{
    [TestMethod]
    public async Task TheHostBacksUpBesideTheFileBeforeRemovingAndNotWhenThereIsNothingToRemove()
    {
        await using var workspace = new DesktopTestWorkspace();
        var named = Png(8, 8, 50_000); var orphan = Png(9, 9, 80_000);
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "media-removal-test"))
            await coordinator.ApplyAsync(new NendoMutation("test", "picture", "test", "Embed a picture", [PutMediaOperation.FromContent("put", named)]));
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        string[] Backups() => Directory.GetFiles(folder, "* before removing pictures *.nendo");

        await using (var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot))
        {
            await session.OpenAsync(workspace.FilePath);
            Assert.AreEqual((1L, 0L), ((await session.ReadMediaUsageAsync()).Count, (await session.ReadMediaUsageAsync()).UnusedCount), "the put that embedded it names it");
            Assert.AreEqual("media-removal-nothing",
                (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.RemoveUnusedMediaAsync())).Code);
            Assert.IsEmpty(Backups(), "nothing to remove, so no backup");
        }

        // A picture nothing names, as folded history leaves one: stored while the file is closed.
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var insert = connection.CreateCommand();
            insert.CommandText = """
                INSERT INTO __nendo_media(sha256, media_type, byte_length, name, width, height) VALUES ($sha, 'image/png', $length, 'orphan.png', 9, 9);
                INSERT INTO __nendo_media_content(sha256, content) VALUES ($sha, $content);
                """;
            insert.Parameters.AddWithValue("$sha", NendoExtensionContent.Sha256(orphan));
            insert.Parameters.AddWithValue("$length", orphan.LongLength);
            insert.Parameters.AddWithValue("$content", orphan);
            await insert.ExecuteNonQueryAsync();
        }

        await using (var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot))
        {
            await session.OpenAsync(workspace.FilePath);
            var usage = await session.ReadMediaUsageAsync();
            Assert.AreEqual((2L, 1L, orphan.LongLength), (usage.Count, usage.UnusedCount, usage.UnusedBytes));
            var result = await session.RemoveUnusedMediaAsync();
            Assert.AreEqual((1L, orphan.LongLength), (result.Removed, result.RemovedBytes));
            var backup = Backups().Single();
            Assert.AreEqual(Path.GetFileName(backup), result.BackupLabel);
            Assert.AreEqual(404, (await session.ResolveMediaAsync("m/" + NendoExtensionContent.Sha256(orphan), "")).Status);
            Assert.AreEqual(200, (await session.ResolveMediaAsync("m/" + NendoExtensionContent.Sha256(named), "")).Status);
        }
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
}
