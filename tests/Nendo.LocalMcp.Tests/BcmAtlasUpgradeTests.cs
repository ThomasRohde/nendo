using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-080: the Capability Atlas upgrade (tools/bcm-atlas/upgrade-operations.json, built from the same
/// definition as a fresh BCM.nendo) validates and applies to a copy of the committed BCM.nendo, over
/// the same MCP tools Upgrade-BcmAtlas.mjs uses. The file in workspace/ is only read.
/// </summary>
[TestClass]
public sealed class BcmAtlasUpgradeTests
{
    [TestMethod]
    public async Task TheAssessmentUpgradeAppliesToACopyOfTheRealBcmFile()
    {
        var root = RepositoryRoot();
        var source = Path.Combine(root, "workspace", "BCM.nendo");
        if (File.Exists(source + "-wal") || File.Exists(source + ".write-owner"))
            Assert.Inconclusive("workspace/BCM.nendo is open in Nendo, so a copy of it would not be the committed file. Close it and run again.");

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.OpenCopyAsync(source);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var owned = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };

        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(owned)
        {
            ["title"] = "Assessments over time for the Capability Atlas (W-080)",
            ["idempotencyKey"] = "upgrade-begin",
        });
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        using var upgrade = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(root, "tools", "bcm-atlas", "upgrade-operations.json")));
        var mutations = upgrade.RootElement.EnumerateArray().Select(mutation => new NendoAgentMutationInput(
            mutation.GetProperty("description").GetString()!,
            mutation.GetProperty("operations").EnumerateArray().Select(operation => new NendoAgentOperationInput(
                operation.GetProperty("operationType").GetString()!, operation.GetProperty("payload").Clone())).ToArray())).ToArray();
        // One call carries at most 16 operations in all, as Upgrade-BcmAtlas.mjs sends them.
        for (var index = 0; index < mutations.Length; index++)
        {
            await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
            {
                ["mutations"] = new[] { mutations[index] },
                ["idempotencyKey"] = $"upgrade-add-{index}",
            });
        }
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped)
        {
            ["idempotencyKey"] = "upgrade-validate",
        });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        Assert.IsEmpty(validated.Diagnostics.Where(diagnostic => diagnostic.Severity == NendoDiagnosticSeverity.Error),
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));

        var promoted = await workspace.Service.PromoteProposalAsync(validated.ProposalId, CancellationToken.None, validated.OperationDigest);
        Assert.IsTrue(promoted.Applied, promoted.Message);
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var assessment = snapshot.Entities.SingleOrDefault(entity => entity.EntityId == "bcm.assessment")
            ?? throw new AssertFailedException("The upgrade did not create the Assessment record type.");
        CollectionAssert.AreEqual(
            new[] { "assess.name", "assess.capability", "assess.dimension", "assess.score", "assess.date" },
            assessment.Fields.Where(field => field.Required).Select(field => field.FieldId).ToArray());
        var capability = snapshot.Entities.Single(entity => entity.EntityId == "bcm.capability");
        Assert.IsTrue(capability.Fields.Single(field => field.FieldId == "cap.code").Unique, "The capability code is not unique after the upgrade.");
        var support = snapshot.Entities.Single(entity => entity.EntityId == "bcm.support");
        Assert.IsTrue(support.Fields.Where(field => field.FieldId is "support.capability" or "support.application").All(field => field.Required),
            "Both ends of a support link should be required after the upgrade.");

        // The data phase: a capability's current maturity becomes its first assessment, imported as
        // Upgrade-BcmAtlas.mjs sends it, with the capability's version, which the import requires.
        var assessed = snapshot.Records.First(record => record.EntityId == "bcm.capability" &&
            record.Values.TryGetValue("cap.maturity", out var maturity) && maturity.ValueKind == JsonValueKind.Number);
        var imported = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(owned)
        {
            ["entityId"] = "bcm.assessment",
            ["format"] = "json",
            ["records"] = new[]
            {
                new NendoRecordInput($"{assessed.RecordId}.assess.maturity", JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                {
                    ["assess.name"] = "Migrated maturity",
                    ["assess.capability"] = assessed.RecordId,
                    ["assess.dimension"] = "Maturity",
                    ["assess.score"] = assessed.Values["cap.maturity"],
                    ["assess.date"] = "2026-09-15",
                })) { ExpectedTargetVersions = new Dictionary<string, long> { ["assess.capability"] = assessed.RecordVersion } },
            },
            ["idempotencyKey"] = "w080-assessments-0",
        });
        Assert.AreEqual(1, imported.Committed);
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) return directory.FullName;
        throw new AssertFailedException("The repository root (Nendo.slnx) was not found above the test binaries.");
    }
}
