using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// The file's full-text index (ADR-0028): built once by an operation, then kept in step with the
/// records by every commit. The check that matters is <c>SearchIndexDriftAsync</c>: it rebuilds what
/// the index should hold from the records themselves and names every row that differs, so each
/// write path is held to the records rather than to the index's own idea of them.
/// </summary>
[TestClass]
public sealed class SearchIndexTests
{
    private const string SearchLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-search-v1";

    private static int s_key;
    private static NendoRequestContext Context() => new("search-test", "key-" + Interlocked.Increment(ref s_key), "test");

    [TestMethod]
    public async Task AFileHasNoIndexUntilItIsBuiltAndTheBuildTakesTheRung()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);

        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.SearchRecordsAsync(new("garden")));
        Assert.AreEqual("search-index-missing", missing.Code);
        Assert.AreNotEqual(NendoFormat.SearchMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Writing records alone took the search rung.");

        var built = await service.BuildSearchIndexAsync(Context());
        Assert.IsFalse(built.IsIdempotentReplay);
        Assert.AreEqual(NendoFormat.SearchMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        await AssertInStep(coordinator);
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, await Find(service, "garden"));

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(SearchLayout, inspection.Layout);
        Assert.IsEmpty(inspection.Findings, string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
        Assert.IsTrue(inspection.CanAcquireWriteAuthority);
    }

    [TestMethod]
    public async Task EveryDataWriteKeepsTheIndexInStep()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        await service.CreateRecordAsync(new("notes", "n4", new Dictionary<string, object?> { ["title"] = "Compost", ["body"] = "Worms turn kitchen scraps into soil." }, Context()));
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "n4" }, await Find(service, "worms"));

        await service.SetFieldAsync(new("notes", "n4", "body", 1, "Beetles turn leaves into soil.", Context()));
        await AssertInStep(coordinator);
        Assert.IsEmpty(await Find(service, "worms"), "The old text is still found.");
        CollectionAssert.AreEqual(new[] { "n4" }, await Find(service, "beetles"));

        await service.SetFieldAsync(new("notes", "n4", "body", 2, null, Context()));
        await AssertInStep(coordinator);
        Assert.IsEmpty(await Find(service, "beetles"), "An emptied field is still found.");

        var deleted = await service.DeleteRecordAsync(new("notes", "n1", 1, Context()));
        await AssertInStep(coordinator);
        Assert.IsFalse((await Find(service, "garden")).Contains("n1"), "A deleted record is still found.");

        await service.CompensateRevisionAsync(deleted.RevisionId, "undo-delete");
        await AssertInStep(coordinator);
        CollectionAssert.Contains(await Find(service, "garden"), "n1", "Undoing the deletion did not bring its words back.");

        // A batch, as CSV import and the record writes route make one.
        await coordinator.ApplyAsync(new("search-test", "batch", "test", "Two at once", [
            new CreateRecordOperation("b1", "notes", "n5", new Dictionary<string, object?> { ["title"] = "Moss", ["body"] = "Shade lovers" }),
            new CreateRecordOperation("b2", "tasks", "t2", new Dictionary<string, object?> { ["task-title"] = "Water the moss" }),
        ]));
        await AssertInStep(coordinator);
        CollectionAssert.AreEquivalent(new[] { "n5", "t2" }, await Find(service, "moss"));
    }

    [TestMethod]
    public async Task DefinitionChangesReindexTheRecordTypesTheyTouch()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        async Task Definition(string key, params NendoOperation[] operations) =>
            await coordinator.ApplyAsync(new("search-test", key, "test", key, operations));
        async Task<long> Revision() => (await coordinator.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;

        await Definition("retire-body", new SetRetiredOperation("r1", "notes", "body", true, await Revision()));
        await AssertInStep(coordinator);
        Assert.IsEmpty(await Find(service, "pollinators"), "A retired field is still searched.");

        await Definition("reactivate-body", new SetRetiredOperation("r2", "notes", "body", false, await Revision()));
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "n2" }, await Find(service, "pollinators"));

        await Definition("retire-tasks", new SetRetiredOperation("r3", "tasks", null, true, await Revision()));
        await AssertInStep(coordinator);
        Assert.IsEmpty(await Find(service, "prune"), "A retired record type is still searched.");
        await Definition("reactivate-tasks", new SetRetiredOperation("r4", "tasks", null, false, await Revision()));
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "t1" }, await Find(service, "prune"));

        await Definition("add-summary", new AddFieldOperation("f1", "notes", "summary", "Summary", "summary", NendoStorageKind.Text, false));
        await service.SetFieldAsync(new("notes", "n3", "summary", 1, "Hedgerows shelter birds.", Context()));
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "n3" }, await Find(service, "hedgerows"));

        // Requiring a field rebuilds the record type's table, which renumbers its rowids; the
        // index is keyed by record ID and does not notice.
        await Definition("require-title", new SetFieldRequiredOperation("q1", "notes", "title", true, await Revision()));
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "n3" }, await Find(service, "hedgerows"));
    }

    [TestMethod]
    public async Task APromotedProposalIsIndexedOnTheActiveFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Add a note", "test", new NendoChangeSet([
                new NendoMutation("search-test", "proposal-note", "test", "Add a note", [
                    new CreateRecordOperation("p1", "notes", "n9", new Dictionary<string, object?> { ["title"] = "Orchard", ["body"] = "Apples and quinces" }),
                ]),
            ])));
        Assert.IsEmpty(await Find(service, "quinces"), "A proposal reached the active file before it was accepted.");
        var promoted = await service.PromoteProposalAsync(preview.ProposalId);
        Assert.IsTrue(promoted.Applied);
        await AssertInStep(coordinator);
        CollectionAssert.AreEqual(new[] { "n9" }, await Find(service, "quinces"));
    }

    /// <summary>
    /// The build operation itself in a reviewed proposal, sent as an agent or Build-Garden sends it:
    /// canonical JSON, validated on the clone with a line in the review, then promoted. Its first
    /// release refused at validate ("has no semantic diff mapping"), which no direct build exercised.
    /// </summary>
    [TestMethod]
    public async Task ABuildInAReviewedProposalIsDescribedAndPromoted()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);

        using var payload = System.Text.Json.JsonDocument.Parse("{}");
        var preview = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Build the search index", "test", new NendoCanonicalChangeSetRequest([
                new NendoCanonicalMutationRequest("search-test", "proposal-build", "test", "Build the search index", [
                    new NendoCanonicalOperationRequest("op-build", "application.buildSearchIndex", payload.RootElement.Clone()),
                ]),
            ])));
        var line = preview.SemanticDiff.Single(entry => entry.Kind == "buildSearchIndex");
        StringAssert.Contains(line.Summary, "search index");
        Assert.AreEqual(NendoReversibilityClass.IrreversibleDeclared, line.Reversibility);
        await Code("search-index-missing", () => service.SearchRecordsAsync(new("garden")));

        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        await AssertInStep(coordinator);
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, await Find(service, "garden"));
    }

    [TestMethod]
    public async Task WordsMatchAcrossFieldsAndNothingTypedIsSyntax()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        CollectionAssert.AreEqual(new[] { "n2" }, await Find(service, "wildflower pollinators"), "A title word and a body word are one match.");
        CollectionAssert.AreEquivalent(new[] { "n1", "t1" }, await Find(service, "garden -pollinators"), "A left-out word removes the whole record.");
        CollectionAssert.AreEqual(new[] { "n2" }, await Find(service, "\"bring pollinators\""), "A phrase is matched as one.");
        Assert.IsEmpty(await Find(service, "\"pollinators bring\""), "A phrase matched out of order.");
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, await Find(service, "gard"), "The last word is a prefix.");
        Assert.IsEmpty(await Find(service, "gard "), "A word followed by a space was still a prefix.");
        CollectionAssert.AreEqual(new[] { "n3" }, await Find(service, "cafe"), "An accent is folded.");
        CollectionAssert.AreEqual(new[] { "n3" }, await Find(service, "CAFÉ"));

        foreach (var typed in new[] { "title:garden", "NEAR(garden pollinators)", "*", "\"unclosed", "garden AND OR NOT", "-", "((", "body : x", "^garden", "\u0000\u0001", "" })
        {
            var page = await service.SearchRecordsAsync(new(typed));
            Assert.IsNotNull(page, typed);
        }
        CollectionAssert.AreEqual(new[] { "n1", "n2" }, (await Find(service, "garden AND")).Order().ToArray(),
            "AND is searched for as a word: both garden notes contain it.");
        Assert.IsEmpty(await Find(service, "*"), "A search of no words found something.");
        Assert.IsEmpty(await Find(service, "-garden"), "Leaving out a word alone found everything else.");

        await Code("search-too-long", () => service.SearchRecordsAsync(new(new string('a', NendoSearchLimits.MaximumTextLength + 1))));
        await Code("search-too-many-terms", () => service.SearchRecordsAsync(new(string.Join(' ', Enumerable.Range(0, 17).Select(i => "w" + i)))));
    }

    [TestMethod]
    public async Task HitsCarryTheirVersionLabelAndExcerptsAndATitleMatchRanksFirst()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        var page = await service.SearchRecordsAsync(new("garden"));
        Assert.AreEqual("n1", page.Items[0].RecordId, "The note titled with the word ranks above one that only mentions it.");
        var hit = page.Items[0];
        Assert.AreEqual("notes", hit.EntityId);
        Assert.AreEqual(1L, hit.Version);
        Assert.AreEqual("Kitchen garden", hit.Label);
        Assert.IsGreaterThan(page.Items[1].Score, hit.Score);
        var title = hit.Fields.Single(field => field.FieldId == "title");
        Assert.AreEqual("Kitchen garden", title.Snippet);
        Assert.AreEqual(new NendoTextRange(8, 6), title.Ranges.Single());
        Assert.AreEqual("garden", title.Snippet.Substring(title.Ranges[0].Start, title.Ranges[0].Length));
        Assert.IsFalse(hit.Fields.Any(field => field.Snippet.Contains('\u0002') || field.Snippet.Contains('\u0003')), "A marker leaked into an excerpt.");
    }

    [TestMethod]
    public async Task ScopePagingAndStaleCursors()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());

        CollectionAssert.AreEqual(new[] { "t1" }, (await service.SearchRecordsAsync(new("garden prune") { EntityIds = ["tasks"] })).Items.Select(hit => hit.RecordId).ToArray());
        CollectionAssert.AreEqual(new[] { "n1" }, (await service.SearchRecordsAsync(new("garden") { FieldIds = ["title"], EntityIds = ["notes"] })).Items.Select(hit => hit.RecordId).ToArray());
        await Code("entity-not-found", () => service.SearchRecordsAsync(new("garden") { EntityIds = ["nope"] }));
        await Code("field-not-found", () => service.SearchRecordsAsync(new("garden") { FieldIds = ["nope"] }));
        await Code("invalid-limit", () => service.SearchRecordsAsync(new("garden", 0)));

        var seen = new List<string>();
        var query = new NendoSearchQuery("garden", 1);
        var first = await service.SearchRecordsAsync(query);
        for (var page = first; ; page = await service.SearchRecordsAsync(query))
        {
            seen.AddRange(page.Items.Select(hit => hit.RecordId));
            if (page.NextCursor is null) break;
            query = query with { Cursor = page.NextCursor };
        }
        Assert.AreEqual("n1", seen[0]);
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, seen, "Paging lost or repeated a record.");
        await Code("invalid-cursor", () => service.SearchRecordsAsync(new("other", 1, first.NextCursor)));
        await service.SetFieldAsync(new("notes", "n3", "title", 1, "Changed", Context()));
        await Code("stale-cursor", () => service.SearchRecordsAsync(new("garden", 1, first.NextCursor)));
    }

    /// <summary>
    /// The index is derived, so the content digest that backup, restore and identity checks compare
    /// leaves it out: dropping the index from a copy leaves the digest exactly as it was.
    /// </summary>
    [TestMethod]
    public async Task TheContentDigestLeavesTheIndexOutAndABackupCarriesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await service.BuildSearchIndexAsync(Context());
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        var plan = await coordinator.PrepareBackupAsync(destination, "backup");
        await coordinator.CreateBackupAsync(plan.PlanId);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var indexed = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        var copy = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "without-index.nendo");
        File.Copy(workspace.FilePath, copy);
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = copy, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var drop = connection.CreateCommand();
            drop.CommandText = "DROP TABLE __nendo_search; DROP TABLE __nendo_search_doc;";
            await drop.ExecuteNonQueryAsync();
        }
        var dropped = await SqliteNendoStore.InspectAsync(copy, CancellationToken.None);
        Assert.IsNotNull(indexed.ContentDigest);
        Assert.AreEqual(indexed.ContentDigest, dropped.ContentDigest, "The digest changed with the index.");

        await using var restored = await NendoWriteCoordinator.OpenAsync(destination, "backup-reader");
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, await Find(new NendoApplicationService(restored), "garden"));
        await AssertInStep(restored);
    }

    [TestMethod]
    public async Task AReadOnlyFileIsSearchedFromItsRecords()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SeedAsync(coordinator);
        await new NendoApplicationService(coordinator).BuildSearchIndexAsync(Context());
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) | FileAttributes.ReadOnly);
        try
        {
            await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
            var service = new NendoApplicationService(reader);
            CollectionAssert.AreEqual(new[] { "n2" }, await Find(service, "wildflower pollinators"));
            var page = await service.SearchRecordsAsync(new("garden"));
            Assert.AreEqual("n1", page.Items[0].RecordId);
            Assert.AreEqual("Kitchen garden", page.Items[0].Label);
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
        }
    }

    [TestMethod]
    public async Task ANewFileIndexesOnlyTheRecordsItKeepsAndAFoldKeepsTheIndex()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        await coordinator.ApplyAsync(new("search-test", "keep-tasks", "test", "Keep tasks", [
            new SetKeptInNewFilesDefaultOperation("k1", "tasks", true, (await coordinator.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision),
        ]));
        await service.BuildSearchIndexAsync(Context());

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "fresh.nendo");
        await service.CreateNewFileAsync(destination, "new-1");
        await using (var fresh = await NendoWriteCoordinator.OpenAsync(destination, "fresh-reader"))
        {
            await AssertInStep(fresh);
            CollectionAssert.AreEqual(new[] { "t1" }, await Find(new NendoApplicationService(fresh), "garden"), "A left-out record is still found in the new file.");
        }

        coordinator.HistoryFoldPolicy = new(2, 1_000_000, 1);
        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold.nendo");
        var plan = await coordinator.PrepareBackupAsync(backup, "fold");
        await coordinator.CreateBackupAsync(plan.PlanId);
        await service.FoldHistoryAsync(plan.PlanId);
        await AssertInStep(coordinator);
        CollectionAssert.AreEquivalent(new[] { "n1", "n2", "t1" }, await Find(service, "garden"));
    }

    /// <summary>
    /// A damaged index is caught where any damaged file is: SQLite's integrity check reads FTS5's
    /// own structure, so the file is refused at open rather than answering searches wrongly.
    /// </summary>
    [TestMethod]
    public async Task ADamagedIndexFailsTheIntegrityCheckAtOpen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SeedAsync(coordinator);
        await new NendoApplicationService(coordinator).BuildSearchIndexAsync(Context());
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var tamper = connection.CreateCommand();
            tamper.CommandText = "UPDATE __nendo_search_content SET c0 = 'tampered' WHERE id = (SELECT MIN(id) FROM __nendo_search_content);";
            Assert.AreEqual(1, await tamper.ExecuteNonQueryAsync());
        }
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("integrity-failed", inspection.Findings.Single().Code);
    }

    /// <summary>
    /// The layout signature leaves FTS5's own tables out because SQLite writes their DDL. Pinned
    /// here so a SQLite upgrade that writes them differently is noticed rather than silently
    /// accepted: the index would still open, but the shape would have moved.
    /// </summary>
    [TestMethod]
    public async Task TheIndexTablesAreTheOnesThisSqliteWrites()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await new NendoApplicationService(coordinator).BuildSearchIndexAsync(Context());
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var ddl = new Dictionary<string, string>();
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT name, sql FROM sqlite_schema WHERE name LIKE '\\_\\_nendo\\_search\\_%' ESCAPE '\\' AND type = 'table' ORDER BY name;";
            await using var rows = await command.ExecuteReaderAsync();
            while (await rows.ReadAsync()) ddl[rows.GetString(0)] = rows.GetString(1);
        }
        var expected = new Dictionary<string, string>
        {
            ["__nendo_search_config"] = "CREATE TABLE '__nendo_search_config'(k PRIMARY KEY, v) WITHOUT ROWID",
            ["__nendo_search_content"] = "CREATE TABLE '__nendo_search_content'(id INTEGER PRIMARY KEY, c0)",
            ["__nendo_search_data"] = "CREATE TABLE '__nendo_search_data'(id INTEGER PRIMARY KEY, block BLOB)",
            ["__nendo_search_docsize"] = "CREATE TABLE '__nendo_search_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
            ["__nendo_search_idx"] = "CREATE TABLE '__nendo_search_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
        };
        foreach (var (name, sql) in expected) Assert.AreEqual(sql, ddl.GetValueOrDefault(name), name);
        CollectionAssert.AreEquivalent(expected.Keys.Append("__nendo_search_doc").ToArray(), ddl.Keys.ToArray());
        CollectionAssert.AreEquivalent(expected.Keys.ToArray(), SqliteNendoStore.SearchShadowTables.ToArray());
    }

    [TestMethod]
    public void TypedTextBecomesQuotedTerms()
    {
        var terms = SearchTerms.Parse("title:garden \"two words\" -NEAR gard");
        CollectionAssert.AreEqual(new[] { "\"title:garden\"", "\"two words\"", "\"gard\"*" }, terms.Required.ToArray());
        CollectionAssert.AreEqual(new[] { "\"NEAR\"" }, terms.Excluded.ToArray());
        Assert.IsEmpty(SearchTerms.Parse("* ( ) - :").Required);
        Assert.AreEqual("\"a\" OR \"b\"*", SearchTerms.Parse("a b").Any);
    }

    // ---------------------------------------------------------------- helpers

    private static async Task SeedAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("search-test", "schema", "test", "Search fixture", [
            new CreateEntityOperation("e1", "notes", "Notes", "data_notes"),
            new AddFieldOperation("f-title", "notes", "title", "Title", "title", NendoStorageKind.Text, false),
            new AddFieldOperation("f-body", "notes", "body", "Body", "body", NendoStorageKind.Text, false, "longText"),
            new AddFieldOperation("f-count", "notes", "count", "Count", "count", NendoStorageKind.Integer, false),
            new CreateEntityOperation("e2", "tasks", "Tasks", "data_tasks"),
            new AddFieldOperation("f-task", "tasks", "task-title", "Title", "title", NendoStorageKind.Text, false),
        ]));
        await coordinator.ApplyAsync(new("search-test", "records", "test", "Search records", [
            new CreateRecordOperation("c1", "notes", "n1", new Dictionary<string, object?> { ["title"] = "Kitchen garden", ["body"] = "Beans and leeks. Herbs and garden mint.", ["count"] = 3 }),
            new CreateRecordOperation("c2", "notes", "n2", new Dictionary<string, object?> { ["title"] = "Wildflower meadow", ["body"] = "A corner of the garden left wild, to bring pollinators and birds back in a long, slow summer and autumn." }),
            new CreateRecordOperation("c3", "notes", "n3", new Dictionary<string, object?> { ["title"] = "Café visits", ["body"] = null }),
            new CreateRecordOperation("c4", "tasks", "t1", new Dictionary<string, object?> { ["task-title"] = "Prune the garden roses" }),
        ]));
    }

    private static async Task<string[]> Find(NendoApplicationService service, string text) =>
        [.. (await service.SearchRecordsAsync(new(text, NendoSearchLimits.MaximumPage))).Items.Select(hit => hit.RecordId)];

    private static async Task AssertInStep(NendoWriteCoordinator coordinator)
    {
        var drift = await coordinator.SearchIndexDriftAsync();
        Assert.IsEmpty(drift, "The index drifted from the records:\n" + string.Join('\n', drift));
    }

    private static async Task Code(string code, Func<Task> action) =>
        Assert.AreEqual(code, (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
