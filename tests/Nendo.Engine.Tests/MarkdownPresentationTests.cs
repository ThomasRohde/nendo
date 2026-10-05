namespace Nendo.Engine.Tests;

/// <summary>
/// W-173: a Text field may be presented as Markdown, the presentation ADR-0003 names. It is a
/// value of the presentation column no older host knows, so the field states the host that
/// draws it, as a rating does, and the file opens cleanly in this one.
/// </summary>
[TestClass]
public sealed class MarkdownPresentationTests
{
    [TestMethod]
    public async Task AMarkdownFieldIsStoredReadBackAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Answers", [
            new CreateEntityOperation("e", "answer", "Answer", "answers"),
            new AddFieldOperation("f", "answer", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("l", "answer", "notes", "Notes", "notes", NendoStorageKind.Text, false, "longText"),
        ]));
        Assert.AreNotEqual(NendoFormat.MarkdownPresentationMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "A long text field alone needs no newer host.");

        await coordinator.ApplyAsync(new("test", "markdown", "test", "A formatted answer", [
            new AddFieldOperation("m", "answer", "body", "Body", "body", NendoStorageKind.Text, false, "markdown"),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("markdown", after.Entities.Single().Fields.Single(field => field.FieldId == "body").Presentation);
        Assert.AreEqual(NendoFormat.MarkdownPresentationMinimumHostVersion, after.Manifest.MinimumHostVersion);

        // The file this host wrote inspects cleanly: no unsupported-field finding.
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code == "unsupported-field-semantics"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
        Assert.IsTrue(inspection.CanAcquireWriteAuthority);
    }

    [TestMethod]
    public void MarkdownIsTextOnly()
    {
        var refused = Assert.ThrowsExactly<ArgumentException>(() =>
            new AddFieldOperation("m", "answer", "score", "Score", "score", NendoStorageKind.Integer, false, "markdown"));
        StringAssert.Contains(refused.Message, "The markdown presentation requires Text storage.", StringComparison.Ordinal);
    }
}
