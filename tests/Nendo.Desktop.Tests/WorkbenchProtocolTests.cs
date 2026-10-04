using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchProtocolTests
{
    [TestMethod]
    public async Task TheAgentLifecycleMethodsAreSanitized()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "protocol-discovery");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot);
        var handler = Handler(session, workspace.FilePath);

        var noFile = await handler.HandleAsync(await RequestAsync(session, "agent-no-file", WorkbenchMethods.AgentGetStatus));
        Assert.IsTrue(noFile.Ok, noFile.Error?.Message);
        Assert.IsFalse(((DesktopAgentStatus)noFile.Result!).Available);
        var createdFile = await handler.HandleAsync(await RequestAsync(session, "agent-create", WorkbenchMethods.SessionCreateFile));
        Assert.IsTrue(createdFile.Ok, createdFile.Error?.Message);

        var inspect = await handler.HandleAsync(await RequestAsync(session,
            "agent-inspect",
            WorkbenchMethods.AgentSetMode,
            new { mode = "inspect" }));
        Assert.IsTrue(inspect.Ok, inspect.Error?.Message);
        var status = (DesktopAgentStatus)inspect.Result!;
        Assert.AreEqual("inspect", status.Mode);
        Assert.AreEqual("ready", status.State);
        var serialized = WorkbenchProtocolHandler.Serialize(inspect);
        // The endpoint is shown so a person can hand it to an agent; it carries no credential.
        StringAssert.Contains(serialized, "\"endpoint\":\"http://127.0.0.1:");
        Assert.DoesNotContain("bearer", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sessionId", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("discovery", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(workspace.FilePath, serialized, StringComparison.OrdinalIgnoreCase);

        var invalid = await handler.HandleAsync(await RequestAsync(session,
            "agent-invalid",
            WorkbenchMethods.AgentSetMode,
            new { mode = "unbounded" }));
        Assert.IsFalse(invalid.Ok);
        Assert.AreEqual("validation", invalid.Error!.Code);

        var missingProposal = await handler.HandleAsync(await RequestAsync(session,
            "agent-missing-proposal",
            WorkbenchMethods.AgentGetProposal,
            new { proposalId = "proposal-00000000000000000000000000000000" }));
        Assert.IsFalse(missingProposal.Ok);
        Assert.AreEqual("proposal-not-found", missingProposal.Error!.Code);

        var off = await handler.HandleAsync(await RequestAsync(session,
            "agent-off",
            WorkbenchMethods.AgentSetMode,
            new { mode = "off" }));
        Assert.IsTrue(off.Ok, off.Error?.Message);
        Assert.IsEmpty(Directory.GetFiles(discoveryRoot, "*.json"));

        // A renderer from before the agent methods existed is refused as a whole, not method by method.
        var olderRenderer = await handler.HandleAsync(RequestForVersion(
            3,
            "agent-v3",
            WorkbenchMethods.AgentGetStatus,
            fileSessionId: (await session.GetViewAsync()).FileSessionId));
        Assert.IsFalse(olderRenderer.Ok);
        Assert.AreEqual("unsupported-protocol", olderRenderer.Error!.Code);
    }

    [TestMethod]
    public async Task TheBridgeRunsTheP1JourneyWithoutReturningTheDatabasePath()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session, workspace.FilePath);

        // Windows save providers may reserve a newly selected destination by
        // creating an empty placeholder before returning its path to the host.
        await File.WriteAllBytesAsync(workspace.FilePath, []);
        var createdFile = await handler.HandleAsync(await RequestAsync(session, "request-create-file", WorkbenchMethods.SessionCreateFile));
        Assert.IsTrue(createdFile.Ok, createdFile.Error?.Message);
        // The bridge has no schema method of its own: a person shapes a schema through a
        // proposal, which the journey below covers. The fixture gives this one a title field.
        await session.CreateIdeaSchemaAsync("protocol-schema");
        var record = await handler.HandleAsync(await RequestAsync(session,
            "request-record",
            WorkbenchMethods.DataCreateRecord,
            new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                recordId = "idea-protocol",
                values = new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "Protocol idea" },
                idempotencyKey = "protocol-record",
            }));
        var edit = await handler.HandleAsync(await RequestAsync(session,
            "request-edit",
            WorkbenchMethods.DataSetField,
            new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                recordId = "idea-protocol",
                fieldId = NendoApplicationService.IdeaTitleFieldId,
                expectedRecordVersion = 1,
                value = "Edited through protocol",
                idempotencyKey = "protocol-edit",
            }));

        Assert.IsTrue(record.Ok, record.Error?.Message);
        Assert.IsTrue(edit.Ok, edit.Error?.Message);
        var mutation = (DesktopMutationView)edit.Result!;
        Assert.IsNotNull(mutation.Session);
        Assert.AreEqual(3L, mutation.Session.Manifest!.ChangeSequence);
        Assert.AreEqual(2L, mutation.Session.Records[0].RecordVersion);
        Assert.AreEqual(
            "Edited through protocol",
            mutation.Session.Records[0].Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        var json = WorkbenchProtocolHandler.Serialize(edit);
        Assert.DoesNotContain(workspace.FilePath, json, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("desktop-session.nendo", json, StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task UnknownMethodAndProtocolVersionFailClosed()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session);

        var unknown = await handler.HandleAsync(await RequestAsync(session, "unknown", "host.invoke"));
        var version = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = 99,
            requestId = "wrong-version",
            method = WorkbenchMethods.SessionGetSnapshot,
            payload = new { },
        }));

        Assert.IsFalse(unknown.Ok);
        Assert.AreEqual("unknown-method", unknown.Error!.Code);
        Assert.IsFalse(version.Ok);
        Assert.AreEqual("unsupported-protocol", version.Error!.Code);
    }

    /// <summary>
    /// W-135 (2026-10-04): the host serves bridge protocol 7 only. A Workbench at 2 to 6 gets one
    /// named refusal, answered at the current version, before any binding, read, write or file
    /// action runs.
    /// </summary>
    [TestMethod]
    public async Task AWorkbenchOlderThanTheBridgeIsRefusedByNameBeforeAnythingRuns()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var created = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("refusal-schema");
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;
        var fileActions = 0;
        var handler = new WorkbenchProtocolHandler(session, _ => { }, _ =>
        {
            fileActions++;
            return Task.FromResult(new DesktopFileActionView(null, null));
        });
        var record = new
        {
            entityId = NendoApplicationService.IdeaEntityId,
            recordId = "refused",
            values = new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "Never written" },
            idempotencyKey = "refused",
        };

        foreach (var version in new[] { 2, 3, 4, 5, 6 })
        {
            foreach (var (method, payload) in new (string, object?)[]
                     {
                         (WorkbenchMethods.SessionGetSnapshot, null),
                         (WorkbenchMethods.DataCreateRecord, record),
                         (WorkbenchMethods.SessionCreateFile, null),
                         (WorkbenchMethods.FileClose, null),
                     })
            {
                var response = await handler.HandleAsync(RequestForVersion(version, $"v{version}-{method}", method, payload, created.FileSessionId));
                Assert.IsFalse(response.Ok, $"{method} answered a version {version} renderer.");
                Assert.AreEqual("unsupported-protocol", response.Error!.Code, $"{method} at {version}");
                Assert.AreEqual(DesktopShellContract.BridgeProtocolVersion, response.ProtocolVersion,
                    "A refusal is answered at the version the host speaks, not echoed back at the old one.");
                StringAssert.Contains(response.Error.Message, $"protocol {version}");
                StringAssert.Contains(response.Error.Message, $"protocol {DesktopShellContract.BridgeProtocolVersion} only");
            }
        }

        Assert.AreEqual(0, fileActions, "A refused renderer started a file action.");
        Assert.IsTrue(session.HasFile, "A refused renderer closed the file.");
        var after = await session.GetViewAsync();
        Assert.AreEqual(created.FileSessionId, after.FileSessionId);
        Assert.AreEqual(before, after.Manifest!.ChangeSequence, "A refused renderer wrote to the file.");
    }

    [TestMethod]
    public async Task OversizedAndOverdeepRequestsFailBeforeDispatch()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session);

        var oversized = await handler.HandleAsync(new string('x', WorkbenchProtocolHandler.MaximumMessageCharacters + 1));
        var nested = Enumerable.Range(0, 18)
            .Aggregate("{}", (inner, _) => $"{{\"value\":{inner}}}");
        var overdeep = await handler.HandleAsync($$"""
            {"protocolVersion":{{DesktopShellContract.BridgeProtocolVersion}},"requestId":"deep","method":"session.getSnapshot","payload":{{nested}}}
            """);

        Assert.IsFalse(oversized.Ok);
        Assert.AreEqual("request-too-large", oversized.Error!.Code);
        Assert.IsFalse(overdeep.Ok);
        Assert.AreEqual("invalid-request", overdeep.Error!.Code);
    }

    [TestMethod]
    public async Task SaveSelectionDoesNotOverwriteANonEmptyFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        var original = new byte[] { 0x4E, 0x45, 0x4E, 0x44, 0x4F };
        await File.WriteAllBytesAsync(workspace.FilePath, original);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session, workspace.FilePath);

        var response = await handler.HandleAsync(
            await RequestAsync(session, "save-existing-file", WorkbenchMethods.SessionCreateFile));

        Assert.IsFalse(response.Ok);
        Assert.AreEqual("file-io", response.Error!.Code);
        CollectionAssert.AreEqual(original, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.IsFalse(session.HasFile);
    }

    [TestMethod]
    public async Task AppearanceMessageIsBoundedAndTyped()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        AppearancePayload? applied = null;
        var handler = new WorkbenchProtocolHandler(
            session,
            appearance => applied = appearance);

        var accepted = await handler.HandleAsync(RequestForVersion(
            DesktopShellContract.BridgeProtocolVersion,
            "appearance-dark",
            WorkbenchMethods.AppearanceSet,
            new { preference = "dark", effective = "dark" }));
        var rejected = await handler.HandleAsync(RequestForVersion(
            DesktopShellContract.BridgeProtocolVersion,
            "appearance-invalid",
            WorkbenchMethods.AppearanceSet,
            new { preference = "sepia", effective = "dark" }));

        Assert.IsTrue(accepted.Ok);
        Assert.AreEqual("dark", applied!.Preference);
        Assert.IsFalse(rejected.Ok);
        Assert.AreEqual("validation", rejected.Error!.Code);
    }

    [TestMethod]
    public async Task TheBridgeRunsProposalUseHistoryAndCompensationJourney()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session, workspace.FilePath);

        var createdFile = await handler.HandleAsync(await RequestAsync(session, "p2-create-file", WorkbenchMethods.SessionCreateFile));
        Assert.IsTrue(createdFile.Ok, createdFile.Error?.Message);
        // The reference application arrives as a proposal the fixture prepares; promoting it is
        // the bridge's, as it is the person's.
        await session.CreateIdeaSchemaAsync("p2-protocol-schema");
        var preview = await session.PrepareIdeaGardenProposalAsync();
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.IsNotEmpty(preview.PreviewApplications);

        var promoted = await handler.HandleAsync(await RequestAsync(session,
            "p2-promote",
            WorkbenchMethods.ProposalPromote,
            new { proposalId = preview.ProposalId }));
        Assert.IsTrue(promoted.Ok, promoted.Error?.Message);
        Assert.IsTrue(((DesktopPromotionView)promoted.Result!).Promotion.Applied);

        var created = await handler.HandleAsync(await RequestAsync(session,
            "p2-create-record",
            WorkbenchMethods.DataCreateRecord,
            new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                recordId = "idea-p2-protocol",
                values = new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = "Protocol garden",
                    [NendoApplicationService.IdeaNotesFieldId] = "Complete record",
                    [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                    [NendoApplicationService.IdeaEnergyFieldId] = "Medium",
                    [NendoApplicationService.IdeaCreatedDateFieldId] = "2026-09-03",
                    [NendoApplicationService.IdeaNextActionFieldId] = "Exercise the command",
                },
                idempotencyKey = "p2-protocol-record",
            }));
        Assert.IsTrue(created.Ok, created.Error?.Message);
        var createdView = (DesktopMutationView)created.Result!;
        Assert.IsNotNull(createdView.Session);

        var command = await handler.HandleAsync(await RequestAsync(session,
            "p2-command",
            WorkbenchMethods.DataExecuteCommand,
            new
            {
                commandId = "command.idea.moveToTrying",
                recordId = "idea-p2-protocol",
                expectedRecordVersion = createdView.Session.Records.Single().RecordVersion,
                idempotencyKey = "p2-protocol-command",
            }));
        Assert.IsTrue(command.Ok, command.Error?.Message);
        var commandView = (DesktopMutationView)command.Result!;
        Assert.IsNotNull(commandView.Session);
        Assert.AreEqual(
            "Trying",
            commandView.Session.Records.Single().Values[NendoApplicationService.IdeaStatusFieldId].GetString());

        var compilation = await handler.HandleAsync(await RequestAsync(session,
            "p2-compile",
            WorkbenchMethods.SemanticCompile));
        var history = await handler.HandleAsync(await RequestAsync(session,
            "p2-history",
            WorkbenchMethods.HistoryGet));
        Assert.IsTrue(((NendoCompileResult)compilation.Result!).IsValid);
        Assert.IsNotEmpty((IReadOnlyList<NendoRevisionSnapshot>)history.Result!);

        var compensated = await handler.HandleAsync(await RequestAsync(session,
            "p2-compensate",
            WorkbenchMethods.HistoryCompensate,
            new
            {
                revisionId = commandView.Mutation.RevisionId,
                idempotencyKey = "p2-protocol-compensate",
            }));
        Assert.IsTrue(compensated.Ok, compensated.Error?.Message);
        var compensatedView = (DesktopMutationView)compensated.Result!;
        Assert.IsNotNull(compensatedView.Session);
        Assert.AreEqual(
            "Idea",
            compensatedView.Session.Records.Single().Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.DoesNotContain(workspace.FilePath, WorkbenchProtocolHandler.Serialize(compensated));
    }

    [TestMethod]
    public async Task TheBridgeRunsADecisionLogThroughGenericTypedRequests()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session, workspace.FilePath);

        var createdFile = await handler.HandleAsync(await RequestAsync(session,
            "decision-create-file",
            WorkbenchMethods.SessionCreateFile));
        Assert.IsTrue(createdFile.Ok, createdFile.Error?.Message);
        Assert.AreEqual(DesktopShellContract.BridgeProtocolVersion, createdFile.ProtocolVersion);

        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var prepared = await handler.HandleAsync(await RequestAsync(session,
            "decision-prepare",
            WorkbenchMethods.ProposalPrepareChangeSet,
            new PrepareChangeSetPayload(
                proposalId,
                "Create Decision Log",
                DecisionDefinitionMutations(proposalId))));
        Assert.IsTrue(prepared.Ok, prepared.Error?.Message);
        var preview = (NendoProposalPreview)prepared.Result!;
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.AreEqual("entity.decision", preview.PreviewApplications.Single().Entity.SemanticId);

        var promoted = await handler.HandleAsync(await RequestAsync(session,
            "decision-promote",
            WorkbenchMethods.ProposalPromote,
            new { proposalId }));
        Assert.IsTrue(((DesktopPromotionView)promoted.Result!).Promotion.Applied);

        var created = await handler.HandleAsync(await RequestAsync(session,
            "decision-create-record",
            WorkbenchMethods.DataCreateRecord,
            new
            {
                entityId = "entity.decision",
                recordId = "decision-protocol",
                values = new Dictionary<string, object?>
                {
                    ["field.decision.title"] = "Use one generic bridge",
                    ["field.decision.context"] = "Both applications use stable semantic identities.",
                    ["field.decision.state"] = "Proposed",
                    ["field.decision.owner"] = "Thomas",
                    ["field.decision.reviewDate"] = "2026-09-18",
                },
                idempotencyKey = "decision-create",
            }));
        Assert.IsTrue(created.Ok, created.Error?.Message);

        var edited = await handler.HandleAsync(await RequestAsync(session,
            "decision-edit-owner",
            WorkbenchMethods.DataSetField,
            new
            {
                entityId = "entity.decision",
                recordId = "decision-protocol",
                fieldId = "field.decision.owner",
                expectedRecordVersion = 1,
                value = "Thomas Klok Rohde",
                idempotencyKey = "decision-edit",
            }));
        Assert.IsTrue(edited.Ok, edited.Error?.Message);

        var command = await handler.HandleAsync(await RequestAsync(session,
            "decision-command",
            WorkbenchMethods.DataExecuteCommand,
            new
            {
                commandId = "command.decision.accept",
                recordId = "decision-protocol",
                expectedRecordVersion = 2,
                idempotencyKey = "decision-command",
            }));
        Assert.IsTrue(command.Ok, command.Error?.Message);
        var commandView = (DesktopMutationView)command.Result!;
        Assert.IsNotNull(commandView.Session);
        var record = commandView.Session.Records.Single();
        Assert.AreEqual(3L, record.RecordVersion);
        Assert.AreEqual("Accepted", record.Values["field.decision.state"].GetString());
        Assert.AreEqual("Thomas Klok Rohde", record.Values["field.decision.owner"].GetString());

        var stale = await handler.HandleAsync(await RequestAsync(session,
            "decision-stale",
            WorkbenchMethods.DataSetField,
            new
            {
                entityId = "entity.decision",
                recordId = "decision-protocol",
                fieldId = "field.decision.context",
                expectedRecordVersion = 1,
                value = "stale",
                idempotencyKey = "decision-stale",
            }));
        Assert.IsFalse(stale.Ok);
        Assert.AreEqual("record-version-conflict", stale.Error!.Code);
        Assert.DoesNotContain(workspace.FilePath, WorkbenchProtocolHandler.Serialize(command));
    }

    /// <summary>
    /// The eight methods that served the Idea Garden by name at protocol 2 are gone with it
    /// (W-135). An open file and its current generation, so each request reaches the dispatch
    /// itself rather than stopping at the binding.
    /// </summary>
    [TestMethod]
    public async Task TheRetiredApplicationMethodsAreUnknown()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var handler = Handler(session);

        foreach (var method in new[]
                 {
                     "schema.createIdea", "data.createIdea", "data.setIdeaTitle", "data.createFullIdea",
                     "data.setIdeaField", "data.executeIdeaCommand", "proposal.prepareIdeaGarden", "proposal.prepareBoardTitle",
                 })
        {
            var response = await handler.HandleAsync(await RequestAsync(session, "retired-" + method, method));
            Assert.IsFalse(response.Ok, method);
            Assert.AreEqual("unknown-method", response.Error!.Code, method);
        }
    }

    private static IReadOnlyList<CanonicalMutationPayload> DecisionDefinitionMutations(string proposalId)
    {
        var operations = new List<NendoCanonicalOperationRequest>();
        void Add(string operationType, object payload) => operations.Add(new NendoCanonicalOperationRequest(
            $"{proposalId}-operation-{operations.Count:D3}",
            operationType,
            JsonSerializer.SerializeToElement(payload)));
        void Property(string surfaceId, string nodeId, string name, object value) => Add(
            "ui.setProperty",
            new { surfaceId, nodeId, propertyName = name, value });
        void Root(string surfaceId, string nodeId, string kind, string title)
        {
            Add("ui.addNode", new { surfaceId, nodeId, parentNodeId = (string?)null, kind, position = 0 });
            Property(surfaceId, nodeId, "definitionVersion", 3);
            Property(surfaceId, nodeId, "entityId", "entity.decision");
            Property(surfaceId, nodeId, "title", title);
        }
        void Bindings(string surfaceId, string rootNodeId, string role, IReadOnlyList<string> fieldIds)
        {
            for (var position = 0; position < fieldIds.Count; position++)
            {
                var nodeId = $"node.decision.{role}.{position:D2}";
                Add("ui.addNode", new { surfaceId, nodeId, parentNodeId = rootNodeId, kind = "fieldBinding", position });
                Property(surfaceId, nodeId, "fieldId", fieldIds[position]);
            }
        }

        Add("schema.createEntity", new { entityId = "entity.decision", displayName = "Decision" });
        Add("schema.addField", new { entityId = "entity.decision", fieldId = "field.decision.title", displayName = "Title", storageKind = "text", required = true, presentation = "singleLine", options = Array.Empty<string>() });
        Add("schema.addField", new { entityId = "entity.decision", fieldId = "field.decision.context", displayName = "Context", storageKind = "text", required = false, presentation = "longText", options = Array.Empty<string>() });
        Add("schema.addField", new { entityId = "entity.decision", fieldId = "field.decision.state", displayName = "State", storageKind = "text", required = true, presentation = "singleChoice", options = new[] { "Proposed", "Accepted", "Superseded" } });
        Add("schema.addField", new { entityId = "entity.decision", fieldId = "field.decision.owner", displayName = "Owner", storageKind = "text", required = false, presentation = "singleLine", options = Array.Empty<string>() });
        Add("schema.addField", new { entityId = "entity.decision", fieldId = "field.decision.reviewDate", displayName = "Review date", storageKind = "date", required = false, presentation = "date", options = Array.Empty<string>() });

        var allFields = new[] { "field.decision.title", "field.decision.context", "field.decision.state", "field.decision.owner", "field.decision.reviewDate" };
        var listFields = new[] { "field.decision.title", "field.decision.state", "field.decision.owner", "field.decision.reviewDate" };
        var cardFields = new[] { "field.decision.title", "field.decision.owner", "field.decision.reviewDate" };
        Root("surface.decision.form", "node.decision.form.root", "recordForm", "Decision record");
        Bindings("surface.decision.form", "node.decision.form.root", "form", allFields);
        Root("surface.decision.list", "node.decision.list.root", "recordList", "Decision register");
        Bindings("surface.decision.list", "node.decision.list.root", "list", listFields);
        Root("surface.decision.board", "node.decision.board.root", "boardSurface", "Decision board");
        Property("surface.decision.board", "node.decision.board.root", "groupByFieldId", "field.decision.state");
        Bindings("surface.decision.board", "node.decision.board.root", "card", cardFields);
        Add("ui.addNode", new { surfaceId = "surface.decision.commands", nodeId = "command.decision.accept", parentNodeId = (string?)null, kind = "recordCommand", position = 0 });
        Property("surface.decision.commands", "command.decision.accept", "definitionVersion", 3);
        Property("surface.decision.commands", "command.decision.accept", "entityId", "entity.decision");
        Property("surface.decision.commands", "command.decision.accept", "label", "Accept decision");
        Add("ui.addNode", new { surfaceId = "surface.decision.commands", nodeId = "command.decision.accept.step", parentNodeId = "command.decision.accept", kind = "commandStep", position = 0 });
        Property("surface.decision.commands", "command.decision.accept.step", "fieldId", "field.decision.state");
        Property("surface.decision.commands", "command.decision.accept.step", "valueKind", "literal");
        Property("surface.decision.commands", "command.decision.accept.step", "value", "Accepted");

        return [new CanonicalMutationPayload(
            $"{proposalId}-definition",
            "Create Decision application",
            operations.AsReadOnly())];
    }

    [TestMethod]
    public async Task EveryMethodTheWorkbenchSendsIsAdmittedAtTheCurrentProtocol()
    {
        // The host fences its methods by protocol version, and the Workbench names the
        // methods it sends as string literals. Nothing tied the two together: on
        // 2026-09-03 the compatibility methods left the current version, and Studio's
        // board rename went on sending one for sixteen days, answered by a red
        // sentence in Studio and a timeout in the review lane (F-084). This reads the
        // literals off the Workbench source and asks the real handler about each one
        // at the version the Workbench speaks, carrying the session's current generation
        // so each request reaches the dispatch. It sees a method the host once had and
        // has since dropped; a method the host never had is the review lanes' to find.
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Nendo.slnx"))) root = root.Parent;
        Assert.IsNotNull(root, "The repository root was not found above the test output directory.");
        var known = typeof(WorkbenchMethods)
            .GetFields(BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(field => (string)field.GetRawConstantValue()!)
            .ToHashSet(StringComparer.Ordinal);
        var sent = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in Directory.GetFiles(Path.Combine(root.FullName, "src", "Nendo.Workbench", "src"), "*.ts"))
        {
            foreach (Match match in Regex.Matches(File.ReadAllText(file), @"'([a-z]+\.[A-Za-z]+)'"))
            {
                if (known.Contains(match.Groups[1].Value)) sent.TryAdd(match.Groups[1].Value, Path.GetFileName(file));
            }
        }
        Assert.IsGreaterThan(20, sent.Count, "The scan found almost no methods, so it is reading the wrong files.");

        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = Handler(session);
        var refused = new List<string>();
        foreach (var (method, file) in sent)
        {
            var response = await handler.HandleAsync(await RequestAsync(session, "sent-" + method, method));
            if (!response.Ok && response.Error!.Code == "unknown-method") refused.Add($"{method} (sent by {file})");
        }
        Assert.IsEmpty(refused,
            $"The Workbench sends methods the host does not admit at protocol version {DesktopShellContract.BridgeProtocolVersion}: {string.Join(", ", refused)}");
    }

    /// <summary>
    /// A handler whose Create and Open file actions answer with <paramref name="pickedPath"/>, as the
    /// window's own pickers would, through the same session calls the window makes.
    /// </summary>
    private static WorkbenchProtocolHandler Handler(DesktopSessionController session, string? pickedPath = null) =>
        new(session, _ => { }, pickedPath is null ? null : async request => new DesktopFileActionView(request.Action switch
        {
            WorkbenchFileAction.Create => await session.CreateFromSavePickerAsync(pickedPath),
            WorkbenchFileAction.Open => await session.OpenAsync(pickedPath),
            _ => throw new InvalidOperationException($"This test has no {request.Action} action."),
        }, null));

    /// <summary>A request at the current version, for the file generation the session has now.</summary>
    private static async Task<string> RequestAsync(
        DesktopSessionController session,
        string requestId,
        string method,
        object? payload = null) =>
        RequestForVersion(
            DesktopShellContract.BridgeProtocolVersion,
            requestId,
            method,
            payload,
            (await session.GetViewAsync()).FileSessionId);

    private static string RequestForVersion(
        int protocolVersion,
        string requestId,
        string method,
        object? payload = null,
        string? fileSessionId = null) =>
        JsonSerializer.Serialize(new
        {
            protocolVersion,
            requestId,
            method,
            fileSessionId,
            payload = payload ?? new { },
        });
}
