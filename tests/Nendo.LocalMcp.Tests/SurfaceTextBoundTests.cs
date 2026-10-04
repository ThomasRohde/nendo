using System.Text.Json;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-082. Claude Code shows server instructions and each tool description up to 2,048
/// characters and drops the rest, with nothing on the wire to say so. Measured on
/// 2026-09-27: the instructions were 2,755 characters and lost the sentence saying no
/// SQL, file, process or network access exists; <c>add_operations</c> lost its amend
/// remedy and <c>import_records</c> its retry sentence. The host cannot see a client's
/// cut, so it holds every text it sends under the bound and this test reads them back.
/// </summary>
[TestClass]
public sealed class SurfaceTextBoundTests
{
    private const int Bound = NendoServerInstructions.MaximumCharacters;

    [TestMethod]
    [DataRow(AgentAccessMode.ReadOnly, false)]
    [DataRow(AgentAccessMode.DataMutation, true)]
    [DataRow(AgentAccessMode.ApplicationAuthoring, false)]
    [DataRow(AgentAccessMode.Unattended, true)]
    public async Task EveryInstructionVariantFitsUnderTheClientCutAndStillSaysWhatMatters(AgentAccessMode mode, bool expiring)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            mode,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot) { LeaseTtl = expiring ? TimeSpan.FromSeconds(90) : null });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        using var http = LatestProtocolTests.Client(host);
        var viaClient = client.ServerInstructions ?? string.Empty;
        var viaDiscover = (await LatestProtocolTests.Send(http, "server/discover", new()))
            .GetProperty("result").GetProperty("instructions").GetString();
        var viaInitialize = (await LatestProtocolTests.Send(http, "initialize", new()
        {
            ["protocolVersion"] = "2025-06-18",
            ["capabilities"] = new { },
            ["clientInfo"] = new { name = "bound-probe", version = "1" },
        }, legacy: true)).GetProperty("result").GetProperty("instructions").GetString();

        Assert.AreEqual(viaClient, viaDiscover, "Both protocol eras read the same instructions.");
        Assert.AreEqual(viaClient, viaInitialize, "Both protocol eras read the same instructions.");
        Assert.IsLessThanOrEqualTo(Bound, viaClient.Length,
            $"At {mode} the instructions are {viaClient.Length} characters; a client stops reading at 2,048 and says nothing.");
        foreach (var required in new[]
                 {
                     "Read nendo://application/describe first",
                     "keep its applicationHandle private",
                     "Save receiptContext",
                     "no SQL, file, process or network access",
                 })
        {
            StringAssert.Contains(viaClient, required, $"At {mode} the instructions no longer say it.");
        }
        if (mode >= AgentAccessMode.Unattended)
        {
            StringAssert.Contains(viaClient, "nendo.change_set.accept applies your own validated proposal");
        }
        else
        {
            StringAssert.Contains(viaClient, "accepted or rejected by the person in Nendo");
            Assert.DoesNotContain("nendo.change_set.accept", viaClient, StringComparison.Ordinal,
                "Below Unattended no tool accepts a proposal, and the instructions must not suggest one.");
        }
        StringAssert.Contains(viaClient, expiring ? "Renew within 90 seconds" : "The lease has no expiry");
    }

    [TestMethod]
    public async Task EveryToolAndResourceTextFitsUnderTheClientCut()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var findings = new List<string>();
        var tools = await client.ListToolsAsync();
        Assert.HasCount(24, tools, "Unattended serves every tool, so every description is measured.");
        foreach (var tool in tools)
        {
            Measure(findings, tool.Name, tool.Description);
            foreach (var property in tool.ProtocolTool.InputSchema.GetProperty("properties").EnumerateObject())
            {
                if (property.Value.TryGetProperty("description", out var description))
                {
                    Measure(findings, $"{tool.Name}({property.Name})", description.GetString());
                }
            }
        }
        var resources = await client.ListResourcesAsync();
        foreach (var resource in resources) Measure(findings, resource.Name, resource.Description);
        var templates = await client.ListResourceTemplatesAsync();
        foreach (var template in templates) Measure(findings, template.Name, template.Description);
        Assert.AreEqual(23, resources.Count + templates.Count, "Every resource is measured.");
        Assert.IsEmpty(findings, "A client stops reading at 2,048 characters:\n" + string.Join('\n', findings));

        // The rules that no longer fit in add_operations are one read away, and the
        // description names that read.
        var addOperations = tools.Single(tool => tool.Name == "nendo.change_set.add_operations").Description ?? string.Empty;
        StringAssert.Contains(addOperations, "authoringRules");
        StringAssert.Contains(addOperations, "nendo.change_set.amend");
        var vocabulary = JsonDocument.Parse(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary")).RootElement;
        var rules = vocabulary.GetProperty("authoringRules").EnumerateArray().Select(rule => rule.GetString()).ToArray();
        CollectionAssert.AreEqual(NendoAuthoringOperations.Rules.ToArray(), rules);
        Assert.IsTrue(rules.Any(rule => rule!.StartsWith("Identifiers are global to the file", StringComparison.Ordinal)));
        Assert.IsTrue(rules.Any(rule => rule!.Contains("same mutation as its schema.createEntity", StringComparison.Ordinal)));
    }

    private static void Measure(List<string> findings, string name, string? text)
    {
        if (text is { Length: > Bound }) findings.Add($"{name}: {text.Length} characters, over {Bound}.");
    }
}
