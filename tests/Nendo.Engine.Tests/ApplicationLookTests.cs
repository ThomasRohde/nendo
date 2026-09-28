namespace Nendo.Engine.Tests;

/// <summary>
/// A file's own look (W-089): a tone and a letter, drawn as a badge on the Nendo mark wherever
/// the file has an icon. Every file has one by default; what a file chose is a row in its own
/// protected table at the end of the layout ladder, as the purpose is.
/// </summary>
[TestClass]
public sealed class ApplicationLookTests
{
    private const string LookLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-v1";

    [TestMethod]
    public async Task AChosenLookIsStoredReadBackAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        Assert.IsNull(before.Manifest.Look, "A file that chose nothing carries nothing.");

        await coordinator.ApplyAsync(new("test", "look", "test", "Give the file its own look", [
            new SetApplicationLookOperation("l", "violet", "p", before.Manifest.DefinitionRevision),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoApplicationLook("violet", "P"), after.Manifest.Look, "A letter is kept in upper case.");
        Assert.AreEqual(NendoFormat.ApplicationLookMinimumHostVersion, after.Manifest.MinimumHostVersion);
        Assert.IsEmpty(after.Entities, "No record type, field or node was needed to choose it.");

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(LookLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding =>
            finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        var reopened = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoApplicationLook("violet", "P"), reopened.Manifest.Look);

        // One part back to its default, the other kept.
        await coordinator.ApplyAsync(new("test", "tone-only", "test", "Keep the tone", [
            new SetApplicationLookOperation("t", "violet", null, reopened.Manifest.DefinitionRevision),
        ]));
        Assert.AreEqual(new NendoApplicationLook("violet", null), (await service.GetSnapshotAsync()).Manifest.Look);
    }

    [TestMethod]
    public async Task ReturningToTheDefaultsRemovesTheRowAndKeepsTheRecordedMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var start = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "look", "test", "Choose", [
            new SetApplicationLookOperation("l", "teal", "B", start.Manifest.DefinitionRevision),
        ]));
        var chosen = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "defaults", "test", "Back to the defaults", [
            new SetApplicationLookOperation("d", null, null, chosen.Manifest.DefinitionRevision),
        ]));
        var defaults = await service.GetSnapshotAsync();
        Assert.IsNull(defaults.Manifest.Look);
        Assert.AreEqual(NendoFormat.ApplicationLookMinimumHostVersion, defaults.Manifest.MinimumHostVersion,
            "Removing a feature never lowers what a file states it once needed.");
    }

    /// <summary>
    /// The rung is taken by choosing, never by returning to the defaults: a file told to look as
    /// it already does must not gain the table or need a newer host.
    /// </summary>
    [TestMethod]
    public async Task ReturningToTheDefaultsNobodyChangedTakesNoRung()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var before = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "defaults", "test", "Look as it looks", [
            new SetApplicationLookOperation("d", null, "  ", before.Manifest.DefinitionRevision),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.IsNull(after.Manifest.Look);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual("production-semantic-v1", (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout);
    }

    [TestMethod]
    public async Task ChoosingALookCanBeCompensatedBackToWhatWasChosenBefore()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var start = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(new("test", "first", "test", "First look", [
            new SetApplicationLookOperation("f", "green", "W", start.Manifest.DefinitionRevision),
        ]));
        var first = await service.GetSnapshotAsync();
        var second = await coordinator.ApplyAsync(new("test", "second", "test", "Second look", [
            new SetApplicationLookOperation("s", "orange", null, first.Manifest.DefinitionRevision),
        ]));
        await service.CompensateRevisionAsync(second.RevisionId, "undo-look");
        Assert.AreEqual(new NendoApplicationLook("green", "W"), (await service.GetSnapshotAsync()).Manifest.Look);
    }

    [TestMethod]
    [DataRow("pink", null)]
    [DataRow("Violet", null)]
    [DataRow(null, "AB")]
    [DataRow(null, "-")]
    [DataRow(null, "😀")]
    public void OnlyAChoiceToneAndASingleLetterOrDigitAreAccepted(string? tone, string? letter)
    {
        var refusal = Assert.ThrowsExactly<NendoValidationException>(() => new SetApplicationLookOperation("l", tone, letter, 0));
        StringAssert.StartsWith(refusal.Message, tone is not null ? "A file's tone is one of red, orange" : "A file's letter is one letter or digit");
    }

    [TestMethod]
    public void EveryFileHasALookWithoutChoosingOne()
    {
        // Stable for an application ID on every device and in every process: the value is
        // pinned so that a change of hash, which would recolour every file, fails here first.
        Assert.AreEqual(NendoLook.DefaultTone("application-7efd926c073f4be9974be19bbc39ff41"),
            NendoLook.DefaultTone("application-7efd926c073f4be9974be19bbc39ff41"));
        var tones = Enumerable.Range(0, 400).Select(index => NendoLook.DefaultTone($"application-{index:x32}")).ToHashSet();
        CollectionAssert.AreEquivalent(NendoLook.DefaultTones.ToArray(), tones.ToArray(),
            "Defaults spread over every default tone, and never red or grey.");
        Assert.AreEqual("amber", NendoLook.DefaultTone("application-7efd926c073f4be9974be19bbc39ff41"));

        Assert.AreEqual("W", NendoLook.DefaultLetter("Work dependencies demo.nendo"));
        Assert.AreEqual("N", NendoLook.DefaultLetter("Nendo.nendo"));
        Assert.AreEqual("2", NendoLook.DefaultLetter("2026 plan.nendo"));
        Assert.AreEqual("Ø", NendoLook.DefaultLetter("økonomi.nendo"));
        Assert.AreEqual("B", NendoLook.DefaultLetter(@"C:\work\-- BCM.nendo"));
        Assert.AreEqual("N", NendoLook.DefaultLetter("---.nendo"));
        Assert.AreEqual("N", NendoLook.DefaultLetter(null));

        var resolved = NendoLook.Resolve("application-x", "BCM.nendo", new NendoApplicationLook(null, "Q"));
        var tone = NendoLook.DefaultTone("application-x");
        Assert.AreEqual(new NendoResolvedLook(tone, "Q", false, true, tone, "B"), resolved);
        Assert.AreEqual(new NendoResolvedLook("grey", "B", true, false, tone, "B"),
            NendoLook.Resolve("application-x", "BCM.nendo", new NendoApplicationLook("grey", null)));
    }

    [TestMethod]
    public void TheDiffSaysChoosingAndReturningToTheDefaultsInAPersonsWords()
    {
        var chosen = SemanticDiff.From(ChangeSet(new SetApplicationLookOperation("l", "violet", "P", 0)), Active());
        Assert.AreEqual("setApplicationLook", chosen[0].Kind);
        Assert.AreEqual("Give this file its own icon: violet, the letter P.", chosen[0].Summary);
        var toneOnly = SemanticDiff.From(ChangeSet(new SetApplicationLookOperation("l", "teal", null, 0)), Active());
        Assert.AreEqual("Give this file its own icon: teal, its default letter.", toneOnly[0].Summary);
        var defaults = SemanticDiff.From(ChangeSet(new SetApplicationLookOperation("l", null, null, 0)), Active());
        Assert.AreEqual("Give this file back its default icon.", defaults[0].Summary);
    }

    private static NendoChangeSet ChangeSet(params NendoOperation[] operations) => new(
    [
        new NendoMutation("look-diff", "diff-definition", "test", "Give the file its own look", operations),
    ]);

    private static NendoSessionSnapshot Active()
    {
        var now = new DateTimeOffset(2026, 9, 28, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.SemanticMinimumHostVersion,
                "application-test", "instance-test", now, now, 1, 0, 1),
            [],
            [],
            [],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
