using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class IdentityCopyTests
{
    [TestMethod]
    [DataRow(NendoIdentityCopyKind.Duplicate, "empty")]
    [DataRow(NendoIdentityCopyKind.Fork, "empty")]
    [DataRow(NendoIdentityCopyKind.Duplicate, "idea-garden")]
    [DataRow(NendoIdentityCopyKind.Fork, "idea-garden")]
    [DataRow(NendoIdentityCopyKind.Duplicate, "decision-log")]
    [DataRow(NendoIdentityCopyKind.Fork, "decision-log")]
    public async Task CopyChangesOnlyDestinationIdentityAndAddsOneIrreversibleRevision(NendoIdentityCopyKind kind, string application)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await PopulateAsync(service, application);
        var original = await source.GetSnapshotAsync();
        var history = await source.GetHistoryAsync();
        var originalBytes = await BytesAsync(workspace.FilePath);
        var plan = await service.PrepareIdentityCopyAsync(kind, Destination(workspace), "copy");
        Assert.AreEqual(original.Manifest, plan.Source);
        Assert.IsFalse(JsonSerializer.Serialize(plan).Contains(JsonEncodedText.Encode(Path.GetDirectoryName(workspace.FilePath)!).ToString(), StringComparison.Ordinal));
        var result = await service.CreateIdentityCopyAsync(plan.PlanId);
        Assert.IsFalse(result.IsIdempotentReplay);
        CollectionAssert.AreEqual(originalBytes, await BytesAsync(workspace.FilePath));
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        await using var copy = await NendoWriteCoordinator.OpenAsync(Destination(workspace), "copy-test");
        var copied = await copy.GetSnapshotAsync();
        Assert.AreEqual(kind == NendoIdentityCopyKind.Duplicate, copied.Manifest.ApplicationId == original.Manifest.ApplicationId);
        Assert.AreNotEqual(original.Manifest.InstanceId, copied.Manifest.InstanceId);
        Assert.AreEqual(plan.ResultApplicationId, copied.Manifest.ApplicationId);
        Assert.AreEqual(plan.ResultInstanceId, copied.Manifest.InstanceId);
        Assert.AreEqual(result.Manifest, copied.Manifest);
        // A copy carries the requirement its content needs: an empty application
        // only the lifecycle host, the Idea Garden the composable host, and the
        // Decision Log — which carries a timeline since S3, a gallery since S2 and
        // a front page since S4 — the rung of the newest shape it holds.
        Assert.AreEqual(
            application switch
            {
                "empty" => NendoFormat.LifecycleMinimumHostVersion,
                "decision-log" => NendoFormat.OverviewMinimumHostVersion,
                _ => NendoFormat.ComposableSurfacesMinimumHostVersion,
            },
            copied.Manifest.MinimumHostVersion);
        Assert.AreEqual(original.Manifest.CreatedAt, copied.Manifest.CreatedAt);
        Assert.AreEqual(original.Manifest.DefinitionRevision + 1, copied.Manifest.DefinitionRevision);
        Assert.AreEqual(original.Manifest.DataRevision, copied.Manifest.DataRevision);
        Assert.AreEqual(original.Manifest.ChangeSequence + 1, copied.Manifest.ChangeSequence);
        Assert.AreEqual(ApplicationState(original), ApplicationState(copied));
        var copiedHistory = await copy.GetHistoryAsync();
        Assert.AreEqual(JsonSerializer.Serialize(history), JsonSerializer.Serialize(copiedHistory.Take(history.Count).ToArray()));
        Assert.HasCount(history.Count + 1, copiedHistory);
        var transition = copiedHistory.Last();
        Assert.AreEqual(result.TransitionRevisionId, transition.RevisionId);
        Assert.HasCount(1, transition.Operations);
        Assert.AreEqual("identity.transition", transition.Operations[0].OperationType);
        Assert.AreEqual(NendoReversibilityClass.IrreversibleDeclared, transition.Operations[0].Reversibility);
        var typed = IdentityTransitionOperation.ParseCanonical(transition.Operations[0].CanonicalJson);
        Assert.AreEqual(kind, typed.Kind);
        Assert.AreEqual(NendoIdentitySourcePoint.From(original.Manifest), typed.Source);
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            new NendoApplicationService(copy).CompensateRevisionAsync(transition.RevisionId, "denied"));
        if (application != "empty") Assert.IsTrue((await new NendoApplicationService(copy).CompileSemanticUiAsync()).IsValid);
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(NendoIdentityCopyKind.Duplicate)]
    [DataRow(NendoIdentityCopyKind.Fork)]
    public async Task ExactAndConcurrentRetriesAndRestartVerifyCommittedCanonicalCopy(NendoIdentityCopyKind kind)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await PopulateAsync(new(source), "decision-log");
        var plan = await source.PrepareIdentityCopyAsync(kind, Destination(workspace), "copy");
        var results = await Task.WhenAll(source.CreateIdentityCopyAsync(plan.PlanId), source.CreateIdentityCopyAsync(plan.PlanId));
        Assert.HasCount(1, results.Where(result => result.IsIdempotentReplay));
        Assert.AreEqual(results[0].TransitionRevisionId, results[1].TransitionRevisionId);
        var copiedBytes = await BytesAsync(Destination(workspace));
        await source.DisposeAsync();
        workspace.Forget(source);
        var reopened = await workspace.OpenAsync();
        var again = await reopened.PrepareIdentityCopyAsync(kind, Destination(workspace), "copy");
        Assert.AreEqual(plan.ResultInstanceId, again.ResultInstanceId);
        var replay = await reopened.CreateIdentityCopyAsync(again.PlanId);
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(results[0].TransitionRevisionId, replay.TransitionRevisionId);
        CollectionAssert.AreEqual(copiedBytes, await BytesAsync(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task GenericMutationsTypedProposalsAndCanonicalAuthoringCannotTransitionIdentity()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await BytesAsync(workspace.FilePath);
        var operation = new IdentityTransitionOperation("attempt", NendoIdentityCopyKind.Fork,
            NendoIdentitySourcePoint.From((await source.GetSnapshotAsync()).Manifest), "application-forbidden", "instance-forbidden", new('A', 64));
        var mutation = new NendoMutation("test", "identity", "test", "forbidden", [operation]);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => source.ApplyAsync(mutation));
        var service = new NendoApplicationService(source);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.PrepareProposalAsync(
            new NendoProposalRequest("proposal-forbidden", "Forbidden", "test", new([mutation]))));
        using var canonical = JsonDocument.Parse(operation.CanonicalJson());
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.PrepareProposalAsync(
            new NendoCanonicalProposalRequest("canonical-forbidden", "Forbidden", "test",
                new([new("test", "identity", "test", "forbidden", [new("attempt", "identity.transition", canonical.RootElement.GetProperty("payload"))])]))));
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ExistingAndRacingUnrelatedDestinationsArePreserved(bool race)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await BytesAsync(workspace.FilePath);
        if (race)
        {
            var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
            source.BeforeIdentityCopyActivation = () => File.WriteAllText(Destination(workspace), "unrelated");
            await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateIdentityCopyAsync(plan.PlanId));
            Assert.AreEqual("unrelated", await File.ReadAllTextAsync(Destination(workspace)));
        }
        else
        {
            await File.WriteAllBytesAsync(Destination(workspace), []);
            await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy"));
            Assert.AreEqual(0L, new FileInfo(Destination(workspace)).Length);
        }
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow("before-commit")]
    [DataRow("before-activation")]
    [DataRow("after-activation")]
    [DataRow("lost-response")]
    [DataRow("invalid-stage")]
    [DataRow("sqlite-full")]
    public async Task FailureAndCancellationBoundariesPreserveSourceAndPermitOnlyCorrectRetry(string failure)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await BytesAsync(workspace.FilePath);
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Destination(workspace), "copy");
        using var cancellation = new CancellationTokenSource();
        switch (failure)
        {
            case "before-commit": source.BeforeIdentityTransitionCommit = cancellation.Cancel; break;
            case "before-activation": source.BeforeIdentityCopyActivation = cancellation.Cancel; break;
            case "after-activation": source.AfterIdentityCopyActivation = cancellation.Cancel; break;
            case "lost-response": source.AfterIdentityCopyActivation = () => throw new InvalidOperationException("lost response"); break;
            case "invalid-stage": source.BeforeIdentityCopyValidation = stage => Change(stage, "UPDATE __nendo_manifest SET created_at = '2020-01-01T00:00:00.0000000+00:00';"); break;
            case "sqlite-full": source.IdentityCopyMaximumPageCountForTest = 1; break;
        }
        if (failure is "before-commit" or "before-activation")
            await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => source.CreateIdentityCopyAsync(plan.PlanId, cancellation.Token));
        else if (failure == "lost-response")
            await Assert.ThrowsExactlyAsync<InvalidOperationException>(() => source.CreateIdentityCopyAsync(plan.PlanId));
        else if (failure == "invalid-stage")
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateIdentityCopyAsync(plan.PlanId));
        else if (failure == "sqlite-full")
            Assert.AreEqual(13, (await Assert.ThrowsExactlyAsync<SqliteException>(() => source.CreateIdentityCopyAsync(plan.PlanId))).SqliteErrorCode);
        else Assert.IsFalse((await source.CreateIdentityCopyAsync(plan.PlanId, cancellation.Token)).IsIdempotentReplay);
        Assert.AreEqual(failure is "after-activation" or "lost-response", File.Exists(Destination(workspace)));
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
        source.BeforeIdentityTransitionCommit = null;
        source.BeforeIdentityCopyActivation = null;
        source.AfterIdentityCopyActivation = null;
        source.BeforeIdentityCopyValidation = null;
        source.IdentityCopyMaximumPageCountForTest = null;
        var retry = await source.CreateIdentityCopyAsync(plan.PlanId);
        Assert.AreEqual(failure is "after-activation" or "lost-response", retry.IsIdempotentReplay);
        Assert.AreEqual(plan.ResultInstanceId, retry.Manifest.InstanceId);
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ChangedRequestsAndChangedSourceCannotBeMistakenForExactRetry()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Destination(workspace), "copy"));
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace, "other.nendo"), "copy"));
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("changed");
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateIdentityCopyAsync(plan.PlanId));
        Assert.AreEqual("identity-source-changed", error.Code);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task RestartReplayChecksAllRetainedStateNotJustPlausibleProvenance()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Retain", "record");
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await source.CreateIdentityCopyAsync(plan.PlanId);
        await source.DisposeAsync();
        workspace.Forget(source);
        Change(Destination(workspace), "UPDATE __nendo_idempotency SET payload_digest = 'forged' WHERE idempotency_key = 'record';");
        var forged = await BytesAsync(Destination(workspace));
        var reopened = await workspace.OpenAsync();
        var retry = await reopened.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => reopened.CreateIdentityCopyAsync(retry.PlanId));
        CollectionAssert.AreEqual(forged, await BytesAsync(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ReadOnlyRawCopyCanBeExplicitlyForkedWithoutWritingOrAcquiringItsSourceLease()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        await writer.DisposeAsync();
        workspace.Forget(writer);
        File.Copy(workspace.FilePath, Destination(workspace, "raw-copy.nendo"));
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(Destination(workspace, "raw-copy.nendo"));
        var before = await BytesAsync(Destination(workspace, "raw-copy.nendo"));
        var plan = await reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await reader.CreateIdentityCopyAsync(plan.PlanId);
        Assert.IsFalse(File.Exists(Destination(workspace, "raw-copy.nendo") + ".write-owner"));
        CollectionAssert.AreEqual(before, await BytesAsync(Destination(workspace, "raw-copy.nendo")));
        Assert.IsTrue((await NendoWriteCoordinator.InspectAsync(Destination(workspace))).CanAcquireWriteAuthority);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task LaterSemanticMutationAndPromotionNeverDowngradeLifecycleHostRequirement()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Destination(workspace), "copy");
        await source.CreateIdentityCopyAsync(plan.PlanId);
        await using var copy = await NendoWriteCoordinator.OpenAsync(Destination(workspace), "copy");
        var service = new NendoApplicationService(copy);
        await service.CreateIdeaSchemaAsync("schema");
        await copy.ApplyAsync(new("test", "semantic", "test", "Add presented field",
            [new AddFieldOperation("field-add", NendoApplicationService.IdeaEntityId, "field.extra", "Extra", "extra", NendoStorageKind.Text, false, "longText")]));
        Assert.AreEqual(NendoFormat.LifecycleMinimumHostVersion, (await copy.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion, (await copy.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        Assert.AreEqual(NendoOpenClassification.NormalReadOnly, (await NendoWriteCoordinator.InspectAsync(Destination(workspace))).Classification);
    }

    [TestMethod]
    public async Task SeparateCoordinatorsRacingForOneDestinationCannotOverwriteOrAddTwoTransitions()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var first = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "same-request");
        var second = await reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "same-request");
        NendoIdentityCopyResult? winner = null;
        source.BeforeIdentityCopyActivation = () => winner = reader.CreateIdentityCopyAsync(second.PlanId).GetAwaiter().GetResult();
        await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateIdentityCopyAsync(first.PlanId));
        Assert.IsNotNull(winner);
        await using var copy = await NendoWriteCoordinator.OpenReadOnlyAsync(Destination(workspace));
        Assert.AreEqual(winner.Manifest, (await copy.GetSnapshotAsync()).Manifest);
        Assert.HasCount(1, (await copy.GetHistoryAsync()).SelectMany(revision => revision.Operations).Where(operation => operation.OperationType == "identity.transition"));
        Assert.AreEqual(0L, (await source.GetSnapshotAsync()).Manifest.ChangeSequence);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task SourceHardLinkIsNotAValidCopyDestination()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        workspace.Forget(source);
        Assert.IsTrue(CreateHardLink(Destination(workspace), workspace.FilePath, IntPtr.Zero), $"Win32 error {Marshal.GetLastWin32Error()}");
        var before = await BytesAsync(workspace.FilePath);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy"));
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        CollectionAssert.AreEqual(before, await BytesAsync(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ForkThenDuplicateRetainsAValidTypedIdentityLineage()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var first = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "first");
        await source.CreateIdentityCopyAsync(first.PlanId);
        await using var fork = await NendoWriteCoordinator.OpenAsync(Destination(workspace), "fork");
        var second = await fork.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Destination(workspace, "second.nendo"), "second");
        await fork.CreateIdentityCopyAsync(second.PlanId);
        await using var duplicate = await NendoWriteCoordinator.OpenAsync(Destination(workspace, "second.nendo"), "duplicate");
        var history = await duplicate.GetHistoryAsync();
        var transitions = history.Skip(1).Select(revision => IdentityTransitionOperation.ParseCanonical(revision.Operations.Single().CanonicalJson)).ToArray();
        Assert.HasCount(2, transitions);
        Assert.AreEqual(transitions[0].ResultInstanceId, transitions[1].Source.InstanceId);
        Assert.AreEqual(transitions[0].ResultApplicationId, transitions[1].Source.ApplicationId);
        Assert.AreEqual(2L, (await duplicate.GetSnapshotAsync()).Manifest.DefinitionRevision);
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow("UPDATE __nendo_manifest SET minimum_host_version = '1.1.0';")]
    [DataRow("UPDATE __nendo_manifest SET instance_id = 'unrecorded-identity';")]
    [DataRow("UPDATE __nendo_operation SET canonical_json = json_set(canonical_json, '$.payload.requestDigest', NULL) WHERE operation_type = 'identity.transition';")]
    public async Task BrokenIdentityEvidenceNeverBecomesWritableOrCrashesInspection(string tampering)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await source.CreateIdentityCopyAsync(plan.PlanId);
        Change(Destination(workspace), tampering);
        var before = await BytesAsync(Destination(workspace));
        var inspection = await NendoWriteCoordinator.InspectAsync(Destination(workspace));
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, inspection.Classification);
        Assert.IsFalse(inspection.CanAcquireWriteAuthority);
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => NendoWriteCoordinator.OpenAsync(Destination(workspace), "denied"));
        CollectionAssert.AreEqual(before, await BytesAsync(Destination(workspace)));
    }

    [TestMethod]
    public async Task RecoveryBackupCapabilityDoesNotAuthoriseAnIdentityChange()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await PopulateAsync(new(source), "idea-garden");
        await source.DisposeAsync();
        workspace.Forget(source);
        Change(workspace.FilePath, "UPDATE __nendo_ui_property SET value_json = '{invalid' WHERE property_name = 'entityId';");
        var before = await BytesAsync(workspace.FilePath);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.IsTrue(reader.Capabilities.Backup);
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy"));
        Assert.AreEqual("identity-copy-unavailable", error.Code);
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow("missing")]
    [DataRow("identical-replacement")]
    [DataRow("modified")]
    public async Task CommittedResultLossOrChangeNeverAuthorisesRecreation(string change)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy");
        await source.CreateIdentityCopyAsync(plan.PlanId);
        if (change is "missing" or "identical-replacement")
        {
            File.Move(Destination(workspace), Destination(workspace, "retained.nendo"));
            if (change == "identical-replacement") File.Copy(Destination(workspace, "retained.nendo"), Destination(workspace));
        }
        else Change(Destination(workspace), "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';");
        var before = File.Exists(Destination(workspace)) ? await BytesAsync(Destination(workspace)) : null;
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.CreateIdentityCopyAsync(plan.PlanId));
        if (before is null) Assert.IsFalse(File.Exists(Destination(workspace)));
        else CollectionAssert.AreEqual(before, await BytesAsync(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ReadOnlySnapshotChangeAndOutsideAuthorityLossPreventIdentityCopies()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var observed = await reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "observed");
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("schema");
        Assert.AreEqual("identity-source-changed", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.CreateIdentityCopyAsync(observed.PlanId))).Code);
        var active = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Destination(workspace), "active");
        Change(workspace.FilePath, "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';");
        var before = await BytesAsync(workspace.FilePath);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => source.CreateIdentityCopyAsync(active.PlanId));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, source.Health);
        Assert.IsFalse(source.Capabilities.AgentAccess);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        CollectionAssert.AreEqual(before, await BytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ObservingBrokenCustomStateDuringCopyPreparationRevokesWritableCapabilities()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await PopulateAsync(new(source), "idea-garden");
        Change(workspace.FilePath, "UPDATE __nendo_ui_property SET value_json = '{invalid' WHERE property_name = 'entityId';");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, Destination(workspace), "copy"));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, source.Health);
        Assert.IsFalse(source.Capabilities.Mutate);
        Assert.IsFalse(source.Capabilities.AgentAccess);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);

    private static async Task PopulateAsync(NendoApplicationService service, string application)
    {
        if (application == "empty") return;
        if (application == "idea-garden")
        {
            var preview = await service.PrepareIdeaGardenProposalAsync();
            await service.PromoteProposalAsync(preview.ProposalId);
            await service.CreateIdeaRecordAsync("idea-1", "First", "record");
            await service.SetIdeaTitleAsync("idea-1", 1, "Changed", "edit");
            return;
        }
        var fixture = SemanticApplicationFixture.Load(application);
        var id = $"proposal-{Guid.NewGuid():N}";
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(id, "Create application", "test", fixture.DefinitionChangeSet(id)));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        foreach (var record in fixture.LoadRecords())
            await service.CreateRecordAsync(new(fixture.Entity.EntityId, record.RecordId, record.ToValues(), new("copy-tests", record.RecordId, "test")));
        await service.ExecuteCommandAsync(new(fixture.Command.NodeId, fixture.LoadRecords()[0].RecordId, 1, new("copy-tests", "command", "test")));
    }

    private static string ApplicationState(NendoSessionSnapshot snapshot) => JsonSerializer.Serialize(new { snapshot.Entities, snapshot.Records, snapshot.UiNodes });
    private static string Destination(EngineTestWorkspace workspace, string fileName = "copy.nendo") => Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, fileName);
    private static void AssertNoStages(EngineTestWorkspace workspace) => Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*"));
    private static async Task<byte[]> BytesAsync(string path)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var memory = new MemoryStream();
        await file.CopyToAsync(memory);
        return memory.ToArray();
    }
    private static void Change(string path, string sql)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
