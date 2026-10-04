using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Views that write (ADR-0013 Phase 3, W-065): a custom view's record writes reach the host
/// through the Workbench's broker named for the view's package. The host admits that name on
/// the four record writes alone, History attributes each write to it, and every other method
/// refuses it. What the broker sends is pinned in scripts/extension-broker.test.mjs; this is
/// the host's half.
/// </summary>
[TestClass]
public sealed class DesktopExtensionWriterTests
{
    private static readonly string Package = DesktopExtensionViewJourneyTests.ProbePackages[0];
    private static readonly string Actor = "extension:" + Package;

    [TestMethod]
    public async Task AViewWritesAsItsPackageAndHistorySaysSo()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var created = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
            new { entityId = "tasks", recordId = "from-view", values = new { title = "Written by a view" }, idempotencyKey = "view-create", actor = Actor }));
        Assert.IsTrue(created.Ok, created.Error?.Message);
        var updated = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataSetFields,
            new { entityId = "tasks", recordId = "from-view", expectedRecordVersion = 1, values = new { title = "Changed by a view" }, idempotencyKey = "view-update", actor = Actor }));
        Assert.IsTrue(updated.Ok, updated.Error?.Message);
        var deleted = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataDeleteRecord,
            new { entityId = "tasks", recordId = "from-view", expectedRecordVersion = 2, idempotencyKey = "view-delete", actor = Actor }));
        Assert.IsTrue(deleted.Ok, deleted.Error?.Message);
        var person = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
            new { entityId = "tasks", recordId = "from-person", values = new { title = "Typed by the person" }, idempotencyKey = "person-create" }));
        Assert.IsTrue(person.Ok, person.Error?.Message);

        var history = await session.GetHistoryAsync();
        var byView = history.Where(revision => revision.Origin == Actor).ToArray();
        Assert.HasCount(3, byView, "History does not name the view's package on each of its three writes: " +
            string.Join(", ", history.Select(revision => revision.Origin)));
        Assert.IsTrue(history.Any(revision => revision.Origin == "surface"), "The person's own write lost its attribution.");
        Assert.IsFalse(history.Any(revision => revision.Origin.StartsWith("extension:", StringComparison.Ordinal) && revision.Origin != Actor));
    }

    // W-102: several writes as one revision, through the same admission as a single write.
    [TestMethod]
    public async Task AViewsBatchIsOneRevisionInItsPackagesNameAndAnswersEachVersion()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetHistoryAsync()).Count;

        var response = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataWriteRecords, new
        {
            writes = new object[]
            {
                new { kind = "create", entityId = "tasks", recordId = "batch-1", values = new { title = "First" } },
                new { kind = "create", entityId = "tasks", recordId = "batch-2", values = new { title = "Second" } },
                new { kind = "update", entityId = "tasks", recordId = "batch-1", expectedRecordVersion = 1, values = new { title = "Twice" } },
            },
            label = "Arrange", idempotencyKey = "view-batch-twice", actor = Actor,
        }));
        Assert.IsFalse(response.Ok, "A batch that writes one record twice was accepted.");
        Assert.HasCount(before, await session.GetHistoryAsync(), "A refused batch left a revision.");

        response = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataWriteRecords, new
        {
            writes = new object[]
            {
                new { kind = "create", entityId = "tasks", recordId = "batch-1", values = new { title = "First" } },
                new { kind = "create", entityId = "tasks", recordId = "batch-2", values = new { title = "Second" } },
            },
            label = "Arrange", idempotencyKey = "view-batch", actor = Actor,
        }));
        Assert.IsTrue(response.Ok, response.Error?.Message);
        var view = (DesktopRecordWritesView)response.Result!;
        CollectionAssert.AreEqual(new long?[] { 1, 1 }, view.Records.Select(record => record.RecordVersion).ToArray());

        var history = await session.GetHistoryAsync();
        Assert.HasCount(before + 1, history, "The batch was not one revision.");
        var revision = history.Single(item => item.RevisionId == view.Mutation.RevisionId);
        Assert.AreEqual(Actor, revision.Origin, "History does not name the view's package on its batch.");
        Assert.AreEqual("Arrange", revision.Description);
    }

    /// <summary>
    /// ADR-0023 (W-103): a view undoes and redoes its own batch in its package's name. Another
    /// package's view, a request with no view behind it and a redo of something that is not an
    /// undo are refused, and change nothing.
    /// </summary>
    [TestMethod]
    public async Task AViewUndoesAndRedoesItsOwnBatchAndNothingElse()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var batch = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataWriteRecords, new
        {
            writes = new object[] { new { kind = "create", entityId = "tasks", recordId = "undo-1", values = new { title = "Made" } } },
            label = "Make one", idempotencyKey = "view-make", actor = Actor,
        }));
        Assert.IsTrue(batch.Ok, batch.Error?.Message);
        var made = ((DesktopRecordWritesView)batch.Result!).Mutation.RevisionId;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        foreach (var (body, code) in new (object, string)[]
        {
            (new { revisionId = made, idempotencyKey = "no-view" }, "actor-not-allowed"),
            (new { revisionId = made, idempotencyKey = "other-view", actor = "extension:" + DesktopExtensionViewJourneyTests.ProbePackages[1] }, "revision-not-yours"),
            (new { revisionId = made, redo = true, idempotencyKey = "redo-first", actor = Actor }, "not-an-undo"),
        })
        {
            var refused = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataUndoRecordWrites, body));
            Assert.IsFalse(refused.Ok, $"{JsonSerializer.Serialize(body)} was accepted.");
            Assert.AreEqual(code, refused.Error!.Code, refused.Error.Message);
        }
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "A refused undo changed the file.");

        var undo = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataUndoRecordWrites,
            new { revisionId = made, idempotencyKey = "view-undo", actor = Actor }));
        Assert.IsTrue(undo.Ok, undo.Error?.Message);
        var undone = (DesktopRecordWritesView)undo.Result!;
        CollectionAssert.AreEqual(new long?[] { null }, undone.Records.Select(record => record.RecordVersion).ToArray(), "The undo did not delete the record it made.");

        var redo = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataUndoRecordWrites,
            new { revisionId = undone.Mutation.RevisionId, redo = true, idempotencyKey = "view-redo", actor = Actor }));
        Assert.IsTrue(redo.Ok, redo.Error?.Message);
        CollectionAssert.AreEqual(new long?[] { 2 }, ((DesktopRecordWritesView)redo.Result!).Records.Select(record => record.RecordVersion).ToArray(),
            "The redo did not restore the record under its own ID.");

        var history = await session.GetHistoryAsync();
        CollectionAssert.AreEqual(new[] { "Make one", "Undo Make one", "Redo Make one" },
            history.Where(revision => revision.Origin == Actor).Select(revision => revision.Description).Reverse().Take(3).Reverse().ToArray(),
            "History does not name the view's batch, its undo and its redo in the package's name.");
    }

    [TestMethod]
    public async Task AnActorIsRefusedOnEveryMethodButTheRecordWritesAndPreparingAProposal()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var writers = WorkbenchMethods.ExtensionWriterMethods.OrderBy(method => method, StringComparer.Ordinal).ToArray();
        CollectionAssert.AreEqual(new[] { WorkbenchMethods.DataCreateRecord, WorkbenchMethods.DataDeleteRecord, WorkbenchMethods.DataExecuteCommand, WorkbenchMethods.DataMoveRecord, WorkbenchMethods.DataSetFields, WorkbenchMethods.DataUndoRecordWrites, WorkbenchMethods.DataWriteRecords, WorkbenchMethods.ExtensionStateRead, WorkbenchMethods.ExtensionStateSet, WorkbenchMethods.ProposalGet, WorkbenchMethods.ProposalPrepareChangeSet },
            writers, "The methods a view's actor may reach changed; the ADR, the contract and the broker's table must change with them.");

        var methods = typeof(WorkbenchMethods)
            .GetFields(BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(field => (string)field.GetRawConstantValue()!)
            .Where(method => !WorkbenchMethods.ExtensionWriterMethods.Contains(method) && method != WorkbenchMethods.RequestCancel)
            .ToArray();
        Assert.IsGreaterThan(40, methods.Length, "The scan found almost no methods.");
        var admitted = new List<string>();
        foreach (var method in methods)
        {
            var response = await handler.HandleAsync(Request(fileSessionId, method, new { actor = Actor, entityId = "tasks", recordId = "t1" }));
            if (response.Ok || response.Error!.Code is not ("actor-not-allowed" or "unknown-method")) admitted.Add($"{method} ({(response.Ok ? "ok" : response.Error!.Code)})");
        }
        Assert.IsEmpty(admitted, "A method other than the record writes accepted a view's actor: " + string.Join(", ", admitted));
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "A refused request changed the file.");
    }

    /// <summary>
    /// W-079: a view moves a record in a declared tree (ADR-0019, 2026-09-28) as its package, and
    /// the Engine's rule refuses a loop whoever asks. The seed's orders leave gaps, so neither
    /// move renumbers a sibling and every version below is the seed's.
    /// </summary>
    [TestMethod]
    public async Task AViewMovesARecordInItsTreeAsItsPackageAndALoopIsRefused()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        await SeedTreeAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var moved = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataMoveRecord, new
        {
            entityId = "units", recordId = "u-b", expectedRecordVersion = 1, parentRecordId = "u-a", expectedParentVersion = 1,
            idempotencyKey = "view-move", actor = Actor,
        }));
        Assert.IsTrue(moved.Ok, moved.Error?.Message);
        var byView = (await session.GetHistoryAsync()).Where(revision => revision.Origin == Actor).ToArray();
        Assert.HasCount(1, byView, "History does not name the view's package on its move.");

        // u-a under u-c, its own child, would close a loop.
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;
        var loop = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataMoveRecord, new
        {
            entityId = "units", recordId = "u-a", expectedRecordVersion = 1, parentRecordId = "u-c", expectedParentVersion = 1,
            idempotencyKey = "view-loop", actor = Actor,
        }));
        Assert.IsFalse(loop.Ok, "A view moved a record under its own child.");
        Assert.AreEqual("hierarchy-cycle", loop.Error!.Code, loop.Error.Message);
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "A refused move changed the file.");
    }

    /// <summary>Units kept as a tree by their parent, ordered: u-a and u-b at the top, u-c under u-a.</summary>
    private static async Task SeedTreeAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "view-tree");
        var service = new NendoApplicationService(coordinator);
        var schemaRevision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "tree-schema", "test", "Units", [
            new CreateEntityOperation("units", "units", "Units", "units"),
            new AddFieldOperation("units-title", "units", "unitTitle", "Title", "unit_title", NendoStorageKind.Text, true),
            new AddFieldOperation("units-parent", "units", "unitParent", "Part of", "unit_parent", NendoStorageKind.Reference, false),
            new AddFieldOperation("units-order", "units", "unitOrder", "Order", "unit_order", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("units-bind", "units", "unitParent", "units", "unitTitle", schemaRevision),
        ]));
        foreach (var (id, parent, order) in new (string, string?, long)[] { ("u-a", null, 1024), ("u-b", null, 2048), ("u-c", "u-a", 1024) })
        {
            await service.CreateRecordAsync(new("units", id,
                new Dictionary<string, object?> { ["unitTitle"] = id.ToUpperInvariant(), ["unitParent"] = parent, ["unitOrder"] = order },
                new NendoRequestContext("test", "tree-" + id, "test"), parent is null ? null : new Dictionary<string, long> { ["unitParent"] = 1 }));
        }
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "tree-declare", "test", "Declare the tree",
            [new DeclareHierarchyOperation("units-tree", "units", "unitParent", "unitOrder", revision)]));
    }

    [TestMethod]
    [DataRow("studio", "actor-not-allowed")]
    [DataRow("extension:", "actor-not-allowed")]
    [DataRow("extension:Org.Example", "actor-not-allowed")]
    [DataRow("extension:org.example.not-in-this-file", "actor-not-allowed")]
    public async Task AWriteNamedForAPackageTheFileDoesNotCarryIsRefusedAndChangesNothing(string actor, string code)
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var response = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
            new { entityId = "tasks", recordId = "forged", values = new { title = "Forged" }, idempotencyKey = "forged-" + actor.Length, actor }));

        Assert.IsFalse(response.Ok);
        Assert.AreEqual(code, response.Error!.Code, response.Error.Message);
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence);
    }

    [TestMethod]
    public async Task AViewCannotWriteWhileViewsAreOffOrOverAStaleVersion()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        // t1 is at version 1; a view that read it earlier and says version 0 or 2 is refused.
        var stale = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataSetFields,
            new { entityId = "tasks", recordId = "t1", expectedRecordVersion = 2, values = new { title = "Over somebody else's edit" }, idempotencyKey = "view-stale", actor = Actor }));
        Assert.IsFalse(stale.Ok, "A write over a version the record does not have was applied.");
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "A stale write changed the file.");

        foreach (var scope in new[] { "file", "device" })
        {
            await session.SetExtensionSettingAsync(scope, false);
            var off = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataSetFields,
                new { entityId = "tasks", recordId = "t1", expectedRecordVersion = 1, values = new { title = "While views are off" }, idempotencyKey = "view-off-" + scope, actor = Actor }));
            Assert.IsFalse(off.Ok, $"A view wrote while views were off for the {scope}.");
            Assert.AreEqual("views-off", off.Error!.Code, off.Error.Message);
            await session.SetExtensionSettingAsync(scope, true);
        }
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence);
    }

    /// <summary>
    /// R-014: the protocol admits a view's write before the request waits for the session gate.
    /// A kill switch already waiting there completes first; the write that was queued behind it
    /// must then be refused, not commit after views were turned off.
    /// </summary>
    [TestMethod]
    [DataRow("device")]
    [DataRow("file")]
    public async Task AKillSwitchQueuedAheadOfAViewWriteStopsThatWrite(string scope)
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var gate = Gate(session);
        await gate.WaitAsync();
        Task<DesktopSessionView> off;
        Task<WorkbenchResponse> write;
        try
        {
            off = session.SetExtensionSettingAsync(scope, false);
            write = handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
                new { entityId = "tasks", recordId = "queued", values = new { title = "Queued behind the switch" }, idempotencyKey = "view-queued", actor = Actor }));
            Assert.IsFalse(off.IsCompleted, "The kill switch did not wait for the held gate.");
            Assert.IsFalse(write.IsCompleted, $"The write did not reach the held gate: {(write.IsCompleted ? write.Result.Error?.Message : null)}");
        }
        finally
        {
            gate.Release();
        }

        Assert.IsFalse((await off).Extensions!.Run, "The kill switch did not turn views off.");
        var response = await write;
        Assert.IsFalse(response.Ok, $"A view's write queued behind the {scope} kill switch committed after views were turned off.");
        Assert.AreEqual("views-off", response.Error!.Code, response.Error.Message);
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "The refused write changed the file.");
    }

    /// <summary>The same order with the package's removal ahead of its view's write.</summary>
    [TestMethod]
    public async Task APackageRemovalQueuedAheadOfItsViewsWriteStopsThatWrite()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var package = DesktopExtensionViewJourneyTests.ProbePackages[2];
        var actor = "extension:" + package;
        var removal = await session.PrepareExtensionRemovalAsync(package);
        Assert.AreEqual(NendoProposalState.Previewable, removal.State, string.Join("; ", removal.Diagnostics.Select(d => d.Message)));

        var gate = Gate(session);
        await gate.WaitAsync();
        Task<DesktopPromotionView> removed;
        Task<WorkbenchResponse> write;
        try
        {
            removed = session.PromoteProposalAsync(removal.ProposalId, expectedOperationDigest: removal.OperationDigest);
            write = handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
                new { entityId = "tasks", recordId = "queued", values = new { title = "Queued behind the removal" }, idempotencyKey = "view-queued-removal", actor }));
            Assert.IsFalse(removed.IsCompleted, "The removal did not wait for the held gate.");
            Assert.IsFalse(write.IsCompleted, $"The write did not reach the held gate: {(write.IsCompleted ? write.Result.Error?.Message : null)}");
        }
        finally
        {
            gate.Release();
        }

        Assert.IsTrue((await removed).Promotion.Applied, "The removal was not applied.");
        var response = await write;
        Assert.IsFalse(response.Ok, "A view's write queued behind its package's removal committed after the package was gone.");
        Assert.AreEqual("actor-not-allowed", response.Error!.Code, response.Error.Message);
        Assert.IsFalse((await session.GetHistoryAsync()).Any(revision => revision.Origin == actor),
            "History holds a write in the name of a package that was removed before it committed.");
    }

    /// <summary>
    /// The other order: a write already admitted when the switch is thrown finishes, and its
    /// outcome is reported as the commit it was, before the switch takes effect.
    /// </summary>
    [TestMethod]
    public async Task AViewWriteAdmittedBeforeTheKillSwitchCommitsAndSaysSo()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        // With the gate free, the request runs synchronously through both of its gate entries,
        // so by the time HandleAsync hands back its task the write holds the gate (or is done)
        // and the switch below queues behind it.
        var write = handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord,
            new { entityId = "tasks", recordId = "ahead", values = new { title = "Ahead of the switch" }, idempotencyKey = "view-ahead", actor = Actor }));
        var off = session.SetExtensionSettingAsync("device", false);

        var response = await write;
        Assert.IsTrue(response.Ok, response.Error?.Message);
        Assert.IsFalse((await off).Extensions!.Run);
        Assert.IsTrue((await session.GetHistoryAsync()).Any(revision => revision.Origin == Actor),
            "A write reported as committed is not in History.");
    }

    private static SemaphoreSlim Gate(DesktopSessionController session) =>
        (SemaphoreSlim)typeof(DesktopSessionController)
            .GetField("_gate", BindingFlags.NonPublic | BindingFlags.Instance)!
            .GetValue(session)!;

    private static async Task<(DesktopSessionController Session, WorkbenchProtocolHandler Handler, string FileSessionId)> OpenAsync(DesktopTestWorkspace workspace)
    {
        var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var view = await session.GetViewAsync();
        Assert.IsTrue(view.Extensions!.Run, "Views are not running in the seeded file.");
        return (session, handler, view.FileSessionId!);
    }

    private static string Request(string fileSessionId, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "writer-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });
}
