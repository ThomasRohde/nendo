using System.Globalization;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoResourceProjection(
    NendoApplicationService application,
    NendoCursorCodec cursors)
{
    private int _definitionReads;

    /// <summary>How many definition snapshots this projection has asked the Engine for; the read-cost tests count it.</summary>
    internal int DefinitionReads => Volatile.Read(ref _definitionReads);

    /// <summary>
    /// Called after each Engine read this projection makes, with the read's name. The tests
    /// commit a change here to put it between two reads of one request; null otherwise.
    /// </summary>
    internal Func<string, Task>? AfterRead { get; set; }

    private async Task<NendoSessionSnapshot> ReadDefinitionAsync(CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _definitionReads);
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        await Settled("definition");
        return snapshot;
    }

    private Task Settled(string read) => AfterRead?.Invoke(read) ?? Task.CompletedTask;

    /// <summary>How many times a bundled read starts again when the file moves under it, before it refuses.</summary>
    internal const int CoherentReadAttempts = 3;

    /// <summary>
    /// A read that puts the definition snapshot beside reads the snapshot does not carry --
    /// record counts, compiled screens, the new-file preview -- from one moment of the file.
    /// Each of those reads reports the change sequence it saw. Every commit advances the
    /// sequence and the Engine serializes reads, so a last sequence equal to the snapshot's
    /// proves nothing was committed in between. A mismatch starts again from a new snapshot,
    /// a bounded number of times, and then refuses by name rather than stitching two moments
    /// of the file into one answer.
    /// </summary>
    private async Task<T> CoherentAsync<T>(
        Func<NendoSessionSnapshot, List<long>, Task<T>> read, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            var snapshot = await ReadDefinitionAsync(cancellationToken);
            var seen = new List<long>();
            var value = await read(snapshot, seen);
            if (seen.TrueForAll(sequence => sequence == snapshot.Manifest.ChangeSequence)) return value;
            if (attempt == CoherentReadAttempts) throw NendoMcpErrors.ReadInterrupted(CoherentReadAttempts);
        }
    }

    /// <summary>The Engine's own preview of a proposal, whoever prepared it (W-148): the person already sees all of it in Pending changes.</summary>
    internal async Task<NendoAgentProposalPreview> GetProposalAsync(string proposalId, CancellationToken cancellationToken)
    {
        NendoText.RequireText(proposalId, "proposal ID", 200);
        return NendoAgentProposalStore.ProjectPreview(await application.GetProposalAsync(proposalId, cancellationToken));
    }

    /// <summary>The revisions an acceptance of this proposal committed, or null when none is recorded (F-261).</summary>
    internal Task<NendoChangeSetApplyResult?> GetProposalReceiptAsync(string proposalId, CancellationToken cancellationToken)
    {
        NendoText.RequireText(proposalId, "proposal ID", 200);
        return application.GetProposalReceiptAsync(proposalId, cancellationToken);
    }

    /// <summary>The definition revision the file is at now, without a record or history read.</summary>
    internal async Task<long> GetDefinitionRevisionAsync(CancellationToken cancellationToken) =>
        (await ReadDefinitionAsync(cancellationToken)).Manifest.DefinitionRevision;

    internal async Task<NendoMcpManifest> GetManifestAsync(CancellationToken cancellationToken) =>
        ProjectManifest(await ReadDefinitionAsync(cancellationToken));

    private static NendoMcpManifest ProjectManifest(NendoSessionSnapshot snapshot)
    {
        var value = snapshot.Manifest;
        var look = NendoLook.Resolve(value.ApplicationId, snapshot.FileName, value.Look);
        return new NendoMcpManifest(
            "nendo.application",
            value.FormatVersion,
            value.MinimumHostVersion,
            value.ApplicationId,
            value.InstanceId,
            value.CreatedAt,
            value.ModifiedAt,
            value.DefinitionRevision,
            value.DataRevision,
            value.ChangeSequence)
        {
            Purpose = value.Purpose,
            Look = new NendoMcpLook(look.Tone, look.Letter, look.ToneChosen, look.LetterChosen),
            NewFileLabel = value.NewFileLabel,
        };
    }

    internal async Task<IReadOnlyList<NendoMcpEntity>> GetEntitiesAsync(
        CancellationToken cancellationToken) =>
        (await ReadDefinitionAsync(cancellationToken)).Entities
            .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
            .Select(entity => new NendoMcpEntity(entity.EntityId, entity.DisplayName) { Retired = entity.Retired })
            .ToArray();

    internal Task<NendoMcpEntitySchema> GetSchemaAsync(
        string entityId,
        CancellationToken cancellationToken) =>
        CoherentAsync((snapshot, seen) => SchemaAsync(snapshot, entityId, seen, cancellationToken), cancellationToken);

    private async Task<NendoMcpEntitySchema> SchemaAsync(
        NendoSessionSnapshot snapshot, string entityId, List<long> seen, CancellationToken cancellationToken)
    {
        var entity = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw NendoMcpErrors.EntityNotFound();
        var counts = await CountRecordsAsync([entity], seen, cancellationToken);
        return ProjectSchema(entity) with { RecordCount = counts[entity.EntityId] };
    }

    private static NendoMcpEntitySchema ProjectSchema(NendoEntitySnapshot entity)
    {
        return new NendoMcpEntitySchema(
            entity.EntityId,
            entity.DisplayName,
            entity.Fields
                .OrderBy(field => field.FieldId, StringComparer.Ordinal)
                .Select(field => new NendoMcpField(
                    field.FieldId,
                    field.DisplayName,
                    field.StorageKind,
                    field.Required,
                    field.Presentation,
                    field.Options) { Reference = field.Reference, Choices = field.Choices, Scale = field.Scale, Retired = field.Retired, Unique = field.Unique, Sequence = field.Sequence })
                .ToArray())
        {
            Retired = entity.Retired,
            Hierarchy = entity.Hierarchy,
            LinkRule = entity.LinkRule,
            KeptInNewFiles = entity.KeptInNewFiles,
            DerivedFields = entity.DerivedFields
                .OrderBy(field => field.FieldId, StringComparer.Ordinal)
                .Select(field => new NendoMcpDerivedField(
                    field.FieldId, field.DisplayName, field.CalculationId,
                    field.ResultType, field.ResultNullable, field.Expression))
                .ToArray(),
        };
    }

    internal async Task<NendoMcpPage<NendoMcpTreeNode>> GetTreeAsync(
        string entityId,
        string? root,
        int depth,
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"tree:{entityId}:{root}:{depth}";
        var page = await application.TreeRecordsAsync(new(entityId, root, depth, limit, cursors.Decode(cursor, scope)), cancellationToken);
        await Settled("tree");
        return new NendoMcpPage<NendoMcpTreeNode>(
            page.Items.Select(node => new NendoMcpTreeNode(Project(node.Record), node.ParentRecordId, node.Depth, node.ChildCount)).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor)) { ChangeSequence = page.ChangeSequence };
    }

    /// <summary>A full-text search over the file's text fields (ADR-0028).</summary>
    internal async Task<NendoMcpPage<NendoSearchHit>> SearchAsync(
        string? q,
        string? entity,
        string? field,
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        if (string.IsNullOrWhiteSpace(q))
            throw new NendoValidationException("q is what to search for: words, \"a phrase\" in double quotes, or -word to leave records out.");
        static string[] Ids(string? list) => string.IsNullOrWhiteSpace(list)
            ? []
            : [.. list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.Ordinal)];
        var entityIds = Ids(entity);
        var fieldIds = Ids(field);
        var scope = $"search:{q}:{string.Join(',', entityIds)}:{string.Join(',', fieldIds)}";
        var page = await application.SearchRecordsAsync(
            new(q, limit, cursors.Decode(cursor, scope)) { EntityIds = entityIds, FieldIds = fieldIds }, cancellationToken);
        await Settled("search");
        return new NendoMcpPage<NendoSearchHit>(page.Items, page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor))
        { ChangeSequence = page.ChangeSequence };
    }

    private static NendoMcpRecord Project(NendoRecordSnapshot record) => new(record.EntityId, record.RecordId, record.RecordVersion, record.Values)
    {
        ReferenceLabels = record.ReferenceLabels,
        Calculations = record.Calculations
            .Select(result => new NendoMcpCalculation(
                result.CalculationId, result.FieldId, result.State, result.ResultType,
                result.Value, result.ErrorCode, result.ErrorMessage))
            .ToArray(),
        KeptInNewFiles = record.KeptInNewFiles,
    };

    internal Task<NendoMcpPage<NendoMcpRecord>> GetRecordsAsync(
        string entityId,
        string? cursor,
        int limit,
        CancellationToken cancellationToken) =>
        GetRecordsAsync(entityId, cursor, limit, null, null, null, null, null, cancellationToken);

    /// <summary>
    /// A page of one record type, or one record by ID, filtered and sorted through the same
    /// typed query the screens use (W-145). Before, the adapter passed only the entity, the
    /// limit and the cursor, so an agent paged a whole type to find one record or one value.
    /// </summary>
    internal async Task<NendoMcpPage<NendoMcpRecord>> GetRecordsAsync(
        string entityId,
        string? cursor,
        int limit,
        string? recordId,
        string? sort,
        string? desc,
        string? filter,
        string? fields,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"records:{entityId}";
        var entity = new RequestEntity(this, entityId, cancellationToken);
        var filters = await ParseFiltersAsync(entity, filter);
        if (sort is not null) await entity.RequireAsync(sort, "sort");
        var projected = await ParseProjectionAsync(entity, fields);
        var descending = desc switch
        {
            null or "" or "false" => false,
            "true" => true,
            _ => throw new NendoValidationException("desc is true or false."),
        };
        var page = await application.QueryRecordsAsync(new(entityId, limit, cursors.Decode(cursor, scope))
        {
            RecordId = string.IsNullOrWhiteSpace(recordId) ? null : recordId,
            SortFieldId = string.IsNullOrWhiteSpace(sort) ? null : sort,
            Descending = descending,
            Filters = filters,
        }, cancellationToken);
        await Settled("records");
        var records = page.Items.Select(record => Project(record, projected)).ToArray();
        return new NendoMcpPage<NendoMcpRecord>(
            records,
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor)) { ChangeSequence = page.ChangeSequence };
    }

    /// <summary>The most field IDs one records read may name in fields.</summary>
    internal const int MaximumProjectedFields = 64;

    private const int MaximumProjectionCharacters = 4 * 1024;

    /// <summary>
    /// The fields query parameter: comma-separated field IDs of the record type, stored or
    /// calculated, each refused by name when the type has no such field. Null, the whole
    /// record, when it is absent or empty. It chooses what each record carries and never
    /// which records match or their order, so it is not part of the cursor's scope.
    /// </summary>
    private static async Task<IReadOnlySet<string>?> ParseProjectionAsync(RequestEntity entity, string? fields)
    {
        if (string.IsNullOrWhiteSpace(fields)) return null;
        if (fields.Length > MaximumProjectionCharacters)
            throw new NendoValidationException($"fields is at most {MaximumProjectionCharacters} characters.");
        var ids = fields.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (ids.Length > MaximumProjectedFields)
            throw new NendoValidationException($"fields names at most {MaximumProjectedFields} field IDs, comma-separated.");
        foreach (var id in ids) await entity.RequireAsync(id, "projected");
        return ids.ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// A record with only the named fields' values, reference labels and calculations. Entity
    /// ID, record ID and version always come, so a projected read can still be written back.
    /// The Engine read the whole record; the projection saves bytes on the wire, not the read.
    /// </summary>
    private static NendoMcpRecord Project(NendoRecordSnapshot record, IReadOnlySet<string>? fields)
    {
        var whole = Project(record);
        if (fields is null) return whole;
        return whole with
        {
            Values = whole.Values.Where(pair => fields.Contains(pair.Key)).ToDictionary(StringComparer.Ordinal),
            ReferenceLabels = whole.ReferenceLabels.Where(pair => fields.Contains(pair.Key)).ToDictionary(StringComparer.Ordinal),
            Calculations = whole.Calculations.Where(calculation => fields.Contains(calculation.FieldId)).ToArray(),
        };
    }

    /// <summary>The operators the records and aggregate reads accept: the vocabulary's, plus the two the Engine's query takes beyond a screen.</summary>
    internal static IReadOnlyList<string> FilterOperators { get; } =
        ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull", "isNotNull", "descendantOf"];

    private const int MaximumFilterCharacters = 8 * 1024;

    /// <summary>
    /// The filter query parameter: a JSON array of {fieldId, op, value}. Refused by name
    /// before the Engine sees it, naming the operators accepted and, for an unknown field,
    /// the fields the record type has: the Engine's own refusals say only that the filter is
    /// invalid.
    /// </summary>
    private static async Task<IReadOnlyList<NendoRecordFilter>> ParseFiltersAsync(RequestEntity fields, string? filter)
    {
        if (string.IsNullOrWhiteSpace(filter)) return [];
        if (filter.Length > MaximumFilterCharacters)
            throw new NendoValidationException($"filter is at most {MaximumFilterCharacters} characters.");
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(filter, new JsonDocumentOptions { MaxDepth = 4 });
        }
        catch (JsonException exception)
        {
            throw new NendoValidationException($"filter is a JSON array of {{fieldId, op, value}}: {exception.Message}");
        }
        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Array)
                throw new NendoValidationException("filter is a JSON array of {fieldId, op, value}.");
            var filters = new List<NendoRecordFilter>();
            foreach (var clause in document.RootElement.EnumerateArray())
            {
                if (clause.ValueKind != JsonValueKind.Object ||
                    !clause.TryGetProperty("fieldId", out var fieldId) || fieldId.ValueKind != JsonValueKind.String ||
                    !clause.TryGetProperty("op", out var op) || op.ValueKind != JsonValueKind.String)
                    throw new NendoValidationException("Each filter clause is an object with fieldId, op and, unless op is isNull or isNotNull, value.");
                var contractOperator = op.GetString()!;
                if (!FilterOperators.Contains(contractOperator, StringComparer.Ordinal))
                    throw new NendoValidationException(
                        $"Filter operator '{contractOperator}' is not one of {string.Join(", ", FilterOperators)}.");
                await fields.RequireAsync(fieldId.GetString()!, "filter");
                var value = clause.TryGetProperty("value", out var given) ? given.Clone() : default;
                filters.Add(new NendoRecordFilter(fieldId.GetString()!, contractOperator switch
                {
                    "lte" => "le",
                    "gte" => "ge",
                    _ => contractOperator,
                }, value));
            }
            return filters;
        }
    }

    /// <summary>
    /// The record type one request names, read from a single definition snapshot the first time
    /// a field needs checking and reused for every other field the same request names. Each
    /// filter clause, the sort and each aggregate field read the whole definition again before.
    /// The Engine still validates the query itself against the file as it stands.
    /// </summary>
    private sealed class RequestEntity(NendoResourceProjection owner, string entityId, CancellationToken cancellationToken)
    {
        private Task<NendoEntitySnapshot>? _entity;

        internal Task<NendoEntitySnapshot> EntityAsync() => _entity ??= ReadAsync();

        /// <summary>A field the record type has, stored or calculated, named with the ones it has when it is not.</summary>
        internal async Task RequireAsync(string fieldId, string use)
        {
            var entity = await EntityAsync();
            if (entity.Fields.Any(field => field.FieldId == fieldId) || entity.DerivedFields.Any(field => field.FieldId == fieldId)) return;
            throw new NendoValidationException(
                $"The {use} field '{fieldId}' is not a field of {entityId}; its fields are {string.Join(", ", FieldIds(entity))}.");
        }

        private async Task<NendoEntitySnapshot> ReadAsync() =>
            (await owner.ReadDefinitionAsync(cancellationToken)).Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
    }

    private static string[] FieldIds(NendoEntitySnapshot entity) =>
        entity.Fields.Select(field => field.FieldId).Concat(entity.DerivedFields.Select(field => field.FieldId))
            .OrderBy(value => value, StringComparer.Ordinal).ToArray();

    /// <summary>
    /// One exact aggregate over a filtered record type, through the Engine's own folds
    /// (W-146): whole, grouped by a closed field, by two of them as a grid, or by civil-date
    /// bucket. Nothing is paged and every number is an invariant lexeme.
    /// </summary>
    internal async Task<NendoMcpAggregate> GetAggregateAsync(
        string entityId,
        string? aggregate,
        string? fieldId,
        string? groupBy,
        string? rowBy,
        string? columnBy,
        string? dateFieldId,
        string? bucket,
        string? range,
        string? filter,
        CancellationToken cancellationToken)
    {
        aggregate = string.IsNullOrWhiteSpace(aggregate) ? "count" : aggregate;
        if (aggregate is not ("count" or "sum" or "min" or "max"))
            throw new NendoValidationException(
                aggregate == "avg"
                    ? "avg is refused: the mean of exact decimals is not generally an exact decimal. Read sum and count."
                    : $"aggregate is one of count, sum, min, max; '{aggregate}' is not.");
        if (aggregate == "count" && !string.IsNullOrWhiteSpace(fieldId))
            throw new NendoValidationException("count takes no fieldId; it counts records.");
        if (aggregate != "count" && string.IsNullOrWhiteSpace(fieldId))
            throw new NendoValidationException($"{aggregate} names the numeric fieldId it reads.");
        var fields = new RequestEntity(this, entityId, cancellationToken);
        if (!string.IsNullOrWhiteSpace(fieldId)) await fields.RequireAsync(fieldId!, "aggregate");
        var filters = await ParseFiltersAsync(fields, filter);
        var shapes = new[] { groupBy, rowBy ?? columnBy, dateFieldId }.Count(value => !string.IsNullOrWhiteSpace(value));
        if (shapes > 1)
            throw new NendoValidationException("Choose one shape: groupBy, rowBy with columnBy, or dateFieldId with bucket and range.");
        var field = string.IsNullOrWhiteSpace(fieldId) ? null : fieldId;
        if (!string.IsNullOrWhiteSpace(groupBy))
        {
            await fields.RequireAsync(groupBy, "groupBy");
            var grouped = await application.GroupAggregateRecordsAsync(
                new NendoRecordGroupedAggregateQuery(entityId, groupBy, aggregate, field) { Filters = filters }, cancellationToken);
            return new NendoMcpAggregate(entityId, aggregate, field, "grouped", grouped.ChangeSequence)
            {
                GroupByFieldId = groupBy,
                Groups = grouped.Groups.Select(group => new NendoMcpAggregateGroup(group.Key, group.ValueLexeme, group.ContributingRecords)).ToArray(),
                Unrecognised = grouped.Unrecognised,
            };
        }
        if (!string.IsNullOrWhiteSpace(rowBy) || !string.IsNullOrWhiteSpace(columnBy))
        {
            if (string.IsNullOrWhiteSpace(rowBy) || string.IsNullOrWhiteSpace(columnBy))
                throw new NendoValidationException("A grid names both rowBy and columnBy.");
            await fields.RequireAsync(rowBy, "rowBy");
            await fields.RequireAsync(columnBy, "columnBy");
            var cells = await application.CellAggregateRecordsAsync(
                new NendoRecordCellAggregateQuery(entityId, rowBy, columnBy, aggregate, field) { Filters = filters }, cancellationToken);
            return new NendoMcpAggregate(entityId, aggregate, field, "cells", cells.ChangeSequence)
            {
                RowByFieldId = rowBy,
                ColumnByFieldId = columnBy,
                RowKeys = cells.RowKeys,
                ColumnKeys = cells.ColumnKeys,
                Cells = cells.Cells.Select(cell => new NendoMcpAggregateCell(cell.RowKey, cell.ColumnKey, cell.ValueLexeme, cell.ContributingRecords)).ToArray(),
                Unrecognised = cells.Unrecognised,
            };
        }
        if (!string.IsNullOrWhiteSpace(dateFieldId))
        {
            if (string.IsNullOrWhiteSpace(bucket) || string.IsNullOrWhiteSpace(range))
                throw new NendoValidationException("Date buckets name dateFieldId, bucket and range, as the vocabulary lists them.");
            await fields.RequireAsync(dateFieldId, "dateFieldId");
            var buckets = await application.BucketAggregateRecordsAsync(
                new NendoRecordDateBucketQuery(entityId, dateFieldId, bucket, range, aggregate, field) { Filters = filters }, cancellationToken);
            return new NendoMcpAggregate(entityId, aggregate, field, "buckets", buckets.ChangeSequence)
            {
                DateFieldId = dateFieldId,
                Bucket = bucket,
                Range = range,
                Start = buckets.Start,
                End = buckets.End,
                Buckets = buckets.Groups.Select(group => new NendoMcpAggregateGroup(group.Key, group.ValueLexeme, group.ContributingRecords)).ToArray(),
            };
        }
        if (aggregate == "count")
        {
            var count = await application.CountRecordsAsync(new NendoRecordCountQuery(entityId) { Filters = filters }, cancellationToken);
            return new NendoMcpAggregate(entityId, aggregate, null, "whole", count.ChangeSequence)
            {
                Value = count.Count.ToString(CultureInfo.InvariantCulture),
                ContributingRecords = count.Count,
            };
        }
        var whole = await application.AggregateRecordsAsync(
            new NendoRecordAggregateQuery(entityId, aggregate, field!) { Filters = filters }, cancellationToken);
        return new NendoMcpAggregate(entityId, aggregate, field, "whole", whole.ChangeSequence)
        {
            Value = whole.ValueLexeme,
            ContributingRecords = whole.ContributingRecords,
        };
    }

    /// <summary>How many records each record type holds now, keyed by entity ID (W-146).</summary>
    private async Task<IReadOnlyDictionary<string, long>> CountRecordsAsync(
        IEnumerable<NendoEntitySnapshot> entities, List<long> seen, CancellationToken cancellationToken)
    {
        var counts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var entity in entities)
        {
            var count = await application.CountRecordsAsync(new NendoRecordCountQuery(entity.EntityId), cancellationToken);
            await Settled("count");
            seen.Add(count.ChangeSequence);
            counts[entity.EntityId] = count.Count;
        }
        return counts;
    }

    /// <summary>
    /// One page of a record type as faithful Nendo CSV, in the same profile the native
    /// import and export use.
    /// <para>
    /// A resource rather than a tool, because reading is a resource in this product: a level
    /// that cannot change anything is worth being able to say plainly, and the only tools
    /// Inspect serves read resources (nendo.read.resource). The pages are the ordinary 1 to 100 and carry
    /// the same revision-bound cursor as every other page here, so a file that moves
    /// mid-export refuses the continuation rather than stitching two states together.
    /// </para>
    /// </summary>
    internal async Task<NendoMcpCsvPage> GetCsvExportAsync(
        string entityId,
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"export:{entityId}";
        using var writer = new StringWriter();
        var page = await application.ExportCsvPageAsync(
            entityId, writer, cursors.Decode(cursor, scope), limit, cancellationToken);
        return new NendoMcpCsvPage(
            entityId,
            writer.ToString(),
            page.RecordCount,
            page.FieldIds,
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
    }

    /// <summary>The facets of describe, as include names them.</summary>
    internal static IReadOnlyList<string> DescribeFacets { get; } =
        ["manifest", "limits", "entities", "surfaces", "health", "reads", "extensions", "newFile"];

    internal Task<NendoMcpDescription> GetDescriptionAsync(CancellationToken cancellationToken) =>
        GetDescriptionAsync(null, cancellationToken);

    /// <summary>
    /// The whole application, or the facets include names (W-150): a client that needs the
    /// manifest and the record types takes those and leaves the compiled screens, which are
    /// most of a mature file's describe, for a later read. A facet left out is null or empty.
    /// </summary>
    internal async Task<NendoMcpDescription> GetDescriptionAsync(string? include, CancellationToken cancellationToken)
    {
        var facets = string.IsNullOrWhiteSpace(include)
            ? DescribeFacets
            : include.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var unknown = facets.Where(facet => !DescribeFacets.Contains(facet, StringComparer.Ordinal)).ToArray();
        if (unknown.Length > 0)
            throw new NendoValidationException(
                $"include names {string.Join(", ", unknown)}; the facets are {string.Join(", ", DescribeFacets)}, comma-separated.");
        bool Wants(string facet) => facets.Contains(facet, StringComparer.Ordinal);
        return await CoherentAsync(async (snapshot, seen) =>
        {
            // The new-file preview carries no change sequence, so a later read that does
            // must close it in: the counts or the screens, or else one more snapshot.
            var newFile = Wants("newFile") ? await GetNewFileAsync(cancellationToken) : null;
            var closed = seen.Count;
            NendoMcpEntitySchema[]? entities = null;
            if (Wants("entities"))
            {
                var counts = await CountRecordsAsync(snapshot.Entities, seen, cancellationToken);
                entities = snapshot.Entities
                    .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
                    .Select(entity => ProjectSchema(entity) with { RecordCount = counts[entity.EntityId] })
                    .ToArray();
            }
            var surfaces = Wants("surfaces") ? await SurfacesAsync(snapshot, seen, cancellationToken) : null;
            if (Wants("newFile") && seen.Count == closed)
                seen.Add((await ReadDefinitionAsync(cancellationToken)).Manifest.ChangeSequence);
            return new NendoMcpDescription(
                snapshot.Manifest.Purpose,
                Wants("manifest") ? ProjectManifest(snapshot) : null,
                Wants("limits") ? NendoAuthoringLimits.Current : null,
                entities,
                surfaces,
                Wants("health") ? Health(snapshot.Health, snapshot.Storage, snapshot.Manifest.ChangeSequence) : null)
            {
                Included = facets.Distinct(StringComparer.Ordinal).ToArray(),
                Reads = Wants("reads") ? NendoMcpReadIndex.All : [],
                Extensions = Wants("extensions") ? ProjectExtensions(snapshot.ExtensionPackages) : [],
                NewFile = newFile,
            };
        }, cancellationToken);
    }

    /// <summary>One record type as a bundle (W-150): schema, record count and its compiled surfaces.</summary>
    internal Task<NendoMcpEntityBundle> GetEntityBundleAsync(string entityId, CancellationToken cancellationToken) =>
        CoherentAsync(async (snapshot, seen) => Bundle(
            entityId,
            await SchemaAsync(snapshot, entityId, seen, cancellationToken),
            await SurfacesAsync(snapshot, seen, cancellationToken)), cancellationToken);

    private static NendoMcpEntityBundle Bundle(string entityId, NendoMcpEntitySchema schema, NendoMcpSurfaces surfaces)
    {
        var own = surfaces.Applications.FirstOrDefault(app => app.EntityId == entityId);
        var nodeIds = own is null ? new HashSet<string>(StringComparer.Ordinal) : Nodes(own.Surfaces).Select(node => node.NodeId).ToHashSet(StringComparer.Ordinal);
        var fieldIds = schema.Fields.Select(field => field.FieldId).Concat(schema.DerivedFields.Select(field => field.FieldId)).ToHashSet(StringComparer.Ordinal);
        return new NendoMcpEntityBundle(schema, own?.Surfaces ?? [])
        {
            SurfacesValid = surfaces.IsValid,
            Diagnostics = surfaces.Diagnostics
                .Where(diagnostic => diagnostic.SemanticId is { } id && (id == entityId || nodeIds.Contains(id) || fieldIds.Contains(id)))
                .ToArray(),
        };
    }

    private static IEnumerable<NendoMcpSurfaceNode> Nodes(IEnumerable<NendoMcpSurfaceNode> roots) =>
        roots.SelectMany(root => new[] { root }.Concat(Nodes(root.Children)));

    /// <summary>
    /// What a new file of this application would keep now (ADR-0022). Null where the file cannot
    /// say, as in a read-only session, rather than a describe that fails over it.
    /// </summary>
    private async Task<NendoMcpNewFile?> GetNewFileAsync(CancellationToken cancellationToken)
    {
        try
        {
            var preview = await application.PreviewNewFileAsync(cancellationToken);
            return new(preview.MenuLabel, preview.Types, preview.ConflictCount, preview.Conflicts);
        }
        catch (Exception exception) when (exception is NendoException or InvalidOperationException) { return null; }
    }

    /// <summary>The most bytes one read of a package file returns.</summary>
    internal const long ExtensionFilePageBytes = 128 * 1024;

    internal async Task<IReadOnlyList<NendoMcpExtensionPackage>> GetExtensionsAsync(CancellationToken cancellationToken) =>
        ProjectExtensions((await ReadDefinitionAsync(cancellationToken)).ExtensionPackages);

    private static IReadOnlyList<NendoMcpExtensionPackage> ProjectExtensions(IReadOnlyList<NendoExtensionPackageSnapshot> packages) =>
        packages.Select(package => new NendoMcpExtensionPackage(
            package.PackageId, package.Title, package.Version, package.EntryPoint, package.Description, package.Kind, package.TotalBytes,
            package.Files.Select(file => new NendoMcpExtensionFile(file.Path, file.MediaType, file.Sha256, file.ByteLength)).ToArray()))
            .ToArray();

    /// <summary>
    /// One page of a package file. Text arrives as text so an agent can read and edit it as
    /// written; anything else, and a page that would split a UTF-8 sequence, arrives as base64.
    /// </summary>
    internal async Task<NendoMcpExtensionFileContent> GetExtensionFileAsync(
        string packageId, string? path, long offset, long length, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new NendoValidationException("Name the file with ?path=, for example ?path=index.html.");
        if (offset < 0 || length < 1 || length > ExtensionFilePageBytes)
            throw new NendoValidationException($"offset must be 0 or more and length 1 to {ExtensionFilePageBytes}.");
        var file = await application.ReadExtensionFileAsync(packageId, path, cancellationToken)
            ?? throw new NendoValidationException($"The file carries no {path} in package {packageId}; nendo://application/extensions lists what it holds.");
        var total = file.Content.LongLength;
        if (offset > total)
            throw new NendoValidationException($"offset {offset} is past the end of {path}, which is {total} bytes.");
        var count = (int)Math.Min(length, total - offset);
        var slice = file.Content.AsSpan((int)offset, count);
        var next = offset + count < total ? offset + count : (long?)null;
        string? text = null;
        string? base64 = null;
        if (NendoExtensionContent.IsTextual(file.MediaType) && TryUtf8(slice, out var decoded)) text = decoded;
        else base64 = Convert.ToBase64String(slice);
        return new NendoMcpExtensionFileContent(packageId, path, file.MediaType, file.Sha256, total, offset, count, next, text, base64);
    }

    private static readonly System.Text.UTF8Encoding StrictUtf8 = new(false, true);

    private static bool TryUtf8(ReadOnlySpan<byte> bytes, out string text)
    {
        try
        {
            text = StrictUtf8.GetString(bytes);
            return true;
        }
        catch (System.Text.DecoderFallbackException)
        {
            text = string.Empty;
            return false;
        }
    }

    internal Task<NendoMcpSurfaces> GetSurfacesAsync(CancellationToken cancellationToken) =>
        CoherentAsync((snapshot, seen) => SurfacesAsync(snapshot, seen, cancellationToken), cancellationToken);

    /// <summary>
    /// The compiled screens beside the stored nodes of <paramref name="snapshot"/>. The compiler
    /// reads the definition itself and says which change sequence it compiled; a recovery
    /// state's fixed refusal names none, and describes no definition to disagree with.
    /// </summary>
    private async Task<NendoMcpSurfaces> SurfacesAsync(NendoSessionSnapshot snapshot, List<long> seen, CancellationToken cancellationToken)
    {
        var compilation = await application.CompileSemanticDefinitionAsync(cancellationToken);
        await Settled("surfaces");
        if (compilation.SourceChangeSequence is { } compiled) seen.Add(compiled);
        var stored = snapshot.UiNodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        var declared = stored.Count;
        NendoMcpSurfaceNode ProjectSurfaceNode(NendoSurfaceNodePlan node) => Project(node, stored);
        var diagnostics = compilation.Diagnostics
            .Select(value => new NendoMcpDiagnostic(
                value.Code,
                value.Severity,
                value.Message,
                value.SemanticId,
                value.PropertyPath,
                value.Hint))
            .ToArray();
        var applications = compilation.Applications
            .Select(app => new NendoMcpApplicationSurfaces(
                app.Entity.SemanticId,
                app.Entity.DisplayName)
            {
                Surfaces = app.Surfaces.Select(ProjectSurfaceNode).ToArray(),
            })
            .ToArray();
        var state = compilation.IsValid ? "valid" : declared == 0 ? "noCustomSurfaces" : "invalid";
        var contractVersion = compilation.Applications.FirstOrDefault()?.ContractVersion;
        return new NendoMcpSurfaces(
            compilation.IsValid,
            state,
            contractVersion,
            diagnostics)
        {
            Applications = applications,
            Overview = compilation.Overview is null ? null : ProjectSurfaceNode(compilation.Overview.Surface),
            Views = compilation.Views.Select(ProjectSurfaceNode).ToArray(),
        };
    }

    // The node IDs the author supplied, the kind, and the properties the compiler
    // accepted. commandId is stated on a command root rather than left to be
    // inferred from the node ID it happens to equal.
    private static NendoMcpSurfaceNode Project(NendoSurfaceNodePlan node, IReadOnlyDictionary<string, NendoUiNodeSnapshot> stored) =>
        new(node.SemanticId,
            node.Kind,
            node.Properties,
            node.Children.Select(child => Project(child, stored)).ToArray())
        {
            SurfaceId = stored.TryGetValue(node.SemanticId, out var kept) ? kept.SurfaceId : null,
            ParentNodeId = kept?.ParentNodeId,
            Position = kept?.Position,
            // A command carries label rather than title; reading only title showed
            // the one node kind an agent most needs to name as having no name.
            Title = Text(node, "title") ?? Text(node, "label"),
            EntityId = Text(node, "entityId"),
            CommandId = node.Kind == "recordCommand" ? node.SemanticId : null,
        };

    private static string? Text(NendoSurfaceNodePlan node, string property) =>
        node.Properties.TryGetValue(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    internal Task<NendoMcpPage<NendoMcpRevision>> GetHistoryAsync(
        string? cursor,
        int limit,
        CancellationToken cancellationToken) =>
        GetHistoryAsync(cursor, limit, null, cancellationToken);

    /// <summary>
    /// A page of revision summaries, oldest first unless <paramref name="newestFirst"/> is true.
    /// Newest first answers "what changed last" in one read instead of paging the whole history.
    /// The direction is part of the cursor's scope here and in the Engine, so a cursor from one
    /// direction does not continue the other.
    /// </summary>
    internal async Task<NendoMcpPage<NendoMcpRevision>> GetHistoryAsync(
        string? cursor,
        int limit,
        string? newestFirst,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var newest = newestFirst switch
        {
            null or "" or "false" => false,
            "true" => true,
            _ => throw new NendoValidationException("newestFirst is true or false."),
        };
        var scope = newest ? "history:newest" : "history";
        var page = await application.QueryHistoryAsync(new(limit, cursors.Decode(cursor, scope), newest), cancellationToken);
        await Settled("history");
        return new NendoMcpPage<NendoMcpRevision>(
            page.Items.Select(ProjectRevision).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor)) { ChangeSequence = page.ChangeSequence };
    }

    internal async Task<NendoMcpPage<NendoMcpOperation>> GetRevisionOperationsAsync(
        string revisionId, string? cursor, int limit, CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"operations:{revisionId}";
        var page = await application.QueryRevisionOperationsAsync(new(revisionId, limit, cursors.Decode(cursor, scope)), cancellationToken);
        return new(page.Items.Select(operation => new NendoMcpOperation(operation.OperationType, operation.Reversibility,
            AffectedSemanticIds(operation.CanonicalJson))
        {
            Attribution = operation.Attribution is { } made
                ? new(made.TriggerId, made.TriggerName, made.ActionId, made.ActionName, made.StepId,
                    made.EventKind, made.EventEntityId, made.EventRecordId)
                : null,
        }).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor)) { ChangeSequence = page.ChangeSequence };
    }

    internal async Task<NendoMcpHealth> GetHealthAsync(CancellationToken cancellationToken)
    {
        var snapshot = await ReadDefinitionAsync(cancellationToken);
        return Health(snapshot.Health, snapshot.Storage, snapshot.Manifest.ChangeSequence);
    }

    /// <summary>
    /// Run a real integrity scan, but only when the file has moved since the last
    /// one. A scan reads the whole file; repeating it against an unchanged file
    /// would cost that for an answer already on record.
    /// </summary>
    internal async Task<NendoMcpIntegrityCheck> VerifyIntegrityAsync(CancellationToken cancellationToken)
    {
        var before = await GetHealthAsync(cancellationToken);
        if (!before.IntegrityStale)
        {
            return new NendoMcpIntegrityCheck(
                false,
                "The file has not changed since the last integrity check, so the recorded result describes it as it stands.",
                before);
        }
        var storage = await application.VerifyIntegrityAsync(cancellationToken);
        var snapshot = await ReadDefinitionAsync(cancellationToken);
        return new NendoMcpIntegrityCheck(
            true,
            "The file was scanned and is intact as of this change sequence.",
            Health(snapshot.Health, storage, snapshot.Manifest.ChangeSequence));
    }

    private static NendoMcpHealth Health(
        NendoSessionHealth health,
        NendoStorageHealthSnapshot storage,
        long changeSequence) => new(
            health,
            storage.IntegrityResult,
            "local-coordinated-durable-file")
        {
            IntegrityCheckedAt = storage.IntegrityCheckedAt,
            IntegrityChangeSequence = storage.IntegrityChangeSequence,
            ChangeSequence = changeSequence,
        };

    private static NendoMcpRevision ProjectRevision(NendoRevisionSummary revision) => new(
        revision.RevisionId,
        revision.CreatedAt,
        revision.Origin,
        revision.Description,
        revision.Lane,
        revision.DefinitionRevisionBefore,
        revision.DefinitionRevisionAfter,
        revision.DataRevisionBefore,
        revision.DataRevisionAfter,
        revision.ChangeSequence,
        revision.OperationDigest,
        revision.ProposalId,
        revision.ProposalDigest,
        revision.CompensationOfRevisionId,
        revision.OperationCount,
        $"nendo://application/revision/{Uri.EscapeDataString(revision.RevisionId)}/operations");

    private static IReadOnlyList<string> AffectedSemanticIds(string canonicalJson)
    {
        using var document = JsonDocument.Parse(canonicalJson, new JsonDocumentOptions { MaxDepth = 16 });
        var result = new SortedSet<string>(StringComparer.Ordinal);
        CollectSemanticIds(document.RootElement, result);
        return result.ToArray();
    }

    private static void CollectSemanticIds(JsonElement element, ISet<string> result)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.String && IsSemanticIdProperty(property.Name))
                {
                    var value = property.Value.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        result.Add(value);
                    }
                }
                else if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    CollectSemanticIds(property.Value, result);
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                CollectSemanticIds(item, result);
            }
        }
    }

    private static bool IsSemanticIdProperty(string name) => name is
        "entityId" or "fieldId" or "recordId" or "surfaceId" or "nodeId" or
        "parentNodeId" or "commandId" or "targetEntityId" or "labelFieldId" or "tableEntityId";

    private static void RequireLimit(int limit)
    {
        if (limit < NendoAuthoringLimits.Current.MinimumPageLimit ||
            limit > NendoAuthoringLimits.Current.MaximumPageLimit)
        {
            throw NendoMcpErrors.InvalidLimit();
        }
    }
}
