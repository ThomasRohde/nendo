namespace Nendo.Engine.Tests;

[TestClass]
public sealed class SchemaOnlyProposalTests
{
    [TestMethod]
    public async Task EmptyFileCanReviewRejectAcceptAndEditTwoSchemaOnlyEntitiesAcrossReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        Assert.IsEmpty((await service.GetSnapshotAsync()).Entities);
        var rejected = await service.PrepareProposalAsync(Request("reject", "entity.first", "First"));
        Assert.AreEqual(NendoProposalState.Previewable, rejected.State);
        Assert.IsEmpty(rejected.PreviewApplications);
        Assert.IsEmpty(rejected.Diagnostics);
        // Two operations, plus the compatibility change they cause: the first
        // semantic entity on an empty file raises the minimum host version, and a
        // person is asked to approve that rather than discover it afterwards.
        Assert.HasCount(3, rejected.SemanticDiff);
        var raise = rejected.SemanticDiff.Single(entry => entry.Kind == "raiseMinimumHostVersion");
        StringAssert.Contains(raise.Summary, NendoFormat.MinimumHostVersion);
        StringAssert.Contains(raise.Summary, NendoFormat.SemanticMinimumHostVersion);
        Assert.AreEqual(NendoReversibilityClass.IrreversibleDeclared, raise.Reversibility);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, rejected.MinimumHostVersionBefore);
        Assert.AreEqual(NendoFormat.SemanticMinimumHostVersion, rejected.MinimumHostVersionAfter);
        // The preview describes what the file would hold, not what compiled: a
        // schema-only change set adds no screen and still previews as something.
        var previewed = rejected.PreviewEntities.Single();
        Assert.AreEqual("entity.first", previewed.EntityId);
        Assert.AreEqual(1, previewed.FieldCount);
        Assert.AreEqual(0, previewed.RecordCount);
        await service.RejectProposalAsync(rejected.ProposalId);
        Assert.IsEmpty((await service.GetSnapshotAsync()).Entities);

        foreach (var name in new[] { "first", "second" })
        {
            var preview = await service.PrepareProposalAsync(Request(name, $"entity.{name}", name));
            Assert.AreEqual(NendoProposalState.Previewable, preview.State);
            Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId,
                expectedOperationDigest: preview.OperationDigest)).Applied);
            await service.CreateRecordAsync(new($"entity.{name}", "record-same-id",
                new Dictionary<string, object?> { [$"field.{name}.name"] = name }, new("studio-test", $"{name}-create", "test")));
        }
        await service.SetFieldAsync(new("entity.second", "record-same-id", "field.second.name", 1,
            "Second edited independently", new("studio-test", "edit-second", "test")));
        var before = await service.GetSnapshotAsync();
        Assert.HasCount(2, before.Entities);
        Assert.IsEmpty(before.UiNodes);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid, "No custom render plan is advertised.");
        Assert.IsEmpty(compiled.Applications);
        Assert.IsEmpty(compiled.Diagnostics, "An absent optional custom definition is not malformed.");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        service = new(await workspace.OpenAsync());
        var reopened = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, reopened.Manifest.ChangeSequence);
        Assert.AreEqual("first", reopened.Records.Single(r => r.EntityId == "entity.first").Values["field.first.name"].GetString());
        Assert.AreEqual("Second edited independently", reopened.Records.Single(r => r.EntityId == "entity.second").Values["field.second.name"].GetString());
        Assert.AreEqual(NendoSessionHealth.Normal, reopened.Health);
    }

    [TestMethod]
    public async Task IncompleteCustomDefinitionStillBlocksProposalWithoutMutatingSchemaOnlyData()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = new NendoApplicationService(await workspace.CreateAsync());
        var preview = await service.PrepareProposalAsync(Request("valid", "entity.first", "First"));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var before = await service.GetSnapshotAsync();
        var malformed = await service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Incomplete surface", "test", new([
                new("studio-test", "incomplete-ui", "test", "Add incomplete form", [
                    new AddUiNodeOperation("incomplete-node", "surface.first", "node.first", null, "recordForm", 0)])])));
        Assert.AreEqual(NendoProposalState.Invalid, malformed.State);
        Assert.IsTrue(malformed.Diagnostics.Any(d => d.Severity == NendoDiagnosticSeverity.Error));
        Assert.IsFalse((await service.PromoteProposalAsync(malformed.ProposalId)).Applied);
        Assert.AreEqual(before.Manifest.ChangeSequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    private static NendoProposalRequest Request(string key, string entityId, string name) => new(
        $"proposal-{Guid.NewGuid():N}", $"Add {name} records", "test", new([
            new("studio-test", key, "test", $"Add {name} records", [
                new CreateEntityOperation($"{key}-entity", entityId, name, $"data_{key}"),
                new AddFieldOperation($"{key}-field", entityId, $"field.{entityId.Split('.')[1]}.name", "Name", "name",
                    NendoStorageKind.Text, true, "singleLine", [])]) ]));
}
