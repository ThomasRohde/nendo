using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class LegacyReferenceConversionTests
{
    [TestMethod]
    public async Task ReviewedConversionPreservesIdsLanesOriginalEvidenceAndExactReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        await RuntimeLegacyReferenceFixture.CreateAsync(workspace.FilePath);
        var originalBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var coordinator = await workspace.OpenAsync(); var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        CollectionAssert.AreEqual(originalBytes, await ReadSharedAsync(workspace.FilePath));
        var change = Change(before.Manifest.DefinitionRevision, [new("s1", 1, "t1", 1), new("s2", 1, null, null)]);
        var rejected = await service.PrepareProposalAsync(Request(change));
        Assert.AreEqual(NendoProposalState.Previewable, rejected.State);
        Assert.IsTrue(rejected.TouchedRecords.Any(row => row.RecordId == "t1"));
        Assert.AreEqual(2, rejected.OperationCount);
        Assert.IsTrue(rejected.SemanticDiff.Any(entry => entry.Summary.Contains("cannot be undone", StringComparison.Ordinal)));
        await service.RejectProposalAsync(rejected.ProposalId);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        var preview = await service.PrepareProposalAsync(Request(change));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ApplicationId, after.Manifest.ApplicationId);
        Assert.AreEqual(before.Manifest.InstanceId, after.Manifest.InstanceId);
        Assert.AreEqual(before.Manifest.DataRevision + 1, after.Manifest.DataRevision);
        Assert.AreEqual(before.Manifest.DefinitionRevision + 1, after.Manifest.DefinitionRevision);
        Assert.AreEqual(NendoFormat.ReferenceConversionMinimumHostVersion, after.Manifest.MinimumHostVersion);
        Assert.AreEqual("t1", after.Records.Single(row => row.RecordId == "s1").Values["ref"].GetString());
        Assert.AreEqual(JsonValueKind.Null, after.Records.Single(row => row.RecordId == "s2").Values["ref"].ValueKind);
        Assert.IsTrue(after.Records.Where(row => row.EntityId == "source").All(row => row.RecordVersion == 2));
        var history = await service.GetHistoryAsync();
        var conversion = history.Single(row => row.Description == "Convert legacy values");
        await using (var evidenceReader = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
        {
            await evidenceReader.OpenAsync();
            await using var query = evidenceReader.CreateCommand();
            query.CommandText = "SELECT inverse_evidence_json FROM __nendo_operation WHERE operation_id=@id;";
            query.Parameters.AddWithValue("@id", conversion.Operations.Single().OperationId);
            StringAssert.Contains((string)(await query.ExecuteScalarAsync())!, "old value 1");
        }
        Assert.AreEqual(NendoReversibilityClass.IrreversibleDeclared, conversion.Operations.Single().Reversibility);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        coordinator = await workspace.OpenAsync();
        var reopened = await new NendoApplicationService(coordinator).GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(after.Records), JsonSerializer.Serialize(reopened.Records));
        Assert.AreEqual(JsonSerializer.Serialize(after.Entities), JsonSerializer.Serialize(reopened.Entities));
        CollectionAssert.AreEqual(bytes, await ReadSharedAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task MissingWrongStaleAndIncompleteMappingsNeverChangeTheActiveFile()
    {
        await using var workspace = new EngineTestWorkspace();
        await RuntimeLegacyReferenceFixture.CreateAsync(workspace.FilePath);
        var coordinator = await workspace.OpenAsync(); var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        foreach (var rows in new NendoReferenceConversionRow[][] {
            [new("s1", 1, "missing", 1), new("s2", 1, "t2", 1)],
            [new("s1", 1, "s2", 1), new("s2", 1, "t2", 1)],
            [new("s1", 2, "t1", 1), new("s2", 1, "t2", 1)],
            [new("s1", 1, "t1", 2), new("s2", 1, "t2", 1)],
            [new("s1", 1, "t1", 1)],
        })
        {
            try
            {
                var preview = await service.PrepareProposalAsync(Request(Change(before.Manifest.DefinitionRevision, rows)));
                Assert.AreEqual(NendoProposalState.Invalid, preview.State);
                await service.RejectProposalAsync(preview.ProposalId);
            }
            catch (NendoPreconditionException exception) { Assert.AreEqual("record-not-found", exception.Code); }
            Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        }
        var valid = await service.PrepareProposalAsync(Request(Change(before.Manifest.DefinitionRevision,
            [new("s1", 1, "t1", 1), new("s2", 1, "t2", 1)])));
        await service.SetFieldAsync(new("target", "t1", "label", 1, "Changed", new("test", "edit-target", "test")));
        var edited = await service.GetSnapshotAsync();
        Assert.IsFalse((await service.PromoteProposalAsync(valid.ProposalId)).Applied);
        Assert.AreEqual(JsonSerializer.Serialize(edited), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    [TestMethod]
    public async Task RequiredSelfReferencesValidateBeforeVersionsAdvance()
    {
        await using var workspace = new EngineTestWorkspace();
        await RuntimeLegacyReferenceFixture.CreateAsync(workspace.FilePath, required: true, selfReference: true);
        var coordinator = await workspace.OpenAsync(); var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        var invalid = await service.PrepareProposalAsync(Request(Change(before.Manifest.DefinitionRevision,
            [new("s1", 1, null, null), new("s2", 1, "s1", 1)], true)));
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        var valid = await service.PrepareProposalAsync(Request(Change(before.Manifest.DefinitionRevision,
            [new("s1", 1, "s2", 1), new("s2", 1, "s1", 1)], true)));
        Assert.AreEqual(NendoProposalState.Previewable, valid.State);
        Assert.IsTrue((await service.PromoteProposalAsync(valid.ProposalId)).Applied);
        var final = await service.GetSnapshotAsync();
        Assert.AreEqual("s2", final.Records.Single(row => row.RecordId == "s1").Values["ref"].GetString());
        Assert.AreEqual("s1", final.Records.Single(row => row.RecordId == "s2").Values["ref"].GetString());
    }

    [TestMethod]
    public async Task OversizedAndStandaloneConversionsAreRejected()
    {
        await using var workspace = new EngineTestWorkspace();
        await RuntimeLegacyReferenceFixture.CreateAsync(workspace.FilePath, 101);
        var coordinator = await workspace.OpenAsync(); var service = new NendoApplicationService(coordinator);
        var rows = Enumerable.Range(1, 100).Select(index => new NendoReferenceConversionRow($"s{index}", 1, "t1", 1)).ToArray();
        var before = await service.GetSnapshotAsync(); var change = Change(before.Manifest.DefinitionRevision, rows);
        var preview = await service.PrepareProposalAsync(Request(change));
        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(change.Mutations[0]));
        Assert.ThrowsExactly<NendoValidationException>(() => new NendoChangeSet([change.Mutations[0]]).Validate());
    }

    internal static NendoChangeSet Change(long definition, IReadOnlyList<NendoReferenceConversionRow> rows, bool self = false)
    {
        var key = Guid.NewGuid().ToString("N"); var target = self ? "source" : "target"; var label = self ? "title" : "label";
        return new([
            new("test", $"convert-{key}", "test", "Convert legacy values", [new ConvertLegacyReferenceOperation($"convert-{key}", "source", "ref", target, label, definition, rows)]),
            new("test", $"bind-{key}", "test", "Bind converted reference", [new ConfigureReferenceOperation($"bind-{key}", "source", "ref", target, label, definition,
                rows.Select(row => row with { ExpectedRecordVersion = row.ExpectedRecordVersion + 1,
                    ExpectedTargetRecordVersion = self && row.ExpectedTargetRecordVersion is long version ? version + 1 : row.ExpectedTargetRecordVersion }).ToArray())]),
        ]);
    }
    private static NendoProposalRequest Request(NendoChangeSet change) => new($"proposal-{Guid.NewGuid():N}", "Convert legacy reference", "test", change);
    private static async Task<byte[]> ReadSharedAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var copy = new MemoryStream(); await stream.CopyToAsync(copy); return copy.ToArray();
    }
}
