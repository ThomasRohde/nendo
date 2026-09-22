using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A disposable <c>.nendo</c> file for the real-host behaviour journey. Never shipped.
/// <para>
/// It is seeded here rather than through the shell because a definition arrives by
/// canonical operation, and the point of the journey is what the shell does with a
/// file that already carries one: show its calculated fields, ask this device whether
/// its actions may run, and keep Studio reachable when a calculation fails.
/// </para>
/// </summary>
public static class RuntimeBehaviourFixture
{
    /// <summary>The record that is deliberately impossible to calculate: no tasks, so completion divides by zero.</summary>
    public const string FailingProjectId = "p-empty";

    public static async Task CreateAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "owned-behaviour-fixture");
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("owned-runtime", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-stage", "projects", "stage", "Stage", "stage", NendoStorageKind.Text, true, "singleChoice", ["open", "done"]),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));

        // Records are seeded before the trigger exists. Afterwards this file needs
        // the device's consent for any edit at all, and the fixture must not be the
        // thing that grants it: that is the journey's first act, on screen.
        await service.CreateRecordAsync(new("projects", "p-live",
            new Dictionary<string, object?> { ["name"] = "Live project", ["stage"] = "open" },
            new("owned-runtime", "p-live", "test")));
        await service.CreateRecordAsync(new("projects", FailingProjectId,
            new Dictionary<string, object?> { ["name"] = "Empty project", ["stage"] = "open" },
            new("owned-runtime", FailingProjectId, "test")));
        foreach (var (id, title, done) in new[] { ("t1", "First", true), ("t2", "Second", false) })
        {
            await service.CreateRecordAsync(new("tasks", id,
                new Dictionary<string, object?> { ["project"] = "p-live", ["title"] = title, ["done"] = done },
                new("owned-runtime", id, "test"), new Dictionary<string, long> { ["project"] = 1 }));
        }

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("owned-runtime", "behaviour", "test", "Calculations and one action", [
            new SetBehaviourDefinitionOperation("c-count", new NendoCalculationDefinition(
                "project.taskCount", "projects", "taskCount", "Tasks",
                NendoBehaviourScalar.Integer, false, "count",
                [NendoBehaviourBinding.RelatedCount("count", "projects", "tasks", "project")]), revision),
            new SetBehaviourDefinitionOperation("c-done", new NendoCalculationDefinition(
                "project.doneCount", "projects", "doneCount", "Done",
                NendoBehaviourScalar.Integer, false, "done",
                [NendoBehaviourBinding.RelatedFilteredCount("done", "projects", "tasks", "project", "done")]), revision),
            // Divides by the task count, so a project with no tasks cannot be
            // calculated. That is the forced error the journey reads on screen.
            new SetBehaviourDefinitionOperation("c-completion", new NendoCalculationDefinition(
                "project.completion", "projects", "completion", "Completion",
                NendoBehaviourScalar.Decimal, false, "RoundEven(done / total * 100, 2)",
                [NendoBehaviourBinding.SameRecordCalculation("total", "projects", "project.taskCount", NendoBehaviourScalar.Integer, false),
                 NendoBehaviourBinding.SameRecordCalculation("done", "projects", "project.doneCount", NendoBehaviourScalar.Integer, false)]), revision),
            // One automatic action, so opening this file asks the device for consent
            // before any ordinary edit is allowed. Finishing every task closes the
            // project, which is a change a person can see happen without being told.
            new SetBehaviourDefinitionOperation("a-close", new NendoActionDefinition(
                "project.close", "Close a project when every task is done",
                [NendoActionStep.SetField("10-stage", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("stage", "doneCount == taskCount ? 'done' : 'open'",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done"),
                         NendoBehaviourBinding.RelatedCount("taskCount", "projects", "tasks", "project")], []))]), revision),
            new SetBehaviourDefinitionOperation("t-close", new NendoTriggerDefinition(
                "10-stage", "tasks", "Keep the project stage current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
                "project.close", ["done", "project"]), revision),
        ]));

        await coordinator.ApplyAsync(new("owned-runtime", "surface", "test", "A form that shows a calculation", [
            new AddUiNodeOperation("root-add", "project-surface", "project-root", null, "recordForm", 0),
            new SetUiPropertyOperation("root-version", "project-surface", "project-root", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("root-entity", "project-surface", "project-root", "entityId", "projects"),
            new AddUiNodeOperation("name-add", "project-surface", "project-name", "project-root", "fieldBinding", 0),
            new SetUiPropertyOperation("name-field", "project-surface", "project-name", "fieldId", "name"),
            new AddUiNodeOperation("count-add", "project-surface", "project-count", "project-root", "fieldBinding", 1),
            new SetUiPropertyOperation("count-field", "project-surface", "project-count", "fieldId", "taskCount"),
            new AddUiNodeOperation("completion-add", "project-surface", "project-completion", "project-root", "fieldBinding", 2),
            new SetUiPropertyOperation("completion-field", "project-surface", "project-completion", "fieldId", "completion"),
        ]));

    }

    /// <summary>What the fixture holds, for a harness that wants to check itself before driving a window.</summary>
    public static async Task<string> InspectAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenReadOnlyAsync(path);
        var snapshot = await new NendoApplicationService(coordinator).GetSnapshotAsync();
        var live = snapshot.Records.Single(record => record.RecordId == "p-live");
        var empty = snapshot.Records.Single(record => record.RecordId == FailingProjectId);
        var projects = snapshot.Entities.Single(entity => entity.EntityId == "projects");
        var completion = empty.Calculations.SingleOrDefault(result => result.FieldId == "completion");
        return JsonSerializer.Serialize(new
        {
            derivedFields = projects.DerivedFields.Select(field => field.FieldId).ToArray(),
            live = live.Calculations.ToDictionary(
                result => result.FieldId,
                result => result.State == NendoCalculationState.Value ? result.Value.ToString() : result.State.ToString()),
            failing = completion is null ? "no-result" : completion.ErrorCode,
        });
    }
}
