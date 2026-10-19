using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Queries, CSV, numbers, dates and locales: each test holds one defect and the rule that
/// keeps it out.
/// </summary>
[TestClass]
public sealed class QueryCsvLocaleReviewTests
{
    private static NendoCsvDocument Parse(string text) => NendoCsvProfile.Parse(Encoding.UTF8.GetBytes(text));

    /// <summary>A blank line is not a row, in a one-column file or a wider one.</summary>
    [TestMethod]
    public void ABlankLineIsNotARow()
    {
        var single = Parse("Name\nAnna\n\n");
        CollectionAssert.AreEqual(new[] { "Anna" }, single.Rows.Select(row => row[0]).ToArray(), "A trailing blank line became an empty record.");
        var wider = Parse("Name,Due\r\nAnna,2026-10-10\r\n\r\nBo,2026-10-11\r\n\r\n");
        Assert.HasCount(2, wider.Rows, "A blank line in a two-column file was read as a row.");
        Assert.AreEqual(4, wider.SourceRowNumber(1), "A row after a blank line is not named by the row a person counts to.");
        // A quoted empty cell is a value, not a blank line.
        Assert.HasCount(2, Parse("Name\nAnna\n\"\"\n").Rows, "A quoted empty cell was dropped as a blank line.");
    }

    /// <summary>A spreadsheet's empty trailing columns are dropped; a bad header names its column.</summary>
    [TestMethod]
    public void EmptyTrailingColumnsAreDroppedAndAHeaderRefusalNamesItsColumn()
    {
        var trailing = Parse("Name,Due,,\nAnna,2026-10-10,,\n");
        CollectionAssert.AreEqual(new[] { "Name", "Due" }, trailing.Headers.ToArray(), "Empty trailing columns blocked the import.");
        CollectionAssert.AreEqual(new[] { "Anna", "2026-10-10" }, trailing.Rows[0].ToArray());

        var duplicate = Assert.ThrowsExactly<NendoValidationException>(() => Parse("Name,Due,Name\nA,B,C\n"));
        StringAssert.Contains(duplicate.Message, "CSV columns 1 and 3 are both “Name”", "The duplicate refusal does not name the header and its columns.");
        var blank = Assert.ThrowsExactly<NendoValidationException>(() => Parse("Name,,Due\nA,B,C\n"));
        StringAssert.Contains(blank.Message, "CSV column 2 has no header", "The blank-header refusal does not name the column.");
    }

    /// <summary>A value refusal names the form its kind expects and the value it got.</summary>
    [TestMethod]
    [DataRow(NendoStorageKind.Boolean, "TRUE", "expects true or false")]
    [DataRow(NendoStorageKind.Date, "10-10-2026", "expects a date as yyyy-MM-dd")]
    [DataRow(NendoStorageKind.Decimal, " 1.5", "with a dot for decimals")]
    [DataRow(NendoStorageKind.Integer, "1,000", "expects a whole number")]
    [DataRow(NendoStorageKind.DateTime, "2026-10-25 14:30", "with Z or an offset")]
    [DataRow(NendoStorageKind.Uuid, "not-a-uuid", "expects a UUID in its hyphenated form")]
    public void AValueRefusalNamesTheFormItsKindExpects(NendoStorageKind kind, string cell, string expected)
    {
        var field = new NendoFieldSnapshot("f", "Field", kind, false, null, []);
        var refused = Assert.ThrowsExactly<NendoValidationException>(() => NendoCsvProfile.Decode(cell, field, new(false)));
        StringAssert.Contains(refused.Message, expected, $"The {kind} refusal does not say what it expects.");
        StringAssert.Contains(refused.Message, $"got “{cell}”", $"The {kind} refusal does not say what it got.");
    }

    /// <summary>
    /// An export file starts with UTF-8's byte-order mark, so a spreadsheet opened on it
    /// reads æ, ø and å, and the importer reads the file back to the same rows.
    /// </summary>
    [TestMethod]
    public async Task AnExportFileCarriesTheByteOrderMarkAndReadsBackTheSame()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "places", "Places", "places"),
            new AddFieldOperation("f", "places", "name", "Name", "name", NendoStorageKind.Text, true)]));
        await service.CreateRecordAsync(new("places", "p1", new Dictionary<string, object?> { ["name"] = "Brødkurv på Ærø" }, new("test", "p1", "test")));

        // The method the Desktop's Export CSV writes its file with.
        using var stream = new MemoryStream();
        Assert.AreEqual(1, await service.ExportCsvFileAsync("places", stream));
        var bytes = stream.ToArray();
        CollectionAssert.AreEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes.Take(3).ToArray(), "The export has no byte-order mark, so a spreadsheet reads it in the ANSI code page.");
        var read = NendoCsvProfile.Parse(bytes);
        Assert.AreEqual("Name", read.Headers[0], "The mark became part of the first header.");
        Assert.AreEqual("Brødkurv på Ærø", read.Rows[0][0]);
    }

    /// <summary>
    /// An Engine step that reads a whole set reads it from one change. A commit between
    /// two pages makes the next page's cursor stale; the read starts again rather than failing
    /// a move or an import with a paging message the person never asked for.
    /// </summary>
    [TestMethod]
    public async Task AWholeReadStartsAgainWhenSomebodyCommitsBetweenItsPages()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "places", "Places", "places"),
            new AddFieldOperation("f", "places", "name", "Name", "name", NendoStorageKind.Text, true)]));
        for (var index = 0; index < 5; index++)
            await service.CreateRecordAsync(new("places", $"p{index}", new Dictionary<string, object?> { ["name"] = $"Place {index}" }, new("test", $"p{index}", "test")));

        var interrupted = false;
        var read = await NendoWholeRead.AllAsync(async cursor =>
        {
            var page = await service.QueryRecordsAsync(new("places", 2, cursor));
            if (cursor is null && !interrupted)
            {
                interrupted = true;
                await service.CreateRecordAsync(new("places", "p9", new Dictionary<string, object?> { ["name"] = "Elsewhere" }, new("test", "p9", "test")));
            }
            return page;
        });
        Assert.IsTrue(interrupted);
        CollectionAssert.AreEqual(new[] { "p0", "p1", "p2", "p3", "p4", "p9" }, read.Select(record => record.RecordId).Order(StringComparer.Ordinal).ToArray(),
            "The whole read did not start again from one change.");
    }

    /// <summary>
    /// A sort by a single choice reads in its options' configured order and a sort by a
    /// reference by its target's label, page by page. A UUID filter matches the value in
    /// either case. Both on the writable path and on the read-only one.
    /// </summary>
    [TestMethod]
    public async Task ChoicesSortInTheirOrderReferencesByLabelAndUuidsInEitherCase()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("c", "customers", "Customers", "customers"),
            new AddFieldOperation("c-name", "customers", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("t", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-status", "tasks", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["todo", "doing", "done"]),
            new AddFieldOperation("t-customer", "tasks", "customer", "Customer", "customer_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("t-external", "tasks", "external", "External ID", "external", NendoStorageKind.Uuid, false),
            new ConfigureReferenceOperation("bind", "tasks", "customer", "customers", "name", 0)]));
        foreach (var (id, name) in new[] { ("c1", "Zeta"), ("c2", "Alpha"), ("c3", "Mid") })
            await service.CreateRecordAsync(new("customers", id, new Dictionary<string, object?> { ["name"] = name }, new("test", id, "test")));
        foreach (var (id, status, customer, external) in new[]
        {
            ("t1", "done", "c1", "6F9619FF-8B86-D011-B42D-00C04FC964FF"),
            ("t2", "todo", "c2", "95e7a1b4-c54a-41bb-83cc-9eae7adf61bb"),
            ("t3", "doing", "c3", "0e1c7a2f-1d2b-4c3d-8e4f-5a6b7c8d9e0f"),
        })
            await service.CreateRecordAsync(new("tasks", id, new Dictionary<string, object?> { ["status"] = status, ["customer"] = customer, ["external"] = external },
                new("test", id, "test"), new Dictionary<string, long> { ["customer"] = 1 }));

        await AssertOrdersAsync(service, "writable");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        await AssertOrdersAsync(new NendoApplicationService(readOnly), "read-only");

        static async Task AssertOrdersAsync(NendoApplicationService app, string path)
        {
            CollectionAssert.AreEqual(new[] { "t2", "t3", "t1" }, await SortedAsync(app, "status"),
                $"A sort by a choice did not read To do, Doing, Done ({path}).");
            CollectionAssert.AreEqual(new[] { "t2", "t3", "t1" }, await SortedAsync(app, "customer"),
                $"A sort by a reference did not read in its labels' order ({path}).");
            var lower = JsonSerializer.SerializeToElement("6f9619ff-8b86-d011-b42d-00c04fc964ff");
            CollectionAssert.AreEqual(new[] { "t1" }, (await app.QueryRecordsAsync(new("tasks") { Filters = [new("external", "eq", lower)] })).Items.Select(item => item.RecordId).ToArray(),
                $"A UUID in the other case matched nothing ({path}).");
            CollectionAssert.AreEqual(new[] { "t2", "t3" }, (await app.QueryRecordsAsync(new("tasks") { Filters = [new("external", "ne", lower)] })).Items.Select(item => item.RecordId).ToArray(),
                $"A UUID in the other case did not exclude its record ({path}).");
        }

        static async Task<string[]> SortedAsync(NendoApplicationService app, string field)
        {
            // One record a page, so the cursor's place in the order is read as well.
            var ids = new List<string>();
            string? cursor = null;
            do
            {
                var page = await app.QueryRecordsAsync(new("tasks", 1, cursor) { SortFieldId = field });
                ids.AddRange(page.Items.Select(item => item.RecordId));
                cursor = page.NextCursor;
            } while (cursor is not null);
            return [.. ids];
        }
    }

    /// <summary>
    /// A file opened read-only refuses the aggregates the file refuses, for the same
    /// reason: a field it does not have, a kind that cannot be folded, a bucket field that is not
    /// a Date, and a whole-number sum past what a whole number holds.
    /// </summary>
    [TestMethod]
    public async Task AReadOnlyFileRefusesTheAggregatesTheFileRefuses()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "items", "Items", "items"),
            new AddFieldOperation("title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("flag", "items", "flag", "Flag", "flag", NendoStorageKind.Boolean, false),
            new AddFieldOperation("other", "items", "other", "Other", "other", NendoStorageKind.Boolean, false),
            new AddFieldOperation("amount", "items", "amount", "Amount", "amount", NendoStorageKind.Integer, false),
            new AddFieldOperation("at", "items", "at", "At", "at", NendoStorageKind.DateTime, false)]));
        foreach (var id in new[] { "a", "b" })
            await service.CreateRecordAsync(new("items", id, new Dictionary<string, object?> {
                ["title"] = "2026-10-1" + (id == "a" ? "0" : "1"), ["flag"] = true, ["other"] = false, ["amount"] = long.MaxValue,
                ["at"] = "2026-10-10T12:00:00+02:00" }, new("test", id, "test")));

        var questions = new (string Name, Func<NendoApplicationService, Task> Ask)[]
        {
            ("sum over a type the file lacks", app => app.AggregateRecordsAsync(new("missing", "sum", "amount"))),
            ("sum of a field the type lacks", app => app.AggregateRecordsAsync(new("items", "sum", "missing"))),
            ("sum of text", app => app.AggregateRecordsAsync(new("items", "sum", "title"))),
            ("min of text holding dates", app => app.AggregateRecordsAsync(new("items", "min", "title"))),
            ("whole-number sum past its range", app => app.AggregateRecordsAsync(new("items", "sum", "amount"))),
            ("grouped sum of text", app => app.GroupAggregateRecordsAsync(new("items", "flag", "sum", "title"))),
            ("grouped sum of a field the type lacks", app => app.GroupAggregateRecordsAsync(new("items", "flag", "sum", "missing"))),
            ("buckets of a date and time", app => app.BucketAggregateRecordsAsync(new("items", "at", "month", "last6Months", "count"))),
            ("bucketed sum of text", app => app.BucketAggregateRecordsAsync(new("items", "at", "month", "last6Months", "sum", "title"))),
            ("crossed sum of text", app => app.CellAggregateRecordsAsync(new("items", "flag", "other", "sum", "title"))),
        };
        var writable = new List<string>();
        foreach (var (_, ask) in questions) writable.Add(await RefusalAsync(() => ask(service)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var safe = new NendoApplicationService(readOnly);
        for (var index = 0; index < questions.Length; index++)
            Assert.AreEqual(writable[index], await RefusalAsync(() => questions[index].Ask(safe)),
                $"Read-only, the {questions[index].Name} was answered differently from the file.");

        static async Task<string> RefusalAsync(Func<Task> ask)
        {
            try { await ask(); return "answered"; }
            catch (NendoException refusal) { return $"{refusal.GetType().Name} {(refusal as NendoPreconditionException)?.Code}: {refusal.Message}"; }
        }
    }

    /// <summary>
    /// The fold's own texts read the same under any regional format: a Thai one, whose
    /// calendar counts the Buddhist era, with a group separator after every digit.
    /// </summary>
    [TestMethod]
    public async Task FoldTextsReadTheSameUnderAnyRegionalFormat()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "notes", "Notes", "notes"),
            new AddFieldOperation("f", "notes", "label", "Label", "label", NendoStorageKind.Text, false)]));
        for (var index = 0; index < 12; index++)
            await service.CreateRecordAsync(new("notes", $"n{index}", new Dictionary<string, object?> { ["label"] = $"Note {index}" }, new("test", $"n{index}", "test")));
        var first = (await service.GetHistoryAsync())[3].RevisionId;

        var regional = (CultureInfo)CultureInfo.GetCultureInfo("th-TH").Clone();
        regional.NumberFormat.NumberGroupSizes = [1];
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = regional;
            coordinator.HistoryFoldPolicy = new(50, 100_000, 50);
            var nothing = await service.PreviewHistoryFoldAsync();
            Assert.IsFalse(nothing.CanFold);
            StringAssert.Matches(nothing.Reason, new System.Text.RegularExpressions.Regex(@"^This file has \d+ changes .* the most recent \d+ of them\.$"),
                "The reason a fold has nothing to take follows the regional number format.");

            coordinator.HistoryFoldPolicy = new(5, 1_000, 2);
            var plan = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold.nendo"), "before-fold");
            await coordinator.CreateBackupAsync(plan.PlanId);
            await service.FoldHistoryAsync(plan.PlanId);
            var folded = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(first, "undo-folded"));
            StringAssert.Contains(folded.Message, $"folded on {DateTimeOffset.UtcNow.ToString("yyyy", CultureInfo.InvariantCulture)}-",
                "The date a fold is refused by is in the regional calendar.");
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
    }

    /// <summary>
    /// The Engine reads the machine's time zone again from Windows within a minute, so a
    /// zone changed under a running Nendo moves the Engine's today as it moves the Workbench's,
    /// and a chart range is resolved against the zone as it is now.
    /// </summary>
    [TestMethod]
    [DoNotParallelize]
    public async Task TheEnginesTodayFollowsAZoneChangeWithinAMinute()
    {
        var ticks = NendoCivilClock.Ticks;
        var forget = NendoCivilClock.ForgetZone;
        var now = long.MaxValue / 2;
        var forgotten = 0;
        try
        {
            NendoCivilClock.Ticks = () => now;
            NendoCivilClock.ForgetZone = () => forgotten++;
            _ = NendoCivilClock.LocalZone();
            Assert.AreEqual(1, forgotten, "The Engine kept the zone it read when the process started.");
            now += 30_000;
            _ = NendoCivilClock.Today();
            Assert.AreEqual(1, forgotten, "The zone was read from Windows again within the minute.");
            now += 31_000;
            _ = NendoCivilClock.Today();
            Assert.AreEqual(2, forgotten, "A minute later the Engine still used the zone it had cached.");

            await using var workspace = new EngineTestWorkspace();
            var coordinator = await workspace.CreateAsync();
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
                new CreateEntityOperation("e", "items", "Items", "items"),
                new AddFieldOperation("f", "items", "due", "Due", "due", NendoStorageKind.Date, false)]));
            now += 61_000;
            await service.BucketAggregateRecordsAsync(new("items", "due", "month", "last6Months", "count"));
            Assert.AreEqual(3, forgotten, "A chart range was resolved against a zone the Engine had cached.");
        }
        finally
        {
            NendoCivilClock.Ticks = ticks;
            NendoCivilClock.ForgetZone = forget;
            // The stand-in clock ran far ahead of the real one; later reads must not wait for it.
            NendoCivilClock.Restart();
        }
    }

    /// <summary>
    /// A term made only of letters outside the Basic
    /// Multilingual Plane is a term, not dropped as punctuation.
    /// </summary>
    [TestMethod]
    public void ATermOfLettersPastTheBasicPlaneIsATerm()
    {
        var terms = SearchTerms.Parse("𝐀𝐁 notes");
        CollectionAssert.AreEqual(new[] { "\"𝐀𝐁\"", "\"notes\"*" }, terms.Required.ToArray(),
            "A word of letters from past the Basic Multilingual Plane was dropped from the search.");
    }

    /// <summary>
    /// At the call sites: the CSV code resolver reads through the whole read, so
    /// a commit between its pages starts the read again rather than failing the import. A move's
    /// sibling scan is one statement (ADR-0019), so no
    /// commit can fall between its pages, and the move still lands with the hook in place.
    /// </summary>
    [TestMethod]
    public async Task AnImportAndAMoveSurviveACommitBetweenTheirPages()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("p", "projects", "Projects", "projects"),
            new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, true),
            new AddFieldOperation("p-ord", "projects", "ord", "Order", "ord", NendoStorageKind.Integer, false),
            new AddFieldOperation("p-parent", "projects", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("p-bind", "projects", "parent", "projects", "code", 0),
            new CreateEntityOperation("t", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("t-bind", "tasks", "project", "projects", "code", 0)]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "rules", "test", "Unique code and the tree", [
            new SetFieldUniqueOperation("unique-code", "projects", "code", true, revision),
            new DeclareHierarchyOperation("tree", "projects", "parent", "ord", revision)]));
        for (var batch = 0; batch < 3; batch++)
            await service.CreateRecordsAsync(new("projects", Enumerable.Range(batch * 50, 50)
                .Select(index => new NendoCreateRecordEntry($"p{index}", new Dictionary<string, object?> { ["code"] = $"P-{index}", ["ord"] = (index + 1) * 1000L }))
                .ToArray(), new("test", $"projects-{batch}", "test")));

        var commits = 0;
        NendoWholeRead.BetweenPages.Value = async () =>
        {
            if (commits++ > 0) return;
            await service.CreateRecordAsync(new("tasks", $"elsewhere-{commits}", new Dictionary<string, object?> { ["title"] = "Elsewhere" }, new("test", $"elsewhere-{commits}", "test")));
        };
        try
        {
            var document = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes("Project,Title\nP-140,A task\n"));
            var batch = await service.PrepareCsvBatchAsync(document, "tasks",
                [new NendoCsvMapping(0, "project") { MatchFieldId = "code" }, new NendoCsvMapping(1, "title")],
                new NendoCsvOptions(false), 0, Guid.NewGuid().ToString("N"));
            Assert.IsGreaterThan(0, commits, "The code resolver did not read its target through the whole read, so a commit between its pages fails the import.");
            Assert.AreEqual(NendoProposalState.Previewable, batch.Proposal.State,
                string.Join("; ", batch.Proposal.Diagnostics.Select(diagnostic => diagnostic.Message)));

            commits = 0;
            var moved = await service.MoveRecordAsync(new("projects", "p149", 1, null, null, "p5", new("test", "move", "test")));
            Assert.AreEqual(0, commits, "A move read its siblings in pages again, where one statement reads them from one change.");
            Assert.IsNotNull(moved);
        }
        finally
        {
            NendoWholeRead.BetweenPages.Value = null;
        }
    }
}
