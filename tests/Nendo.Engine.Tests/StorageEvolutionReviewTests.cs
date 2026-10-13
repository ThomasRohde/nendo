using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// The broad review's storage, schema evolution and reversibility findings (W-212): each guard
/// measures the defect it names and was seen to fail with that defect put back.
/// </summary>
[TestClass]
public sealed class StorageEvolutionReviewTests
{
    private const int InterruptedRecords = 300;

    /// <summary>
    /// What the child process runs for ESC-01: a large import stopped inside its write
    /// transaction, after SQLite has spilled pages into the file and before COMMIT.
    /// </summary>
    internal static async Task InterruptedWriteAsync(NendoWriteCoordinator coordinator)
    {
        coordinator.BeforeCommitAuthorityRead = () =>
        {
            Console.WriteLine("BEFORE-COMMIT");
            Console.Out.Flush();
            Thread.Sleep(Timeout.Infinite);
        };
        var body = new string('x', 16_000);
        await coordinator.ApplyAsync(new("test", "interrupted", "test", "Interrupted import",
            Enumerable.Range(0, InterruptedRecords).Select(index => (NendoOperation)new CreateRecordOperation(
                $"interrupted-{index}", "notes", $"late-{index}", new Dictionary<string, object?> { ["notes.body"] = body })).ToArray()));
    }

    private static async Task NotesFileAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("notes-body", "notes", "notes.body", "Body", "body", NendoStorageKind.Text, false, "longText"),
        ]));
        await coordinator.ApplyAsync(new("test", "first", "test", "First", [
            new CreateRecordOperation("first", "notes", "early", new Dictionary<string, object?> { ["notes.body"] = "kept" })]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
    }

    private static SqliteConnection Raw(string path)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        connection.Open();
        return connection;
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// What a Nendo write touches: its manifest (a real change, since SQLite writes no page for a
    /// row it would store unchanged), then a large value that spills pages into the file.
    /// </summary>
    private const string NendoWrite = "UPDATE __nendo_manifest SET change_sequence = change_sequence + 1; UPDATE notes SET body = @body;";

    /// <summary>Starts a write on <paramref name="connection"/> that has spilled pages into the file and left its journal.</summary>
    private static SqliteTransaction SpilledWrite(SqliteConnection connection, string sql = NendoWrite)
    {
        Execute(connection, "PRAGMA cache_size = 8;");
        var transaction = connection.BeginTransaction(deferred: false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.Parameters.AddWithValue("@body", new string('y', 400_000));
        command.ExecuteNonQuery();
        return transaction;
    }

    /// <summary>
    /// The pair a crash leaves, made without a crash: the file and its journal copied while a write
    /// that has spilled pages is still open on <paramref name="source"/>, so no one holds the copy's journal.
    /// </summary>
    private static async Task CrashedCopyAsync(string source, string destination, string sql = NendoWrite)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        using var connection = Raw(source);
        using var transaction = SpilledWrite(connection, sql);
        await File.WriteAllBytesAsync(destination, await ObservedFile.ReadAllBytesAsync(source));
        await File.WriteAllBytesAsync(destination + "-journal", await ObservedFile.ReadAllBytesAsync(source + "-journal"));
        transaction.Rollback();
    }

    /// <summary>A SQLite file that is not a Nendo file, with an application ID of its choosing and a value naming an instance.</summary>
    private static void ForeignFile(string path, int applicationId)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = path.Replace("ideas.nendo", "seed.db", StringComparison.Ordinal), Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false }.ToString());
        connection.Open();
        Execute(connection, $"PRAGMA journal_mode = DELETE; PRAGMA application_id = {applicationId}; CREATE TABLE notes(body TEXT); " +
            "INSERT INTO notes VALUES ('instance-0123456789abcdef0123456789abcdef');");
        connection.Close();
        File.Move(path.Replace("ideas.nendo", "seed.db", StringComparison.Ordinal), path);
    }

    private static string[] FilesBeside(string path) =>
        Directory.GetFiles(Path.GetDirectoryName(path)!).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray()!;

    /// <summary>An observation the person asked for: they opened this file themselves, outside a synced folder.</summary>
    private static Task<NendoFileObservation> OpenedAsync(string path) =>
        NendoWriteCoordinator.ObserveAsync(path, NendoInterruptedWrite.RollBack);

    private static async Task AssertRefusedUntouchedAsync(string path, string expected, string why,
        NendoInterruptedWrite interruptedWrite = NendoInterruptedWrite.RollBack)
    {
        var main = await File.ReadAllBytesAsync(path);
        var journal = await File.ReadAllBytesAsync(path + "-journal");
        var observed = await NendoWriteCoordinator.ObserveAsync(path, interruptedWrite);
        Assert.AreEqual(expected, string.Join(" | ", observed.Inspection.Findings.Select(finding => finding.Message)), why);
        Assert.IsFalse(observed.Inspection.Capabilities.ReadData);
        CollectionAssert.AreEqual(main, await File.ReadAllBytesAsync(path), $"{why} The file was changed.");
        CollectionAssert.AreEqual(journal, await File.ReadAllBytesAsync(path + "-journal"), $"{why} The journal was changed.");
        CollectionAssert.AreEqual(new[] { "ideas.nendo", "ideas.nendo-journal" }, FilesBeside(path), $"{why} A copy was left beside it.");
    }

    /// <summary>After a playback: the file reads, the journal is gone, and the file as it was is kept, exactly, and named.</summary>
    private static void AssertKeptExactly(string path, NendoFileInspection inspection, byte[] main, byte[] journal, string why)
    {
        var held = SqliteNendoStore.HeldStages(path);
        Assert.HasCount(1, held, $"{why} The file as it was before the playback was not kept.");
        CollectionAssert.AreEqual(main, File.ReadAllBytes(held[0]), $"{why} The kept file is not the file as it was before the playback.");
        CollectionAssert.AreEqual(journal, File.ReadAllBytes(held[0] + ".journal"), $"{why} The kept journal is not the journal as it was.");
        Assert.AreEqual(SqliteNendoStore.HeldStageFinding(held[0]), inspection.Findings.LastOrDefault(), $"{why} The inspection did not name the kept copy.");
        Assert.IsFalse(File.Exists(path + "-journal"), $"{why} The journal is still beside the file.");
    }

    private static uint ChangeCounter(byte[] file) => System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(file.AsSpan(24));

    [TestMethod]
    public async Task ESC01_AWriteKilledBeforeCommitIsRolledBackWhenThePersonOpensTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var committed = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        using (var child = StartChild(workspace.FilePath, "Interrupt"))
        {
            try
            {
                var signal = await child.StandardOutput.ReadLineAsync().WithinAsync(TestWaits.ChildStart, "the child's first line");
                if (signal != "BEFORE-COMMIT")
                    Assert.Fail($"Interrupt child missed its seam: {signal}; {await child.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5))}");
                Assert.IsTrue(File.Exists(workspace.FilePath + "-journal"), "The write in progress has no journal.");
            }
            finally
            {
                if (!child.HasExited) child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        await RestoreInterruptionTests.AssertExitedWriterReleasedAsync(workspace.FilePath);
        Assert.IsTrue(File.Exists(workspace.FilePath + "-journal"), "The killed writer left no journal, so nothing here was interrupted.");
        var crashed = await ObservedFile.ReadAllBytesAsync(workspace.FilePath);
        var journal = await ObservedFile.ReadAllBytesAsync(workspace.FilePath + "-journal");
        CollectionAssert.AreNotEqual(before, crashed, "The killed write changed no page of the file, so the journal had nothing to roll back.");

        // An observation the person did not ask for leaves it alone.
        await LingeringHandle.OpenAsync(workspace.FilePath, () => NendoWriteCoordinator.ObserveAsync(workspace.FilePath));
        await AssertRefusedUntouchedAsync(workspace.FilePath, SqliteNendoStore.JournalOpenToRollBackText,
            "An observation the person did not ask for rolled the file back.", NendoInterruptedWrite.Refuse);

        var observed = await OpenedAsync(workspace.FilePath);
        Assert.IsTrue(observed.Inspection.CanAcquireWriteAuthority,
            "A write killed before COMMIT left the file refused: " + string.Join("; ", observed.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
        Assert.HasCount(1, observed.Inspection.Findings, string.Join("; ", observed.Inspection.Findings.Select(finding => finding.Code)));
        AssertKeptExactly(workspace.FilePath, observed.Inspection, crashed, journal, "A killed write was rolled back.");
        Assert.AreEqual(committed.Manifest, observed.Inspection.Manifest, "The rolled-back file is not the file as it was last committed.");

        var reopened = await workspace.OpenAsync();
        var records = (await new NendoApplicationService(reopened).GetSnapshotAsync()).Records;
        Assert.AreEqual("early", records.Single().RecordId, "The records are not the ones last committed.");
    }

    [TestMethod]
    public async Task ESC01_AJournalAProgramStillHoldsIsLeftAlone()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        using var connection = Raw(workspace.FilePath);
        using (var transaction = SpilledWrite(connection))
        {
            var main = await ObservedFile.ReadAllBytesAsync(workspace.FilePath);
            var journal = await ObservedFile.ReadAllBytesAsync(workspace.FilePath + "-journal");
            var observed = await OpenedAsync(workspace.FilePath);
            Assert.AreEqual(NendoOpenClassification.RecoveryRequired, observed.Inspection.Classification);
            // A writer that has spilled pages holds the file to itself, so SQLite answers busy.
            Assert.AreEqual(SqliteNendoStore.JournalBusyText, observed.Inspection.Findings.Single().Message,
                "A file another program is writing was not refused as such.");
            CollectionAssert.AreEqual(main, await ObservedFile.ReadAllBytesAsync(workspace.FilePath), "A file another program is writing was changed.");
            CollectionAssert.AreEqual(journal, await ObservedFile.ReadAllBytesAsync(workspace.FilePath + "-journal"), "Its journal was changed.");
            CollectionAssert.AreEqual(new[] { "ideas.nendo", "ideas.nendo-journal" }, FilesBeside(workspace.FilePath), "A copy was left behind.");
            transaction.Rollback();
        }
        Assert.IsTrue((await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).CanAcquireWriteAuthority);
    }

    [TestMethod]
    public async Task ESC01_AJournalAnotherCoordinatorOwnsIsLeftAloneAndPlayedBackOnceItIsFree()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "crashed", "ideas.nendo");
        var committed = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        await CrashedCopyAsync(workspace.FilePath, crashed);
        var main = await File.ReadAllBytesAsync(crashed);
        var journal = await File.ReadAllBytesAsync(crashed + "-journal");
        using (WriteOwnershipLease.Acquire(crashed, "another-window"))
        {
            var held = await OpenedAsync(crashed);
            Assert.AreEqual(SqliteNendoStore.JournalAnotherWindowText, held.Inspection.Findings.SingleOrDefault()?.Message,
                "A file another coordinator owns was rolled back.");
            CollectionAssert.AreEqual(main, await File.ReadAllBytesAsync(crashed), "A file another coordinator owns was rolled back.");
        }
        var free = await OpenedAsync(crashed);
        Assert.IsTrue(free.Inspection.CanAcquireWriteAuthority, string.Join("; ", free.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
        Assert.AreEqual(committed.Manifest, free.Inspection.Manifest);
        AssertKeptExactly(crashed, free.Inspection, main, journal, "A free crashed copy was rolled back.");
    }

    /// <summary>A backup restored over a crashed file, its old journal left beside it: the journal is another file's.</summary>
    [TestMethod]
    public async Task ESC01_AJournalWrittenForAnotherFileIsRefusedUntouched()
    {
        await using var first = new EngineTestWorkspace();
        await NotesFileAsync(first);
        await using var second = new EngineTestWorkspace();
        await NotesFileAsync(second);
        var crashed = Path.Combine(Path.GetDirectoryName(first.FilePath)!, "restored", "ideas.nendo");
        await CrashedCopyAsync(second.FilePath, crashed);
        await File.WriteAllBytesAsync(crashed, await File.ReadAllBytesAsync(first.FilePath));
        await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalMismatchText,
            "Another file's journal was played back into this one.");
    }

    /// <summary>
    /// A copy of the same file one commit ahead of the crashed file's base, with the crashed file's
    /// journal beside it: SQLite's format cannot tell them apart, so the playback runs only on the
    /// person's own open, never in a synced folder, and keeps the copy exactly as it was.
    /// </summary>
    [TestMethod]
    public async Task ESC01_AJournalFromACopyOfTheSameFileNeverLosesTheCopy()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var ahead = Path.Combine(folder, "ahead", "ideas.nendo");
        Directory.CreateDirectory(Path.GetDirectoryName(ahead)!);
        File.Copy(workspace.FilePath, ahead);
        await using (var copy = await NendoWriteCoordinator.OpenAsync(ahead, "copy"))
            await copy.ApplyAsync(new("test", "ahead", "test", "Ahead", [new CreateRecordOperation("ahead", "notes", "ahead",
                new Dictionary<string, object?> { ["notes.body"] = "only in the copy" })]));
        var crashed = Path.Combine(folder, "crashed", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, crashed);
        var y = await File.ReadAllBytesAsync(ahead);
        await File.WriteAllBytesAsync(crashed, y);
        var journal = await File.ReadAllBytesAsync(crashed + "-journal");
        Assert.AreEqual(ChangeCounter(await File.ReadAllBytesAsync(workspace.FilePath)) + 1, ChangeCounter(y), "The copy is not one commit ahead.");

        await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalOpenToRollBackText,
            "An observation the person did not ask for played a copy's journal back.", NendoInterruptedWrite.Refuse);
        await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalSyncedFolderText,
            "A file in a synced folder had its journal played back.", NendoInterruptedWrite.RefuseInSyncedFolder);
        var opened = await OpenedAsync(crashed);
        AssertKeptExactly(crashed, opened.Inspection, y, journal, "A copy's journal was played back into the file.");
        Assert.AreEqual(SqliteNendoStore.HeldStageFinding(SqliteNendoStore.HeldStages(crashed)[0]),
            (await NendoWriteCoordinator.InspectAsync(crashed)).Findings.LastOrDefault(), "A later inspection did not name the kept copy.");
    }

    /// <summary>Two copies that diverged at the same change counter, with byte-identical page 1.</summary>
    [TestMethod]
    public async Task ESC01_AJournalFromACopyAtTheSameCounterKeepsTheCopyExactly()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var other = Path.Combine(folder, "other", "ideas.nendo");
        Directory.CreateDirectory(Path.GetDirectoryName(other)!);
        File.Copy(workspace.FilePath, other);
        foreach (var (path, id) in new[] { (workspace.FilePath, "xx"), (other, "yy") })
            await using (var copy = await NendoWriteCoordinator.OpenAsync(path, "copy"))
                await copy.ApplyAsync(new("test", id, "test", id, [new CreateRecordOperation(id, "notes", id,
                    new Dictionary<string, object?> { ["notes.body"] = id })]));
        var crashed = Path.Combine(folder, "crashed", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, crashed);
        var y = await File.ReadAllBytesAsync(other);
        var journal = await File.ReadAllBytesAsync(crashed + "-journal");
        await File.WriteAllBytesAsync(crashed, y);
        Assert.AreEqual(ChangeCounter(await File.ReadAllBytesAsync(workspace.FilePath)), ChangeCounter(y), "The copies are not at the same counter.");

        var opened = await OpenedAsync(crashed);
        AssertKeptExactly(crashed, opened.Inspection, y, journal, "A copy's journal at the same counter was played back.");
    }

    [TestMethod]
    public async Task ESC01_ARestoresBackupWithAJournalIsRefusedUntouched()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, backup);
        var main = await File.ReadAllBytesAsync(backup);
        var opened = await workspace.OpenAsync();
        var refused = await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => opened.PrepareRestoreAsync(backup, "restore"));
        Assert.AreEqual(SqliteNendoStore.JournalOpenToRollBackText, refused.Message, "Choosing a backup to restore rolled its journal back.");
        CollectionAssert.AreEqual(main, await File.ReadAllBytesAsync(backup), "Choosing a backup to restore changed it.");
        CollectionAssert.AreEqual(new[] { "ideas.nendo", "ideas.nendo-journal" }, FilesBeside(backup));
    }

    [TestMethod]
    [DataRow(0)]
    [DataRow(4)]
    public async Task ESC01_AJournalWithNothingToRollBackIsClearedWhenNoWriterHoldsIt(int length)
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var main = await File.ReadAllBytesAsync(workspace.FilePath);
        await File.WriteAllBytesAsync(workspace.FilePath + "-journal", new byte[length]);
        var opened = await OpenedAsync(workspace.FilePath);
        Assert.IsTrue(opened.Inspection.CanAcquireWriteAuthority && opened.Inspection.Findings.Count == 0,
            "A journal with nothing to roll back left the file refused for good: " + string.Join("; ", opened.Inspection.Findings.Select(finding => finding.Message)));
        CollectionAssert.AreEqual(main, await File.ReadAllBytesAsync(workspace.FilePath), "Clearing an empty journal changed the file.");
        CollectionAssert.AreEqual(new[] { "ideas.nendo" }, FilesBeside(workspace.FilePath));

        // A writer that has not yet synced its journal holds RESERVED: its journal stays.
        using var connection = Raw(workspace.FilePath);
        using var transaction = connection.BeginTransaction(deferred: false);
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "UPDATE notes SET body = 'held';";
            command.ExecuteNonQuery();
        }
        var held = await ObservedFile.ReadAllBytesAsync(workspace.FilePath + "-journal");
        Assert.AreEqual(0, held.Length == 0 ? 0 : held[0], "The writer's journal header was already written.");
        var observed = await OpenedAsync(workspace.FilePath);
        Assert.AreEqual(SqliteNendoStore.JournalWriterText, observed.Inspection.Findings.Single().Message, "A writer's journal was cleared.");
        Assert.IsTrue(File.Exists(workspace.FilePath + "-journal"));
        transaction.Rollback();
    }

    [TestMethod]
    public async Task ESC01_ACopyCutShortIsNeverOfferedAsRestorable()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "partial", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, crashed);
        // What a kill part way through keeping a copy leaves, and a kept file whose journal is missing.
        var stale = crashed + ".before-rollback-20261013T000000000.nendo-held";
        await File.WriteAllBytesAsync(stale + ".partial-0123", [1, 2, 3]);
        await File.WriteAllBytesAsync(stale, [1, 2, 3]);
        var inspected = await NendoWriteCoordinator.InspectAsync(crashed);
        Assert.IsFalse(inspected.Findings.Any(finding => finding.Code == "interrupted-write-held"), "A copy cut short was offered as restorable.");
        File.Delete(stale + ".partial-0123");
        File.Delete(stale);

        // A copy that fails part way: nothing is played back, and nothing is offered.
        SqliteNendoStore.BeforeKeptCopyRenamed = (_, _) => throw new IOException("The disk is full.");
        try
        {
            await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalCouldNotKeepText(new IOException()),
                "A copy that failed part way was offered, or the file was played back without it.");
        }
        finally { SqliteNendoStore.BeforeKeptCopyRenamed = null; }
    }

    [TestMethod]
    public async Task ESC01_AJournalAnotherHostRolledBackMeanwhileLeavesTheFileToInspect()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "raced", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, crashed);
        // Another host plays the journal back while this one is keeping its copy.
        SqliteNendoStore.BeforeKeptCopyRenamed = async (_, ct) =>
        {
            SqliteNendoStore.BeforeKeptCopyRenamed = null;
            Assert.IsNull(await SqliteNendoStore.RollBackHotJournalAsync(crashed, ct));
        };
        try
        {
            var opened = await OpenedAsync(crashed);
            Assert.IsTrue(opened.Inspection.CanAcquireWriteAuthority && opened.Inspection.Findings.Count == 0,
                "A journal another host rolled back meanwhile was answered as a copy that failed: " +
                string.Join("; ", opened.Inspection.Findings.Select(finding => finding.Message)));
        }
        finally { SqliteNendoStore.BeforeKeptCopyRenamed = null; }
        CollectionAssert.AreEqual(new[] { "ideas.nendo" }, FilesBeside(crashed));
    }

    [TestMethod]
    public async Task ESC01_AForeignSqliteFileWithAHotJournalIsRefusedUntouched()
    {
        await using var workspace = new EngineTestWorkspace();
        var foreign = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "foreign", "source", "ideas.nendo");
        ForeignFile(foreign, 0);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "foreign", "ideas.nendo");
        await CrashedCopyAsync(foreign, crashed, "UPDATE notes SET body = @body;");
        await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalNotNendoText,
            "A file that is not Nendo's had its journal played back.");
    }

    [TestMethod]
    [DataRow("")]
    [DataRow("-journal")]
    public async Task ESC01_AReadOnlyFileIsRefusedWithTheRealReason(string which)
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "readonly", "ideas.nendo");
        await CrashedCopyAsync(workspace.FilePath, crashed);
        File.SetAttributes(crashed + which, FileAttributes.ReadOnly);
        try
        {
            await AssertRefusedUntouchedAsync(crashed, SqliteNendoStore.JournalFileReadOnlyText,
                $"A read-only {(which.Length == 0 ? "file" : "journal")} was refused with a reason that is not the real one.");
        }
        finally { File.SetAttributes(crashed + which, FileAttributes.Normal); }
    }

    [TestMethod]
    public async Task ESC01_ANendoFileSwitchedToWalWithAJournalIsNotCalledForeign()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        using (var connection = Raw(workspace.FilePath)) Execute(connection, "PRAGMA journal_mode = WAL;");
        await File.WriteAllBytesAsync(workspace.FilePath + "-journal", [1, 2, 3, 4]);
        await AssertRefusedUntouchedAsync(workspace.FilePath, SqliteNendoStore.JournalUnsupportedProfileText,
            "A Nendo file in another journal mode was called a file that is not Nendo's.");
    }

    /// <summary>
    /// A journal that belongs to the file and is played back, whose result does not read: the copy
    /// kept before the playback stays, byte for byte, under names SQLite does not pair, and every
    /// inspection names it.
    /// </summary>
    [TestMethod]
    public async Task ESC01_APlaybackThatDoesNotReadKeepsTheCopyAndNamesItEveryTime()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "unread", "source", "ideas.nendo");
        ForeignFile(source, NendoFormat.SqliteApplicationId);
        var crashed = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "unread", "ideas.nendo");
        await CrashedCopyAsync(source, crashed, "UPDATE notes SET body = body || ''; UPDATE notes SET body = @body || body;");
        var main = await File.ReadAllBytesAsync(crashed);
        var journal = await File.ReadAllBytesAsync(crashed + "-journal");

        var once = await OpenedAsync(crashed);
        Assert.IsFalse(once.Inspection.Capabilities.ReadData);
        AssertKeptExactly(crashed, once.Inspection, main, journal, "A playback that did not read.");
        Assert.AreEqual(SqliteNendoStore.HeldStageFinding(SqliteNendoStore.HeldStages(crashed)[0]),
            (await NendoWriteCoordinator.InspectAsync(crashed)).Findings.Last(), "A later inspection did not name the kept copy.");
    }

    /// <summary>A populated record type the review's schema findings change in place.</summary>
    private static async Task<NendoApplicationService> CapabilitiesAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("caps", "caps", "Capabilities", "caps"),
            new AddFieldOperation("caps-title", "caps", "caps.title", "Title", "title", NendoStorageKind.Text, false, "singleLine"),
            new AddFieldOperation("caps-done", "caps", "caps.done", "Done", "done", NendoStorageKind.Boolean, true),
        ]));
        await coordinator.ApplyAsync(new("test", "rows", "test", "Rows", [
            new CreateRecordOperation("c1", "caps", "c1", new Dictionary<string, object?> { ["caps.title"] = "One", ["caps.done"] = false }),
            new CreateRecordOperation("c2", "caps", "c2", new Dictionary<string, object?> { ["caps.title"] = "Two", ["caps.done"] = true }),
        ]));
        return new NendoApplicationService(coordinator);
    }

    private static async Task<long> DefinitionAsync(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

    private static async Task CommitsAsync(Func<Task> write, string what)
    {
        try
        {
            await write();
        }
        catch (SqliteException exception)
        {
            Assert.Fail($"{what} failed as a raw SQLite error: {exception.Message}");
        }
    }

    [TestMethod]
    public async Task ESS01_AFieldAddedEarlierInTheSameMutationIsNotReadBeforeItHasAColumn()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);

        var revision = await DefinitionAsync(service);
        await CommitsAsync(() => coordinator.ApplyAsync(new("test", "tree", "test", "Parent and hierarchy", [
            new AddFieldOperation("caps-parent", "caps", "caps.parent", "Parent", "parent", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("caps-parent-ref", "caps", "caps.parent", "caps", "caps.title", revision),
            new DeclareHierarchyOperation("caps-tree", "caps", "caps.parent", null, revision),
        ])), "Adding a Parent field and declaring the hierarchy over it in one mutation");
        Assert.AreEqual("caps.parent", (await service.GetSnapshotAsync()).Entities.Single().Hierarchy?.ParentFieldId);

        revision = await DefinitionAsync(service);
        await CommitsAsync(() => coordinator.ApplyAsync(new("test", "required", "test", "Notes and a required title", [
            new AddFieldOperation("caps-notes", "caps", "caps.notes", "Notes", "notes", NendoStorageKind.Text, false, "longText"),
            new SetFieldRequiredOperation("caps-title-required", "caps", "caps.title", true, revision),
        ])), "Adding a field and making another required in one mutation");
        await Assert.ThrowsAsync<NendoException>(() => coordinator.ApplyAsync(new("test", "blank", "test", "Blank title", [
            new SetFieldOperation("blank", "caps", "c1", "caps.title", 1, null)])), "The rebuilt table lost the title's NOT NULL.");
        await coordinator.ApplyAsync(new("test", "note", "test", "Note", [new SetFieldOperation("note", "caps", "c1", "caps.notes", 1, "kept")]));

        revision = await DefinitionAsync(service);
        await CommitsAsync(() => coordinator.ApplyAsync(new("test", "retire", "test", "Owner and retire Done", [
            new AddFieldOperation("caps-owner", "caps", "caps.owner", "Owner", "owner", NendoStorageKind.Text, false, "singleLine"),
            new SetRetiredOperation("caps-done-retired", "caps", "caps.done", true, revision),
        ])), "Adding a field and retiring a required one in one mutation");
        var c1 = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "c1");
        Assert.AreEqual("kept", c1.Values["caps.notes"].GetString(), "The rebuild dropped a value.");
    }

    /// <summary>Projects whose Finished count an action keeps on task Created, Updated and Deleted.</summary>
    private static async Task<NendoApplicationService> CountedTasksAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Finished", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-status", "tasks", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["open", "blocked"]),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        await coordinator.ApplyAsync(new("test", "p1", "test", "Project", [new CreateRecordOperation("p1", "projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project", ["total"] = 0L })]));
        foreach (var id in new[] { "t1", "t2" })
            await coordinator.ApplyAsync(new("test", id, "test", id, [new CreateRecordOperation(id, "tasks", id,
                new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false, ["status"] = "blocked" },
                new Dictionary<string, long> { ["project"] = 1 })]));
        var service = new NendoApplicationService(coordinator);
        var revision = await DefinitionAsync(service);
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Keep the finished count current", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition("project.count", "Count finished tasks",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition("10-total", "tasks", "Keep the finished count current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted, "project.count", ["done", "project"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        return service;
    }

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    [TestMethod]
    public async Task ESS02_ADeletionWhoseRevisionAlsoWroteItsTargetIsUndone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CountedTasksAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "finish", "test", "Finish t2", [new SetFieldOperation("finish", "tasks", "t2", "done", 1, true)]));
        Assert.AreEqual(1L, (await RecordAsync(service, "p1")).Values["total"].GetInt64());

        // The Deleted trigger recounts p1 in the deletion's own revision.
        var deleted = await coordinator.ApplyAsync(new("test", "delete", "test", "Delete t2", [new DeleteRecordOperation("delete", "tasks", "t2", 2)]));
        Assert.AreEqual(0L, (await RecordAsync(service, "p1")).Values["total"].GetInt64());
        try
        {
            await service.CompensateRevisionAsync(deleted.RevisionId, "undo-delete");
        }
        catch (NendoPreconditionException refused)
        {
            Assert.Fail($"Undoing a deletion whose action recounted its project was refused: {refused.Code}: {refused.Message}");
        }
        var restored = await RecordAsync(service, "t2");
        Assert.AreEqual(3L, restored.RecordVersion);
        Assert.IsTrue(restored.Values["done"].GetBoolean());
        Assert.AreEqual(1L, (await RecordAsync(service, "p1")).Values["total"].GetInt64(), "The count was not put back.");

        // A batch that edits the target after the delete is undone the same way.
        var p1 = (await RecordAsync(service, "p1")).RecordVersion;
        var batch = await coordinator.ApplyAsync(new("test", "batch", "test", "Delete t1 and rename", [
            new DeleteRecordOperation("batch-delete", "tasks", "t1", 1),
            new SetFieldOperation("batch-name", "projects", "p1", "name", p1, "Renamed"),
        ]));
        try
        {
            await service.CompensateRevisionAsync(batch.RevisionId, "undo-batch");
        }
        catch (NendoPreconditionException refused)
        {
            Assert.Fail($"Undoing a batch that renamed the project after deleting its task was refused: {refused.Code}: {refused.Message}");
        }
        Assert.AreEqual("Project", (await RecordAsync(service, "p1")).Values["name"].GetString());
        Assert.AreEqual(2L, (await RecordAsync(service, "t1")).RecordVersion);

        // Someone else's edit since still refuses, and says which record moved.
        var again = await coordinator.ApplyAsync(new("test", "again", "test", "Delete t1", [new DeleteRecordOperation("again", "tasks", "t1", 2)]));
        p1 = (await RecordAsync(service, "p1")).RecordVersion;
        await coordinator.ApplyAsync(new("test", "later", "test", "Rename", [new SetFieldOperation("later", "projects", "p1", "name", p1, "Later")]));
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(again.RevisionId, "undo-again"));
        Assert.AreEqual("target-version-conflict", stale.Code);
        StringAssert.Contains(stale.Message, "t1 pointed at p1 through Project, and p1 changed after the record was deleted");
    }

    [TestMethod]
    public async Task R2RM07_ARestoreBlockedByARetiredOptionNamesItAndTheRoute()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CountedTasksAsync(coordinator);
        var deleted = await coordinator.ApplyAsync(new("test", "delete", "test", "Delete t2", [new DeleteRecordOperation("delete", "tasks", "t2", 1)]));
        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire Blocked", [
            new SetChoiceMetadataOperation("retire", "tasks", "status", "blocked", "Blocked", true, await DefinitionAsync(service))]));
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(deleted.RevisionId, "undo"));
        Assert.AreEqual("choice-retired", refused.Code);
        Assert.AreEqual("t2 held Blocked in Tasks's Status, and Blocked is retired now, so the deletion is not undone. " +
            "Make Blocked available again in Structure, undo again, then retire it.", refused.Message,
            "The restore was refused with a remedy it cannot take.");
    }

    private static async Task<string> DescriptionAsync(NendoApplicationService service, string revisionId) =>
        (await service.QueryHistoryAsync(new(50))).Items.Single(revision => revision.RevisionId == revisionId).Description;

    [TestMethod]
    public async Task R2RM08_AnUndoIsNamedUndoAndItsUndoRedoOnEveryPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        NendoRequestContext Agent(string key) => new("agent-tests", key, "agent:pseudonym");
        Dictionary<string, object?> Values(string title) => new() { ["caps.title"] = title, ["caps.done"] = false };

        // History, three links.
        var made = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest([
            new(NendoRecordWriteKind.Create, "caps", "h1", Values("A")),
            new(NendoRecordWriteKind.Create, "caps", "h2", Values("B")),
        ], new("history-tests", "made", "workbench"), "Create 2 Capabilities"));
        var undo = await service.CompensateRevisionAsync(made.Applied.RevisionId, "history-undo");
        var redo = await service.CompensateRevisionAsync(undo.RevisionId, "history-redo");
        var again = await service.CompensateRevisionAsync(redo.RevisionId, "history-again");
        CollectionAssert.AreEqual(new[] { "Undo Create 2 Capabilities", "Redo Create 2 Capabilities", "Undo Create 2 Capabilities" },
            new[] { await DescriptionAsync(service, undo.RevisionId), await DescriptionAsync(service, redo.RevisionId), await DescriptionAsync(service, again.RevisionId) },
            "History names its undo and redo by what they do.");

        // An agent's nendo.data.undo_revision always sends Redo: false.
        var written = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest([
            new(NendoRecordWriteKind.Create, "caps", "a1", Values("C")),
        ], Agent("written"), "Create 1 Capabilities"));
        var agentUndo = await service.UndoRecordWritesAsync(new(written.Applied.RevisionId, Agent("agent-undo"), Redo: false));
        var agentRedo = await service.UndoRecordWritesAsync(new(agentUndo.Applied.RevisionId, Agent("agent-redo"), Redo: false));
        var agentAgain = await service.UndoRecordWritesAsync(new(agentRedo.Applied.RevisionId, Agent("agent-again"), Redo: false));
        CollectionAssert.AreEqual(new[] { "Undo Create 1 Capabilities", "Redo Create 1 Capabilities", "Undo Create 1 Capabilities" },
            new[] { await DescriptionAsync(service, agentUndo.Applied.RevisionId), await DescriptionAsync(service, agentRedo.Applied.RevisionId),
                await DescriptionAsync(service, agentAgain.Applied.RevisionId) },
            "An agent's redo is named as the undo it reverses.");
    }

    private static async Task<bool> OfferedAsync(NendoApplicationService service, string revisionId) =>
        (await service.QueryHistoryAsync(new(50))).Items.Single(revision => revision.RevisionId == revisionId).CanRequestCompensation;

    /// <summary>A populated record type with a field for each definition change History offers to undo.</summary>
    private static async Task<NendoApplicationService> ShapesAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("caps", "caps", "Capabilities", "caps"),
            new AddFieldOperation("caps-title", "caps", "caps.title", "Title", "title", NendoStorageKind.Text, false, "singleLine"),
            new AddFieldOperation("caps-done", "caps", "caps.done", "Done", "done", NendoStorageKind.Boolean, true),
            .. new[] { "code", "code2", "seq", "seq2", "spare", "spare2", "label2" }.Select(name =>
                (NendoOperation)new AddFieldOperation($"caps-{name}", "caps", $"caps.{name}", name, name, NendoStorageKind.Text, false, "singleLine")),
            .. new[] { "body", "body2" }.Select(name =>
                (NendoOperation)new AddFieldOperation($"caps-{name}", "caps", $"caps.{name}", name, name, NendoStorageKind.Text, false)),
        ]));
        var service = new NendoApplicationService(coordinator);
        // A sequence numbers a unique field.
        var revision = await DefinitionAsync(service);
        await coordinator.ApplyAsync(new("test", "unique-seq", "test", "Unique", [
            new SetFieldUniqueOperation("unique-seq", "caps", "caps.seq", true, revision),
            new SetFieldUniqueOperation("unique-seq2", "caps", "caps.seq2", true, revision)]));
        await coordinator.ApplyAsync(new("test", "rows", "test", "Rows", [
            new CreateRecordOperation("c1", "caps", "c1", new Dictionary<string, object?> { ["caps.title"] = "One", ["caps.done"] = false }),
        ]));
        return service;
    }

    [TestMethod]
    public async Task R2RM02_HistoryOffersADefinitionUndoExactlyWhenTheEngineMakesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await ShapesAsync(coordinator);
        // Two of each kind History offers on a structure change: the first is overtaken, the
        // second is undone while it is still the latest (ESC-03 adds the unique, sequence and
        // presentation changes to the offer).
        var kinds = new (string Name, Func<long, string, NendoOperation> First, Func<long, string, NendoOperation> Second)[]
        {
            ("unique", (r, k) => new SetFieldUniqueOperation(k, "caps", "caps.code", true, r), (r, k) => new SetFieldUniqueOperation(k, "caps", "caps.code2", true, r)),
            ("sequence", (r, k) => new SetFieldSequenceOperation(k, "caps", "caps.seq", "S-", 3, r), (r, k) => new SetFieldSequenceOperation(k, "caps", "caps.seq2", "T-", 3, r)),
            ("presentation", (r, k) => new SetFieldPresentationOperation(k, "caps", "caps.body", "markdown", r), (r, k) => new SetFieldPresentationOperation(k, "caps", "caps.body2", "longText", r)),
            ("rename", (r, k) => new RenameFieldOperation(k, "caps", "caps.title", "Name", r), (r, k) => new RenameFieldOperation(k, "caps", "caps.label2", "Label two", r)),
            ("retire", (r, k) => new SetRetiredOperation(k, "caps", "caps.spare", true, r), (r, k) => new SetRetiredOperation(k, "caps", "caps.spare2", true, r)),
            ("required", (r, k) => new SetFieldRequiredOperation(k, "caps", "caps.title", true, r), (r, k) => new SetFieldRequiredOperation(k, "caps", "caps.done", false, r)),
        };
        var later = 0;
        foreach (var (name, first, second) in kinds)
        {
            var overtaken = await coordinator.ApplyAsync(new("test", $"{name}-1", "test", name, [first(await DefinitionAsync(service), $"{name}-1")]));
            Assert.IsTrue(await OfferedAsync(service, overtaken.RevisionId), $"History does not offer to undo the latest {name} change.");
            var moved = await coordinator.ApplyAsync(new("test", $"later-{++later}", "test", "Rename", [
                new RenameEntityOperation($"later-{later}", "caps", $"Capabilities {later}", await DefinitionAsync(service))]));
            Assert.IsFalse(await OfferedAsync(service, overtaken.RevisionId),
                $"History offers to undo a {name} change that a later structure change overtook, and the engine refuses it.");
            var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
                () => service.CompensateRevisionAsync(overtaken.RevisionId, $"undo-{name}-1"));
            StringAssert.StartsWith(refused.Message, "Only the latest change to the file's structure can be undone");
            // Undoing the later change moves the definition on too, so the overtaken one stays refused.
            await service.CompensateRevisionAsync(moved.RevisionId, $"undo-later-{later}");
            Assert.IsFalse(await OfferedAsync(service, overtaken.RevisionId), $"History offers the overtaken {name} change after an undo.");

            var latest = await coordinator.ApplyAsync(new("test", $"{name}-2", "test", name, [second(await DefinitionAsync(service), $"{name}-2")]));
            Assert.IsTrue(await OfferedAsync(service, latest.RevisionId), $"History does not offer to undo the latest {name} change.");
            await service.CompensateRevisionAsync(latest.RevisionId, $"undo-{name}-2");
            Assert.IsFalse(await OfferedAsync(service, latest.RevisionId), $"History offers to undo the {name} change it just undid.");
        }
    }

    [TestMethod]
    public async Task ESC02_ARevisionWhoseUndoIsOnAnotherPageIsNotOffered()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        var edit = await coordinator.ApplyAsync(new("test", "edit", "test", "Edit", [new SetFieldOperation("edit", "caps", "c1", "caps.title", 1, "Edited")]));
        await service.CompensateRevisionAsync(edit.RevisionId, "undo-edit");
        var first = await service.QueryHistoryAsync(new(1));
        Assert.AreEqual(edit.RevisionId, first.Items.Single().CompensationOfRevisionId, "The undo is not on the first page.");
        var second = await service.QueryHistoryAsync(new(1, first.NextCursor));
        Assert.AreEqual(edit.RevisionId, second.Items.Single().RevisionId);
        Assert.IsFalse(second.Items.Single().CanRequestCompensation,
            "Page two offers to undo a revision whose undo is on page one, and the engine refuses it.");
    }

    [TestMethod]
    public async Task R2RM04_TheFillTheReactivateFormWritesIsUndoneOrSaysWhyNot()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "owner", "test", "Owner", [
            new AddFieldOperation("caps-owner", "caps", "caps.owner", "Owner", "owner", NendoStorageKind.Text, false, "singleLine"),
            new AddFieldOperation("caps-note", "caps", "caps.note", "Note", "note", NendoStorageKind.Text, false, "singleLine")]));
        await coordinator.ApplyAsync(new("test", "fill", "test", "Fill", [
            new SetFieldOperation("fill-o", "caps", "c1", "caps.owner", 1, "Ann"),
            new SetFieldOperation("fill-o2", "caps", "c2", "caps.owner", 1, "Bo")]));
        await coordinator.ApplyAsync(new("test", "require", "test", "Require owner", [
            new SetFieldRequiredOperation("require", "caps", "caps.owner", true, await DefinitionAsync(service))]));
        foreach (var field in new[] { "caps.owner", "caps.note" })
            await coordinator.ApplyAsync(new("test", $"retire-{field}", "test", "Retire", [
                new SetRetiredOperation($"retire-{field}", "caps", field, true, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "c3", "test", "New", [new CreateRecordOperation("c3", "caps", "c3",
            new Dictionary<string, object?> { ["caps.title"] = "Three", ["caps.done"] = false })]));

        // The Reactivate form's two mutations: fill the missing values, then reactivate.
        var filled = await coordinator.ApplyAsync(new("test", "backfill", "test", "Fill missing Owner values", [
            new BackfillRetiredFieldOperation("backfill", "caps", "c3", "caps.owner", 1, "Cy")]));
        await coordinator.ApplyAsync(new("test", "reactivate", "test", "Reactivate Owner", [
            new SetRetiredOperation("reactivate", "caps", "caps.owner", false, await DefinitionAsync(service))]));
        Assert.IsTrue(await OfferedAsync(service, filled.RevisionId));
        var required = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(filled.RevisionId, "undo-fill"),
            "The fill of a required field was not refused, or not in words a person can act on.");
        Assert.AreEqual("Owner is required now, so the values filled in to make it active again stay. Make Owner optional, then undo this again.", required.Message);

        // Optional and active again: putting the value back is an ordinary edit.
        await coordinator.ApplyAsync(new("test", "optional", "test", "Owner optional", [
            new SetFieldRequiredOperation("optional", "caps", "caps.owner", false, await DefinitionAsync(service))]));
        try
        {
            await service.CompensateRevisionAsync(filled.RevisionId, "undo-fill-optional");
        }
        catch (NendoPreconditionException refused)
        {
            Assert.Fail($"Undoing a fill on a field that is active again was refused: {refused.Code}: {refused.Message}");
        }
        Assert.AreEqual(JsonValueKind.Null, (await RecordAsync(service, "c3")).Values["caps.owner"].ValueKind);

        // A fill of a field still retired is undone as a fill, its empty value included.
        await coordinator.ApplyAsync(new("test", "require-note", "test", "Require note", [
            new SetRetiredOperation("unretire-note", "caps", "caps.note", false, await DefinitionAsync(service))]));
        var noteFill = await coordinator.ApplyAsync(new("test", "note-fill", "test", "Fill notes", [
            new SetFieldOperation("note-1", "caps", "c1", "caps.note", (await RecordAsync(service, "c1")).RecordVersion, "n1"),
            new SetFieldOperation("note-2", "caps", "c2", "caps.note", (await RecordAsync(service, "c2")).RecordVersion, "n2"),
            new SetFieldOperation("note-3", "caps", "c3", "caps.note", (await RecordAsync(service, "c3")).RecordVersion, "n3")]));
        await coordinator.ApplyAsync(new("test", "note-required", "test", "Require note", [
            new SetFieldRequiredOperation("note-required", "caps", "caps.note", true, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "note-retire", "test", "Retire note", [
            new SetRetiredOperation("note-retire", "caps", "caps.note", true, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "c4", "test", "New", [new CreateRecordOperation("c4", "caps", "c4",
            new Dictionary<string, object?> { ["caps.title"] = "Four", ["caps.done"] = false })]));
        var retiredFill = await coordinator.ApplyAsync(new("test", "fill-c4", "test", "Fill missing Note values", [
            new BackfillRetiredFieldOperation("fill-c4", "caps", "c4", "caps.note", 1, "n4")]));
        _ = noteFill;
        try
        {
            await service.CompensateRevisionAsync(retiredFill.RevisionId, "undo-fill-c4");
        }
        catch (NendoException refused)
        {
            Assert.Fail($"Undoing the fill of a required field that is still retired was refused: {refused.Message}");
        }
        Assert.AreEqual(JsonValueKind.Null, (await RecordAsync(service, "c4")).Values["caps.note"].ValueKind);
    }

    [TestMethod]
    public async Task ESS06_UndoingAPresentationChangeGivesAFieldWithNoneNoneAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await ShapesAsync(coordinator);
        PresentationOf((await service.GetSnapshotAsync()), "caps.body", null);
        var shown = await coordinator.ApplyAsync(new("test", "markdown", "test", "Show as Markdown", [
            new SetFieldPresentationOperation("markdown", "caps", "caps.body", "markdown", await DefinitionAsync(service))]));
        await service.CompensateRevisionAsync(shown.RevisionId, "undo-markdown");
        PresentationOf(await service.GetSnapshotAsync(), "caps.body", null);

        static void PresentationOf(NendoSessionSnapshot snapshot, string fieldId, string? expected) =>
            Assert.AreEqual(expected, snapshot.Entities.Single().Fields.Single(field => field.FieldId == fieldId).Presentation,
                "Undoing a presentation change left a presentation the author never set.");
    }

    [TestMethod]
    public async Task ESC04_AReadOnlySessionShowsAUniqueNumberedFieldAsTheWritableOneDoes()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await ShapesAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "number", "test", "Number", [
            new SetFieldSequenceOperation("number", "caps", "caps.seq", "S-", 3, await DefinitionAsync(service))]));
        var writable = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Entities.Single().Fields);
        StringAssert.Contains(writable, "\"S-\"", "The fixture has no numbered field.");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(writable, JsonSerializer.Serialize((await new NendoApplicationService(reader).GetSnapshotAsync()).Entities.Single().Fields),
            "A read-only session shows the fields differently from the writable one: no field unique or numbered.");
    }

    [TestMethod]
    public async Task ESC05_ATableNameSqliteReservesIsRefusedByNameAndAnAgentsIdStillWorks()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new("test", "reserved", "test", "Reserved", [
            new CreateEntityOperation("log", "log", "Log", "sqlite_x_00000000")])),
            "A table name SQLite reserves reached CREATE TABLE.");
        StringAssert.Contains(refused.Message, "starts with sqlite_");

        foreach (var entityId in new[] { "entity.sqlite_log", "entity.sqlite" })
        {
            var operation = (CreateEntityOperation)CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
                $"create-{entityId}", "schema.createEntity", JsonDocument.Parse($$"""{"entityId":"{{entityId}}","displayName":"{{entityId}}"}""").RootElement));
            StringAssert.StartsWith(operation.PhysicalTableName, "entity_sqlite", StringComparison.Ordinal);
            await coordinator.ApplyAsync(new("test", entityId, "test", entityId, [operation]));
        }
    }

    [TestMethod]
    public async Task ESC06_ASaveAnotherProgramKeepsBusyIsRefusedAsBusyAndChangesNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        var before = (await RecordAsync(service, "c1")).RecordVersion;

        // A reader holding its read open: COMMIT cannot have the file to itself.
        using (var reader = Raw(workspace.FilePath))
        using (var read = reader.BeginTransaction(deferred: true))
        {
            using (var select = reader.CreateCommand())
            {
                select.Transaction = read;
                select.CommandText = "SELECT COUNT(*) FROM caps;";
                _ = select.ExecuteScalar();
            }
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "busy", "test", "Edit",
                [new SetFieldOperation("busy", "caps", "c1", "caps.title", before, "Edited")])),
                "A save a reader kept busy did not come back as the typed busy refusal.");
            Assert.AreEqual("file-busy", refused.Code);
            read.Rollback();
        }
        // An outside writer: BEGIN IMMEDIATE cannot start.
        using (var writer = Raw(workspace.FilePath))
        using (var write = writer.BeginTransaction(deferred: false))
        {
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "busy-2", "test", "Edit",
                [new SetFieldOperation("busy-2", "caps", "c1", "caps.title", before, "Edited")])),
                "A save another writer kept busy did not come back as the typed busy refusal.");
            Assert.AreEqual("file-busy", refused.Code);
            write.Rollback();
        }
        Assert.AreEqual(before, (await RecordAsync(service, "c1")).RecordVersion, "A busy save changed the record.");
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health, "A busy save cost the session its authority.");
        await coordinator.ApplyAsync(new("test", "after", "test", "Edit", [new SetFieldOperation("after", "caps", "c1", "caps.title", before, "Edited")]));
        Assert.AreEqual("Edited", (await RecordAsync(service, "c1")).Values["caps.title"].GetString());
    }

    [TestMethod]
    public async Task ESC06_AFoldAnotherProgramKeepsBusyIsRefusedAsBusy()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        coordinator.HistoryFoldPolicy = new(5, 1_000, 2);
        for (var index = 0; index < 12; index++)
            await coordinator.ApplyAsync(new("test", $"row-{index}", "test", "Row", [new CreateRecordOperation($"row-{index}", "caps", $"r{index}",
                new Dictionary<string, object?> { ["caps.title"] = $"Row {index}", ["caps.done"] = false })]));
        var plan = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold.nendo"), "before-fold");
        await coordinator.CreateBackupAsync(plan.PlanId);
        var history = (await service.GetHistoryAsync()).Count;
        using (var reader = Raw(workspace.FilePath))
        using (var read = reader.BeginTransaction(deferred: true))
        {
            using (var select = reader.CreateCommand())
            {
                select.Transaction = read;
                select.CommandText = "SELECT COUNT(*) FROM caps;";
                _ = select.ExecuteScalar();
            }
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.FoldHistoryAsync(plan.PlanId),
                "A fold a reader kept busy did not come back as the typed busy refusal.");
            Assert.AreEqual("file-busy", refused.Code);
            read.Rollback();
        }
        Assert.HasCount(history, await service.GetHistoryAsync(), "A busy fold changed the history.");
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
    }

    [TestMethod]
    [DataRow("new-file preview")]
    [DataRow("search")]
    [DataRow("fold preview")]
    public async Task ESC08_AnAdvisoryReadAfterAnOutsideCommitEntersRecovery(string read)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await CapabilitiesAsync(coordinator);
        using (var outside = Raw(workspace.FilePath)) Execute(outside, "UPDATE caps SET title = 'outside';");
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(async () =>
        {
            switch (read)
            {
                case "new-file preview": await coordinator.PreviewNewFileAsync(); break;
                case "search": await coordinator.SearchRecordsAsync(new NendoSearchQuery("outside")); break;
                default: await coordinator.PreviewHistoryFoldAsync(); break;
            }
        }, $"The {read} read the outside-changed file as if Nendo had written it.");
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health, $"The {read} left the session trusted after an outside commit.");
    }

    [TestMethod]
    public async Task ESC09_AnObservedOpenScansTheFilesIntegrityOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        await NotesFileAsync(workspace);
        var observed = await NendoWriteCoordinator.ObserveAsync(workspace.FilePath);
        await using var opened = await NendoWriteCoordinator.OpenObservedAsync(workspace.FilePath, "observed", observed);
        Assert.AreEqual(1L, opened.ReadDiagnostics.IntegrityChecks,
            "An open that confirms an observation ran SQLite's integrity_check more than once on its connection.");
    }

    [TestMethod]
    public void ESS07_OnlyAWordStillBeingTypedIsAPrefix()
    {
        CollectionAssert.AreEqual(new[] { "\"garden\"" }, SearchTerms.Parse("garden -weed").Required.ToArray(),
            "The last required word was a prefix although a left-out word followed it.");
        CollectionAssert.AreEqual(new[] { "\"garden\"" }, SearchTerms.Parse("garden\t").Required.ToArray(), "A word followed by a tab is whole.");
        CollectionAssert.AreEqual(new[] { "\"gard\"*" }, SearchTerms.Parse("gard").Required.ToArray());
        CollectionAssert.AreEqual(new[] { "\"weed\"", "\"gard\"*" }, SearchTerms.Parse("weed gard").Required.ToArray());
    }

    [TestMethod]
    public async Task ESS03_ANumberADeletedRecordHeldIsNotHandedOutAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await ShapesAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "number", "test", "Number", [
            new SetFieldSequenceOperation("number", "caps", "caps.seq", "F-", 3, await DefinitionAsync(service))]));
        foreach (var id in new[] { "n1", "n2", "n3" })
            await coordinator.ApplyAsync(new("test", id, "test", id, [new CreateRecordOperation(id, "caps", id,
                new Dictionary<string, object?> { ["caps.title"] = id, ["caps.done"] = false })]));
        Assert.AreEqual("F-003", (await RecordAsync(service, "n3")).Values["caps.seq"].GetString());
        var deleted = await coordinator.ApplyAsync(new("test", "delete", "test", "Delete n3", [new DeleteRecordOperation("delete", "caps", "n3", 1)]));
        await coordinator.ApplyAsync(new("test", "stop", "test", "Stop numbering", [
            new SetFieldSequenceOperation("stop", "caps", "caps.seq", null, null, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "again", "test", "Number again", [
            new SetFieldSequenceOperation("again", "caps", "caps.seq", "F-", 3, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "n4", "test", "n4", [new CreateRecordOperation("n4", "caps", "n4",
            new Dictionary<string, object?> { ["caps.title"] = "n4", ["caps.done"] = false })]));
        Assert.AreEqual("F-004", (await RecordAsync(service, "n4")).Values["caps.seq"].GetString(),
            "A sequence declared again handed out the number of a deleted record.");
        await service.CompensateRevisionAsync(deleted.RevisionId, "undo-delete");
        Assert.AreEqual("F-003", (await RecordAsync(service, "n3")).Values["caps.seq"].GetString(), "The restored record did not get its own code back.");
    }

    private static List<(string Name, string Table)> UniqueIndexes(string path)
    {
        using var connection = Raw(path);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'nendo_unique_%' ORDER BY tbl_name;";
        using var reader = command.ExecuteReader();
        var found = new List<(string, string)>();
        while (reader.Read()) found.Add((reader.GetString(0), reader.GetString(1)));
        return found;
    }

    [TestMethod]
    public async Task ESS04_TwoUniqueFieldsWhoseNamesRunTogetherEachKeepTheirOwnIndex()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("task", "task", "Task", "task"),
            new AddFieldOperation("task-due-code", "task", "task.due_code", "Due code", "due_code", NendoStorageKind.Text, false, "singleLine"),
            new CreateEntityOperation("task-due", "task_due", "Task due", "task_due"),
            new AddFieldOperation("task-due-code2", "task_due", "task_due.code", "Code", "code", NendoStorageKind.Text, false, "singleLine"),
        ]));
        var revision = await DefinitionAsync(service);
        await coordinator.ApplyAsync(new("test", "unique", "test", "Unique", [
            new SetFieldUniqueOperation("u1", "task", "task.due_code", true, revision),
            new SetFieldUniqueOperation("u2", "task_due", "task_due.code", true, revision)]));
        CollectionAssert.AreEqual(new[] { "task", "task_due" }, UniqueIndexes(workspace.FilePath).Select(index => index.Table).ToArray(),
            "A unique field whose index name ran into another table's got no backstop index.");
        await coordinator.ApplyAsync(new("test", "stop", "test", "Stop", [
            new SetFieldUniqueOperation("stop", "task_due", "task_due.code", false, await DefinitionAsync(service))]));
        CollectionAssert.AreEqual(new[] { ("nendo_unique_task_due_code", "task") }, UniqueIndexes(workspace.FilePath).ToArray(),
            "Stopping one field's uniqueness dropped another table's index.");
    }

    [TestMethod]
    public async Task ESS10_AHierarchysOrderFieldAndUniquenessRefuseEachOther()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        var revision = await DefinitionAsync(service);
        await coordinator.ApplyAsync(new("test", "fields", "test", "Fields", [
            new AddFieldOperation("caps-parent", "caps", "caps.parent", "Parent", "parent", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("caps-parent-ref", "caps", "caps.parent", "caps", "caps.title", revision),
            new AddFieldOperation("caps-position", "caps", "caps.position", "Position", "position", NendoStorageKind.Integer, false),
            new AddFieldOperation("caps-rank", "caps", "caps.rank", "Rank", "rank", NendoStorageKind.Integer, false)]));
        await coordinator.ApplyAsync(new("test", "unique-rank", "test", "Unique rank", [
            new SetFieldUniqueOperation("unique-rank", "caps", "caps.rank", true, await DefinitionAsync(service))]));
        var declare = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "tree-rank", "test", "Tree", [
            new DeclareHierarchyOperation("tree-rank", "caps", "caps.parent", "caps.rank", revision + 2)])),
            "A hierarchy was ordered by a unique field, which refuses ordinary moves.");
        Assert.AreEqual("hierarchy-field-in-use", declare.Code);

        await coordinator.ApplyAsync(new("test", "tree", "test", "Tree", [
            new DeclareHierarchyOperation("tree", "caps", "caps.parent", "caps.position", await DefinitionAsync(service))]));
        var unique = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "unique-position", "test", "Unique", [
            new SetFieldUniqueOperation("unique-position", "caps", "caps.position", true, revision + 3)])),
            "A hierarchy's order field was made unique, which refuses ordinary moves.");
        Assert.AreEqual("hierarchy-field-in-use", unique.Code);
    }

    [TestMethod]
    public async Task ESS12_RecordIdsWithSpacesAreNamedWholeInACollision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await ShapesAsync(coordinator);
        foreach (var id in new[] { "Task 1", "Task 2" })
            await coordinator.ApplyAsync(new("test", id, "test", id, [new CreateRecordOperation(id, "caps", id,
                new Dictionary<string, object?> { ["caps.title"] = id, ["caps.done"] = false, ["caps.code"] = "C-1" })]));
        var revision = await DefinitionAsync(service);
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "unique", "test", "Unique", [
            new SetFieldUniqueOperation("unique", "caps", "caps.code", true, revision)])));
        Assert.AreEqual("field-values-not-unique", refused.Code);
        StringAssert.Contains(refused.Message, "in these groups: Task 1 and Task 2.", "A record ID with a space was split apart in the refusal.");
    }

    [TestMethod]
    public async Task ESS13_ADeleteBlockedByARetiredReferenceNamesTheRemedy()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CountedTasksAsync(coordinator);
        var behaviour = await DefinitionAsync(service);
        await coordinator.ApplyAsync(new("test", "unbehave", "test", "No actions", [
            new RemoveBehaviourDefinitionOperation("t-off", "10-total", NendoBehaviourKind.Trigger, behaviour),
            new RemoveBehaviourDefinitionOperation("a-off", "project.count", NendoBehaviourKind.Action, behaviour)]));
        await coordinator.ApplyAsync(new("test", "optional", "test", "Optional", [
            new SetFieldRequiredOperation("optional", "tasks", "project", false, await DefinitionAsync(service))]));
        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire", [
            new SetRetiredOperation("retire", "tasks", "project", true, await DefinitionAsync(service))]));
        var version = (await RecordAsync(service, "p1")).RecordVersion;
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "delete", "test", "Delete", [
            new DeleteRecordOperation("delete", "projects", "p1", version)])));
        Assert.AreEqual("record-referenced", refused.Code);
        StringAssert.Contains(refused.Message, "Project is retired, so it cannot be edited on those records. Reactivate Project, or clear it with a reviewed backfill",
            "The refusal told the person to clear references through a field they cannot edit.");
    }

    [TestMethod]
    public async Task R2RM03_AnUndoResentAfterItWasRedoneIsRefusedNotReplayed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await CapabilitiesAsync(coordinator);
        var edit = await coordinator.ApplyAsync(new("test", "edit", "test", "Edit", [new SetFieldOperation("edit", "caps", "c1", "caps.title", 1, "Edited")]));
        var undo = await service.CompensateRevisionAsync(edit.RevisionId, "undo-edit");
        Assert.IsTrue((await service.CompensateRevisionAsync(edit.RevisionId, "undo-edit")).IsIdempotentReplay, "An exact retry was not replayed.");
        await service.CompensateRevisionAsync(undo.RevisionId, "redo-edit");
        var stale = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(edit.RevisionId, "undo-edit"),
            "An undo resent after it was redone answered with a state the file no longer has.");
        StringAssert.StartsWith(stale.Message, "This undo has itself been undone since");
        Assert.AreEqual("Edited", (await RecordAsync(service, "c1")).Values["caps.title"].GetString());
    }

    private static Process StartChild(string path, string mode)
    {
        var start = new ProcessStartInfo("pwsh")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File",
                     Path.Combine(ReviewOutcomeChildDriver.RepositoryRoot(), "tools", "Invoke-ReviewOutcomeChild.ps1"),
                     "-EngineDirectory", Path.GetDirectoryName(typeof(ReviewOutcomeChildDriver).Assembly.Location)!,
                     "-FilePath", path, "-ProposalId", "unused", "-Mode", mode })
            start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new AssertFailedException("The interrupted-write child did not start.");
    }
}
