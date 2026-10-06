using System.Text.Json;
using ModelContextProtocol.Client;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-094. nendo://application/view-api is window.nendo as an agent reads it before it writes a
/// custom view's code. The Workbench's api build writes it from the tables api.js is built from,
/// and this host serves it as built.
/// <para>
/// It is for an agent that is writing a view, and nothing else. So nothing an agent reads by
/// default carries it: the instructions, describe, the vocabulary and the examples each point at
/// it with that condition, and describe lists it by the one sentence that says so.
/// </para>
/// </summary>
[TestClass]
public sealed class ViewApiResourceTests
{
    private const string Uri = "nendo://application/view-api";
    private const string Condition = "Read this only while you write a custom view's code; nothing else needs it.";

    [TestMethod]
    public async Task TheReferenceIsServedAsTheApiBuildWroteIt()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var served = await ProtocolResourceTests.ReadTextAsync(client, Uri);
        Assert.AreEqual(await File.ReadAllTextAsync(BuiltReference()), served,
            "The host serves another reference than the Workbench's api build wrote. Build the Workbench, then the local MCP.");

        using var reference = JsonDocument.Parse(served);
        var root = reference.RootElement;
        Assert.AreEqual(1, root.GetProperty("apiVersion").GetInt32());
        var methods = root.GetProperty("methods").EnumerateArray().Select(line => line.GetProperty("method").GetString()).ToArray();
        foreach (var method in new[] { "schema.describe", "records.query", "records.update", "proposals.prepare", "state.set", "ui.setToolbar" })
            CollectionAssert.Contains(methods, method, $"The reference has no line for {method}.");
        CollectionAssert.Contains(
            root.GetProperty("filters").GetProperty("operators").EnumerateArray().Select(word => word.GetString()).ToArray(), "le",
            "The reference does not give the query's own filter words.");
        StringAssert.Contains(root.GetProperty("example").GetProperty("index.html").GetString(), "<script src=\"/_nendo/api.js\"></script>");
    }

    [TestMethod]
    [DataRow(AgentAccessMode.ReadOnly)]
    [DataRow(AgentAccessMode.Unattended)]
    public async Task OnlyAnAgentWritingAViewIsSentToIt(AgentAccessMode mode)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, mode, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var carried = Distinctive(await ProtocolResourceTests.ReadTextAsync(client, Uri));

        var instructions = client.ServerInstructions ?? string.Empty;
        // The handshake does not route to it (review R-006): the resource's own description, describe,
        // extension.setPackage and the custom-view example send a view's author there, checked below.
        Assert.AreEqual(0, Occurrences(instructions, Uri), "The instructions send every agent toward the view API.");
        NoneCarried("the instructions", instructions, carried);

        var listed = (await client.ListResourcesAsync()).Single(resource => resource.Uri == Uri);
        Assert.IsTrue(listed.Description is { } text && text.StartsWith(Condition, StringComparison.Ordinal),
            $"The resource list describes the view API without first saying when to read it: {listed.Description}");

        using var description = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe"));
        var read = description.RootElement.GetProperty("reads").EnumerateArray()
            .Single(entry => entry.GetProperty("uri").GetString() == Uri);
        Assert.AreEqual(Condition, read.GetProperty("purpose").GetString(), "describe lists the view API by more, or other, than when to read it.");
        NoneCarried("describe", Strings(description.RootElement), carried);

        using var vocabulary = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        var setPackage = vocabulary.RootElement.GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("operationType").GetString() == "extension.setPackage");
        StringAssert.Contains(setPackage.GetProperty("summary").GetString(), $"Before writing that code, read {Uri}.");
        NoneCarried("the vocabulary", Strings(vocabulary.RootElement), carried);

        using var examples = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/examples"));
        var notes = examples.RootElement.GetProperty("examples").EnumerateArray()
            .Single(example => example.GetProperty("name").GetString() == "put-a-custom-view-in-the-file")
            .GetProperty("notes").EnumerateArray().Select(note => note.GetString()!).ToArray();
        Assert.IsTrue(notes.Any(note => note.StartsWith($"Before writing a view's code, read {Uri}", StringComparison.Ordinal)),
            "The custom-view example does not send a view's author to the view API.");
        NoneCarried("the examples", Strings(examples.RootElement), carried);
    }

    /// <summary>
    /// Sentences only the reference holds: its own, its example's code, and each method's answer
    /// long enough not to be a phrase any read might use, such as "null.".
    /// </summary>
    private static string[] Distinctive(string reference)
    {
        using var document = JsonDocument.Parse(reference);
        var root = document.RootElement;
        return
        [
            root.GetProperty("readWhen").GetString()!,
            root.GetProperty("about").GetString()!,
            root.GetProperty("example").GetProperty("view.js").GetString()!,
            .. root.GetProperty("methods").EnumerateArray().Select(line => line.GetProperty("answer").GetString()!).Where(answer => answer.Length >= 40),
        ];
    }

    private static void NoneCarried(string where, string text, string[] carried)
    {
        foreach (var sentence in carried)
            Assert.DoesNotContain(sentence, text, StringComparison.Ordinal,
                $"{where} carries the view API reference, which only an agent writing a view's code should pay to read: {sentence[..Math.Min(80, sentence.Length)]}");
    }

    /// <summary>Every string in a JSON read, decoded, so an escaped apostrophe still matches.</summary>
    private static string Strings(JsonElement element)
    {
        var found = new List<string>();
        void Walk(JsonElement value)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.String: found.Add(value.GetString()!); break;
                case JsonValueKind.Array: foreach (var item in value.EnumerateArray()) Walk(item); break;
                case JsonValueKind.Object: foreach (var property in value.EnumerateObject()) Walk(property.Value); break;
            }
        }
        Walk(element);
        return string.Join('\n', found);
    }

    private static int Occurrences(string text, string value)
    {
        var count = 0;
        for (var at = text.IndexOf(value, StringComparison.Ordinal); at >= 0; at = text.IndexOf(value, at + value.Length, StringComparison.Ordinal))
            count++;
        return count;
    }

    private static string BuiltReference()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "src", "Nendo.Workbench", "dist", "_nendo", "view-api.json");
            if (File.Exists(Path.Combine(directory.FullName, "src", "Nendo.Workbench", "package.json")))
                return File.Exists(candidate) ? candidate : throw new AssertFailedException($"The Workbench's api build has not written {candidate}.");
        }
        throw new AssertFailedException("The repository root was not found above the test's output folder.");
    }
}
