using System.Diagnostics;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Locates installed agent clients for the opt-in installed-client lanes. Both npm installs put a script
/// shim on PATH (codex.ps1, claude.cmd) that Process.Start cannot launch, so the real executable is found
/// by an explicit override first and the known install layout second.
/// </summary>
internal static class InstalledClients
{
    internal static string ManifestPrompt(string marker) =>
        "Use only the nendo MCP resource helpers. You must actually read nendo://application/manifest. " +
        $"After that succeeds, reply with {marker} and its formatIdentifier. Do not guess or echo the marker " +
        "before the resource result arrives.";

    internal static string ResolveCodex()
    {
        var configured = Environment.GetEnvironmentVariable("NENDO_INSTALLED_CODEX_PATH");
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        var vendored = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
            "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
        return File.Exists(vendored) ? vendored : "codex.exe";
    }

    internal static string ResolveClaude()
    {
        var configured = Environment.GetEnvironmentVariable("NENDO_INSTALLED_CLAUDE_PATH");
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        var local = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin", "claude.exe");
        return File.Exists(local) ? local : "claude.exe";
    }

    internal static async Task<(int ExitCode, string StandardOutput, string StandardError)> RunAsync(
        ProcessStartInfo start, TimeSpan timeout)
    {
        using var process = Process.Start(start)
            ?? throw new AssertFailedException($"The installed client '{start.FileName}' did not start.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var cancellation = new CancellationTokenSource(timeout);
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            Assert.Fail($"The installed client '{start.FileName}' did not finish within {timeout}.");
        }
        return (process.ExitCode, await output, await error);
    }

    internal static string Bounded(string value) => value.Length <= 1000 ? value : value[..1000];
}

/// <summary>
/// The lane the 2026-09-13 blackbox review ran by hand: Claude Code registered against the live endpoint
/// with nothing but its URL. Opt in with NENDO_RUN_INSTALLED_CLAUDE_TEST=1; it needs an installed,
/// signed-in Claude Code.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class InstalledClaudeCodeNegotiationTests
{
    [TestMethod]
    [TestCategory("InstalledClient")]
    public async Task InstalledClaudeCodeConnectsWithOnlyTheEndpointUrl()
    {
        if (Environment.GetEnvironmentVariable("NENDO_RUN_INSTALLED_CLAUDE_TEST") != "1")
        {
            return;
        }

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        // The whole client configuration is the endpoint. This is the file .mcp.json at the repository
        // root also carries, with the standard port in place of the test host's ephemeral one.
        var configRoot = Path.Combine(Path.GetTempPath(), "nendo-installed-claude", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(configRoot);
        var configPath = Path.Combine(configRoot, "mcp.json");
        await File.WriteAllTextAsync(configPath, System.Text.Json.JsonSerializer.Serialize(
            new { mcpServers = new { nendo = new { type = "http", url = host.Endpoint.AbsoluteUri } } }));
        try
        {
            var start = new ProcessStartInfo(InstalledClients.ResolveClaude())
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = configRoot,
            };
            foreach (var argument in new[]
            {
                "-p",
                InstalledClients.ManifestPrompt("CLAUDE_LATEST_OK"),
                "--mcp-config", configPath,
                "--strict-mcp-config",
                "--permission-mode", "bypassPermissions",
            })
            {
                start.ArgumentList.Add(argument);
            }

            var (exitCode, standardOutput, standardError) =
                await InstalledClients.RunAsync(start, TimeSpan.FromMinutes(3));
            Assert.AreEqual(0, exitCode,
                $"Installed Claude Code negotiation failed. stderr: {InstalledClients.Bounded(standardError)}");
            StringAssert.Contains(standardOutput, "CLAUDE_LATEST_OK");
            Assert.IsTrue(host.GetActivities().Any(item =>
                item.Category == "resource" &&
                item.Name == "nendo://application/manifest" &&
                item.Outcome == "completed"),
                $"The host did not observe the manifest read. stdout: {InstalledClients.Bounded(standardOutput)}");
        }
        finally
        {
            try { Directory.Delete(configRoot, recursive: true); } catch (IOException) { }
        }
    }
}
