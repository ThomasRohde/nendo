using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A command runs on its own record type's record. The bridge's data.executeCommand
/// carries the record type the caller names, and the session refuses a command of another type
/// before anything is written. Held through the controller and the protocol handler only, with
/// no window.
/// </summary>
[TestClass]
public sealed class DesktopCommandRecordTypeTests
{
    [TestMethod]
    public async Task ACommandNamedWithARecordOfAnotherTypeIsRefusedAndWritesNothing()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("command-type-schema");
        var preview = await session.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await session.PromoteProposalAsync(preview.ProposalId)).Promotion.Applied);
        var created = await session.CreateIdeaRecordAsync("idea-1",
            new NendoIdeaDraft("A complete Idea", "Notes", "Exploring", "High", "2026-09-03", "Test the command"), "command-type-record");
        var version = created.Session!.Records.Single().RecordVersion;
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var refused = await handler.HandleAsync(await RequestAsync(session, "wrong-type", new
        {
            commandId = "command.idea.moveToTrying", entityId = "entity.dependency", recordId = "idea-1",
            expectedRecordVersion = version, idempotencyKey = "wrong-type",
        }));
        Assert.IsFalse(refused.Ok, "A command ran on a record of another type.");
        Assert.AreEqual("command-unavailable", refused.Error!.Code);
        Assert.AreEqual(
            "The command command.idea.moveToTrying runs on entity.idea records, and this call names a record of entity.dependency. Pass the record's own entityId.",
            refused.Error.Message);
        var record = (await session.GetViewAsync()).Records.Single();
        Assert.AreEqual((version, "Exploring"), (record.RecordVersion, record.Values[IdeaGarden.IdeaStatusFieldId].GetString()),
            "The refused command changed the record.");

        var ran = await handler.HandleAsync(await RequestAsync(session, "own-type", new
        {
            commandId = "command.idea.moveToTrying", entityId = IdeaGarden.IdeaEntityId, recordId = "idea-1",
            expectedRecordVersion = version, idempotencyKey = "own-type",
        }));
        Assert.IsTrue(ran.Ok, ran.Error?.Message);
        Assert.AreEqual("Trying", ((DesktopMutationView)ran.Result!).Session!.Records.Single()
            .Values[IdeaGarden.IdeaStatusFieldId].GetString());
    }

    private static async Task<string> RequestAsync(DesktopSessionController session, string requestId, object payload) =>
        JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId,
            method = WorkbenchMethods.DataExecuteCommand,
            fileSessionId = (await session.GetViewAsync()).FileSessionId,
            payload,
        });
}
