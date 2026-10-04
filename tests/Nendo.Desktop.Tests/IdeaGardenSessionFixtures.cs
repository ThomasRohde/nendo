using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The Idea Garden reference application, driven through a Desktop session for tests that need a
/// file with a schema, records or a waiting proposal in it.
/// <para>
/// These lived in the Desktop until W-135 (2026-10-04) retired bridge protocols 2 to 6, the last
/// production callers. They go through the session's own request gate, so a test that expects a
/// refusal (no file, recovery, a lost write owner) still meets the real one.
/// </para>
/// </summary>
internal static class IdeaGardenSessionFixtures
{
    internal static Task<DesktopMutationView> CreateIdeaSchemaAsync(
        this DesktopSessionController session,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        session.MutateAsync(
            service => service.CreateIdeaSchemaAsync(idempotencyKey, cancellationToken),
            cancellationToken);

    internal static Task<DesktopMutationView> CreateIdeaRecordAsync(
        this DesktopSessionController session,
        string recordId,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        session.MutateAsync(
            service => service.CreateIdeaRecordAsync(recordId, title, idempotencyKey, cancellationToken),
            cancellationToken);

    internal static Task<DesktopMutationView> CreateIdeaRecordAsync(
        this DesktopSessionController session,
        string recordId,
        NendoIdeaDraft draft,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        session.MutateAsync(
            service => service.CreateIdeaRecordAsync(recordId, draft, idempotencyKey, cancellationToken),
            cancellationToken);

    internal static Task<DesktopMutationView> SetIdeaTitleAsync(
        this DesktopSessionController session,
        string recordId,
        long expectedRecordVersion,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        session.MutateAsync(
            service => service.SetIdeaTitleAsync(recordId, expectedRecordVersion, title, idempotencyKey, cancellationToken),
            cancellationToken);

    internal static Task<DesktopMutationView> ExecuteIdeaCommandAsync(
        this DesktopSessionController session,
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        session.MutateAsync(
            service => service.ExecuteIdeaCommandAsync(commandId, recordId, expectedRecordVersion, idempotencyKey, cancellationToken),
            cancellationToken);

    internal static Task<NendoProposalPreview> PrepareIdeaGardenProposalAsync(
        this DesktopSessionController session,
        CancellationToken cancellationToken = default) =>
        session.QueryAsync(service => service.PrepareIdeaGardenProposalAsync(cancellationToken), cancellationToken);
}
