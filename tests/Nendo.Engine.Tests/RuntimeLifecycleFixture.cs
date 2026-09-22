using System.Text.Json;

namespace Nendo.Engine.Tests;

// Test-assembly entry points for disposable Desktop journeys. Never shipped.
public static class RuntimeLifecycleFixture
{
    public static async Task CreateAsync(string path, string application, string repositoryRoot)
    {
        if (application is not ("idea-garden" or "decision-log"))
            throw new ArgumentException("Unknown runtime fixture.", nameof(application));
        await using var source = await NendoWriteCoordinator.CreateAsync(path, "owned-lifecycle-fixture");
        var service = new NendoApplicationService(source);
        if (application == "idea-garden")
        {
            var proposal = await service.PrepareIdeaGardenProposalAsync();
            if (!(await service.PromoteProposalAsync(proposal.ProposalId)).Applied)
                throw new InvalidOperationException("Fixture promotion failed.");
            await service.CreateRecordAsync(new(NendoApplicationService.IdeaEntityId, "idea-1",
                new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = "A garden worth keeping",
                    [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                }, new("owned-runtime", "create-first", "test")));
            await service.CreateRecordAsync(new(NendoApplicationService.IdeaEntityId, "idea-2",
                new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = "Another durable idea",
                    [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                }, new("owned-runtime", "create-second", "test")));
            await service.SetIdeaTitleAsync("idea-2", 1, "An edited durable idea", "edit-second");
        }
        else
        {
            var fixture = SemanticApplicationFixture.Load(application, repositoryRoot);
            var proposalId = $"proposal-{Guid.NewGuid():N}";
            var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(
                proposalId, "Create Decision Log", "test", fixture.DefinitionChangeSet(proposalId)));
            if (!(await service.PromoteProposalAsync(proposal.ProposalId)).Applied)
                throw new InvalidOperationException("Fixture promotion failed.");
            foreach (var record in fixture.LoadRecords(repositoryRoot))
                await service.CreateRecordAsync(new(fixture.Entity.EntityId, record.RecordId, record.ToValues(),
                    new("owned-runtime", record.RecordId, "test")));
            await service.ExecuteCommandAsync(new(fixture.Command.NodeId, "decision-002", 1,
                new("owned-runtime", "command-second", "test")));
        }
    }

    public static async Task<string> InspectAsync(string path)
    {
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(path);
        var snapshot = await reader.GetSnapshotAsync();
        var history = await reader.GetHistoryAsync();
        var compiled = await new NendoApplicationService(reader).CompileSemanticUiAsync();
        if (!compiled.IsValid) throw new InvalidOperationException("Runtime fixture no longer compiles.");
        return JsonSerializer.Serialize(new
        {
            snapshot.Manifest, snapshot.Entities, snapshot.Records, snapshot.UiNodes, History = history,
            SemanticValid = compiled.IsValid,
        });
    }
}
