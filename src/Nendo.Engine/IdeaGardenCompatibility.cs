using System.Text.Json;

namespace Nendo.Engine;

public sealed record NendoIdeaDraft(
    string Title,
    string? Notes,
    string Status,
    string? Energy,
    string CreatedDate,
    string? NextAction);

public sealed partial class NendoApplicationService
{
    public const string IdeaEntityId = "entity.idea";
    public const string IdeaTitleFieldId = "field.idea.title";
    public const string IdeaNotesFieldId = "field.idea.notes";
    public const string IdeaStatusFieldId = "field.idea.status";
    public const string IdeaEnergyFieldId = "field.idea.energy";
    public const string IdeaCreatedDateFieldId = "field.idea.createdDate";
    public const string IdeaNextActionFieldId = "field.idea.nextAction";
    public const string DesktopIdempotencyScope = "desktop.p1";

    public static IReadOnlyList<string> IdeaStatusOptions { get; } =
        Array.AsReadOnly(["Idea", "Exploring", "Trying", "Paused", "Done"]);

    public static IReadOnlyList<string> IdeaEnergyOptions { get; } =
        Array.AsReadOnly(["Low", "Medium", "High"]);

    public async Task<NendoProposalPreview> PrepareIdeaGardenProposalAsync(
        CancellationToken cancellationToken = default)
    {
        var snapshot = await _coordinator.GetSnapshotAsync(cancellationToken);
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var changeSet = IdeaGardenDefinition.CreateInitialChangeSet(snapshot, proposalId);
        return await PrepareProposalAsync(
            new NendoProposalRequest(
                proposalId,
                "Idea form, list and board",
                "studio",
                changeSet),
            cancellationToken);
    }

    public async Task<NendoProposalPreview> PrepareBoardTitleProposalAsync(
        string title,
        CancellationToken cancellationToken = default)
    {
        var normalized = title?.Trim() ?? string.Empty;
        if (normalized.Length is < 1 or > 120)
        {
            throw new NendoValidationException("Board title must contain 1-120 characters.");
        }
        var compilation = await CompileSemanticUiAsync(cancellationToken);
        var board = compilation.Applications
            .SelectMany(plan => plan.Surfaces)
            .FirstOrDefault(node => node.Kind == "boardSurface");
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
        return await PrepareProposalAsync(
            new NendoProposalRequest(
                proposalId,
                $"Rename board to {normalized}",
                "studio",
                IdeaGardenDefinition.RenameBoardChangeSet(proposalId, normalized)),
            cancellationToken);
    }

    public Task<NendoApplyResult> CreateIdeaSchemaAsync(
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireKey(idempotencyKey);
        return _coordinator.ApplyAsync(
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

    public async Task<NendoApplyResult> CreateIdeaRecordAsync(
        string recordId,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireRecord(recordId, title);
        RequireKey(idempotencyKey);
        return await CreateRecordAsync(
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

    public async Task<NendoApplyResult> CreateIdeaRecordAsync(
        string recordId,
        NendoIdeaDraft draft,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(draft);
        RequireRecord(recordId, draft.Title);
        RequireKey(idempotencyKey);
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
        return await CreateRecordAsync(
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

    public async Task<NendoApplyResult> SetIdeaTitleAsync(
        string recordId,
        long expectedRecordVersion,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireRecord(recordId, title);
        RequireKey(idempotencyKey);
        return await SetFieldAsync(
            new NendoSetFieldRequest(
                IdeaEntityId,
                recordId,
                IdeaTitleFieldId,
                expectedRecordVersion,
                title.Trim(),
                new NendoRequestContext(DesktopIdempotencyScope, idempotencyKey, "studio")),
            cancellationToken);
    }

    public async Task<NendoApplyResult> SetIdeaFieldAsync(
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
        RequireKey(idempotencyKey);
        return await SetFieldAsync(
            new NendoSetFieldRequest(
                IdeaEntityId,
                recordId,
                fieldId,
                expectedRecordVersion,
                value,
                new NendoRequestContext("desktop.p2", idempotencyKey, "surface")),
            cancellationToken);
    }

    public async Task<NendoApplyResult> ExecuteIdeaCommandAsync(
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireKey(idempotencyKey);
        return await ExecuteCommandAsync(
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
