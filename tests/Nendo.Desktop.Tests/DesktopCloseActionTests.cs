namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopCloseActionTests
{
    [TestMethod]
    public void TheDefaultPreferenceHidesTheWindow()
    {
        Assert.AreEqual(
            DesktopCloseOutcome.Hide,
            DesktopCloseAction.Resolve("tray", exitRequested: false, trayAvailable: true));
    }

    [TestMethod]
    public void ChoosingToExitOnCloseExits()
    {
        Assert.AreEqual(
            DesktopCloseOutcome.Exit,
            DesktopCloseAction.Resolve("exit", exitRequested: false, trayAvailable: true));
    }

    [TestMethod]
    [DataRow("tray")]
    [DataRow("exit")]
    public void AnExplicitExitIsNeverOverriddenByThePreference(string closeAction)
    {
        Assert.AreEqual(
            DesktopCloseOutcome.Exit,
            DesktopCloseAction.Resolve(closeAction, exitRequested: true, trayAvailable: true),
            "The tray menu's Exit and a Windows shutdown are the two ways out; a preference that could swallow them would strand the process.");
    }

    [TestMethod]
    public void WithoutAnIconInTheNotificationAreaThereIsNowhereToHideTo()
    {
        Assert.AreEqual(
            DesktopCloseOutcome.Exit,
            DesktopCloseAction.Resolve("tray", exitRequested: false, trayAvailable: false),
            "Hiding a window whose icon the shell refused would leave a process with no way back.");
    }

    [TestMethod]
    public void AnUnrecognisedPreferenceExits()
    {
        Assert.AreEqual(
            DesktopCloseOutcome.Exit,
            DesktopCloseAction.Resolve("vanish", exitRequested: false, trayAvailable: true));
    }
}
