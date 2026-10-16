using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

/// <summary>
/// A write a crash left unfinished, rolled back when the person opens the file (ADR-0012,
/// 2026-10-13, ESC-01).
/// <para>
/// SQLite pairs a database with its rollback journal by name alone. Plain file reads first show
/// that a journal could be this file's; that rules out another file's journal, but not one from a
/// copy of the same file (an Explorer copy, a backup, the file synced to another machine), which
/// SQLite's format cannot tell apart. So a journal is played back only on the person's own open
/// of the file, never in a synced folder, and the file as it was before is always kept beside it
/// and named until the person removes it.
/// </para>
/// </summary>
internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// What a file with a storage sidecar is refused with when nothing more specific is known:
    /// an inspection outside the open path, or a WAL derivative. It does not claim a writer it
    /// has not seen.
    /// </summary>
    internal const string OperationalSidecarsText =
        "This file has a storage file beside it (ending -journal, -wal or -shm) from a write that is in progress or did not finish. " +
        "Close any program that has the file open, then inspect it again. Never delete those files, and never copy the file without them: " +
        "they hold what is needed to finish or undo that write.";

    internal const string JournalOpenToRollBackText =
        "A save to this file was left unfinished, and its -journal is beside it. Nendo rolls such a save back only when you open this file " +
        "yourself, so nothing was changed here. Keep the -journal with the file.";

    internal const string JournalSyncedFolderText =
        "A save to this file was left unfinished, and the file is in a folder that may be synced, so its -journal may have come from another " +
        "computer. Nendo did not roll it back or change anything. Let sync finish and close Nendo on the other computers, then copy the file " +
        "together with its -journal, side by side, to a folder that is not synced, and open it there.";

    internal const string JournalNothingToRollBackText =
        "A -journal is beside this file, but it holds nothing to roll back: a save stopped before it changed the file. Open the file " +
        "yourself, from a folder that is not synced, and Nendo clears it. Keep the -journal with the file until then.";

    internal const string JournalWriterText =
        "Another program is writing to this file. Close it, then inspect the file again. Never delete the file's -journal, and never copy the file without it.";

    internal const string JournalBusyText =
        "Another program has this file locked. Close it, then inspect the file again. Keep the file's -journal with it.";

    internal const string JournalNotNendoText =
        "This is not a Nendo file, and an unfinished SQLite write has left a -journal beside it. Nendo did not open, roll back or change either.";

    internal const string JournalUnsupportedProfileText =
        "This file uses a storage read/write profile Nendo does not support, and a -journal is beside it. Nendo did not open, roll back or change either.";

    internal const string JournalMismatchText =
        "The -journal beside this file was not written for it: it belongs to another file, or was brought here from elsewhere, for example " +
        "by a backup restored over the file or by a sync tool. Nendo did not roll it back or change anything. Move the -journal out of the " +
        "folder, keeping it, then inspect the file again.";

    internal const string JournalUnverifiableText =
        "A save to this file was left unfinished, but its -journal does not show which file it was written for, so Nendo did not roll it " +
        "back or change anything. Keep the two together, and open a backup instead, or roll it back with a SQLite tool if you know the " +
        "journal is this file's.";

    internal const string JournalAnotherWindowText =
        "Another Nendo window has this file open. Close it there, then inspect the file again.";

    internal const string JournalFolderReadOnlyText =
        "A save to this file was left unfinished, and Nendo cannot roll it back here because it cannot write in this folder. Copy the file " +
        "together with its -journal, side by side, to a folder you can write to, and open it there.";

    internal const string JournalFileReadOnlyText =
        "A save to this file was left unfinished, and Nendo cannot roll it back because the file or its -journal is read-only. Make both " +
        "writable, or copy the file together with its -journal, side by side, to a folder you can write to, and open it there.";

    internal static string JournalTooLargeText =>
        $"This file exceeds the current {InspectionLimitText} inspection limit, and a save to it left a -journal beside it. Nendo did not roll it back or change it.";

    internal static string JournalOversizeText =>
        $"The -journal beside this file is larger than the {InspectionLimitText} Nendo reads, so Nendo did not roll it back or change anything. " +
        "Keep the two together and open a backup instead.";

    internal static string JournalCouldNotKeepText(Exception exception) =>
        "A save to this file was left unfinished, and Nendo could not keep a copy of the file and its -journal before rolling it back " +
        $"({(exception is UnauthorizedAccessException ? "the folder cannot be written" : "the disk may be full or write-protected")}), so nothing " +
        "was changed. Free some space, or copy the file together with its -journal to a folder you can write to, and open it there.";

    /// <summary>What a check of a file's rollback journal found.</summary>
    internal enum JournalVerdict
    {
        /// <summary>The journal could be this file's and SQLite reports it hot.</summary>
        Hot,
        /// <summary>The journal holds nothing to roll back: empty, or its header was never written.</summary>
        Empty,
        /// <summary>The journal went away while it was checked: another host rolled it back.</summary>
        Gone,
        /// <summary>Refused unopened, for the reason in the message; nothing was written.</summary>
        Refused,
    }

    internal sealed record JournalCheck(JournalVerdict Verdict, string? Message)
    {
        internal static JournalCheck Refuse(string message) => new(JournalVerdict.Refused, message);
    }

    private static readonly byte[] JournalMagic = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

    private static readonly Regex InstanceIdPattern = new("instance-[0-9a-f]{32}", RegexOptions.CultureInvariant);

    /// <summary>Whether a file has a rollback journal and no WAL derivative beside it.</summary>
    internal static bool HasLoneRollbackJournal(string path) =>
        File.Exists(path + "-journal") && !File.Exists(path + "-wal") && !File.Exists(path + "-shm");

    /// <summary>The refusal an open path answers with when a journal is not played back.</summary>
    internal static InspectedNendoFile JournalRefusal(string message) =>
        Unreadable("operational-sidecars", message, DateTimeOffset.UtcNow, recovery: true);

    /// <summary>
    /// Whether a lone rollback journal could be played back, read without opening the file in
    /// SQLite for writing. The file must be within the size bound, a rollback-journal SQLite file
    /// carrying Nendo's application ID. The journal must have SQLite's header and this file's page
    /// size, and its saved image of page 1 must be a Nendo page 1 whose change counter is the
    /// file's (then the file's page 1 is still that image, byte for byte) or one behind it. The
    /// journal must name at least one Nendo instance, and every one it names must be in the file.
    /// Last, a read-only SQLite connection must report the journal hot: SQLite treats a journal as
    /// hot only while no connection holds a write lock, so a program still writing is answered as
    /// such. These checks rule out another file's journal; a copy of the same file can pass them,
    /// which is why the caller plays back only on the person's open and keeps the file as it was.
    /// </summary>
    internal static async Task<JournalCheck> CheckInterruptedWriteAsync(string path, CancellationToken cancellationToken)
    {
        var journalPath = path + "-journal";
        try
        {
            byte[] page1;
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (file.Length < 100) return JournalCheck.Refuse(JournalNotNendoText);
                var header = new byte[100];
                await file.ReadExactlyAsync(header, cancellationToken);
                if (!header.AsSpan(0, 16).SequenceEqual("SQLite format 3\0"u8) ||
                    BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(68)) != NendoFormat.SqliteApplicationId)
                    return JournalCheck.Refuse(JournalNotNendoText);
                if (header[18] != 1 || header[19] != 1) return JournalCheck.Refuse(JournalUnsupportedProfileText);
                if (file.Length > MaximumPhysicalFileBytes) return JournalCheck.Refuse(JournalTooLargeText);
                var pageSize = PageSize(header);
                if (pageSize is null || file.Length < pageSize) return JournalCheck.Refuse(JournalNotNendoText);
                page1 = new byte[pageSize.Value];
                file.Position = 0;
                await file.ReadExactlyAsync(page1, cancellationToken);
            }

            byte[]? saved;
            using (var journal = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (journal.Length == 0) return new(JournalVerdict.Empty, null);
                var first = new byte[1];
                await journal.ReadExactlyAsync(first, cancellationToken);
                if (first[0] == 0) return new(JournalVerdict.Empty, null);
                if (journal.Length > MaximumPhysicalFileBytes) return JournalCheck.Refuse(JournalOversizeText);
                (saved, var mismatch) = await ReadJournalAsync(journal, page1.Length, cancellationToken);
                if (mismatch) return JournalCheck.Refuse(JournalMismatchText);
            }
            if (saved is null) return JournalCheck.Refuse(JournalUnverifiableText);
            if (!saved.AsSpan(0, 16).SequenceEqual("SQLite format 3\0"u8) ||
                BinaryPrimitives.ReadInt32BigEndian(saved.AsSpan(68)) != NendoFormat.SqliteApplicationId ||
                PageSize(saved) != page1.Length)
                return JournalCheck.Refuse(JournalMismatchText);
            // Which file the journal was written for: every Nendo instance its bytes name, the
            // records SQLite has not counted yet included, since each came from that file. A
            // Nendo write saves its manifest page, which names the instance; a journal from
            // another file names that file's instance.
            var named = await InstanceIdsInAsync(journalPath, cancellationToken);
            if (named.Count == 0) return JournalCheck.Refuse(JournalUnverifiableText);
            if (!named.IsSubsetOf(await InstanceIdsInAsync(path, cancellationToken)))
                return JournalCheck.Refuse(JournalMismatchText);
            var counter = BinaryPrimitives.ReadUInt32BigEndian(page1.AsSpan(24));
            var savedCounter = BinaryPrimitives.ReadUInt32BigEndian(saved.AsSpan(24));
            if (counter == savedCounter)
            {
                // Page 1 not written yet: it is the saved image, byte for byte.
                if (!page1.AsSpan().SequenceEqual(saved)) return JournalCheck.Refuse(JournalMismatchText);
            }
            else if (counter != unchecked(savedCounter + 1))
            {
                return JournalCheck.Refuse(JournalMismatchText);
            }
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException && !File.Exists(journalPath))
        {
            return new(JournalVerdict.Gone, null);
        }
        catch (UnauthorizedAccessException)
        {
            return JournalCheck.Refuse(JournalFileReadOnlyText);
        }
        catch (IOException)
        {
            return JournalCheck.Refuse(OperationalSidecarsText);
        }

        // Only now does SQLite see the file, read-only: a hot journal cannot be rolled back on a
        // read-only connection, so SQLite says it is hot and changes nothing.
        try
        {
            await using var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadOnly, cancellationToken);
            var store = new SqliteNendoStore(path, connection);
            await store.NonQueryAsync($"PRAGMA busy_timeout = {BusyTimeoutMilliseconds};", null, cancellationToken);
            _ = await store.ScalarAsync("SELECT COUNT(*) FROM sqlite_schema;", null, cancellationToken);
            // It read: some connection holds the file for writing, so the journal is not hot.
            return File.Exists(journalPath) ? JournalCheck.Refuse(JournalWriterText) : new(JournalVerdict.Gone, null);
        }
        catch (SqliteException exception) when (exception.SqliteExtendedErrorCode == 776)
        {
            return new(JournalVerdict.Hot, null);
        }
        catch (SqliteException exception)
        {
            return JournalCheck.Refuse(SqliteRefusal(exception));
        }
    }

    /// <summary>A SQLite refusal of the playback, in its real reason.</summary>
    private static string SqliteRefusal(SqliteException exception) => exception.SqliteErrorCode switch
    {
        5 or 6 => JournalBusyText,
        8 or 14 => JournalFileReadOnlyText,
        _ => JournalUnverifiableText,
    };

    /// <summary>A page size read from a SQLite header, or null when it is not one.</summary>
    private static int? PageSize(ReadOnlySpan<byte> header)
    {
        var raw = BinaryPrimitives.ReadUInt16BigEndian(header[16..]);
        var size = raw == 1 ? 65536 : raw;
        return size >= 512 && (size & (size - 1)) == 0 ? size : null;
    }

    /// <summary>
    /// Walks a rollback journal's segments, as SQLite plays them back: each header, then the
    /// records its count holds. Answers the saved image of page 1, and whether the journal is not
    /// one for a file of this page size.
    /// </summary>
    private static async Task<(byte[]? Page1, bool Mismatch)> ReadJournalAsync(
        FileStream journal, int pageSize, CancellationToken cancellationToken)
    {
        byte[]? page1 = null;
        var header = new byte[28];
        var number = new byte[4];
        long offset = 0;
        var segments = 0;
        while (offset + header.Length <= journal.Length)
        {
            journal.Position = offset;
            await journal.ReadExactlyAsync(header, cancellationToken);
            if (!header.AsSpan(0, 8).SequenceEqual(JournalMagic))
                return segments == 0 ? (null, true) : (page1, false);
            var records = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(8));
            var sector = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(20));
            var size = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(24));
            if (size != pageSize || sector < 512 || sector > 65536 || (sector & (sector - 1)) != 0)
                return (null, true);
            // 0xffffffff asks SQLite to count records from the file's size, which a synchronous
            // FULL file never writes; such a journal is not one Nendo made.
            if (records == uint.MaxValue) return (null, false);
            segments++;
            var record = offset + sector;
            for (var index = 0u; index < records && record + 4 + pageSize + 4 <= journal.Length; index++)
            {
                journal.Position = record;
                await journal.ReadExactlyAsync(number, cancellationToken);
                if (BinaryPrimitives.ReadUInt32BigEndian(number) == 1 && page1 is null)
                {
                    page1 = new byte[pageSize];
                    await journal.ReadExactlyAsync(page1, cancellationToken);
                }
                record += 4 + pageSize + 4;
            }
            if (records == 0) break;
            offset = (record + sector - 1) / sector * sector;
        }
        return (page1, false);
    }

    /// <summary>Every Nendo instance ID the file's bytes carry, read in overlapping chunks.</summary>
    private static async Task<HashSet<string>> InstanceIdsInAsync(string path, CancellationToken cancellationToken)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        const int overlap = 41;
        var buffer = new byte[1 << 20];
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var carried = 0;
        while (true)
        {
            var read = await file.ReadAsync(buffer.AsMemory(carried, buffer.Length - carried), cancellationToken);
            if (read == 0) break;
            var filled = carried + read;
            foreach (Match match in InstanceIdPattern.Matches(Encoding.Latin1.GetString(buffer, 0, filled))) found.Add(match.Value);
            carried = Math.Min(overlap, filled);
            Buffer.BlockCopy(buffer, filled - carried, buffer, 0, carried);
        }
        return found;
    }

    /// <summary>
    /// Where the file and its journal are kept before a playback: beside the file, under names
    /// SQLite does not pair, so opening the kept copy never plays its journal back by accident.
    /// </summary>
    internal static string HeldStagePath(string path) =>
        $"{path}.before-rollback-{DateTime.UtcNow:yyyyMMddTHHmmssfff}.nendo-held";

    /// <summary>
    /// The complete copies kept before earlier playbacks of this file that are still beside it: a
    /// kept file and its kept journal, both. A copy is written under a temporary name and renamed
    /// only once whole, so a copy cut short never matches, and is never offered as restorable.
    /// </summary>
    internal static string[] HeldStages(string path)
    {
        try
        {
            return Directory.GetFiles(Path.GetDirectoryName(path)!, Path.GetFileName(path) + ".before-rollback-*.nendo-held")
                .Where(held => held.EndsWith(".nendo-held", StringComparison.Ordinal) && File.Exists(held + ".journal"))
                .Order(StringComparer.Ordinal).ToArray();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>What an inspection says about a kept copy, every time, until the person removes it.</summary>
    internal static NendoOpenFinding HeldStageFinding(string held) => new("interrupted-write-held",
        $"Nendo rolled back an unfinished save to this file and kept the file as it was before in {Path.GetFileName(held)}, with its " +
        $"journal in {Path.GetFileName(held)}.journal, in case the journal came from another copy of this file. Check that the file " +
        "holds what you expect. If something is missing, the journal was probably another copy's: rename the kept file alone to a name " +
        "ending .nendo and open it, since it is this file exactly as it was before. Once you have checked, you can delete both kept files.");

    /// <summary>
    /// Keeps the file and its journal under <paramref name="held"/>: each is copied to a temporary
    /// name and flushed, then renamed, the journal first, so the pair matches <see cref="HeldStages"/>
    /// only once both are whole. A copy cut short is removed, or left under its temporary name.
    /// </summary>
    internal static async Task KeepBeforePlaybackAsync(string path, string held, CancellationToken cancellationToken)
    {
        var suffix = $".partial-{Guid.NewGuid():N}";
        try
        {
            await CopyExactAsync(path, held + suffix, cancellationToken);
            await CopyExactAsync(path + "-journal", held + ".journal" + suffix, cancellationToken);
            File.Move(held + ".journal" + suffix, held + ".journal");
            File.Move(held + suffix, held);
        }
        catch
        {
            foreach (var partial in new[] { held + suffix, held + ".journal" + suffix, held + ".journal" })
                TryDelete(partial);
            throw;
        }
    }

    private static readonly AsyncLocal<Func<string, CancellationToken, Task>?> KeptCopyHook = new();

    /// <summary>A hook a test uses to stop a copy part way, for its own flow only; never set outside tests.</summary>
    internal static Func<string, CancellationToken, Task>? BeforeKeptCopyRenamed
    {
        get => KeptCopyHook.Value;
        set => KeptCopyHook.Value = value;
    }

    /// <summary>Copies a file byte for byte into a new file, flushed to disk.</summary>
    internal static async Task CopyExactAsync(string source, string destination, CancellationToken cancellationToken)
    {
        await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        await using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            await input.CopyToAsync(output, cancellationToken);
            await output.FlushAsync(cancellationToken);
            output.Flush(flushToDisk: true);
        }
        if (BeforeKeptCopyRenamed is { } hook) await hook(destination, cancellationToken);
    }

    /// <summary>
    /// Removes a copy made for a playback that did not happen, the kept file first, so a kept
    /// journal left behind is never named; a kept file that cannot be removed stays named.
    /// </summary>
    internal static void DiscardHeldStage(string held)
    {
        TryDelete(held);
        if (!File.Exists(held)) TryDelete(held + ".journal");
    }

    private static void TryDelete(string file)
    {
        try { File.Delete(file); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>
    /// Lets SQLite play a checked hot journal back, on one read-write connection with the bounded
    /// profile, by reading the schema: exactly what any SQLite connection would do. Answers null
    /// when it ran, or why it could not.
    /// </summary>
    internal static async Task<string?> RollBackHotJournalAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadWrite, cancellationToken);
            var store = new SqliteNendoStore(path, connection);
            await store.NonQueryAsync($"PRAGMA busy_timeout = {BusyTimeoutMilliseconds};", null, cancellationToken);
            _ = await store.ScalarAsync("SELECT COUNT(*) FROM sqlite_schema;", null, cancellationToken);
            return null;
        }
        catch (SqliteException exception)
        {
            return SqliteRefusal(exception);
        }
    }

    /// <summary>
    /// Clears a journal that holds nothing to roll back (empty, or a header that was never
    /// written): the file was never changed by it, and SQLite would overwrite it at its next write.
    /// It is removed only while this connection holds the file's RESERVED lock, which no writer
    /// can share, so a program still writing keeps its journal. Answers null when it was cleared,
    /// or why it was not.
    /// </summary>
    internal static async Task<string?> ClearEmptyJournalAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadWrite, cancellationToken);
            var store = new SqliteNendoStore(path, connection);
            await store.NonQueryAsync($"PRAGMA busy_timeout = {BusyTimeoutMilliseconds};", null, cancellationToken);
            using var transaction = connection.BeginTransaction(deferred: false);
            using (var journal = new FileStream(path + "-journal", FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var first = new byte[1];
                if (journal.Length > 0 && await journal.ReadAsync(first, cancellationToken) == 1 && first[0] != 0)
                    return JournalUnverifiableText;
            }
            File.Delete(path + "-journal");
            transaction.Rollback();
            return null;
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode is 5 or 6)
        {
            return JournalWriterText;
        }
        catch (SqliteException exception)
        {
            return SqliteRefusal(exception);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return JournalFileReadOnlyText;
        }
    }
}
