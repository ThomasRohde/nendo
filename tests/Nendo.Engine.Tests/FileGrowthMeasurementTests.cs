using System.Diagnostics;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// W-038 / C-051, the measurement half. F-040 reasoned that the audit lane multiplies
/// stored text by roughly three -- the row holds it, the canonical operation that wrote
/// it holds it again, and inverse evidence sits beside that -- and said plainly that the
/// arithmetic had never been measured. This measures it: records of a known payload size
/// through the ordinary write path, the size on disk after each batch, the audit rows the
/// open path counts, and what one open costs at each size the limit could be set to.
/// <para>
/// Not an assertion, and not a lane that runs by itself. It writes a quarter of a gigabyte
/// and takes minutes. Run it explicitly when the bound is being chosen.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class FileGrowthMeasurementTests
{
    private const int BodyCharacters = 1_300;
    private const int BatchSize = NendoApplicationService.MaximumBatchRecords;
    private const int Records = 74_000;
    private const int ReportEvery = 5_000;
    private static readonly long[] OpenAtBytes =
        [16L * 1024 * 1024, 32L * 1024 * 1024, 64L * 1024 * 1024, 128L * 1024 * 1024, 250L * 1024 * 1024];

    [TestMethod]
    [Ignore("Measurement harness for W-038, not an assertion. It writes 250 MiB and takes about a minute. Remove this line to run it when the bound is being chosen again.")]
    public async Task WhatOneRecordCostsOnDiskAndWhatOneOpenCosts()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("measure", "schema", "measure", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("n-body", "notes", "body", "Body", "body", NendoStorageKind.Text, false),
        ]));

        var body = new string('x', BodyCharacters);
        var empty = new FileInfo(workspace.FilePath).Length;
        var payloadPerRecord = 0L;
        var nextOpen = 0;
        Console.WriteLine($"MEASURE empty file: {empty} bytes");
        Console.WriteLine("MEASURE records,bytes,bytesPerRecord,payloadBytes,multiple,operationRows,revisionRows");

        for (var written = 0; written < Records; written += BatchSize)
        {
            var entries = new List<NendoCreateRecordEntry>(BatchSize);
            for (var index = 0; index < BatchSize; index++)
            {
                var title = $"Note {written + index}";
                if (payloadPerRecord == 0) payloadPerRecord = title.Length + body.Length;
                entries.Add(new($"n{written + index}",
                    new Dictionary<string, object?> { ["title"] = title, ["body"] = body }));
            }
            await service.CreateRecordsAsync(new("notes", entries,
                new NendoRequestContext("measure", $"batch-{written}", "measure")));

            var count = written + BatchSize;
            var bytes = new FileInfo(workspace.FilePath).Length;
            if (count % ReportEvery == 0)
            {
                var perRecord = (double)(bytes - empty) / count;
                Console.WriteLine(
                    $"MEASURE {count},{bytes},{perRecord:F0},{payloadPerRecord}," +
                    $"{(perRecord / payloadPerRecord).ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}," +
                    $"{await RowsAsync(workspace.FilePath, "__nendo_operation")}," +
                    $"{await RowsAsync(workspace.FilePath, "__nendo_revision")}");
            }

            // What the bound is actually bounding: one cold open, which runs the whole
            // inspection. Measured at each size the limit could plausibly be set to.
            if (nextOpen >= OpenAtBytes.Length || bytes < OpenAtBytes[nextOpen]) continue;
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            var clock = Stopwatch.StartNew();
            coordinator = await workspace.OpenAsync($"measure-{nextOpen}");
            clock.Stop();
            service = new NendoApplicationService(coordinator);
            Console.WriteLine($"MEASURE-OPEN {bytes},{count},{clock.ElapsedMilliseconds}");
            nextOpen++;
        }
    }

    /// <summary>
    /// The audit tables the open path counts against <c>MaximumInspectionRows</c>. Read
    /// directly here because the measurement is about what the file holds, not about what
    /// a service chooses to project from it. Pooling is off so the read releases the file.
    /// </summary>
    private static async Task<long> RowsAsync(string path, string table)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM \"{table}\";";
        return (long)(await command.ExecuteScalarAsync())!;
    }
}
