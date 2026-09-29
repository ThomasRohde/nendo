namespace Nendo.Desktop.Tests;

/// <summary>
/// Hovering Nendo in the notification area showed no tooltip. Under NOTIFYICON_VERSION_4
/// the shell reads NIF_SHOWTIP on every add and modify, and the modify that gives the icon
/// the open file's look sent NIF_ICON alone, so the tooltip went the moment a file opened.
/// The shell offers no way to read a tooltip back; this holds the flags every call sends.
/// </summary>
[TestClass]
public sealed class DesktopTrayIconTests
{
    private const int NIM_ADD = 0x0, NIM_MODIFY = 0x1, NIM_DELETE = 0x2, NIM_SETVERSION = 0x4;
    private const int NIF_MESSAGE = 0x01, NIF_ICON = 0x02, NIF_TIP = 0x04, NIF_INFO = 0x10, NIF_SHOWTIP = 0x80;

    [TestMethod]
    public void EveryAddAndModifyKeepsTheStandardTooltip()
    {
        foreach (var flags in new[] { NIF_ICON, NIF_INFO, NIF_TIP, NIF_MESSAGE | NIF_ICON })
        {
            foreach (var message in new[] { NIM_ADD, NIM_MODIFY })
            {
                var sent = DesktopTrayIcon.ShellFlags(message, flags);
                Assert.AreEqual(NIF_TIP | NIF_SHOWTIP, sent & (NIF_TIP | NIF_SHOWTIP),
                    $"Message {message} with flags 0x{flags:X} sent 0x{sent:X}, which leaves the tooltip off.");
                Assert.AreEqual(flags, sent & flags, "The caller's own flags are kept.");
            }
        }
    }

    [TestMethod]
    public void DeleteAndSetVersionSendOnlyWhatTheyAskFor()
    {
        Assert.AreEqual(0, DesktopTrayIcon.ShellFlags(NIM_DELETE, 0));
        Assert.AreEqual(0, DesktopTrayIcon.ShellFlags(NIM_SETVERSION, 0));
    }
}
