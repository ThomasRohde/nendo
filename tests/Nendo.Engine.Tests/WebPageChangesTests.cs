using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Apply changes from a web page (ADR-0035): the revisions made in an exported page's working file
/// come back to the file it was exported from as one proposal, replayed at their base versions.
/// </summary>
[TestClass]
public sealed class WebPageChangesTests
{
    [TestMethod]
    public async Task AnUpdateACreateADeleteAndADefinitionChangeMadeInThePageArriveInTheOriginal()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var page = await ExportAsync(workspace, source, "page.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(page, "page"))
        {
            var edits = new NendoApplicationService(coordinator);
            await edits.SetIdeaTitleAsync("idea-1", 1, "Edited in the page", "page-edit");
            await edits.CreateIdeaRecordAsync("idea-3", "Made in the page", "page-create");
            await edits.DeleteRecordAsync(new(IdeaGarden.IdeaEntityId, "idea-2", 1, new("page", "page-delete", "studio")));
            await RenameTitleAsync(edits, "Headline");
        }

        var service = new NendoApplicationService(source);
        var changes = await service.PrepareWebPageChangesAsync(page);
        Assert.AreEqual("page.nendo", changes.WorkingFileName);
        Assert.IsEmpty(changes.LeftOut);
        Assert.AreEqual(4, changes.Replayed);
        Assert.AreEqual(0, changes.AlreadyApplied);
        Assert.IsNotNull(changes.Proposal);
        Assert.AreEqual(NendoProposalState.Previewable, changes.Proposal.State);
        Assert.AreEqual("Changes from page.nendo", changes.Proposal.Title);
        Assert.IsTrue((await service.PromoteProposalAsync(changes.Proposal.ProposalId)).Applied);

        var snapshot = await service.GetSnapshotAsync();
        Assert.AreEqual("Edited in the page", Title(snapshot, "idea-1"));
        Assert.AreEqual("Made in the page", Title(snapshot, "idea-3"));
        Assert.IsFalse(snapshot.Records.Any(record => record.RecordId == "idea-2"));
        Assert.AreEqual("Headline", snapshot.Entities.Single(entity => entity.EntityId == IdeaGarden.IdeaEntityId)
            .Fields.Single(field => field.FieldId == IdeaGarden.IdeaTitleFieldId).DisplayName);
        var replayed = (await service.GetHistoryAsync()).Where(revision => revision.Origin == NendoWriteCoordinator.WebPageOrigin).ToArray();
        Assert.HasCount(4, replayed);

        // A second Apply of the same working file finds every change already here.
        var again = await service.PrepareWebPageChangesAsync(page);
        Assert.IsNull(again.Proposal);
        Assert.AreEqual(4, again.AlreadyApplied);
    }

    [TestMethod]
    public async Task ARevisionMadeStaleInNendoFirstIsListedAndLeftOut()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var page = await ExportAsync(workspace, source, "page.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(page, "page"))
        {
            var edits = new NendoApplicationService(coordinator);
            await edits.SetIdeaTitleAsync("idea-1", 1, "Page's first title", "page-1");
            await edits.SetIdeaTitleAsync("idea-2", 1, "Page's idea 2", "page-2");
            await edits.SetIdeaTitleAsync("idea-1", 2, "Page's second title", "page-3");
        }
        var service = new NendoApplicationService(source);
        await service.SetIdeaTitleAsync("idea-1", 1, "Nendo's title", "nendo-1");

        var changes = await service.PrepareWebPageChangesAsync(page);
        Assert.AreEqual(1, changes.Replayed);
        Assert.HasCount(2, changes.LeftOut);
        StringAssert.Contains(changes.LeftOut[0].Reason, "changed in ideas.nendo since the export");
        StringAssert.Contains(changes.LeftOut[1].Reason, "changed in ideas.nendo since the export");
        Assert.HasCount(2, changes.Proposal!.Diagnostics.Where(diagnostic => diagnostic.Code == "NPROP013" && diagnostic.Severity == NendoDiagnosticSeverity.Warning));
        Assert.IsTrue((await service.PromoteProposalAsync(changes.Proposal.ProposalId)).Applied);
        var snapshot = await service.GetSnapshotAsync();
        Assert.AreEqual("Nendo's title", Title(snapshot, "idea-1"));
        Assert.AreEqual("Page's idea 2", Title(snapshot, "idea-2"));
    }

    [TestMethod]
    public async Task AChangeThisFilesValidationRefusesIsLeftOutWithItsReason()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var page = await ExportAsync(workspace, source, "page.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(page, "page"))
        {
            var edits = new NendoApplicationService(coordinator);
            await edits.SetIdeaTitleAsync("idea-1", 1, "Second", "page-title");
            await edits.SetIdeaFieldAsync("idea-2", 1, IdeaGarden.IdeaNotesFieldId, "Kept notes", "page-notes");
        }
        // Nendo makes titles unique after the export: the page's title, already idea-2's, is refused here.
        var service = new NendoApplicationService(source);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        using var unique = JsonDocument.Parse($$"""{"entityId":"{{IdeaGarden.IdeaEntityId}}","fieldId":"{{IdeaGarden.IdeaTitleFieldId}}","unique":true,"expectedDefinitionRevision":{{revision}}}""");
        var proposal = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest($"proposal-{Guid.NewGuid():N}", "Unique titles", "test",
            new([new("unique", "unique-titles", "test", "Unique titles", [new("op-unique-titles", "schema.setFieldUnique", unique.RootElement.Clone())])])));
        var applied = await service.PromoteProposalAsync(proposal.ProposalId);
        Assert.IsTrue(applied.Applied, applied.Message);

        var changes = await service.PrepareWebPageChangesAsync(page);
        Assert.AreEqual(1, changes.Replayed);
        Assert.HasCount(1, changes.LeftOut);
        StringAssert.Contains(changes.LeftOut[0].Reason, "already used by idea-2");
        Assert.IsTrue((await service.PromoteProposalAsync(changes.Proposal!.ProposalId)).Applied);
        var snapshot = await service.GetSnapshotAsync();
        Assert.AreEqual("First", Title(snapshot, "idea-1"));
        Assert.AreEqual("Kept notes", snapshot.Records.Single(record => record.RecordId == "idea-2").Values[IdeaGarden.IdeaNotesFieldId].GetString());
    }

    [TestMethod]
    public async Task AWorkingFileOfAnotherApplicationOrNotExportedFromThisFileIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var service = new NendoApplicationService(source);

        var other = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "other.nendo");
        await (await NendoWriteCoordinator.CreateAsync(other, "other")).DisposeAsync();
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.PrepareWebPageChangesAsync(other));
        Assert.AreEqual("web-page-other-application", refused.Code);
        StringAssert.Contains(refused.Message, "other.nendo");

        // A copy of a copy is of this application, but was exported from the first copy.
        var first = await ExportAsync(workspace, source, "first.nendo");
        string second;
        await using (var copy = await NendoWriteCoordinator.OpenAsync(first, "first"))
            second = await ExportAsync(workspace, copy, "second.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(second, "second"))
            await new NendoApplicationService(coordinator).SetIdeaTitleAsync("idea-1", 1, "From the second copy", "second");
        refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.PrepareWebPageChangesAsync(second));
        Assert.AreEqual("web-page-not-exported-here", refused.Code);
        Assert.AreEqual("second.nendo was not exported from ideas.nendo.", refused.Message);
    }

    [TestMethod]
    public async Task APictureEmbeddedInThePageComesWithItsBytes()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var page = await ExportAsync(workspace, source, "page.nendo");
        var picture = new byte[64];
        new Random(7).NextBytes(picture);
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R', 0, 0, 0, 2, 0, 0, 0, 2 }.CopyTo(picture, 0);
        string address;
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(page, "page"))
            address = (await new NendoApplicationService(coordinator).PutMediaAsync(new(picture, null, "sketch.png", new("page", "page-picture", "studio")))).Address;

        var service = new NendoApplicationService(source);
        var changes = await service.PrepareWebPageChangesAsync(page);
        Assert.IsEmpty(changes.LeftOut);
        Assert.IsTrue((await service.PromoteProposalAsync(changes.Proposal!.ProposalId)).Applied);
        CollectionAssert.AreEqual(picture, await source.ReadMediaContentAsync(address["media:".Length..]));
    }

    [TestMethod]
    public async Task AVisitorsChangesCarryToANewerExportOfTheSameSourceAndAreAppliedOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var older = await ExportAsync(workspace, source, "older.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(older, "visitor"))
        {
            var edits = new NendoApplicationService(coordinator);
            await edits.SetIdeaTitleAsync("idea-1", 1, "The visitor's title", "visitor-title");
            await edits.SetIdeaFieldAsync("idea-2", 1, IdeaGarden.IdeaNotesFieldId, "The visitor's notes", "visitor-notes");
        }
        // The owner changes idea-2 and publishes a newer export (ADR-0037).
        var service = new NendoApplicationService(source);
        await service.SetIdeaTitleAsync("idea-2", 1, "The owner's title", "owner-title");
        var newer = await ExportAsync(workspace, source, "newer.nendo");

        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(newer, "carry"))
        {
            var carry = new NendoApplicationService(coordinator);
            var carried = await carry.PrepareWebPageChangesAsync(older);
            Assert.AreEqual(1, carried.Replayed);
            Assert.HasCount(1, carried.LeftOut);
            Assert.AreEqual("Its records changed in newer.nendo since the export.", carried.LeftOut[0].Reason);
            Assert.IsTrue((await carry.PromoteProposalAsync(carried.Proposal!.ProposalId)).Applied);
            var snapshot = await carry.GetSnapshotAsync();
            Assert.AreEqual("The visitor's title", Title(snapshot, "idea-1"));
            Assert.AreEqual("The owner's title", Title(snapshot, "idea-2"));
        }

        // The carried working copy applies to the source, and the older one finds its change already there.
        var changes = await service.PrepareWebPageChangesAsync(newer);
        Assert.AreEqual(1, changes.Replayed);
        Assert.IsTrue((await service.PromoteProposalAsync(changes.Proposal!.ProposalId)).Applied);
        Assert.AreEqual("The visitor's title", Title(await service.GetSnapshotAsync(), "idea-1"));
        var again = await service.PrepareWebPageChangesAsync(older);
        Assert.AreEqual(1, again.AlreadyApplied);
        Assert.AreEqual(0, again.Replayed);
        Assert.HasCount(1, again.LeftOut);
    }

    [TestMethod]
    public async Task AnOlderExportIsNotCarriedOverANewerOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await GardenWithTwoIdeasAsync(workspace);
        var older = await ExportAsync(workspace, source, "older.nendo");
        await new NendoApplicationService(source).SetIdeaTitleAsync("idea-2", 1, "The owner's title", "owner-title");
        var newer = await ExportAsync(workspace, source, "newer.nendo");
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(newer, "visitor"))
            await new NendoApplicationService(coordinator).SetIdeaTitleAsync("idea-1", 1, "The visitor's title", "visitor-title");

        await using var stale = await NendoWriteCoordinator.OpenAsync(older, "carry");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => new NendoApplicationService(stale).PrepareWebPageChangesAsync(newer));
        Assert.AreEqual("web-page-older-export", refused.Code);
        Assert.AreEqual("older.nendo is an older export than newer.nendo, so its changes are not carried to it.", refused.Message);
    }

    private static async Task<NendoWriteCoordinator> GardenWithTwoIdeasAsync(EngineTestWorkspace workspace)
    {
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        Assert.IsTrue((await service.PromoteProposalAsync((await service.PrepareIdeaGardenProposalAsync()).ProposalId)).Applied);
        await service.CreateIdeaRecordAsync("idea-1", "First", "create-1");
        await service.CreateIdeaRecordAsync("idea-2", "Second", "create-2");
        return source;
    }

    /// <summary>The exported page's working file: a Duplicate of the source, as Export → Web page makes it.</summary>
    private static async Task<string> ExportAsync(EngineTestWorkspace workspace, NendoWriteCoordinator source, string fileName)
    {
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, fileName);
        var plan = await source.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, destination, $"export-{fileName}");
        await source.CreateIdentityCopyAsync(plan.PlanId);
        return destination;
    }

    private static async Task RenameTitleAsync(NendoApplicationService service, string name)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        using var rename = JsonDocument.Parse($$"""{"entityId":"{{IdeaGarden.IdeaEntityId}}","fieldId":"{{IdeaGarden.IdeaTitleFieldId}}","displayName":"{{name}}","expectedDefinitionRevision":{{revision}}}""");
        var proposal = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest($"proposal-{Guid.NewGuid():N}", "Rename the title", "test",
            new([new("rename", "rename-title", "test", "Rename the title", [new("op-rename-title", "schema.renameField", rename.RootElement.Clone())])])));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
    }

    private static string? Title(NendoSessionSnapshot snapshot, string recordId) =>
        snapshot.Records.Single(record => record.RecordId == recordId).Values[IdeaGarden.IdeaTitleFieldId].GetString();
}
