using System.Globalization;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoResourceProjection(
    NendoApplicationService application,
    NendoCursorCodec cursors)
{
    /// <summary>The definition revision the file is at now, without a record or history read.</summary>
    internal async Task<long> GetDefinitionRevisionAsync(CancellationToken cancellationToken) =>
        (await application.GetDefinitionSnapshotAsync(cancellationToken)).Manifest.DefinitionRevision;

    internal async Task<NendoMcpManifest> GetManifestAsync(CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
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
        (await application.GetDefinitionSnapshotAsync(cancellationToken)).Entities
            .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
            .Select(entity => new NendoMcpEntity(entity.EntityId, entity.DisplayName) { Retired = entity.Retired })
            .ToArray();

    internal async Task<NendoMcpEntitySchema> GetSchemaAsync(
        string entityId,
        CancellationToken cancellationToken)
    {
        var entity = (await application.GetDefinitionSnapshotAsync(cancellationToken)).Entities
            .SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw NendoMcpErrors.EntityNotFound();
        var counts = await CountRecordsAsync([entity], cancellationToken);
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
        return new NendoMcpPage<NendoMcpTreeNode>(
            page.Items.Select(node => new NendoMcpTreeNode(Project(node.Record), node.ParentRecordId, node.Depth, node.ChildCount)).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
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
        GetRecordsAsync(entityId, cursor, limit, null, null, null, null, cancellationToken);

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
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"records:{entityId}";
        var filters = await ParseFiltersAsync(entityId, filter, cancellationToken);
        if (sort is not null) await RequireFieldAsync(entityId, sort, "sort", cancellationToken);
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
        var records = page.Items.Select(Project).ToArray();
        return new NendoMcpPage<NendoMcpRecord>(
            records,
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
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
    private async Task<IReadOnlyList<NendoRecordFilter>> ParseFiltersAsync(string entityId, string? filter, CancellationToken cancellationToken)
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
                await RequireFieldAsync(entityId, fieldId.GetString()!, "filter", cancellationToken);
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

    /// <summary>A field the record type has, stored or calculated, named with the ones it has when it is not.</summary>
    private async Task RequireFieldAsync(string entityId, string fieldId, string use, CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        var entity = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        if (entity.Fields.Any(field => field.FieldId == fieldId) || entity.DerivedFields.Any(field => field.FieldId == fieldId)) return;
        var known = entity.Fields.Select(field => field.FieldId).Concat(entity.DerivedFields.Select(field => field.FieldId))
            .OrderBy(value => value, StringComparer.Ordinal).ToArray();
        throw new NendoValidationException(
            $"The {use} field '{fieldId}' is not a field of {entityId}; its fields are {string.Join(", ", known)}.");
    }

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
        if (!string.IsNullOrWhiteSpace(fieldId)) await RequireFieldAsync(entityId, fieldId!, "aggregate", cancellationToken);
        var filters = await ParseFiltersAsync(entityId, filter, cancellationToken);
        var shapes = new[] { groupBy, rowBy ?? columnBy, dateFieldId }.Count(value => !string.IsNullOrWhiteSpace(value));
        if (shapes > 1)
            throw new NendoValidationException("Choose one shape: groupBy, rowBy with columnBy, or dateFieldId with bucket and range.");
        var field = string.IsNullOrWhiteSpace(fieldId) ? null : fieldId;
        if (!string.IsNullOrWhiteSpace(groupBy))
        {
            await RequireFieldAsync(entityId, groupBy, "groupBy", cancellationToken);
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
            await RequireFieldAsync(entityId, rowBy, "rowBy", cancellationToken);
            await RequireFieldAsync(entityId, columnBy, "columnBy", cancellationToken);
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
            await RequireFieldAsync(entityId, dateFieldId, "dateFieldId", cancellationToken);
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
    private async Task<IReadOnlyDictionary<string, long>> CountRecordsAsync(IEnumerable<NendoEntitySnapshot> entities, CancellationToken cancellationToken)
    {
        var counts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var entity in entities)
        {
            counts[entity.EntityId] = (await application.CountRecordsAsync(new NendoRecordCountQuery(entity.EntityId), cancellationToken)).Count;
        }
        return counts;
    }

    /// <summary>
    /// One page of a record type as faithful Nendo CSV, in the same profile the native
    /// import and export use.
    /// <para>
    /// A resource rather than a tool, because reading is a resource in this product and
    /// because Inspect must keep an empty tool list -- a level that cannot change anything
    /// is worth being able to say plainly. The pages are the ordinary 1 to 100 and carry
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

    internal async Task<NendoMcpDescription> GetDescriptionAsync(CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        var counts = await CountRecordsAsync(snapshot.Entities, cancellationToken);
        var entities = snapshot.Entities
            .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
            .Select(entity => ProjectSchema(entity) with { RecordCount = counts[entity.EntityId] })
            .ToArray();
        return new NendoMcpDescription(
            snapshot.Manifest.Purpose,
            await GetManifestAsync(cancellationToken),
            NendoAuthoringLimits.Current,
            entities,
            await GetSurfacesAsync(cancellationToken),
            await GetHealthAsync(cancellationToken))
        {
            Reads = NendoMcpReadIndex.All,
            Extensions = ProjectExtensions(snapshot.ExtensionPackages),
            NewFile = await GetNewFileAsync(cancellationToken),
        };
    }

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
        ProjectExtensions((await application.GetDefinitionSnapshotAsync(cancellationToken)).ExtensionPackages);

    private static IReadOnlyList<NendoMcpExtensionPackage> ProjectExtensions(IReadOnlyList<NendoExtensionPackageSnapshot> packages) =>
        packages.Select(package => new NendoMcpExtensionPackage(
            package.PackageId, package.Title, package.Version, package.EntryPoint, package.Description, package.TotalBytes,
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

    internal async Task<NendoMcpSurfaces> GetSurfacesAsync(CancellationToken cancellationToken)
    {
        var compilation = await application.CompileSemanticDefinitionAsync(cancellationToken);
        var declared = (await application.GetDefinitionSnapshotAsync(cancellationToken)).UiNodes.Count;
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
    private static NendoMcpSurfaceNode ProjectSurfaceNode(NendoSurfaceNodePlan node) =>
        new(node.SemanticId,
            node.Kind,
            node.Properties,
            node.Children.Select(ProjectSurfaceNode).ToArray())
        {
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

    internal async Task<NendoMcpPage<NendoMcpRevision>> GetHistoryAsync(
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        const string scope = "history";
        var page = await application.QueryHistoryAsync(new(limit, cursors.Decode(cursor, scope), false), cancellationToken);
        return new NendoMcpPage<NendoMcpRevision>(
            page.Items.Select(ProjectRevision).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
    }

    internal async Task<NendoMcpPage<NendoMcpOperation>> GetRevisionOperationsAsync(
        string revisionId, string? cursor, int limit, CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"operations:{revisionId}";
        var page = await application.QueryRevisionOperationsAsync(new(revisionId, limit, cursors.Decode(cursor, scope)), cancellationToken);
        return new(page.Items.Select(operation => new NendoMcpOperation(operation.OperationType, operation.Reversibility,
            AffectedSemanticIds(operation.CanonicalJson))).ToArray(),
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
    }

    internal async Task<NendoMcpHealth> GetHealthAsync(CancellationToken cancellationToken)
    {
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
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
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
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
        "parentNodeId" or "commandId" or "targetEntityId" or "labelFieldId";

    private static void RequireLimit(int limit)
    {
        if (limit < NendoAuthoringLimits.Current.MinimumPageLimit ||
            limit > NendoAuthoringLimits.Current.MaximumPageLimit)
        {
            throw NendoMcpErrors.InvalidLimit();
        }
    }
}
