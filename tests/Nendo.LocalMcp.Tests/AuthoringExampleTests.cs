using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>A device authority a test can hand the grant the open file asks for.</summary>
internal interface IApprovesWhatTheFileAsks
{
    void Approve(NendoBehaviourGrant required);
}

/// <summary>
/// A worked example that no longer validates is worse than no example: it teaches
/// a rule the host does not hold. Every example published at
/// <c>nendo://application/examples</c> is sent through the same tools an agent
/// uses, from an empty file, and must reach a previewable proposal.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class AuthoringExampleTests
{
    [TestMethod]
    public async Task EveryPublishedExampleValidatesThroughTheRealAuthoringBoundary()
    {
        var examples = NendoAuthoringExamples.Description();
        Assert.AreEqual(NendoSemanticVocabulary.ContractVersion, examples.ContractVersion);
        Assert.IsNotEmpty(examples.Examples);

        foreach (var example in examples.Examples)
        {
            Assert.IsNotEmpty(example.Notes, $"{example.Name} carries no rule.");
            await using var workspace = new LocalMcpTestWorkspace();
            await workspace.CreateEmptyAsync();
            await using var host = await NendoLocalMcpHost.StartAsync(
                workspace.Service,
                AgentAccessMode.ApplicationAuthoring,
                new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
            await using var client = await ProtocolResourceTests.ConnectAsync(host);

            var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
            var owned = new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle,
                ["leaseId"] = lease.LeaseId,
            };
            var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync(
                "nendo.change_set.begin",
                new Dictionary<string, object?>(owned)
                {
                    ["title"] = example.Purpose,
                    ["idempotencyKey"] = $"{example.Name}-begin",
                }));
            var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };

            for (var index = 0; index < example.Mutations.Count; index++)
            {
                var mutation = example.Mutations[index];
                var result = await client.CallToolAsync("nendo.change_set.add_operations",
                    new Dictionary<string, object?>(scoped)
                    {
                        ["mutations"] = new[]
                        {
                            new NendoAgentMutationInput(
                                mutation.Description,
                                mutation.Operations
                                    .Select(operation => new NendoAgentOperationInput(operation.OperationType, operation.Payload))
                                    .ToArray()),
                        },
                        ["idempotencyKey"] = $"{example.Name}-add-{index:D2}",
                    });
                Assert.AreNotEqual(
                    true,
                    result.IsError,
                    $"{example.Name} mutation {index} was refused: {JsonSerializer.Serialize(result)}");
            }

            var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync(
                "nendo.change_set.validate",
                new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = $"{example.Name}-validate" }));
            Assert.AreEqual(
                NendoProposalState.Previewable,
                validated.State,
                $"{example.Name}: {JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options)}");
        }
    }

    /// <summary>
    /// An example that installs a trigger is not proven by validating. Validating says
    /// the definitions are well formed; it never runs one. A worked example whose
    /// action fails the first time anybody saves is worse than no example, because an
    /// agent follows it and the owner meets the failure.
    /// </summary>
    [TestMethod]
    public async Task AnExampleThatInstallsATriggerHasItsActionRun()
    {
        var example = NendoAuthoringExamples.Description().Examples
            .SingleOrDefault(candidate => candidate.Mutations
                .SelectMany(mutation => mutation.Operations)
                .Any(operation => operation.OperationType == "behaviour.setDefinition" &&
                    operation.Payload.TryGetProperty("definitionKind", out var kind) &&
                    kind.GetString() == "Trigger"));
        Assert.IsNotNull(example, "No published example installs a trigger, so nothing here is being checked.");

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();

        // Sent through the same tools an agent uses, so the boundary fills in each
        // mutation's expected definition revision exactly as it would in the field.
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = example.Purpose, ["idempotencyKey"] = "run-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        for (var index = 0; index < example.Mutations.Count; index++)
        {
            var mutation = example.Mutations[index];
            var added = await client.CallToolAsync("nendo.change_set.add_operations",
                new Dictionary<string, object?>(scoped)
                {
                    ["mutations"] = new[]
                    {
                        new NendoAgentMutationInput(mutation.Description, mutation.Operations
                            .Select(operation => new NendoAgentOperationInput(operation.OperationType, operation.Payload))
                            .ToArray()),
                    },
                    ["idempotencyKey"] = $"run-add-{index:D2}",
                });
            Assert.AreNotEqual(true, added.IsError, $"{example.Name} mutation {index}: {JsonSerializer.Serialize(added)}");
        }
        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "run-validate" }));
        Assert.AreEqual(NendoProposalState.Previewable, validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(validated.ProposalId)).Applied,
            $"{example.Name} did not promote.");

        // The file now carries a trigger, so it is not editable until this device says
        // so — which is itself part of what the example teaches.
        var authority = new ExampleBehaviourAuthority();
        workspace.ApproveBehaviour(authority);

        await workspace.Service.CreateRecordAsync(new("project", "project-1",
            new Dictionary<string, object?> { ["projectName"] = "Untitled" }, new("test", "project-1", "test")));
        var project = (await workspace.Service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "project-1");
        await workspace.Service.CreateRecordAsync(new("task", "task-1",
            new Dictionary<string, object?> { ["taskTitle"] = "Draw the thing", ["taskDone"] = false, ["taskHours"] = 3, ["taskProject"] = "project-1" },
            new("test", "task-1", "test"), new Dictionary<string, long> { ["taskProject"] = project.RecordVersion }));

        var after = (await workspace.Service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "project-1");
        Assert.AreEqual("Active", after.Values["projectStatus"].GetString(),
            $"{example.Name} installs a trigger whose action did not take effect on the first save that fired it.");

        // And the calculations it also installs produce values rather than errors.
        foreach (var result in after.Calculations)
        {
            Assert.AreNotEqual(NendoCalculationState.Error, result.State,
                $"{result.FieldId}: {result.ErrorCode} {result.ErrorMessage}");
        }
    }

    /// <summary>Approves exactly what the open file asks for, which is what a person would do.</summary>
    private sealed class ExampleBehaviourAuthority : INendoBehaviourAuthority, IApprovesWhatTheFileAsks
    {
        private readonly HashSet<NendoBehaviourGrant> _granted = [];

        public long RevocationGeneration => 0;

        public bool IsGranted(NendoBehaviourGrant required) => _granted.Contains(required);

        public void Approve(NendoBehaviourGrant required) => _granted.Add(required);
    }

    private static T Result<T>(ModelContextProtocol.Protocol.CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
