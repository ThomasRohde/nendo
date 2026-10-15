using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The change-set lifecycle as an agent meets it, measured against the authoring service
/// directly (W-227, the broad review's MCP authoring findings). Each case names the finding
/// whose defect it measures.
/// </summary>
[TestClass]
public sealed class AuthoringContractReviewTests
{
    [TestMethod]
    public async Task AMoveByPositionAloneKeepsTheNodesParent()
    {
        await using var rig = await AuthoringRig.StartAsync();
        await rig.AcceptAsync(await rig.ValidateExampleAsync("two-commands-and-a-filtered-list"));
        var before = (await rig.Workspace.Service.GetDefinitionSnapshotAsync()).UiNodes.Single(node => node.NodeId == "dealOpenStage");
        Assert.AreEqual("dealOpen", before.ParentNodeId);

        var reorder = await rig.BeginAsync("Put the stage column last");
        await rig.AddAsync(reorder.ChangeSetId, Mutation("Move the stage column",
            Op("ui.moveNode", new { surfaceId = before.SurfaceId, nodeId = "dealOpenStage", position = 9 })));
        var moved = await rig.ValidateAsync(reorder.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, moved.State,
            "MAA-05: a move that left parentNodeId out was read as a move to the root. " +
            string.Join(" | ", moved.Diagnostics.Select(value => $"{value.Code} {value.Message}")));
        await rig.AcceptAsync(moved);

        var after = (await rig.Workspace.Service.GetDefinitionSnapshotAsync()).UiNodes.Single(node => node.NodeId == "dealOpenStage");
        Assert.AreEqual("dealOpen", after.ParentNodeId, "MAA-05: the node left its list.");
        Assert.AreEqual(9, after.Position);
    }

    [TestMethod]
    public async Task AnAnchorSentAsNullIsAnAnchorNotGiven()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Place nodes with null anchors");
        await rig.AddAsync(begun.ChangeSetId, Mutation("A root with every optional key",
            Op("ui.addNode", new { surfaceId = "notes", nodeId = "notesAll", kind = "recordList", parentNodeId = (string?)null, position = 2, beforeNodeId = (string?)null, afterNodeId = (string?)null })));
        await rig.AddAsync(begun.ChangeSetId, Mutation("Move it with every optional key",
            Op("ui.moveNode", new { surfaceId = "notes", nodeId = "notesAll", parentNodeId = (string?)null, position = 3, beforeNodeId = (string?)null, afterNodeId = (string?)null })));
        await rig.AddAsync(begun.ChangeSetId, Mutation("Place one beside it, position null",
            Op("ui.addNode", new { surfaceId = "notes2", nodeId = "notesOther", kind = "recordList", afterNodeId = "notesAll", position = (int?)null, beforeNodeId = (string?)null })));

        // Only null anchors is no placement, and a new node given none goes after its siblings (W-245;
        // MAA-04 refused it for the missing position, in the Engine's words).
        await rig.AddAsync(begun.ChangeSetId, Mutation("Only null anchors",
            Op("ui.addNode", new { surfaceId = "notes3", nodeId = "notesThird", kind = "recordList", parentNodeId = (string?)null, beforeNodeId = (string?)null })));
    }

    [TestMethod]
    public async Task ADraftTheFileMovedUnderValidatesAtTheNewRevisionUnlessItPinsOne()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var first = await rig.BeginAsync("Notes");
        await rig.AddAsync(first.ChangeSetId, Mutation("Create notes", Op("schema.createEntity", new { entityId = "note", displayName = "Note" })));
        var pinned = await rig.BeginAsync("Rename notes at a pinned revision");
        var other = await rig.BeginAsync("Tasks");
        await rig.AddAsync(other.ChangeSetId, Mutation("Create tasks", Op("schema.createEntity", new { entityId = "task", displayName = "Task" })));
        await rig.AcceptAsync(await rig.ValidateAsync(other.ChangeSetId));
        var revision = (await rig.Workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreNotEqual(first.CapturedDefinitionRevision, revision, "The other proposal moved the file.");

        var validated = await rig.ValidateAsync(first.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, "MAA-02: a draft the file moved under could never be validated.");
        Assert.AreEqual(revision, validated.CapturedDefinitionRevision);
        var recaptured = validated.Diagnostics.SingleOrDefault(value => value.Code == "NCS001");
        Assert.IsNotNull(recaptured, "MAA-02 review: the draft was validated at a newer revision and nothing said so.");
        Assert.AreEqual(NendoDiagnosticSeverity.Warning, recaptured.Severity);
        StringAssert.Contains(recaptured.Message, $"from revision {first.CapturedDefinitionRevision} to {revision}");

        await rig.AddAsync(pinned.ChangeSetId, Mutation("Rename tasks",
            Op("schema.renameEntity", new { entityId = "task", displayName = "Jobs", expectedDefinitionRevision = revision })));
        await rig.AcceptAsync(validated);
        var stale = await Assert.ThrowsAsync<NendoAgentAuthoringException>(() => rig.ValidateAsync(pinned.ChangeSetId));
        Assert.AreEqual("CHANGE_SET_STALE", stale.Code);
        StringAssert.Contains(stale.Message, "nendo.change_set.reject", "MAA-02: the refusal names no way out.");
        StringAssert.Contains(stale.Message, "mutation 0");
    }

    /// <summary>
    /// MAA-02, review: add_operations resolves placement when the operations arrive, so a draft
    /// holding a placement the host worked out is not captured again silently: replayed at the
    /// new revision it would put the node back where the person moved it from.
    /// </summary>
    [TestMethod]
    public async Task ADraftPlacedByTheHostIsRefusedWhenThePersonMovedTheNodeSince()
    {
        await using var rig = await AuthoringRig.StartAsync();
        await rig.AcceptAsync(await rig.ValidateExampleAsync("build-a-detail-surface"));
        var name = (await rig.Workspace.Service.GetDefinitionSnapshotAsync()).UiNodes.Single(node => node.NodeId == "projectNameBinding");
        Assert.AreEqual("projectOverview", name.ParentNodeId);
        var reorder = await rig.BeginAsync("Put the name last in its section");
        await rig.AddAsync(reorder.ChangeSetId, Mutation("Move the name",
            Op("ui.moveNode", new { surfaceId = name.SurfaceId, nodeId = "projectNameBinding", position = 9 })));

        // The person moves the name out of the section onto the page itself, in Studio, before the draft validates.
        var revision = (await rig.Workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var theirs = await rig.Workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Theirs first", "test",
            new([new("test", "theirs", "test", "Move the name onto the page",
                [new MoveUiNodeOperation("theirs-move", name.SurfaceId, "projectNameBinding", "projectPage", 5)])])));
        Assert.AreEqual(NendoProposalState.Previewable, theirs.State, string.Join(" | ", theirs.Diagnostics.Select(value => $"{value.Code} {value.Message}")));
        var promoted = await rig.Workspace.Service.PromoteProposalAsync(theirs.ProposalId);
        Assert.IsTrue(promoted.Applied, promoted.Message);
        Assert.AreNotEqual(revision, (await rig.Workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision);

        var stale = await Assert.ThrowsAsync<NendoAgentAuthoringException>(() => rig.ValidateAsync(reorder.ChangeSetId),
            "MAA-02 review: the draft was captured again and would move the name back into the section the person took it out of.");
        Assert.AreEqual("CHANGE_SET_STALE", stale.Code);
        StringAssert.Contains(stale.Message, "mutation 0");
        StringAssert.Contains(stale.Message, "send the placement again");
        Assert.AreEqual("projectPage",
            (await rig.Workspace.Service.GetDefinitionSnapshotAsync()).UiNodes.Single(node => node.NodeId == "projectNameBinding").ParentNodeId);
    }

    /// <summary>
    /// MAA-06, review: a reference board draws no column when the target type holds more records
    /// than the ceiling, counted before any filter, as the renderer counts them.
    /// </summary>
    [TestMethod]
    public async Task AReferenceBoardPastTheCeilingSaysItDrawsNoneWhateverItsFilter()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var shape = await rig.ReferenceBoardShapeAsync(30, "client07");
        StringAssert.Contains(shape, "30 of them, more than the 24 a board draws, so it would draw none",
            $"MAA-06 review: the shape counted the filtered columns. Shape: {shape}");
    }

    [TestMethod]
    public async Task AReferenceBoardWhoseFilterExcludesEveryColumnSaysSo()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var shape = await rig.ReferenceBoardShapeAsync(3, "clientMissing");
        StringAssert.Contains(shape, "the board's own filter excludes every column",
            $"MAA-06 review: an empty board read as a type with no records. Shape: {shape}");
    }

    /// <summary>
    /// MAA-09, review: the person's accept reaches the authoring service through the host's own
    /// queue-change wiring; the count reads without pruning, so only that wiring can empty it.
    /// </summary>
    [TestMethod]
    public async Task ThePersonsAcceptReleasesTheOperationsThroughTheHostsQueueNotice()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var store = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), store);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var owned = await AppBuilderReviewTests.AcquireAsync(client);
        var begun = await AppBuilderReviewTests.CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin",
            new(owned) { ["title"] = "Notes", ["idempotencyKey"] = "begin" });
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        await AppBuilderReviewTests.CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[] { Mutation("Create notes", Op("schema.createEntity", new { entityId = "note", displayName = "Note" })) },
            ["idempotencyKey"] = "add",
        });
        var proposal = await AppBuilderReviewTests.CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "validate" });
        Assert.AreEqual(1, host.KeptProposalCount);

        // As the Desktop accepts: through the store, never the authoring service.
        Assert.IsTrue((await store.PromoteAsync(workspace.Service, proposal.ProposalId, proposal.OperationDigest)).Applied);
        Assert.AreEqual(0, host.KeptProposalCount, "MAA-09: the person's accept left the operations held until the next agent call.");
    }

    [TestMethod]
    public async Task ARefusalsHintNamesTheMutationItWasSentIn()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Notes with a broken rename");
        await rig.AddAsync(begun.ChangeSetId,
            Mutation("Create notes",
                Op("schema.createEntity", new { entityId = "note", displayName = "Note" }),
                Op("schema.addField", new { entityId = "note", fieldId = "noteTitle", displayName = "Title", storageKind = "Text", required = true, presentation = "singleLine", options = Array.Empty<string>() })),
            Mutation("Two lists, the second placed before the first",
                Op("ui.addNode", new { surfaceId = "noteAll", nodeId = "noteAll", parentNodeId = (string?)null, kind = "recordList", position = 0,
                    properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "note", ["title"] = "Notes" } }),
                Op("ui.addNode", new { surfaceId = "noteMore", nodeId = "noteMore", kind = "recordList", beforeNodeId = "noteAll",
                    properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "note", ["title"] = "More notes" } })),
            Mutation("Rename a record type that is not there",
                Op("schema.renameEntity", new { entityId = "ghost", displayName = "Ghost" })));
        var invalid = await rig.ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        var refusal = invalid.Diagnostics.First(value => value.OperationId is not null);
        StringAssert.Contains(refusal.Hint, "mutation 2 as sent",
            $"MAA-03: {refusal.OperationId} cannot be mapped back to the mutation amend takes. Hint: {refusal.Hint}");
    }

    [TestMethod]
    public async Task ARevalidateCancelledAfterItsRejectKeepsTheChangeSet()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Notes");
        await rig.AddAsync(begun.ChangeSetId, Mutation("Create notes", Op("schema.createEntity", new { entityId = "note", displayName = "Note" })));
        Assert.AreEqual(NendoProposalState.Previewable, (await rig.ValidateAsync(begun.ChangeSetId)).State);

        using var cancellation = new CancellationTokenSource();
        rig.Authoring.AfterRevalidateReject = cancellation.Cancel;
        try
        {
            await rig.Authoring.RevalidateAsync(rig.Session, rig.LeaseId, begun.ChangeSetId, "revalidate-cancelled", cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            // The caller stopped waiting between the reject and the new validation.
        }
        finally
        {
            rig.Authoring.AfterRevalidateReject = null;
        }

        var again = await rig.ValidateAsync(begun.ChangeSetId, "validate-after-cancel");
        Assert.AreEqual(NendoProposalState.Previewable, again.State,
            "MAA-07: a revalidate cancelled after its reject lost the proposal and its operations.");
        Assert.HasCount(1, rig.Proposals.Snapshot());
    }

    [TestMethod]
    public async Task APersonsAcceptOrRejectReleasesTheOperationsAndNamesTheFate()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var accepted = await rig.BeginAsync("Notes");
        await rig.AddAsync(accepted.ChangeSetId, Mutation("Create notes", Op("schema.createEntity", new { entityId = "note", displayName = "Note" })));
        var proposal = await rig.ValidateAsync(accepted.ChangeSetId);
        await rig.AcceptAsync(proposal);
        Assert.AreEqual(0, rig.Authoring.KeptProposalCount, "MAA-09: the person's accept left the operations held.");
        var preview = await rig.Authoring.PreviewAsync(rig.Session, rig.LeaseId, accepted.ChangeSetId, CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Active, preview.State, "MAA-09: preview did not say the proposal was accepted.");
        Assert.AreEqual(accepted.ChangeSetId, preview.ChangeSetId);

        var rejected = await rig.BeginAsync("Tasks");
        await rig.AddAsync(rejected.ChangeSetId, Mutation("Create tasks", Op("schema.createEntity", new { entityId = "task", displayName = "Task" })));
        var second = await rig.ValidateAsync(rejected.ChangeSetId);
        await rig.Proposals.RejectAsync(rig.Workspace.Service, second.ProposalId);
        Assert.AreEqual(0, rig.Authoring.KeptProposalCount, "MAA-09: the person's reject left the operations held.");
        var refused = await Assert.ThrowsAsync<NendoAgentAuthoringException>(() =>
            rig.Authoring.RevalidateAsync(rig.Session, rig.LeaseId, rejected.ChangeSetId, "revalidate-rejected", CancellationToken.None));
        StringAssert.Contains(refused.Message, second.ProposalId);
        StringAssert.Contains(refused.Message, "was rejected");
    }

    [TestMethod]
    public async Task ARequiredKeyLeftOutIsRefusedByName()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Recolour the file");
        var look = await Assert.ThrowsAsync<NendoValidationException>(() => rig.AddAsync(begun.ChangeSetId,
            Mutation("Teal", Op("application.setLook", new { tone = "teal" }))));
        StringAssert.Contains(look.Message, "letter", "MAA-10: setLook without letter reset the letter.");
        var purpose = await Assert.ThrowsAsync<NendoValidationException>(() => rig.AddAsync(begun.ChangeSetId,
            Mutation("Say nothing", Op("application.setPurpose", new { }))));
        StringAssert.Contains(purpose.Message, "purpose");
        await rig.AddAsync(begun.ChangeSetId, Mutation("Teal, default letter", Op("application.setLook", new { tone = "teal", letter = (string?)null })));
    }

    [TestMethod]
    public async Task AChunkedFileWhoseFirstPartCarriesItsHashValidates()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("A view in two parts");
        const string first = "nendo.ready.then(async () => {\n";
        const string second = "  document.body.textContent = 'Hello';\n});\n";
        await rig.AddAsync(begun.ChangeSetId,
            Mutation("The package and the first part",
                Op("extension.setPackage", new { packageId = "org.example.parts", title = "Parts" }),
                Op("extension.putFile", new { packageId = "org.example.parts", path = "index.html", text = "<!doctype html><title>Parts</title>" }),
                Op("extension.putFile", new
                {
                    packageId = "org.example.parts",
                    path = "view.js",
                    text = first,
                    sha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(first))).ToLowerInvariant(),
                })),
            Mutation("The second part",
                Op("extension.putFile", new { packageId = "org.example.parts", path = "view.js", text = second, append = true })));
        var validated = await rig.ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State,
            "MAA-11: " + string.Join(" | ", validated.Diagnostics.Select(value => value.Message)));
    }

    [TestMethod]
    public async Task ValidatePreviewAndRevalidateNameTheirOwnChangeSet()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Notes");
        await rig.AddAsync(begun.ChangeSetId, Mutation("Create notes", Op("schema.createEntity", new { entityId = "note", displayName = "Note" })));
        var owner = NendoTransportIdentity.Pseudonym(rig.Session);
        var validated = await rig.ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual((begun.ChangeSetId, owner), (validated.ChangeSetId, validated.Owner), "MAA-13: validate");
        var preview = await rig.Authoring.PreviewAsync(rig.Session, rig.LeaseId, begun.ChangeSetId, CancellationToken.None);
        Assert.AreEqual((begun.ChangeSetId, owner), (preview.ChangeSetId, preview.Owner), "MAA-13: preview");
        var revalidated = await rig.Authoring.RevalidateAsync(rig.Session, rig.LeaseId, begun.ChangeSetId, "revalidate", CancellationToken.None);
        Assert.AreEqual((begun.ChangeSetId, owner), (revalidated.ChangeSetId, revalidated.Owner), "MAA-13: revalidate");
    }

    [TestMethod]
    public async Task TheDraftLimitNamesTheLimitTheDraftsAndTheWayOut()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var drafts = new List<NendoChangeSetBeginResult>();
        for (var index = 0; index < NendoAuthoringLimits.Current.DraftsPerSession; index++)
            drafts.Add(await rig.BeginAsync($"Draft {index}"));
        var refused = await Assert.ThrowsAsync<NendoAgentAuthoringException>(() => rig.BeginAsync("One too many"));
        Assert.AreEqual("DRAFT_LIMIT", refused.Code);
        StringAssert.Contains(refused.Message, drafts[0].ChangeSetId, "MAA-15: the refusal names no draft to reject.");
        StringAssert.Contains(refused.Message, NendoAuthoringLimits.Current.DraftsPerSession.ToString(System.Globalization.CultureInfo.InvariantCulture));
        StringAssert.Contains(refused.Message, "release the lease");
    }

    [TestMethod]
    public async Task AProposalThatAddsAFileScopedViewListsItAsAScreen()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Open the file on a custom view");
        await rig.AddAsync(begun.ChangeSetId, (await AuthoringRig.ExampleAsync("put-a-custom-view-in-the-file")).ToArray());
        await rig.AddAsync(begun.ChangeSetId, Mutation("The view as a screen of the file",
            Op("ui.addNode", new
            {
                surfaceId = "hello",
                nodeId = "helloView",
                parentNodeId = (string?)null,
                kind = "extensionView",
                position = 0,
                properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["title"] = "Hello", ["packageId"] = "org.example.hello" },
            })));
        var validated = await rig.ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State,
            string.Join(" | ", validated.Diagnostics.Select(value => $"{value.Code} {value.Message}")));
        var view = validated.Preview.Surfaces.SingleOrDefault(surface => surface.NodeId == "helloView");
        Assert.IsNotNull(view, "MAA-16: a proposal that adds a custom view as a screen of the file listed no screen.");
        Assert.AreEqual(("extensionView", "Hello", (string?)null), (view.Kind, view.Title, view.EntityId));
    }

    [TestMethod]
    public async Task KeptInNewFilesOnACreateInAChangeSetNamesTheOperationThatDoesIt()
    {
        await using var rig = await AuthoringRig.StartAsync();
        var begun = await rig.BeginAsync("Seed the kinds");
        await rig.AddAsync(begun.ChangeSetId, Mutation("Create kinds",
            Op("schema.createEntity", new { entityId = "kind", displayName = "Kind" }),
            Op("schema.addField", new { entityId = "kind", fieldId = "kindName", displayName = "Name", storageKind = "Text", required = true, presentation = "singleLine", options = Array.Empty<string>() })));
        var refused = await Assert.ThrowsAsync<NendoValidationException>(() => rig.AddAsync(begun.ChangeSetId, Mutation("Seed one kind",
            Op("data.createRecord", new { entityId = "kind", recordId = "kindBug", values = new { kindName = "Bug" }, keptInNewFiles = true }))));
        StringAssert.Contains(refused.Message, "data.setKeptInNewFiles", "MAA-18: the refusal did not name the operation that keeps a record.");

        // And the operation it names does it, in the same mutation as the create.
        await rig.AddAsync(begun.ChangeSetId, Mutation("Seed one kind and keep it",
            Op("data.createRecord", new { entityId = "kind", recordId = "kindBug", values = new { kindName = "Bug" } }),
            Op("data.setKeptInNewFiles", new { entityId = "kind", recordId = "kindBug", kept = true })));
        var validated = await rig.ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State,
            string.Join(" | ", validated.Diagnostics.Select(value => value.Message)));
    }

    /// <summary>
    /// MAA-14: an invalid validate discards its clone, and the activity entry named it anyway, a
    /// proposal no read lists. The result still carries the ID, as its description now says.
    /// </summary>
    [TestMethod]
    public async Task AnInvalidValidatesActivityEntryNamesNoProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var owned = await AppBuilderReviewTests.AcquireAsync(client);
        var begun = await AppBuilderReviewTests.CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin",
            new(owned) { ["title"] = "Rename a ghost", ["idempotencyKey"] = "begin" });
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        await AppBuilderReviewTests.CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[] { Mutation("Rename a record type that is not there", Op("schema.renameEntity", new { entityId = "ghost", displayName = "Ghost" })) },
            ["idempotencyKey"] = "add",
        });
        var invalid = await AppBuilderReviewTests.CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "validate" });
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        var entry = host.GetActivities()[^1];
        Assert.AreEqual("nendo.change_set.validate", entry.Name);
        Assert.IsNull(entry.ProposalId, $"MAA-14: the activity entry names {entry.ProposalId}, a clone already discarded.");
    }

    /// <summary>
    /// MHS-10: NENDO_HOST_CLOSED reached a queued tool call as "Agent authority rejected the
    /// request.", every resource read the same, and a call stopped in a host filter as the SDK's
    /// code-less internal error. Each path now gives the code and the perimeter's sentence.
    /// </summary>
    [TestMethod]
    public void AClosedEndpointSaysWhyAndWhereOnEveryPath()
    {
        var host = new NendoHostAuthority("closed-run", AgentAccessMode.ReadOnly, new byte[32], "application", "instance");
        host.CloseAdmission();
        var closed = Assert.Throws<NendoAgentAuthorityException>(host.RequireActive);

        var tool = NendoToolErrors.Translate(closed);
        StringAssert.Contains(tool.Message, "NENDO_HOST_CLOSED: " + NendoHostAuthority.ClosedMessage);
        var read = NendoMcpErrors.Translate(closed);
        StringAssert.Contains(read.Message, "NENDO_HOST_CLOSED: " + NendoHostAuthority.ClosedMessage);

        var filtered = Assert.Throws<ModelContextProtocol.McpProtocolException>(() => NendoMcpErrors.RequireActive(host));
        StringAssert.Contains(filtered.Message, "Agent page");
        using var refusal = NendoToolRefusal.Begin();
        var called = Assert.Throws<ModelContextProtocol.McpException>(() => NendoMcpErrors.RequireActiveForTool(host));
        StringAssert.Contains(called.Message, "Agent page");
        Assert.AreEqual("NENDO_HOST_CLOSED", refusal.Refusal?.Code, "The tool filter's refusal carries no code in _meta.");
    }

    internal static NendoAgentOperationInput Op(string type, object payload) =>
        new(type, JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));

    internal static NendoAgentMutationInput Mutation(string description, params NendoAgentOperationInput[] operations) =>
        new(description, operations);
}

/// <summary>An authoring service over a fresh empty file, with one lease, driven as the tools drive it.</summary>
internal sealed class AuthoringRig : IAsyncDisposable
{
    private int _keys;

    private AuthoringRig(
        LocalMcpTestWorkspace workspace,
        NendoHostAuthority host,
        NendoAgentAuthority authority,
        NendoAgentProposalStore proposals,
        NendoAgentAuthoringService authoring,
        string session,
        string leaseId)
    {
        Workspace = workspace;
        Host = host;
        Authority = authority;
        Proposals = proposals;
        Authoring = authoring;
        Session = session;
        LeaseId = leaseId;
    }

    internal LocalMcpTestWorkspace Workspace { get; }
    internal NendoHostAuthority Host { get; }
    internal NendoAgentAuthority Authority { get; }
    internal NendoAgentProposalStore Proposals { get; }
    internal NendoAgentAuthoringService Authoring { get; }
    internal string Session { get; }
    internal string LeaseId { get; }

    internal static async Task<AuthoringRig> StartAsync()
    {
        var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        var host = new NendoHostAuthority($"rig-{Guid.NewGuid():N}", AgentAccessMode.ApplicationAuthoring,
            new byte[32], manifest.ApplicationId, manifest.InstanceId);
        var authority = new NendoAgentAuthority(host, new SystemNendoClock(), null);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(manifest.ApplicationId, manifest.InstanceId);
        var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        // Connected as the host connects it, so the person's accept and reject reach the service.
        proposals.ProposalsChanged += authoring.ReleaseSettled;
        const string session = "authoring-rig-session";
        var lease = await authority.AcquireAsync(session, "authoring rig", CancellationToken.None);
        return new AuthoringRig(workspace, host, authority, proposals, authoring, session, lease.LeaseId);
    }

    internal Task<NendoChangeSetBeginResult> BeginAsync(string title) =>
        Authoring.BeginAsync(Session, LeaseId, title, NextKey("begin"), CancellationToken.None);

    internal Task<NendoChangeSetAddResult> AddAsync(string changeSetId, params NendoAgentMutationInput[] mutations) =>
        Authoring.AddOperationsAsync(Session, LeaseId, changeSetId, mutations, NextKey("add"), CancellationToken.None);

    internal Task<NendoAgentProposalPreview> ValidateAsync(string changeSetId, string? key = null) =>
        Authoring.ValidateAsync(Session, LeaseId, changeSetId, key ?? NextKey("validate"), CancellationToken.None);

    /// <summary>The person's Accept, as the Desktop calls it: through the store, never the authoring service.</summary>
    internal async Task AcceptAsync(NendoAgentProposalPreview proposal)
    {
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State,
            string.Join(" | ", proposal.Diagnostics.Select(value => $"{value.Code} {value.Message}")));
        var outcome = await Proposals.PromoteAsync(Workspace.Service, proposal.ProposalId, proposal.OperationDigest);
        Assert.IsTrue(outcome.Applied, outcome.Message);
    }

    internal async Task<NendoAgentProposalPreview> ValidateExampleAsync(string name)
    {
        var begun = await BeginAsync(name);
        foreach (var mutation in await ExampleAsync(name)) await AddAsync(begun.ChangeSetId, mutation);
        return await ValidateAsync(begun.ChangeSetId);
    }

    internal static Task<IReadOnlyList<NendoAgentMutationInput>> ExampleAsync(string name) =>
        Task.FromResult<IReadOnlyList<NendoAgentMutationInput>>(NendoAuthoringExamples.Description().Examples
            .Single(example => example.Name == name).Mutations
            .Select(mutation => new NendoAgentMutationInput(mutation.Description,
                mutation.Operations.Select(operation => new NendoAgentOperationInput(operation.OperationType, operation.Payload)).ToArray()))
            .ToArray());

    /// <summary>
    /// The preview shape of a board of jobs grouped by client, over <paramref name="clients"/>
    /// client records, narrowed by its own clause "client eq <paramref name="only"/>".
    /// </summary>
    internal async Task<string> ReferenceBoardShapeAsync(int clients, string only)
    {
        static NendoAgentOperationInput Field(string entityId, string fieldId, string name, string kind, bool required) =>
            AuthoringContractReviewTests.Op("schema.addField", new { entityId, fieldId, displayName = name, storageKind = kind, required, presentation = kind == "Text" ? "singleLine" : null, options = Array.Empty<string>() });
        var begun = await BeginAsync("Jobs by client");
        await AddAsync(begun.ChangeSetId,
            AuthoringContractReviewTests.Mutation("Clients and jobs",
                AuthoringContractReviewTests.Op("schema.createEntity", new { entityId = "client", displayName = "Client" }),
                Field("client", "clientName", "Name", "Text", true),
                AuthoringContractReviewTests.Op("schema.createEntity", new { entityId = "job", displayName = "Job" }),
                Field("job", "jobName", "Name", "Text", true),
                Field("job", "jobClient", "Client", "Reference", false)),
            AuthoringContractReviewTests.Mutation("Bind the client",
                AuthoringContractReviewTests.Op("schema.configureReference", new { entityId = "job", fieldId = "jobClient", targetEntityId = "client", labelFieldId = "clientName" })));
        foreach (var chunk in Enumerable.Range(1, clients).Chunk(NendoAuthoringLimits.Current.OperationsPerCall))
        {
            await AddAsync(begun.ChangeSetId, AuthoringContractReviewTests.Mutation($"Clients from {chunk[0]}",
                chunk.Select(index => AuthoringContractReviewTests.Op("data.createRecord",
                    new { entityId = "client", recordId = $"client{index:D2}", values = new { clientName = $"Client {index:D2}" } })).ToArray()));
        }
        await AddAsync(begun.ChangeSetId, AuthoringContractReviewTests.Mutation("The board",
            AuthoringContractReviewTests.Op("ui.addNode", new
            {
                surfaceId = "jobBoard", nodeId = "jobBoard", parentNodeId = (string?)null, kind = "boardSurface", position = 0,
                properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "job", ["title"] = "Jobs by client", ["groupByFieldId"] = "jobClient" },
            }),
            AuthoringContractReviewTests.Op("ui.addNode", new
            {
                surfaceId = "jobBoard", nodeId = "jobBoardName", parentNodeId = "jobBoard", kind = "fieldBinding", position = 0,
                properties = new Dictionary<string, object?> { ["fieldId"] = "jobName" },
            }),
            AuthoringContractReviewTests.Op("ui.addNode", new
            {
                surfaceId = "jobBoard", nodeId = "jobBoardOnly", parentNodeId = "jobBoard", kind = "filterClause", position = 1,
                properties = new Dictionary<string, object?> { ["fieldId"] = "jobClient", ["operator"] = "eq", ["value"] = only },
            }),
            // A screen for the clients too, so the preview's plan carries their records for the filter.
            AuthoringContractReviewTests.Op("ui.addNode", new
            {
                surfaceId = "clientAll", nodeId = "clientAll", parentNodeId = (string?)null, kind = "recordList", position = 1,
                properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "client", ["title"] = "Clients" },
            }),
            AuthoringContractReviewTests.Op("ui.addNode", new
            {
                surfaceId = "clientAll", nodeId = "clientAllName", parentNodeId = "clientAll", kind = "fieldBinding", position = 0,
                properties = new Dictionary<string, object?> { ["fieldId"] = "clientName" },
            })));
        var validated = await ValidateAsync(begun.ChangeSetId);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State,
            string.Join(" | ", validated.Diagnostics.Select(value => $"{value.Code} {value.Message}")));
        return validated.Preview.Surfaces.Single(surface => surface.NodeId == "jobBoard").Shape ?? "(null)";
    }

    private string NextKey(string kind) => $"{kind}-{Interlocked.Increment(ref _keys):D3}";

    public async ValueTask DisposeAsync()
    {
        Authoring.Dispose();
        Authority.Dispose();
        await Workspace.DisposeAsync();
    }
}
