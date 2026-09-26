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

    [TestMethod]
    public async Task AnActorIsRefusedOnEveryMethodButTheRecordWritesAndPreparingAProposal()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var writers = WorkbenchMethods.ExtensionWriterMethods.OrderBy(method => method, StringComparer.Ordinal).ToArray();
        CollectionAssert.AreEqual(new[] { WorkbenchMethods.DataCreateRecord, WorkbenchMethods.DataDeleteRecord, WorkbenchMethods.DataExecuteCommand, WorkbenchMethods.DataSetFields, WorkbenchMethods.ProposalGet, WorkbenchMethods.ProposalPrepareChangeSet },
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

    private static async Task<(DesktopSessionController Session, WorkbenchProtocolHandler Handler, string FileSessionId)> OpenAsync(DesktopTestWorkspace workspace)
    {
        var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
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
