using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed partial class DesktopSessionController
{
    internal async Task<DesktopMutationView> CreateIdeaSchemaAsync(
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.CreateIdeaSchemaAsync(idempotencyKey, cancellationToken),
            cancellationToken);

    internal async Task<DesktopMutationView> CreateIdeaRecordAsync(
        string recordId,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.CreateIdeaRecordAsync(recordId, title, idempotencyKey, cancellationToken),
            cancellationToken);

    internal async Task<DesktopMutationView> CreateIdeaRecordAsync(
        string recordId,
        NendoIdeaDraft draft,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.CreateIdeaRecordAsync(recordId, draft, idempotencyKey, cancellationToken),
            cancellationToken);

    internal async Task<DesktopMutationView> SetIdeaTitleAsync(
        string recordId,
        long expectedRecordVersion,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.SetIdeaTitleAsync(
                recordId,
                expectedRecordVersion,
                title,
                idempotencyKey,
                cancellationToken),
            cancellationToken);

    internal async Task<DesktopMutationView> SetIdeaFieldAsync(
        string recordId,
        long expectedRecordVersion,
        string fieldId,
        object? value,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.SetIdeaFieldAsync(
                recordId,
                expectedRecordVersion,
                fieldId,
                value,
                idempotencyKey,
                cancellationToken),
            cancellationToken);

    internal async Task<DesktopMutationView> ExecuteIdeaCommandAsync(
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.ExecuteIdeaCommandAsync(
                commandId,
                recordId,
                expectedRecordVersion,
                idempotencyKey,
                cancellationToken),
            cancellationToken);

    internal Task<NendoProposalPreview> PrepareIdeaGardenProposalAsync(
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.PrepareIdeaGardenProposalAsync(cancellationToken), cancellationToken);

    internal Task<NendoProposalPreview> PrepareBoardTitleProposalAsync(
        string title,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.PrepareBoardTitleProposalAsync(title, cancellationToken), cancellationToken);
}
