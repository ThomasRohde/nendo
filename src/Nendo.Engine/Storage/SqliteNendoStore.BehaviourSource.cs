using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private NendoExpressionAdapter? _behaviourAdapter;
    private bool? _behaviourTablePresent;

    /// <summary>
    /// Whether this file holds any behaviour at all, remembered per open store.
    /// <para>
    /// This is asked on every record read and every write, and for the overwhelming
    /// majority of files the answer is no and never changes. Only
    /// <see cref="EnsureBehaviourLayoutAsync"/> can make it yes, and it says so, so
    /// the question costs one query per file rather than one per read.
    /// </para>
    /// <para>
    /// The answer is only true once the mutation that created the table commits.
    /// <see cref="ForgetBehaviourTableCache"/> puts it back to unknown on a rollback,
    /// because the table goes with the transaction and the flag does not: a file whose
    /// first behaviour install was refused was left claiming a table it no longer had,
    /// and every later read of the open file threw a raw SQLite error (F-070).
    /// </para>
    /// </summary>
    private async ValueTask<bool> HasBehaviourAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (_behaviourTablePresent is { } known) return known;
        var present = await TableExistsAsync("__nendo_behaviour", transaction, cancellationToken);
        _behaviourTablePresent = present;
        return present;
    }

    /// <summary>
    /// Forgets whether this file has a behaviour table, so the next question asks the
    /// file rather than the last answer. Called when a mutation does not commit: DDL
    /// rolls back with everything else, and a remembered "yes" would outlive the table
    /// it described.
    /// </summary>
    private void ForgetBehaviourTableCache() => _behaviourTablePresent = null;
    private CompiledBehaviour? _compiledBehaviour;
    private long _compiledAtDefinitionRevision = -1;
    private NendoBehaviourLimits _behaviourLimits = NendoBehaviourLimits.Default;

    /// <summary>
    /// The ceilings this file's calculations run under. Host-owned: it is set by the
    /// host that opened the file, never read from the file, so no stored definition can
    /// buy itself more room. Tests lower it to exercise exact boundaries; nothing
    /// raises it above what the host chose.
    /// </summary>
    internal NendoBehaviourLimits BehaviourLimits
    {
        get => _behaviourLimits;
        set
        {
            _behaviourLimits = (value ?? throw new ArgumentNullException(nameof(value))).Validate();
            // A different policy is a different validation, so nothing compiled under
            // the old one may be reused.
            _compiledBehaviour = null;
            _compiledAtDefinitionRevision = -1;
        }
    }

    /// <summary>
    /// Created the first time a file actually holds behaviour.
    /// <para>
    /// Constructing it touches the expression library, so a file with no calculations
    /// must not construct one: opening an ordinary file would otherwise need an
    /// assembly it never uses, and a host that loads the Engine assembly by hand
    /// would fail to open any file at all.
    /// </para>
    /// </summary>
    private NendoExpressionAdapter BehaviourAdapter => _behaviourAdapter ??= new NendoExpressionAdapter();

    /// <summary>
    /// The compiled behaviour for the file's current definition revision.
    /// <para>
    /// Compiled once per definition revision, not per read: validating every formula
    /// on every keystroke would be wasteful, while recompiling only when the
    /// definitions actually change keeps the compiled set and the stored definitions
    /// from ever disagreeing. A definition change bumps the revision, so this is
    /// invalidated by the same counter that records the change.
    /// </para>
    /// </summary>
    private async Task<CompiledBehaviour> GetCompiledBehaviourAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return CompiledBehaviour.Empty;
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        if (_compiledBehaviour is not null && _compiledAtDefinitionRevision == manifest.DefinitionRevision)
            return _compiledBehaviour;
        var definitions = await ReadBehaviourDefinitionsAsync(transaction, cancellationToken);
        var compiled = CompiledBehaviour.Compile(
            definitions, BehaviourAdapter, new BehaviourBudget(_behaviourLimits, cancellationToken));
        _compiledBehaviour = compiled;
        _compiledAtDefinitionRevision = manifest.DefinitionRevision;
        return compiled;
    }

    /// <summary>
    /// Attaches each record's calculated fields.
    /// <para>
    /// Every record gets its own budget. Reading a list is a series of independent
    /// evaluations, not one long one, so a file with many records is not refused
    /// because of its size — while any single record's calculations stay bounded.
    /// A save is the opposite case and shares one budget across the whole chain.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyList<NendoRecordSnapshot>> WithCalculationsAsync(
        IReadOnlyList<NendoRecordSnapshot> records,
        IReadOnlyList<EntityMapping> entities,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        // Deliberately the only thing this method does before handing off. Naming an
        // expression type here would make the runtime resolve the evaluator whenever
        // any file's records are read, so a file that holds no calculations would
        // need an assembly it never uses — and a host that loads the Engine by hand
        // would fail to open ordinary files.
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return records;
        return await EvaluateCalculationsAsync(records, entities, transaction, cancellationToken);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private async Task<IReadOnlyList<NendoRecordSnapshot>> EvaluateCalculationsAsync(
        IReadOnlyList<NendoRecordSnapshot> records,
        IReadOnlyList<EntityMapping> entities,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        CompiledBehaviour behaviour;
        try
        {
            behaviour = await GetCompiledBehaviourAsync(transaction, cancellationToken);
        }
        catch (Exception exception) when (exception is NendoException or System.Text.Json.JsonException)
        {
            // The definitions are damaged or come from a contract this host does not
            // implement. Inspection reports that and blocks editing; a read still hands
            // back the owner's stored data rather than failing outright, because the
            // data is not what is wrong with the file.
            return records;
        }
        if (behaviour.CalculationsByEntity.Count == 0) return records;
        var service = new NendoCalculationService(BehaviourAdapter);
        var source = new BehaviourRecordSource(this, transaction, entities);
        var results = new List<NendoRecordSnapshot>(records.Count);
        foreach (var record in records)
        {
            if (!behaviour.CalculationsByEntity.ContainsKey(record.EntityId))
            {
                results.Add(record);
                continue;
            }
            results.Add(record with
            {
                Calculations = await service.EvaluateRecordAsync(
                    behaviour, record.EntityId, record.RecordId, source,
                    new BehaviourBudget(_behaviourLimits, cancellationToken), cancellationToken),
            });
        }
        return results;
    }

    /// <summary>
    /// Reads the values a binding names, out of one SQLite transaction.
    /// <para>
    /// It is constructed around a transaction rather than around the store so the same
    /// resolver serves an ordinary bounded read and a save in progress: during a save
    /// it sees the staged rows, which is the only state a trigger condition may
    /// legitimately be judged against. Nothing above storage learns a table or column
    /// name; a binding arrives in stable semantic IDs and leaves as a typed value.
    /// </para>
    /// </summary>
    private sealed class BehaviourRecordSource(
        SqliteNendoStore store,
        SqliteTransaction? transaction,
        IReadOnlyList<EntityMapping> mappings,
        Action<RecordKey, long>? observe = null) : IBehaviourRecordSource
    {
        public async Task<BehaviourValue> ResolveAsync(
            NendoBehaviourBinding binding,
            string recordId,
            BehaviourBudget budget,
            CancellationToken cancellationToken)
        {
            budget.SpendWork();
            switch (binding.Kind)
            {
                case NendoBindingKind.SameRecordField:
                    return await ReadFieldAsync(binding.EntityId, recordId, binding.FieldId!, binding, budget, cancellationToken);

                case NendoBindingKind.ReferenceTraversal:
                {
                    var target = await ReadReferenceAsync(binding.EntityId, recordId, binding.ReferenceFieldId!, budget, cancellationToken);
                    // An unset relationship is an empty value, not a zero and not a
                    // failure: there is genuinely nothing at the other end to read.
                    return target is null
                        ? BehaviourValue.Empty(binding.ResultType)
                        : await ReadFieldAsync(binding.RelatedEntityId!, target, binding.FieldId!, binding, budget, cancellationToken);
                }

                case NendoBindingKind.RelatedAggregate:
                    return await AggregateAsync(binding, recordId, budget, cancellationToken);

                default:
                    throw new NendoValidationException("The binding kind is not supported by this contract.");
            }
        }

        private async Task<BehaviourValue> ReadFieldAsync(
            string entityId,
            string recordId,
            string fieldId,
            NendoBehaviourBinding binding,
            BehaviourBudget budget,
            CancellationToken cancellationToken)
        {
            var (entity, field) = Locate(entityId, fieldId);
            budget.SpendScan();
            await using var command = store.Command(
                $"SELECT {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;",
                transaction);
            command.Parameters.AddWithValue("@recordId", recordId);
            await using var rows = await command.ExecuteReaderAsync(cancellationToken);
            if (!await rows.ReadAsync(cancellationToken))
                throw new NendoCalculationException(NendoCalculationCodes.RelatedUnavailable,
                    "A record this calculation reads is no longer there.");
            return rows.IsDBNull(0)
                ? BehaviourValue.Empty(binding.ResultType)
                : Convert(rows.GetValue(0), field.StorageKind, binding.ResultType, budget);
        }

        private async Task<string?> ReadReferenceAsync(
            string entityId,
            string recordId,
            string referenceFieldId,
            BehaviourBudget budget,
            CancellationToken cancellationToken)
        {
            var (entity, field) = Locate(entityId, referenceFieldId);
            budget.SpendScan();
            await using var command = store.Command(
                $"SELECT {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;",
                transaction);
            command.Parameters.AddWithValue("@recordId", recordId);
            await using var rows = await command.ExecuteReaderAsync(cancellationToken);
            if (!await rows.ReadAsync(cancellationToken))
                throw new NendoCalculationException(NendoCalculationCodes.RelatedUnavailable,
                    "A record this calculation reads is no longer there.");
            return rows.IsDBNull(0) ? null : rows.GetString(0);
        }

        /// <summary>
        /// Counts or totals the records pointing at this one.
        /// <para>
        /// The query carries a LIMIT one past the remaining allowance and every row read
        /// is charged, including rows that turn out not to contribute. Reading is the
        /// cost, not answering. If the extra row comes back the collection was larger
        /// than the ceiling, and the result is an error — a partial total returned as a
        /// complete one is the failure this guards against.
        /// </para>
        /// </summary>
        private async Task<BehaviourValue> AggregateAsync(
            NendoBehaviourBinding binding,
            string recordId,
            BehaviourBudget budget,
            CancellationToken cancellationToken)
        {
            var (related, pointer) = Locate(binding.RelatedEntityId!, binding.RelatedReferenceFieldId!);
            var valueFieldId = binding.PredicateFieldId ?? binding.ValueFieldId;
            var member = valueFieldId is null ? null : Locate(binding.RelatedEntityId!, valueFieldId).Field;

            var allowance = budget.RemainingScanAllowance;
            if (allowance <= 0)
                throw new NendoCalculationException(NendoCalculationCodes.LimitReached,
                    "This calculation reached the related record limit for a single save.");
            var selection = member is null ? "1" : Quote(member.PhysicalColumnName);
            // The row's identity and version come back with its value. A record that was
            // only counted still decided what an action wrote, so a reviewed plan is
            // only valid while that record still says what it said.
            await using var command = store.Command(
                $"SELECT {selection}, {Quote("__nendo_record_id")}, {Quote("__nendo_record_version")} " +
                $"FROM {Quote(related.PhysicalTableName)} WHERE {Quote(pointer.PhysicalColumnName)} = @recordId LIMIT @limit;",
                transaction);
            command.Parameters.AddWithValue("@recordId", recordId);
            command.Parameters.AddWithValue("@limit", (long)allowance + 1);

            var count = 0L;
            var integerTotal = 0L;
            var decimalTotal = 0m;
            var rowsRead = 0;
            await using (var rows = await command.ExecuteReaderAsync(cancellationToken))
            {
                while (await rows.ReadAsync(cancellationToken))
                {
                    rowsRead++;
                    if (rowsRead > allowance)
                    {
                        throw new NendoCalculationException(NendoCalculationCodes.LimitReached,
                            $"More than {budget.Limits.RelatedRows} related records contribute to this calculation, so no total is shown rather than an incomplete one.");
                    }
                    budget.SpendScan();
                    observe?.Invoke(new RecordKey(binding.RelatedEntityId!, rows.GetString(1)), rows.GetInt64(2));
                    switch (binding.Aggregate)
                    {
                        case NendoAggregateFunction.Count:
                            count++;
                            break;
                        case NendoAggregateFunction.FilteredCount:
                        {
                            if (rows.IsDBNull(0))
                                throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                                    "A related record has no value for the field this calculation tests, so it cannot be counted or skipped.");
                            if (Convert(rows.GetValue(0), member!.StorageKind, NendoBehaviourScalar.Boolean, budget).AsBoolean()) count++;
                            break;
                        }
                        case NendoAggregateFunction.Sum:
                        {
                            if (rows.IsDBNull(0))
                                throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                                    "A related record has no value for the field this calculation totals, so it cannot be added or skipped.");
                            var value = Convert(rows.GetValue(0), member!.StorageKind, binding.ResultType, budget);
                            try
                            {
                                if (binding.ResultType == NendoBehaviourScalar.Integer)
                                    integerTotal = checked(integerTotal + value.AsInteger());
                                else decimalTotal += value.AsDecimal();
                            }
                            catch (OverflowException)
                            {
                                throw new NendoCalculationException(NendoCalculationCodes.Overflow,
                                    "The total of these related records is outside the range this calculation can hold.");
                            }
                            break;
                        }
                        default:
                            throw new NendoValidationException("The aggregate is not supported by this contract.");
                    }
                }
            }

            // An empty collection totals zero. It is a real answer, not a missing one.
            return binding.Aggregate switch
            {
                NendoAggregateFunction.Count or NendoAggregateFunction.FilteredCount => BehaviourValue.Integer(count),
                NendoAggregateFunction.Sum when binding.ResultType == NendoBehaviourScalar.Integer =>
                    BehaviourValue.Integer(integerTotal),
                _ => BehaviourValue.Decimal(decimalTotal),
            };
        }

        private (EntityMapping Entity, FieldMapping Field) Locate(string entityId, string fieldId)
        {
            var entity = mappings.SingleOrDefault(candidate => string.Equals(candidate.EntityId, entityId, StringComparison.Ordinal))
                ?? throw new NendoCalculationException(NendoCalculationCodes.RelatedUnavailable,
                    "A record type this calculation reads is no longer there.");
            var field = entity.Fields.SingleOrDefault(candidate => string.Equals(candidate.FieldId, fieldId, StringComparison.Ordinal))
                ?? throw new NendoCalculationException(NendoCalculationCodes.RelatedUnavailable,
                    "A field this calculation reads is no longer there.");
            return (entity, field);
        }

        /// <summary>
        /// Turns a stored value into the scalar the binding declared. The declared type
        /// was checked against the schema at installation, so a mismatch here means the
        /// file changed underneath the definition — a refusal, never a coercion.
        /// </summary>
        private static BehaviourValue Convert(
            object stored,
            NendoStorageKind storageKind,
            NendoBehaviourScalar expected,
            BehaviourBudget budget)
        {
            var actual = BehaviourScalarOf(storageKind)
                ?? throw new NendoValidationException("A formula cannot read this kind of stored value.");
            var value = actual switch
            {
                NendoBehaviourScalar.Integer => BehaviourValue.Integer(System.Convert.ToInt64(stored, CultureInfo.InvariantCulture)),
                NendoBehaviourScalar.Decimal => BehaviourValue.Decimal(ReadDecimal(stored)),
                NendoBehaviourScalar.Boolean => BehaviourValue.Boolean(System.Convert.ToInt64(stored, CultureInfo.InvariantCulture) != 0),
                NendoBehaviourScalar.Text => BehaviourValue.Text((string)stored, budget.Limits),
                _ => BehaviourValue.Date(DateOnly.ParseExact((string)stored, "yyyy-MM-dd", CultureInfo.InvariantCulture)),
            };
            if (value.Type == expected) return value;
            if (expected == NendoBehaviourScalar.Decimal && value.Type == NendoBehaviourScalar.Integer)
                return BehaviourValue.Decimal(value.AsDecimal());
            throw new NendoValidationException(
                $"A formula expects {expected.ToString().ToLowerInvariant()} where the file now stores {value.Type.ToString().ToLowerInvariant()}.");
        }

        /// <summary>
        /// Decimals are stored behind a textual prefix precisely so SQLite's numeric
        /// affinity cannot round the coefficient into binary floating point. Reading one
        /// back through a double would undo that.
        /// </summary>
        private static decimal ReadDecimal(object stored) => stored switch
        {
            string text when text.StartsWith("nendo.decimal:", StringComparison.Ordinal) =>
                decimal.Parse(text[14..], CultureInfo.InvariantCulture),
            string text => decimal.Parse(text, CultureInfo.InvariantCulture),
            long number => number,
            _ => System.Convert.ToDecimal(stored, CultureInfo.InvariantCulture),
        };
    }
}
