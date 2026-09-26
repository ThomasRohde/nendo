using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// R-014, the writer the Desktop's request gate does not serialize with: an agent at
/// Unattended accepts its own proposal through the Engine directly. A view's write already
/// admitted by the Desktop must still be refused if that acceptance removes its package
/// before the write reaches the Engine, and the Engine's write transaction is where that
/// is decided.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionWriterAgentRaceTests
{
    [TestMethod]
    public async Task AnAgentRemovingThePackageAfterAViewWriteIsAdmittedStopsThatWrite()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var discovery = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery-agent-race");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discovery), workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;
        var package = DesktopExtensionViewJourneyTests.ProbePackages[2];
        var actor = "extension:" + package;
        Assert.IsTrue((await session.GetViewAsync()).Extensions!.Run, "Views are not running in the seeded file.");

        Assert.AreEqual("ready", (await session.SetAgentModeAsync("unattended")).State);
        await using var client = await ConnectAsync(Directory.GetFiles(discovery, "*.json").Single());
        var lease = await CallAsync(client, "nendo.lease.acquire", new());
        var authority = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.GetProperty("applicationHandle").GetString(),
            ["leaseId"] = lease.GetProperty("leaseId").GetString(),
        };
        var begun = await CallAsync(client, "nendo.change_set.begin", new(authority) { ["title"] = "Remove probe C", ["idempotencyKey"] = "race-begin" });
        var scoped = new Dictionary<string, object?>(authority) { ["changeSetId"] = begun.GetProperty("changeSetId").GetString() };
        await CallAsync(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new
                {
                    description = "Remove probe C",
                    operations = new object[]
                    {
                        new { operationType = "extension.removeFile", payload = new { packageId = package, path = "index.html" } },
                        new { operationType = "extension.removeFile", payload = new { packageId = package, path = "probe.js" } },
                        new { operationType = "extension.removePackage", payload = new { packageId = package } },
                    },
                },
            },
            ["idempotencyKey"] = "race-add",
        });
        var validated = await CallAsync(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "race-validate" });
        Assert.AreEqual("previewable", validated.GetProperty("state").GetString()!.ToLowerInvariant(), validated.GetRawText());

        // The agent accepts in the window between the Desktop's admission of the view's write
        // and the Engine commit. It needs nothing the Desktop holds: the view's write holds the
        // Desktop's request gate throughout, so an accept that waited for it would time out.
        var removed = false;
        session.AfterExtensionWriterAdmittedForTest = async () =>
        {
            session.AfterExtensionWriterAdmittedForTest = null;
            var accepted = await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "race-accept" })
                .AsTask().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.AreNotEqual(true, accepted.IsError, JsonSerializer.Serialize(accepted));
            removed = accepted.StructuredContent!.Value.GetProperty("applied").GetBoolean();
        };

        var response = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = "race-" + Guid.NewGuid().ToString("N"),
            method = WorkbenchMethods.DataCreateRecord,
            fileSessionId,
            payload = new { entityId = "tasks", recordId = "raced", values = new { title = "Admitted before the removal" }, idempotencyKey = "view-raced", actor },
        }));

        Assert.IsTrue(removed, "The agent's removal did not commit inside the window, so this test measured nothing.");
        Assert.IsFalse(response.Ok, "A view's write committed after an agent removed its package.");
        Assert.AreEqual("actor-not-allowed", response.Error!.Code, response.Error.Message);
        Assert.IsFalse((await session.GetHistoryAsync()).Any(revision => revision.Origin == actor),
            "History holds a write in the name of a package that was gone when it committed.");
        Assert.IsFalse((await session.GetViewAsync()).Extensions!.Packages.Any(value => value.PackageId == package));
    }

    private static async Task<JsonElement> CallAsync(McpClient client, string name, Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        return result.StructuredContent ?? throw new AssertFailedException($"{name} returned no structured content.");
    }

    private static async Task<McpClient> ConnectAsync(string discoveryPath)
    {
        using var discovery = JsonDocument.Parse(await File.ReadAllTextAsync(discoveryPath));
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri(discovery.RootElement.GetProperty("endpoint").GetString()!),
            TransportMode = HttpTransportMode.StreamableHttp, ConnectionTimeout = TimeSpan.FromSeconds(5),
        });
        return await McpClient.CreateAsync(transport, new McpClientOptions
        {
            ClientInfo = new Implementation { Name = "nendo-desktop-agent-race-tests", Version = "1.0.0" },
            ProtocolVersion = "2026-07-28", InitializationTimeout = TimeSpan.FromSeconds(5),
        });
    }
}
