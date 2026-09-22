using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopOutcomeTests
{
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task AcceptanceMustMatchTheReviewedDigestIncludingCommittedRetries(bool alreadyApplied)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        var preview = await session.PrepareIdeaGardenProposalAsync();
        if (alreadyApplied) await session.PromoteProposalAsync(preview.ProposalId);
        var snapshot = await session.GetViewAsync();
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });
        var response = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = 5, requestId = "wrong-preview", fileSessionId = snapshot.FileSessionId,
            method = "proposal.promote", payload = new { preview.ProposalId, expectedOperationDigest = new string('0', 64) },
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        Assert.AreEqual("idempotency-conflict", response.Error?.Code);
        Assert.AreEqual(snapshot.Manifest, (await session.GetViewAsync()).Manifest);
    }

    [TestMethod]
    [DataRow("data")]
    [DataRow("proposal")]
    [DataRow("compensation")]
    public async Task ReceiptQuerySurvivesReopenAndStillRequiresCurrentFileBinding(string kind)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var opened = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        string receiptId;
        string method;
        object payload;
        if (kind == "proposal")
        {
            var preview = await session.PrepareIdeaGardenProposalAsync();
            var saved = await session.PromoteProposalAsync(preview.ProposalId);
            receiptId = saved.Promotion.Result!.Revisions.Single().RevisionId;
            method = WorkbenchMethods.ProposalGetReceipt;
            payload = new { proposalId = preview.ProposalId };
        }
        else
        {
            var saved = await session.CreateRecordAsync(NendoApplicationService.IdeaEntityId, "record",
                new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "One effect" }, "receipt-key");
            if (kind == "compensation")
            {
                var edit = await session.SetFieldAsync(NendoApplicationService.IdeaEntityId, "record",
                    NendoApplicationService.IdeaTitleFieldId, 1, "Reversible edit", "edit-for-compensation");
                saved = await session.CompensateRevisionAsync(edit.Mutation.RevisionId, "receipt-key");
            }
            receiptId = saved.Mutation.RevisionId;
            method = kind == "compensation" ? WorkbenchMethods.CompensationGetReceipt : WorkbenchMethods.DataGetReceipt;
            payload = new { idempotencyKey = "receipt-key" };
        }
        await session.CloseAsync();
        var reopened = await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });
        string Message(string? fileSessionId, int protocolVersion = 5) => JsonSerializer.Serialize(new
        { protocolVersion, requestId = Guid.NewGuid().ToString("N"), method, fileSessionId, payload });
        var stale = await handler.HandleAsync(Message(opened.FileSessionId));
        Assert.AreEqual("stale-file-session", stale.Error!.Code);
        var legacy = await handler.HandleAsync(Message(reopened.FileSessionId, 4));
        Assert.AreEqual("unknown-method", legacy.Error!.Code);
        var resolved = await handler.HandleAsync(Message(reopened.FileSessionId));
        Assert.IsTrue(resolved.Ok, resolved.Error?.Message);
        var receipt = kind == "proposal" ? ((NendoChangeSetApplyResult)resolved.Result!).Revisions.Single()
            : (NendoApplyResult)resolved.Result!;
        Assert.AreEqual(receiptId, receipt.RevisionId);
        Assert.IsTrue(receipt.IsIdempotentReplay);
        var serialized = WorkbenchProtocolHandler.Serialize(resolved);
        Assert.DoesNotContain(workspace.FilePath, serialized);
        Assert.DoesNotContain("idempotencyScope", serialized);
        Assert.AreEqual(reopened.Manifest!.ChangeSequence, (await session.GetViewAsync()).Manifest!.ChangeSequence);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task CancellationAfterCommitReturnsReceiptAndReopenRetryHasOneEffect(bool proposal)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("outcome-schema");
        var preview = proposal ? await session.PrepareIdeaGardenProposalAsync() : null;
        using var cancellation = new CancellationTokenSource();
        var coordinator = (NendoWriteCoordinator)typeof(DesktopSessionController)
            .GetField("_coordinator", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(session)!;
        typeof(NendoWriteCoordinator).GetProperty("AfterCommit", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(coordinator, (Action)cancellation.Cancel);
        string revisionId;
        if (proposal)
        {
            var saved = await session.PromoteProposalAsync(preview!.ProposalId, cancellation.Token);
            Assert.IsTrue(saved.Promotion.Applied);
            Assert.IsNull(saved.Session);
            Assert.IsNotNull(saved.RefreshNotice);
            revisionId = saved.Promotion.Result!.Revisions.Single().RevisionId;
        }
        else
        {
            var saved = await session.CreateRecordAsync(NendoApplicationService.IdeaEntityId, "receipt-record",
                new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "Saved once" },
                "receipt-create", cancellation.Token);
            revisionId = saved.Mutation.RevisionId;
            Assert.IsNull(saved.Session);
            Assert.IsNotNull(saved.RefreshNotice);
        }
        await session.CloseAsync();
        var reopened = await session.OpenAsync(workspace.FilePath);
        var sequence = reopened.Manifest!.ChangeSequence;
        if (proposal)
        {
            var repeated = await session.PromoteProposalAsync(preview!.ProposalId);
            Assert.AreEqual(revisionId, repeated.Promotion.Result!.Revisions.Single().RevisionId);
        }
        else
        {
            var repeated = await session.CreateRecordAsync(NendoApplicationService.IdeaEntityId, "receipt-record",
                new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "Saved once" },
                "receipt-create");
            Assert.AreEqual(revisionId, repeated.Mutation.RevisionId);
        }
        Assert.AreEqual(sequence, (await session.GetViewAsync()).Manifest!.ChangeSequence);
    }
}
