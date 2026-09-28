using System.Runtime.InteropServices;
using System.Text;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-089. Opening a file another Nendo window had open for editing started a second process
/// that could only refuse it and offer a read-only copy. The hand-off reads who holds the file
/// from the write-owner sidecar and asks that window to come forward. The two-process journey
/// is measured by Review-ShellRuntime.ps1; these hold the parts one process can reach.
/// </summary>
[TestClass]
public sealed class DesktopWindowHandoffTests
{
    [TestMethod]
    public async Task TheOwnerIsReadFromTheSidecarTheEngineKeepsWhileTheFileIsOpen()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);

        // Read as another process would: the sidecar is held writable and delete-on-close,
        // and a reader that does not share both is refused and would find no owner.
        Assert.AreEqual(Environment.ProcessId, DesktopWindowHandoff.OwnerOf(workspace.FilePath, _ => true, self: 1));
        Assert.AreEqual(Environment.ProcessId, DesktopWindowHandoff.OwnerOf(workspace.FilePath.ToUpperInvariant(), _ => true, self: 1),
            "A path in another case names the same file on Windows.");
        Assert.IsNull(DesktopWindowHandoff.OwnerOf(workspace.FilePath, _ => true),
            "A file this process holds is not handed to itself.");
        Assert.IsNull(DesktopWindowHandoff.OwnerOf(workspace.FilePath, _ => false, self: 1),
            "A process ID that no longer belongs to a Nendo is nobody to hand the file to.");

        await session.CloseAsync();
        Assert.IsNull(DesktopWindowHandoff.OwnerOf(workspace.FilePath, _ => true, self: 1),
            "A closed file has no sidecar and no owner.");
    }

    [TestMethod]
    [DataRow("")]
    [DataRow("not json")]
    [DataRow("{\"ownerId\":\"x\"}")]
    [DataRow("{\"ownerId\":\"x\",\"processId\":\"12\"}")]
    [DataRow("{\"ownerId\":\"x\",\"processId\":-4}")]
    public async Task ASidecarThatDoesNotNameAProcessHandsNothingOff(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        await File.WriteAllTextAsync(workspace.FilePath + ".write-owner", text);
        Assert.IsNull(DesktopWindowHandoff.OwnerOf(workspace.FilePath, _ => true, self: 1));
    }

    [TestMethod]
    [DataRow("show", true, null)]
    [DataRow("show:agent", true, DesktopNotificationContent.RouteAgent)]
    [DataRow("show:health", true, DesktopNotificationContent.RouteHealth)]
    [DataRow("show:open", true, DesktopNotificationContent.RouteOpen)]
    [DataRow("show:data", false, null)]
    [DataRow("show:", false, null)]
    [DataRow("promote", false, null)]
    [DataRow("", false, null)]
    public void ARequestNamesTheWindowAndAtMostAViewANotificationCouldName(string text, bool accepted, string? route)
    {
        Assert.AreEqual(accepted, DesktopWindowHandoff.TryParse(text, out var parsed), text);
        Assert.AreEqual(route, parsed, text);
        if (accepted) Assert.AreEqual(text, DesktopWindowHandoff.Request(parsed));
    }

    [TestMethod]
    public void OnlyAMessageCarryingOurSignatureIsRead()
    {
        Assert.IsTrue(Read(DesktopWindowHandoff.Signature, "show:agent", out var route));
        Assert.AreEqual(DesktopNotificationContent.RouteAgent, route);
        Assert.IsFalse(Read(0x1234, "show:agent", out _), "Another program's WM_COPYDATA is not a request.");
        Assert.IsFalse(Read(DesktopWindowHandoff.Signature, new string('x', 400), out _), "An oversized payload is refused unread.");
        Assert.IsFalse(DesktopWindowHandoff.TryRead(IntPtr.Zero, out _));
    }

    [TestMethod]
    public void ThisProcessIsNeverAskedToShowItself() =>
        Assert.IsFalse(DesktopWindowHandoff.TryShow(Environment.ProcessId));

    private static bool Read(int signature, string text, out string? route)
    {
        var payload = Encoding.Unicode.GetBytes(text + '\0');
        var buffer = Marshal.AllocHGlobal(payload.Length);
        var structure = Marshal.AllocHGlobal(Marshal.SizeOf<DesktopWindowHandoff.COPYDATASTRUCT>());
        try
        {
            Marshal.Copy(payload, 0, buffer, payload.Length);
            Marshal.StructureToPtr(new DesktopWindowHandoff.COPYDATASTRUCT
            {
                dwData = signature,
                cbData = payload.Length,
                lpData = buffer,
            }, structure, false);
            return DesktopWindowHandoff.TryRead(structure, out route);
        }
        finally
        {
            Marshal.FreeHGlobal(structure);
            Marshal.FreeHGlobal(buffer);
        }
    }
}
