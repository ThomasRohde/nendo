using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// R-002, the host's half: a custom view's records.create and records.update reach the host
/// through the broker named for the view's package, now with the view's
/// <c>expectedTargetVersions</c>. Through the real protocol and typed service, a reference
/// with the target's current version commits, a stale version is refused as a changed
/// target, a missing version is refused as required, and a null reference needs none.
/// What the broker sends is pinned in scripts/extension-broker.test.mjs.
/// </summary>
[TestClass]
public sealed class DesktopExtensionReferenceWriteTests
{
    private static readonly string Actor = "extension:" + DesktopExtensionViewJourneyTests.ProbePackages[0];

    [TestMethod]
    public async Task AViewCreatesARecordWithAReferenceOnlyAtTheTargetsCurrentVersion()
    {
        await using var workspace = new DesktopTestWorkspace();
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var current = await Create(handler, fileSessionId, "ref-current", "p1", new Dictionary<string, long> { ["project"] = 2 });
        Assert.IsTrue(current.Ok, current.Error?.Message);

        var stale = await Create(handler, fileSessionId, "ref-stale", "p1", new Dictionary<string, long> { ["project"] = 1 });
        Assert.IsFalse(stale.Ok, "A reference over a stale target version was written.");
        Assert.AreEqual("target-version-conflict", stale.Error!.Code, stale.Error.Message);

        var absent = await Create(handler, fileSessionId, "ref-absent", "p1", null);
        Assert.IsFalse(absent.Ok, "A reference with no target version was written.");
        Assert.AreEqual("target-version-required", absent.Error!.Code, absent.Error.Message);

        var noEntry = await Create(handler, fileSessionId, "ref-no-entry", "p1", new Dictionary<string, long>());
        Assert.IsFalse(noEntry.Ok, "A reference whose field has no entry in the map was written.");
        Assert.AreEqual("target-version-required", noEntry.Error!.Code, noEntry.Error.Message);

        var cleared = await Create(handler, fileSessionId, "ref-null", null, null);
        Assert.IsTrue(cleared.Ok, cleared.Error?.Message);

        var records = await Records(session);
        CollectionAssert.AreEquivalent(new[] { "ref-current", "ref-null" },
            records.Keys.Where(id => id.StartsWith("ref-", StringComparison.Ordinal)).ToArray());
        Assert.AreEqual("p1", Reference(records["ref-current"]));
        Assert.IsNull(Reference(records["ref-null"]));
        Assert.AreEqual(2, (await session.GetHistoryAsync()).Count(revision => revision.Origin == Actor),
            "History does not name the view's package on both of its writes.");
    }

    [TestMethod]
    public async Task AViewUpdatesAReferenceOnlyAtTheTargetsCurrentVersion()
    {
        await using var workspace = new DesktopTestWorkspace();
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var stale = await Update(handler, fileSessionId, 1, "p1", new Dictionary<string, long> { ["project"] = 1 });
        Assert.IsFalse(stale.Ok, "A reference over a stale target version was written.");
        Assert.AreEqual("target-version-conflict", stale.Error!.Code, stale.Error.Message);

        var absent = await Update(handler, fileSessionId, 1, "p1", null);
        Assert.IsFalse(absent.Ok, "A reference with no target version was written.");
        Assert.AreEqual("target-version-required", absent.Error!.Code, absent.Error.Message);

        var noEntry = await Update(handler, fileSessionId, 1, "p1", new Dictionary<string, long>());
        Assert.IsFalse(noEntry.Ok, "A reference whose field has no entry in the map was written.");
        Assert.AreEqual("target-version-required", noEntry.Error!.Code, noEntry.Error.Message);
        Assert.AreEqual(1, (await Records(session))["t1"].RecordVersion, "A refused update changed the record.");

        var current = await Update(handler, fileSessionId, 1, "p1", new Dictionary<string, long> { ["project"] = 2 });
        Assert.IsTrue(current.Ok, current.Error?.Message);
        Assert.AreEqual("p1", Reference((await Records(session))["t1"]));

        var cleared = await Update(handler, fileSessionId, 2, null, null);
        Assert.IsTrue(cleared.Ok, cleared.Error?.Message);
        var t1 = (await Records(session))["t1"];
        Assert.IsNull(Reference(t1));
        Assert.AreEqual(3, t1.RecordVersion);
        Assert.AreEqual(2, (await session.GetHistoryAsync()).Count(revision => revision.Origin == Actor));
    }

    private static Task<WorkbenchResponse> Create(WorkbenchProtocolHandler handler, string fileSessionId, string recordId,
        string? project, IReadOnlyDictionary<string, long>? versions) =>
        handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord, versions is null
            ? new { entityId = "tasks", recordId, values = Values(recordId, project), idempotencyKey = "create-" + recordId, actor = Actor }
            : new { entityId = "tasks", recordId, values = Values(recordId, project), idempotencyKey = "create-" + recordId, actor = Actor, expectedTargetVersions = versions } as object));

    private static Task<WorkbenchResponse> Update(WorkbenchProtocolHandler handler, string fileSessionId, long expectedRecordVersion,
        string? project, IReadOnlyDictionary<string, long>? versions)
    {
        var key = $"update-{expectedRecordVersion}-{project ?? "null"}-{versions?.GetValueOrDefault("project")}-{versions?.Count}";
        var values = new Dictionary<string, object?> { ["project"] = project };
        return handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataSetFields, versions is null
            ? new { entityId = "tasks", recordId = "t1", expectedRecordVersion, values, idempotencyKey = key, actor = Actor }
            : new { entityId = "tasks", recordId = "t1", expectedRecordVersion, values, idempotencyKey = key, actor = Actor, expectedTargetVersions = versions } as object));
    }

    private static Dictionary<string, object?> Values(string title, string? project) => new() { ["title"] = title, ["project"] = project };

    private static string? Reference(NendoRecordSnapshot record) =>
        record.Values.TryGetValue("project", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static async Task<Dictionary<string, NendoRecordSnapshot>> Records(DesktopSessionController session) =>
        (await session.QueryRecordsAsync(new NendoRecordQuery("tasks", 100), CancellationToken.None)).Items.ToDictionary(record => record.RecordId, StringComparer.Ordinal);

    /// <summary>
    /// The view journey's file, with a Projects type and an optional reference from each task
    /// to its project. Project p1 has been edited once, so version 2 is current and 1 is stale.
    /// </summary>
    private static async Task<(DesktopSessionController, WorkbenchProtocolHandler, string)> OpenAsync(DesktopTestWorkspace workspace)
    {
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "reference-seed"))
        {
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(new("test", "projects", "test", "Projects", [
                new CreateEntityOperation("projects", "projects", "Projects", "projects"),
                new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            ]));
            var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("test", "project-reference", "test", "Task project", [
                new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("bind-project", "tasks", "project", "projects", "name", revision),
            ]));
            await service.CreateRecordAsync(new("projects", "p1", new Dictionary<string, object?> { ["name"] = "Site" }, new("test", "p1", "test")));
            await service.SetFieldAsync(new NendoSetFieldRequest("projects", "p1", "name", 1, "Site works", new("test", "p1-edit", "test")));
        }
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
        requestId = "reference-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });
}
