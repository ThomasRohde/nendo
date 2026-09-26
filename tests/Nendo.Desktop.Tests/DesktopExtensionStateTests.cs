using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// What a custom view keeps with the file (ADR-0013 Phase 3, W-069), at the host: state is read
/// and written only with a view's actor, in that actor's package and nowhere else, as a Data
/// revision History names the package on, and not while views are off.
/// </summary>
[TestClass]
public sealed class DesktopExtensionStateTests
{
    private static readonly string Package = DesktopExtensionViewJourneyTests.ProbePackages[0];
    private static readonly string Actor = "extension:" + Package;

    [TestMethod]
    public async Task AViewKeepsStateInItsPackageAndHistorySaysSo()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var kept = await handler.HandleAsync(Set(fileSessionId, "probe", "layout", new { zoom = 1.5 }, Actor));
        Assert.IsTrue(kept.Ok, kept.Error?.Message);
        var read = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ExtensionStateRead, new { viewId = "probe", key = "layout", actor = Actor }));
        Assert.IsTrue(read.Ok, read.Error?.Message);
        var entry = ((DesktopExtensionStateView)read.Result!).Entries.Single();
        Assert.AreEqual(("layout", """{"zoom":1.5}""", 1L), (entry.Key, entry.Value!.Value.GetRawText(), entry.Version));

        // The package is the actor's: another package reads its own, empty, place.
        var other = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ExtensionStateRead,
            new { viewId = "probe", key = "layout", actor = "extension:" + DesktopExtensionViewJourneyTests.ProbePackages[1] }));
        Assert.IsTrue(other.Ok, other.Error?.Message);
        Assert.IsEmpty(((DesktopExtensionStateView)other.Result!).Entries, "One package read another's state.");

        var history = await session.GetHistoryAsync();
        var revision = history.Single(item => item.Description == "Keep layout for the view Probe");
        Assert.AreEqual((Actor, NendoRevisionLane.Data), (revision.Origin, revision.Lane));
    }

    [TestMethod]
    public async Task StateNeedsAViewsActorAndViewsOn()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var person = await handler.HandleAsync(Set(fileSessionId, "probe", "layout", 1, actor: null));
        Assert.IsFalse(person.Ok, "State was written with no view's actor.");
        Assert.AreEqual("actor-not-allowed", person.Error!.Code, person.Error.Message);
        var stranger = await handler.HandleAsync(Set(fileSessionId, "probe", "layout", 1, "extension:org.example.not-in-this-file"));
        Assert.AreEqual("actor-not-allowed", stranger.Error!.Code, stranger.Error.Message);

        await session.SetExtensionSettingAsync("file", false);
        var off = await handler.HandleAsync(Set(fileSessionId, "probe", "layout", 1, Actor));
        Assert.AreEqual("views-off", off.Error!.Code, off.Error.Message);
        await session.SetExtensionSettingAsync("file", true);
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "A refused state write changed the file.");
    }

    private static string Set(string fileSessionId, string viewId, string key, object value, string? actor) =>
        Request(fileSessionId, WorkbenchMethods.ExtensionStateSet, actor is null
            ? new { viewId, key, value, description = $"Keep {key} for the view Probe", idempotencyKey = "state-" + Guid.NewGuid().ToString("N") }
            : (object)new { viewId, key, value, description = $"Keep {key} for the view Probe", idempotencyKey = "state-" + Guid.NewGuid().ToString("N"), actor });

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
        requestId = "state-test-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });
}
