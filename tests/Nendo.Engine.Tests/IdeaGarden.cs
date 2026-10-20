using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Engine.Tests;

internal sealed record NendoIdeaDraft(
    string Title,
    string? Notes,
    string Status,
    string? Energy,
    string CreatedDate,
    string? NextAction);

/// <summary>
/// The Idea Garden reference application as test support: its identifiers, and the convenience
/// writes that give a test a file with a schema, records or a waiting proposal. The Engine knows
/// no application, so these go through its typed services like any other caller. Linked into the
/// Desktop and LocalMcp test projects as well, so all three suites build Garden files one way.
/// </summary>
internal static class IdeaGarden
{
    internal const string IdeaEntityId = "entity.idea";
    internal const string IdeaTitleFieldId = "field.idea.title";
    internal const string IdeaNotesFieldId = "field.idea.notes";
    internal const string IdeaStatusFieldId = "field.idea.status";
    internal const string IdeaEnergyFieldId = "field.idea.energy";
    internal const string IdeaCreatedDateFieldId = "field.idea.createdDate";
    internal const string IdeaNextActionFieldId = "field.idea.nextAction";
    internal const string DesktopIdempotencyScope = "desktop.p1";

    internal static IReadOnlyList<string> IdeaStatusOptions { get; } =
        Array.AsReadOnly(["Idea", "Exploring", "Trying", "Paused", "Done"]);

    internal static IReadOnlyList<string> IdeaEnergyOptions { get; } =
        Array.AsReadOnly(["Low", "Medium", "High"]);

    internal static async Task<NendoProposalPreview> PrepareIdeaGardenProposalAsync(
        this NendoApplicationService service,
        CancellationToken cancellationToken = default)
    {
        var snapshot = await service.GetSnapshotAsync(cancellationToken);
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var changeSet = IdeaGardenDefinition.CreateInitialChangeSet(snapshot, proposalId);
        return await service.PrepareProposalAsync(
            new NendoProposalRequest(
                proposalId,
                "Idea form, list and board",
                "studio",
                changeSet),
            cancellationToken);
    }

    internal static async Task<NendoProposalPreview> PrepareBoardTitleProposalAsync(
        this NendoApplicationService service,
        string title,
        CancellationToken cancellationToken = default)
    {
        var normalized = title?.Trim() ?? string.Empty;
        if (normalized.Length is < 1 or > 120)
        {
            throw new NendoValidationException("Board title must contain 1-120 characters.");
        }
        var compilation = await service.CompileSemanticUiAsync(cancellationToken);
        var board = compilation.Applications
            .SelectMany(plan => plan.Surfaces)
            .FirstOrDefault(node => node.Kind == "boardSurface" && node.SemanticId == IdeaGardenDefinition.BoardRootId);
        if (!compilation.IsValid || board is null)
        {
            throw new NendoPreconditionException(
                "semantic-definition-invalid",
                "A healthy Idea Garden is required before its board can be renamed.");
        }
        if (board.Properties.TryGetValue("title", out var currentTitle)
            && currentTitle.ValueKind == JsonValueKind.String
            && currentTitle.GetString() == normalized)
        {
            throw new NendoPreconditionException(
                "title-unchanged",
                "The Idea board already uses that title.");
        }
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        return await service.PrepareProposalAsync(
            new NendoProposalRequest(
                proposalId,
                $"Rename board to {normalized}",
                "studio",
                IdeaGardenDefinition.RenameBoardChangeSet(proposalId, normalized)),
            cancellationToken);
    }

    internal static Task<NendoApplyResult> CreateIdeaSchemaAsync(
        this NendoApplicationService service,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        NendoApplicationService.RequireKey(idempotencyKey);
        return service.ApplyMutationAsync(
            new NendoMutation(
                DesktopIdempotencyScope,
                idempotencyKey,
                "studio",
                "Create Idea entity and required Title field",
                [
                    new CreateEntityOperation(
                        NendoCanonical.DeterministicId("operation", DesktopIdempotencyScope, idempotencyKey, 0),
                        IdeaEntityId,
                        "Idea",
                        "idea"),
                    new AddFieldOperation(
                        NendoCanonical.DeterministicId("operation", DesktopIdempotencyScope, idempotencyKey, 1),
                        IdeaEntityId,
                        IdeaTitleFieldId,
                        "Title",
                        "title",
                        NendoStorageKind.Text,
                        required: true),
                ]),
            cancellationToken);
    }

    internal static async Task<NendoApplyResult> CreateIdeaRecordAsync(
        this NendoApplicationService service,
        string recordId,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireRecord(recordId, title);
        NendoApplicationService.RequireKey(idempotencyKey);
        return await service.CreateRecordAsync(
            new NendoCreateRecordRequest(
                IdeaEntityId,
                recordId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    [IdeaTitleFieldId] = title.Trim(),
                },
                new NendoRequestContext(DesktopIdempotencyScope, idempotencyKey, "studio")),
            cancellationToken);
    }

    internal static async Task<NendoApplyResult> CreateIdeaRecordAsync(
        this NendoApplicationService service,
        string recordId,
        NendoIdeaDraft draft,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(draft);
        RequireRecord(recordId, draft.Title);
        NendoApplicationService.RequireKey(idempotencyKey);
        if (!IdeaStatusOptions.Contains(draft.Status, StringComparer.Ordinal))
        {
            throw new NendoValidationException("Status must be Idea, Exploring, Trying, Paused or Done.");
        }
        if (draft.Energy is not null && !IdeaEnergyOptions.Contains(draft.Energy, StringComparer.Ordinal))
        {
            throw new NendoValidationException("Energy must be Low, Medium, High or blank.");
        }
        if (!DateOnly.TryParseExact(
                draft.CreatedDate,
                "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out _))
        {
            throw new NendoValidationException("Created date must use yyyy-MM-dd.");
        }
        return await service.CreateRecordAsync(
            new NendoCreateRecordRequest(
                IdeaEntityId,
                recordId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    [IdeaTitleFieldId] = draft.Title.Trim(),
                    [IdeaNotesFieldId] = NormalizeOptional(draft.Notes),
                    [IdeaStatusFieldId] = draft.Status,
                    [IdeaEnergyFieldId] = draft.Energy,
                    [IdeaCreatedDateFieldId] = draft.CreatedDate,
                    [IdeaNextActionFieldId] = NormalizeOptional(draft.NextAction),
                },
                new NendoRequestContext("desktop.p2", idempotencyKey, "surface")),
            cancellationToken);
    }

    internal static async Task<NendoApplyResult> SetIdeaTitleAsync(
        this NendoApplicationService service,
        string recordId,
        long expectedRecordVersion,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireRecord(recordId, title);
        NendoApplicationService.RequireKey(idempotencyKey);
        return await service.SetFieldAsync(
            new NendoSetFieldRequest(
                IdeaEntityId,
                recordId,
                IdeaTitleFieldId,
                expectedRecordVersion,
                title.Trim(),
                new NendoRequestContext(DesktopIdempotencyScope, idempotencyKey, "studio")),
            cancellationToken);
    }

    internal static async Task<NendoApplyResult> SetIdeaFieldAsync(
        this NendoApplicationService service,
        string recordId,
        long expectedRecordVersion,
        string fieldId,
        object? value,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        if (fieldId is not (IdeaTitleFieldId or IdeaNotesFieldId or IdeaStatusFieldId or
            IdeaEnergyFieldId or IdeaCreatedDateFieldId or IdeaNextActionFieldId))
        {
            throw new NendoValidationException("The requested field is not part of the Idea Garden form.");
        }
        if (fieldId == IdeaTitleFieldId)
        {
            if (value is not string title)
            {
                throw new NendoValidationException("Title requires text.");
            }
            RequireRecord(recordId, title);
            value = title.Trim();
        }
        else if (string.IsNullOrWhiteSpace(recordId) || recordId.Length > 200)
        {
            throw new NendoValidationException("A record ID must contain 1-200 characters.");
        }
        NendoApplicationService.RequireKey(idempotencyKey);
        return await service.SetFieldAsync(
            new NendoSetFieldRequest(
                IdeaEntityId,
                recordId,
                fieldId,
                expectedRecordVersion,
                value,
                new NendoRequestContext("desktop.p2", idempotencyKey, "surface")),
            cancellationToken);
    }

    internal static async Task<NendoApplyResult> ExecuteIdeaCommandAsync(
        this NendoApplicationService service,
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        NendoApplicationService.RequireKey(idempotencyKey);
        return await service.ExecuteCommandAsync(
            new NendoExecuteCommandRequest(
                commandId,
                recordId,
                expectedRecordVersion,
                new NendoRequestContext("desktop.p2", idempotencyKey, "surface")),
            cancellationToken);
    }

    private static void RequireRecord(string recordId, string title)
    {
        if (string.IsNullOrWhiteSpace(recordId) || recordId.Length > 200)
        {
            throw new NendoValidationException("A record ID must contain 1-200 characters.");
        }
        if (string.IsNullOrWhiteSpace(title) || title.Length > 2_000)
        {
            throw new NendoValidationException("Title is required and must contain at most 2,000 characters.");
        }
    }

    private static string? NormalizeOptional(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
