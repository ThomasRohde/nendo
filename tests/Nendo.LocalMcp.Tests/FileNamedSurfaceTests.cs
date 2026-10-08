using ModelContextProtocol.Client;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-089. With two Nendo windows open, an agent registered with both read "Nendo" as the
/// title of each server, "This is a Nendo file" as the first sentence of each, and a lease
/// grant that named no file. The discovery document was the one place that said which file
/// a server was, and no client shows it before its first call.
/// </summary>
[TestClass]
public sealed class FileNamedSurfaceTests
{
    [TestMethod]
    public async Task TheTitleTheInstructionsTheGrantAndTheStatusNameTheOpenFile()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        Assert.AreEqual("Nendo · fixture", client.ServerInfo.Title);
        StringAssert.StartsWith(client.ServerInstructions ?? string.Empty, "This is the Nendo file fixture.nendo. If your client");

        var grant = await client.CallToolAsync("nendo.lease.acquire");
        Assert.AreNotEqual(true, grant.IsError);
        Assert.AreEqual("fixture.nendo", grant.StructuredContent!.Value.GetProperty("fileName").GetString(),
            "The grant says which file the lease edits.");
        var status = await client.CallToolAsync("nendo.lease.status", new Dictionary<string, object?>());
        Assert.AreNotEqual(true, status.IsError);
        Assert.AreEqual("fixture.nendo", status.StructuredContent!.Value.GetProperty("fileName").GetString(),
            "The status after a reconnect says which file the endpoint serves.");
    }

    [TestMethod]
    public void ALongOrPathShapedNameStaysAShortNameAndTheInstructionsStayUnderTheCut()
    {
        // 255 characters is the longest name Windows gives a file.
        var longest = new string('a', 249) + ".nendo";
        foreach (var mode in new[] { AgentAccessMode.ReadOnly, AgentAccessMode.DataMutation, AgentAccessMode.ApplicationAuthoring, AgentAccessMode.Unattended })
        {
            foreach (var ttl in new TimeSpan?[] { null, TimeSpan.FromSeconds(86400) })
            {
                var instructions = NendoServerInstructions.For(mode, ttl, longest);
                Assert.IsLessThanOrEqualTo(NendoServerInstructions.MaximumCharacters, instructions.Length,
                    $"At {mode} a 255-character file name pushed the instructions to {instructions.Length} characters.");
            }
        }
        Assert.AreEqual("Nendo · ".Length + NendoFileLabel.MaximumCharacters, NendoFileLabel.Title(longest).Length);
        StringAssert.EndsWith(NendoFileLabel.Title(longest), "…");

        // A name and never a location, whatever the caller hands in.
        Assert.AreEqual("Nendo · Plan", NendoFileLabel.Title(@"C:\work\Plan.nendo"));
        var fromPath = NendoServerInstructions.For(AgentAccessMode.ReadOnly, null, @"C:\work\Plan.nendo");
        StringAssert.StartsWith(fromPath, "This is the Nendo file Plan.nendo. ");
        Assert.DoesNotContain(@"C:\work", fromPath, StringComparison.Ordinal);

        // No file to name keeps the sentence and the title this surface had before.
        Assert.AreEqual("Nendo", NendoFileLabel.Title(null));
        Assert.AreEqual("Nendo", NendoFileLabel.Title("   "));
        StringAssert.StartsWith(NendoServerInstructions.For(AgentAccessMode.ReadOnly, null), "This is a Nendo file. If your client");
    }
}
