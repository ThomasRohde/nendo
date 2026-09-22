using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class CsvTests
{
    [TestMethod]
    public void QuotingUnicodeNullEmptyAndMarkerTextRemainDistinct()
    {
        var originals = new string?[] { null, "", "\\N", "\\leading", "  =SUM(A1:A2)", "+formula", "-formula", "@formula", "æøå 🌱,\"quoted\"\r\nnext\nlast\r" };
        var csv = "Value\r\n" + string.Join("\r\n", originals.Select(value => NendoCsvProfile.Encode(JsonSerializer.SerializeToElement(value)))) + "\r\n";
        var parsed = Parse(csv); var field = new NendoFieldSnapshot("f", "Value", NendoStorageKind.Text, false, null, []);
        CollectionAssert.AreEqual(originals, parsed.Rows.Select(row => (string?)NendoCsvProfile.Decode(row[0], field, new(true))).ToArray());
        Assert.AreEqual("\\N", NendoCsvProfile.Decode("\\N", field, new(false)));
        Assert.AreEqual("", NendoCsvProfile.Decode("", field, new(false)));
        Assert.IsNull(NendoCsvProfile.Decode("", field, new(false, true)));
    }

    [TestMethod]
    [DataRow("A\n\"unfinished")]
    [DataRow("A\n\"closed\"oops")]
    [DataRow("A\nbad\"quote")]
    [DataRow("A,A\nx,y")]
    [DataRow("A,B\nx")]
    public void MalformedInputIsRejectedBeforeAnyMutation(string text) => Assert.ThrowsExactly<NendoValidationException>(() => Parse(text));

    [TestMethod]
    public void BoundsEncodingAndCancellationFailExplicitly()
    {
        Assert.ThrowsExactly<NendoValidationException>(() => NendoCsvProfile.Parse(new byte[] { 0xff }));
        Assert.ThrowsExactly<NendoValidationException>(() => NendoCsvProfile.Parse(new byte[NendoCsvProfile.MaximumBytes + 1]));
        Assert.ThrowsExactly<NendoValidationException>(() => Parse("A\n" + new string('x', NendoCsvProfile.MaximumCellCharacters + 1)));
        Assert.ThrowsExactly<OperationCanceledException>(() => NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("A\nx"), new CancellationToken(true)));
    }

    [TestMethod]
    public async Task EveryScalarExportsImportsAndReopensExactlyWithDurableReceipt()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        var kinds = new[] { NendoStorageKind.Text, NendoStorageKind.Integer, NendoStorageKind.Decimal, NendoStorageKind.Boolean, NendoStorageKind.Date, NendoStorageKind.DateTime, NendoStorageKind.Uuid };
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", new NendoOperation[] { new CreateEntityOperation("e", "e", "Entries", "entries") }
            .Concat(kinds.Select((kind, i) => new AddFieldOperation("f" + i, "e", "f" + i, "Field" + i, "field" + i, kind, false))).ToArray()));
        var values = new Dictionary<string, object?> { ["f0"] = "  \\N,\"🌱\"\r\n=SUM(A1:A2)  ", ["f1"] = long.MaxValue, ["f2"] = 0.1234567890123456789012345678m,
            ["f3"] = false, ["f4"] = "2026-09-06", ["f5"] = "2026-09-06T12:30:00.1234567+02:00", ["f6"] = "95e7a1b4-c54a-41bb-83cc-9eae7adf61bb" };
        await service.CreateRecordAsync(new("e", "original", values, new("test", "record", "test")));
        using var writer = new StringWriter(); Assert.AreEqual(1, await service.ExportCsvAsync("e", writer));
        var document = Parse(writer.ToString()); var before = await service.GetSnapshotAsync();
        var batch = await service.PrepareCsvBatchAsync(document, "e", kinds.Select((_, i) => new NendoCsvMapping(i, "f" + i)).ToArray(), new(true), 0, Guid.NewGuid().ToString("N"));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsTrue((await service.PromoteProposalAsync(batch.Proposal.ProposalId)).Applied);
        var records = (await service.GetSnapshotAsync()).Records;
        Assert.HasCount(2, records); Assert.AreEqual(JsonSerializer.Serialize(records[0].Values), JsonSerializer.Serialize(records[1].Values));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator); coordinator = await workspace.OpenAsync(); service = new(coordinator);
        Assert.AreEqual(JsonSerializer.Serialize(records), JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records));
        Assert.IsNotNull(await service.GetProposalReceiptAsync(batch.Proposal.ProposalId));
        Assert.HasCount(2, (await service.GetSnapshotAsync()).Records);
    }

    [TestMethod]
    public async Task InvalidLaterBatchPreservesExactlyTheEarlierCommittedBatch()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [new CreateEntityOperation("e", "e", "Entries", "entries"), new AddFieldOperation("f", "e", "f", "Count", "count", NendoStorageKind.Integer, true)]));
        var document = Parse("Count\n" + string.Join('\n', Enumerable.Range(0, 100)) + "\ninvalid\n");
        var batch = await service.PrepareCsvBatchAsync(document, "e", [new(0, "f")], new(true), 0, Guid.NewGuid().ToString("N"));
        Assert.HasCount(100, batch.Rows); Assert.IsTrue((await service.PromoteProposalAsync(batch.Proposal.ProposalId)).Applied);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.PrepareCsvBatchAsync(document, "e", [new(0, "f")], new(true), 100, Guid.NewGuid().ToString("N")));
        Assert.HasCount(100, (await service.GetSnapshotAsync()).Records);
        var receipt = await service.GetProposalReceiptAsync(batch.Proposal.ProposalId); Assert.IsNotNull(receipt); Assert.HasCount(1, receipt.Revisions);
    }

    [TestMethod]
    public async Task ReferenceVersionChangesRejectTheWholeReviewedBatch()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("target", "target", "Targets", "targets"), new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("source", "source", "Sources", "sources"), new AddFieldOperation("ref", "source", "ref", "Target", "target", NendoStorageKind.Reference, false),
        ]));
        await coordinator.ApplyAsync(new("test", "reference", "test", "Reference", [new ConfigureReferenceOperation("configure", "source", "ref", "target", "label", 1)]));
        await service.CreateRecordAsync(new("target", "target-id", new Dictionary<string, object?> { ["label"] = "Target label" }, new("test", "target", "test")));
        var batch = await service.PrepareCsvBatchAsync(Parse("Target\ntarget-id\ntarget-id\n"), "source", [new(0, "ref")], new(true), 0, Guid.NewGuid().ToString("N"));
        Assert.AreEqual(1L, batch.Rows[0].ExpectedTargetVersions["ref"]);
        await service.SetFieldAsync(new("target", "target-id", "label", 1, "Changed", new("test", "change", "test")));
        var result = await service.PromoteProposalAsync(batch.Proposal.ProposalId);
        Assert.IsFalse(result.Applied); Assert.IsFalse((await service.GetSnapshotAsync()).Records.Any(record => record.EntityId == "source"));
        Assert.IsNull(await service.GetProposalReceiptAsync(batch.Proposal.ProposalId));
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task InterruptedBatchAcknowledgementResolvesWithoutDuplicateRecords(bool afterCommit)
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [new CreateEntityOperation("e", "e", "Entries", "entries"), new AddFieldOperation("f", "e", "f", "Text", "text", NendoStorageKind.Text, false)]));
        var batch = await service.PrepareCsvBatchAsync(Parse("Text\none\ntwo\n"), "e", [new(0, "f")], new(true), 0, Guid.NewGuid().ToString("N"));
        Action fault = () => throw new IOException("Injected acknowledgement failure");
        if (afterCommit) coordinator.AfterCommit = fault; else coordinator.BeforeCommitAuthorityRead = fault;
        await Assert.ThrowsExactlyAsync<IOException>(() => service.PromoteProposalAsync(batch.Proposal.ProposalId));
        coordinator.AfterCommit = null; coordinator.BeforeCommitAuthorityRead = null;
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);coordinator = await workspace.OpenAsync();service = new(coordinator);
        Assert.AreEqual(afterCommit, await service.GetProposalReceiptAsync(batch.Proposal.ProposalId) is not null);
        Assert.HasCount(afterCommit ? 2 : 0, (await service.GetSnapshotAsync()).Records);
        if (!afterCommit) batch = await service.PrepareCsvBatchAsync(Parse("Text\none\ntwo\n"), "e", [new(0, "f")], new(true), 0, batch.Proposal.ProposalId["proposal-".Length..]);
        Assert.IsTrue((await service.PromoteProposalAsync(batch.Proposal.ProposalId)).Applied);
        Assert.HasCount(2, (await service.GetSnapshotAsync()).Records);
    }

    [TestMethod]
    public async Task MappingRejectsDefinitionChangesAndMalformedDocumentsWithoutWrites()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [new CreateEntityOperation("e", "e", "Entries", "entries"), new AddFieldOperation("f", "e", "f", "Text", "text", NendoStorageKind.Text, false)]));
        var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "schema2", "test", "New field", [new AddFieldOperation("g", "e", "g", "Other", "other", NendoStorageKind.Text, false)]));
        var before = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.PrepareCsvBatchAsync(Parse("Text\none\n"), "e", [new(0, "f")], new(true), 0, "stale", expectedDefinitionRevision: revision));
        Assert.AreEqual("stale-csv-schema", error.Code);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.PrepareCsvBatchAsync(new(["Text"], [Array.Empty<string>()]), "e", [new(0, "f")], new(true), 0, "malformed"));
        Assert.AreEqual(before, JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    private static NendoCsvDocument Parse(string text) => NendoCsvProfile.Parse(Encoding.UTF8.GetBytes(text));
}
