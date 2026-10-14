using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The 1.x promise (ADR-0012, 2026-10-14 amendment, W-235): a file Nendo 1.0.0 opens normally,
/// every later 1.x opens normally, with its definitions and data intact. Each file under
/// Fixtures/Format1 is a file as 1.0 read it, frozen; beside it is the record of what 1.0 read
/// back. A later host that opens one in safe mode, refuses it, or reads back anything else has
/// broken the promise, and that takes 2.0 and an ADR, not a new fixture.
/// </summary>
[TestClass]
public sealed class FormatPromiseTests
{
    private const string BuildVariable = "NENDO_WRITE_FORMAT_FIXTURES";

    /// <summary>Frozen copies of tracked demo files, and the one file built at the top rung.</summary>
    private static readonly string[] Fixtures = ["Nendo Station.nendo", "Swarm.nendo", "Rung 1.51.0.nendo"];

    // A fixture keeps the keys its builder used, so a key is never reused across runs.
    private static NendoRequestContext Context() => new("format-promise", "key-" + Guid.NewGuid().ToString("N"), "test");

    private static string FixtureDirectory() => Path.Combine(TestRepository.Root(), "tests", "Nendo.Engine.Tests", "Fixtures", "Format1");

    [TestMethod]
    [DataRow("Nendo Station.nendo")]
    [DataRow("Swarm.nendo")]
    [DataRow("Rung 1.51.0.nendo")]
    public async Task A1Point0FileOpensWritableAndReadsBackWhat1Point0Read(string name)
    {
        var fixture = Path.Combine(FixtureDirectory(), name);
        Assert.IsTrue(File.Exists(fixture), $"{name} is missing from Fixtures/Format1. Within 1.x a fixture is never removed.");
        var expected = await File.ReadAllTextAsync(fixture + ".expected.json");
        await using var workspace = new EngineTestWorkspace();
        File.Copy(fixture, workspace.FilePath);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsEmpty(inspection.Findings, $"{name} was inspected with findings: "
            + string.Join("; ", inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
        Assert.IsTrue(inspection.CanAcquireWriteAuthority, $"{name} can no longer be opened for writing.");

        var coordinator = await workspace.OpenAsync();
        Assert.AreEqual(NendoOpenClassification.NormalWritable, coordinator.Inspection!.Classification, $"{name} did not open normally.");
        // A file with automatic actions waits for this device's approval before it is edited,
        // as on any new device; that interlock is not a broken promise.
        var authority = new TestBehaviourAuthority();
        coordinator.BehaviourAuthority = authority;
        if (coordinator.BehaviourTrust.RequiresApproval) authority.ApproveCurrent(coordinator);
        Assert.IsTrue(coordinator.Capabilities.Mutate, $"{name} opened without the right to write.");
        var service = new NendoApplicationService(coordinator);
        Assert.AreEqual(expected, Describe(await service.GetSnapshotAsync()),
            $"{name} reads back differently from what Nendo 1.0 read. The 1.x promise (ADR-0012, 2026-10-14) needs 2.0 to break.");

        // Writable, not only readable: a new record type and a record in it commit.
        await coordinator.ApplyAsync(new("format-promise", "probe-" + Guid.NewGuid().ToString("N"), "test", "Probe", [
            new CreateEntityOperation("probe-entity", "format_promise_probe", "Probe", "format_promise_probe"),
            new AddFieldOperation("probe-field", "format_promise_probe", "probe_title", "Title", "probe_title", NendoStorageKind.Text, true),
        ]));
        if (coordinator.BehaviourTrust.RequiresApproval) authority.ApproveCurrent(coordinator);
        await service.CreateRecordAsync(new("format_promise_probe", "probe-1",
            new Dictionary<string, object?> { ["probe_title"] = "Written by a later host" }, Context()));
        Assert.AreEqual("Written by a later host", (await service.GetSnapshotAsync()).Records
            .Single(record => record.EntityId == "format_promise_probe").Values["probe_title"].GetString());
    }

    /// <summary>
    /// Writes Fixtures/Format1, which is done once, at 1.0.0. Within 1.x a fixture may be added
    /// for a new rung, but an existing one is never rebuilt or replaced, so this method refuses to
    /// overwrite one.
    /// </summary>
    [TestMethod]
    public async Task BuildFixtures()
    {
        if (Environment.GetEnvironmentVariable(BuildVariable) != "1")
            Assert.Inconclusive($"Set {BuildVariable}=1 to write Fixtures/Format1. Done once, at 1.0.0.");
        var directory = FixtureDirectory();
        Directory.CreateDirectory(directory);
        foreach (var name in Fixtures)
            Assert.IsFalse(File.Exists(Path.Combine(directory, name)), $"{name} already exists; a 1.x fixture is never rebuilt.");

        foreach (var demo in new[] { "Nendo Station.nendo", "Swarm.nendo" })
        {
            var source = Path.Combine(TestRepository.Root(), "workspace", demo);
            Assert.IsFalse(File.Exists(source + ".write-owner"), $"workspace/{demo} is open in Nendo; close it so the copy is the committed file.");
            File.Copy(source, Path.Combine(directory, demo));
        }

        await using (var builder = new EngineTestWorkspace())
        {
            var coordinator = await builder.CreateAsync();
            await BuildTopRungAsync(coordinator, new NendoApplicationService(coordinator));
            await coordinator.DisposeAsync();
            builder.Forget(coordinator);
            File.Copy(builder.FilePath, Path.Combine(directory, "Rung 1.51.0.nendo"));
        }

        // The record is what a host reads back from a copy, never from the fixture itself.
        foreach (var name in Fixtures)
        {
            await using var reader = new EngineTestWorkspace();
            File.Copy(Path.Combine(directory, name), reader.FilePath);
            var coordinator = await reader.OpenAsync();
            var described = Describe(await new NendoApplicationService(coordinator).GetSnapshotAsync());
            await File.WriteAllTextAsync(Path.Combine(directory, name + ".expected.json"), described, new UTF8Encoding(false));
        }
    }

    /// <summary>
    /// A file at the top rung of 1.0.0: references, a retired field, the full-text index (1.46.0)
    /// and a changed reference label (1.51.0).
    /// </summary>
    private static async Task BuildTopRungAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("format-promise", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, false),
            new AddFieldOperation("p-budget", "projects", "budget", "Budget", "budget", NendoStorageKind.Integer, false),
            new AddFieldOperation("p-notes", "projects", "notes", "Notes", "notes", NendoStorageKind.Text, false, "longText"),
            new AddFieldOperation("p-archived", "projects", "archived", "Archived note", "archived", NendoStorageKind.Text, false),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        await coordinator.ApplyAsync(new("format-promise", "retire-archived", "test", "Retire",
            [new SetRetiredOperation("retire-archived", "projects", "archived", true, (await service.GetSnapshotAsync()).Manifest.DefinitionRevision)]));
        await service.CreateRecordAsync(new("projects", "apollo", new Dictionary<string, object?>
        {
            ["name"] = "Apollo", ["code"] = "APL", ["budget"] = 12L, ["notes"] = "Ship the lander. Café meetings on Fridays.",
        }, Context()));
        await service.CreateRecordAsync(new("projects", "gemini", new Dictionary<string, object?>
        {
            ["name"] = "Gemini", ["code"] = "GEM", ["budget"] = -3L, ["notes"] = null,
        }, Context()));
        await service.CreateRecordAsync(new("tasks", "launch",
            new Dictionary<string, object?> { ["title"] = "Launch", ["project"] = "apollo" }, Context(),
            new Dictionary<string, long> { ["project"] = 1 }));
        await service.CreateRecordAsync(new("tasks", "dock",
            new Dictionary<string, object?> { ["title"] = "Dock", ["project"] = "gemini" }, Context(),
            new Dictionary<string, long> { ["project"] = 1 }));
        await service.BuildSearchIndexAsync(Context());
        await coordinator.ApplyAsync(new("format-promise", "relabel", "test", "Change the label",
            [new SetReferenceLabelOperation("relabel", "tasks", "project", "code", (await service.GetSnapshotAsync()).Manifest.DefinitionRevision)]));
        Assert.AreEqual(NendoFormat.ReferenceLabelMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "The generated fixture is meant to sit at the top rung of 1.0.0.");
    }

    /// <summary>
    /// What a file holds, in a form that does not depend on how a host prints it: the manifest's
    /// format and application, each record type with its fields and record count, a digest of
    /// every stored value, a digest of every screen node and the packages the file carries.
    /// </summary>
    private static string Describe(NendoSessionSnapshot snapshot)
    {
        var values = new StringBuilder();
        foreach (var record in snapshot.Records.OrderBy(record => record.EntityId, StringComparer.Ordinal).ThenBy(record => record.RecordId, StringComparer.Ordinal))
            foreach (var (fieldId, value) in record.Values.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                values.Append(record.EntityId).Append('\t').Append(record.RecordId).Append('\t').Append(fieldId).Append('\t').Append(value.GetRawText()).Append('\n');
        var nodes = new StringBuilder();
        foreach (var node in snapshot.UiNodes.OrderBy(node => node.SurfaceId, StringComparer.Ordinal).ThenBy(node => node.NodeId, StringComparer.Ordinal))
        {
            nodes.Append(node.SurfaceId).Append('\t').Append(node.NodeId).Append('\t').Append(node.ParentNodeId).Append('\t')
                .Append(node.Kind).Append('\t').Append(node.Position).Append('\n');
            foreach (var (key, value) in node.Properties.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                nodes.Append("\t\t").Append(key).Append('\t').Append(value.GetRawText()).Append('\n');
        }
        var described = new
        {
            formatVersion = snapshot.Manifest.FormatVersion,
            minimumHostVersion = snapshot.Manifest.MinimumHostVersion,
            applicationId = snapshot.Manifest.ApplicationId,
            entities = snapshot.Entities.OrderBy(entity => entity.EntityId, StringComparer.Ordinal).Select(entity => new
            {
                entityId = entity.EntityId,
                retired = entity.Retired,
                fields = entity.Fields.Select(field => field.FieldId).Order(StringComparer.Ordinal).ToArray(),
                records = snapshot.Records.Count(record => record.EntityId == entity.EntityId),
            }).ToArray(),
            valuesSha256 = Sha256(values.ToString()),
            uiNodes = snapshot.UiNodes.Count,
            uiNodesSha256 = Sha256(nodes.ToString()),
            packages = snapshot.ExtensionPackages.OrderBy(package => package.PackageId, StringComparer.Ordinal)
                .Select(package => $"{package.PackageId}@{package.Version}: {package.Files.Count} files, "
                    + Sha256(string.Join('\n', package.Files.OrderBy(file => file.Path, StringComparer.Ordinal).Select(file => file.Path + "\t" + file.Sha256))))
                .ToArray(),
        };
        return JsonSerializer.Serialize(described, new JsonSerializerOptions { WriteIndented = true }).ReplaceLineEndings("\n") + "\n";
    }

    private static string Sha256(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
