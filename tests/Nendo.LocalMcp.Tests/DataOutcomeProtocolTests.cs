using System.Reflection;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DataOutcomeProtocolTests
{
    [TestMethod]
    public async Task LookupRejectsWrongFilesMalformedLocatorsAndCallerAuthorityWithoutWriting()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 0);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = Structured(await client.CallToolAsync("nendo.lease.acquire"));
        var locator = grant.GetProperty("receiptContext").GetString()!;
        Structured(await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?>
        { ["applicationHandle"] = grant.GetProperty("applicationHandle").GetString(), ["leaseId"] = grant.GetProperty("leaseId").GetString() }));
        var before = (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence;
        foreach (var malformed in new[] { "", "receipt-v1.*", new string('x', 1201),
                     "receipt-v1." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { scope = "studio.p2" })).TrimEnd('=') })
        {
            var rejected = await client.CallToolAsync("nendo.data.get_receipt", new Dictionary<string, object?>
            { ["receiptContext"] = malformed, ["idempotencyKey"] = "key" });
            Assert.IsTrue(rejected.IsError);
            Assert.Contains("NENDO_INVALID_REQUEST", JsonSerializer.Serialize(rejected));
        }
        var forged = await client.CallToolAsync("nendo.data.get_receipt", new Dictionary<string, object?>
        { ["receiptContext"] = locator, ["idempotencyKey"] = "key", ["owner"] = "another-agent" });
        Assert.IsTrue(forged.IsError);
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease);
        Assert.AreEqual(before, (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence);

        await using var other = new LocalMcpTestWorkspace();
        await other.CreateEmptyAsync();
        await using var otherHost = await NendoLocalMcpHost.StartAsync(other.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(other.DiscoveryRoot));
        await using var otherClient = await ProtocolResourceTests.ConnectAsync(otherHost);
        var mismatch = await otherClient.CallToolAsync("nendo.data.get_receipt", new Dictionary<string, object?>
        { ["receiptContext"] = locator, ["idempotencyKey"] = "key" });
        Assert.IsTrue(mismatch.IsError);
        Assert.Contains("NENDO_RECEIPT_FILE_MISMATCH", JsonSerializer.Serialize(mismatch));
        Assert.AreEqual(0L, (await other.Service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    [TestMethod]
    public async Task PrecommitFailureHasNoReceiptAndOriginalLeaseRetryCommitsOnce()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = Structured(await client.CallToolAsync("nendo.lease.acquire"));
        var before = (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence;
        var arguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = grant.GetProperty("applicationHandle").GetString(), ["leaseId"] = grant.GetProperty("leaseId").GetString(), ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["recordId"] = "idea-001", ["fieldId"] = NendoApplicationService.IdeaNotesFieldId,
            ["expectedRecordVersion"] = 1, ["value"] = "One retried effect", ["idempotencyKey"] = "precommit-fault",
        };
        var coordinator = Coordinator(workspace.Service);
        var seam = typeof(NendoWriteCoordinator).GetProperty("BeforeCommitAuthorityRead", BindingFlags.NonPublic | BindingFlags.Instance)!;
        seam.SetValue(coordinator, (Action)(() => throw new IOException("Owned precommit fault")));
        try { Assert.IsTrue((await client.CallToolAsync("nendo.data.set_field", arguments)).IsError); }
        finally { seam.SetValue(coordinator, null); }
        var missing = Structured(await client.CallToolAsync("nendo.data.get_receipt", new Dictionary<string, object?>
        { ["receiptContext"] = grant.GetProperty("receiptContext").GetString(), ["idempotencyKey"] = "precommit-fault" }));
        Assert.AreEqual("unresolved", missing.GetProperty("state").GetString());
        Assert.AreEqual(before, (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence);
        var retry = Structured(await client.CallToolAsync("nendo.data.set_field", arguments));
        Assert.IsFalse(retry.GetProperty("isIdempotentReplay").GetBoolean());
        var again = Structured(await client.CallToolAsync("nendo.data.set_field", arguments));
        Assert.AreEqual(retry.GetProperty("revisionId").GetString(), again.GetProperty("revisionId").GetString());
        Assert.AreEqual(before + 1, (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    [TestMethod]
    [DataRow(false, false)]
    [DataRow(true, false)]
    [DataRow(false, true)]
    [DataRow(true, true)]
    public async Task LostReplyResolvesAcrossReconnectWithoutTransferringTheLease(bool reopen, bool cancelHttp)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        var service = workspace.Service;
        var coordinator = Coordinator(service);
        var baseline = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;
        await using var host = await NendoLocalMcpHost.StartAsync(service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        string locator;
        string oldLease;
        string revisionId;
        await using (var client = await ProtocolResourceTests.ConnectAsync(host))
        {
            var grant = Structured(await client.CallToolAsync("nendo.lease.acquire"));
            Assert.IsTrue(grant.TryGetProperty("receiptContext", out var receiptContext),
                "The client needs a stable read-only locator before sending a mutation.");
            locator = receiptContext.GetString()!;
            oldLease = grant.GetProperty("leaseId").GetString()!;
            var arguments = new Dictionary<string, object?>
            {
                ["applicationHandle"] = grant.GetProperty("applicationHandle").GetString(), ["leaseId"] = oldLease, ["entityId"] = NendoApplicationService.IdeaEntityId,
                ["recordId"] = "idea-001", ["fieldId"] = NendoApplicationService.IdeaNotesFieldId,
                ["expectedRecordVersion"] = 1, ["value"] = "Saved despite lost response", ["idempotencyKey"] = "lost-reply",
            };
            if (cancelHttp)
            {
                var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                using var release = new ManualResetEventSlim();
                using var cancellation = new CancellationTokenSource();
                SetFault(coordinator, () => { entered.SetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Owned response-loss fixture was not released."); });
                try
                {
                    var call = client.CallToolAsync("nendo.data.set_field", arguments, cancellationToken: cancellation.Token);
                    await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
                    cancellation.Cancel();
                    await Assert.ThrowsAsync<OperationCanceledException>(async () => await call);
                }
                finally { release.Set(); SetFault(coordinator, null); }
            }
            else
            {
                SetFault(coordinator, () => throw new IOException("fixture " + workspace.FilePath));
                try
                {
                    var lost = await client.CallToolAsync("nendo.data.set_field", arguments);
                    Assert.IsTrue(lost.IsError);
                    Assert.DoesNotContain(workspace.FilePath, JsonSerializer.Serialize(lost));
                }
                finally { SetFault(coordinator, null); }
            }
            var repeated = Structured(await client.CallToolAsync("nendo.data.set_field", arguments));
            Assert.IsTrue(repeated.GetProperty("isIdempotentReplay").GetBoolean());
            revisionId = repeated.GetProperty("revisionId").GetString()!;
        }
        await host.DisposeAsync();
        NendoWriteCoordinator? restarted = null;
        try
        {
            if (reopen)
            {
                await coordinator.DisposeAsync();
                restarted = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "receipt-reopen");
                service = new NendoApplicationService(restarted);
            }
            await using var successorHost = await NendoLocalMcpHost.StartAsync(service, AgentAccessMode.DataMutation,
                new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
            await using var successor = await ProtocolResourceTests.ConnectAsync(successorHost);
            var receipt = Structured(await successor.CallToolAsync("nendo.data.get_receipt",
                new Dictionary<string, object?> { ["receiptContext"] = locator, ["idempotencyKey"] = "lost-reply" }));
            Assert.AreEqual("committed", receipt.GetProperty("state").GetString());
            Assert.AreEqual(revisionId, receipt.GetProperty("receipt").GetProperty("revisionId").GetString());
            Assert.IsFalse((await successorHost.GetLeaseStatusAsync()).HasLease);
            var rejectedLease = await successor.CallToolAsync("nendo.lease.renew",
                new Dictionary<string, object?> { ["leaseId"] = oldLease });
            Assert.IsTrue(rejectedLease.IsError);
            var missing = Structured(await successor.CallToolAsync("nendo.data.get_receipt",
                new Dictionary<string, object?> { ["receiptContext"] = locator, ["idempotencyKey"] = "not-sent" }));
            Assert.AreEqual("unresolved", missing.GetProperty("state").GetString());
            Assert.IsFalse(missing.TryGetProperty("receipt", out var missingReceipt) && missingReceipt.ValueKind != JsonValueKind.Null);
            Assert.AreEqual(baseline + 1, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
            Assert.IsTrue(successorHost.GetActivities().Any(item => item.Category == "receipt" && item.RevisionId == revisionId));
        }
        finally { if (restarted is not null) await restarted.DisposeAsync(); }
    }

    private static NendoWriteCoordinator Coordinator(NendoApplicationService service) =>
        (NendoWriteCoordinator)typeof(NendoApplicationService).GetField("_coordinator", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;

    private static void SetFault(NendoWriteCoordinator coordinator, Action? fault) =>
        typeof(NendoWriteCoordinator).GetProperty("AfterCommit", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(coordinator, fault);

    private static JsonElement Structured(CallToolResult result)
    {
        Assert.IsFalse(result.IsError ?? false, JsonSerializer.Serialize(result));
        Assert.IsNotNull(result.StructuredContent);
        return JsonSerializer.SerializeToElement(result.StructuredContent);
    }
}
