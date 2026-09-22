using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S6 of ADR-0008: nothing runs a file's automatic actions without this
/// device's consent.
/// <para>
/// The property under test is narrow and absolute. A file may carry any definitions
/// it likes and stay perfectly readable; the moment editing it would write records
/// nobody typed, the host must have said yes to exactly this behaviour, in exactly
/// this file, and must still be saying yes when the transaction commits.
/// </para>
/// </summary>
/// <remarks>
/// Not parallelized. Each case here creates a real <c>.nendo</c> file and drives it
/// through the ordinary coordinator, which is the point — but running dozens of them
/// at once saturates the disk and starves the timing-sensitive process lanes in the
/// other test assemblies. Running them one at a time costs a few seconds and keeps
/// the rest of the suite honest.
/// </remarks>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourGrantTests
{
    [TestMethod]
    public async Task PromotingAFilesFirstTriggerMakesTheHostAskForApproval()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        Assert.IsNull(coordinator.BehaviourTrust.Required, "A file with no actions asks for nothing.");

        // The first trigger arrives by proposal, which is how an agent installs one.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "One automatic action", "test",
            new([new("test", "first-trigger", "test", "One automatic action", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "note.stamp", "Stamp the label",
                    [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                        new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                            [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)],
                            []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-stamp", "notes", "Stamp the label",
                    NendoTriggerEvents.Created | NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
            ])])));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);

        // The store now refuses every edit. If the coordinator still reported nothing
        // to approve, the shell would have nothing to offer and the owner would be
        // locked out of their own file until they closed and reopened it.
        Assert.IsNotNull(coordinator.BehaviourTrust.Required,
            "Promoting a file's first trigger left the host reporting nothing to approve.");
        Assert.IsTrue(coordinator.BehaviourTrust.RequiresApproval);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CreateRecordAsync(
            new("notes", "n1", new Dictionary<string, object?> { ["label"] = "First" }, new("test", "n1", "test"))));

        // And approving exactly what it now asks for makes editing available again.
        TestBehaviourAuthority.Approving(coordinator);
        await service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" }, new("test", "n1", "test")));
        Assert.AreEqual("Seen First",
            (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").Values["stamp"].GetString());
    }

    [TestMethod]
    public async Task WithoutConsentTheFileStaysReadableAndCalculatesButCannotBeEdited()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var before = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);

        // No authority was supplied at all, which is the state a host that forgot to
        // wire up consent is in. It must refuse, not assume.
        Assert.IsTrue(coordinator.BehaviourTrust.RequiresApproval);
        Assert.IsFalse(coordinator.BehaviourTrust.IsApproved);
        Assert.IsFalse(coordinator.Capabilities.Mutate, "An unapproved file offered editing.");
        Assert.IsTrue(coordinator.Capabilities.ReadData, "An unapproved file hid the owner's data.");
        Assert.IsTrue(coordinator.Capabilities.Export);

        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Edit()));
        Assert.AreEqual("behaviour-not-approved", refusal.Code);

        // Reading, and calculating while reading, are unaffected.
        Assert.AreEqual(before, JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records));
        var project = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");
        Assert.AreEqual(NendoCalculationState.Value, project.Calculations.Single().State);
        Assert.AreEqual(1L, project.Calculations.Single().Value.GetInt64());
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
    }

    [TestMethod]
    public async Task ApprovingOnceAllowsEditingAndRevokingStopsItAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        var authority = TestBehaviourAuthority.Approving(coordinator);
        Assert.IsTrue(coordinator.Capabilities.Mutate);
        await coordinator.ApplyAsync(Edit());
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());

        authority.RevokeAll();
        Assert.IsFalse(coordinator.Capabilities.Mutate, "Revoking consent left editing available.");
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(SecondEdit()));
        Assert.AreEqual("behaviour-not-approved", refusal.Code);
    }

    [TestMethod]
    public async Task ConsentWithdrawnWhileSavingAbortsTheWholeTransaction()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var authority = TestBehaviourAuthority.Approving(coordinator);
        var snapshot = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);
        var history = await service.GetHistoryAsync();

        // Withdraw consent after the actions have run but before the commit. Checking
        // only at the start would let this write land anyway.
        coordinator.GeneratedOperationCheckpoint = _ => authority.RevokeAll();
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Edit()));
        coordinator.GeneratedOperationCheckpoint = null;

        Assert.AreEqual("behaviour-not-approved", refusal.Code);
        Assert.AreEqual(snapshot, JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records),
            "A save that lost consent mid-flight still changed the file.");
        Assert.HasCount(history.Count, await service.GetHistoryAsync());
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
    }

    [TestMethod]
    public async Task ConsentIsBoundToEveryFieldItNames()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        var required = coordinator.BehaviourTrust.Required!;
        Assert.AreEqual(NendoBehaviourCapabilities.UpdateRecords, required.Capabilities,
            "The fixture's actions only set fields, so that is all consent should cover.");

        // Each field individually is enough to make a grant not apply. A copied file,
        // an edited definition and a host reading the contract differently are all
        // one of these.
        foreach (var mismatch in new[]
        {
            required with { ApplicationId = "application-other" },
            required with { InstanceId = "instance-other" },
            required with { BehaviourDigest = new string('0', 64) },
            required with { ContractVersion = "behaviour-99" },
            required with { DefinitionRevision = required.DefinitionRevision + 1 },
            required with { Capabilities = NendoBehaviourCapabilities.DeleteRecords },
        })
        {
            var authority = new TestBehaviourAuthority();
            authority.Approve(mismatch);
            coordinator.BehaviourAuthority = authority;
            Assert.IsFalse(coordinator.Capabilities.Mutate, $"A grant differing only in one field was accepted: {mismatch}");
            var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
                () => coordinator.ApplyAsync(Edit()));
            Assert.AreEqual("behaviour-not-approved", refusal.Code);
        }
    }

    [TestMethod]
    public async Task ChangingWhatAnActionDoesWithdrawsTheConsentGivenForTheOldOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);
        Assert.IsTrue(coordinator.Capabilities.Mutate);

        // Rewriting the action's formula is exactly the case consent exists for: the
        // file is the same file, and what it will do to the data is not the same.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "rewrite", "test", "Change what the action writes", [
            new SetBehaviourDefinitionOperation("a1", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount + 100",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]),
                revision),
        ]));

        Assert.IsFalse(coordinator.Capabilities.Mutate, "Consent survived a change to what the action writes.");
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Edit()));
        Assert.AreEqual("behaviour-not-approved", refusal.Code);
    }

    [TestMethod]
    public async Task AFileWithCalculationsButNoTriggersNeedsNoConsent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Schema(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "calc", "test", "A calculation only", [
            new SetBehaviourDefinitionOperation("c", Completed(), revision),
        ]));

        // Calculating reads data and writes none, so there is nothing to consent to.
        Assert.IsFalse(coordinator.BehaviourTrust.RequiresApproval);
        Assert.IsTrue(coordinator.Capabilities.Mutate);
        await coordinator.ApplyAsync(Edit());
        Assert.AreEqual("Finished", (await service.GetSnapshotAsync())
            .Records.Single(record => record.RecordId == "t2").Values["title"].GetString());
    }

    [TestMethod]
    public async Task ReopeningAFileAsksAgainRatherThanRememberingTheLastSession()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var granted = TestBehaviourAuthority.Approving(coordinator);
        await coordinator.ApplyAsync(Edit());
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // A fresh session starts with no authority at all. Consent lives with the
        // host, and a coordinator cannot inherit it from the file.
        var reopened = await workspace.OpenAsync();
        Assert.IsTrue(reopened.BehaviourTrust.RequiresApproval);
        Assert.IsFalse(reopened.BehaviourTrust.IsApproved);
        Assert.IsFalse(reopened.Capabilities.Mutate);

        // The same grant the first session used still applies, because nothing about
        // the file changed — which is what makes a durable store worth keeping.
        var authority = new TestBehaviourAuthority();
        authority.Approve(reopened.BehaviourTrust.Required!);
        reopened.BehaviourAuthority = authority;
        Assert.IsTrue(reopened.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task InstallingDefinitionsNeedsNoConsentAndRunsNoAction()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        // Fixture installs schema, records and definitions with no authority set at
        // any point. Installing a definition is a reviewed change to the file, not an
        // occasion to run it.
        await Fixture(coordinator, service);
        var project = await Project(service);
        Assert.AreEqual(1L, project.Values["total"].GetInt64(),
            "Installing a trigger ran it against existing records.");
        Assert.AreEqual(1L, project.RecordVersion, "Installing a trigger wrote to a record.");

        // Approving does not run anything either.
        TestBehaviourAuthority.Approving(coordinator);
        Assert.AreEqual(1L, (await Project(service)).RecordVersion, "Approving ran the actions.");
    }

    [TestMethod]
    public async Task DefinitionsInstalledWithoutConsentStayInstalledAndInspectable()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        // Installing definitions and recording consent are two separate storage
        // operations, and consent is not even in the same file. If everything stops
        // between them, the definition is committed and the approval is not — which
        // must leave the file readable and unapproved, never half-installed.
        await Fixture(coordinator, service);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var reopened = await workspace.OpenAsync();
        var reopenedService = new NendoApplicationService(reopened);

        // The definition survived; only editing is withheld.
        var projects = (await reopenedService.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "projects");
        Assert.HasCount(1, projects.DerivedFields, "The installed calculation was rolled back.");
        Assert.AreEqual("completed", projects.DerivedFields.Single().FieldId);
        Assert.IsTrue(reopened.BehaviourTrust.RequiresApproval);
        Assert.IsFalse(reopened.BehaviourTrust.IsApproved);
        Assert.IsTrue(reopened.Capabilities.ReadData);
        Assert.IsFalse(reopened.Capabilities.Mutate);

        // And approving now — with nothing else changed — is all that is needed.
        TestBehaviourAuthority.Approving(reopened);
        Assert.IsTrue(reopened.Capabilities.Mutate);
    }

    [TestMethod]
    [DataRow(NendoIdentityCopyKind.Duplicate)]
    [DataRow(NendoIdentityCopyKind.Fork)]
    public async Task ACopiedFileAsksForItsOwnApproval(NendoIdentityCopyKind kind)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var authority = TestBehaviourAuthority.Approving(coordinator);
        Assert.IsTrue(coordinator.Capabilities.Mutate);

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "copy.nendo");
        var plan = await service.PrepareIdentityCopyAsync(kind, destination, "copy");
        await service.CreateIdentityCopyAsync(plan.PlanId);

        // The copy holds the same definitions and does the same things, but it is a
        // different file. Approving the original was not a decision about this one.
        await using var copy = await NendoWriteCoordinator.OpenAsync(destination, "copy-test");
        copy.BehaviourAuthority = authority;
        Assert.IsTrue(copy.BehaviourTrust.RequiresApproval);
        Assert.IsFalse(copy.BehaviourTrust.IsApproved, $"A {kind} inherited the original's approval.");
        Assert.IsFalse(copy.Capabilities.Mutate);
        Assert.AreNotEqual(
            coordinator.BehaviourTrust.Required!.InstanceId,
            copy.BehaviourTrust.Required!.InstanceId);
    }

    [TestMethod]
    public async Task ABackupOfAnApprovedFileCarriesNoApproval()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var required = TestBehaviourAuthority.Approving(coordinator).ApproveCurrent(coordinator);

        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        var plan = await service.PrepareBackupAsync(backup, "backup");
        await service.CreateBackupAsync(plan.PlanId);

        // Consent is device state and lives nowhere in the file, so a backup — or a
        // file sent to somebody else — carries data and definitions but never the
        // decision to trust them.
        var bytes = await File.ReadAllBytesAsync(backup);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        Assert.DoesNotContain(required.BehaviourDigest, text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("behaviour-grants", text, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<NendoRecordSnapshot> Project(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");

    private static NendoCalculationDefinition Completed() => new(
        "project.completed", "projects", "completed", "Completed",
        NendoBehaviourScalar.Integer, false, "done",
        [NendoBehaviourBinding.RelatedFilteredCount("done", "projects", "tasks", "project", "done")]);

    private static NendoMutation Edit() => new("test", "edit", "test", "Finish the second task", [
        new SetFieldOperation("edit-done", "tasks", "t2", "done", 1, true),
        new SetFieldOperation("edit-title", "tasks", "t2", "title", 2, "Finished"),
    ]);

    private static NendoMutation SecondEdit() => new("test", "edit-2", "test", "Rename the second task", [
        new SetFieldOperation("edit2-title", "tasks", "t2", "title", 3, "Renamed"),
    ]);

    private static async Task Schema(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 1L },
            new NendoRequestContext("test", "p1", "test")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "First" },
            new NendoRequestContext("test", "t1", "test"), new Dictionary<string, long> { ["project"] = 1 }));
        await service.CreateRecordAsync(new("tasks", "t2",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false, ["title"] = "Second" },
            new NendoRequestContext("test", "t2", "test"), new Dictionary<string, long> { ["project"] = 1 }));
    }

    /// <summary>Schema, records, one calculation and one trigger — and no consent.</summary>
    private static async Task Fixture(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await Schema(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Totals", [
            new SetBehaviourDefinitionOperation("c", Completed(), revision),
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]),
                revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-total", "tasks", "Keep the project total current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
                "project.setTotal", ["done", "project"]), revision),
        ]));
    }
}
