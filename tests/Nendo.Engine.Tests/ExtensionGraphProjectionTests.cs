namespace Nendo.Engine.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ExtensionGraphProjectionTests
{
    private static readonly NendoGraphBinding Binding = new("nodes", "label", "edges", "from", "to", "amount");
    private static async Task Seed(NendoWriteCoordinator coordinator, int count = 2)
    {
        await coordinator.ApplyAsync(new("graph", "schema", "test", "Graph fixture", [
            new CreateEntityOperation("nodes", "nodes", "Nodes", "nodes"),
            new AddFieldOperation("label", "nodes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("amount", "nodes", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
            new AddFieldOperation("secret", "nodes", "secret", "Unprojected", "secret", NendoStorageKind.Text, false),
            new CreateEntityOperation("edges", "edges", "Edges", "edges"),
            new AddFieldOperation("from", "edges", "from", "From", "from_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("to", "edges", "to", "To", "to_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "nodes", "label", 0),
        ]));
        // Bounded batches respect the existing operation ceiling.
        foreach (var batch in Enumerable.Range(0, count).Chunk(50))
            await coordinator.ApplyAsync(new("graph", "batch" + batch[0], "test", "Nodes", batch.Select(i => (NendoOperation)new CreateRecordOperation("create" + i, "nodes", "n" + i,
                new Dictionary<string, object?> { ["label"] = "Node " + i, ["amount"] = 0.1234567890123456789012345678m, ["secret"] = "never projected" })).ToArray()));
    }
    private static Task Edge(NendoWriteCoordinator coordinator, string id, string? from, string? to) => coordinator.ApplyAsync(new("graph", id, "test", "Edge", [
        new CreateRecordOperation("create-" + id, "edges", id, new Dictionary<string, object?> { ["from"] = from, ["to"] = to },
            new Dictionary<string, long>(new[] { ("from", from), ("to", to) }.Where(p => p.Item2 is not null).Select(p => new KeyValuePair<string, long>(p.Item1, 1)))),
    ]));

    [TestMethod]
    public async Task ProjectionUsesBoundReferencesExactScalarTextAndOneRevision()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        await Seed(coordinator); await Edge(coordinator, "e1", "n0", "n1"); await Edge(coordinator, "e2", "n1", "n0");
        var service = new NendoApplicationService(coordinator);
        var projection = await service.ReadGraphProjectionAsync(Binding);
        Assert.HasCount(2, projection.Nodes); Assert.HasCount(2, projection.Edges);
        Assert.AreEqual("0.1234567890123456789012345678", projection.Nodes[0].Status);
        Assert.IsFalse(System.Text.Json.JsonSerializer.Serialize(projection).Contains("never projected", StringComparison.Ordinal));
        Assert.AreEqual((await service.GetDefinitionSnapshotAsync()).Manifest.ChangeSequence, projection.SourceChangeSequence);
        Assert.AreNotEqual(Binding.ComputeDigest(), (Binding with { StatusFieldId = null }).ComputeDigest());
    }

    [TestMethod]
    public async Task OversizedGraphIsRefusedAsAWhole()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        await Seed(coordinator, 501);
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ReadGraphProjectionAsync(Binding));
        Assert.AreEqual("graph-projection-too-large", error.Code);
    }

    [TestMethod]
    public async Task MissingEndpointsAndWrongBindingsAreNotSilentlyDropped()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        await Seed(coordinator); await Edge(coordinator, "e1", "n0", null);
        Assert.AreEqual("graph-endpoint-unavailable", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ReadGraphProjectionAsync(Binding))).Code);
        Assert.AreEqual("graph-binding-invalid", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ReadGraphProjectionAsync(Binding with { TargetFieldId = "from" }))).Code);
        Assert.AreEqual("graph-binding-invalid", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ReadGraphProjectionAsync(Binding with { LabelFieldId = "amount" }))).Code);
    }
}
