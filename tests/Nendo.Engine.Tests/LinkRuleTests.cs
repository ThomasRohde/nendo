using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// A link rule, ADR-0026: a link record type names its source, target and kind, each end's
/// kind, and a record type of allowed combinations. Declaring checks the data; from then on the
/// end of every mutation, from every path, refuses a link no table record allows, naming it.
/// </summary>
[TestClass]
public sealed class LinkRuleTests
{
    private const string Things = "things";
    private const string Links = "links";
    private const string Allowed = "allowed";

    [TestMethod]
    public async Task DeclaringRecordsTheRuleRaisesTheLayoutAndSurvivesAReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        Assert.IsNull(Entity(await service.GetSnapshotAsync(), Links).LinkRule);

        await DeclareAsync(coordinator, service);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(Rule, Entity(after, Links).LinkRule);
        Assert.IsNull(Entity(after, Things).LinkRule);
        Assert.AreEqual(NendoFormat.LinkRuleMinimumHostVersion, after.Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-v1",
            inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
        coordinator = await workspace.OpenAsync();
        Assert.AreEqual(Rule, Entity(await new NendoApplicationService(coordinator).GetSnapshotAsync(), Links).LinkRule);
    }

    [TestMethod]
    public async Task AFileThatNeverDeclaresOneKeepsItsLayoutAndHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await LinkAsync(service, "l2", "r1", "a1", "nonsense");
        var snapshot = await service.GetSnapshotAsync();
        Assert.IsTrue(Version.Parse(snapshot.Manifest.MinimumHostVersion) < Version.Parse(NendoFormat.LinkRuleMinimumHostVersion));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.IsFalse((await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout!.Contains("-linkrule-", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task DeclaringOverLinksThatAreNotAllowedIsRefusedNamingEachAndNothingChanges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await LinkAsync(service, "l2", "r1", "a1", "assign");
        await LinkAsync(service, "l3", "a1", "g1", "assign");
        // A link missing its source, target or kind is not checked.
        await LinkAsync(service, "l4", "a1", null, "assign");
        await LinkAsync(service, "l5", "a1", "r1", null);

        var refused = await Refused(() => DeclareAsync(coordinator, service));
        Assert.AreEqual("links-not-allowed", refused.Code);
        StringAssert.Contains(refused.Message, "2 Links records are not allowed links by Allowed links: l2, l3.");
        Assert.IsFalse(refused.Message.Contains("assign", StringComparison.Ordinal), "A refusal names records, never stored text: " + refused.Message);
        Assert.IsNull(Entity(await service.GetSnapshotAsync(), Links).LinkRule);

        // Corrected through ordinary writes, the declaration is accepted.
        await service.DeleteRecordAsync(new(Links, "l2", 1, Context("drop-l2")));
        await service.SetFieldAsync(new(Links, "l3", "link.kind", 1, "serve", Context("fix-l3")));
        await DeclareAsync(coordinator, service);
        Assert.IsNotNull(Entity(await service.GetSnapshotAsync(), Links).LinkRule);
    }

    [TestMethod]
    public async Task EveryWriteThatLeavesALinkNotAllowedIsRefusedNamingItAndTheFileIsUnchanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await CommandAsync(coordinator, service);
        await DeclareAsync(coordinator, service);
        var history = (await service.GetHistoryAsync()).Count;

        var paths = new List<(string Path, NendoPreconditionException Refusal, string Link)>
        {
            ("create", await Refused(() => LinkAsync(service, "l2", "r1", "a1", "assign")), "l2"),
            ("set kind", await Refused(() => service.SetFieldAsync(new(Links, "l1", "link.kind", 1, "serve", Context("kind")))), "l1"),
            ("set target", await Refused(() => SetReferenceAsync(service, "l1", "link.target", "g1")), "l1"),
            ("form", await Refused(async () => await service.SetFieldsAsync(new(Links, "l1", 1,
                new Dictionary<string, object?> { ["link.note"] = "edited", ["link.kind"] = "serve" }, Context("form")))), "l1"),
            ("batch", await Refused(async () => await service.CreateRecordsAsync(new(Links,
            [
                new("l3", Values("a1", "r1", "assign"), await TargetsAsync(service, "a1", "r1")),
                new("l4", Values("a1", "r1", "nonsense"), await TargetsAsync(service, "a1", "r1")),
            ], Context("paste")))), "l4"),
            ("source's kind", await Refused(() => service.SetFieldAsync(new(Things, "a1", "thing.kind", 1, "goal", Context("retype-source")))), "l1"),
            ("target's kind", await Refused(() => service.SetFieldAsync(new(Things, "r1", "thing.kind", 1, "goal", Context("retype-target")))), "l1"),
            ("table row edited", await Refused(() => service.SetFieldAsync(new(Allowed, "allow-assign", "allowed.kind", 1, "serve", Context("row-edit")))), "l1"),
            ("table row deleted", await Refused(() => service.DeleteRecordAsync(new(Allowed, "allow-assign", 1, Context("row-delete")))), "l1"),
            ("command step", await Refused(() => service.ExecuteCommandAsync(new("breakLink", "l1", 1, Context("command")))), "l1"),
        };
        foreach (var (path, refusal, link) in paths)
        {
            Assert.AreEqual("link-not-allowed", refusal.Code, path);
            StringAssert.Contains(refusal.Message, $"Links record {link} is not an allowed link: no Allowed links record holds its Source's Kind, its Target's Kind and its Kind.", path);
        }
        Assert.HasCount(history, await service.GetHistoryAsync(), "Every refusal left the file as it was.");
        Assert.AreEqual("assign", (await RecordAsync(service, Links, "l1")).Values["link.kind"].GetString());

        // A CSV import refuses the batch at review, before anything is written.
        var csv = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("id,source,target,kind\nl5,a1,r1,assign\nl6,r1,a1,assign\n"));
        var batch = await service.PrepareCsvBatchAsync(csv, Links,
            [new(1, "link.source"), new(2, "link.target"), new(3, "link.kind")], new(true), 0, Guid.NewGuid().ToString("N"));
        Assert.AreNotEqual(NendoProposalState.Previewable, batch.Proposal.State);
        Assert.IsTrue(batch.Proposal.Diagnostics.Any(diagnostic => diagnostic.Message.Contains("is not an allowed link", StringComparison.Ordinal)),
            string.Join("; ", batch.Proposal.Diagnostics.Select(diagnostic => diagnostic.Message)));
        Assert.HasCount(history, await service.GetHistoryAsync());

        // An allowed link is written on every one of those paths.
        await LinkAsync(service, "l7", "a1", "g1", "serve");
        await service.SetFieldAsync(new(Links, "l7", "link.kind", 1, "assign-goal", Context("ok")));
    }

    [TestMethod]
    public async Task AMutationMayPassThroughALinkThatIsNotAllowedOnItsWayToOneThatIs()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await DeclareAsync(coordinator, service);

        // Kind first, then target: a1 → r1 by serve is not allowed, a1 → g1 by serve is.
        await service.SetFieldsAsync(new(Links, "l1", 1,
            new Dictionary<string, object?> { ["link.kind"] = "serve", ["link.target"] = "g1" }, Context("both"),
            new Dictionary<string, long> { ["link.target"] = 1 }));
        var record = await RecordAsync(service, Links, "l1");
        Assert.AreEqual("serve", record.Values["link.kind"].GetString());
        Assert.AreEqual("g1", record.Values["link.target"].GetString());

        // Retyping an end and its link together, as a view's batch would.
        await coordinator.ApplyAsync(new("test", "retype", "test", "Retype a thing and its link", [
            new SetFieldOperation("retype-thing", Things, "g1", "thing.kind", 1, "role"),
            new SetFieldOperation("retype-link", Links, "l1", "link.kind", record.RecordVersion, "assign"),
        ]));
        Assert.AreEqual("assign", (await RecordAsync(service, Links, "l1")).Values["link.kind"].GetString());
    }

    [TestMethod]
    public async Task AnAutomaticActionThatLeavesALinkNotAllowedRefusesTheWholeEdit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await DeclareAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Retype a link when its note changes", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition("links.retype", "Retype the link",
                [NendoActionStep.SetField("10-kind", NendoActionTarget.EventRecord, new NendoActionAssignment("link.kind", "'nonsense'", [], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition("10-retype", Links, "Retype the link",
                NendoTriggerEvents.Updated, "links.retype", ["link.note"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var history = (await service.GetHistoryAsync()).Count;

        var refused = await Refused(() => service.SetFieldAsync(new(Links, "l1", "link.note", 1, "touch", Context("note"))));
        Assert.AreEqual("link-not-allowed", refused.Code);
        StringAssert.Contains(refused.Message, "Links record l1 is not an allowed link");
        Assert.HasCount(history, await service.GetHistoryAsync());
        Assert.AreEqual(JsonValueKindNull, (await RecordAsync(service, Links, "l1")).Values["link.note"].ValueKind);
    }

    [TestMethod]
    public async Task UndoingTheRowALinkNeedsIsRefusedAndUndoingTheRuleLiftsIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        var declared = await DeclareAsync(coordinator, service);
        var row = await service.CreateRecordAsync(new(Allowed, "allow-role-actor",
            new Dictionary<string, object?> { ["allowed.from"] = "role", ["allowed.to"] = "actor", ["allowed.kind"] = "report" }, Context("row")));
        await LinkAsync(service, "l1", "r1", "a1", "report");

        var refused = await Refused(() => service.CompensateRevisionAsync(row.RevisionId, "undo-row"));
        Assert.AreEqual("link-not-allowed", refused.Code);
        StringAssert.Contains(refused.Message, "Links record l1");

        await service.CompensateRevisionAsync(declared.RevisionId, "undo-declare");
        Assert.IsNull(Entity(await service.GetSnapshotAsync(), Links).LinkRule);
        await LinkAsync(service, "l2", "r1", "a1", "nonsense");

        Assert.AreEqual("links-not-allowed", (await Refused(() => DeclareAsync(coordinator, service))).Code);
        await service.DeleteRecordAsync(new(Links, "l2", 1, Context("drop")));
        await DeclareAsync(coordinator, service);
        var removed = await RemoveAsync(coordinator, service);
        Assert.IsNull(Entity(await service.GetSnapshotAsync(), Links).LinkRule);
        await LinkAsync(service, "l3", "r1", "a1", "nonsense");
        Assert.AreEqual("links-not-allowed", (await Refused(() => service.CompensateRevisionAsync(removed.RevisionId, "undo-remove"))).Code,
            "Putting the rule back over a link it does not allow is refused like declaring it.");
    }

    [TestMethod]
    public async Task AReferenceKindIsNamedByTheRecordItHolds()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Concepts", [
            new CreateEntityOperation("types", "types", "Concept types", "types"),
            new AddFieldOperation("ty-name", "types", "type.name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("concepts", "concepts", "Concepts", "concepts"),
            new AddFieldOperation("c-name", "concepts", "concept.name", "Name", "name", NendoStorageKind.Text, false),
            new AddFieldOperation("c-type", "concepts", "concept.type", "Type", "type_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("c-source", "concepts", "concept.source", "Source", "source_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("c-target", "concepts", "concept.target", "Target", "target_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("c-type-bind", "concepts", "concept.type", "types", "type.name", 0),
            new ConfigureReferenceOperation("c-source-bind", "concepts", "concept.source", "concepts", "concept.name", 0),
            new ConfigureReferenceOperation("c-target-bind", "concepts", "concept.target", "concepts", "concept.name", 0),
            new CreateEntityOperation("rules", "rules", "Allowed relationships", "rules"),
            new AddFieldOperation("r-source", "rules", "rule.source", "Source type", "source_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("r-target", "rules", "rule.target", "Target type", "target_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("r-type", "rules", "rule.type", "Relationship type", "type_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("r-source-bind", "rules", "rule.source", "types", "type.name", 0),
            new ConfigureReferenceOperation("r-target-bind", "rules", "rule.target", "types", "type.name", 0),
            new ConfigureReferenceOperation("r-type-bind", "rules", "rule.type", "types", "type.name", 0),
        ]));
        foreach (var type in new[] { "actor", "role", "goal", "assignment" })
            await service.CreateRecordAsync(new("types", type, new Dictionary<string, object?> { ["type.name"] = type }, Context(type)));
        await service.CreateRecordAsync(new("rules", "rule-1",
            new Dictionary<string, object?> { ["rule.source"] = "actor", ["rule.target"] = "role", ["rule.type"] = "assignment" }, Context("rule-1"),
            new Dictionary<string, long> { ["rule.source"] = 1, ["rule.target"] = 1, ["rule.type"] = 1 }));
        foreach (var (id, type) in new[] { ("a1", "actor"), ("r1", "role"), ("g1", "goal") })
            await service.CreateRecordAsync(new("concepts", id, new Dictionary<string, object?> { ["concept.name"] = id, ["concept.type"] = type }, Context(id),
                new Dictionary<string, long> { ["concept.type"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "rule", "test", "Allowed relationships", [
            new DeclareLinkRuleOperation("declare", "concepts",
                new("concept.source", "concept.target", "concept.type", "concept.type", "concept.type", "rules", "rule.source", "rule.target", "rule.type"), revision),
        ]));
        // An element, a concept with neither end, is not a link and is never checked.
        await service.CreateRecordAsync(new("concepts", "e1", new Dictionary<string, object?> { ["concept.name"] = "e1", ["concept.type"] = "goal" }, Context("e1"),
            new Dictionary<string, long> { ["concept.type"] = 1 }));
        await service.CreateRecordAsync(new("concepts", "rel-1",
            new Dictionary<string, object?> { ["concept.type"] = "assignment", ["concept.source"] = "a1", ["concept.target"] = "r1" }, Context("rel-1"),
            new Dictionary<string, long> { ["concept.type"] = 1, ["concept.source"] = 1, ["concept.target"] = 1 }));

        var refused = await Refused(() => service.CreateRecordAsync(new("concepts", "rel-2",
            new Dictionary<string, object?> { ["concept.type"] = "assignment", ["concept.source"] = "g1", ["concept.target"] = "r1" }, Context("rel-2"),
            new Dictionary<string, long> { ["concept.type"] = 1, ["concept.source"] = 1, ["concept.target"] = 1 })));
        Assert.AreEqual("link-not-allowed", refused.Code);
        Assert.AreEqual("Concepts record rel-2 is not an allowed link: no Allowed relationships record holds its Source's Type (goal), " +
            "its Target's Type (role) and its Type (assignment). Change the link, or add the combination to Allowed relationships.", refused.Message);
    }

    [TestMethod]
    public async Task ANewFileThatWouldKeepALinkWithoutItsRowIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service);
        await LinkAsync(service, "l1", "a1", "r1", "assign");
        await DeclareAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "keep", "test", "Keep things and links", [
            new SetKeptInNewFilesDefaultOperation("keep-things", Things, true, revision),
            new SetKeptInNewFilesDefaultOperation("keep-links", Links, true, revision),
        ]));

        var refusedAt = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "refused.nendo");
        var refused = await Refused(() => service.CreateNewFileAsync(refusedAt, "refused"));
        Assert.AreEqual("links-not-allowed", refused.Code);
        StringAssert.Contains(refused.Message, "1 Links record is not an allowed link by Allowed links: l1.");
        Assert.IsFalse(File.Exists(refusedAt), "A refused new file was made anyway.");

        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "keep-table", "test", "Keep the table", [
            new SetKeptInNewFilesDefaultOperation("keep-allowed", Allowed, true, revision),
        ]));
        var madeAt = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "kept.nendo");
        await service.CreateNewFileAsync(madeAt, "kept");
        var inspected = await NendoWriteCoordinator.InspectAsync(madeAt);
        Assert.IsTrue(inspected.Layout!.Contains("-linkrule-", StringComparison.Ordinal), inspected.Layout);
        Assert.IsEmpty(inspected.Findings, string.Join("; ", inspected.Findings.Select(finding => finding.Code)));
    }

    [TestMethod]
    public async Task ARuleOfTheWrongShapeIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        foreach (var (rule, says) in new[]
                 {
                     (Rule with { SourceFieldId = "link.note" }, "Note is not a configured reference, so it cannot be the link's source."),
                     (Rule with { TargetFieldId = "link.source" }, "The source and the target must be different fields."),
                     (Rule with { KindFieldId = "link.target" }, "The kind must be a field other than the source and the target."),
                     (Rule with { KindFieldId = "link.notes" }, "Long notes is long text. A kind is a configured reference or single-line Text."),
                     (Rule with { SourceKindFieldId = "missing" }, "Field missing is not a field of Things, which Source points at."),
                     (Rule with { TableEntityId = Things, TableSourceFieldId = "thing.kind", TableTargetFieldId = "thing.name", TableKindFieldId = "thing.label" },
                         "Things holds links or their ends; the allowed links need a record type of their own."),
                     (Rule with { TableKindFieldId = "allowed.from" }, "The three fields of Allowed links must be different fields."),
                     (Rule with { TableKindFieldId = "allowed.count" }, "Count of Allowed links must be the same kind of field as Kind: single-line Text."),
                 })
        {
            var refused = await Refused(() => DeclareAsync(coordinator, service, rule));
            Assert.AreEqual("link-rule-invalid", refused.Code, says);
            Assert.AreEqual(says, refused.Message);
        }
        await DeclareAsync(coordinator, service);
        Assert.AreEqual("link-rule-already-declared", (await Refused(() => DeclareAsync(coordinator, service))).Code);
        await RemoveAsync(coordinator, service);
        Assert.AreEqual("link-rule-not-declared", (await Refused(() => RemoveAsync(coordinator, service))).Code);
    }

    [TestMethod]
    public async Task WhatARuleReadsCannotBeRetiredOrShownAnotherWay()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await DeclareAsync(coordinator, service);
        async Task<NendoPreconditionException> Change(NendoOperation operation) => await Refused(() =>
            coordinator.ApplyAsync(new("test", $"change-{Guid.NewGuid():N}", "test", "Change", [operation])));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        foreach (var (operation, says) in new (NendoOperation, string)[]
                 {
                     (new SetRetiredOperation("r1", Links, "link.kind", true, revision), "The link rule of Links reads this field, so it cannot be retired."),
                     (new SetRetiredOperation("r2", Things, "thing.kind", true, revision), "The link rule of Links reads this field, so it cannot be retired."),
                     (new SetRetiredOperation("r3", Allowed, null, true, revision), "The link rule of Links reads Allowed links, so it cannot be retired."),
                     (new SetFieldPresentationOperation("p1", Allowed, "allowed.from", "longText", revision), "The link rule of Links reads this field, so it cannot be shown another way."),
                 })
        {
            var refused = await Change(operation);
            Assert.AreEqual("link-rule-field-in-use", refused.Code, says);
            StringAssert.StartsWith(refused.Message, says);
        }
        // A field the rule does not read, and a rename of one it does, are ordinary changes.
        await coordinator.ApplyAsync(new("test", "rename", "test", "Rename", [
            new SetRetiredOperation("n1", Links, "link.note", true, revision),
            new RenameFieldOperation("n2", Links, "link.kind", "Relationship", revision),
        ]));
    }

    private static readonly NendoLinkRule Rule = new("link.source", "link.target", "link.kind", "thing.kind", "thing.kind", Allowed, "allowed.from", "allowed.to", "allowed.kind");
    private const System.Text.Json.JsonValueKind JsonValueKindNull = System.Text.Json.JsonValueKind.Null;

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "Things and their links", [
            new CreateEntityOperation("e-things", Things, "Things", "things"),
            new AddFieldOperation("t-name", Things, "thing.name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("t-kind", Things, "thing.kind", "Kind", "kind", NendoStorageKind.Text, false),
            new AddFieldOperation("t-label", Things, "thing.label", "Label", "label", NendoStorageKind.Text, false),
            new CreateEntityOperation("e-links", Links, "Links", "links"),
            new AddFieldOperation("l-source", Links, "link.source", "Source", "source_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("l-target", Links, "link.target", "Target", "target_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("l-kind", Links, "link.kind", "Kind", "kind", NendoStorageKind.Text, false),
            new AddFieldOperation("l-note", Links, "link.note", "Note", "note", NendoStorageKind.Text, false),
            new AddFieldOperation("l-notes", Links, "link.notes", "Long notes", "notes", NendoStorageKind.Text, false, "longText"),
            new ConfigureReferenceOperation("l-source-bind", Links, "link.source", Things, "thing.name", 0),
            new ConfigureReferenceOperation("l-target-bind", Links, "link.target", Things, "thing.name", 0),
            new CreateEntityOperation("e-allowed", Allowed, "Allowed links", "allowed"),
            new AddFieldOperation("a-from", Allowed, "allowed.from", "From", "from_kind", NendoStorageKind.Text, true),
            new AddFieldOperation("a-to", Allowed, "allowed.to", "To", "to_kind", NendoStorageKind.Text, true),
            new AddFieldOperation("a-kind", Allowed, "allowed.kind", "Kind", "kind", NendoStorageKind.Text, true),
            new AddFieldOperation("a-count", Allowed, "allowed.count", "Count", "count", NendoStorageKind.Integer, false),
        ]));

    /// <summary>Three things and the combinations they may be linked by.</summary>
    private static async Task SeedAsync(NendoApplicationService service)
    {
        foreach (var (id, kind) in new[] { ("a1", "actor"), ("r1", "role"), ("g1", "goal") })
            await service.CreateRecordAsync(new(Things, id, new Dictionary<string, object?> { ["thing.name"] = id, ["thing.kind"] = kind }, Context(id)));
        foreach (var (id, from, to, kind) in new[]
                 {
                     ("allow-assign", "actor", "role", "assign"),
                     ("allow-serve", "actor", "goal", "serve"),
                     ("allow-assign-goal", "actor", "goal", "assign-goal"),
                 })
            await service.CreateRecordAsync(new(Allowed, id, new Dictionary<string, object?> { ["allowed.from"] = from, ["allowed.to"] = to, ["allowed.kind"] = kind }, Context(id)));
    }

    private static Dictionary<string, object?> Values(string? source, string? target, string? kind) =>
        new() { ["link.source"] = source, ["link.target"] = target, ["link.kind"] = kind };

    private static async Task<Dictionary<string, long>> TargetsAsync(NendoApplicationService service, params string?[] ends)
    {
        var versions = new Dictionary<string, long>();
        string[] fields = ["link.source", "link.target"];
        for (var index = 0; index < ends.Length; index++)
            if (ends[index] is { } id) versions[fields[index]] = (await RecordAsync(service, Things, id)).RecordVersion;
        return versions;
    }

    private static async Task<NendoApplyResult> LinkAsync(NendoApplicationService service, string id, string? source, string? target, string? kind) =>
        await service.CreateRecordAsync(new(Links, id, Values(source, target, kind), Context($"link-{id}-{Guid.NewGuid():N}"),
            await TargetsAsync(service, source, target)));

    private static async Task<NendoApplyResult> SetReferenceAsync(NendoApplicationService service, string link, string field, string thing)
    {
        var record = await RecordAsync(service, Links, link);
        return await service.SetFieldAsync(new(Links, link, field, record.RecordVersion, thing, Context($"set-{Guid.NewGuid():N}"),
            (await RecordAsync(service, Things, thing)).RecordVersion));
    }

    /// <summary>A command on a link whose one step writes a kind no table record allows.</summary>
    private static async Task CommandAsync(NendoWriteCoordinator coordinator, NendoApplicationService service) =>
        await coordinator.ApplyAsync(new("test", "surface", "test", "A command", [
            new AddUiNodeOperation("command-add", "links-surface", "breakLink", null, "recordCommand", 0),
            new SetUiPropertyOperation("command-version", "links-surface", "breakLink", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("command-entity", "links-surface", "breakLink", "entityId", Links),
            new SetUiPropertyOperation("command-label", "links-surface", "breakLink", "label", "Break"),
            new AddUiNodeOperation("step-add", "links-surface", "breakStep", "breakLink", "commandStep", 0),
            new SetUiPropertyOperation("step-field", "links-surface", "breakStep", "fieldId", "link.kind"),
            new SetUiPropertyOperation("step-kind", "links-surface", "breakStep", "valueKind", "literal"),
            new SetUiPropertyOperation("step-value", "links-surface", "breakStep", "value", "nonsense"),
        ]));

    private static async Task<NendoApplyResult> DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, NendoLinkRule? rule = null)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"declare-{Guid.NewGuid():N}", "test", "Allowed links",
            [new DeclareLinkRuleOperation($"d-{Guid.NewGuid():N}", Links, rule ?? Rule, revision)]));
    }

    private static async Task<NendoApplyResult> RemoveAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"remove-{Guid.NewGuid():N}", "test", "No allowed links",
            [new RemoveLinkRuleOperation($"r-{Guid.NewGuid():N}", Links, revision)]));
    }

    private static NendoEntitySnapshot Entity(NendoSessionSnapshot snapshot, string entityId) =>
        snapshot.Entities.Single(entity => entity.EntityId == entityId);

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string entityId, string id) =>
        (await service.QueryRecordsAsync(new(entityId, 1) { RecordId = id })).Items.Single();

    private static NendoRequestContext Context(string key) => new("link-rule-tests", key, "test");

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);
}
