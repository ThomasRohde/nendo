using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class SemanticMetadataTests
{
    [TestMethod]
    public async Task LegacyP1FileRemainsReadableButRequiresExplicitStagedUpgrade()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var originalService = new NendoApplicationService(original);
        await originalService.CreateIdeaSchemaAsync("legacy-schema");
        await originalService.CreateIdeaRecordAsync("idea-1", "Keep me", "legacy-record");
        await original.DisposeAsync();
        workspace.Forget(original);
        await StripSemanticMetadataAsync(workspace.FilePath);

        var beforeOpen = await File.ReadAllBytesAsync(workspace.FilePath);
        var legacy = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var legacySnapshot = await legacy.GetSnapshotAsync();
        Assert.AreEqual(NendoFormat.MinimumHostVersion, legacySnapshot.Manifest.MinimumHostVersion);
        Assert.IsEmpty(legacySnapshot.UiNodes);
        Assert.HasCount(1, legacySnapshot.Entities[0].Fields);
        Assert.IsFalse((await legacy.GetHistoryAsync())[1].Operations[1].CanonicalJson
            .Contains("\"options\"", StringComparison.Ordinal));
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, legacy.Inspection!.Classification);
        Assert.IsTrue(legacy.Inspection.Findings.Any(finding => finding.Code == "upgrade-required"));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => legacy.ApplyAsync(SemanticDefinition("activation-1")));
        await legacy.DisposeAsync();
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync("legacy-write-denied"));
        CollectionAssert.AreEqual(beforeOpen, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task MissingSemanticTablesInANewerFileAreNotMistakenForALegacyUpgrade()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);
        await original.DisposeAsync();
        workspace.Forget(original);
        await StripSemanticMetadataAsync(workspace.FilePath);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.Rejected, inspection.Classification);
        Assert.AreEqual("layout-version-mismatch", inspection.Findings.Single().Code);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task CurrentFilePersistsSemanticMetadataAndIncompleteSurfaceReopensForRecovery()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var originalService = new NendoApplicationService(original);
        await originalService.CreateIdeaSchemaAsync("schema");
        await originalService.CreateIdeaRecordAsync("idea-1", "Keep me", "record");
        await original.DisposeAsync();
        workspace.Forget(original);
        var coordinator = await workspace.OpenAsync("semantic-activation");
        var applied = await coordinator.ApplyAsync(SemanticDefinition("activation-1"));
        var snapshot = await coordinator.GetSnapshotAsync();

        Assert.AreEqual((2L, 1L, 3L), (
            applied.DefinitionRevision,
            applied.DataRevision,
            applied.ChangeSequence));
        Assert.AreEqual(NendoFormat.SemanticMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);
        Assert.HasCount(4, snapshot.Entities[0].Fields);
        Assert.HasCount(2, snapshot.UiNodes);
        var status = snapshot.Entities[0].Fields.Single(field => field.FieldId == "field.idea.status");
        Assert.AreEqual("singleChoice", status.Presentation);
        CollectionAssert.AreEqual(
            new[] { "Idea", "Exploring", "Trying", "Paused", "Done" },
            status.Options.ToArray());
        var record = snapshot.Records.Single();
        Assert.AreEqual("Keep me", record.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual(JsonValueKind.Null, record.Values["field.idea.status"].ValueKind);
        Assert.AreEqual(JsonValueKind.Null, record.Values["field.idea.notes"].ValueKind);

        var history = await coordinator.GetHistoryAsync();
        CollectionAssert.AreEqual(
            new[]
            {
                "schema.addField",
                "schema.addField",
                "schema.addField",
                "ui.addNode",
                "ui.addNode",
                "ui.setProperty",
            },
            history[^1].Operations.Select(operation => operation.OperationType).ToArray());

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using var reopened = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, reopened.Inspection!.Classification);
        Assert.IsTrue(reopened.Inspection.Findings.Any(finding => finding.Code == "invalid-surface"));
        var reopenedSnapshot = await reopened.GetSnapshotAsync();
        Assert.AreEqual(snapshot.Manifest.ApplicationId, reopenedSnapshot.Manifest.ApplicationId);
        Assert.AreEqual(snapshot.Manifest.InstanceId, reopenedSnapshot.Manifest.InstanceId);
        Assert.AreEqual(NendoFormat.SemanticMinimumHostVersion, reopenedSnapshot.Manifest.MinimumHostVersion);
        Assert.HasCount(2, reopenedSnapshot.UiNodes);
        Assert.AreEqual(
            "entity.idea",
            reopenedSnapshot.UiNodes.Single(node => node.NodeId == "node.idea.form.root")
                .Properties["entityId"]
                .GetString());
    }

    [TestMethod]
    public async Task ChoiceAndDateSemanticsRejectInvalidValuesWithoutPartialRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await coordinator.ApplyAsync(SemanticDefinition("semantic"));
        await service.CreateIdeaRecordAsync("idea-1", "A typed idea", "record");

        var status = await coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "valid-status",
            "test",
            "Set a declared status",
            [new SetFieldOperation("operation-status", "entity.idea", "idea-1", "field.idea.status", 1, "Trying")]));
        var date = await coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "valid-date",
            "test",
            "Set an ISO date",
            [new SetFieldOperation("operation-date", "entity.idea", "idea-1", "field.idea.createdDate", 2, "2026-09-03")]));
        Assert.AreEqual(3L, date.DataRevision);
        Assert.AreEqual(status.ChangeSequence + 1, date.ChangeSequence);

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "invalid-choice",
            "test",
            "Reject an undeclared status",
            [new SetFieldOperation("operation-invalid-choice", "entity.idea", "idea-1", "field.idea.status", 3, "Later")]))) ;
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "invalid-date",
            "test",
            "Reject a non-ISO date",
            [new SetFieldOperation("operation-invalid-date", "entity.idea", "idea-1", "field.idea.createdDate", 3, "03/09/2026")]))) ;

        var snapshot = await coordinator.GetSnapshotAsync();
        Assert.AreEqual(date.ChangeSequence, snapshot.Manifest.ChangeSequence);
        Assert.AreEqual(3L, snapshot.Records.Single().RecordVersion);
        Assert.AreEqual("Trying", snapshot.Records.Single().Values["field.idea.status"].GetString());
        Assert.AreEqual("2026-09-03", snapshot.Records.Single().Values["field.idea.createdDate"].GetString());
    }

    [TestMethod]
    public async Task UiTreeMutationsRetainEvidenceAndRejectParentCycles()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await coordinator.ApplyAsync(SemanticDefinition("semantic"));

        var moved = await coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "move-node",
            "test",
            "Move the Title binding",
            [new MoveUiNodeOperation(
                "operation-move",
                "surface.idea.form",
                "node.idea.form.title",
                null,
                4)]));
        Assert.AreEqual(3L, moved.DefinitionRevision);
        var movedNode = (await coordinator.GetSnapshotAsync()).UiNodes
            .Single(node => node.NodeId == "node.idea.form.title");
        Assert.IsNull(movedNode.ParentNodeId);
        Assert.AreEqual(4, movedNode.Position);

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "cycle",
            "test",
            "Reject a parent cycle",
            [new MoveUiNodeOperation(
                "operation-cycle",
                "surface.idea.form",
                "node.idea.form.title",
                "node.idea.form.title",
                0)])));
        Assert.AreEqual(moved.ChangeSequence, (await coordinator.GetSnapshotAsync()).Manifest.ChangeSequence);

        var removed = await coordinator.ApplyAsync(new NendoMutation(
            "semantic-test",
            "remove-node",
            "test",
            "Remove the Title binding",
            [new RemoveUiNodeOperation(
                "operation-remove",
                "surface.idea.form",
                "node.idea.form.title")]));
        Assert.AreEqual(4L, removed.DefinitionRevision);
        Assert.IsFalse((await coordinator.GetSnapshotAsync()).UiNodes
            .Any(node => node.NodeId == "node.idea.form.title"));

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var evidence = await ReadScalarAsync(
            workspace.FilePath,
            "SELECT inverse_evidence_json FROM __nendo_operation WHERE operation_id = 'operation-remove';");
        StringAssert.Contains(evidence, "retainedSubtree");
        StringAssert.Contains(evidence, "node.idea.form.title");
    }

    private static NendoMutation SemanticDefinition(string key) => new(
        "semantic-test",
        key,
        "test",
        "Add semantic Idea metadata",
        [
            new AddFieldOperation(
                $"operation-{key}-status",
                "entity.idea",
                "field.idea.status",
                "Status",
                "status",
                NendoStorageKind.Text,
                required: false,
                presentation: "singleChoice",
                options: ["Idea", "Exploring", "Trying", "Paused", "Done"]),
            new AddFieldOperation(
                $"operation-{key}-notes",
                "entity.idea",
                "field.idea.notes",
                "Notes",
                "notes",
                NendoStorageKind.Text,
                required: false,
                presentation: "longText"),
            new AddFieldOperation(
                $"operation-{key}-date",
                "entity.idea",
                "field.idea.createdDate",
                "Created date",
                "created_date",
                NendoStorageKind.Date,
                required: false,
                presentation: "date"),
            new AddUiNodeOperation(
                $"operation-{key}-root",
                "surface.idea.form",
                "node.idea.form.root",
                null,
                "recordForm",
                0),
            new AddUiNodeOperation(
                $"operation-{key}-title",
                "surface.idea.form",
                "node.idea.form.title",
                "node.idea.form.root",
                "fieldBinding",
                0),
            new SetUiPropertyOperation(
                $"operation-{key}-entity",
                "surface.idea.form",
                "node.idea.form.root",
                "entityId",
                "entity.idea"),
        ]);

    internal static async Task StripSemanticMetadataAsync(string path)
    {
        await using var connection = await OpenAsync(path, SqliteOpenMode.ReadWrite);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            DROP TABLE __nendo_ui_property;
            DROP INDEX __nendo_ui_node_surface;
            DROP TABLE __nendo_ui_node;
            ALTER TABLE __nendo_field DROP COLUMN options_json;
            ALTER TABLE __nendo_field DROP COLUMN presentation;
            ALTER TABLE __nendo_revision DROP COLUMN compensation_of_revision_id;
            ALTER TABLE __nendo_revision DROP COLUMN proposal_digest;
            ALTER TABLE __nendo_revision DROP COLUMN proposal_id;
            """;
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<string> ReadScalarAsync(string path, string sql)
    {
        await using var connection = await OpenAsync(path, SqliteOpenMode.ReadOnly);
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToString(await command.ExecuteScalarAsync(), System.Globalization.CultureInfo.InvariantCulture)
            ?? string.Empty;
    }

    private static async Task<SqliteConnection> OpenAsync(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = mode,
            Pooling = false,
        }.ToString());
        await connection.OpenAsync();
        return connection;
    }
}
