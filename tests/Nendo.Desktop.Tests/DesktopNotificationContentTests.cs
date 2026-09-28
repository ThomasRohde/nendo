using System.Xml.Linq;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopNotificationContentTests
{
    private static readonly DesktopNotification[] Every =
    [
        DesktopNotificationContent.TrayIntro("Ideas.nendo"),
        DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 1),
        DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 4),
        DesktopNotificationContent.ApprovalNeeded("Ideas.nendo", true, true, true),
        DesktopNotificationContent.FileUnwritable("Ideas.nendo", "readOnly"),
        DesktopNotificationContent.RendererFailed("Ideas.nendo"),
    ];

    [TestMethod]
    public void NoNotificationOffersToApproveOrAcceptAnything()
    {
        // Promotion verifies the digest that was reviewed, and a behaviour grant binds
        // an exact digest, contract version, revision and capability set. Neither can be
        // shown on a toast, so neither may be answered from one. This is the test that
        // keeps that a property of the code rather than of whoever edits it next.
        foreach (var notification in Every)
        {
            var xml = DesktopNotificationContent.ToXml(notification);
            foreach (var forbidden in new[] { "approve", "accept", "promote", "grant" })
            {
                Assert.IsFalse(
                    xml.Contains($"arguments=\"{forbidden}", StringComparison.OrdinalIgnoreCase),
                    $"{notification.Tag} carries a {forbidden} argument.");
            }
            Assert.IsTrue(
                notification.Route is DesktopNotificationContent.RouteOpen
                    or DesktopNotificationContent.RouteAgent
                    or DesktopNotificationContent.RouteHealth,
                $"{notification.Tag} routes outside the closed set.");
        }
    }

    [TestMethod]
    public void NothingPrivilegedTravelsOnANotification()
    {
        var notifications = new[]
        {
            DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 2),
            DesktopNotificationContent.ApprovalNeeded("Ideas.nendo", true, false, true),
            DesktopNotificationContent.FileUnwritable("Ideas.nendo", "recoveryRequired"),
        };
        foreach (var notification in notifications)
        {
            var xml = DesktopNotificationContent.ToXml(notification);
            // A path, a digest or a session id on a notification would be handed to the
            // Windows notification store, which is outside anything Nendo controls.
            Assert.IsFalse(xml.Contains(":\\", StringComparison.Ordinal));
            Assert.IsFalse(xml.Contains("file-session-", StringComparison.Ordinal));
            Assert.IsFalse(xml.Contains("proposal-", StringComparison.Ordinal));
            Assert.AreEqual($"route={notification.Route}", ArgumentOf(xml));
        }
    }

    [TestMethod]
    public void EveryPayloadIsWellFormedAndNamesTheFile()
    {
        foreach (var notification in Every)
        {
            var document = XDocument.Parse(DesktopNotificationContent.ToXml(notification));
            var texts = document.Descendants("text").Select(element => element.Value).ToArray();
            Assert.HasCount(2, texts, notification.Tag);
            Assert.AreEqual(notification.Title, texts[0]);
            Assert.AreEqual(notification.Body, texts[1]);
            Assert.Contains("Ideas.nendo", texts[1], notification.Tag);
            var actions = document.Descendants("action").ToArray();
            Assert.HasCount(notification.ButtonLabel is null ? 0 : 1, actions, notification.Tag);
        }
    }

    [TestMethod]
    public void AFileNameWithMarkupInItCannotBreakThePayload()
    {
        var notification = DesktopNotificationContent.ProposalWaiting("<a & b>\"c\".nendo", 1);
        var document = XDocument.Parse(DesktopNotificationContent.ToXml(notification));
        var body = document.Descendants("text").Last().Value;
        Assert.Contains("<a & b>\"c\".nendo", body);
    }

    [TestMethod]
    public void WithNoFileOpenTheNotificationStillReads()
    {
        var notification = DesktopNotificationContent.TrayIntro(null);
        Assert.StartsWith("Your file", notification.Body);
        Assert.IsTrue(XDocument.Parse(DesktopNotificationContent.ToXml(notification)).Descendants("text").Any());
    }

    [TestMethod]
    [DataRow(true, true, true, "create, update and delete records")]
    [DataRow(true, false, true, "create and delete records")]
    [DataRow(false, false, true, "delete records")]
    [DataRow(false, false, false, "change records")]
    public void ConsentNamesWhatItCovers(bool creates, bool updates, bool deletes, string expected)
    {
        var notification = DesktopNotificationContent.ApprovalNeeded("Ideas.nendo", creates, updates, deletes);
        Assert.Contains(expected, notification.Body);
    }

    [TestMethod]
    public void OneChangeAndSeveralChangesAreSaidDifferently()
    {
        Assert.Contains("A change is waiting", DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 1).Title);
        Assert.Contains("3 changes are waiting", DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 3).Title);
    }

    [TestMethod]
    [DataRow("readOnly", "read-only")]
    [DataRow("recoveryRequired", "in recovery")]
    [DataRow("rejected", "refused by this host")]
    [DataRow("closed", "no longer writable")]
    public void EachUnwritableStateIsNamedInOwnerWords(string health, string expected)
    {
        Assert.Contains(expected, DesktopNotificationContent.FileUnwritable("Ideas.nendo", health).Body);
    }

    [TestMethod]
    [DataRow("route=agent", DesktopNotificationContent.RouteAgent)]
    [DataRow("route=health", DesktopNotificationContent.RouteHealth)]
    [DataRow("route=open", DesktopNotificationContent.RouteOpen)]
    public void AKnownRouteComesBack(string argument, string expected)
    {
        Assert.AreEqual(expected, DesktopNotificationContent.RouteFrom(argument));
    }

    [TestMethod]
    [DataRow("")]
    [DataRow("route=data")]
    [DataRow("route=")]
    [DataRow("promote=1")]
    [DataRow("anything at all")]
    public void AnUnknownArgumentRoutesNowhere(string argument)
    {
        Assert.IsNull(DesktopNotificationContent.RouteFrom(argument));
    }

    /// <summary>
    /// W-089. Every Nendo process posted under one "nendo" group with the same tags, so a
    /// second file's "A change is waiting" replaced the first file's, and bringing back any
    /// window cleared every file's notifications.
    /// </summary>
    [TestMethod]
    public void EachProcessPostsUnderAGroupOfItsOwn()
    {
        Assert.AreNotEqual(DesktopNotificationContent.GroupFor(4242), DesktopNotificationContent.GroupFor(4343),
            "Two files open in two processes must not share a group.");
        Assert.AreEqual(DesktopNotificationContent.GroupFor(Environment.ProcessId), DesktopNotificationContent.Group);
        Assert.IsLessThanOrEqualTo(16, DesktopNotificationContent.GroupFor(int.MaxValue).Length,
            "A group Windows would refuse is a notification nobody sees.");
    }

    /// <summary>
    /// W-089. Windows hands a click to whichever Nendo holds the activation, so the click says
    /// which process raised it, and nothing more: no path, no file session, no proposal.
    /// </summary>
    [TestMethod]
    public void AClickSaysWhichWindowRaisedItAndStillOnlyWhichView()
    {
        var notification = DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 1);
        var xml = DesktopNotificationContent.ToXml(notification, 4242);
        var argument = ArgumentOf(xml);
        Assert.AreEqual("route=agent&window=4242", argument);
        Assert.AreEqual(DesktopNotificationContent.RouteAgent, DesktopNotificationContent.RouteFrom(argument));
        Assert.AreEqual(4242, DesktopNotificationContent.WindowFrom(argument));
        var action = XDocument.Parse(xml).Descendants("action").Single().Attribute("arguments")!.Value;
        Assert.AreEqual(argument, action, "The button says the same as the body.");
        Assert.IsNull(DesktopNotificationContent.WindowFrom("route=agent"));
        Assert.IsNull(DesktopNotificationContent.WindowFrom("route=agent&window=-1"));
        Assert.IsNull(DesktopNotificationContent.WindowFrom("route=agent&window=abc"));
    }

    /// <summary>
    /// W-089. Every notification carried the same picture whichever file it was about. It now
    /// shows the file's icon from this device's icon cache, a picture of the look and nothing
    /// about the file itself.
    /// </summary>
    [TestMethod]
    public void ANotificationShowsTheFilesIconAndNothingAboutWhereTheFileIs()
    {
        var notification = DesktopNotificationContent.ProposalWaiting("Ideas.nendo", 1);
        var logo = @"C:\Users\someone\AppData\Local\Nendo\icons\file-v1-violet-50-96.png";
        var document = XDocument.Parse(DesktopNotificationContent.ToXml(notification, 4242, logo));
        var image = document.Descendants("image").Single();
        Assert.AreEqual("appLogoOverride", image.Attribute("placement")!.Value);
        Assert.AreEqual("file:///C:/Users/someone/AppData/Local/Nendo/icons/file-v1-violet-50-96.png", image.Attribute("src")!.Value);
        Assert.HasCount(2, document.Descendants("text"), "The picture is an addition, not a third line.");
        Assert.IsFalse(DesktopNotificationContent.ToXml(notification, 4242, "relative/icon.png").Contains("<image", StringComparison.Ordinal),
            "Only a picture this device drew, at a full path, is shown.");
        Assert.IsFalse(DesktopNotificationContent.ToXml(notification).Contains("<image", StringComparison.Ordinal));
    }

    [TestMethod]
    public void EveryNotificationHasItsOwnTagSoARepeatReplacesRatherThanStacks()
    {
        var tags = Every.Select(notification => notification.Tag).Distinct().ToArray();
        Assert.HasCount(5, tags, "Only the two proposal counts should share a tag.");
    }

    private static string ArgumentOf(string xml) =>
        XDocument.Parse(xml).Root!.Attribute("launch")!.Value;
}
