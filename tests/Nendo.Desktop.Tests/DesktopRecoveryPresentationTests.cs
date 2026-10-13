using System.Text;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopRecoveryPresentationTests
{
    [TestMethod]
    [DataRow("copy", "copy.nendo")]
    [DataRow(" chosen.nendo ", "chosen.nendo")]
    public void NewDestinationAcceptsOnlyALeafName(string candidate, string expected) =>
        Assert.AreEqual(expected, DesktopRecoveryPresentation.ValidateNewFileName(candidate, ".nendo"));

    [TestMethod]
    [DataRow("../escape")]
    [DataRow("C:\\another\\file.nendo")]
    [DataRow("file.nendo:stream")]
    [DataRow("COM1.nendo")]
    [DataRow("LPT¹")]
    [DataRow("nul")]
    [DataRow("CONIN$")]
    [DataRow("file.nendo.")]
    [DataRow("")]
    public void NewDestinationCannotEscapeTheSelectedFolder(string candidate) =>
        Assert.ThrowsExactly<NendoValidationException>(() => DesktopRecoveryPresentation.ValidateNewFileName(candidate, ".nendo"));

    [TestMethod]
    public async Task DiagnosticExportDoesNotContainPrivateFileOrApplicationContent()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("sensitive-record-id", "Private record contents", "record");
        var view = await session.GetViewAsync();
        var diagnostic = Encoding.UTF8.GetString(DesktopRecoveryPresentation.DiagnosticBytes(view));
        Assert.DoesNotContain(view.FileName!, diagnostic);
        Assert.DoesNotContain(view.Manifest!.ApplicationId, diagnostic);
        Assert.DoesNotContain(view.Manifest.InstanceId, diagnostic);
        Assert.DoesNotContain(view.FileSessionId!, diagnostic);
        Assert.DoesNotContain("sensitive-record-id", diagnostic);
        Assert.DoesNotContain("Private record contents", diagnostic);
        Assert.DoesNotContain("Idea", diagnostic);
        Assert.DoesNotContain("endpoint", diagnostic);
        Assert.DoesNotContain("bearer", diagnostic);
        Assert.Contains("\"health\": \"normal\"", diagnostic);
        var rejected = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ReinspectCurrentAsync());
        Assert.AreEqual("inspection-not-required", rejected.Code);
        Assert.AreEqual(view.FileSessionId, (await session.GetViewAsync()).FileSessionId);
    }

    [TestMethod]
    public async Task ExplicitReinspectionCreatesANewReadOnlySession()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CloseAsync();
        var original = await session.OpenReadOnlyAsync(workspace.FilePath);
        var repeated = await session.ReinspectCurrentAsync();
        Assert.AreNotEqual(original.FileSessionId, repeated.FileSessionId);
        Assert.AreEqual("readOnly", repeated.Health);
        Assert.AreEqual(original.Manifest, repeated.Manifest);
        Assert.IsFalse(repeated.Capabilities.AgentAccess);
        Assert.Contains("Open read-only", DesktopRecoveryPresentation.Describe(repeated));
        Assert.IsTrue(DesktopRecoveryPresentation.CanReinspect(repeated), "A read-only file did not offer Inspect file again.");
    }

    /// <summary>
    /// R2SMA-06: Inspect file again was offered and accepted whenever editing was off, so a healthy
    /// file that only waited for its automatic actions to be approved was closed, lost its agent
    /// access and came back read-only, where the approval could no longer be given.
    /// </summary>
    [TestMethod]
    public async Task AHealthyFileWaitingForApprovalIsNotReinspected()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopBehaviourGrantTests.SeedWithTriggerAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(null, workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var opened = await session.OpenAsync(workspace.FilePath);
        var view = await session.GetViewAsync();
        Assert.IsTrue(view.BehaviourTrust!.RequiresApproval);
        Assert.IsFalse(view.Capabilities.Mutate, "The fixture does not wait for approval.");
        Assert.AreEqual("normal", view.Health);

        Assert.IsFalse(DesktopRecoveryPresentation.CanReinspect(view), "The native panel offers Inspect file again on a healthy file.");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ReinspectCurrentAsync());
        Assert.AreEqual("inspection-not-required", refused.Code);
        var after = await session.GetViewAsync();
        Assert.AreEqual(opened.FileSessionId, after.FileSessionId, "The file was closed and reopened.");
        Assert.AreEqual("normal", after.Health);
    }

    /// <summary>
    /// R2SMA-10: the native panel offered Restore and Upgrade on a file marked read-only in File
    /// Explorer. Such a file is inspected, exported and backed up, never replaced.
    /// </summary>
    [TestMethod]
    public async Task AFileMarkedReadOnlyOffersNoRestoreOrUpgrade()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var seed = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot))
            await seed.CreateAsync(workspace.FilePath);
        File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) | FileAttributes.ReadOnly);
        try
        {
            await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
            var view = await session.OpenReadOnlyAsync(workspace.FilePath);
            Assert.IsTrue(view.Capabilities.Backup, "A file marked read-only lost its backup.");
            Assert.IsTrue(view.Findings.Any(finding => finding.Code == "file-read-only"));
            Assert.IsFalse(DesktopRecoveryPresentation.CanReplace(view), "Restore is offered on a file marked read-only.");
            Assert.IsTrue(DesktopRecoveryPresentation.CanReinspect(view));
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
        }
    }
}
