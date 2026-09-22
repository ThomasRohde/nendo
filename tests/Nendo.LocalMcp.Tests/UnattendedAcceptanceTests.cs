using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The fifth access level: the agent accepts its own validated proposal, and the host
/// records the open file's automatic-action consent on the person's behalf
/// (ADR-0009, 2026-09-22 amendment).
/// <para>
/// Every test here has a pair. The level below must refuse what this level allows, or
/// what is being measured is that the code runs rather than that the boundary holds.
/// </para>
/// </summary>
[TestClass]
public sealed class UnattendedAcceptanceTests
{
    [TestMethod]
    public async Task ShapeAppIsNotServedTheAcceptToolAndIsRefusedIfItAsks()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var tools = (await client.ListToolsAsync()).Select(tool => tool.Name).ToArray();
        CollectionAssert.DoesNotContain(tools, "nendo.change_set.accept");

        // Not listed is not the same as not reachable, so a client that knows the name
        // sends it anyway. It is refused before it reaches Nendo at all: the tool is not
        // registered at this level, so the SDK has nothing to dispatch to.
        var session = await AcquireAsync(client);
        var validated = await ValidateNotesAsync(client, session);
        var refused = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(session)
            {
                ["changeSetId"] = validated.ChangeSetId,
                ["idempotencyKey"] = "accept-at-shape-app",
            }).AsTask());
        StringAssert.Contains(refused.Message, "nendo.change_set.accept", StringComparison.Ordinal);

        // And it changed nothing: the proposal is still waiting for somebody.
        Assert.HasCount(1, host.GetPendingProposals());
        Assert.IsEmpty((await workspace.Service.GetSnapshotAsync()).Entities);
    }

    [TestMethod]
    public async Task UnattendedAppliesItsOwnProposalAndLeavesTheQueueEmpty()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var validated = await ValidateNotesAsync(client, session);

        // Waiting for a person right up to the moment it stops waiting: the proposal is
        // real, is listed, and is what acceptance acts on.
        Assert.HasCount(1, host.GetPendingProposals());

        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = validated.ChangeSetId,
            ["idempotencyKey"] = "accept-notes",
        });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.AreEqual("active", accepted.State);
        Assert.AreEqual(validated.ProposalId, accepted.ProposalId);
        Assert.IsFalse(accepted.BehaviourApproved, "This change installs no automatic actions.");
        Assert.IsNotNull(accepted.DefinitionRevision);

        Assert.IsEmpty(host.GetPendingProposals());
        var snapshot = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual("notes", snapshot.Entities.Single().EntityId);
        Assert.AreEqual(accepted.DefinitionRevision, snapshot.Manifest.DefinitionRevision);

        // An exact retry returns the original outcome rather than promoting again.
        var replayed = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = validated.ChangeSetId,
            ["idempotencyKey"] = "accept-notes",
        });
        Assert.AreEqual(accepted, replayed);
        Assert.AreEqual(
            snapshot.Manifest.DefinitionRevision,
            (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision);
    }

    /// <summary>
    /// The second lock on the same door.
    /// <para>
    /// A client never meets this refusal, because the tool is not registered below
    /// Unattended and the SDK turns it away first. It exists for the edit that registers
    /// it a rung too low: the service asks the mode itself, so the level is enforced by
    /// the authority rather than only by the composition of the listener.
    /// </para>
    /// </summary>
    [TestMethod]
    public async Task TheServiceRefusesAnAcceptBelowUnattendedEvenWithTheToolInHand()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var host = new NendoHostAuthority(
            "run-unattended-backstop",
            AgentAccessMode.ApplicationAuthoring,
            new byte[32],
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        host.SetPort(41764);
        var authority = new NendoAgentAuthority(host, new SystemNendoClock(), null);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId);
        var authoring = new NendoAgentAuthoringService(
            workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        const string sessionId = "unattended-backstop-session";
        var lease = await authority.AcquireAsync(sessionId, "test client", CancellationToken.None);

        var refused = await Assert.ThrowsExactlyAsync<NendoAgentAuthorityException>(() =>
            authoring.AcceptAsync(sessionId, lease.LeaseId, "change-set-absent", "accept-backstop", CancellationToken.None));
        Assert.AreEqual("UNATTENDED_REQUIRED", refused.Code);
        StringAssert.Contains(refused.Message, "Unattended", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AcceptingADraftThatNeverValidatedIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "Notes",
            ["idempotencyKey"] = "begin-unvalidated",
        });

        var refusal = await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(session)
        {
            ["changeSetId"] = begun.ChangeSetId,
            ["idempotencyKey"] = "accept-unvalidated",
        });
        Assert.IsTrue(refusal.IsError, JsonSerializer.Serialize(refusal));
        StringAssert.Contains(
            JsonSerializer.Serialize(refusal),
            "NENDO_CHANGE_SET_NOT_VALIDATED",
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The half of this level that removes a boundary rather than moving a button.
    /// <para>
    /// Installing a trigger needs no consent -- nothing runs while it is installed. The
    /// interlock is on the write after it: a file whose actions nobody has approved
    /// refuses the first write that would fire one. That is what an unattended build has
    /// to get past, and the level below must not.
    /// </para>
    /// </summary>
    [TestMethod]
    public async Task WithoutConsentTheFirstWriteThatWouldRunAnActionIsRefused()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareStampFixtureAsync(workspace);
        var grants = new RecordingGrantStore();
        workspace.AttachBehaviourAuthority(grants);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            null,
            CancellationToken.None,
            // Handed the delegate on purpose. A host that simply never wired one up would
            // refuse for the wrong reason, and this test would pass against a build whose
            // level check had been deleted -- which is what it did until it was falsified.
            _ =>
            {
                workspace.GrantCurrentBehaviour(grants);
                return Task.CompletedTask;
            });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var validated = await ValidateStampTriggerAsync(client, session, workspace);

        // The person accepts it themselves. Installing the action is not the refused act.
        var promotion = await workspace.Service.PromoteProposalAsync(
            validated.ProposalId, CancellationToken.None, validated.OperationDigest);
        Assert.IsTrue(promotion.Applied, promotion.Message);

        var refused = await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "notes",
            ["recordId"] = "n1",
            ["fieldId"] = "label",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Second"),
            ["idempotencyKey"] = "write-without-consent",
        });
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        StringAssert.Contains(
            JsonSerializer.Serialize(refused),
            "NENDO_BEHAVIOUR_NOT_APPROVED",
            StringComparison.Ordinal);
        Assert.AreEqual(0, grants.Approvals, "Nothing below Unattended may record consent.");

        // Nothing was written, so the action never had the chance to run.
        var record = (await workspace.Service.QueryRecordsAsync(new("notes", 10))).Items
            .Single(item => item.RecordId == "n1");
        Assert.AreEqual(1L, record.RecordVersion);
    }

    /// <summary>
    /// The same file, the same write, at Unattended: consent is recorded once and the
    /// write goes through on a single retry.
    /// </summary>
    [TestMethod]
    public async Task UnattendedRecordsConsentForARefusedWriteAndRetriesItOnce()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareStampFixtureAsync(workspace);
        var grants = new RecordingGrantStore();
        workspace.AttachBehaviourAuthority(grants);
        await using var installer = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using (var authoringClient = await ProtocolResourceTests.ConnectAsync(installer))
        {
            var authoringSession = await AcquireAsync(authoringClient);
            var validated = await ValidateStampTriggerAsync(authoringClient, authoringSession, workspace);
            Assert.IsTrue((await workspace.Service.PromoteProposalAsync(
                validated.ProposalId, CancellationToken.None, validated.OperationDigest)).Applied);
        }
        await installer.DisposeAsync();

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            null,
            CancellationToken.None,
            _ =>
            {
                workspace.GrantCurrentBehaviour(grants);
                return Task.CompletedTask;
            });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var written = await CallAsync<NendoDataApplyResult>(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = "notes",
            ["recordId"] = "n1",
            ["fieldId"] = "label",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Second"),
            ["idempotencyKey"] = "write-with-unattended-consent",
        });
        Assert.IsNotNull(written.RevisionId);
        Assert.AreEqual(1, grants.Approvals, "Consent is recorded once, not once per attempt.");
        var record = (await workspace.Service.QueryRecordsAsync(new("notes", 10))).Items
            .Single(item => item.RecordId == "n1");
        Assert.AreEqual(
            "Seen Second",
            record.Values["stamp"].GetString(),
            "The automatic action did not run after its consent was recorded.");
    }

    [TestMethod]
    public async Task UnattendedRecordsTheConsentItsOwnAcceptanceNeeds()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareStampFixtureAsync(workspace);
        var grants = new RecordingGrantStore();
        workspace.AttachBehaviourAuthority(grants);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            null,
            CancellationToken.None,
            _ =>
            {
                // What the Desktop does, in the same two steps: read what the open file
                // asks for, and record that exact grant.
                workspace.GrantCurrentBehaviour(grants);
                return Task.CompletedTask;
            });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var validated = await ValidateStampTriggerAsync(client, session, workspace);

        Assert.AreEqual(0, grants.Approvals, "Nothing is approved before the acceptance needs it.");
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = validated.ChangeSetId,
            ["idempotencyKey"] = "accept-trigger",
        });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.IsTrue(accepted.BehaviourApproved, "The acceptance installed an action and said nothing about consent.");
        Assert.AreEqual(1, grants.Approvals, "Consent is recorded once, for what the file now holds.");

        // And the consent is real: the write that fires the action goes through, where at
        // any level below it is refused (see the pair above).
        var written = await CallAsync<NendoDataApplyResult>(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = "notes",
            ["recordId"] = "n1",
            ["fieldId"] = "label",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Second"),
            ["idempotencyKey"] = "write-after-consent",
        });
        Assert.IsNotNull(written.RevisionId);
        Assert.AreEqual(1, grants.Approvals, "The write must not record consent a second time.");
        var record = (await workspace.Service.QueryRecordsAsync(new("notes", 10))).Items
            .Single(item => item.RecordId == "n1");
        Assert.AreEqual(
            "Seen Second",
            record.Values["stamp"].GetString(),
            "The automatic action did not run after its consent was recorded.");
    }

    private sealed record StampFixture(string ChangeSetId, string ProposalId, string OperationDigest);

    /// <summary>The behaviour payload shape, written once. The keys are published at
    /// nendo://application/vocabulary and refused by name when they are wrong.</summary>
    private static NendoAgentOperationInput Set(string definitionId, string kind, object body) =>
        new("behaviour.setDefinition", JsonSerializer.SerializeToElement(new
        {
            definitionId,
            definitionKind = kind,
            body,
        }));

    /// <summary>A record type with a label and a stamp, and one record in it.</summary>
    private static async Task PrepareStampFixtureAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" }, new("test", "n1", "test")));
    }

    /// <summary>A change set that installs an action and the trigger that runs it.</summary>
    private static async Task<StampFixture> ValidateStampTriggerAsync(
        McpClient client,
        Dictionary<string, object?> session,
        LocalMcpTestWorkspace workspace)
    {
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "Stamp the label",
            ["idempotencyKey"] = "begin-stamp",
        });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Stamp the label",
                [
                    Set("note.stamp", "Action", new
                    {
                        displayName = "Stamp the label",
                        steps = new[]
                        {
                            new
                            {
                                stepId = "10-stamp",
                                kind = "SetField",
                                target = new { kind = "EventRecord" },
                                assignments = new[]
                                {
                                    new
                                    {
                                        fieldId = "stamp",
                                        expression = "Concat('Seen ', label)",
                                        bindings = new[]
                                        {
                                            new
                                            {
                                                bindingId = "label", kind = "SameRecordField", entityId = "notes",
                                                fieldId = "label", resultType = "Text", nullable = false,
                                            },
                                        },
                                        callAliases = Array.Empty<object>(),
                                    },
                                },
                            },
                        },
                    }),
                    Set("note.stamp.trigger", "Trigger", new
                    {
                        entityId = "notes",
                        displayName = "Stamp the label when it changes",
                        events = "Updated",
                        actionId = "note.stamp",
                        relevantFieldIds = new[] { "label" },
                        conditionBindings = Array.Empty<object>(),
                        callAliases = Array.Empty<object>(),
                    }),
                ]),
            },
            ["idempotencyKey"] = "add-stamp",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped)
        {
            ["idempotencyKey"] = "validate-stamp",
        });
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new StampFixture(begun.ChangeSetId, validated.ProposalId, validated.OperationDigest);
    }

    /// <summary>A change set that adds one record type and nothing else.</summary>
    private static async Task<StampFixture> ValidateNotesAsync(
        McpClient client,
        Dictionary<string, object?> session)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "Notes",
            ["idempotencyKey"] = "begin-notes",
        });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create Notes",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new
                    {
                        entityId = "notes",
                        displayName = "Notes",
                    })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new
                    {
                        entityId = "notes",
                        fieldId = "label",
                        displayName = "Label",
                        storageKind = "Text",
                        required = true,
                    })),
                ]),
            },
            ["idempotencyKey"] = "add-notes",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped)
        {
            ["idempotencyKey"] = "validate-notes",
        });
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new StampFixture(begun.ChangeSetId, validated.ProposalId, validated.OperationDigest);
    }

    /// <summary>
    /// A device grant store that counts how often it was asked. The count is the
    /// assertion: consent recorded twice, or before it was needed, would be this level
    /// widening quietly.
    /// </summary>
    private sealed class RecordingGrantStore : INendoBehaviourAuthority, IApprovesWhatTheFileAsks
    {
        private readonly HashSet<NendoBehaviourGrant> _granted = [];

        internal int Approvals { get; private set; }

        public long RevocationGeneration => 0;

        public bool IsGranted(NendoBehaviourGrant required) => _granted.Contains(required);

        public void Approve(NendoBehaviourGrant required)
        {
            _granted.Add(required);
            Approvals++;
        }
    }

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
    }

    private static async Task<T> CallAsync<T>(
        McpClient client,
        string name,
        Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
