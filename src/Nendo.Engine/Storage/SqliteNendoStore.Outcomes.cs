using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<NendoApplyResult?> GetMutationReceiptAsync(
        NendoOperationIdentity identity, NendoAuthoritySnapshot expectedAuthority, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        await VerifyReceiptAuthorityAsync(expectedAuthority, transaction, cancellationToken);
        const string sql = """
            SELECT r.revision_id, r.operation_digest, r.definition_revision_after,
                   r.data_revision_after, r.change_sequence
            FROM __nendo_idempotency i JOIN __nendo_revision r ON r.revision_id = i.revision_id
            WHERE i.idempotency_scope = @scope AND i.idempotency_key = @key;
            """;
        NendoApplyResult? receipt;
        await using (var command = Command(sql, transaction))
        {
            command.Parameters.AddWithValue("@scope", identity.IdempotencyScope);
            command.Parameters.AddWithValue("@key", identity.IdempotencyKey);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            receipt = await reader.ReadAsync(cancellationToken)
                ? new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetInt64(3), reader.GetInt64(4), true)
                : null;
        }
        return receipt is null
            ? null
            : receipt with { GeneratedChanges = await ReadGeneratedChangesAsync(receipt.RevisionId, transaction, cancellationToken) };
    }

    /// <summary>
    /// What a committed revision's automatic actions wrote, rebuilt from the operations
    /// its attribution rows annotate. The write result carried this at commit time; a
    /// receipt read back after a lost response, and an exact replay, carried nothing,
    /// so a client recovering an outcome had to re-read every record to learn the
    /// side effect. Versions are left null: the file may have moved since.
    /// </summary>
    private async Task<IReadOnlyList<NendoGeneratedChange>> ReadGeneratedChangesAsync(
        string revisionId, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return [];
        const string sql = """
            SELECT o.canonical_json
            FROM __nendo_operation o
            JOIN __nendo_attribution a ON a.revision_id = o.revision_id AND a.ordinal = o.ordinal
            WHERE o.revision_id = @revision ORDER BY o.ordinal;
            """;
        var generated = new List<NendoOperation>();
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@revision", revisionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            generated.Add(NendoOperationCodec.Read(reader.GetString(0)));
        }
        return CollapseGeneratedChanges(generated, withVersions: false);
    }

    internal async Task<NendoChangeSetApplyResult?> GetProposalReceiptAsync(
        string proposalId, NendoAuthoritySnapshot expectedAuthority, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        await VerifyReceiptAuthorityAsync(expectedAuthority, transaction, cancellationToken);
        return await ReadProposalReceiptAsync(proposalId, transaction, cancellationToken);
    }

    private async Task VerifyReceiptAuthorityAsync(NendoAuthoritySnapshot expectedAuthority,
        SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        if (await ReadAuthoritySnapshotAsync(transaction, cancellationToken) != expectedAuthority)
            throw new NendoRecoveryRequiredException("The open file changed outside its trusted session; its outcome evidence must be inspected again.");
    }

    private async Task<NendoChangeSetApplyResult?> ReadProposalReceiptAsync(
        string proposalId, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        if (!await ColumnExistsAsync("__nendo_revision", "proposal_id", transaction, cancellationToken)) return null;
        const string sql = """
            SELECT revision_id, operation_digest, definition_revision_after, data_revision_after,
                   change_sequence, proposal_digest
            FROM __nendo_revision WHERE proposal_id = @proposalId ORDER BY change_sequence;
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@proposalId", proposalId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var results = new List<NendoApplyResult>();
        string? digest = null;
        while (await reader.ReadAsync(cancellationToken))
        {
            if (reader.IsDBNull(5) || digest is not null && digest != reader.GetString(5) ||
                results.Count > 0 && results[^1].ChangeSequence + 1 != reader.GetInt64(4))
                throw new NendoRecoveryRequiredException("The committed proposal evidence is inconsistent.");
            digest = reader.GetString(5);
            results.Add(new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2),
                reader.GetInt64(3), reader.GetInt64(4), true));
        }
        return results.Count == 0 ? null : new(digest!, results.AsReadOnly(), results[^1].DefinitionRevision,
            results[^1].DataRevision, results[^1].ChangeSequence);
    }
}
