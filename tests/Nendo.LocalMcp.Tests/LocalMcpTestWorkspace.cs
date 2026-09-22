using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

internal sealed class LocalMcpTestWorkspace : IAsyncDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "nendo-p3-tests",
        $"fixture-p{Environment.ProcessId}-{Guid.NewGuid():N}");
    private NendoWriteCoordinator? _coordinator;

    internal string FilePath => Path.Combine(_root, "fixture.nendo");

    internal string DiscoveryRoot => Path.Combine(_root, "discovery");

    internal NendoApplicationService Service { get; private set; } = null!;

    /// <summary>
    /// Attaches a device authority and approves exactly what the open file asks for.
    /// Only the coordinator knows what that is, and only this class holds one.
    /// </summary>
    internal void ApproveBehaviour(INendoBehaviourAuthority authority)
    {
        var coordinator = _coordinator ?? throw new InvalidOperationException("No file is open.");
        coordinator.BehaviourAuthority = authority;
        if (authority is IApprovesWhatTheFileAsks approver) approver.Approve(coordinator.BehaviourTrust.Required
            ?? throw new InvalidOperationException("The file asks for no approval."));
    }

    /// <summary>
    /// Attaches a device authority without approving anything, so a test can watch the
    /// interlock refuse and then watch it clear.
    /// </summary>
    internal void AttachBehaviourAuthority(INendoBehaviourAuthority authority) =>
        (_coordinator ?? throw new InvalidOperationException("No file is open.")).BehaviourAuthority = authority;

    /// <summary>
    /// Records consent for exactly what the open file currently asks for -- the two steps
    /// the Desktop runs when a person clicks Approve, and the two the Unattended delegate
    /// runs on their behalf.
    /// </summary>
    internal void GrantCurrentBehaviour(IApprovesWhatTheFileAsks approver)
    {
        var coordinator = _coordinator ?? throw new InvalidOperationException("No file is open.");
        if (coordinator.BehaviourTrust.Required is { } required) approver.Approve(required);
    }

    internal async Task CreateEmptyAsync()
    {
        Directory.CreateDirectory(_root);
        _coordinator = await NendoWriteCoordinator.CreateAsync(FilePath, "p3-test-owner");
        Service = new NendoApplicationService(_coordinator);
    }

    internal async Task CreateIdeaGardenAsync(int recordCount = 3)
    {
        await CreateEmptyAsync();
        var preview = await Service.PrepareIdeaGardenProposalAsync();
        var promotion = await Service.PromoteProposalAsync(preview.ProposalId);
        if (!promotion.Applied)
        {
            throw new InvalidOperationException("The Idea Garden fixture proposal did not apply.");
        }

        for (var index = 1; index <= recordCount; index++)
        {
            await Service.CreateRecordAsync(new NendoCreateRecordRequest(
                NendoApplicationService.IdeaEntityId,
                $"idea-{index:D3}",
                new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = $"Idea {index:D2}",
                    [NendoApplicationService.IdeaNotesFieldId] = $"Fixture note {index:D2}",
                    [NendoApplicationService.IdeaStatusFieldId] = index == 3 ? "Trying" : "Idea",
                    [NendoApplicationService.IdeaEnergyFieldId] = "Medium",
                    [NendoApplicationService.IdeaCreatedDateFieldId] = $"2026-09-{index:D2}",
                    [NendoApplicationService.IdeaNextActionFieldId] = $"Try step {index:D2}",
                },
                new NendoRequestContext("test.p3", $"create-idea-{index:D3}", "test")));
        }
    }

    internal async Task CreateDecisionLogAsync()
    {
        await CreateEmptyAsync();
        var fixture = SemanticProtocolFixture.Load("decision-log");
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var preview = await Service.PrepareProposalAsync(new NendoProposalRequest(
            proposalId,
            "Create Decision Log",
            "test",
            fixture.DefinitionChangeSet(proposalId)));
        var promotion = await Service.PromoteProposalAsync(preview.ProposalId);
        if (!promotion.Applied)
        {
            throw new InvalidOperationException("The Decision Log fixture proposal did not apply.");
        }
        foreach (var record in fixture.LoadRecords())
        {
            await Service.CreateRecordAsync(new NendoCreateRecordRequest(
                fixture.Entity.EntityId,
                record.RecordId,
                record.Values.ToDictionary(
                    pair => pair.Key,
                    pair => (object?)pair.Value.Clone(),
                    StringComparer.Ordinal),
                new NendoRequestContext("test.p3", $"create-{record.RecordId}", "test")));
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_coordinator is not null)
        {
            await _coordinator.DisposeAsync();
        }
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
