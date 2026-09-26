using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ProposalOutcomeProcessTests
{
    [TestMethod]
    public async Task AbruptLossAfterCommitResolvesFromAuditInFreshProcessWithoutDuplicateEffects()
    {
        await using var workspace = new EngineTestWorkspace();
        var initial = await workspace.CreateAsync();
        await initial.DisposeAsync();
        workspace.Forget(initial);
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        using (var child = StartChild(workspace.FilePath, proposalId, "Commit"))
        {
            try
            {
                var signal = await child.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
                if (signal != "COMMITTED")
                    Assert.Fail($"Commit child missed its seam: {signal}; {await child.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5))}");
            }
            finally
            {
                if (!child.HasExited) child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        await RestoreInterruptionTests.AssertExitedWriterReleasedAsync(workspace.FilePath);
        using (var reader = StartChild(workspace.FilePath, proposalId, "Read"))
        {
            try
            {
                var text = await reader.StandardOutput.ReadToEndAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
                await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.AreEqual(0, reader.ExitCode, await reader.StandardError.ReadToEndAsync());
                using var evidence = JsonDocument.Parse(text);
                Assert.AreEqual(1L, evidence.RootElement.GetProperty("sequence").GetInt64());
                Assert.AreEqual(2, evidence.RootElement.GetProperty("historyCount").GetInt32());
                Assert.IsTrue(evidence.RootElement.GetProperty("replayed").GetBoolean());
                Assert.AreEqual("Normal", evidence.RootElement.GetProperty("health").GetString());
                Assert.IsTrue(evidence.RootElement.GetProperty("cleanupComplete").GetBoolean());
            }
            finally
            {
                if (!reader.HasExited) reader.Kill(entireProcessTree: true);
                await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        var reopened = await workspace.OpenAsync();
        var service = new NendoApplicationService(reopened);
        Assert.IsNotNull(await service.GetProposalReceiptAsync(proposalId));
        Assert.HasCount(2, await service.GetHistoryAsync());
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);
    }

    private static Process StartChild(string path, string proposalId, string mode)
    {
        var start = new ProcessStartInfo("pwsh")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File",
                     Path.Combine(ReviewOutcomeChildDriver.RepositoryRoot(), "tools", "Invoke-ReviewOutcomeChild.ps1"),
                     "-EngineDirectory", Path.GetDirectoryName(typeof(ReviewOutcomeChildDriver).Assembly.Location)!,
                     "-FilePath", path, "-ProposalId", proposalId, "-Mode", mode })
            start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new AssertFailedException("The owned receipt child did not start.");
    }
}

public static class ReviewOutcomeChildDriver
{
    public static async Task RunAsync(string path, string proposalId, string mode)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "receipt-child");
        var service = new NendoApplicationService(coordinator);
        if (mode == "Commit")
        {
            var fixture = SemanticApplicationFixture.Load("decision-log", RepositoryRoot());
            await service.PrepareProposalAsync(new NendoProposalRequest(proposalId, "Decision Log", "test",
                fixture.DefinitionChangeSet(proposalId)));
            coordinator.AfterCommit = () =>
            {
                Console.WriteLine("COMMITTED");
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
            };
            await service.PromoteProposalAsync(proposalId);
        }
        else
        {
            var receipt = await service.GetProposalReceiptAsync(proposalId)
                ?? throw new InvalidOperationException("The committed receipt was lost.");
            var repeated = await service.PromoteProposalAsync(proposalId);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                sequence = receipt.ChangeSequence,
                historyCount = (await service.GetHistoryAsync()).Count,
                replayed = repeated.Applied && repeated.Result!.Revisions.All(revision => revision.IsIdempotentReplay),
                health = coordinator.Health.ToString(),
                cleanupComplete = !coordinator.ProposalCleanupPending,
            }));
        }
    }

    internal static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(Path.GetDirectoryName(typeof(ReviewOutcomeChildDriver).Assembly.Location)!);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Test repository root is unavailable.");
    }
}
