using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The review lines: each line names what it acts on,
/// in the person's terms, so two same-named fields or a clause with a value kind can be judged
/// at the accept gate.
/// </summary>
[TestClass]
public sealed class SemanticDiffReviewTests
{
    [TestMethod]
    public void ESM14_RetireRenameBackfillChoiceAndRemovalNameTheirSubjects()
    {
        var entries = Lines(
            new SetRetiredOperation("r1", "client", "client.notes", true, 4),
            new RenameFieldOperation("r2", "task", "task.notes", "Comments", 4),
            new SetRetiredOperation("r3", "client", null, true, 4),
            new SetChoiceMetadataOperation("r4", "task", "task.stage", "done", "Closed", false, 4),
            new BackfillRetiredFieldOperation("r5", "task", "t1", "task.old", 3, "kept"),
            new RemoveUiNodeOperation("r6", "page", "details"),
            new RenameEntityOperation("r7", "task", "Work item", 4));

        Same(new[]
        {
            "Retire Notes on Client; retain stored data.",
            "Rename Notes on Work item to Comments.",
            "Retire the record type Client; retain stored data.",
            "Rename the Stage choice Done to Closed, mark it available and give it no colour; preserve its stored ID.",
            "Fill the retired field Old on Work item record T1 with the value this proposal states.",
            "Remove the section \"Details\" from its surface, and the 2 nodes inside it.",
            "Rename the record type Task to Work item.",
        }, entries);
    }

    [TestMethod]
    public void ESM13_AFilterClauseWithAValueKindIsOneStatementInItsFieldsTerms()
    {
        var entries = Lines(
            new AddUiNodeOperation("a1", "list", "f1", "list", "filterClause", 1),
            new SetUiPropertyOperation("a2", "list", "f1", "fieldId", "task.due"),
            new SetUiPropertyOperation("a3", "list", "f1", "operator", "lt"),
            new SetUiPropertyOperation("a4", "list", "f1", "valueKind", "today"),
            new AddUiNodeOperation("a5", "list", "f2", "list", "filterClause", 2),
            new SetUiPropertyOperation("a6", "list", "f2", "fieldId", "task.due"),
            new SetUiPropertyOperation("a7", "list", "f2", "operator", "isNull"),
            new SetUiPropertyOperation("a8", "list", "f2", "valueKind", "null"),
            new SetUiPropertyOperation("a9", "list", "open", "valueKind", "now"));

        Same(new[]
        {
            "Show only records where Due is before today.",
            "Show only records where Due is empty.",
            "Compare with the date and time when the screen reads.",
        }, entries, "A clause's value kind was said as a command step, or as 'the value'.");
    }

    [TestMethod]
    public void ESM19_ActionsTilesAndMovesAreSaidInThePersonsTerms()
    {
        var action = new NendoActionDefinition("action.finish", "Finish the task",
            [NendoActionStep.SetField("s1", NendoActionTarget.EventRecord, new NendoActionAssignment("task.p9", "3"))]);
        var entries = Lines(
            new SetBehaviourDefinitionOperation("b1", action, 4),
            new SetBehaviourDefinitionOperation("b2", new NendoTriggerDefinition("trigger.a", "task", "On add", NendoTriggerEvents.Created, "action.finish"), 4),
            new SetBehaviourDefinitionOperation("b3", new NendoTriggerDefinition("trigger.b", "task", "On change", NendoTriggerEvents.Updated, "action.stamp"), 4),
            new RemoveBehaviourDefinitionOperation("b4", "action.stamp", NendoBehaviourKind.Action, 4),
            new RemoveBehaviourDefinitionOperation("b5", "action.unknown", NendoBehaviourKind.Action, 4),
            new AddUiNodeOperation("t1", "page", "tile", "details", "summaryTile", 3),
            new MoveUiNodeOperation("m1", "page", "details", "page", 0));

        Same(new[]
        {
            "Define the action Finish the task: set Priority.",
            "Run the action \"Finish the task\" automatically when a Task record is added.",
            "Run the action \"Stamp the date\" automatically when a Task record is changed.",
            "Remove the action \"Stamp the date\"; retain its definition in history.",
            "Remove the action with the ID action.unknown; retain its definition in history.",
            "Count the records over every Task record.",
            "Move the section \"Details\" into the record page \"Task\" at position 1.",
        }, entries);
    }

    [TestMethod]
    public void ESM14_ARemovalCountsOnlyWhatIsStillInsideIt()
    {
        var entries = Lines(
            new RemoveUiNodeOperation("x1", "page", "b1"),
            new RemoveUiNodeOperation("x2", "page", "b2"),
            new RemoveUiNodeOperation("x3", "page", "details"));
        Assert.AreEqual("Remove the section \"Details\" from its surface.", entries[2],
            "Nodes the same change set already removed were counted as going with their parent.");
    }

    [TestMethod]
    public void ESM13_AFilterOnACalculatedDateReadsAsADate()
    {
        var calculation = new NendoCalculationDefinition("calc.next", "task", "task.next", "Next review",
            NendoBehaviourScalar.Date, true, "Today()", []);
        var entries = Lines(
            new SetBehaviourDefinitionOperation("c1", calculation, 4),
            new AddUiNodeOperation("a1", "list", "f3", "list", "filterClause", 3),
            new SetUiPropertyOperation("a2", "list", "f3", "fieldId", "task.next"),
            new SetUiPropertyOperation("a3", "list", "f3", "operator", "lt"),
            new SetUiPropertyOperation("a4", "list", "f3", "valueKind", "today"));
        Assert.AreEqual("Show only records where Next review is before today.", entries[1]);
    }

    private static void Same(string[] expected, string[] actual, string? message = null) =>
        Assert.AreEqual(string.Join(Environment.NewLine, expected), string.Join(Environment.NewLine, actual), message);

    private static string[] Lines(params NendoOperation[] operations) =>
        SemanticDiff.From(
                new NendoChangeSet([new NendoMutation("proposal-review", "review", "test", "Review lines", operations)]),
                Active(),
                new Dictionary<string, string> { ["action.stamp"] = "Stamp the date" })
            .Select(entry => entry.Summary).ToArray();

    private static NendoSessionSnapshot Active()
    {
        var task = new NendoFieldSnapshot[]
        {
            new("task.title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("task.notes", "Notes", NendoStorageKind.Text, false, "longText", []),
            new("task.due", "Due", NendoStorageKind.Date, false, "date", []),
            new("task.stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"])
            {
                Choices = [new("open", "Open", false), new("done", "Done", false)],
            },
            new("task.old", "Old", NendoStorageKind.Text, false, "singleLine", []) { Retired = true },
            // An ID that does not read as its name, as an author's generated IDs often do not.
            new("task.p9", "Priority", NendoStorageKind.Integer, false, null, []),
        };
        var client = new NendoFieldSnapshot[]
        {
            new("client.name", "Name", NendoStorageKind.Text, true, "singleLine", []),
            new("client.notes", "Notes", NendoStorageKind.Text, false, "longText", []),
        };
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("page", "page", null, "detailSurface", ("entityId", "task"), ("title", "Task")),
            Node("page", "details", "page", "section", ("title", "Details")),
            Node("page", "b1", "details", "fieldBinding", ("fieldId", "task.title")),
            Node("page", "b2", "details", "fieldBinding", ("fieldId", "task.notes")),
            Node("list", "list", null, "recordList", ("entityId", "task"), ("title", "Tasks")),
            Node("list", "open", "list", "filterClause", ("fieldId", "task.due"), ("operator", "lt"), ("value", "2026-10-31")),
        };
        var now = new DateTimeOffset(2026, 10, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "review.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [new NendoEntitySnapshot("task", "Task", task), new NendoEntitySnapshot("client", "Client", client)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoUiNodeSnapshot Node(string surfaceId, string nodeId, string? parentNodeId, string kind,
        params (string Name, object Value)[] properties) => new(
            surfaceId, nodeId, parentNodeId, kind, 0,
            properties.ToDictionary(property => property.Name, property => JsonSerializer.SerializeToElement(property.Value), StringComparer.Ordinal));
}
