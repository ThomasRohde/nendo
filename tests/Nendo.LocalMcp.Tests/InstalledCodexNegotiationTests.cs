using System.Diagnostics;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class InstalledCodexNegotiationTests
{
    [TestMethod]
    [TestCategory("InstalledClient")]
    public async Task InstalledCodexUsesLatestProtocolAndReadsManifestWhenRequested()
    {
        if (Environment.GetEnvironmentVariable("NENDO_RUN_INSTALLED_CODEX_TEST") != "1")
        {
            return;
        }

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        var repositoryRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        var executable = InstalledClients.ResolveCodex();
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[]
        {
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--strict-config",
            "--sandbox",
            "read-only",
            "-C",
            repositoryRoot,
            "-c",
            "approval_policy=\"never\"",
            "-c",
            $"mcp_servers.nendo.url=\"{host.Endpoint.AbsoluteUri}\"",
            "-c",
            "mcp_servers.nendo.enabled_tools=[]",
            "-c",
            "mcp_servers.nendo.default_tools_approval_mode=\"approve\"",
            InstalledClients.ManifestPrompt("MCP_LATEST_OK"),
        })
        {
            start.ArgumentList.Add(argument);
        }
        using var process = Process.Start(start)
            ?? throw new AssertFailedException("The installed Codex process did not start.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            Assert.Fail("Installed Codex did not finish the bounded negotiation check within two minutes.");
        }

        var standardOutput = await output;
        var standardError = await error;
        Assert.AreEqual(
            0,
            process.ExitCode,
            $"Installed Codex negotiation failed. stderr: {Bounded(standardError)}");
        StringAssert.Contains(standardOutput, "MCP_LATEST_OK");
        Assert.IsTrue(host.GetActivities().Any(item =>
            item.Category == "resource" &&
            item.Name == "nendo://application/manifest" &&
            item.Outcome == "completed"),
            $"The host did not observe the manifest read. stdout: {Bounded(standardOutput)}");
        // Codex speaks the initialize handshake, and the host is stateless: clientInfo travels only in that
        // first request, so later activity carries the "Local agent" fallback rather than the client's name.
        // The manifest-read assertion above is the evidence that it was Codex.
    }

    private static string Bounded(string value) =>
        value.Length <= 1000 ? value : value[..1000];
}
