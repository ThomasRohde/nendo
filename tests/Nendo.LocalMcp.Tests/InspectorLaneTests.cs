using System.Diagnostics;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-158: the reference MCP Inspector's own view of the tool list, against the host's. Opt-in
/// through NENDO_RUN_INSPECTOR=1 (Test-Production.ps1 -Inspector), because the package is not
/// part of the build; a run without it says Inconclusive, and a run with it and no package
/// fails by name.
/// </summary>
[TestClass]
public sealed class InspectorLaneTests
{
    [TestMethod]
    public async Task TheInspectorListsTheSameToolsTheHostDoes()
    {
        if (Environment.GetEnvironmentVariable("NENDO_RUN_INSPECTOR") != "1")
        {
            Assert.Inconclusive("The Inspector lane runs with NENDO_RUN_INSPECTOR=1 and @modelcontextprotocol/inspector where npx finds it; this run did not exercise it.");
        }
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var expected = (await client.ListToolsAsync()).Select(tool => tool.Name).Order(StringComparer.Ordinal).ToArray();

        var npx = OperatingSystem.IsWindows() ? "npx.cmd" : "npx";
        var start = new ProcessStartInfo(npx)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[] { "--no-install", "@modelcontextprotocol/inspector", "--cli", host.Endpoint.ToString(), "--transport", "http", "--method", "tools/list" })
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new AssertFailedException("npx did not start.");
        var output = await process.StandardOutput.ReadToEndAsync();
        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromMinutes(2)).Token);
        Assert.AreEqual(0, process.ExitCode, $"The Inspector lane needs @modelcontextprotocol/inspector where npx finds it. stderr: {error[..Math.Min(error.Length, 800)]}");
        var json = output[output.IndexOf('{')..];
        var listed = JsonDocument.Parse(json).RootElement.GetProperty("tools").EnumerateArray()
            .Select(tool => tool.GetProperty("name").GetString()!).Order(StringComparer.Ordinal).ToArray();
        CollectionAssert.AreEqual(expected, listed, "The Inspector and the host list different tools.");
    }
}
