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
    public async Task RevisionFourExposesOnlySanitizedAgentLifecycleMethods()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "protocol-discovery");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath),
            _ => { });

        var noFile = await handler.HandleAsync(Request("agent-no-file", WorkbenchMethods.AgentGetStatus));
        Assert.IsTrue(noFile.Ok);
        Assert.IsFalse(((DesktopAgentStatus)noFile.Result!).Available);
        Assert.IsTrue((await handler.HandleAsync(
            Request("agent-create", WorkbenchMethods.SessionCreateFile))).Ok);

        var inspect = await handler.HandleAsync(Request(
            "agent-inspect",
            WorkbenchMethods.AgentSetMode,
            new { mode = "inspect" }));
        Assert.IsTrue(inspect.Ok);
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

        var invalid = await handler.HandleAsync(Request(
            "agent-invalid",
            WorkbenchMethods.AgentSetMode,
            new { mode = "unbounded" }));
        Assert.IsFalse(invalid.Ok);
        Assert.AreEqual("validation", invalid.Error!.Code);

        var missingProposal = await handler.HandleAsync(Request(
            "agent-missing-proposal",
            WorkbenchMethods.AgentGetProposal,
            new { proposalId = "proposal-00000000000000000000000000000000" }));
        Assert.IsFalse(missingProposal.Ok);
        Assert.AreEqual("proposal-not-found", missingProposal.Error!.Code);

        var off = await handler.HandleAsync(Request(
            "agent-off",
            WorkbenchMethods.AgentSetMode,
            new { mode = "off" }));
        Assert.IsTrue(off.Ok);
        Assert.IsEmpty(Directory.GetFiles(discoveryRoot, "*.json"));

        var previousVersion = await handler.HandleAsync(RequestForVersion(
            DesktopShellContract.PreviousBridgeProtocolVersion,
            "agent-v3",
            WorkbenchMethods.AgentGetStatus));
        Assert.IsFalse(previousVersion.Ok);
        Assert.AreEqual("unknown-method", previousVersion.Error!.Code);
    }

    private static readonly IReadOnlySet<string> LegacyMethods = new HashSet<string>(
        [
            WorkbenchMethods.SchemaCreateIdea,
            WorkbenchMethods.DataCreateIdea,
            WorkbenchMethods.DataSetIdeaTitle,
            WorkbenchMethods.DataCreateFullIdea,
            WorkbenchMethods.DataSetIdeaField,
            WorkbenchMethods.DataExecuteIdeaCommand,
            WorkbenchMethods.ProposalPrepareIdeaGarden,
            WorkbenchMethods.ProposalPrepareBoardTitle,
        ],
        StringComparer.Ordinal);

    [TestMethod]
    public async Task ClosedProtocolRunsTheP1JourneyWithoutReturningTheDatabasePath()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath),
            _ => { });

        // Windows save providers may reserve a newly selected destination by
        // creating an empty placeholder before returning its path to the host.
        await File.WriteAllBytesAsync(workspace.FilePath, []);
        var createdFile = await handler.HandleAsync(Request("request-create-file", WorkbenchMethods.SessionCreateFile));
        var schema = await handler.HandleAsync(Request(
            "request-schema",
            WorkbenchMethods.SchemaCreateIdea,
            new { idempotencyKey = "protocol-schema" }));
        var record = await handler.HandleAsync(Request(
            "request-record",
            WorkbenchMethods.DataCreateIdea,
            new
            {
                recordId = "idea-protocol",
                title = "Protocol idea",
                idempotencyKey = "protocol-record",
            }));
        var edit = await handler.HandleAsync(Request(
            "request-edit",
            WorkbenchMethods.DataSetIdeaTitle,
            new
            {
                recordId = "idea-protocol",
                expectedRecordVersion = 1,
                title = "Edited through protocol",
                idempotencyKey = "protocol-edit",
            }));

        Assert.IsTrue(createdFile.Ok);
        Assert.IsTrue(schema.Ok);
        Assert.IsTrue(record.Ok);
        Assert.IsTrue(edit.Ok);
        var mutation = (DesktopMutationView)edit.Result!;
        Assert.IsNotNull(mutation.Session);
        Assert.AreEqual(3L, mutation.Session.Manifest!.ChangeSequence);
        Assert.AreEqual(2L, mutation.Session.Records[0].RecordVersion);
        Assert.AreEqual(
            "Edited through protocol",
            mutation.Session.Records[0].Values[Nendo.Engine.NendoApplicationService.IdeaTitleFieldId].GetString());
        var json = WorkbenchProtocolHandler.Serialize(edit);
        Assert.DoesNotContain(workspace.FilePath, json, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("desktop-session.nendo", json, StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task UnknownMethodAndProtocolVersionFailClosed()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null),
            _ => { });

        var unknown = await handler.HandleAsync(Request("unknown", "host.invoke"));
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

    [TestMethod]
    public async Task OversizedAndOverdeepRequestsFailBeforeDispatch()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null),
            _ => { });

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
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(null),
            _ => { });

        var response = await handler.HandleAsync(
            Request("save-existing-file", WorkbenchMethods.SessionCreateFile));

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
            () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null),
            appearance => applied = appearance);

        var accepted = await handler.HandleAsync(Request(
            "appearance-dark",
            WorkbenchMethods.AppearanceSet,
            new { preference = "dark", effective = "dark" }));
        var rejected = await handler.HandleAsync(Request(
            "appearance-invalid",
            WorkbenchMethods.AppearanceSet,
            new { preference = "sepia", effective = "dark" }));

        Assert.IsTrue(accepted.Ok);
        Assert.AreEqual("dark", applied!.Preference);
        Assert.IsFalse(rejected.Ok);
        Assert.AreEqual("validation", rejected.Error!.Code);
    }

    [TestMethod]
    public async Task ClosedProtocolRunsProposalUseHistoryAndCompensationJourney()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath),
            _ => { });

        Assert.IsTrue((await handler.HandleAsync(Request(
            "p2-create-file",
            WorkbenchMethods.SessionCreateFile))).Ok);
        Assert.IsTrue((await handler.HandleAsync(Request(
            "p2-create-schema",
            WorkbenchMethods.SchemaCreateIdea,
            new { idempotencyKey = "p2-protocol-schema" }))).Ok);

        var prepared = await handler.HandleAsync(Request(
            "p2-prepare",
            WorkbenchMethods.ProposalPrepareIdeaGarden));
        var preview = (Nendo.Engine.NendoProposalPreview)prepared.Result!;
        Assert.AreEqual(Nendo.Engine.NendoProposalState.Previewable, preview.State);
        Assert.IsNotEmpty(preview.PreviewApplications);

        var promoted = await handler.HandleAsync(Request(
            "p2-promote",
            WorkbenchMethods.ProposalPromote,
            new { proposalId = preview.ProposalId }));
        Assert.IsTrue(((DesktopPromotionView)promoted.Result!).Promotion.Applied);

        var created = await handler.HandleAsync(Request(
            "p2-create-record",
            WorkbenchMethods.DataCreateFullIdea,
            new
            {
                recordId = "idea-p2-protocol",
                title = "Protocol garden",
                notes = "Complete record",
                status = "Idea",
                energy = "Medium",
                createdDate = "2026-09-03",
                nextAction = "Exercise the command",
                idempotencyKey = "p2-protocol-record",
            }));
        var createdView = (DesktopMutationView)created.Result!;
        Assert.IsNotNull(createdView.Session);

        var command = await handler.HandleAsync(Request(
            "p2-command",
            WorkbenchMethods.DataExecuteIdeaCommand,
            new
            {
                commandId = "command.idea.moveToTrying",
                recordId = "idea-p2-protocol",
                expectedRecordVersion = createdView.Session.Records.Single().RecordVersion,
                idempotencyKey = "p2-protocol-command",
            }));
        var commandView = (DesktopMutationView)command.Result!;
        Assert.IsNotNull(commandView.Session);
        Assert.AreEqual(
            "Trying",
            commandView.Session.Records.Single().Values[
                Nendo.Engine.NendoApplicationService.IdeaStatusFieldId].GetString());

        var compilation = await handler.HandleAsync(Request(
            "p2-compile",
            WorkbenchMethods.SemanticCompile));
        var history = await handler.HandleAsync(Request(
            "p2-history",
            WorkbenchMethods.HistoryGet));
        Assert.IsTrue(((Nendo.Engine.NendoCompileResult)compilation.Result!).IsValid);
        Assert.IsNotEmpty((IReadOnlyList<Nendo.Engine.NendoRevisionSnapshot>)history.Result!);

        var compensated = await handler.HandleAsync(Request(
            "p2-compensate",
            WorkbenchMethods.HistoryCompensate,
            new
            {
                revisionId = commandView.Mutation.RevisionId,
                idempotencyKey = "p2-protocol-compensate",
            }));
        var compensatedView = (DesktopMutationView)compensated.Result!;
        Assert.IsNotNull(compensatedView.Session);
        Assert.AreEqual(
            "Idea",
            compensatedView.Session.Records.Single().Values[
                Nendo.Engine.NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.DoesNotContain(workspace.FilePath, WorkbenchProtocolHandler.Serialize(compensated));
    }

    [TestMethod]
    public async Task RevisionFourCompatibilityRunsDecisionLogThroughGenericTypedRequests()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath),
            _ => { });

        var createdFile = await handler.HandleAsync(Request(
            "decision-create-file",
            WorkbenchMethods.SessionCreateFile));
        Assert.IsTrue(createdFile.Ok);
        Assert.AreEqual(DesktopShellContract.AgentBridgeProtocolVersion, createdFile.ProtocolVersion);

        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var prepared = await handler.HandleAsync(Request(
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

        var promoted = await handler.HandleAsync(Request(
            "decision-promote",
            WorkbenchMethods.ProposalPromote,
            new { proposalId }));
        Assert.IsTrue(((DesktopPromotionView)promoted.Result!).Promotion.Applied);

        var created = await handler.HandleAsync(Request(
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

        var edited = await handler.HandleAsync(Request(
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

        var command = await handler.HandleAsync(Request(
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

        var stale = await handler.HandleAsync(Request(
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

    [TestMethod]
    public async Task ProtocolVersionsKeepGenericAndIdeaMethodsSeparated()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null),
            _ => { });

        var legacyGeneric = await handler.HandleAsync(RequestForVersion(
            DesktopShellContract.LegacyBridgeProtocolVersion,
            "legacy-generic",
            WorkbenchMethods.DataCreateRecord,
            new { }));
        var currentIdea = await handler.HandleAsync(RequestForVersion(
            DesktopShellContract.BridgeProtocolVersion,
            "current-idea",
            WorkbenchMethods.SchemaCreateIdea,
            new { }));

        Assert.IsFalse(legacyGeneric.Ok);
        Assert.AreEqual(DesktopShellContract.LegacyBridgeProtocolVersion, legacyGeneric.ProtocolVersion);
        Assert.AreEqual("unknown-method", legacyGeneric.Error!.Code);
        Assert.IsFalse(currentIdea.Ok);
        Assert.AreEqual(DesktopShellContract.BridgeProtocolVersion, currentIdea.ProtocolVersion);
        Assert.AreEqual("unknown-method", currentIdea.Error!.Code);
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

    private static string Request(string requestId, string method, object? payload = null) =>
        RequestForVersion(
            LegacyMethods.Contains(method)
                ? DesktopShellContract.LegacyBridgeProtocolVersion
                : DesktopShellContract.AgentBridgeProtocolVersion,
            requestId,
            method,
            payload);

    [TestMethod]
    public async Task EveryMethodTheWorkbenchSendsIsAdmittedAtTheCurrentProtocol()
    {
        // The host fences its methods by protocol version, and the Workbench names the
        // methods it sends as string literals. Nothing tied the two together: on
        // 2026-09-03 the compatibility methods left the current version, and Studio's
        // board rename went on sending one for sixteen days, answered by a red
        // sentence in Studio and a timeout in the review lane (F-084). This reads the
        // literals off the Workbench source and asks the real handler about each one
        // at the version the Workbench speaks. It sees a method the host once had and
        // has since fenced off; a method the host never had is the review lanes' to find.
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
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null),
            _ => { });
        var refused = new List<string>();
        foreach (var (method, file) in sent)
        {
            var response = await handler.HandleAsync(RequestForVersion(
                DesktopShellContract.BridgeProtocolVersion, "sent-" + method, method));
            if (!response.Ok && response.Error!.Code == "unknown-method") refused.Add($"{method} (sent by {file})");
        }
        Assert.IsEmpty(refused,
            $"The Workbench sends methods the host does not admit at protocol version {DesktopShellContract.BridgeProtocolVersion}: {string.Join(", ", refused)}");
    }

    private static string RequestForVersion(
        int protocolVersion,
        string requestId,
        string method,
        object? payload = null) =>
        JsonSerializer.Serialize(new
        {
            protocolVersion,
            requestId,
            method,
            payload = payload ?? new { },
        });
}
