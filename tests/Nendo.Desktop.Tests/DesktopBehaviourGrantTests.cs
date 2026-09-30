using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Stage S6 of ADR-0008, device side: where consent is kept, and what happens when
/// it cannot be read.
/// <para>
/// The store answers one question — may this file run its actions — and it must
/// answer "no" in every case where it is not certain of a "yes". A grant file that
/// is missing, truncated, oversized or edited is not a reason to guess.
/// </para>
/// </summary>
[TestClass]
public sealed class DesktopBehaviourGrantTests
{
    [TestMethod]
    public async Task NothingIsApprovedUntilItIsAndNoStateIsWrittenBefore()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsTrue(store.Persisted);
        Assert.IsNull(store.Notice);
        Assert.IsFalse(Directory.Exists(workspace.FileHistoryRoot), "Asking about approval created device state.");
    }

    [TestMethod]
    public async Task AnApprovalSurvivesANewStoreAndCoversOnlyWhatItNamed()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());

        var reopened = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsTrue(reopened.IsGranted(Grant()));
        Assert.IsTrue(reopened.Persisted);
        Assert.IsNull(reopened.Notice);

        // Each field of a grant is part of what was agreed to. A copy of the file, an
        // edited definition, a later revision or a wider capability is a different
        // question and has to be asked again.
        foreach (var other in new[]
        {
            Grant() with { ApplicationId = "application-other" },
            Grant() with { InstanceId = "instance-other" },
            Grant() with { BehaviourDigest = new string('1', 64) },
            Grant() with { ContractVersion = "behaviour-99" },
            Grant() with { DefinitionRevision = 8 },
            Grant() with { Capabilities = NendoBehaviourCapabilities.UpdateRecords | NendoBehaviourCapabilities.DeleteRecords },
        })
        {
            Assert.IsFalse(reopened.IsGranted(other), $"An approval covered something it did not name: {other}");
        }
    }

    [TestMethod]
    public async Task StaleStoresPreserveOtherApprovalsAndCannotRestoreARevokedGrant()
    {
        await using var workspace = new DesktopTestWorkspace();
        var first = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        var second = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        var a = Grant();
        var b = a with { ApplicationId = "application-two", InstanceId = "instance-two" };
        var c = a with { ApplicationId = "application-three", InstanceId = "instance-three" };
        first.Approve(a);
        second.Approve(b);
        Assert.IsTrue(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(a),
            "A stale second approval erased the first file's approval.");
        first.Revoke(a.ApplicationId, a.InstanceId);
        second.Approve(c);
        var reopened = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.IsGranted(a), "An unrelated approval restored revoked consent.");
        Assert.IsTrue(reopened.IsGranted(b));
        Assert.IsTrue(reopened.IsGranted(c));
        Assert.IsTrue(first.Persisted && second.Persisted);
    }

    [TestMethod]
    public async Task AStoreLoadedBeforeWithdrawalCannotPersistThatGrantAgain()
    {
        await using var workspace = new DesktopTestWorkspace();
        var first = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        first.Approve(Grant());
        var stale = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        first.Revoke(Grant().ApplicationId, Grant().InstanceId);
        stale.Approve(Grant() with { ApplicationId = "application-other", InstanceId = "instance-other" });
        Assert.IsFalse(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()),
            "An unrelated approval restored revoked consent from a stale store.");
    }

    [TestMethod]
    public async Task AnotherStoresWithdrawalIsVisibleEvenAfterExactReapproval()
    {
        await using var workspace = new DesktopTestWorkspace();
        var owner = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        owner.Approve(Grant());
        var other = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        var generation = other.RevocationGeneration;
        owner.Revoke(Grant().ApplicationId, Grant().InstanceId);
        Assert.IsFalse(other.IsGranted(Grant()), "An already-open authority kept trusting revoked consent.");
        owner.Approve(Grant());
        Assert.IsTrue(other.IsGranted(Grant()));
        Assert.IsGreaterThan(generation, other.RevocationGeneration,
            "An external withdrawal followed by reapproval did not invalidate work already in flight.");
    }

    [TestMethod]
    public async Task AWithdrawalWithoutTheDeviceLockStaysLocalUntilASerializedSave()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());
        var acquired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Factory.StartNew(() =>
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"));
            acquired.SetResult();
            release.Wait();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await acquired.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            store.Revoke(Grant().ApplicationId, Grant().InstanceId);
            Assert.IsFalse(store.IsGranted(Grant()), "An unsaved withdrawal stopped applying to this session.");
            Assert.IsFalse(store.Persisted, "The store claimed to persist without owning the shared lock.");
            Assert.IsNotNull(store.Notice);
            Assert.IsTrue(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()),
                "The control document was overwritten without owning its lock.");
        }
        finally { release.Set(); await holder; }
        store.Approve(Grant() with { ApplicationId = "other" });
        Assert.IsFalse(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()),
            "The next serialized save lost the session's unsaved withdrawal.");
    }

    [TestMethod]
    public async Task ASharedWithdrawalAlsoRevokesAnEarlierUnsavedSessionApproval()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        var acquired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Factory.StartNew(() =>
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"));
            acquired.SetResult();
            release.Wait();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await acquired.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            store.Approve(Grant());
            Assert.IsFalse(store.Persisted);
            Assert.IsTrue(store.IsGranted(Grant()));
        }
        finally { release.Set(); await holder; }
        var other = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        other.Revoke(Grant().ApplicationId, Grant().InstanceId);
        Assert.IsFalse(store.IsGranted(Grant()), "An unsaved session approval outran another controller's later withdrawal.");
        store.Approve(Grant() with { ApplicationId = "other" });
        Assert.IsFalse(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()),
            "A later save persisted the superseded session approval again.");
    }

    [TestMethod]
    public async Task ConcurrentIndependentApprovalsAreAllKept()
    {
        await using var workspace = new DesktopTestWorkspace();
        var grants = Enumerable.Range(0, 12).Select(index => Grant() with { ApplicationId = "application-" + index }).ToArray();
        var stores = grants.Select(_ => new DesktopBehaviourGrantStore(workspace.FileHistoryRoot)).ToArray();
        await Task.WhenAll(grants.Select((grant, index) => Task.Run(() => stores[index].Approve(grant))));
        var reopened = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        foreach (var grant in grants) Assert.IsTrue(reopened.IsGranted(grant), "Concurrent approvals lost " + grant.ApplicationId);
    }

    [TestMethod]
    public async Task RevokingRemovesEveryApprovalForThatFileAndMovesTheGeneration()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());
        store.Approve(Grant() with { DefinitionRevision = 4, BehaviourDigest = new string('2', 64) });
        var other = Grant() with { InstanceId = "instance-two" };
        store.Approve(other);
        var generation = store.RevocationGeneration;

        store.Revoke("application-one", "instance-one");

        // Revoking is about the file, not one version of its rules, so every approval
        // for that file goes — and another file's approval is untouched.
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.IsGranted(Grant() with { DefinitionRevision = 4, BehaviourDigest = new string('2', 64) }));
        Assert.IsTrue(store.IsGranted(other));
        Assert.IsGreaterThan(generation, store.RevocationGeneration,
            "A withdrawal that does not move the generation cannot be noticed by work already in flight.");
        Assert.IsFalse(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()));
    }

    [TestMethod]
    [DataRow("not json at all")]
    [DataRow("{}")]
    [DataRow("{\"version\":2,\"grants\":[]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"\",\"instanceId\":\"i\",\"behaviourDigest\":\"00\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":2}]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"application-one\",\"instanceId\":\"instance-one\",\"behaviourDigest\":\"zz\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":2}]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"application-one\",\"instanceId\":\"instance-one\",\"behaviourDigest\":\"" + Digest + "\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":99}]}")]
    public async Task UnreadableStateApprovesNothingAndSaysSo(string contents)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"), contents);

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        // Failing closed is the whole design. "I could not tell" must never read as
        // "yes", or a damaged state file becomes somebody else's actions running.
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.DoesNotContain(workspace.FileHistoryRoot, store.Notice, StringComparison.Ordinal);
    }

    /// <summary>
    /// The same refusal in the casing the store itself writes. The lowercase rows above
    /// never get past the version check, because the reader is case-sensitive; these
    /// reach the per-grant validation, where a null entry or a missing member used to
    /// throw a NullReferenceException that closed every file on open (R-017).
    /// </summary>
    [TestMethod]
    [DataRow("{\"Version\":1,\"Grants\":[null]}")]
    [DataRow("{\"Version\":1,\"Grants\":[{\"ApplicationId\":\"application-one\",\"InstanceId\":\"instance-one\",\"ContractVersion\":\"behaviour-1\",\"DefinitionRevision\":3,\"Capabilities\":2}]}")]
    [DataRow("{\"Version\":1,\"Grants\":[{\"ApplicationId\":\"application-one\",\"InstanceId\":\"instance-one\",\"BehaviourDigest\":null,\"ContractVersion\":\"behaviour-1\",\"DefinitionRevision\":3,\"Capabilities\":2}]}")]
    [DataRow("{\"Version\":1,\"Grants\":[{\"InstanceId\":\"instance-one\",\"BehaviourDigest\":\"" + Digest + "\",\"ContractVersion\":\"behaviour-1\",\"DefinitionRevision\":3,\"Capabilities\":2}]}")]
    [DataRow("{\"Version\":1,\"Grants\":[{\"ApplicationId\":\"application-one\",\"InstanceId\":\"instance-one\",\"BehaviourDigest\":\"" + Digest + "\",\"DefinitionRevision\":3,\"Capabilities\":2}]}")]
    [DataRow("{\"Version\":1}")]
    [DataRow("{\"Version\":1,\"Grants\":null}")]
    [DataRow("null")]
    public async Task StructurallyInvalidStateInTheWrittenCasingApprovesNothingAndSaysSo(string contents)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"), contents);

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
    }

    [TestMethod]
    public async Task ARepairedSharedDocumentClearsTheEarlierUnreadableNotice()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"), "not json");
        var stale = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsFalse(stale.Persisted);
        Assert.IsNotNull(stale.Notice);
        var other = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        other.Approve(Grant());
        Assert.IsTrue(stale.IsGranted(Grant()));
        Assert.IsTrue(stale.Persisted, "A successful shared approval reread kept the old persistence failure.");
        Assert.IsNull(stale.Notice, "The approved file still reported that nothing is approved.");
    }

    [TestMethod]
    public async Task TheWrittenCasingIsWhatTheReaderAccepts()
    {
        // Guards the rows above: a well-formed document in exactly this casing is
        // read as a grant, so the refusals there are about the damaged member alone.
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"),
            "{\"Version\":1,\"Grants\":[{\"ApplicationId\":\"application-one\",\"InstanceId\":\"instance-one\",\"BehaviourDigest\":\"" + Digest + "\",\"ContractVersion\":\"behaviour-1\",\"DefinitionRevision\":3,\"Capabilities\":2}]}");

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        Assert.IsTrue(store.IsGranted(Grant()));
        Assert.IsTrue(store.Persisted);
        Assert.IsNull(store.Notice);
    }

    [TestMethod]
    public async Task AFileStillOpensWhenTheApprovalDocumentHasANullEntry()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedWithTriggerAsync(workspace.FilePath);
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"),
            "{\"Version\":1,\"Grants\":[null]}");

        await using var session = new DesktopSessionController(
            null, workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var opened = await session.OpenAsync(workspace.FilePath);

        // The file is open and usable; only its automatic actions wait for a fresh
        // approval, and the shell is told why it is asking again.
        Assert.IsTrue(opened.HasFile, "A damaged approval document closed a healthy file.");
        var trust = (await session.GetViewAsync()).BehaviourTrust!;
        Assert.IsTrue(trust.RequiresApproval);
        Assert.IsFalse(trust.IsApproved);
        Assert.IsNotNull(trust.Notice);
        Assert.IsTrue((await session.ApproveBehaviourAsync()).BehaviourTrust!.IsApproved,
            "Approving again did not replace the damaged document.");
    }

    [TestMethod]
    public async Task AnOversizedDocumentIsRefusedWithoutBeingRead()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(
            Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"),
            "{\"version\":1,\"grants\":[]," + new string(' ', 300_000) + "}");

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.Persisted);
    }

    [TestMethod]
    public async Task ApprovingWritesOneFileAndLeavesNoStagedRemains()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());
        store.Approve(Grant() with { InstanceId = "instance-two" });

        CollectionAssert.AreEqual(
            new[] { "behaviour-grants.json" },
            Directory.GetFiles(workspace.FileHistoryRoot).Select(Path.GetFileName).ToArray(),
            "Staged temporary state was left behind.");

        // Device state, never application data: nothing here says where the file is.
        var serialized = await File.ReadAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"));
        Assert.DoesNotContain(workspace.FilePath, serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(workspace.FileHistoryRoot, serialized, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>A file carrying one trigger, so opening it asks the store for approval.</summary>
    private static async Task SeedWithTriggerAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "seed");
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("seed", "schema", "seed", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("seed", "behaviour", "seed", "Stamp", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "note.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                        [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the label",
                NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
        ]));
    }

    private const string Digest ="0000000000000000000000000000000000000000000000000000000000000000";

    private static NendoBehaviourGrant Grant() => new(
        "application-one", "instance-one", Digest, "behaviour-1", 3, NendoBehaviourCapabilities.UpdateRecords);
}
