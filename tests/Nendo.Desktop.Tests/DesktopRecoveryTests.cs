using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DesktopRecoveryTests
{
    [TestMethod]
    public async Task OutsideChangeStopsAgentsAndKeepsPathFreeRecoveryWithoutReadingChangedRows()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discovery = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery");
        await using var session = new DesktopSessionController(new(discovery), workspace.FileHistoryRoot);
        var created = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("idea-1", "Trusted", "record");
        var proposal = await session.PrepareIdeaGardenProposalAsync();
        await session.SetAgentModeAsync("shapeApp");
        Assert.HasCount(1, Directory.GetFiles(discovery, "*.json"));
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE idea SET title = 'Outside' WHERE __nendo_record_id = 'idea-1';";
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() =>
            session.SetIdeaTitleAsync("idea-1", 1, "Denied", "edit"));
        // Cleanup runs without a view/status poll. Only observe the owned test
        // discovery directory; no desktop input or production device state.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (Directory.GetFiles(discovery, "*.json").Length != 0)
            await Task.Delay(20, timeout.Token);
        var recovery = await session.GetViewAsync();
        Assert.IsTrue(recovery.HasFile);
        Assert.AreEqual("recoveryRequired", recovery.Health);
        Assert.AreEqual(created.FileSessionId, recovery.FileSessionId);
        Assert.AreEqual("authority-lost", recovery.Findings.Single().Code);
        Assert.IsFalse(recovery.Capabilities.ReadData);
        Assert.IsFalse(recovery.Capabilities.AgentAccess);
        Assert.IsEmpty(recovery.Entities);
        Assert.IsEmpty(recovery.Records);
        Assert.IsEmpty(recovery.UiNodes);
        Assert.IsNull(recovery.Manifest);
        Assert.DoesNotContain(JsonEncodedText.Encode(Path.GetDirectoryName(workspace.FilePath)!).ToString(), JsonSerializer.Serialize(recovery));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        Assert.IsFalse((await session.SetAgentModeAsync("off")).Available);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.SetAgentModeAsync("inspect"));
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => session.GetHistoryAsync());
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => session.GetProposalAsync(proposal.ProposalId));
        await session.CloseAsync();
        var inspected = await session.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreNotEqual(created.FileSessionId, inspected.FileSessionId);
        Assert.AreEqual("readOnly", inspected.Health);
        Assert.IsTrue(inspected.Capabilities.ReadData);
        Assert.AreEqual("Outside", inspected.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual("readOnly", (await session.GetAgentStatusAsync()).State);
    }
}
