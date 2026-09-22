namespace Nendo.Engine.Tests;

/// <summary>
/// What the file is for, ADR-0004 2026-09-15 amendment. A row in its own protected table at
/// the end of the layout ladder, belonging to the file rather than to a record type or a
/// node: a file with no front page still has one, clearing removes the row rather than
/// storing a blank, and a file nobody has told carries nothing at all.
/// </summary>
[TestClass]
public sealed class ApplicationPurposeTests
{
    private const string Purpose = "Every axiom this project has accepted, and what still has to be proved.";

    [TestMethod]
    public async Task APurposeIsStoredReadBackAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        // A file nobody has told says nothing, rather than something derived from its name.
        Assert.IsNull(before.Manifest.Purpose);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, before.Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "purpose", "test", "Say what this file is for", [
            new SetApplicationPurposeOperation("p", Purpose, before.Manifest.DefinitionRevision),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(Purpose, after.Manifest.Purpose);
        // A file that carries one states the host that knows the table.
        Assert.AreEqual(NendoFormat.ApplicationPurposeMinimumHostVersion, after.Manifest.MinimumHostVersion);

        // No record type, no field and no node were needed to say it.
        Assert.IsEmpty(after.Entities);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(
            "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-v1",
            inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding =>
            finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        Assert.AreEqual(Purpose, (await service.GetSnapshotAsync()).Manifest.Purpose);
    }

    [TestMethod]
    public async Task ClearingAPurposeRemovesTheRowAndKeepsTheRecordedMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var start = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "purpose", "test", "Say it", [
            new SetApplicationPurposeOperation("p", Purpose, start.Manifest.DefinitionRevision),
        ]));
        var said = await service.GetSnapshotAsync();

        await coordinator.ApplyAsync(new("test", "clear", "test", "Stop saying it", [
            new SetApplicationPurposeOperation("c", null, said.Manifest.DefinitionRevision),
        ]));
        var cleared = await service.GetSnapshotAsync();
        // Absent again, not an empty string somebody has to decide how to draw.
        Assert.IsNull(cleared.Manifest.Purpose);
        // Removing a feature never lowers what a file states it once needed.
        Assert.AreEqual(NendoFormat.ApplicationPurposeMinimumHostVersion, cleared.Manifest.MinimumHostVersion);
    }

    /// <summary>
    /// The rung is taken by saying something, never by saying nothing. A file told it has no
    /// purpose is a file that is unchanged: it must not gain the table, and it must not be
    /// told it needs a newer host to open what it does not carry.
    /// </summary>
    [TestMethod]
    public async Task ClearingAPurposeNobodySetTakesNoRungAndNeedsNoNewerHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "clear", "test", "Say nothing", [
            new SetApplicationPurposeOperation("c", null, before.Manifest.DefinitionRevision),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.IsNull(after.Manifest.Purpose);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-v1", inspection.Layout);
    }

    /// <summary>A blank is a clear, not a stored empty value, in either direction.</summary>
    [TestMethod]
    [DataRow("")]
    [DataRow("   ")]
    [DataRow("\n\t ")]
    public async Task ABlankPurposeIsAnAbsentOne(string blank)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "blank", "test", "Say nothing at all", [
            new SetApplicationPurposeOperation("b", blank, before.Manifest.DefinitionRevision),
        ]));
        Assert.IsNull((await service.GetSnapshotAsync()).Manifest.Purpose);
    }

    [TestMethod]
    public void APurposeLongerThanItsPublishedCeilingIsRefusedByName()
    {
        var overlong = new string('x', SetApplicationPurposeOperation.MaximumCharacters + 1);
        var refusal = Assert.ThrowsExactly<ArgumentException>(
            () => new SetApplicationPurposeOperation("p", overlong, 0));
        StringAssert.Contains(refusal.Message, SetApplicationPurposeOperation.MaximumCharacters.ToString());
        StringAssert.Contains(refusal.Message, (SetApplicationPurposeOperation.MaximumCharacters + 1).ToString());

        // The ceiling that refuses is the ceiling that is published.
        Assert.AreEqual(
            SetApplicationPurposeOperation.MaximumCharacters,
            NendoAuthoringLimits.Current.ApplicationPurposeCharacters);

        // The bound is inclusive: the longest accepted purpose is exactly the published one.
        var longest = new string('x', SetApplicationPurposeOperation.MaximumCharacters);
        Assert.AreEqual(longest, new SetApplicationPurposeOperation("p", longest, 0).Purpose);
    }

    /// <summary>
    /// Setting and clearing read as two different sentences. The neighbouring front-page
    /// description used to print its own fallback when it was cleared, which read as a value
    /// the author had typed; both are checked here so neither can drift back to that.
    /// </summary>
    [TestMethod]
    public void TheDiffSaysSettingAndClearingInAPersonsWords()
    {
        var set = SemanticDiff.From(ChangeSet(new SetApplicationPurposeOperation("p", Purpose, 0)), Active());
        Assert.AreEqual("setApplicationPurpose", set[0].Kind);
        StringAssert.Contains(set[0].Summary, Purpose);
        StringAssert.StartsWith(set[0].Summary, "Say what this file is for:");

        var cleared = SemanticDiff.From(ChangeSet(new SetApplicationPurposeOperation("p", null, 0)), Active());
        Assert.AreEqual("Clear what this file is for.", cleared[0].Summary);

        // The front page's own description, one line away in the same switch, used to print
        // "Say what this file is for: a description" when it was cleared.
        var clearedDescription = SemanticDiff.From(
            ChangeSet(new SetUiPropertyOperation("d", "surface.file", "node.overview", "description", null)),
            Active());
        Assert.AreEqual("Stop saying what this front page is for.", clearedDescription[0].Summary);
    }

    private static NendoChangeSet ChangeSet(params NendoOperation[] operations) => new(
    [
        new NendoMutation("purpose-diff", "diff-definition", "test", "Say what this file is for", operations),
    ]);

    /// <summary>A file with no record types at all, because a purpose does not need one.</summary>
    private static NendoSessionSnapshot Active()
    {
        var now = new DateTimeOffset(2026, 9, 15, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier,
                NendoFormat.CurrentVersion,
                NendoFormat.SemanticMinimumHostVersion,
                "application-test",
                "instance-test",
                now,
                now,
                1,
                0,
                1),
            [],
            [],
            [],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
