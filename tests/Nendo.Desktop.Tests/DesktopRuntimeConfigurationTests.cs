using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopRuntimeConfigurationTests
{
    [TestMethod]
    public void OrdinaryLaunchHasNeitherOverrideNorNativeCapture()
    {
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveDeviceStateRoot(_ => null));
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveNativeCaptureRoot(_ => null));
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveNativeCaptureRoot(key => key == "NENDO_NATIVE_DIAGNOSTICS" ? "1" : null));
    }

    [TestMethod]
    public void ExplicitProfileDoesNotImplicitlyEnableCaptures()
    {
        var path = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "nendo-profile-contract"));
        string? Read(string name) => name == "NENDO_DEVICE_STATE_ROOT" ? path : null;
        Assert.AreEqual(path, DesktopRuntimeConfiguration.ResolveDeviceStateRoot(Read));
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveNativeCaptureRoot(Read));
        Assert.AreEqual(path, DesktopRuntimeConfiguration.ResolveNativeCaptureRoot(name => name == "NENDO_NATIVE_DIAGNOSTICS" ? "1" : Read(name)));
        Assert.IsFalse(Directory.Exists(path), "Resolving the profile must not write anything.");
    }

    /// <summary>
    /// A process on an isolated device state under the product identity is a lane, and
    /// writes neither the installed Nendo's Jump List nor its notification registration.
    /// </summary>
    [TestMethod]
    public void OnlyTheProductProfileOrAPinnedIdentityWritesShellState()
    {
        var path = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "nendo-profile-contract"));
        Assert.IsTrue(DesktopRuntimeConfiguration.ResolveWritesShellState(_ => null), "The person's own Nendo stopped writing its Jump List.");
        Assert.IsFalse(DesktopRuntimeConfiguration.ResolveWritesShellState(name => name == "NENDO_DEVICE_STATE_ROOT" ? path : null),
            "A lane on an isolated device state writes the installed Nendo's Jump List and notification registration.");
        Assert.IsTrue(DesktopRuntimeConfiguration.ResolveWritesShellState(name => name switch
        {
            "NENDO_DEVICE_STATE_ROOT" => path,
            "NENDO_DESKTOP_APP_ID" => "Nendo.Lane.abc",
            _ => null,
        }), "A lane with an identity of its own cannot measure its Jump List.");
        Assert.IsFalse(DesktopRuntimeConfiguration.ResolveWritesShellState(name => name switch
        {
            "NENDO_DEVICE_STATE_ROOT" => path,
            "NENDO_DESKTOP_APP_ID" => "Nendo\\Lane",
            _ => null,
        }), "A refused identity falls back to the product one, so it must not write.");
        Assert.IsFalse(DesktopRuntimeConfiguration.ResolveWritesShellState(name => name == "NENDO_DEVICE_STATE_ROOT" ? "relative-profile" : null));
    }

    [TestMethod]
    public void RelativeProfileFailsInsteadOfFallingBackToOwnerState()
    {
        Assert.ThrowsExactly<NendoValidationException>(() => DesktopRuntimeConfiguration.ResolveDeviceStateRoot(
            name => name == "NENDO_DEVICE_STATE_ROOT" ? "relative-profile" : null));
    }

    [TestMethod]
    public void OrdinaryLaunchLeavesTheCloseButtonToThePreference()
    {
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveCloseAction(_ => null));
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveCloseAction(_ => "   "));
    }

    [TestMethod]
    [DataRow("tray")]
    [DataRow("exit")]
    public void TheProcessOwnerCanPinWhatTheCloseButtonDoes(string value)
    {
        Assert.AreEqual(
            value,
            DesktopRuntimeConfiguration.ResolveCloseAction(name => name == "NENDO_DESKTOP_CLOSE_ACTION" ? value : null));
    }

    [TestMethod]
    [DataRow("Exit")]
    [DataRow("quit")]
    [DataRow("1")]
    public void AnUnrecognisedCloseActionIsRefusedRatherThanGuessedAt(string value)
    {
        // A typo that fell back to the default would leave a scripted lane's process
        // resident in the notification area and report it as a hang.
        Assert.ThrowsExactly<NendoValidationException>(
            () => DesktopRuntimeConfiguration.ResolveCloseAction(name => name == "NENDO_DESKTOP_CLOSE_ACTION" ? value : null));
    }
}
