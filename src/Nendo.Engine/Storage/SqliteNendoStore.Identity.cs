using System.Text.Json;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>Used only on a verified owned stage, never on the active source.</summary>
    internal async Task<string> ApplyIdentityTransitionAsync(
        IdentityCopyIntent intent, IdentityTransitionOperation operation, string revisionId,
        DateTimeOffset createdAt, Action? beforeCommit, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        RequireUnattachedStage();
        using var transaction = _connection.BeginTransaction(deferred: false);
        var before = await ReadManifestAsync(transaction, cancellationToken);
        if (before != intent.Source || operation.Source != NendoIdentitySourcePoint.From(before) ||
            operation.RequestDigest != intent.RequestDigest || operation.Kind != intent.Kind ||
            operation.OperationId != intent.Operation(operation.ResultApplicationId, operation.ResultInstanceId).OperationId ||
            await ReadContentDigestAsync(cancellationToken, transaction) != intent.ContentDigest)
        {
            throw new NendoPreconditionException("identity-source-changed", "The identity transition does not match its verified source snapshot.");
        }
        var definitionAfter = checked(before.DefinitionRevision + 1);
        var sequenceAfter = checked(before.ChangeSequence + 1);
        await using (var command = Command("UPDATE __nendo_manifest SET application_id = @application, instance_id = @instance WHERE singleton_id = 1;", transaction))
        {
            command.Parameters.AddWithValue("@application", operation.ResultApplicationId);
            command.Parameters.AddWithValue("@instance", operation.ResultInstanceId);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        // Deliberately bypass generic mutation execution, which rejects this type.
        await AppendRevisionAsync(intent.Mutation(operation), [new(operation, "{\"irreversible\":true}")],
            before, revisionId, createdAt, definitionAfter, before.DataRevision, sequenceAfter,
            null, null, null, transaction, cancellationToken);
        await UpdateManifestAsync(createdAt, definitionAfter, before.DataRevision, sequenceAfter,
            NendoFormat.RequireAtLeast(before.MinimumHostVersion, NendoFormat.LifecycleMinimumHostVersion), transaction, cancellationToken);
        var resultDigest = await ReadContentDigestAsync(cancellationToken, transaction);
        beforeCommit?.Invoke();
        cancellationToken.ThrowIfCancellationRequested();
        transaction.Commit();
        return resultDigest;
    }

    internal static (IdentityTransitionOperation Operation, NendoRevisionSnapshot Revision)? FindIdentityCopyEvidence(
        InspectedNendoFile file, IdentityCopyIntent intent)
    {
        try
        {
            // A used/changed destination is not an exact retry of its original copy.
            var revision = file.History.LastOrDefault();
            if (file.Inspection.Classification != NendoOpenClassification.NormalReadOnly || revision is null ||
                revision.IdempotencyScope != intent.Scope || revision.IdempotencyKey != intent.RequestId ||
                revision.Operations.Count != 1 || revision.Operations[0].OperationType != "identity.transition") return null;
            using var body = JsonDocument.Parse(revision.Operations[0].CanonicalJson);
            var payload = body.RootElement.GetProperty("payload");
            var operation = intent.Operation(payload.GetProperty("resultApplicationId").GetString()!, payload.GetProperty("resultInstanceId").GetString()!);
            var mutation = intent.Mutation(operation);
            if (operation.CanonicalJson() != revision.Operations[0].CanonicalJson ||
                revision.OperationDigest != mutation.OperationDigest ||
                revision.Origin != mutation.Origin || revision.Description != mutation.Description ||
                revision.Lane != NendoRevisionLane.Definition || revision.ProposalId is not null ||
                revision.ProposalDigest is not null || revision.CompensationOfRevisionId is not null ||
                revision.DefinitionRevisionBefore != intent.Source.DefinitionRevision ||
                revision.DefinitionRevisionAfter != checked(intent.Source.DefinitionRevision + 1) ||
                revision.DataRevisionBefore != intent.Source.DataRevision || revision.DataRevisionAfter != intent.Source.DataRevision ||
                revision.ChangeSequence != checked(intent.Source.ChangeSequence + 1)) return null;
            return (operation, revision);
        }
        catch (Exception exception) when (IsProjectionFailure(exception) || exception is KeyNotFoundException)
        {
            return null;
        }
    }
}
