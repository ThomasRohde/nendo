using Nendo.Desktop;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The parts of the Windows shell integrations that are decisions rather than calls
/// (W-048): what the command line means, which recent files the taskbar menu offers,
/// and what the open file's state is worth badging. The calls themselves — Explorer
/// drawing an overlay, Windows populating a Jump List — are the owner's to report.
/// </summary>
[TestClass]
public sealed class DesktopStartupArgumentTests
{
    [TestMethod]
    public void ADoubleClickPassesThePathAsTheFirstArgument()
    {
        var request = DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", @"C:\files\Work.nendo"]);
        Assert.IsNotNull(request);
        Assert.AreEqual(DesktopStartupMode.Open, request.Mode);
        Assert.AreEqual(@"C:\files\Work.nendo", request.Path);
    }

    [TestMethod]
    public void TheExplorerNewMenuAsksForAFileToBeMade()
    {
        var request = DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "-new", @"C:\files\Untitled.nendo"]);
        Assert.IsNotNull(request);
        Assert.AreEqual(DesktopStartupMode.CreateFromShell, request.Mode);
        Assert.AreEqual(@"C:\files\Untitled.nendo", request.Path);
    }

    [TestMethod]
    public void TheNewSwitchIsAcceptedInEitherFormAndEitherCase()
    {
        foreach (var switchText in new[] { "-new", "/new", "-NEW", "/New" })
        {
            var request = DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", switchText, @"C:\files\Untitled.nendo"]);
            Assert.AreEqual(DesktopStartupMode.CreateFromShell, request?.Mode, switchText);
        }
    }

    [TestMethod]
    public void ASwitchThatIsNotNewLeavesTheLaunchOpeningRatherThanCreating()
    {
        // The defect this exists for: a flag nobody recognised quietly turning a
        // double-click into a create, which over an existing file is data loss.
        var request = DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "--verbose", @"C:\files\Work.nendo"]);
        Assert.AreEqual(DesktopStartupMode.Open, request?.Mode);
    }

    [TestMethod]
    public void ASwitchAfterTheNewSwitchTakesTheNewIntentionBackAgain()
    {
        var request = DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "-new", "-x", @"C:\files\Work.nendo"]);
        Assert.AreEqual(DesktopStartupMode.Open, request?.Mode);
    }

    [TestMethod]
    public void ALaunchWithNoPathOpensNothingRatherThanFailing()
    {
        Assert.IsNull(DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe"]));
        Assert.IsNull(DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "-new"]));
        Assert.IsNull(DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "   "]));
    }

    [TestMethod]
    public void APathWindowsCannotResolveOpensAnEmptyWindow()
    {
        Assert.IsNull(DesktopStartupRequest.FromArguments(["Nendo.Desktop.exe", "C:\\files\\bad\0name.nendo"]));
    }
}

/// <summary>
/// The host half of a dropped file.
/// <para>
/// This is the only place it can be measured. The page cannot reach it: WebView2
/// refuses to carry a <c>File</c> the page made up — "additional File object is not a
/// file on the disk" — so a request for <c>file.openDropped</c> that names no real
/// file never leaves the browser. The refusal below is the guard behind that one, and
/// a test is the only thing that can see it fail.
/// </para>
/// </summary>
[TestClass]
public sealed class WorkbenchDroppedFileTests
{
    [TestMethod]
    public async Task ARequestToOpenADroppedFileWithNoFileAttachedIsRefused()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(
            new Nendo.LocalMcp.NendoLocalMcpHostOptions(
                Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "drop-discovery")),
            workspace.FileHistoryRoot);
        var opened = 0;
        var handler = new WorkbenchProtocolHandler(
            session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath),
            _ => { },
            request =>
            {
                if (request.Action == WorkbenchFileAction.OpenDropped) opened++;
                return Task.FromResult(new DesktopFileActionView(null, null));
            });
        // Created through the session rather than the protocol: the request under test
        // needs a live file generation, and how a file gets made is not what this is about.
        await session.CreateAsync(workspace.FilePath);
        var fileSessionId = (await session.GetViewAsync()).FileSessionId;

        var response = await handler.HandleAsync(
            Request("drop-nothing", WorkbenchMethods.FileOpenDropped, fileSessionId));

        Assert.IsFalse(response.Ok, "A request naming no file was treated as a file to open.");
        StringAssert.Contains(response.Error!.Message, "No file arrived");
        Assert.AreEqual(0, opened, "The host started a file action for a file that never arrived.");
    }

    private static string Request(string requestId, string method, string? fileSessionId = null) =>
        System.Text.Json.JsonSerializer.Serialize(new
        {
            protocolVersion = 7,
            requestId,
            method,
            fileSessionId,
            payload = new { },
        });
}

[TestClass]
public sealed class DesktopShellIdentityTests
{
    [TestMethod]
    public void WithoutAPinTheProcessUsesTheProductIdentity()
    {
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveAppUserModelId(_ => null));
        Assert.IsNull(DesktopRuntimeConfiguration.ResolveAppUserModelId(_ => "   "));
    }

    [TestMethod]
    public void APinnedIdentityIsUsedAsGiven()
    {
        Assert.AreEqual("Nendo.Lane.abc", DesktopRuntimeConfiguration.ResolveAppUserModelId(_ => "Nendo.Lane.abc"));
    }

    [TestMethod]
    public void AnIdentityWindowsWouldRefuseIsRefusedHereInstead()
    {
        // Silently running under a different identity from the one somebody asked for
        // is the failure mode: the Jump List then lands in a file nobody is reading.
        foreach (var bad in new[] { new string('x', 129), @"Nendo\Desktop", " Nendo.Desktop" })
        {
            Assert.ThrowsExactly<NendoValidationException>(
                () => DesktopRuntimeConfiguration.ResolveAppUserModelId(_ => bad), bad);
        }
    }

    [TestMethod]
    public void AnIdentityWindowsWouldRefuseFallsBackRatherThanEndingTheLaunch()
    {
        // The resolution runs while the first window is being built, so throwing here
        // is a process that exits before drawing anything — which is what it did.
        // Falling back is safe because the lane asserts the window carries the identity
        // it asked for, so a silent fallback fails there instead of here.
        Assert.AreEqual(DesktopShellIdentity.DefaultAppUserModelId,
            DesktopShellIdentity.ResolveFrom(_ => " Nendo.Desktop"));
        Assert.AreEqual(DesktopShellIdentity.DefaultAppUserModelId,
            DesktopShellIdentity.ResolveFrom(_ => null));
        Assert.AreEqual("Nendo.Lane.abc", DesktopShellIdentity.ResolveFrom(_ => "Nendo.Lane.abc"));
    }

    // The product identity is a compile-time constant, so comparing it to a literal
    // here would assert nothing. What matters about it is that the setup script
    // registers the same string, and that is checked across the two files by
    // Test-Repository.ps1, which can read both.
}

[TestClass]
public sealed class DesktopJumpListPlanTests
{
    private static DesktopShellRecentFile File(string path, int daysAgo = 0) =>
        new(path, System.IO.Path.GetFileName(path), DateTimeOffset.UtcNow.AddDays(-daysAgo));

    [TestMethod]
    public void TheMenuOffersTheNewestFirst()
    {
        var plan = DesktopJumpList.Plan(
            [File(@"C:\a\Old.nendo", 9), File(@"C:\a\New.nendo", 1), File(@"C:\a\Middle.nendo", 4)], [], 10);
        CollectionAssert.AreEqual(new[] { "New.nendo", "Middle.nendo", "Old.nendo" }, plan.Select(entry => entry.Title).ToArray());
    }

    [TestMethod]
    public void TheShellsSlotCountIsWhatTheMenuHasRoomFor()
    {
        var files = Enumerable.Range(0, 12).Select(index => File($@"C:\a\File{index}.nendo", index)).ToArray();
        Assert.HasCount(4, DesktopJumpList.Plan(files, [], 4));
        // And the shell may say it has room for more than is worth offering.
        Assert.HasCount(10, DesktopJumpList.Plan(files, [], 40));
        Assert.IsEmpty(DesktopJumpList.Plan(files, [], 0));
        Assert.IsEmpty(DesktopJumpList.Plan(files, [], -1));
    }

    [TestMethod]
    public void AFileThePersonRemovedFromTheMenuStaysRemoved()
    {
        // Not politeness: re-adding a removed destination makes CommitList fail, and
        // the whole menu is then lost rather than one row.
        var plan = DesktopJumpList.Plan(
            [File(@"C:\a\Kept.nendo"), File(@"C:\a\Gone.nendo")], [@"c:\A\GONE.NENDO"], 10);
        CollectionAssert.AreEqual(new[] { "Kept.nendo" }, plan.Select(entry => entry.Title).ToArray());
    }

    [TestMethod]
    public void TwoFilesWithOneNameAreToldApartByTheirFolder()
    {
        var plan = DesktopJumpList.Plan(
            [File(@"C:\work\Plan.nendo", 1), File(@"C:\backups\Plan.nendo", 2), File(@"C:\work\Other.nendo", 3)], [], 10);
        CollectionAssert.AreEqual(
            new[] { "Plan.nendo — work", "Plan.nendo — backups", "Other.nendo" },
            plan.Select(entry => entry.Title).ToArray());
    }

    [TestMethod]
    public void TheSameFileTwiceIsOneRow()
    {
        var plan = DesktopJumpList.Plan([File(@"C:\a\Work.nendo", 1), File(@"C:\a\Work.nendo", 3)], [], 10);
        Assert.HasCount(1, plan);
        Assert.AreEqual("Work.nendo", plan[0].Title);
    }

    [TestMethod]
    public void EveryRowCarriesThePathItWillOpen()
    {
        var plan = DesktopJumpList.Plan([File(@"C:\a\Work.nendo")], [], 10);
        Assert.AreEqual(@"C:\a\Work.nendo", plan[0].Path);
    }
}

[TestClass]
public sealed class DesktopShellBadgeTests
{
    private static DesktopShellState State(string health = "healthy", bool requiresApproval = false, bool isApproved = true) =>
        new("Work.nendo", health, requiresApproval, isApproved, false, false, false, "Off", false);

    [TestMethod]
    public void AHealthyFileWearsNoBadge()
    {
        var badge = DesktopShellBadge.For(State());
        Assert.AreEqual(DesktopShellBadgeKind.None, badge.Kind);
        Assert.IsNull(badge.Reason);
        Assert.AreEqual("Nendo — Work.nendo", badge.Tooltip("Work.nendo"));
    }

    [TestMethod]
    public void OutstandingApprovalIsSomethingWaitingForThePerson()
    {
        var badge = DesktopShellBadge.For(State(requiresApproval: true, isApproved: false));
        Assert.AreEqual(DesktopShellBadgeKind.Attention, badge.Kind);
        Assert.AreEqual("Approval needed", badge.Reason);
        Assert.AreEqual("Nendo — Work.nendo (approval needed)", badge.Tooltip("Work.nendo"));
    }

    [TestMethod]
    public void AFileNeedingRecoveryIsTheSameKindOfBadgeWithItsOwnWords()
    {
        var badge = DesktopShellBadge.For(State("recoveryRequired"));
        Assert.AreEqual(DesktopShellBadgeKind.Attention, badge.Kind);
        Assert.AreEqual("Recovery needed", badge.Reason);
    }

    [TestMethod]
    public void AReadOnlyFileWearsTheLockRatherThanAnAlarm()
    {
        var badge = DesktopShellBadge.For(State("readOnly"));
        Assert.AreEqual(DesktopShellBadgeKind.ReadOnly, badge.Kind);
        Assert.AreEqual("Nendo — Work.nendo (read-only)", badge.Tooltip("Work.nendo"));
    }

    [TestMethod]
    public void ApprovalOutranksEverythingElseAboutTheFile()
    {
        // Read-only and approval-needed can both be true. The person can do something
        // about one of them, so that is the one the button says.
        var badge = DesktopShellBadge.For(State("readOnly", requiresApproval: true, isApproved: false));
        Assert.AreEqual("Approval needed", badge.Reason);
    }

    [TestMethod]
    public void WithNoFileOpenTheTooltipIsJustTheProduct()
    {
        Assert.AreEqual("Nendo", DesktopShellBadge.For(DesktopShellState.None).Tooltip(null));
    }
}
