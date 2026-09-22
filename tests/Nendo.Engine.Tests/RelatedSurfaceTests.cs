using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// P6-B: a related list is the inverse of one configured reference, and a detail
/// surface is the record page that composes it. Both are contract version 3.
/// </summary>
[TestClass]
public sealed class RelatedSurfaceTests
{
    [TestMethod]
    public async Task RecordPageComposesSectionsAndTheInverseOfAReference()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Remit page", RemitPage()));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        var page = compiled.Applications.Single(app => app.Entity.SemanticId == "remit").Surfaces.Single();
        Assert.AreEqual("detailSurface", page.Kind);

        var details = page.Children.Single(node => node.Kind == "section");
        Assert.AreEqual("Scope", details.Properties["title"].GetString());
        Assert.AreEqual("remit-name", details.Children.Single().Properties["fieldId"].GetString());

        var related = page.Children.Single(node => node.Kind == "relatedList");
        Assert.AreEqual("axiom", related.Properties["targetEntityId"].GetString());
        Assert.AreEqual("axiom-remit", related.Properties["viaFieldId"].GetString());

        // Bindings inside a related list address the related record type, not the
        // record type the page is for.
        CollectionAssert.AreEqual(
            new[] { "axiom-handle", "axiom-statement" },
            related.Children.Select(child => child.Properties["fieldId"].GetString()).ToArray());
    }

    [TestMethod]
    public async Task ConfiguringAReferenceCreatesItsCoveringIndexAndKeepsTheLayoutRecognised()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await using (var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='axiom_records';";
            await using var reader = await command.ExecuteReaderAsync();
            var found = new List<(string Name, string? Sql)>();
            while (await reader.ReadAsync()) found.Add((reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)));

            var index = found.SingleOrDefault(row => row.Sql?.Contains("remit_id", StringComparison.Ordinal) == true);
            Assert.IsNotNull(index.Name, $"Expected a reference index; found {string.Join(", ", found.Select(row => row.Name))}.");
            StringAssert.Contains(index.Sql!, "__nendo_record_id", "The index must cover the ordering column.");
            Assert.IsFalse(index.Name.StartsWith("__nendo_", StringComparison.Ordinal),
                "A reference index must stay outside the protected schema signature, whose recognised layouts are a fixed set.");
        }
        SqliteConnection.ClearAllPools();

        // The layout must still be recognised, which is what an unrecognised
        // protected schema would refuse.
        var reopened = await workspace.OpenAsync();
        Assert.IsNotNull(await new NendoApplicationService(reopened).GetSnapshotAsync());
        await reopened.DisposeAsync();
        workspace.Forget(reopened);
    }

    [TestMethod]
    public async Task EmptyRelationCompilesAndCarriesNoRecordsOfItsOwn()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await service.CreateRecordAsync(new("remit", "remit-1",
            new Dictionary<string, object?> { ["remit-name"] = "Data" }, new("test", "r1", "test")));
        await coordinator.ApplyAsync(new("test", "ui", "test", "Remit page", RemitPage()));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        var app = compiled.Applications.Single(value => value.Entity.SemanticId == "remit");
        Assert.AreEqual("Data", app.Records.Single().Values["remit-name"].GetString());
        Assert.IsNotNull(app.Surfaces.Single().Children.Single(node => node.Kind == "relatedList"),
            "A relation with no records is still a declared part of the page.");
    }

    [TestMethod]
    [DataRow("missingTarget", "NUI262", "targetEntityId")]
    [DataRow("notAReference", "NUI263", "viaFieldId")]
    [DataRow("pointsElsewhere", "NUI266", "viaFieldId")]
    [DataRow("noBindings", "NUI264", null)]
    public async Task InvalidRelationsFailClosed(string scenario, string code, string? propertyPath)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", scenario, RemitPage(scenario)));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid, "An invalid relation must not compile.");
        Assert.IsEmpty(compiled.Applications, "A core error produces no partial application plan.");

        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == code);
        Assert.IsNotNull(hit, $"Expected {code}; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.IsFalse(string.IsNullOrWhiteSpace(hit.SemanticId));
        Assert.AreEqual(propertyPath, hit.PropertyPath);
    }

    // P6-E: a tile states one exact count over a filtered set, never a length
    // taken from whichever page happens to be loaded.
    [TestMethod]
    public async Task CountIsExactOverTheWholeFilteredSetRatherThanAPage()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await service.CreateRecordAsync(new("remit", "remit-1",
            new Dictionary<string, object?> { ["remit-name"] = "Data" }, new("test", "r0", "test")));
        var remit = (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "remit");

        for (var index = 0; index < 120; index++)
        {
            await service.CreateRecordAsync(new("axiom", $"axiom-{index:D3}",
                new Dictionary<string, object?>
                {
                    ["axiom-handle"] = $"AX-{index:D3}",
                    ["axiom-statement"] = "Statement",
                    ["axiom-remit"] = index < 90 ? remit.RecordId : null,
                },
                new("test", $"a{index}", "test"),
                index < 90 ? new Dictionary<string, long> { ["axiom-remit"] = remit.RecordVersion } : null));
        }

        var all = await service.CountRecordsAsync(new("axiom"));
        Assert.AreEqual(120, all.Count, "A count must not stop at a page boundary.");

        var related = await service.CountRecordsAsync(new("axiom")
        {
            Filters = [new("axiom-remit", "eq", JsonSerializer.SerializeToElement(remit.RecordId))],
        });
        Assert.AreEqual(90, related.Count, "The relation count must honour its filter.");

        var unassigned = await service.CountRecordsAsync(new("axiom")
        {
            Filters = [new("axiom-remit", "isNull")],
        });
        Assert.AreEqual(30, unassigned.Count);

        // A relation with nothing in it counts zero rather than failing.
        await service.CreateRecordAsync(new("remit", "remit-2",
            new Dictionary<string, object?> { ["remit-name"] = "Empty" }, new("test", "r2", "test")));
        var empty = await service.CountRecordsAsync(new("axiom")
        {
            Filters = [new("axiom-remit", "eq", JsonSerializer.SerializeToElement("remit-2"))],
        });
        Assert.AreEqual(0, empty.Count);
    }

    [TestMethod]
    public async Task ATileCompilesAndAnUnsupportedAggregateFailsClosed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Remit page with a tile", TiledRemitPage("count")));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        // The tile sits inside the relation it counts, not directly on the page.
        var relation = compiled.Applications.Single(app => app.Entity.SemanticId == "remit")
            .Surfaces.Single().Children.Single(node => node.Kind == "relatedList");
        var tile = relation.Children.Single(node => node.Kind == "summaryTile");
        Assert.AreEqual("count", tile.Properties["aggregate"].GetString());
        Assert.AreEqual("Axioms", tile.Properties["title"].GetString());
    }

    // avg carries its own refusal, because an author who asks for it is owed the
    // reason it cannot be exact rather than the generic unsupported list.
    [TestMethod]
    public async Task AverageIsRefusedByNameWithItsReason()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Average tile", TiledRemitPage("avg")));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid);
        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == "NUI292");
        Assert.IsNotNull(hit, $"Expected NUI292; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual("aggregate", hit.PropertyPath);
        StringAssert.Contains(hit.Message, "not generally an exact decimal");
        StringAssert.Contains(hit.Hint, "sum");
    }

    [TestMethod]
    public async Task AnUnknownAggregateFailsClosedAgainstTheAcceptedList()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Unknown tile", TiledRemitPage("median")));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid);
        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == "NUI291");
        Assert.IsNotNull(hit, $"Expected NUI291; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual("aggregate", hit.PropertyPath);
        StringAssert.Contains(hit.Hint, "count");
    }

    // A numeric aggregate reads one field. Declaring none is a diagnostic, never
    // a tile that quietly falls back to counting.
    [TestMethod]
    [DataRow("sum")]
    [DataRow("min")]
    [DataRow("max")]
    public async Task ANumericAggregateWithoutItsFieldFailsClosed(string aggregate)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await ConfiguredRegisterAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Fieldless tile", TiledRemitPage(aggregate)));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid);
        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == "NUI293");
        Assert.IsNotNull(hit, $"Expected NUI293; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual("fieldId", hit.PropertyPath);
    }

    private static NendoOperation[] TiledRemitPage(string aggregate)
    {
        var operations = RemitPage().ToList();
        operations.Add(new AddUiNodeOperation("tile-add", "remit-surface", "remit-axiom-count", "remit-axioms", "summaryTile", 2));
        operations.Add(new SetUiPropertyOperation("tile-aggregate", "remit-surface", "remit-axiom-count", "aggregate", aggregate));
        operations.Add(new SetUiPropertyOperation("tile-title", "remit-surface", "remit-axiom-count", "title", "Axioms"));
        return operations.ToArray();
    }

    // P6-D: one button sets several fields as one mutation against one expected
    // record version, and today resolves at execution rather than at compilation.
    [TestMethod]
    public async Task MultiStepCommandAppliesEveryFieldAsOneVersionedMutation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await CommandRegisterAsync(coordinator);
        await service.CreateRecordAsync(new("axiom", "axiom-1",
            new Dictionary<string, object?> { ["axiom-handle"] = "DATA-01", ["axiom-status"] = "draft" },
            new("test", "r1", "test")));

        var before = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(1, before.RecordVersion);

        var command = (await service.CompileSemanticUiAsync()).Applications.Single()
            .Surfaces.Single().Children.Single(node => node.Kind == "recordCommand");

        var result = await service.ExecuteCommandAsync(new NendoExecuteCommandRequest(
            command.SemanticId, "axiom-1", before.RecordVersion, new("test", "accept-1", "test")));
        Assert.IsFalse(result.IsIdempotentReplay);

        var after = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual("accepted", after.Values["axiom-status"].GetString(), "The literal step did not apply.");
        Assert.AreEqual(
            DateTimeOffset.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            after.Values["axiom-accepted"].GetString(),
            "today did not resolve at execution.");
        Assert.AreEqual(before.RecordVersion + 2, after.RecordVersion,
            "Two steps advance the record once each, inside one mutation.");

        // One mutation, so History shows one revision for the whole button.
        var history = await service.QueryHistoryAsync(new(50), default);
        Assert.AreEqual("Accept", history.Items[0].Description);
        Assert.AreEqual(2, history.Items[0].OperationCount);
    }

    [TestMethod]
    public async Task AStaleRecordVersionRejectsTheWholeCommand()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await CommandRegisterAsync(coordinator);
        await service.CreateRecordAsync(new("axiom", "axiom-1",
            new Dictionary<string, object?> { ["axiom-handle"] = "DATA-01", ["axiom-status"] = "draft" },
            new("test", "r1", "test")));
        var command = (await service.CompileSemanticUiAsync()).Applications.Single()
            .Surfaces.Single().Children.Single(node => node.Kind == "recordCommand");

        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ExecuteCommandAsync(
            new NendoExecuteCommandRequest(command.SemanticId, "axiom-1", 99, new("test", "accept-stale", "test"))));

        var after = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual("draft", after.Values["axiom-status"].GetString(), "A refused command must change nothing.");
        Assert.AreEqual(1, after.RecordVersion);
    }

    private static async Task CommandRegisterAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("axiom-create", "axiom", "Axiom", "axiom_records"),
            new AddFieldOperation("axiom-handle-create", "axiom", "axiom-handle", "Handle", "handle", NendoStorageKind.Text, true),
            new AddFieldOperation("axiom-status-create", "axiom", "axiom-status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["draft", "accepted"]),
            new AddFieldOperation("axiom-accepted-create", "axiom", "axiom-accepted", "Accepted", "accepted", NendoStorageKind.Date, false, "date", []),
        ]));
        await coordinator.ApplyAsync(new("test", "ui", "test", "Axiom page",
        [
            new AddUiNodeOperation("page-add", "axiom-surface", "axiom-page", null, "detailSurface", 0),
            new SetUiPropertyOperation("page-version", "axiom-surface", "axiom-page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("page-entity", "axiom-surface", "axiom-page", "entityId", "axiom"),
            new AddUiNodeOperation("handle-add", "axiom-surface", "axiom-handle-binding", "axiom-page", "fieldBinding", 0),
            new SetUiPropertyOperation("handle-field", "axiom-surface", "axiom-handle-binding", "fieldId", "axiom-handle"),
            new AddUiNodeOperation("command-add", "axiom-surface", "axiom-accept", "axiom-page", "recordCommand", 1),
            new SetUiPropertyOperation("command-version", "axiom-surface", "axiom-accept", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("command-entity", "axiom-surface", "axiom-accept", "entityId", "axiom"),
            new SetUiPropertyOperation("command-label", "axiom-surface", "axiom-accept", "label", "Accept"),
            new AddUiNodeOperation("step-status-add", "axiom-surface", "axiom-step-status", "axiom-accept", "commandStep", 0),
            new SetUiPropertyOperation("step-status-field", "axiom-surface", "axiom-step-status", "fieldId", "axiom-status"),
            new SetUiPropertyOperation("step-status-kind", "axiom-surface", "axiom-step-status", "valueKind", "literal"),
            new SetUiPropertyOperation("step-status-value", "axiom-surface", "axiom-step-status", "value", "accepted"),
            new AddUiNodeOperation("step-date-add", "axiom-surface", "axiom-step-date", "axiom-accept", "commandStep", 1),
            new SetUiPropertyOperation("step-date-field", "axiom-surface", "axiom-step-date", "fieldId", "axiom-accepted"),
            new SetUiPropertyOperation("step-date-kind", "axiom-surface", "axiom-step-date", "valueKind", "today"),
        ]));
    }

    // Remit has a name; Axiom references Remit. This is the Axiom Register shape
    // the P6 gate uses, reduced to what these assertions need.
    private static async Task ConfiguredRegisterAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("remit-create", "remit", "Remit", "remit_records"),
            new AddFieldOperation("remit-name-create", "remit", "remit-name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("axiom-create", "axiom", "Axiom", "axiom_records"),
            new AddFieldOperation("axiom-handle-create", "axiom", "axiom-handle", "Handle", "handle", NendoStorageKind.Text, true),
            new AddFieldOperation("axiom-statement-create", "axiom", "axiom-statement", "Statement", "statement", NendoStorageKind.Text, true),
            new AddFieldOperation("axiom-remit-create", "axiom", "axiom-remit", "Remit", "remit_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("axiom-super-create", "axiom", "axiom-supersedes", "Supersedes", "supersedes_id", NendoStorageKind.Reference, false),
        ]));
        await coordinator.ApplyAsync(new("test", "reference", "test", "Bind references",
        [
            new ConfigureReferenceOperation("bind-remit", "axiom", "axiom-remit", "remit", "remit-name", 1),
        ]));
    }

    private static NendoOperation[] RemitPage(string scenario = "none")
    {
        var (targetEntityId, viaFieldId) = scenario switch
        {
            "missingTarget" => ("absent", "axiom-remit"),
            "notAReference" => ("axiom", "axiom-handle"),
            // A real reference, but one that points at Axiom rather than at Remit.
            "pointsElsewhere" => ("axiom", "axiom-supersedes"),
            _ => ("axiom", "axiom-remit"),
        };

        var operations = new List<NendoOperation>
        {
            new AddUiNodeOperation("page-add", "remit-surface", "remit-page", null, "detailSurface", 0),
            new SetUiPropertyOperation("page-version", "remit-surface", "remit-page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("page-entity", "remit-surface", "remit-page", "entityId", "remit"),
            new AddUiNodeOperation("section-add", "remit-surface", "remit-scope", "remit-page", "section", 0),
            new SetUiPropertyOperation("section-title", "remit-surface", "remit-scope", "title", "Scope"),
            new AddUiNodeOperation("name-add", "remit-surface", "remit-name-binding", "remit-scope", "fieldBinding", 0),
            new SetUiPropertyOperation("name-field", "remit-surface", "remit-name-binding", "fieldId", "remit-name"),
            new AddUiNodeOperation("related-add", "remit-surface", "remit-axioms", "remit-page", "relatedList", 1),
            new SetUiPropertyOperation("related-target", "remit-surface", "remit-axioms", "targetEntityId", targetEntityId),
            new SetUiPropertyOperation("related-via", "remit-surface", "remit-axioms", "viaFieldId", viaFieldId),
            new SetUiPropertyOperation("related-title", "remit-surface", "remit-axioms", "title", "Axioms"),
        };

        if (scenario != "noBindings")
        {
            operations.Add(new AddUiNodeOperation("handle-add", "remit-surface", "axiom-handle-binding", "remit-axioms", "fieldBinding", 0));
            operations.Add(new SetUiPropertyOperation("handle-field", "remit-surface", "axiom-handle-binding", "fieldId", "axiom-handle"));
            operations.Add(new AddUiNodeOperation("statement-add", "remit-surface", "axiom-statement-binding", "remit-axioms", "fieldBinding", 1));
            operations.Add(new SetUiPropertyOperation("statement-field", "remit-surface", "axiom-statement-binding", "fieldId", "axiom-statement"));
        }

        return operations.ToArray();
    }
}
