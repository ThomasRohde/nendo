using System.Text.Json;
using ModelContextProtocol.Client;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A launched agent that repeats its application handle in its own words ("Your
/// applicationHandle is …", a table row, the bare value) showed it in the conversation tab,
/// because the tab hid a handle only after a key it recognised. Every handle a grant carries is
/// now known to the process, so the tab hides it by its value.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class MintedHandleTests
{
    [TestMethod]
    public async Task EveryHandleALeaseGrantsIsHiddenByItsValue()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        var handle = grant.ApplicationHandle;

        foreach (var said in new[] { $"Your applicationHandle is {handle}.", $"| applicationHandle | {handle} |", handle, handle.ToUpperInvariant() })
        {
            var shown = NendoMintedHandles.Hide(said, "(hidden)");
            Assert.DoesNotContain(handle, shown, StringComparison.OrdinalIgnoreCase, $"The granted handle was shown: {shown}");
            StringAssert.Contains(shown, "(hidden)");
        }
        // Past the bound the oldest handle goes, never the one just granted.
        for (var index = 0; index < NendoMintedHandles.Capacity; index++)
            NendoMintedHandles.Remember(Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)));
        var latest = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        NendoMintedHandles.Remember(latest);
        Assert.AreEqual("(hidden)", NendoMintedHandles.Hide(latest, "(hidden)"), "A handle granted past the bound was not hidden.");
        var other = new string('a', 64);
        Assert.AreEqual($"sha256 {other}", NendoMintedHandles.Hide($"sha256 {other}", "(hidden)"), "A digest that is no handle was hidden.");
    }
}
