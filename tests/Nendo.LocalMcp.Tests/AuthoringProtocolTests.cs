using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class AuthoringProtocolTests
{
    [TestMethod]
    public async Task DirectAuthoringBoundaryBuildsAReadingQueuePreview()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var host = new NendoHostAuthority(
            "authoring-test-run",
            AgentAccessMode.ApplicationAuthoring,
            new byte[32],
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        var authority = new NendoAgentAuthority(
            host,
            new SystemNendoClock(),
            NendoAgentAuthority.ProductionLeaseTtl);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId);
        var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        const string sessionId = "direct-authoring-session";
        var lease = await authority.AcquireAsync(sessionId, "test client", CancellationToken.None);
        var begun = await authoring.BeginAsync(
            sessionId,
            lease.LeaseId,
            "Reading Queue",
            "direct-begin",
            CancellationToken.None);
        var addOrdinal = 0;
        foreach (var chunk in ReadingQueueAuthoringFixture.Operations().Chunk(16))
        {
            await authoring.AddOperationsAsync(
                sessionId,
                lease.LeaseId,
                begun.ChangeSetId,
                [new NendoAgentMutationInput("Shape the Reading Queue", chunk)],
                $"direct-add-{addOrdinal++:D2}",
                CancellationToken.None);
        }

        var preview = await authoring.ValidateAsync(
            sessionId,
            lease.LeaseId,
            begun.ChangeSetId,
            "direct-validate",
            CancellationToken.None);

        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.HasCount(1, proposals.Snapshot());
    }

    [TestMethod]
    public async Task ReadingQueueProposalChangesNothingUntilHostPromotesAfterDisconnect()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposals = new NendoAgentProposalStore();
        var before = await workspace.Service.GetSnapshotAsync();
        var historyBefore = await workspace.Service.GetHistoryAsync();
        var bytesBefore = await ReadBytesSharedAsync(workspace.FilePath);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        var client = await ProtocolResourceTests.ConnectAsync(host);
        var tools = await client.ListToolsAsync();
        Assert.IsFalse(tools.Any(tool =>
            tool.Name.Contains("promote", StringComparison.OrdinalIgnoreCase) ||
            tool.Name.Contains("accept", StringComparison.OrdinalIgnoreCase)));
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));

        var beginArguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["title"] = "Reading Queue",
            ["idempotencyKey"] = "begin-reading-queue",
        };
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync(
            "nendo.change_set.begin",
            beginArguments));
        var beginRetry = Result<NendoChangeSetBeginResult>(await client.CallToolAsync(
            "nendo.change_set.begin",
            beginArguments));
        Assert.AreEqual(begun.ChangeSetId, beginRetry.ChangeSetId);
        await AssertToolErrorAsync(
            client,
            "nendo.change_set.begin",
            new Dictionary<string, object?>(beginArguments, StringComparer.Ordinal)
            {
                ["title"] = "Altered title",
            },
            "NENDO_IDEMPOTENCY_CONFLICT");

        var operations = ReadingQueueAuthoringFixture.Operations();
        var addOrdinal = 0;
        NendoChangeSetAddResult? lastAdd = null;
        foreach (var chunk in operations.Chunk(16))
        {
            var arguments = AddArguments(
                lease,
                begun.ChangeSetId,
                chunk,
                $"add-reading-queue-{addOrdinal:D2}");
            lastAdd = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
                "nendo.change_set.add_operations",
                arguments));
            if (addOrdinal == 0)
            {
                var retry = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
                    "nendo.change_set.add_operations",
                    arguments));
                Assert.AreEqual(lastAdd.OperationCount, retry.OperationCount);
            }
            addOrdinal++;
        }
        Assert.IsNotNull(lastAdd);
        Assert.AreEqual(operations.Count, lastAdd.OperationCount);

        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
            "nendo.change_set.validate",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["idempotencyKey"] = "validate-reading-queue",
            }));
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
            "nendo.change_set.preview",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
            }));
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);
        Assert.AreEqual(validated.OperationDigest, preview.OperationDigest);
        Assert.AreEqual("Reading item", preview.Preview.Entities.Single().DisplayName);
        Assert.IsTrue(
            preview.Preview.Surfaces.Any(surface => surface.Kind == "recordList" && surface.Title == "Reading queue"),
            "The review summary does not name the list this proposal builds.");
        Assert.AreEqual(operations.Count, preview.OperationCount);
        Assert.IsFalse(JsonSerializer.Serialize(preview).Contains("applicationId", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(JsonSerializer.Serialize(preview).Contains("instanceId", StringComparison.OrdinalIgnoreCase));

        var stillActive = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, stillActive.Manifest.ChangeSequence);
        Assert.HasCount(historyBefore.Count, await workspace.Service.GetHistoryAsync());
        CollectionAssert.AreEqual(bytesBefore, await ReadBytesSharedAsync(workspace.FilePath));

        Result<NendoLeaseRelease>(await client.CallToolAsync("nendo.lease.release",
            new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId }));
        await client.DisposeAsync();
        Assert.HasCount(1, proposals.Snapshot());
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease);
        await host.DisposeAsync();
        Assert.IsFalse(host.IsReady);
        Assert.HasCount(1, proposals.Snapshot());
        var outcome = await proposals.PromoteAsync(workspace.Service, validated.ProposalId);
        Assert.IsTrue(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Active, outcome.State);
        Assert.IsEmpty(proposals.Snapshot());

        var active = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual(ReadingQueueAuthoringFixture.EntityId, active.Entities.Single().EntityId);
        var compilation = await workspace.Service.CompileSemanticUiAsync();
        Assert.IsTrue(compilation.IsValid);
        Assert.AreEqual("Reading queue", compilation.Applications.Single().Surfaces.Single(node => node.Kind == "recordList").Properties["title"].GetString());
    }

    [TestMethod]
    public async Task ProtocolRejectIsIdempotentAndDraftCountIsBounded()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var authored = await CreateReadingQueuePreviewAsync(client, lease, "protocol-reject");
        var preview = authored.Preview;
        var pending = host.GetPendingProposals().Single();
        Assert.AreEqual(preview.ProposalId, pending.ProposalId);
        var rejectArguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["changeSetId"] = authored.ChangeSetId,
            ["idempotencyKey"] = "reject-preview",
        };
        var rejected = Result<NendoChangeSetRejectResult>(await client.CallToolAsync(
            "nendo.change_set.reject",
            rejectArguments));
        var retry = Result<NendoChangeSetRejectResult>(await client.CallToolAsync(
            "nendo.change_set.reject",
            rejectArguments));
        Assert.AreEqual(rejected, retry);
        Assert.IsEmpty(host.GetPendingProposals());

        for (var index = 0; index < 8; index++)
        {
            _ = await BeginAsync(client, lease, $"Draft {index}", $"draft-{index}");
        }
        await AssertToolErrorAsync(
            client,
            "nendo.change_set.begin",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["title"] = "Ninth draft",
                ["idempotencyKey"] = "draft-9",
            },
            "NENDO_DRAFT_LIMIT");
    }

    [TestMethod]
    public async Task HostCanRejectPreviewAfterDisconnectWithoutChangingActiveFile()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposals = new NendoAgentProposalStore();
        var before = await workspace.Service.GetSnapshotAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var preview = (await CreateReadingQueuePreviewAsync(client, lease, "reject")).Preview;

        await client.DisposeAsync();
        var outcome = await proposals.RejectAsync(workspace.Service, preview.ProposalId);
        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Rejected, outcome.State);
        Assert.IsEmpty(proposals.Snapshot());
        var after = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.IsEmpty(after.Entities);
    }

    [TestMethod]
    public async Task ProposalCanCreateThenEditItsOwnRecordInOrder()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(1);
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = await BeginAsync(client, lease, "Create and refine an idea", "begin-create-edit");
        const string recordId = "idea-created-in-proposal";
        var create = new NendoAgentOperationInput(
            "data.createRecord",
            JsonSerializer.SerializeToElement(new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                recordId,
                values = new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = "Initial title",
                },
            }));
        var edit = new NendoAgentOperationInput(
            "data.setField",
            JsonSerializer.SerializeToElement(new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                recordId,
                fieldId = NendoApplicationService.IdeaTitleFieldId,
                expectedRecordVersion = 1,
                value = "Edited title",
            }));
        _ = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
            "nendo.change_set.add_operations",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle,
                ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["mutations"] = new[]
                {
                    new NendoAgentMutationInput("Create the record", [create]),
                    new NendoAgentMutationInput("Refine the record", [edit]),
                },
                ["idempotencyKey"] = "add-create-edit",
            }));

        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
            "nendo.change_set.validate",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle,
                ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["idempotencyKey"] = "validate-create-edit",
            }));

        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.IsFalse((await workspace.Service.GetSnapshotAsync()).Records.Any(record => record.RecordId == recordId));
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);
        var created = (await workspace.Service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);
        Assert.AreEqual(2, created.RecordVersion);
        Assert.AreEqual("Edited title", created.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
    }

    [TestMethod]
    public async Task DraftIsSessionBoundBoundedAndStalesWhenDefinitionChanges()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        await using var otherSession = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = await BeginAsync(client, lease, "Stale draft", "begin-stale");

        await AssertToolErrorAsync(
            otherSession,
            "nendo.change_set.add_operations",
            AddArguments(
                lease with { ApplicationHandle = "unknown-handle" },
                begun.ChangeSetId,
                [ReadingQueueAuthoringFixture.Operations()[0]],
                "copied-draft"),
            "NENDO_INVALID_LEASE");

        await AssertToolErrorAsync(
            client,
            "nendo.change_set.add_operations",
            AddArguments(
                lease,
                begun.ChangeSetId,
                Enumerable.Repeat(ReadingQueueAuthoringFixture.Operations()[0], 17).ToArray(),
                "too-many-operations"),
            "NENDO_CHANGE_SET_LIMIT");

        await AssertToolErrorAsync(
            client,
            "nendo.change_set.add_operations",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["mutations"] = Enumerable.Range(0, 9)
                    .Select(index => new NendoAgentMutationInput(
                        $"Mutation {index}",
                        [ReadingQueueAuthoringFixture.Operations()[0]]))
                    .ToArray(),
                ["idempotencyKey"] = "too-many-mutations",
            },
            "NENDO_CHANGE_SET_LIMIT");

        await AssertToolErrorAsync(
            client,
            "nendo.change_set.add_operations",
            AddArguments(
                lease,
                begun.ChangeSetId,
                [new NendoAgentOperationInput(
                    "process.run",
                    JsonSerializer.SerializeToElement(new { command = "no" }))],
                "unknown-operation"),
            "NENDO_UNKNOWN_OPERATION");

        await AssertToolErrorAsync(
            client,
            "nendo.change_set.add_operations",
            AddArguments(
                lease,
                begun.ChangeSetId,
                [new NendoAgentOperationInput(
                    "schema.createEntity",
                    JsonSerializer.SerializeToElement(new
                    {
                        entityId = "entity.forbidden",
                        displayName = "Forbidden",
                        physicalTableName = "must_not_cross_boundary",
                    }))],
                "forbidden-physical-name"),
            "NENDO_INVALID_REQUEST");

        _ = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
            "nendo.change_set.add_operations",
            AddArguments(
                lease,
                begun.ChangeSetId,
                [ReadingQueueAuthoringFixture.Operations()[0]],
                "valid-operation")));
        await workspace.Service.CreateIdeaSchemaAsync("definition-changed");
        await AssertToolErrorAsync(
            client,
            "nendo.change_set.validate",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["idempotencyKey"] = "validate-stale",
            },
            "NENDO_CHANGE_SET_STALE");
        Assert.IsEmpty(host.GetPendingProposals());
    }

    [TestMethod]
    public async Task ProtocolCannotAuthorIdentityTransitionsOrDiscoverFileLifecycleTools()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var before = await ReadBytesSharedAsync(workspace.FilePath);
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var tools = await client.ListToolsAsync();
        Assert.IsFalse(tools.Any(tool => new[] { "identity", "duplicate", "fork", "backup", "restore" }
            .Any(name => tool.Name.Contains(name, StringComparison.OrdinalIgnoreCase))));
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var draft = await BeginAsync(client, lease, "Forbidden file transition", "begin-forbidden");
        await AssertToolErrorAsync(client, "nendo.change_set.add_operations",
            AddArguments(lease, draft.ChangeSetId,
                [new("identity.transition", JsonSerializer.SerializeToElement(new
                {
                    kind = "Fork", resultApplicationId = "application-forbidden", resultInstanceId = "instance-forbidden",
                    requestDigest = new string('A', 64),
                    source = new { applicationId = manifest.ApplicationId, instanceId = manifest.InstanceId,
                        definitionRevision = 0, dataRevision = 0, changeSequence = 0 },
                }))], "identity-attempt"), "NENDO_UNKNOWN_OPERATION");
        Assert.IsEmpty(host.GetPendingProposals());
        Assert.AreEqual(manifest, (await workspace.Service.GetSnapshotAsync()).Manifest);
        CollectionAssert.AreEqual(before, await ReadBytesSharedAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task CompleteDraftLimitsAreExactly32MutationsAnd128Operations()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var host = new NendoHostAuthority(
            "limits-test-run",
            AgentAccessMode.ApplicationAuthoring,
            new byte[32],
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        var authority = new NendoAgentAuthority(
            host,
            new SystemNendoClock(),
            NendoAgentAuthority.ProductionLeaseTtl);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId);
        var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        const string sessionId = "limits-session";
        var lease = await authority.AcquireAsync(sessionId, "test client", CancellationToken.None);
        var operation = ReadingQueueAuthoringFixture.Operations()[0];

        var operationDraft = await authoring.BeginAsync(
            sessionId,
            lease.LeaseId,
            "Operation limit",
            "begin-operation-limit",
            CancellationToken.None);
        NendoChangeSetAddResult? operationResult = null;
        for (var index = 0; index < 8; index++)
        {
            operationResult = await authoring.AddOperationsAsync(
                sessionId,
                lease.LeaseId,
                operationDraft.ChangeSetId,
                [new NendoAgentMutationInput(
                    $"Operation batch {index}",
                    Enumerable.Repeat(operation, 16).ToArray())],
                $"operation-batch-{index}",
                CancellationToken.None);
        }
        Assert.IsNotNull(operationResult);
        Assert.AreEqual(128, operationResult.OperationCount);
        await Assert.ThrowsExactlyAsync<NendoAgentAuthoringException>(() =>
            authoring.AddOperationsAsync(
                sessionId,
                lease.LeaseId,
                operationDraft.ChangeSetId,
                [new NendoAgentMutationInput("Operation 129", [operation])],
                "operation-129",
                CancellationToken.None));

        var mutationDraft = await authoring.BeginAsync(
            sessionId,
            lease.LeaseId,
            "Mutation limit",
            "begin-mutation-limit",
            CancellationToken.None);
        NendoChangeSetAddResult? mutationResult = null;
        for (var index = 0; index < 4; index++)
        {
            mutationResult = await authoring.AddOperationsAsync(
                sessionId,
                lease.LeaseId,
                mutationDraft.ChangeSetId,
                Enumerable.Range(0, 8)
                    .Select(ordinal => new NendoAgentMutationInput(
                        $"Mutation {index}-{ordinal}",
                        [operation]))
                    .ToArray(),
                $"mutation-batch-{index}",
                CancellationToken.None);
        }
        Assert.IsNotNull(mutationResult);
        Assert.AreEqual(32, mutationResult.MutationCount);
        await Assert.ThrowsExactlyAsync<NendoAgentAuthoringException>(() =>
            authoring.AddOperationsAsync(
                sessionId,
                lease.LeaseId,
                mutationDraft.ChangeSetId,
                [new NendoAgentMutationInput("Mutation 33", [operation])],
                "mutation-33",
                CancellationToken.None));
    }

    [TestMethod]
    public async Task LeaseExpiryDiscardsPrivateDraftBeforeAReplacementLease()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var clock = new AuthoringTestClock(
            new DateTimeOffset(2026, 9, 3, 12, 0, 0, TimeSpan.Zero));
        var host = new NendoHostAuthority(
            "expiry-test-run",
            AgentAccessMode.ApplicationAuthoring,
            new byte[32],
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        var authority = new NendoAgentAuthority(host, clock, TimeSpan.FromSeconds(10));
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId);
        var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        authority.SetLeaseEndedHandler(authoring.DiscardSessionAsync);
        const string sessionId = "expiry-session";
        var lease = await authority.AcquireAsync(sessionId, "test client", CancellationToken.None);
        var draft = await authoring.BeginAsync(
            sessionId,
            lease.LeaseId,
            "Expiring draft",
            "begin-expiring",
            CancellationToken.None);

        clock.Advance(TimeSpan.FromSeconds(11));
        Assert.IsFalse((await authority.GetStatusAsync(CancellationToken.None)).HasLease);
        var replacement = await authority.AcquireAsync(
            sessionId,
            "replacement client",
            CancellationToken.None);
        var error = await Assert.ThrowsExactlyAsync<NendoAgentAuthoringException>(() =>
            authoring.AddOperationsAsync(
                sessionId,
                replacement.LeaseId,
                draft.ChangeSetId,
                [new NendoAgentMutationInput(
                    "Must not revive",
                    [ReadingQueueAuthoringFixture.Operations()[0]])],
                "revive-expired",
                CancellationToken.None));
        Assert.AreEqual("CHANGE_SET_NOT_FOUND", error.Code);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task SchemaOnlyAndMalformedUiPreviewsStayIsolatedUntilHostAcceptance(bool malformedUi)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var before = await workspace.Service.GetSnapshotAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = await BeginAsync(client, lease, "Incomplete app", "begin-incomplete");
        _ = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
            "nendo.change_set.add_operations",
            AddArguments(
                lease,
                begun.ChangeSetId,
                malformedUi ? [ReadingQueueAuthoringFixture.Operations()[0],
                    new NendoAgentOperationInput("ui.addNode", JsonSerializer.SerializeToElement(new {
                        surfaceId = "surface.incomplete", nodeId = "node.incomplete", parentNodeId = (string?)null,
                        kind = "recordForm", position = 0 }))] : [ReadingQueueAuthoringFixture.Operations()[0]],
                "add-incomplete")));
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
            "nendo.change_set.validate",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["idempotencyKey"] = "validate-incomplete",
            }));

        Assert.AreEqual(malformedUi ? NendoProposalState.Invalid : NendoProposalState.Previewable, preview.State);
        Assert.AreEqual(malformedUi, preview.Diagnostics.Count > 0);
        Assert.HasCount(malformedUi ? 0 : 1, host.GetPendingProposals());
        await client.DisposeAsync();
        var after = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.IsEmpty(after.Entities);
    }

    private static async Task<(string ChangeSetId, NendoAgentProposalPreview Preview)>
        CreateReadingQueuePreviewAsync(
        McpClient client,
        NendoLeaseGrant lease,
        string suffix)
    {
        var begun = await BeginAsync(client, lease, "Reading Queue", $"begin-{suffix}");
        var addOrdinal = 0;
        foreach (var chunk in ReadingQueueAuthoringFixture.Operations().Chunk(16))
        {
            _ = Result<NendoChangeSetAddResult>(await client.CallToolAsync(
                "nendo.change_set.add_operations",
                AddArguments(lease, begun.ChangeSetId, chunk, $"add-{suffix}-{addOrdinal++:D2}")));
        }
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
            "nendo.change_set.validate",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["changeSetId"] = begun.ChangeSetId,
                ["idempotencyKey"] = $"validate-{suffix}",
            }));
        return (begun.ChangeSetId, preview);
    }

    private static async Task<NendoChangeSetBeginResult> BeginAsync(
        McpClient client,
        NendoLeaseGrant lease,
        string title,
        string key) => Result<NendoChangeSetBeginResult>(await client.CallToolAsync(
            "nendo.change_set.begin",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["title"] = title,
                ["idempotencyKey"] = key,
            }));

    private static Dictionary<string, object?> AddArguments(
        NendoLeaseGrant lease,
        string changeSetId,
        IReadOnlyList<NendoAgentOperationInput> operations,
        string key) => new()
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["changeSetId"] = changeSetId,
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Shape the Reading Queue", operations),
            },
            ["idempotencyKey"] = key,
        };

    private static T Result<T>(CallToolResult result) where T : notnull
    {
        Assert.IsFalse(result.IsError ?? false, JsonSerializer.Serialize(result));
        if (result.StructuredContent is not { } structured)
        {
            throw new AssertFailedException("The tool did not return structured content.");
        }
        return structured.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }

    private static async Task AssertToolErrorAsync(
        McpClient client,
        string tool,
        IReadOnlyDictionary<string, object?> arguments,
        string code)
    {
        var result = await client.CallToolAsync(tool, arguments);
        Assert.IsTrue(result.IsError, JsonSerializer.Serialize(result));
        StringAssert.Contains(JsonSerializer.Serialize(result), code);
    }

    private static async Task<byte[]> ReadBytesSharedAsync(string path)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.ReadWrite,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
        });
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer);
        return buffer.ToArray();
    }

    private sealed class AuthoringTestClock(DateTimeOffset current) : INendoClock
    {
        public DateTimeOffset UtcNow { get; private set; } = current;

        internal void Advance(TimeSpan duration) => UtcNow = UtcNow.Add(duration);
    }
}
