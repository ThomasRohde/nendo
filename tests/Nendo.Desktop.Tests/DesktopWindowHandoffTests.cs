using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Opening a file another Nendo window had open for editing started a second process
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
    [DataRow("show", true, null, null)]
    [DataRow("show:agent", true, DesktopNotificationContent.RouteAgent, null)]
    [DataRow("show:health", true, DesktopNotificationContent.RouteHealth, null)]
    [DataRow("show:open", true, DesktopNotificationContent.RouteOpen, null)]
    [DataRow("show:agent:3", true, DesktopNotificationContent.RouteAgent, 3)]
    [DataRow("show:agent:0", false, null, null)]
    [DataRow("show:agent:x", false, null, null)]
    [DataRow("show:agent:3:4", false, null, null)]
    [DataRow("show:data", false, null, null)]
    [DataRow("show:data:3", false, null, null)]
    [DataRow("show:", false, null, null)]
    [DataRow("promote", false, null, null)]
    [DataRow("", false, null, null)]
    public void ARequestNamesTheWindowAndAtMostAViewANotificationCouldName(string text, bool accepted, string? route, int? generation)
    {
        Assert.AreEqual(accepted, DesktopWindowHandoff.TryParse(text, out var parsed, out var raisedIn), text);
        Assert.AreEqual(route, parsed, text);
        Assert.AreEqual(generation, raisedIn, text);
        if (accepted) Assert.AreEqual(text, DesktopWindowHandoff.Request(parsed, raisedIn));
    }

    [TestMethod]
    public void OnlyAMessageCarryingOurSignatureIsRead()
    {
        Assert.IsTrue(Read(DesktopWindowHandoff.Signature, "show:agent", out var route));
        Assert.AreEqual(DesktopNotificationContent.RouteAgent, route);
        Assert.IsFalse(Read(0x1234, "show:agent", out _), "Another program's WM_COPYDATA is not a request.");
        Assert.IsFalse(Read(DesktopWindowHandoff.Signature, new string('x', 400), out _), "An oversized payload is refused unread.");
        Assert.IsFalse(DesktopWindowHandoff.TryRead(IntPtr.Zero, out _, out _));
    }

    [TestMethod]
    public void ThisProcessIsNeverAskedToShowItself() =>
        Assert.IsFalse(DesktopWindowHandoff.TryShow(Environment.ProcessId));

    /// <summary>
    /// A launch hands a file another Nendo holds to that window through the sidecar
    /// naming it, which an open writes just after taking the instance's guard, once it has
    /// inspected the file. A second launch inside that window -- a double-click repeated while
    /// nothing showed yet -- found no owner, then met the guard, and ended beside the healthy
    /// window on a refusal. It now looks briefly for the owner to say who it is and hands over.
    /// </summary>
    [TestMethod]
    public async Task ASecondLaunchWhileTheFirstIsStillOpeningHandsTheFileOver()
    {
        await using var workspace = new DesktopTestWorkspace();
        string instanceId;
        await using (var creator = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "creator")))
        {
            instanceId = (await creator.CreateAsync(workspace.FilePath)).Manifest!.InstanceId;
        }
        await using var second = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "second"));
        var assessment = await second.AssessOpenAsync(workspace.FilePath);
        Assert.AreEqual(workspace.FilePath, assessment.FilePath);

        // The first launch has taken the instance's guard and not yet written the sidecar.
        using var guard = new EventWaitHandle(false, EventResetMode.ManualReset, InstanceLeaseName(instanceId), out var created);
        Assert.IsTrue(created, "The instance was already held.");
        var sidecar = workspace.FilePath + ".write-owner";
        var shown = new List<int>();
        try
        {
            var handOff = DesktopStartupOpen.OpenOrHandOffAsync(
                () => second.OpenAssessedAsync(assessment.AssessmentId, readOnly: false),
                assessment.FilePath,
                ownerOf: path => DesktopWindowHandoff.OwnerOf(path, _ => true, self: 1),
                show: processId => { lock (shown) shown.Add(processId); return true; });
            await Task.WhenAny(handOff, Task.Delay(100));
            Assert.IsFalse(handOff.IsCompleted,
                $"The second launch gave up before the first had said who holds the file: {handOff.Exception?.InnerException?.Message}");
            // The first launch's next step: the sidecar naming its window.
            await File.WriteAllTextAsync(sidecar, "{\"ownerId\":\"first\",\"processId\":4242}");
            Assert.IsTrue(await handOff, "The second launch did not hand the file to the window that opened it.");
        }
        finally { File.Delete(sidecar); }
        CollectionAssert.AreEqual(new[] { 4242 }, shown);
        Assert.IsFalse(second.HasFile, "The second launch opened the file as well.");
    }

    /// <summary>
    /// A refusal that names nobody -- a folder Nendo may not write in, a
    /// guard it cannot make -- is offered read-only at once: no owner is looked for.
    /// </summary>
    [TestMethod]
    [DataRow("write-ownership-denied")]
    [DataRow("instance-guard-unavailable")]
    public async Task ARefusalThatNamesNobodyIsNotWaitedOn(string code)
    {
        var looked = 0;
        var refusal = new NendoWriteOwnershipException("refused", code);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var thrown = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => DesktopStartupOpen.OpenOrHandOffAsync(
            () => throw refusal, @"C:\nowhere\file.nendo",
            ownerOf: _ => { Interlocked.Increment(ref looked); return null; },
            show: _ => true, patience: TimeSpan.FromSeconds(30)));
        Assert.AreSame(refusal, thrown);
        Assert.AreEqual(0, looked, $"A {code} refusal looked for an owner before the read-only offer.");
        Assert.IsLessThan(1_000, clock.ElapsedMilliseconds, $"A {code} refusal waited before the read-only offer.");
    }

    /// <summary>
    /// A copy of a file another window has open is refused on its instance,
    /// and no sidecar ever appears beside the copy: the launch looks only as long as an owner takes
    /// to write one, not the ten seconds it first waited. A wait the window ends ends with it.
    /// </summary>
    [TestMethod]
    public async Task ACopyOfAnOpenFileIsOfferedReadOnlyWithoutALongWait()
    {
        await using var workspace = new DesktopTestWorkspace();
        var copy = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "copy.nendo");
        await using (var creator = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "creator")))
        {
            await creator.CreateAsync(workspace.FilePath);
        }
        File.Copy(workspace.FilePath, copy);
        await using var holder = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "holder"));
        await using var second = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "second"));
        await holder.OpenAsync(workspace.FilePath);
        var assessment = await second.AssessOpenAsync(copy);
        var shown = 0;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var refused = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => DesktopStartupOpen.OpenOrHandOffAsync(
            () => second.OpenAssessedAsync(assessment.AssessmentId, readOnly: false),
            assessment.FilePath,
            ownerOf: path => DesktopWindowHandoff.OwnerOf(path, _ => true, self: 1),
            show: _ => { Interlocked.Increment(ref shown); return true; }));
        Assert.AreEqual("instance-in-use", refused.Code);
        Assert.AreEqual(0, shown);
        Assert.IsLessThan(3_000, clock.ElapsedMilliseconds,
            $"A copy of an open file waited {clock.ElapsedMilliseconds} ms before the read-only offer.");

        using var leaving = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        clock.Restart();
        await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => DesktopStartupOpen.OpenOrHandOffAsync(
            () => throw new NendoWriteOwnershipException("refused", "instance-in-use"), copy,
            ownerOf: _ => null, show: _ => true, patience: TimeSpan.FromSeconds(30), cancellationToken: leaving.Token));
        Assert.IsLessThan(3_000, clock.ElapsedMilliseconds, "The wait outlived the window that asked for it.");
    }

    /// <summary>
    /// An owner that has said who it is and does not answer is not waited for: the
    /// refusal goes to the read-only offer, as it did, without the wait an owner still opening gets.
    /// </summary>
    [TestMethod]
    public async Task AnOwnerThatDoesNotAnswerIsNotWaitedFor()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var holder = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "holder"));
        await using var second = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "second"));
        await holder.CreateAsync(workspace.FilePath);
        var assessment = await second.AssessOpenAsync(workspace.FilePath);
        var asked = 0;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => DesktopStartupOpen.OpenOrHandOffAsync(
            () => second.OpenAssessedAsync(assessment.AssessmentId, readOnly: false),
            assessment.FilePath,
            ownerOf: path => DesktopWindowHandoff.OwnerOf(path, _ => true, self: 1),
            show: _ => { Interlocked.Increment(ref asked); return false; },
            patience: TimeSpan.FromSeconds(30)));
        Assert.AreEqual(1, asked);
        Assert.IsLessThan(10_000, clock.ElapsedMilliseconds, "A silent owner was waited for.");
        Assert.IsFalse(await DesktopStartupOpen.OpenOrHandOffAsync(() => Task.CompletedTask, workspace.FilePath),
            "An open that was not refused hands nothing over.");
    }

    /// <summary>The name the Engine gives an instance's lease, as InstanceOwnershipLease forms it.</summary>
    private static string InstanceLeaseName(string instanceId)
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        return $"Global\\Nendo.Instance.v1.{Digest(identity.User!.Value)}.{Digest(instanceId)}";
    }

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
            return DesktopWindowHandoff.TryRead(structure, out route, out _);
        }
        finally
        {
            Marshal.FreeHGlobal(structure);
            Marshal.FreeHGlobal(buffer);
        }
    }
}
