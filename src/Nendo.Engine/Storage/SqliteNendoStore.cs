using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore : IAsyncDisposable
{
    private const int BusyTimeoutMilliseconds = 2_000;
    private readonly string _path;
    private readonly SqliteConnection _connection;
    private bool _disposed;

    private static string EvidenceMinimumHost(IEnumerable<OperationEvidence> evidence, string current) =>
        evidence.Aggregate(current, (minimum, item) => NendoFormat.RequireAtLeast(minimum, item.RequiredHostVersion));

    private static bool TouchesUiNodes(IEnumerable<NendoOperation> operations) => operations.Any(operation =>
        operation is AddUiNodeOperation or SetUiPropertyOperation or MoveUiNodeOperation or RemoveUiNodeOperation);

    /// <summary>
    /// The minimum host a mutation leaves the file needing. Per-operation evidence
    /// covers the storage extensions an operation touches; the semantic capability
    /// is read from the node tree the mutation leaves behind, because a widened
    /// definition is a shape rather than an operation — a second list root and a
    /// moved tile change what a host must understand without any operation saying
    /// so. It is computed once, after every operation in the mutation has applied,
    /// so inline-property expansion order cannot produce a false answer.
    /// </summary>
    private async Task<string> MutationMinimumHostAsync(
        IReadOnlyList<NendoOperation> operations,
        IReadOnlyList<OperationEvidence> evidence,
        string current,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var minimum = EvidenceMinimumHost(evidence, current);
        if (!TouchesUiNodes(operations)) return minimum;
        var nodes = await ReadUiNodesAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        return NendoFormat.RequireAtLeast(minimum, NendoSemanticCapability.RequiredHostVersion(nodes, CapabilityFields(mappings)));
    }

    /// <summary>
    /// The stored fields as the capability ladder reads them. Only a UI operation can make
    /// a board group by a reference — a field's storage kind never changes underneath one,
    /// because the only conversion binds an unbound reference rather than turning a choice
    /// into one — so this is read on the same condition the tree is, and a schema mutation
    /// alone still skips both.
    /// </summary>
    private static IReadOnlyList<NendoCapabilityField> CapabilityFields(IReadOnlyList<EntityMapping> mappings) =>
        [.. mappings.SelectMany(entity => entity.Fields
            .Select(field => new NendoCapabilityField(entity.EntityId, field.FieldId, field.StorageKind)))];

    private SqliteNendoStore(string path, SqliteConnection connection)
    {
        _path = path;
        _connection = connection;
    }

    internal static async Task<SqliteNendoStore> CreateAsync(
        string path,
        CancellationToken cancellationToken)
    {
        var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadWrite, cancellationToken);
        var store = new SqliteNendoStore(path, connection);
        try
        {
            await store.ApplyAndVerifyProfileAsync(cancellationToken);
            await store.CreateSchemaAsync(cancellationToken);
            await store.ValidateAsync(cancellationToken);
            return store;
        }
        catch
        {
            await store.DisposeAsync();
            throw;
        }
    }

    internal static async Task<SqliteNendoStore> OpenAsync(
        string path,
        CancellationToken cancellationToken)
    {
        var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadWrite, cancellationToken);
        var store = new SqliteNendoStore(path, connection);
        try
        {
            await store.ApplyAndVerifyProfileAsync(cancellationToken);
            await store.ValidateAsync(cancellationToken);
            return store;
        }
        catch
        {
            await store.DisposeAsync();
            throw;
        }
    }

    internal async Task<(NendoApplyResult Result, NendoAuthoritySnapshot Authority)> ApplyAsync(
        NendoMutation mutation,
        NendoAuthoritySnapshot expectedAuthority,
        CancellationToken cancellationToken,
        string? compensationOfRevisionId = null,
        Action? beforeAuthorityRead = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        mutation.Validate();

        if (mutation.Operations.Any(operation => operation is ConvertLegacyReferenceOperation))
            throw new NendoValidationException("Legacy conversion requires an atomic reviewed change set with reference binding.");

        using var transaction = _connection.BeginTransaction(deferred: false);
        var committed = false;
        try
        {
            var currentAuthority = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
            if (currentAuthority != expectedAuthority)
            {
                throw new NendoRecoveryRequiredException(
                    "The open Nendo state changed outside the write coordinator; recovery is required before another mutation.");
            }

            var replay = await TryResolveReplayAsync(mutation, transaction, cancellationToken);
            if (replay is not null)
            {
                transaction.Rollback();
                return (replay, currentAuthority);
            }

            var manifestBefore = await ReadManifestAsync(transaction, cancellationToken);
            // Hook one: the state every logical event is measured against, captured
            // before a single operation is staged.
            // A compensation reverses operations that are already recorded, including
            // the ones actions generated. Running the actions again over the reversal
            // would apply effects on top of the ones being undone, so expansion is off
            // for exactly this case. It cannot be asked for: the only way in is the
            // host's own compensation route, which is what supplies this revision ID.
            var replayingInverses = compensationOfRevisionId is not null;
            var behaviourBefore = replayingInverses
                ? new Dictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>()
                : await CaptureBehaviourBeforeAsync(mutation.Operations, transaction, cancellationToken);
            var newEntityIds = mutation.Operations
                .OfType<CreateEntityOperation>()
                .Select(operation => operation.EntityId)
                .ToHashSet(StringComparer.Ordinal);
            var requiresSemanticHost = mutation.Operations.Any(operation =>
                operation is AddUiNodeOperation or SetUiPropertyOperation or MoveUiNodeOperation or RemoveUiNodeOperation ||
                operation is AddFieldOperation field &&
                    (!newEntityIds.Contains(field.EntityId) || field.Presentation is not null || field.Options.Count != 0));
            await RequireSupportedWritableLayoutAsync(transaction, cancellationToken);
            await RequireRoomToGrowAsync(transaction, cancellationToken);
            var evidence = new List<OperationEvidence>(mutation.Operations.Count);
            foreach (var operation in mutation.Operations)
            {
                evidence.Add(await ExecuteOperationMetadataOrDataAsync(
                    operation,
                    newEntityIds,
                    transaction,
                    cancellationToken));
            }
            // Hook two: every initiating operation is staged, so the file now shows the
            // complete edit and no half-formed intermediate. Automatic actions run
            // against that, and their generated writes join `evidence` as ordinary
            // operations of the same revision.
            var chain = replayingInverses
                ? null
                : await RunBehaviourChainAsync(mutation, behaviourBefore, evidence, transaction, cancellationToken);
            await MaterializeSchemaChangesAsync(
                mutation.Operations.Concat(evidence.Skip(mutation.Operations.Count).Select(item => item.Operation)).ToArray(),
                newEntityIds,
                transaction,
                cancellationToken);

            var lane = mutation.Operations[0].Lane;
            if (lane == NendoRevisionLane.Definition) await ValidateRetiredBindingsAsync(transaction, cancellationToken);
            var definitionAfter = manifestBefore.DefinitionRevision +
                (lane == NendoRevisionLane.Definition ? 1 : 0);
            var dataAfter = manifestBefore.DataRevision +
                (lane == NendoRevisionLane.Data ? 1 : 0);
            var sequenceAfter = manifestBefore.ChangeSequence + 1;
            var revisionId = $"revision-{Guid.NewGuid():N}";
            var now = DateTimeOffset.UtcNow;

            await AppendRevisionAsync(
                mutation,
                evidence,
                manifestBefore,
                revisionId,
                now,
                definitionAfter,
                dataAfter,
                sequenceAfter,
                null,
                null,
                compensationOfRevisionId,
                transaction,
                cancellationToken);
            await WriteAttributionAsync(revisionId, mutation.Operations.Count, chain, transaction, cancellationToken);
            await UpdateManifestAsync(
                now,
                definitionAfter,
                dataAfter,
                sequenceAfter,
                await MutationMinimumHostAsync(
                    mutation.Operations,
                    evidence,
                    requiresSemanticHost
                        ? NendoFormat.RequireAtLeast(manifestBefore.MinimumHostVersion, NendoFormat.SemanticMinimumHostVersion)
                        : manifestBefore.MinimumHostVersion,
                    transaction,
                    cancellationToken),
                transaction,
                cancellationToken);

            var result = new NendoApplyResult(
                revisionId,
                // The expanded digest covers what was actually committed, generated
                // writes included. The request's own payload digest still keys
                // idempotency, so a retry is recognised by what was asked for while
                // history records what happened.
                NendoCanonical.DigestOperations(evidence.Select(item => item.Operation).ToArray()),
                definitionAfter,
                dataAfter,
                sequenceAfter,
                false)
            {
                GeneratedChanges = GeneratedChanges(chain),
            };
            // Capture exactly our transaction's authority while it still owns
            // the SQLite write lock. No cancellable refresh follows COMMIT.
            beforeAuthorityRead?.Invoke();
            RequireBehaviourStillGranted(chain);
            var committedAuthority = await PrepareCommittedAuthorityAsync(transaction, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            transaction.Commit();
            committed = true;
            _authorityCache = committedAuthority;
            _verifiedContentDigest = null;
            return (result, committedAuthority);
        }
        catch
        {
            if (!committed)
            {
                transaction.Rollback();
                // The behaviour table is created inside this transaction, so a rollback
                // takes it away again. The flag that remembers it does not roll back.
                ForgetBehaviourTableCache();
            }
            throw;
        }
    }

    internal async Task<NendoAuthoritySnapshot> GetAuthoritySnapshotAsync(
        CancellationToken cancellationToken) =>
        await ReadAuthoritySnapshotAsync(null, cancellationToken);

    internal async Task BackupToAsync(
        string destinationPath,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        cancellationToken.ThrowIfCancellationRequested();
        if (File.Exists(destinationPath))
        {
            throw new IOException("The proposal clone destination already exists.");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)
            ?? throw new NendoValidationException("The proposal clone needs a parent directory."));
        await using var destination = await OpenConnectionAsync(
            destinationPath,
            SqliteOpenMode.ReadWriteCreate,
            cancellationToken);
        _connection.BackupDatabase(destination);
        cancellationToken.ThrowIfCancellationRequested();
    }

    /// <summary>
    /// Applies a reviewed change set.
    /// <para>
    /// It runs in one of two modes and never in between. Preparing a proposal expands
    /// automatic actions on the throwaway clone and reports what they did, so the
    /// owner reviews the whole effect rather than only the part an agent asked for.
    /// Promotion replays exactly those reviewed operations against the live file with
    /// expansion switched off, because running the triggers a second time would apply
    /// effects nobody reviewed on top of the ones they did.
    /// </para>
    /// </summary>
    /// <param name="expansion">
    /// Collects what the actions did, when preparing. Null when promoting: that is
    /// what makes replay a replay.
    /// </param>
    internal async Task<(NendoChangeSetApplyResult Result, NendoAuthoritySnapshot Authority)> ApplyChangeSetAsync(
        NendoChangeSet changeSet,
        NendoAuthoritySnapshot expectedAuthority,
        string proposalId,
        Action? beforeCommit,
        CancellationToken cancellationToken,
        Action? beforeAuthorityRead = null,
        List<(int MutationIndex, BehaviourExecutionContext Context)>? expansion = null,
        PreparedBehaviourPlan? reviewedPlan = null,
        long? reviewedRevocationGeneration = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentException.ThrowIfNullOrWhiteSpace(proposalId);
        changeSet.Validate();
        var changeSetDigest = changeSet.OperationDigest;

        // Promotion replays reviewed effects with expansion off, so the chain's own
        // consent gate never fires. The grant the reviewed plan needs is re-checked at
        // the commit boundary against the generation the coordinator read before its
        // own grant check, so approval withdrawn at any point after that check aborts
        // the whole thing — the same guarantee the single-write path gives through
        // RequireBehaviourStillGranted. Reading the generation here instead left a
        // window between the coordinator's check and this call in which a revoke and
        // regrant went unnoticed.
        var reviewedGrant = expansion is null && reviewedPlan is { Generated.Count: > 0 }
            ? reviewedPlan.RequiredGrant : null;
        reviewedRevocationGeneration ??= BehaviourAuthority.RevocationGeneration;

        using var transaction = _connection.BeginTransaction(deferred: false);
        var committed = false;
        try
        {
            var currentAuthority = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
            if (currentAuthority != expectedAuthority)
            {
                throw new NendoRecoveryRequiredException(
                    "The open Nendo state changed outside the write coordinator; recovery is required before proposal promotion.");
            }
            var committedProposal = await ReadProposalReceiptAsync(proposalId, transaction, cancellationToken);
            if (committedProposal is not null)
            {
                if (committedProposal.ChangeSetDigest != changeSetDigest ||
                    committedProposal.Revisions.Count != changeSet.Mutations.Count)
                    throw new NendoIdempotencyConflictException("The proposal identity already names a different committed change set.");
                for (var index = 0; index < changeSet.Mutations.Count; index++)
                {
                    var replay = await TryResolveReplayAsync(changeSet.Mutations[index], transaction, cancellationToken);
                    if (replay?.RevisionId != committedProposal.Revisions[index].RevisionId)
                        throw new NendoIdempotencyConflictException("The proposal request identities do not match its committed evidence.");
                }
                transaction.Rollback();
                return (committedProposal, currentAuthority);
            }
            foreach (var mutation in changeSet.Mutations)
            {
                if (await TryResolveReplayAsync(mutation, transaction, cancellationToken) is not null)
                {
                    throw new NendoIdempotencyConflictException(
                        "A proposal mutation idempotency key was already committed.");
                }
            }

            await RequireSupportedWritableLayoutAsync(transaction, cancellationToken);
            await RequireRoomToGrowAsync(transaction, cancellationToken);
            var running = await ReadManifestAsync(transaction, cancellationToken);
            var results = new List<NendoApplyResult>(changeSet.Mutations.Count);
            foreach (var mutation in changeSet.Mutations)
            {
                var mutationIndex = results.Count;
                var newEntityIds = mutation.Operations
                    .OfType<CreateEntityOperation>()
                    .Select(operation => operation.EntityId)
                    .ToHashSet(StringComparer.Ordinal);
                var behaviourBefore = expansion is null
                    ? new Dictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>()
                    : await CaptureBehaviourBeforeAsync(mutation.Operations, transaction, cancellationToken);
                var evidence = new List<OperationEvidence>(mutation.Operations.Count);
                foreach (var operation in mutation.Operations)
                {
                    evidence.Add(await ExecuteOperationMetadataOrDataAsync(
                        operation,
                        newEntityIds,
                        transaction,
                        cancellationToken));
                }
                var chain = expansion is null
                    ? null
                    : await RunBehaviourChainAsync(mutation, behaviourBefore, evidence, transaction, cancellationToken);
                if (chain is not null) expansion!.Add((results.Count, chain));
                await MaterializeSchemaChangesAsync(
                    mutation.Operations.Concat(evidence.Skip(mutation.Operations.Count).Select(item => item.Operation)).ToArray(),
                    newEntityIds,
                    transaction,
                    cancellationToken);

                var lane = mutation.Operations[0].Lane;
                var definitionAfter = running.DefinitionRevision +
                    (lane == NendoRevisionLane.Definition ? 1 : 0);
                var dataAfter = running.DataRevision +
                    (lane == NendoRevisionLane.Data ? 1 : 0);
                var sequenceAfter = running.ChangeSequence + 1;
                var revisionId = $"revision-{Guid.NewGuid():N}";
                var now = DateTimeOffset.UtcNow;
                await AppendRevisionAsync(
                    mutation,
                    evidence,
                    running,
                    revisionId,
                    now,
                    definitionAfter,
                    dataAfter,
                    sequenceAfter,
                    proposalId,
                    changeSetDigest,
                    null,
                    transaction,
                    cancellationToken);
                running = running with
                {
                    ModifiedAt = now,
                    MinimumHostVersion = await MutationMinimumHostAsync(
                        mutation.Operations,
                        evidence,
                        NendoFormat.RequireAtLeast(running.MinimumHostVersion, NendoFormat.SemanticMinimumHostVersion),
                        transaction,
                        cancellationToken),
                    DefinitionRevision = definitionAfter,
                    DataRevision = dataAfter,
                    ChangeSequence = sequenceAfter,
                };
                // Later mutations in this same transaction validate against the staged
                // definition/data revisions, not the pre-proposal manifest. Nothing is
                // externally visible until the enclosing transaction commits.
                await UpdateManifestAsync(running.ModifiedAt, running.DefinitionRevision, running.DataRevision,
                    running.ChangeSequence, running.MinimumHostVersion, transaction, cancellationToken);
                // On promotion the chain is null because expansion is off; the reviewed
                // generated operations are folded into this mutation and their attribution
                // travels on the plan. Writing it here keeps every generated operation's
                // provenance and lets the receipt rebuild what changed. The pre-fold
                // operation count is the ordinal base, since the folded generated ops sit
                // after the author's own in the revision.
                var reviewedForMutation = reviewedPlan is null
                    ? []
                    : reviewedPlan.Generated.Where(operation => operation.MutationIndex == mutationIndex).ToArray();
                if (chain is not null)
                    await WriteAttributionAsync(revisionId, mutation.Operations.Count, chain, transaction, cancellationToken);
                else if (reviewedForMutation.Length > 0)
                    await WriteReviewedAttributionAsync(revisionId,
                        mutation.Operations.Count - reviewedForMutation.Length, reviewedForMutation,
                        transaction, cancellationToken);
                results.Add(new NendoApplyResult(
                    revisionId,
                    NendoCanonical.DigestOperations(evidence.Select(item => item.Operation).ToArray()),
                    definitionAfter,
                    dataAfter,
                    sequenceAfter,
                    false)
                {
                    GeneratedChanges = chain is not null
                        ? GeneratedChanges(chain)
                        : reviewedForMutation.Length == 0
                            ? []
                            : CollapseGeneratedChanges(
                                reviewedForMutation.Select(operation => NendoOperationCodec.Read(operation.CanonicalJson)),
                                withVersions: true),
                });
            }

            beforeCommit?.Invoke();
            await UpdateManifestAsync(
                running.ModifiedAt,
                running.DefinitionRevision,
                running.DataRevision,
                running.ChangeSequence,
                running.MinimumHostVersion,
                transaction,
                cancellationToken);
            await ValidateRetiredBindingsAsync(transaction, cancellationToken);
            var result = new NendoChangeSetApplyResult(
                changeSetDigest,
                results.AsReadOnly(),
                running.DefinitionRevision,
                running.DataRevision,
                running.ChangeSequence);
            beforeAuthorityRead?.Invoke();
            if (reviewedGrant is not null &&
                (BehaviourAuthority.RevocationGeneration != reviewedRevocationGeneration ||
                 !BehaviourAuthority.IsGranted(reviewedGrant)))
            {
                throw new NendoPreconditionException(
                    "behaviour-not-approved",
                    "Approval for this file's automatic actions was withdrawn while saving, so nothing was changed.");
            }
            var committedAuthority = await PrepareCommittedAuthorityAsync(transaction, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            transaction.Commit();
            committed = true;
            _authorityCache = committedAuthority;
            _verifiedContentDigest = null;
            return (result, committedAuthority);
        }
        catch
        {
            if (!committed)
            {
                transaction.Rollback();
                // The behaviour table is created inside this transaction, so a rollback
                // takes it away again. The flag that remembers it does not roll back.
                ForgetBehaviourTableCache();
            }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        await _connection.DisposeAsync();
    }

    private static async Task<SqliteConnection> OpenConnectionAsync(
        string path,
        SqliteOpenMode mode,
        CancellationToken cancellationToken)
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = mode,
            Cache = SqliteCacheMode.Private,
            ForeignKeys = true,
            Pooling = false,
            DefaultTimeout = BusyTimeoutMilliseconds / 1_000,
        };
        var connection = new SqliteConnection(builder.ToString());
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private async Task ApplyAndVerifyProfileAsync(CancellationToken cancellationToken)
    {
        var journal = Convert.ToString(
            await ScalarAsync("PRAGMA journal_mode = DELETE;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        if (!string.Equals(journal, "delete", StringComparison.OrdinalIgnoreCase))
        {
            throw new NendoValidationException($"SQLite reported journal mode {journal ?? "<null>"} instead of DELETE.");
        }

        await NonQueryAsync("PRAGMA synchronous = FULL;", null, cancellationToken);
        await NonQueryAsync($"PRAGMA busy_timeout = {BusyTimeoutMilliseconds};", null, cancellationToken);
        await NonQueryAsync("PRAGMA foreign_keys = ON;", null, cancellationToken);

        var synchronous = Convert.ToInt64(
            await ScalarAsync("PRAGMA synchronous;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        var busyTimeout = Convert.ToInt64(
            await ScalarAsync("PRAGMA busy_timeout;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        var foreignKeys = Convert.ToInt64(
            await ScalarAsync("PRAGMA foreign_keys;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        if (synchronous != 2 || busyTimeout != BusyTimeoutMilliseconds || foreignKeys != 1)
        {
            throw new NendoValidationException(
                "The SQLite connection did not retain the required FULL/2000 ms/foreign-key profile.");
        }
    }

    private const string CurrentSchemaSql = """
            CREATE TABLE __nendo_manifest (
                singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
                format_identifier TEXT NOT NULL,
                format_version INTEGER NOT NULL,
                minimum_host_version TEXT NOT NULL,
                application_id TEXT NOT NULL,
                instance_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                definition_revision INTEGER NOT NULL,
                data_revision INTEGER NOT NULL,
                change_sequence INTEGER NOT NULL
            );

            CREATE TABLE __nendo_entity (
                entity_id TEXT NOT NULL PRIMARY KEY,
                display_name TEXT NOT NULL,
                physical_table_name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE __nendo_field (
                field_id TEXT NOT NULL PRIMARY KEY,
                entity_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                physical_column_name TEXT NOT NULL,
                storage_kind TEXT NOT NULL,
                required INTEGER NOT NULL,
                presentation TEXT NULL,
                options_json TEXT NOT NULL DEFAULT '[]',
                UNIQUE (entity_id, physical_column_name),
                FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id) ON DELETE CASCADE
            );

            CREATE TABLE __nendo_ui_node (
                node_id TEXT NOT NULL PRIMARY KEY,
                surface_id TEXT NOT NULL,
                parent_node_id TEXT NULL,
                kind TEXT NOT NULL,
                position INTEGER NOT NULL CHECK (position >= 0),
                FOREIGN KEY (parent_node_id) REFERENCES __nendo_ui_node(node_id) ON DELETE CASCADE
            );

            CREATE INDEX __nendo_ui_node_surface
            ON __nendo_ui_node(surface_id, parent_node_id, position, node_id);

            CREATE TABLE __nendo_ui_property (
                node_id TEXT NOT NULL,
                property_name TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY (node_id, property_name),
                FOREIGN KEY (node_id) REFERENCES __nendo_ui_node(node_id) ON DELETE CASCADE
            );

            CREATE TABLE __nendo_revision (
                revision_id TEXT NOT NULL PRIMARY KEY,
                created_at TEXT NOT NULL,
                origin TEXT NOT NULL,
                description TEXT NOT NULL,
                lane TEXT NOT NULL,
                definition_revision_before INTEGER NOT NULL,
                definition_revision_after INTEGER NOT NULL,
                data_revision_before INTEGER NOT NULL,
                data_revision_after INTEGER NOT NULL,
                change_sequence INTEGER NOT NULL UNIQUE,
                operation_digest TEXT NOT NULL,
                idempotency_scope TEXT NULL,
                idempotency_key TEXT NULL,
                proposal_id TEXT NULL,
                proposal_digest TEXT NULL,
                compensation_of_revision_id TEXT NULL
            );

            CREATE TABLE __nendo_operation (
                revision_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                operation_id TEXT NOT NULL UNIQUE,
                operation_type TEXT NOT NULL,
                canonical_json TEXT NOT NULL,
                reversibility TEXT NOT NULL,
                inverse_evidence_json TEXT NOT NULL,
                PRIMARY KEY (revision_id, ordinal),
                FOREIGN KEY (revision_id) REFERENCES __nendo_revision(revision_id) ON DELETE CASCADE
            );

            CREATE TABLE __nendo_idempotency (
                idempotency_scope TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                payload_digest TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                PRIMARY KEY (idempotency_scope, idempotency_key),
                FOREIGN KEY (revision_id) REFERENCES __nendo_revision(revision_id) ON DELETE CASCADE
            );
            """;

    private async Task CreateSchemaAsync(CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction();
        await NonQueryAsync(CurrentSchemaSql, transaction, cancellationToken);
        await NonQueryAsync(
            $"PRAGMA application_id = {NendoFormat.SqliteApplicationId};",
            transaction,
            cancellationToken);
        await NonQueryAsync(
            $"PRAGMA user_version = {NendoFormat.CurrentVersion};",
            transaction,
            cancellationToken);

        var now = DateTimeOffset.UtcNow;
        var applicationId = $"application-{Guid.NewGuid():N}";
        var instanceId = $"instance-{Guid.NewGuid():N}";
        const string manifestSql = """
            INSERT INTO __nendo_manifest (
                singleton_id, format_identifier, format_version, minimum_host_version,
                application_id, instance_id, created_at, modified_at,
                definition_revision, data_revision, change_sequence)
            VALUES (1, @formatIdentifier, @formatVersion, @minimumHostVersion,
                @applicationId, @instanceId, @createdAt, @modifiedAt, 0, 0, 0);
            """;
        await using (var command = Command(manifestSql, transaction))
        {
            command.Parameters.AddWithValue("@formatIdentifier", NendoFormat.Identifier);
            command.Parameters.AddWithValue("@formatVersion", NendoFormat.CurrentVersion);
            command.Parameters.AddWithValue("@minimumHostVersion", NendoFormat.MinimumHostVersion);
            command.Parameters.AddWithValue("@applicationId", applicationId);
            command.Parameters.AddWithValue("@instanceId", instanceId);
            command.Parameters.AddWithValue("@createdAt", FormatTimestamp(now));
            command.Parameters.AddWithValue("@modifiedAt", FormatTimestamp(now));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        const string genesisSql = """
            INSERT INTO __nendo_revision (
                revision_id, created_at, origin, description, lane,
                definition_revision_before, definition_revision_after,
                data_revision_before, data_revision_after, change_sequence,
                operation_digest, idempotency_scope, idempotency_key)
            VALUES (@revisionId, @createdAt, 'kernel', 'Genesis revision', 'Genesis',
                0, 0, 0, 0, 0, @operationDigest, NULL, NULL);
            """;
        await using (var command = Command(genesisSql, transaction))
        {
            command.Parameters.AddWithValue("@revisionId", $"revision-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("@createdAt", FormatTimestamp(now));
            command.Parameters.AddWithValue("@operationDigest", NendoCanonical.DigestOperations([]));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        transaction.Commit();
    }

    private async Task ValidateAsync(CancellationToken cancellationToken)
    {
        var applicationId = Convert.ToInt64(
            await ScalarAsync("PRAGMA application_id;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        var userVersion = Convert.ToInt64(
            await ScalarAsync("PRAGMA user_version;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        var quickCheck = Convert.ToString(
            await ScalarAsync("PRAGMA quick_check;", null, cancellationToken),
            CultureInfo.InvariantCulture);
        if (applicationId != NendoFormat.SqliteApplicationId ||
            userVersion != NendoFormat.CurrentVersion ||
            !string.Equals(quickCheck, "ok", StringComparison.OrdinalIgnoreCase))
        {
            throw new NendoValidationException(
                "The SQLite application marker, format version or integrity check is invalid.");
        }

        var manifest = await ReadManifestAsync(null, cancellationToken);
        if (!string.Equals(manifest.FormatIdentifier, NendoFormat.Identifier, StringComparison.Ordinal) ||
            manifest.FormatVersion != NendoFormat.CurrentVersion ||
            !Version.TryParse(manifest.MinimumHostVersion, out var minimumHost) ||
            !Version.TryParse(NendoFormat.CurrentHostVersion, out var currentHost) ||
            minimumHost > currentHost ||
            string.IsNullOrWhiteSpace(manifest.ApplicationId) ||
            string.IsNullOrWhiteSpace(manifest.InstanceId) ||
            manifest.DefinitionRevision < 0 ||
            manifest.DataRevision < 0 ||
            manifest.ChangeSequence < 0)
        {
            throw new NendoValidationException("The protected Nendo manifest is invalid or unsupported.");
        }

        const string countersSql = """
            SELECT COUNT(*), MAX(change_sequence),
                   MAX(definition_revision_after), MAX(data_revision_after)
            FROM __nendo_revision;
            """;
        await using var command = Command(countersSql, null);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken) ||
            reader.GetInt64(0) < 1 ||
            reader.GetInt64(1) != manifest.ChangeSequence ||
            reader.GetInt64(2) != manifest.DefinitionRevision ||
            reader.GetInt64(3) != manifest.DataRevision)
        {
            throw new NendoValidationException("The protected revision counters do not match the manifest.");
        }
    }

    private async Task<NendoApplyResult?> TryResolveReplayAsync(
        NendoMutation mutation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT i.payload_digest, r.revision_id, r.operation_digest,
                   r.definition_revision_after, r.data_revision_after, r.change_sequence
            FROM __nendo_idempotency i
            JOIN __nendo_revision r ON r.revision_id = i.revision_id
            WHERE i.idempotency_scope = @scope AND i.idempotency_key = @key;
            """;
        NendoApplyResult replay;
        await using (var command = Command(sql, transaction))
        {
            command.Parameters.AddWithValue("@scope", mutation.IdempotencyScope);
            command.Parameters.AddWithValue("@key", mutation.IdempotencyKey);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            if (!string.Equals(reader.GetString(0), mutation.PayloadDigest, StringComparison.Ordinal))
            {
                throw new NendoIdempotencyConflictException(
                    "The idempotency key was already used with a different mutation payload.");
            }

            replay = new NendoApplyResult(
                reader.GetString(1),
                reader.GetString(2),
                reader.GetInt64(3),
                reader.GetInt64(4),
                reader.GetInt64(5),
                true);
        }
        // The original write said what its actions changed; the replay of it says the
        // same, so a lost response costs a retry and not a read of every record.
        return replay with { GeneratedChanges = await ReadGeneratedChangesAsync(replay.RevisionId, transaction, cancellationToken) };
    }

    private async Task AppendRevisionAsync(
        NendoMutation mutation,
        IReadOnlyList<OperationEvidence> evidence,
        NendoManifestSnapshot before,
        string revisionId,
        DateTimeOffset now,
        long definitionAfter,
        long dataAfter,
        long sequenceAfter,
        string? proposalId,
        string? proposalDigest,
        string? compensationOfRevisionId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string revisionSql = """
            INSERT INTO __nendo_revision (
                revision_id, created_at, origin, description, lane,
                definition_revision_before, definition_revision_after,
                data_revision_before, data_revision_after, change_sequence,
                operation_digest, idempotency_scope, idempotency_key,
                proposal_id, proposal_digest, compensation_of_revision_id)
            VALUES (@revisionId, @createdAt, @origin, @description, @lane,
                @definitionBefore, @definitionAfter,
                @dataBefore, @dataAfter, @sequenceAfter,
                @operationDigest, @scope, @key,
                @proposalId, @proposalDigest, @compensationOfRevisionId);
            """;
        await using (var command = Command(revisionSql, transaction))
        {
            command.Parameters.AddWithValue("@revisionId", revisionId);
            command.Parameters.AddWithValue("@createdAt", FormatTimestamp(now));
            command.Parameters.AddWithValue("@origin", mutation.Origin);
            command.Parameters.AddWithValue("@description", mutation.Description);
            command.Parameters.AddWithValue("@lane", mutation.Operations[0].Lane.ToString());
            command.Parameters.AddWithValue("@definitionBefore", before.DefinitionRevision);
            command.Parameters.AddWithValue("@definitionAfter", definitionAfter);
            command.Parameters.AddWithValue("@dataBefore", before.DataRevision);
            command.Parameters.AddWithValue("@dataAfter", dataAfter);
            command.Parameters.AddWithValue("@sequenceAfter", sequenceAfter);
            // The digest of what this revision actually did, generated writes included.
            // Persisting the request's own digest instead would make a replay report a
            // different digest than the commit it is replaying.
            command.Parameters.AddWithValue("@operationDigest",
                NendoCanonical.DigestOperations(evidence.Select(item => item.Operation).ToArray()));
            command.Parameters.AddWithValue("@scope", mutation.IdempotencyScope);
            command.Parameters.AddWithValue("@key", mutation.IdempotencyKey);
            command.Parameters.AddWithValue("@proposalId", (object?)proposalId ?? DBNull.Value);
            command.Parameters.AddWithValue("@proposalDigest", (object?)proposalDigest ?? DBNull.Value);
            command.Parameters.AddWithValue("@compensationOfRevisionId", (object?)compensationOfRevisionId ?? DBNull.Value);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        const string operationSql = """
            INSERT INTO __nendo_operation (
                revision_id, ordinal, operation_id, operation_type,
                canonical_json, reversibility, inverse_evidence_json)
            VALUES (@revisionId, @ordinal, @operationId, @operationType,
                @canonicalJson, @reversibility, @evidenceJson);
            """;
        for (var index = 0; index < evidence.Count; index++)
        {
            var item = evidence[index];
            await using var command = Command(operationSql, transaction);
            command.Parameters.AddWithValue("@revisionId", revisionId);
            command.Parameters.AddWithValue("@ordinal", index);
            command.Parameters.AddWithValue("@operationId", item.Operation.OperationId);
            command.Parameters.AddWithValue("@operationType", item.Operation.OperationType);
            command.Parameters.AddWithValue("@canonicalJson", item.Operation.CanonicalJson());
            command.Parameters.AddWithValue("@reversibility", item.Operation.Reversibility.ToString());
            command.Parameters.AddWithValue("@evidenceJson", item.EvidenceJson);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        const string idempotencySql = """
            INSERT INTO __nendo_idempotency (
                idempotency_scope, idempotency_key, payload_digest, revision_id)
            VALUES (@scope, @key, @payloadDigest, @revisionId);
            """;
        await using (var command = Command(idempotencySql, transaction))
        {
            command.Parameters.AddWithValue("@scope", mutation.IdempotencyScope);
            command.Parameters.AddWithValue("@key", mutation.IdempotencyKey);
            command.Parameters.AddWithValue("@payloadDigest", mutation.PayloadDigest);
            command.Parameters.AddWithValue("@revisionId", revisionId);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    private async Task UpdateManifestAsync(
        DateTimeOffset now,
        long definitionAfter,
        long dataAfter,
        long sequenceAfter,
        string minimumHostVersion,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE __nendo_manifest
            SET modified_at = @modifiedAt,
                minimum_host_version = @minimumHostVersion,
                definition_revision = @definitionRevision,
                data_revision = @dataRevision,
                change_sequence = @changeSequence
            WHERE singleton_id = 1;
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@modifiedAt", FormatTimestamp(now));
        command.Parameters.AddWithValue("@minimumHostVersion", minimumHostVersion);
        command.Parameters.AddWithValue("@definitionRevision", definitionAfter);
        command.Parameters.AddWithValue("@dataRevision", dataAfter);
        command.Parameters.AddWithValue("@changeSequence", sequenceAfter);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task ExpandLegacyP1SchemaAsync(
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (!await ColumnExistsAsync("__nendo_field", "presentation", transaction, cancellationToken))
        {
            await NonQueryAsync(
                "ALTER TABLE __nendo_field ADD COLUMN presentation TEXT NULL;",
                transaction,
                cancellationToken);
        }
        if (!await ColumnExistsAsync("__nendo_field", "options_json", transaction, cancellationToken))
        {
            await NonQueryAsync(
                "ALTER TABLE __nendo_field ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]';",
                transaction,
                cancellationToken);
        }
        if (!await ColumnExistsAsync("__nendo_revision", "proposal_id", transaction, cancellationToken))
        {
            await NonQueryAsync(
                "ALTER TABLE __nendo_revision ADD COLUMN proposal_id TEXT NULL;",
                transaction,
                cancellationToken);
        }
        if (!await ColumnExistsAsync("__nendo_revision", "proposal_digest", transaction, cancellationToken))
        {
            await NonQueryAsync(
                "ALTER TABLE __nendo_revision ADD COLUMN proposal_digest TEXT NULL;",
                transaction,
                cancellationToken);
        }
        if (!await ColumnExistsAsync("__nendo_revision", "compensation_of_revision_id", transaction, cancellationToken))
        {
            await NonQueryAsync(
                "ALTER TABLE __nendo_revision ADD COLUMN compensation_of_revision_id TEXT NULL;",
                transaction,
                cancellationToken);
        }

        const string schema = """
            CREATE TABLE IF NOT EXISTS __nendo_ui_node (
                node_id TEXT NOT NULL PRIMARY KEY,
                surface_id TEXT NOT NULL,
                parent_node_id TEXT NULL,
                kind TEXT NOT NULL,
                position INTEGER NOT NULL CHECK (position >= 0),
                FOREIGN KEY (parent_node_id) REFERENCES __nendo_ui_node(node_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS __nendo_ui_node_surface
            ON __nendo_ui_node(surface_id, parent_node_id, position, node_id);

            CREATE TABLE IF NOT EXISTS __nendo_ui_property (
                node_id TEXT NOT NULL,
                property_name TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY (node_id, property_name),
                FOREIGN KEY (node_id) REFERENCES __nendo_ui_node(node_id) ON DELETE CASCADE
            );
            """;
        await NonQueryAsync(schema, transaction, cancellationToken);
    }

    private async Task<bool> ColumnExistsAsync(
        string tableName,
        string columnName,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        await using var command = Command($"PRAGMA table_info({Quote(tableName)});", transaction);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    private async Task<bool> TableExistsAsync(
        string tableName,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        await using var command = Command(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = @name);",
            transaction);
        command.Parameters.AddWithValue("@name", tableName);
        return Convert.ToInt64(
            await command.ExecuteScalarAsync(cancellationToken),
            CultureInfo.InvariantCulture) == 1;
    }

    private SqliteCommand Command(string sql, SqliteTransaction? transaction)
    {
        var command = _connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        command.CommandTimeout = BusyTimeoutMilliseconds / 1_000;
        return command;
    }

    private async Task<object?> ScalarAsync(
        string sql,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        await using var command = Command(sql, transaction);
        return await command.ExecuteScalarAsync(cancellationToken);
    }

    private async Task NonQueryAsync(
        string sql,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        await using var command = Command(sql, transaction);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static string FormatTimestamp(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ParseTimestamp(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);

    private static string Evidence(object value) => JsonSerializer.Serialize(value);
}
