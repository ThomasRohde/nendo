using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopFileActionOutcomeTests
{
    [TestMethod]
    [DataRow("io")]
    [DataRow("access")]
    [DataRow("cancel")]
    public async Task ActivatedBackupOutcomeSurvivesLaterViewFailure(string failure)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "saved.backup.nendo");
        var plan = await session.PrepareBackupAsync(destination, "outcome-backup");
        var backup = await session.CreateBackupAsync(plan.PlanId);
        var bytes = await File.ReadAllBytesAsync(destination);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Task<DesktopSessionView> Refresh(CancellationToken token) => failure switch
        {
            "cancel" => session.GetViewAsync(token),
            "access" => throw new UnauthorizedAccessException("Private path C:\\private\\file.nendo"),
            _ => throw new IOException("Private path C:\\private\\file.nendo"),
        };
        var outcome = await DesktopFileActionView.CaptureAsync(Refresh,
            $"Backup created: {backup.DestinationFileName}.", cancellation.Token);
        Assert.IsNull(outcome.Session);
        Assert.IsNotNull(outcome.RefreshNotice);
        Assert.DoesNotContain("C:\\private", WorkbenchProtocolHandler.Serialize(new(5, "backup", true, outcome, null)));
        Assert.AreEqual("Backup created: saved.backup.nendo.", outcome.Notice);
        Assert.IsTrue((await session.CreateBackupAsync(plan.PlanId)).IsIdempotentReplay);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(destination));
    }
}
