using System.Runtime.InteropServices;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class FileHistoryTests
{
    [TestMethod]
    public async Task KnownClosedRawCopyOffersReadOnlyOriginalOrExplicitForkWithoutChangingSource()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var original = Session(workspace))
        {
            await original.CreateAsync(workspace.FilePath);
            await original.CreateIdeaSchemaAsync("schema");
            await original.CreateIdeaRecordAsync("idea-1", "Retained", "record");
        }
        var rawPath = FilePath(workspace, "raw-copy.nendo");
        File.Copy(workspace.FilePath, rawPath);
        var sourceBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var session = Session(workspace);
        var conflict = await Assert.ThrowsExactlyAsync<DesktopFileCollisionException>(() => session.OpenAsync(rawPath));
        Assert.IsTrue(conflict.Assessment.KnownInstanceCollision);
        Assert.IsNotNull(conflict.Assessment.KnownOriginalRecentId);
        Assert.IsFalse(session.HasFile);
        Assert.IsFalse(File.Exists(rawPath + ".write-owner"));
        Assert.DoesNotContain(JsonEncodedText.Encode(Path.GetDirectoryName(rawPath)!).ToString(), JsonSerializer.Serialize(conflict.Assessment));
        var readOnly = await session.OpenAssessedAsync(conflict.Assessment.AssessmentId, readOnly: true);
        Assert.AreEqual("readOnly", readOnly.Health);
        Assert.AreEqual("Retained", readOnly.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.SetIdeaTitleAsync("idea-1", 1, "Denied", "edit"));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.SetAgentModeAsync("inspect"));
        Assert.IsFalse((await session.GetAgentStatusAsync()).Available);
        var forkPath = FilePath(workspace, "fork.nendo");
        var fork = await session.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Fork, forkPath, "fork");
        var copied = await session.CreateIdentityCopyAsync(fork.PlanId);
        Assert.AreNotEqual(readOnly.Manifest!.InstanceId, copied.Manifest.InstanceId);
        await session.CloseAsync();
        Assert.AreEqual("normal", (await session.OpenAsync(forkPath)).Health);
        await session.CloseAsync();
        Assert.AreEqual(readOnly.Manifest, (await session.OpenRecentAsync(conflict.Assessment.KnownOriginalRecentId)).Manifest);
        await session.CloseAsync();
        CollectionAssert.AreEqual(sourceBytes, await File.ReadAllBytesAsync(workspace.FilePath));
        CollectionAssert.AreEqual(sourceBytes, await File.ReadAllBytesAsync(rawPath));
        // Inspecting the raw copy never promotes it to a known writable original.
        var stillConflict = await Assert.ThrowsExactlyAsync<DesktopFileCollisionException>(() => session.OpenAsync(rawPath));
        Assert.AreEqual(conflict.Assessment.KnownOriginalRecentId, stillConflict.Assessment.KnownOriginalRecentId);
    }

    [TestMethod]
    public async Task MovedFileAndHardLinkAliasRetainIdentityWithoutBecomingRawCopyConflicts()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        var created = await session.CreateAsync(workspace.FilePath);
        var recentId = (await session.GetRecentFilesAsync()).Files.Single().Id;
        await session.CloseAsync();
        var moved = FilePath(workspace, "moved.nendo");
        File.Move(workspace.FilePath, moved);
        Assert.AreEqual("missing", (await session.GetRecentFilesAsync()).Files.Single().State);
        Assert.AreEqual(created.Manifest, (await session.OpenAsync(moved)).Manifest);
        await session.CloseAsync();
        var alias = FilePath(workspace, "alias.nendo");
        Assert.IsTrue(CreateHardLink(alias, moved, IntPtr.Zero), $"Win32 error {Marshal.GetLastWin32Error()}");
        Assert.AreEqual(created.Manifest, (await session.OpenAsync(alias)).Manifest);
        var recent = (await session.GetRecentFilesAsync()).Files.Single();
        Assert.AreEqual(recentId, recent.Id);
        Assert.AreEqual("alias.nendo", recent.FileName);
    }

    [TestMethod]
    public async Task ReplacedRecentPathNeverSilentlyOpensTheNewApplication()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        await session.CreateAsync(workspace.FilePath);
        var recent = (await session.GetRecentFilesAsync()).Files.Single();
        await session.CloseAsync();
        File.Move(workspace.FilePath, FilePath(workspace, "original.nendo"));
        await using (var replacement = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "replacement")) { }
        var replacementBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        Assert.AreEqual("changed", (await session.GetRecentFilesAsync()).Files.Single().State);
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.OpenRecentAsync(recent.Id));
        Assert.AreEqual("recent-file-changed", error.Code);
        Assert.IsFalse(session.HasFile);
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        CollectionAssert.AreEqual(replacementBytes, await File.ReadAllBytesAsync(workspace.FilePath));
        // Explicit file selection is a fresh inspection, not the stale shortcut.
        Assert.AreEqual("normal", (await session.OpenAsync(workspace.FilePath)).Health);
        Assert.AreNotEqual(recent.Id, (await session.GetRecentFilesAsync()).Files.Single().Id);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task AssessmentIsBoundToObservedPhysicalFileForWritableAndReadOnlyOpen(bool readOnly)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        await session.CreateAsync(workspace.FilePath);
        await session.CloseAsync();
        var assessment = await session.AssessOpenAsync(workspace.FilePath);
        File.Move(workspace.FilePath, FilePath(workspace, "retained.nendo"));
        File.Copy(FilePath(workspace, "retained.nendo"), workspace.FilePath);
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.OpenAssessedAsync(assessment.AssessmentId, readOnly));
        Assert.AreEqual("file-changed-before-open", error.Code);
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        Assert.IsFalse(session.HasFile);
    }

    [TestMethod]
    [DataRow("{invalid")]
    [DataRow("{\"Version\":99,\"Entries\":[]}")]
    public async Task CorruptOrNewerAdvisoryStateIsPreservedAndDoesNotBlockRecovery(string contents)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var initial = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "fixture")) { }
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var historyPath = Path.Combine(workspace.FileHistoryRoot, "recent-files.json");
        await File.WriteAllTextAsync(historyPath, contents);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var session = Session(workspace);
        Assert.IsNotNull((await session.GetRecentFilesAsync()).Notice);
        Assert.AreEqual("readOnly", (await session.OpenReadOnlyAsync(workspace.FilePath)).Health);
        Assert.IsNotNull((await session.GetRecentFilesAsync()).Notice);
        Assert.AreEqual(contents, await File.ReadAllTextAsync(historyPath));
        await session.CloseAsync();
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task AdvisoryWriteFailureDoesNotHideTheSuccessfullyOpenedApplication()
    {
        await using var workspace = new DesktopTestWorkspace();
        await File.WriteAllTextAsync(workspace.FileHistoryRoot, "a file, not a writable state folder");
        await using var session = Session(workspace);
        var opened = await session.CreateAsync(workspace.FilePath);
        Assert.IsTrue(opened.HasFile);
        Assert.IsTrue(session.HasFile);
        Assert.AreEqual("normal", opened.Health);
        Assert.IsNotNull((await session.GetRecentFilesAsync()).Notice);
        Assert.AreEqual("a file, not a writable state folder", await File.ReadAllTextAsync(workspace.FileHistoryRoot));
    }

    [TestMethod]
    public async Task BoundedHistoryAndConcurrentDeviceWritesKeepRecentEntriesValid()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var first = Session(workspace);
        await using var second = Session(workspace);
        await Task.WhenAll(first.CreateAsync(workspace.FilePath), second.CreateAsync(FilePath(workspace, "other.nendo")));
        Assert.HasCount(2, (await first.GetRecentFilesAsync()).Files);
        await first.CloseAsync();
        await second.CloseAsync();
        for (var index = 0; index < 33; index++)
        {
            await first.CreateAsync(FilePath(workspace, $"recent-{index}.nendo"));
            await first.CloseAsync();
        }
        var recents = (await first.GetRecentFilesAsync()).Files;
        Assert.HasCount(32, recents);
        Assert.IsTrue(recents.All(entry => entry.State == "available"));
        Assert.AreEqual("recent-32.nendo", recents[0].FileName);
        Assert.IsEmpty(Directory.GetFiles(workspace.FileHistoryRoot, "*.tmp"));
        Assert.IsFalse(File.Exists(Path.Combine(workspace.FileHistoryRoot, ".recent-access")));
    }

    [TestMethod]
    public async Task MissingHistoryCannotInventKnowledgeOfAnUnobservedClosedCopy()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var initial = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "fixture")) { }
        var raw = FilePath(workspace, "unobserved.nendo");
        File.Copy(workspace.FilePath, raw);
        await using var session = Session(workspace);
        var observation = await session.AssessOpenAsync(raw);
        Assert.IsFalse(observation.KnownInstanceCollision);
        Assert.AreEqual("normal", (await session.OpenAssessedAsync(observation.AssessmentId, readOnly: false)).Health);
        // The live Engine guard still excludes the other physical file.
        var error = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => NendoWriteCoordinator.OpenAsync(workspace.FilePath, "other"));
        Assert.AreEqual("instance-in-use", error.Code);
    }

    private static DesktopSessionController Session(DesktopTestWorkspace workspace) => new(fileHistoryRoot: workspace.FileHistoryRoot);
    private static string FilePath(DesktopTestWorkspace workspace, string name) => Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, name);
    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);
}
