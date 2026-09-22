namespace Nendo.Engine.Tests;

// Invoked only by the repository's owned runtime probe. Not shipped with Desktop.
public static class RuntimeRecoveryFixture
{
    public static async Task CreateAsync(string path)
    {
        await using var source = await NendoWriteCoordinator.CreateAsync(path, "owned-runtime-fixture");
        var service = new NendoApplicationService(source);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        if (!(await service.PromoteProposalAsync(proposal.ProposalId)).Applied) throw new InvalidOperationException("Fixture proposal failed.");
        await service.CreateIdeaRecordAsync("idea-1", "Before Restore", "create");
        var backup = Path.Combine(Path.GetDirectoryName(path)!, "backup.nendo");
        await source.CreateBackupAsync((await source.PrepareBackupAsync(backup, "backup")).PlanId);
        await service.SetIdeaTitleAsync("idea-1", 1, "Retained original", "edit");
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        source.RestoreCheckpoint = seam => { if (seam == "original-retained") throw new IOException("Owned runtime fixture interruption"); };
        try { await source.RestoreAsync(plan.PlanId, false); throw new InvalidOperationException("Fixture missed its interruption seam."); }
        catch (NendoReplacementInterruptedException) { }
    }
}
