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
}
