using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoResourceProjection(
    NendoApplicationService application,
    NendoCursorCodec cursors)
{
    internal async Task<NendoMcpManifest> GetManifestAsync(CancellationToken cancellationToken)
    {
        var value = (await application.GetDefinitionSnapshotAsync(cancellationToken)).Manifest;
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
        return ProjectSchema(entity);
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
                    field.Options) { Reference = field.Reference, Choices = field.Choices, Scale = field.Scale, Retired = field.Retired })
                .ToArray())
        {
            Retired = entity.Retired,
            DerivedFields = entity.DerivedFields
                .OrderBy(field => field.FieldId, StringComparer.Ordinal)
                .Select(field => new NendoMcpDerivedField(
                    field.FieldId, field.DisplayName, field.CalculationId,
                    field.ResultType, field.ResultNullable, field.Expression))
                .ToArray(),
        };
    }

    internal async Task<NendoMcpPage<NendoMcpRecord>> GetRecordsAsync(
        string entityId,
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        RequireLimit(limit);
        var scope = $"records:{entityId}";
        var page = await application.QueryRecordsAsync(new(entityId, limit, cursors.Decode(cursor, scope)), cancellationToken);
        var records = page.Items
            .Select(record => new NendoMcpRecord(
                record.EntityId,
                record.RecordId,
                record.RecordVersion,
                record.Values)
            {
                ReferenceLabels = record.ReferenceLabels,
                Calculations = record.Calculations
                    .Select(result => new NendoMcpCalculation(
                        result.CalculationId, result.FieldId, result.State, result.ResultType,
                        result.Value, result.ErrorCode, result.ErrorMessage))
                    .ToArray(),
            })
            .ToArray();
        return new NendoMcpPage<NendoMcpRecord>(
            records,
            page.NextCursor is null ? null : cursors.Encode(scope, page.NextCursor));
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
        var writer = new StringWriter();
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
        var entities = snapshot.Entities
            .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
            .Select(ProjectSchema)
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
        };
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
