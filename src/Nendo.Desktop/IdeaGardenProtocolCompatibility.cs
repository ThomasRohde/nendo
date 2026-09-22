using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    internal const string SchemaCreateIdea = "schema.createIdea";
    internal const string DataCreateIdea = "data.createIdea";
    internal const string DataSetIdeaTitle = "data.setIdeaTitle";
    internal const string DataCreateFullIdea = "data.createFullIdea";
    internal const string DataSetIdeaField = "data.setIdeaField";
    internal const string DataExecuteIdeaCommand = "data.executeIdeaCommand";
    internal const string ProposalPrepareIdeaGarden = "proposal.prepareIdeaGarden";
    internal const string ProposalPrepareBoardTitle = "proposal.prepareBoardTitle";
}

internal sealed record CreateIdeaRecordPayload(string RecordId, string Title, string IdempotencyKey);

internal sealed record SetIdeaTitlePayload(
    string RecordId,
    long ExpectedRecordVersion,
    string Title,
    string IdempotencyKey);

internal sealed record IdempotentPayload(string IdempotencyKey);

internal sealed record CreateFullIdeaPayload(
    string RecordId,
    string Title,
    string? Notes,
    string Status,
    string? Energy,
    string CreatedDate,
    string? NextAction,
    string IdempotencyKey);

internal sealed record SetIdeaFieldPayload(
    string RecordId,
    long ExpectedRecordVersion,
    string FieldId,
    JsonElement Value,
    string IdempotencyKey);

internal sealed record ExecuteIdeaCommandPayload(
    string CommandId,
    string RecordId,
    long ExpectedRecordVersion,
    string IdempotencyKey);

internal sealed record BoardTitlePayload(string Title);

internal static class LegacyWorkbenchProtocol
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly IReadOnlySet<string> Methods = new HashSet<string>(
        [
            WorkbenchMethods.SchemaCreateIdea,
            WorkbenchMethods.DataCreateIdea,
            WorkbenchMethods.DataSetIdeaTitle,
            WorkbenchMethods.DataCreateFullIdea,
            WorkbenchMethods.DataSetIdeaField,
            WorkbenchMethods.DataExecuteIdeaCommand,
            WorkbenchMethods.ProposalPrepareIdeaGarden,
            WorkbenchMethods.ProposalPrepareBoardTitle,
        ],
        StringComparer.Ordinal);

    internal static bool IsMethod(string method) => Methods.Contains(method);

    internal static async Task<object?> HandleAsync(
        DesktopSessionController session,
        string method,
        JsonElement payload,
        CancellationToken cancellationToken) => method switch
    {
        WorkbenchMethods.SchemaCreateIdea => await CreateIdeaAsync(session, payload, cancellationToken),
        WorkbenchMethods.DataCreateIdea => await CreateRecordAsync(session, payload, cancellationToken),
        WorkbenchMethods.DataSetIdeaTitle => await SetTitleAsync(session, payload, cancellationToken),
        WorkbenchMethods.DataCreateFullIdea => await CreateFullRecordAsync(session, payload, cancellationToken),
        WorkbenchMethods.DataSetIdeaField => await SetFieldAsync(session, payload, cancellationToken),
        WorkbenchMethods.DataExecuteIdeaCommand => await ExecuteCommandAsync(session, payload, cancellationToken),
        WorkbenchMethods.ProposalPrepareIdeaGarden => await session.PrepareIdeaGardenProposalAsync(cancellationToken),
        WorkbenchMethods.ProposalPrepareBoardTitle => await PrepareBoardTitleAsync(session, payload, cancellationToken),
        _ => throw new NendoPreconditionException("unknown-method", $"Unknown legacy Workbench method {method}."),
    };

    private static async Task<DesktopMutationView> CreateIdeaAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<IdempotentPayload>(payload);
        return await session.CreateIdeaSchemaAsync(request.IdempotencyKey, cancellationToken);
    }

    private static async Task<DesktopMutationView> CreateRecordAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<CreateIdeaRecordPayload>(payload);
        return await session.CreateIdeaRecordAsync(
            request.RecordId,
            request.Title,
            request.IdempotencyKey,
            cancellationToken);
    }

    private static async Task<DesktopMutationView> SetTitleAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<SetIdeaTitlePayload>(payload);
        return await session.SetIdeaTitleAsync(
            request.RecordId,
            request.ExpectedRecordVersion,
            request.Title,
            request.IdempotencyKey,
            cancellationToken);
    }

    private static async Task<DesktopMutationView> CreateFullRecordAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<CreateFullIdeaPayload>(payload);
        return await session.CreateIdeaRecordAsync(
            request.RecordId,
            new NendoIdeaDraft(
                request.Title,
                request.Notes,
                request.Status,
                request.Energy,
                request.CreatedDate,
                request.NextAction),
            request.IdempotencyKey,
            cancellationToken);
    }

    private static async Task<DesktopMutationView> SetFieldAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<SetIdeaFieldPayload>(payload);
        return await session.SetIdeaFieldAsync(
            request.RecordId,
            request.ExpectedRecordVersion,
            request.FieldId,
            request.Value,
            request.IdempotencyKey,
            cancellationToken);
    }

    private static async Task<DesktopMutationView> ExecuteCommandAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ExecuteIdeaCommandPayload>(payload);
        return await session.ExecuteIdeaCommandAsync(
            request.CommandId,
            request.RecordId,
            request.ExpectedRecordVersion,
            request.IdempotencyKey,
            cancellationToken);
    }

    private static async Task<NendoProposalPreview> PrepareBoardTitleAsync(
        DesktopSessionController session,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<BoardTitlePayload>(payload);
        return await session.PrepareBoardTitleProposalAsync(request.Title, cancellationToken);
    }

    private static T Deserialize<T>(JsonElement payload) where T : class =>
        payload.Deserialize<T>(JsonOptions)
        ?? throw new NendoValidationException("The Workbench request payload is missing or invalid.");
}
