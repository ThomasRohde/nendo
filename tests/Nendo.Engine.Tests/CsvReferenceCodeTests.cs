using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// W-075: a CSV names a parent by its code, as a spreadsheet does, and the import resolves
/// the code, writes parents first, and refuses a code that names nothing or two things by
/// its row. Measured through the person's importer: batches prepared, accepted, promoted.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class CsvReferenceCodeTests
{
    private const string Entity = "caps";

    [TestMethod]
    public async Task AFiveLevelTreeWrittenChildrenFirstImportsInOneRunParentsFirst()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);

        // Deepest first: every row names a parent that only appears further down the file.
        var csv = Csv(
            ("1.1.1.1.1", "Five", "1.1.1.1"),
            ("1.1.1.1", "Four", "1.1.1"),
            ("1.1.1", "Three", "1.1"),
            ("1.2", "Two again", "1"),
            ("1.1", "Two", "1"),
            ("1", "One", ""));
        var imported = await ImportAsync(service, csv);

        Assert.AreEqual(6, imported);
        var records = (await service.GetSnapshotAsync()).Records.Where(record => record.EntityId == Entity).ToArray();
        var byId = records.ToDictionary(record => record.RecordId);
        string? ParentCode(NendoRecordSnapshot record) =>
            record.Values["parent"].ValueKind == System.Text.Json.JsonValueKind.Null
                ? null
                : byId[record.Values["parent"].GetString()!].Values["code"].GetString();
        var parents = records.ToDictionary(record => record.Values["code"].GetString()!, ParentCode);
        Assert.AreEqual("1.1.1.1", parents["1.1.1.1.1"]);
        Assert.AreEqual("1.1", parents["1.1.1"]);
        Assert.AreEqual("1", parents["1.2"]);
        Assert.IsNull(parents["1"]);
        int Depth(NendoRecordSnapshot record) => ParentCode(record) is { } code
            ? 1 + Depth(records.Single(other => other.Values["code"].GetString() == code))
            : 1;
        Assert.AreEqual(5, records.Max(Depth));
    }

    [TestMethod]
    public async Task ACodeThatNamesNothingIsRefusedByItsRowAndNothingIsWritten()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        var before = (await service.GetSnapshotAsync()).Records.Count;

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => ImportAsync(service,
            Csv(("1", "One", ""), ("1.1", "Two", "9.9"))));
        StringAssert.Contains(refused.Message, "CSV row 3, Parent");
        StringAssert.Contains(refused.Message, "No Capabilities has Code “9.9”.");
        Assert.HasCount(before, (await service.GetSnapshotAsync()).Records, "A refused import wrote records.");
    }

    [TestMethod]
    public async Task ACodeOnTwoRowsIsRefusedByTheRowThatUsesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => ImportAsync(service,
            Csv(("1", "One", ""), ("1", "One again", ""), ("1.1", "Two", "1"))));
        StringAssert.Contains(refused.Message, "CSV row 4, Parent");
        StringAssert.Contains(refused.Message, "is on more than one CSV row");
    }

    [TestMethod]
    public async Task ACodeResolvesToARecordTheFileAlreadyHoldsWhateverItsCase()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await service.CreateRecordAsync(new(Entity, "existing-root",
            new Dictionary<string, object?> { ["code"] = "CAP-1", ["name"] = "Root" }, new("test", "root", "test")));

        Assert.AreEqual(1, await ImportAsync(service, Csv(("CAP-1.1", "Child", "cap-1"))));
        var child = (await service.GetSnapshotAsync()).Records.Single(record => record.Values["code"].GetString() == "CAP-1.1");
        Assert.AreEqual("existing-root", child.Values["parent"].GetString());
    }

    [TestMethod]
    public async Task ParentsThatNameEachOtherAreRefusedByRow()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => ImportAsync(service,
            Csv(("a", "A", "b"), ("b", "B", "a"))));
        StringAssert.Contains(refused.Message, "leads back to itself");
        StringAssert.Contains(refused.Message, "CSV row");
    }

    [TestMethod]
    public async Task OnlyAUniqueFieldCanNameATarget()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => ImportAsync(service,
            Csv(("1", "One", "")), matchFieldId: "name"));
        StringAssert.Contains(refused.Message, "can be matched only by a unique field");
    }

    [TestMethod]
    public async Task TheNorthstarModelImportsFromItsOneCsv()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        var csv = await File.ReadAllTextAsync(Path.Combine(RepositoryRoot(), "tools", "bcm-atlas", "northstar-capabilities.csv"));

        Assert.AreEqual(635, await ImportAsync(service, csv));
        var records = (await service.GetSnapshotAsync()).Records.Where(record => record.EntityId == Entity).ToArray();
        var byId = records.ToDictionary(record => record.RecordId);
        var rows = csv.TrimEnd().Split('\n').Skip(1).Select(line => line.Split("\",\"").Select(cell => cell.Trim('"')).ToArray()).ToArray();
        foreach (var row in rows)
        {
            var record = records.Single(candidate => candidate.Values["code"].GetString() == row[0]);
            var parent = record.Values["parent"];
            Assert.AreEqual(row[2].Length == 0 ? null : row[2],
                parent.ValueKind == System.Text.Json.JsonValueKind.Null ? null : byId[parent.GetString()!].Values["code"].GetString(),
                $"{row[0]} has the wrong parent.");
        }
    }

    /// <summary>The person's importer: parents first, then each batch prepared and accepted.</summary>
    private static async Task<int> ImportAsync(NendoApplicationService service, string csv, string matchFieldId = "code")
    {
        var document = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes(csv));
        NendoCsvMapping[] mappings =
        [
            new(0, "code"),
            new(1, "name"),
            new(2, "parent") { MatchFieldId = matchFieldId },
        ];
        var options = new NendoCsvOptions(false, EmptyIsNull: true);
        document = await service.OrderCsvParentsFirstAsync(document, Entity, mappings);
        var committed = 0;
        while (committed < document.Rows.Count)
        {
            var batch = await service.PrepareCsvBatchAsync(document, Entity, mappings, options, committed, Guid.NewGuid().ToString("N"));
            Assert.AreEqual(NendoProposalState.Previewable, batch.Proposal.State,
                string.Join("; ", batch.Proposal.Diagnostics.Select(diagnostic => diagnostic.Message)));
            var promoted = await service.PromoteProposalAsync(batch.Proposal.ProposalId, CancellationToken.None, batch.Proposal.OperationDigest);
            Assert.IsTrue(promoted.Applied, promoted.Message);
            committed += batch.Rows.Count;
        }
        return committed;
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "caps", "test", "Capabilities", [
            new CreateEntityOperation("e", Entity, "Capabilities", "caps"),
            new AddFieldOperation("f-code", Entity, "code", "Code", "code", NendoStorageKind.Text, true),
            new AddFieldOperation("f-name", Entity, "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("f-parent", Entity, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", Entity, "parent", Entity, "name", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "rules", "test", "Unique code and the tree", [
            new SetFieldUniqueOperation("unique-code", Entity, "code", true, revision),
            new DeclareHierarchyOperation("tree", Entity, "parent", null, revision),
        ]));
    }

    private static string Csv(params (string Code, string Name, string Parent)[] rows) =>
        "Code,Name,Parent\n" + string.Join("\n", rows.Select(row => $"{row.Code},{row.Name},{row.Parent}")) + "\n";

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) return directory.FullName;
        throw new AssertFailedException("The repository root (Nendo.slnx) was not found above the test binaries.");
    }
}
