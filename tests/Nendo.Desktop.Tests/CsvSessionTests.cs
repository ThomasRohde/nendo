using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class CsvSessionTests
{
    [TestMethod]
    [DataRow("file.importCsv")]
    [DataRow("file.exportCsv")]
    public async Task FileSwitchDuringNativeCsvSelectionRejectsDelayedWork(string method)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var original = await session.CreateAsync(workspace.FilePath);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { },
            async request => {
                entered.SetResult(); await resume.Task;
                if (request.Action == WorkbenchFileAction.ImportCsv)
                    await session.PrepareCsvBatchAsync(NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("Text\nvalue")), "missing", [new(0, "f")], new(true), 0, Guid.NewGuid().ToString("N"));
                else await session.ExportCsvAsync("missing", new StringWriter());
                return new(null, null);
            });
        var pending = handler.HandleAsync(JsonSerializer.Serialize(new { protocolVersion = 6, requestId = "csv", fileSessionId = original.FileSessionId, method, payload = new { } }));
        await entered.Task; await session.CloseAsync(); var reopened = await session.OpenAsync(workspace.FilePath); resume.SetResult();
        var result = await pending;
        Assert.AreEqual("stale-file-session", result.Error?.Code);
        Assert.AreEqual(reopened.Manifest, (await session.GetViewAsync()).Manifest);
    }

    /// <summary>
    /// W-075: the native importer asks the session to put a tree's rows parents first before it
    /// cuts batches. The dialog itself is not driven by any lane; this measures what it calls.
    /// </summary>
    [TestMethod]
    public async Task TheSessionPutsATreesRowsParentsFirstAndKeepsTheirLines()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "seed"))
        {
            await coordinator.ApplyAsync(new("seed", "tree", "seed", "Tree", [
                new CreateEntityOperation("e", "caps", "Capabilities", "caps"),
                new AddFieldOperation("f-code", "caps", "code", "Code", "code", NendoStorageKind.Text, true),
                new AddFieldOperation("f-parent", "caps", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("bind", "caps", "parent", "caps", "code", 0),
            ]));
            var revision = (await new NendoApplicationService(coordinator).GetSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("seed", "declare", "seed", "Declare", [
                new SetFieldUniqueOperation("unique", "caps", "code", true, revision),
                new DeclareHierarchyOperation("tree", "caps", "parent", null, revision),
            ]));
        }
        await session.OpenAsync(workspace.FilePath);

        var document = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("Code,Parent\n1.1.1,1.1\n1.1,1\n1,\n"));
        var ordered = await session.OrderCsvParentsFirstAsync(document, "caps",
            [new(0, "code"), new(1, "parent") { MatchFieldId = "code" }]);

        CollectionAssert.AreEqual(new[] { "1", "1.1", "1.1.1" }, ordered.Rows.Select(row => row[0]).ToArray());
        CollectionAssert.AreEqual(new[] { 4, 3, 2 }, Enumerable.Range(0, 3).Select(ordered.SourceRowNumber).ToArray(),
            "A reordered row should keep the line it has in the file.");
    }
}
