using System.Diagnostics;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0022 (W-129, W-130): a new Archi model from a copy of the committed Archi.nendo, marked
/// as tools/Build-Archi.mjs marks it, keeps the 72 concept types and the nine top-level folders
/// and nothing else. Measures the file sizes and the time New takes. The file in workspace/ is
/// only read; NENDO_ARCHI_SOURCE names another copy, such as one taken from git while Nendo has
/// the workspace file open.
/// </summary>
[TestClass]
public sealed class NewFileArchiMeasurementTests
{
    [TestMethod]
    public async Task ANewArchiModelKeepsTheConceptTypesAndTheTopLevelFolders()
    {
        var source = Environment.GetEnvironmentVariable("NENDO_ARCHI_SOURCE") is { Length: > 0 } named
            ? named : Path.Combine(RepositoryRoot(), "workspace", "Archi.nendo");
        if (!File.Exists(source)) Assert.Inconclusive($"{source} is not here.");
        if (File.Exists(source + ".write-owner") || File.Exists(source + "-journal"))
            Assert.Inconclusive($"{Path.GetFileName(source)} is open in Nendo, so a copy of it would not be the committed file. Close it, or name a copy in NENDO_ARCHI_SOURCE.");

        await using var workspace = new EngineTestWorkspace();
        // A raw copy keeps its source's instance, which Nendo refuses to open for editing while
        // the source is open; a Duplicate of it is its own instance with the same content.
        var copy = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "copy.nendo");
        File.Copy(source, copy);
        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(copy))
        {
            var plan = await reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, workspace.FilePath, "measure-duplicate");
            await reader.CreateIdentityCopyAsync(plan.PlanId);
        }
        var coordinator = await workspace.OpenAsync();
        var service = new NendoApplicationService(coordinator);
        var snapshot = await service.GetSnapshotAsync();
        var revision = snapshot.Manifest.DefinitionRevision;
        // Marked as Build-Archi marks it, where the file is not marked already.
        var definition = new List<NendoOperation>();
        if (!snapshot.Entities.Single(entity => entity.EntityId == "ar.type").KeptInNewFiles)
            definition.Add(new SetKeptInNewFilesDefaultOperation("keep-types", "ar.type", true, revision));
        if (snapshot.Manifest.NewFileLabel is null)
            definition.Add(new SetNewFileLabelOperation("label", "Archi model", revision));
        if (definition.Count > 0) await coordinator.ApplyAsync(new("archi", "ships", "test", "What a new Archi model keeps", definition));
        var topLevel = snapshot.Records.Where(record => record.EntityId == "ar.folder" &&
            record.Values["ar.folder.parent"].ValueKind == System.Text.Json.JsonValueKind.Null).ToArray();
        Assert.HasCount(9, topLevel);
        foreach (var folder in topLevel.Where(folder => folder.KeptInNewFiles != true))
            await service.SetRecordKeptInNewFilesAsync("ar.folder", folder.RecordId, true, new("archi", $"keep-{folder.RecordId}", "test"));

        var preview = await service.PreviewNewFileAsync();
        Assert.AreEqual("New Archi model…", preview.MenuLabel);
        Assert.IsTrue(preview.CanCreate, $"{preview.ConflictCount} conflicts");
        Assert.AreEqual(81L, preview.Kept);

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "New model.nendo");
        var clock = Stopwatch.StartNew();
        var made = await service.CreateNewFileAsync(destination, "archi-new");
        clock.Stop();
        Console.WriteLine($"new-archi-model: source {new FileInfo(workspace.FilePath).Length / 1024:N0} KiB with {preview.Kept + preview.LeftOut:N0} records " +
            $"and {preview.Revisions:N0} changes; new file {new FileInfo(destination).Length / 1024:N0} KiB with {made.KeptRecords:N0} records; " +
            $"{clock.ElapsedMilliseconds:N0} ms");

        await using var opened = await NendoWriteCoordinator.OpenAsync(destination, "test-archi-new");
        var fresh = await new NendoApplicationService(opened).GetSnapshotAsync();
        Assert.AreEqual(72, fresh.Records.Count(record => record.EntityId == "ar.type"));
        Assert.AreEqual(9, fresh.Records.Count(record => record.EntityId == "ar.folder"));
        Assert.HasCount(81, fresh.Records, "A new Archi model kept work it should have left out.");
        Assert.HasCount(3, await new NendoApplicationService(opened).GetHistoryAsync());
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) return directory.FullName;
        throw new InvalidOperationException("The repository root was not found.");
    }
}
