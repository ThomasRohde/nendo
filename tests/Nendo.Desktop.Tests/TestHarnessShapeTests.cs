namespace Nendo.Desktop.Tests;

/// <summary>
/// Under the full gate a fresh MCP host's first answer ran past this suite's 5 s client
/// bound, because the three suites ran at once, this process's thread pool was left at its
/// default, and three copies of the client each carried the short bound. These hold the shape
/// that fixed it, so a later change cannot quietly bring one part back.
/// </summary>
[TestClass]
public sealed class TestHarnessShapeTests
{
    [TestMethod]
    public void ThisProcesssThreadPoolIsSizedForTheSuite()
    {
        ThreadPool.GetMinThreads(out var workers, out _);
        Assert.IsGreaterThanOrEqualTo(DesktopTestHostThreads.Minimum, workers,
            $"The pool's minimum is {workers}; a fresh host's first answer queues behind the suite's waits.");
    }

    [TestMethod]
    public void EveryMcpClientInTheSuiteHasTheOneHandshakeBound()
    {
        var folder = Path.Combine(TestRepository.Root(), "tests", "Nendo.Desktop.Tests");
        var own = Directory.GetFiles(folder, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => Path.GetFileName(path) is not (nameof(DesktopMcpClient) + ".cs" or nameof(TestHarnessShapeTests) + ".cs"))
            .Where(path => File.ReadAllText(path) is var text &&
                (text.Contains("McpClient.CreateAsync", StringComparison.Ordinal) || text.Contains("InitializationTimeout", StringComparison.Ordinal)))
            .Select(Path.GetFileName)
            .ToArray();
        Assert.IsEmpty(own, "These tests build their own MCP client instead of DesktopMcpClient: " + string.Join(", ", own));
        Assert.AreEqual(TimeSpan.FromSeconds(10), DesktopMcpClient.HandshakeBound, "The Desktop suite's handshake bound is not the LocalMcp suite's.");
        // The client's server/discover probe has a bound of its own, 5 s by default, that fails
        // the handshake as "does not support the requested protocol version" before the 10 s.
        var probe = DesktopMcpClient.Options("shape").DiscoverProbeTimeout;
        Assert.IsTrue(probe == Timeout.InfiniteTimeSpan || probe >= DesktopMcpClient.HandshakeBound,
            $"The server/discover probe gives up after {probe}, inside the {DesktopMcpClient.HandshakeBound} handshake bound.");
    }

    [TestMethod]
    public void TheGateRunsTheSuitesOneAtATime()
    {
        var gate = File.ReadAllText(Path.Combine(TestRepository.Root(), "tools", "Test-Production.ps1"));
        Assert.DoesNotContain("'test', 'Nendo.slnx'", gate, "The gate runs every suite at once again.");
        Assert.IsFalse(System.Text.RegularExpressions.Regex.IsMatch(gate, @"dotnet\W+test\W+Nendo\.slnx"), "The gate runs every suite at once again.");
        foreach (var suite in new[] { "Nendo.Engine.Tests", "Nendo.LocalMcp.Tests", "Nendo.Desktop.Tests" })
            Assert.Contains($"'{suite}'", gate, $"The gate does not run {suite} on its own.");
    }

    /// <summary>
    /// Every gate run wrote a TRX and a deployment folder into each test project's
    /// TestResults, outside artifacts/ and removed by nothing: 467 MB from 285 runs.
    /// </summary>
    [TestMethod]
    public void TheGateKeepsTestResultsUnderArtifactsAndOnlyForAFailure()
    {
        var gate = File.ReadAllText(Path.Combine(TestRepository.Root(), "tools", "Test-Production.ps1"));
        var run = System.Text.RegularExpressions.Regex.Match(gate, @"(?m)^\s*& dotnet test \$project .*$");
        Assert.IsTrue(run.Success, "The gate's dotnet test line was not found.");
        StringAssert.Contains(run.Value, "--results-directory $suiteResults", "The gate writes test results into each test project.");
        StringAssert.Contains(gate, "\"artifacts/test-results/", "The gate's test results are not under artifacts/.");
        StringAssert.Contains(gate, "Remove-Item -LiteralPath $suiteResults", "A passing suite's results are kept.");
    }
}
