using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// What an agent can observe. The 2026-09-11 blackbox review built a complete CRM
/// through this interface and then had to open the SQLite file directly to check
/// that a button had done what the button said it did: the read paths existed but
/// were not discoverable, health reported a stale measurement as a current one,
/// and pending proposals were invisible. Each case here is one of those.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class ReadPathTests
{
    /// <summary>
    /// resources/list returns only the parameterless resources, so the read path
    /// for records — the one an agent needs most — appeared nowhere in it. The
    /// first read this host sends a client to now names every resource URI.
    /// </summary>
    [TestMethod]
    public async Task DescribeNamesEveryReadPathIncludingTheTemplatedOnes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var description = ProtocolResourceTests.Deserialize<NendoMcpDescription>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe"));

        var listed = (await client.ListResourcesAsync()).Select(resource => resource.Uri);
        var templated = (await client.ListResourceTemplatesAsync()).Select(template => template.UriTemplate);
        CollectionAssert.AreEquivalent(
            listed.Concat(templated).ToArray(),
            description.Reads.Select(read => read.Uri).ToArray(),
            "The index must name exactly the resources this host serves.");
        Assert.IsTrue(
            description.Reads.Any(read => read.Templated && read.Uri.StartsWith(
                "nendo://application/entity/{entityId}/records", StringComparison.Ordinal)),
            "Reading a record back must be discoverable from the first read.");
        Assert.IsTrue(description.Reads.All(read => !string.IsNullOrWhiteSpace(read.Purpose)));

        // The named path has to work as named, with the entity substituted.
        var records = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ProtocolResourceTests.ReadTextAsync(
                client,
                $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records?limit=100"));
        Assert.IsNotEmpty(records.Items);
        Assert.IsNotEmpty(records.Items[0].Values);
        Assert.IsGreaterThan(0, records.Items[0].RecordVersion,
            "A read-modify-write needs the record's current version, which is what this path carries.");
    }

    /// <summary>
    /// "ok" measured 32 changes ago is not "ok" now. The result still reports what
    /// was measured; what changed is that the file's distance from it is stated.
    /// </summary>
    [TestMethod]
    public async Task HealthSaysHowFarTheFileHasMovedSinceItsIntegrityResultWasMeasured()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var health = ProtocolResourceTests.Deserialize<NendoMcpHealth>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/health"));

        Assert.AreEqual("ok", health.IntegrityResult);
        Assert.IsNotNull(health.ChangeSequence);
        Assert.IsNotNull(health.IntegrityChangeSequence);
        Assert.IsGreaterThan(0, health.ChangesSinceIntegrityCheck!.Value,
            "The fixture wrote a schema and three records after the file was opened and scanned.");
        Assert.IsTrue(health.IntegrityStale,
            "A result measured before those writes must not present itself as current.");
        Assert.AreEqual(
            health.ChangeSequence!.Value - health.IntegrityChangeSequence!.Value,
            health.ChangesSinceIntegrityCheck!.Value);
    }

    /// <summary>
    /// The advertisement names the endpoint, the process and the application, but
    /// not which file it serves — which with two Nendo windows open is the one
    /// question a person has to answer. It carries the file's name, and no path:
    /// agents never receive a database path.
    /// </summary>
    [TestMethod]
    public async Task TheDiscoveryAdvertisementNamesTheFileWithoutGivingItsPath()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        var text = await File.ReadAllTextAsync(host.DiscoveryPath);
        var document = JsonSerializer.Deserialize<NendoDiscoveryDocument>(text, NendoMcpJson.Options);

        Assert.IsNotNull(document);
        Assert.AreEqual(Path.GetFileName(workspace.FilePath), document.DisplayName);
        Assert.DoesNotContain(
            Path.GetDirectoryName(workspace.FilePath)!,
            text,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(workspace.FilePath, text, StringComparison.OrdinalIgnoreCase);
    }
}
