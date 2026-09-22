using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class FormSaveOutcomeTests
{
    [TestMethod]
    public async Task FormSaveIsOneRevisionWithExactRetryAndWholeFormCompensationAfterReopen()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await SeedAsync(session, workspace.FilePath);
        var before = await session.GetViewAsync();
        var saved = await SaveAsync(session, Values(), "form-save");
        Assert.IsTrue(saved.Ok, saved.Error?.Message);
        var receipt = ((DesktopMutationView)saved.Result!).Mutation;
        var after = await session.GetViewAsync();
        Assert.AreEqual(before.Manifest!.ChangeSequence + 1, after.Manifest!.ChangeSequence);
        Assert.AreEqual(3L, after.Records.Single().RecordVersion);
        var history = await session.GetHistoryAsync();
        Assert.HasCount(2, history.Single(revision => revision.RevisionId == receipt.RevisionId).Operations);
        await session.CloseAsync();
        await session.OpenAsync(workspace.FilePath);
        var replay = await SaveAsync(session, Values(reverse: true), "form-save");
        Assert.IsTrue(replay.Ok, replay.Error?.Message);
        Assert.AreEqual(receipt with { IsIdempotentReplay = true }, ((DesktopMutationView)replay.Result!).Mutation);
        var conflict = await SaveAsync(session, Values(title: "Different"), "form-save");
        Assert.AreEqual("idempotency-conflict", conflict.Error!.Code);
        var compensation = await session.CompensateRevisionAsync(receipt.RevisionId, "compensate-form");
        var restored = (await session.GetViewAsync()).Records.Single();
        Assert.AreEqual(5L, restored.RecordVersion);
        Assert.AreEqual("Before", restored.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual("Original notes", restored.Values[NendoApplicationService.IdeaNotesFieldId].GetString());
        await session.SetFieldAsync(NendoApplicationService.IdeaEntityId, "record", NendoApplicationService.IdeaTitleFieldId,
            5, "Later", "later-edit");
        var repeated = await session.CompensateRevisionAsync(receipt.RevisionId, "compensate-form");
        Assert.AreEqual(compensation.Mutation with { IsIdempotentReplay = true }, repeated.Mutation);
        Assert.AreEqual("Later", (await session.GetViewAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
    }

    [TestMethod]
    [DataRow("invalid-last-field", "validation")]
    [DataRow("stale-record", "record-version-conflict")]
    [DataRow("empty", "validation")]
    public async Task RejectedFormLeavesEveryFieldVersionAndRevisionUnchanged(string kind, string code)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await SeedAsync(session, workspace.FilePath);
        var before = await session.GetViewAsync();
        var values = kind == "empty" ? new Dictionary<string, object?>() : Values(title: kind == "invalid-last-field" ? null : "Changed");
        var result = await SaveAsync(session, values, "rejected", version: kind == "stale-record" ? 8 : 1);
        Assert.AreEqual(code, result.Error?.Code);
        var after = await session.GetViewAsync();
        Assert.AreEqual(before.Manifest, after.Manifest);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
        Assert.IsNull(await session.GetMutationReceiptAsync("rejected", false));
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task CommitFaultCanBeResolvedAndRetriedWithoutPartialForm(bool afterCommit)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await SeedAsync(session, workspace.FilePath);
        var before = await session.GetViewAsync();
        var coordinator = (NendoWriteCoordinator)typeof(DesktopSessionController)
            .GetField("_coordinator", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(session)!;
        var seam = typeof(NendoWriteCoordinator).GetProperty(afterCommit ? "AfterCommit" : "BeforeCommitAuthorityRead",
            BindingFlags.NonPublic | BindingFlags.Instance)!;
        seam.SetValue(coordinator, (Action)(() => throw new IOException("Form outcome fault")));
        var failed = await SaveAsync(session, Values(), "lost-form");
        Assert.AreEqual("file-io", failed.Error?.Code);
        seam.SetValue(coordinator, null);
        var receipt = await session.GetMutationReceiptAsync("lost-form", false);
        Assert.AreEqual(afterCommit, receipt is not null);
        var after = await session.GetViewAsync();
        Assert.AreEqual(before.Manifest!.ChangeSequence + (afterCommit ? 1 : 0), after.Manifest!.ChangeSequence);
        Assert.AreEqual(afterCommit ? 3L : 1L, after.Records.Single().RecordVersion);
        await session.CloseAsync();
        await session.OpenAsync(workspace.FilePath);
        var retry = await SaveAsync(session, Values(), "lost-form");
        Assert.IsTrue(retry.Ok, retry.Error?.Message);
        if (receipt is not null) Assert.AreEqual(receipt.RevisionId, ((DesktopMutationView)retry.Result!).Mutation.RevisionId);
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, (await session.GetViewAsync()).Manifest!.ChangeSequence);
    }

    private static Dictionary<string, object?> Values(string? title = "Changed", bool reverse = false)
    {
        var values = new Dictionary<string, object?>
        {
            [NendoApplicationService.IdeaNotesFieldId] = "Updated notes",
            [NendoApplicationService.IdeaTitleFieldId] = title,
        };
        return reverse ? values.Reverse().ToDictionary(pair => pair.Key, pair => pair.Value) : values;
    }

    private static async Task SeedAsync(DesktopSessionController session, string path)
    {
        await session.CreateAsync(path);
        await session.CreateIdeaSchemaAsync("schema");
        var definition = await session.PrepareIdeaGardenProposalAsync();
        await session.PromoteProposalAsync(definition.ProposalId);
        await session.CreateRecordAsync(NendoApplicationService.IdeaEntityId, "record",
            new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "Before",
                [NendoApplicationService.IdeaNotesFieldId] = "Original notes",
                [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                [NendoApplicationService.IdeaCreatedDateFieldId] = "2026-09-05",
            }, "create");
    }

    private static async Task<WorkbenchResponse> SaveAsync(DesktopSessionController session,
        Dictionary<string, object?> values, string key, long version = 1)
    {
        var snapshot = await session.GetViewAsync();
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });
        return await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = 5, requestId = Guid.NewGuid().ToString("N"), method = "data.setFields", snapshot.FileSessionId,
            payload = new { entityId = NendoApplicationService.IdeaEntityId, recordId = "record", values,
                expectedRecordVersion = version, idempotencyKey = key },
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }
}
