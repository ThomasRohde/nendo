using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// What the session does for the window's file actions, held through the controller the
/// window drives — the open a launch asks for, opening another file while one is open, the
/// recovery panel's reads, the fold's backup and the recent list.
/// </summary>
[TestClass]
public sealed class DesktopSessionFollowTests
{
    /// <summary>
    /// A launch's open called the plain open, which refused a synced folder or a known
    /// copy outright, and the window showed one fixed sentence. It now assesses first, and an
    /// assessment that needs the person goes to the questions a picked file meets.
    /// </summary>
    [TestMethod]
    public async Task ALaunchsOpenAsksWhereAPickedFileWouldAndSaysWhatRefusedIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;

        await using (var plain = Session(workspace, []))
        {
            Assert.IsFalse(DesktopStartupOpen.NeedsAQuestion(await plain.AssessOpenAsync(workspace.FilePath)),
                "A file with nothing to ask about asked anyway.");
        }

        await using (var synced = Session(workspace, [folder]))
        {
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => synced.OpenAsync(workspace.FilePath));
            Assert.AreEqual(synced.InspectDestinationLocation(workspace.FilePath)!.Message, DesktopRecoveryPresentation.FailureMessage(refused),
                "The refusal's own words were replaced by a fixed sentence.");
            var assessment = await synced.AssessOpenAsync(workspace.FilePath);
            Assert.IsTrue(DesktopStartupOpen.NeedsAQuestion(assessment), "A file in a synced folder opened, or was refused, without the question.");
            Assert.IsFalse(synced.HasFile);
        }

        // A copy of a file this device has opened for editing: the collision question.
        var copy = Path.Combine(folder, "copy.nendo");
        File.Copy(workspace.FilePath, copy);
        await using (var known = Session(workspace, []))
        {
            var collision = await known.AssessOpenAsync(copy);
            Assert.IsTrue(collision.KnownInstanceCollision);
            Assert.IsTrue(DesktopStartupOpen.NeedsAQuestion(collision), "A known copy opened without the collision question.");
        }
    }

    /// <summary>
    /// A launch of a file Nendo opens only read-only — marked read-only here; needing
    /// recovery or an upgrade alike — does not end on the recovery panel with no file open. The
    /// launch assesses first, and a file that can be read but not written goes to the question
    /// offering Inspect read-only, with the inspection's own reason.
    /// </summary>
    [TestMethod]
    public async Task ALaunchOfAFileThatOpensOnlyReadOnlyOffersToInspectIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) | FileAttributes.ReadOnly);
        try
        {
            await using var session = Session(workspace, []);
            var assessment = await session.AssessOpenAsync(workspace.FilePath);
            Assert.IsTrue(assessment.Inspection.Capabilities.ReadData, "The file cannot be inspected at all.");
            Assert.IsFalse(assessment.Inspection.CanAcquireWriteAuthority);
            Assert.IsTrue(DesktopStartupOpen.NeedsAQuestion(assessment), "A launch tried to open for editing a file that opens only read-only.");
            Assert.AreEqual("file-read-only", assessment.Inspection.Findings.Single().Code);
            var view = await session.OpenReadOnlyAsync(workspace.FilePath);
            Assert.AreEqual("readOnly", view.Health);
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
        }
    }

    /// <summary>
    /// Opening another file closed this one before the new one was assessed, so a Cancel
    /// or a refusal left nothing open and the proposals discarded; and the open file chosen again
    /// was closed and reopened.
    /// </summary>
    [TestMethod]
    public async Task AnotherFileIsAssessedBeforeTheOpenOneClosesAndTheOpenOneIsNotReopened()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var other = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "other.nendo");
        await using (var seed = Session(workspace, []))
        {
            await seed.CreateAsync(other);
        }

        await using var session = Session(workspace, []);
        var opened = await session.OpenAsync(workspace.FilePath);
        var assessment = await session.AssessOpenAsync(other);
        Assert.IsTrue(session.HasFile, "Assessing another file closed this one.");
        Assert.AreEqual(opened.FileSessionId, session.CurrentFileSessionId, "Assessing another file changed this one's session.");

        // The person cancels: nothing changes.
        Assert.IsTrue(session.IsOpenFile(workspace.FilePath));
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.OpenAssessedAsync(assessment.AssessmentId, false));
        Assert.AreEqual("file-already-open", refused.Code, "An open without the person's consent closed the open file.");
        Assert.IsTrue(session.IsOpenFile(workspace.FilePath));

        // The same file again is not a reason to close it.
        Assert.IsTrue(session.IsOpenFile(workspace.FilePath.ToUpperInvariant()));
        var same = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.AssessOpenAsync(workspace.FilePath));
        Assert.AreEqual("file-already-open", same.Code);
        Assert.AreEqual("This file is already open in this window.", same.Message);

        // The person answers Open: the open file closes and the other opens, in one step.
        var replaced = await session.OpenAssessedAsync(assessment.AssessmentId, false, replaceCurrent: true);
        Assert.AreEqual("other.nendo", replaced.FileName);
        Assert.IsTrue(session.IsOpenFile(other));
        Assert.IsFalse(session.IsOpenFile(workspace.FilePath));
        Assert.AreNotEqual(opened.FileSessionId, replaced.FileSessionId);
    }

    /// <summary>A copy assessed while its original is open meets the collision, from the open file's own observation.</summary>
    [TestMethod]
    public async Task ACopyAssessedWhileItsOriginalIsOpenIsTheKnownCollision()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var copy = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "copy.nendo");
        File.Copy(workspace.FilePath, copy);
        await using var session = Session(workspace, []);
        await session.OpenAsync(workspace.FilePath);
        var assessment = await session.AssessOpenAsync(copy);
        Assert.IsTrue(assessment.KnownInstanceCollision, "The open original was not recognised as the copy's original.");
        Assert.IsTrue(session.IsOpenFile(workspace.FilePath));
    }

    /// <summary>
    /// The window followed the session only through Workbench responses, so the recovery
    /// panel's actions left the caption, icon, Jump List and placement naming the last file.
    /// </summary>
    [TestMethod]
    public async Task EveryOpenAndCloseIsAnnouncedWithTheSessionAlreadyInItsNewState()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        await using var session = Session(workspace, []);
        var seen = new List<string?>();
        session.FileSessionChanged += () => seen.Add(session.CurrentFileName);

        await session.OpenAsync(workspace.FilePath);
        CollectionAssert.AreEqual(new[] { "desktop-session.nendo" }, seen, "An open was not announced, or announced before the session held it.");
        await session.CloseAsync();
        CollectionAssert.AreEqual(new[] { "desktop-session.nendo", null }, seen, "A close was not announced.");
        await session.OpenReadOnlyAsync(workspace.FilePath);
        await session.ReinspectCurrentAsync();
        Assert.HasCount(5, seen, "A reopen for inspection, as the recovery panel's Inspect again does, was not announced.");
        Assert.AreEqual("desktop-session.nendo", seen[^1]);
    }

    /// <summary>The recovery panel and the native actions read every record to set a few button states.</summary>
    [TestMethod]
    public async Task TheRecoveryPanelsViewCarriesNoRecords()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        await using var session = Session(workspace, []);
        await session.OpenAsync(workspace.FilePath);
        Assert.IsNotEmpty((await session.GetViewAsync()).Records, "The fixture has no records to leave out.");
        var view = await session.GetDefinitionViewAsync();
        Assert.IsEmpty(view.Records, "The recovery panel's read materialised every record.");
        Assert.IsNotEmpty(view.Entities, "The panel's Export needs the tables.");
        Assert.AreEqual("desktop-session.nendo", view.FileName);
        Assert.IsTrue(view.Capabilities.Backup);
        Assert.IsNotEmpty((await session.GetViewAsync()).Records, "The bounded read leaked into the next one.");
    }

    /// <summary>
    /// The fold's backup beside a file whose synced folder the person accepted was refused
    /// as an unacknowledged path, so the fold could never run there.
    /// </summary>
    [TestMethod]
    public async Task TheFoldsBackupBesideAnAcceptedFileIsCoveredAndNothingElseIs()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        await using var session = Session(workspace, [folder]);
        using (session.BindFileRequest(session.CurrentFileSessionId))
        {
            var assessment = await session.AssessOpenAsync(workspace.FilePath);
            await session.AcknowledgeOpenLocationAsync(assessment.AssessmentId);
            Assert.IsTrue((await session.OpenAssessedAsync(assessment.AssessmentId, false)).Capabilities.Mutate);
        }

        var backup = Path.Combine(folder, "desktop-session before folding 2026-10-13 1200.nendo");
        var plan = await session.PrepareFoldBackupAsync(workspace.FilePath, backup);
        Assert.IsNotNull(plan.PlanId, "The fold's backup beside an accepted file was refused.");
        // Still no blanket grant: any other output in the folder asks.
        var other = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareBackupAsync(Path.Combine(folder, "other.nendo"), "other"));
        Assert.AreEqual("unsupported-sync-location", other.Code);
    }

    /// <summary>A file opened read-only in a synced folder gets no backup grant from the fold.</summary>
    [TestMethod]
    public async Task TheFoldsBackupIsNotCoveredForAFileWhoseLocationWasNotAccepted()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        await using var session = Session(workspace, [folder]);
        await session.OpenReadOnlyAsync(workspace.FilePath);
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            session.PrepareFoldBackupAsync(workspace.FilePath, Path.Combine(folder, "fold backup.nendo")));
        Assert.AreEqual("unsupported-sync-location", refused.Code);
    }

    /// <summary>
    /// The fold's backup rebound to the session open at the
    /// moment, read outside the gate, so a fold running off the UI thread could act on the next
    /// file after a close or a replacement. It now belongs to its own request's session.
    /// </summary>
    [TestMethod]
    public async Task TheFoldsBackupAfterTheFileWasReplacedIsStaleAndTouchesNothing()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var next = Path.Combine(folder, "next.nendo");
        await using (var seed = Session(workspace, []))
        {
            await seed.CreateAsync(next);
        }
        await using var session = Session(workspace, []);
        var folded = await session.OpenAsync(workspace.FilePath);

        // Another request replaces the file between the fold's preview and its backup.
        await session.CloseAsync();
        var replaced = await session.OpenAsync(next);
        var nextChange = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var backup = Path.Combine(folder, "desktop-session before folding 2026-10-13 1200.nendo");
        using (session.BindFileRequest(folded.FileSessionId!))
        {
            var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareFoldBackupAsync(workspace.FilePath, backup),
                "The fold's backup went ahead on the file that replaced the one being folded.");
            Assert.AreEqual("stale-file-session", stale.Code);
        }
        Assert.IsFalse(File.Exists(backup));
        Assert.AreEqual(replaced.FileSessionId, session.CurrentFileSessionId, "The next file's session moved.");
        Assert.IsTrue(session.IsOpenFile(next));
        Assert.AreEqual(nextChange, (await session.GetViewAsync()).Manifest!.ChangeSequence, "The next file changed.");
    }

    /// <summary>
    /// The list read outside the gate still opened the file open here, which
    /// during a write reads as unavailable (its journal exists) and holds a lock the commit waits
    /// out. The open file is confirmed from the observation it was opened with.
    /// </summary>
    [TestMethod]
    public async Task TheOpenFileIsListedAsAvailableInTheMiddleOfAWrite()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        await using var session = Session(workspace, []);
        await session.OpenAsync(workspace.FilePath);
        // A write in progress, as the list finds it: a rollback journal beside the file. Empty,
        // so it is not a hot journal; removed before anything else touches the file.
        var journal = workspace.FilePath + "-journal";
        await File.WriteAllBytesAsync(journal, []);
        try
        {
            var listed = (await session.GetRecentFilesAsync()).Files.Single();
            Assert.AreEqual("available", listed.State, "The file open here read as unavailable in the middle of a write.");
        }
        finally
        {
            File.Delete(journal);
        }
    }

    /// <summary>
    /// The Workbench's recent list opened every remembered file while holding the request
    /// gate, so one on a disconnected share held every read behind it.
    /// </summary>
    [TestMethod]
    public async Task TheRecentListIsReadWithoutTheRequestGate()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        await using var session = Session(workspace, []);
        await session.OpenAsync(workspace.FilePath);
        var holding = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        var held = session.QueryAsync(async _ =>
        {
            holding.SetResult();
            await release.Task;
            return 0;
        }, CancellationToken.None);
        await holding.Task;
        try
        {
            var listed = session.GetRecentFilesAsync();
            var finished = await Task.WhenAny(listed, Task.Delay(TimeSpan.FromSeconds(10)));
            Assert.AreSame(listed, finished, "The recent list waited for the request gate another request held.");
            Assert.IsNotEmpty((await listed).Files);
        }
        finally
        {
            release.SetResult();
            await held;
        }
    }

    /// <summary>
    /// The handoff check observed the recent file in full only to learn its path, and the
    /// assessment then observed it again. The path comes from the history alone now: here the file
    /// cannot even be opened, and its path is still known.
    /// </summary>
    [TestMethod]
    public async Task ARecentFilesPathIsKnownWithoutOpeningIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        await using var session = Session(workspace, []);
        var recent = (await session.GetRecentFilesAsync()).Files.Single();
        using (new FileStream(workspace.FilePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.AreEqual(workspace.FilePath, await session.ResolveRecentPathAsync(recent.Id),
                "Learning a recent file's path opened the file.");
        }
        Assert.IsNull(await session.ResolveRecentPathAsync("recent-that-was-never-listed"));
    }

    private static async Task SeedAsync(DesktopTestWorkspace workspace)
    {
        await using var session = Session(workspace, []);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("record", "Preserved", "record");
    }

    private static DesktopSessionController Session(DesktopTestWorkspace workspace, string[] syncedRoots) =>
        new(fileHistoryRoot: workspace.FileHistoryRoot, locationPolicy: new(syncedRoots), deviceStateRoot: workspace.FileHistoryRoot);
}
