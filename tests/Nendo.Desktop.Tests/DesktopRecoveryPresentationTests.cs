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
    }
}
