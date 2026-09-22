using Nendo.Desktop;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopShellContractTests
{
    [TestMethod]
    public void WindowPolicyOpensLargeAndEnforcesAUsableMinimum()
    {
        var workArea = new Windows.Graphics.RectInt32(100, 40, 1_920, 1_040);
        var bounds = DesktopWindowPolicy.FitTo(workArea);
        var minimum = DesktopWindowPolicy.MinimumFor(workArea);

        Assert.AreEqual(new Windows.Graphics.RectInt32(260, 80, 1_600, 960), bounds);
        Assert.AreEqual(new Windows.Graphics.SizeInt32(1_024, 720), minimum);
    }

    [TestMethod]
    public void WindowPolicyFitsSmallerWorkAreasWithoutMovingOffScreen()
    {
        var bounds = DesktopWindowPolicy.FitTo(new Windows.Graphics.RectInt32(0, 0, 1_366, 728));
        var minimum = DesktopWindowPolicy.MinimumFor(new Windows.Graphics.RectInt32(0, 0, 800, 600));

        Assert.AreEqual(new Windows.Graphics.RectInt32(0, 0, 1_366, 728), bounds);
        Assert.AreEqual(new Windows.Graphics.SizeInt32(800, 600), minimum);
    }

    [TestMethod]
    public void WorkbenchOriginIsLocalAndStudioRouteIsPermanent()
    {
        var shell = DesktopShellContract.Describe();

        Assert.AreEqual(7, shell.BridgeProtocolVersion);
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(2));
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(3));
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(4));
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(5));
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(6));
        Assert.IsTrue(DesktopShellContract.IsSupportedBridgeProtocol(7));
        Assert.IsFalse(DesktopShellContract.IsSupportedBridgeProtocol(1));
        Assert.IsFalse(DesktopShellContract.IsSupportedBridgeProtocol(8));
        Assert.AreEqual(
            DesktopShellContract.EventBridgeProtocolVersion,
            shell.BridgeProtocolVersion,
            "An unsolicited host event may only be posted to a renderer that knows what to do with one.");
        Assert.AreEqual("studio", shell.PermanentStudioRoute);
        Assert.AreEqual("https", shell.WorkbenchUri.Scheme);
        Assert.AreEqual("app.nendo.local", shell.WorkbenchUri.Host);
        Assert.AreEqual("/index.html", shell.WorkbenchUri.AbsolutePath);
    }

    [TestMethod]
    [DataRow("https://app.nendo.local/index.html", true)]
    [DataRow("https://app.nendo.local/assets/index.js", true)]
    [DataRow("http://app.nendo.local/index.html", false)]
    [DataRow("https://example.com/index.html", false)]
    [DataRow("file:///C:/workbench/index.html", false)]
    [DataRow(null, false)]
    public void WorkbenchNavigationIsRestrictedToTheLocalHttpsOrigin(
        string? uri,
        bool expected)
    {
        Assert.AreEqual(expected, DesktopShellContract.IsAllowedWorkbenchUri(uri));
    }

    [TestMethod]
    public void AHostEventIsShapedSoAnOlderRendererDropsIt()
    {
        var json = WorkbenchProtocolHandler.SerializeEvent(
            new WorkbenchEvent(DesktopShellContract.EventBridgeProtocolVersion, WorkbenchEvents.Navigate, "agent"));

        // These three names are the wire contract host-desktop.ts matches on. The
        // renderer tells an event from a reply by the absence of a request id, so an
        // event that grew one would start resolving somebody else's pending call.
        using var document = System.Text.Json.JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.AreEqual(
            DesktopShellContract.EventBridgeProtocolVersion,
            root.GetProperty("protocolVersion").GetInt32());
        Assert.AreEqual("navigate", root.GetProperty("event").GetString());
        Assert.AreEqual("agent", root.GetProperty("payload").GetString());
        Assert.IsFalse(root.TryGetProperty("requestId", out _), "A host event must never carry a request id.");
        Assert.IsFalse(root.TryGetProperty("ok", out _));
        Assert.IsFalse(root.TryGetProperty("result", out _));
    }
}
