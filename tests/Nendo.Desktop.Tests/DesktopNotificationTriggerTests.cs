namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopNotificationTriggerTests
{
    private static DesktopShellState State(
        string health = "normal",
        bool requiresApproval = false,
        bool isApproved = true) =>
        new("Ideas.nendo", health, requiresApproval, isApproved, true, true, false, "Application authoring", true);

    [TestMethod]
    public void AFileThatOpensReadOnlyIsNotAnnouncedAsHavingBecomeReadOnly()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State(health: "readOnly")));
        Assert.IsNull(trigger.Observe(State(health: "readOnly")));
    }

    [TestMethod]
    public void BecomingReadOnlyIsAnnouncedOnce()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        var notification = trigger.Observe(State(health: "readOnly"));
        Assert.IsNotNull(notification);
        Assert.AreEqual(DesktopNotificationContent.TagUnwritable, notification.Tag);
        Assert.IsNull(trigger.Observe(State(health: "readOnly")), "The same state is not a new event.");
    }

    [TestMethod]
    public void RecoveringAndFailingAgainIsAnnouncedAgain()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.Observe(State(health: "recoveryRequired")));
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.Observe(State(health: "recoveryRequired")));
    }

    [TestMethod]
    public void ConsentBecomingOutstandingIsAnnouncedOnce()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        var notification = trigger.Observe(State(requiresApproval: true, isApproved: false));
        Assert.IsNotNull(notification);
        Assert.AreEqual(DesktopNotificationContent.TagApproval, notification.Tag);
        Assert.IsTrue(trigger.ApprovalOutstanding);
        Assert.IsNull(trigger.Observe(State(requiresApproval: true, isApproved: false)));
    }

    [TestMethod]
    public void ApprovingAndThenNeedingConsentAgainIsAnnouncedAgain()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.Observe(State(requiresApproval: true, isApproved: false)));
        Assert.IsNull(trigger.Observe(State(requiresApproval: true, isApproved: true)));
        Assert.IsFalse(trigger.ApprovalOutstanding);
        Assert.IsNotNull(trigger.Observe(State(requiresApproval: true, isApproved: false)));
    }

    [TestMethod]
    public void AFileThatCannotBeWrittenIsSaidBeforeConsent()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        var notification = trigger.Observe(State(health: "readOnly", requiresApproval: true, isApproved: false));
        Assert.IsNotNull(notification);
        Assert.AreEqual(
            DesktopNotificationContent.TagUnwritable,
            notification.Tag,
            "Approving consent would not make a read-only file editable, so it is the wrong thing to ask for first.");
    }

    [TestMethod]
    public void WalkingAwayFromAnOutstandingApprovalIsSaidOnce()
    {
        var trigger = new DesktopNotificationTrigger();
        var state = State(requiresApproval: true, isApproved: false);
        Assert.IsNotNull(trigger.OnHidden(state));
        Assert.IsNull(trigger.OnHidden(state), "Hiding twice is not two approvals.");
    }

    [TestMethod]
    public void WalkingAwayFromAFileThatNeedsNothingSaysNothing()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.OnHidden(State()));
        Assert.IsNull(trigger.OnHidden(State(requiresApproval: true, isApproved: true)));
    }

    [TestMethod]
    public void LosingWriteAuthorityIsSaidOnceAndNotRepeatedByAReading()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.OnWriteAuthorityLost("Ideas.nendo"));
        Assert.IsNull(trigger.OnWriteAuthorityLost("Ideas.nendo"));
        Assert.IsNull(
            trigger.Observe(State(health: "recoveryRequired")),
            "The reading that follows the push is the same event.");
    }

    [TestMethod]
    public void TheWorkspaceFailingIsSaidOncePerFailure()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNotNull(trigger.OnRendererFailed("Ideas.nendo"));
        Assert.IsNull(trigger.OnRendererFailed("Ideas.nendo"));
        trigger.OnRendererStarted();
        Assert.IsNotNull(trigger.OnRendererFailed("Ideas.nendo"));
    }

    [TestMethod]
    public void ClosingTheFileForgetsEverythingSoTheNextOneStartsClean()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.Observe(State(health: "readOnly")));
        Assert.IsNull(trigger.Observe(DesktopShellState.None));
        Assert.IsFalse(trigger.ApprovalOutstanding);
        Assert.IsNull(
            trigger.Observe(State(health: "readOnly")),
            "A newly opened read-only file has not just become read-only.");
    }

    [TestMethod]
    public void ResetForgetsAnOutstandingApproval()
    {
        var trigger = new DesktopNotificationTrigger();
        Assert.IsNull(trigger.Observe(State()));
        Assert.IsNotNull(trigger.Observe(State(requiresApproval: true, isApproved: false)));
        trigger.Reset();
        Assert.IsFalse(trigger.ApprovalOutstanding);
    }
}
