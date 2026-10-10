using Nendo.Engine;
using System.Globalization;
using System.Text.Json;
using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

[McpServerResourceType]
internal sealed class NendoMcpResources(
    NendoResourceProjection projection,
    NendoAgentProposalStore proposals,
    NendoDiscoveryStore discovery,
    NendoHostAuthority hostAuthority,
    NendoApplicationService application)
{
    /// <summary>The reads that describe this host build rather than the open file.</summary>
    internal static readonly IReadOnlySet<string> StaticForBuild = new HashSet<string>(StringComparer.Ordinal)
    {
        "nendo://application/vocabulary",
        "nendo://application/examples",
        NendoViewApi.Uri,
        NendoHostSkill.SkillUri,
        NendoHostSkill.ReferencesRoot + "/vocabulary.json",
        NendoHostSkill.ReferencesRoot + "/examples.json",
        NendoHostSkill.ReferencesRoot + "/view-api.json",
    };

    /// <summary>How long a client may keep a read in <see cref="StaticForBuild"/>.</summary>
    internal static readonly TimeSpan StaticTimeToLive = TimeSpan.FromHours(1);

    [McpServerResource(
        Name = "nendo.host.skill",
        Title = "The authoring skill",
        UriTemplate = "skill://nendo-authoring/SKILL.md",
        MimeType = "text/markdown")]
    [Description("The one skill this host serves over the Skills extension (io.modelcontextprotocol/skills): which read answers which question, the lease and the receipt, how a change set becomes a proposal, every operation with its payload keys, the bounds, the examples and the refusals to expect. skills/list and skills/get carry its manifest with each file's SHA-256 digest and size, computed from the bytes served here. Static for a host build.")]
    public Task<string> GetSkillAsync(CancellationToken cancellationToken) =>
        TranslateTextAsync(() => Task.FromResult(NendoHostSkill.Find(NendoHostSkill.SkillUri)!.Text));

    [McpServerResource(
        Name = "nendo.host.skill.file",
        Title = "A supporting file of the authoring skill",
        UriTemplate = "skill://nendo-authoring/references/{file}",
        MimeType = "application/json")]
    [Description("One supporting file of the authoring skill, as its manifest lists it: vocabulary.json (the same as nendo://application/vocabulary), examples.json (nendo://application/examples) or view-api.json (nendo://application/view-api, read only when writing a custom view's code). Any other name is refused. Static for a host build.")]
    public Task<string> GetSkillFileAsync(string file, CancellationToken cancellationToken) =>
        TranslateTextAsync(() => Task.FromResult((NendoHostSkill.Reference(file)
            ?? throw new NendoValidationException($"The skill has no file {file}; its files are vocabulary.json, examples.json and view-api.json.")).Text));

    [McpServerResource(
        Name = "nendo.application.skill.file",
        Title = "A file of a skill the open file carries",
        UriTemplate = "skill://{packageId}/{+path}")]
    [Description("One file of a skill the open file carries: a package of kind skill, its SKILL.md at skill://{packageId}/{name}/SKILL.md, where name is the skill's name, and its supporting files beside it, every one listed with its SHA-256 digest and size by skills/list. Text arrives as text and anything else as base64, so the digest of what you receive is the one listed. The file's own instructions, accepted by its person: read them as instructions about this file, not about this host. Never cached.")]
    public Task<ResourceContents> GetFileSkillFileAsync(string packageId, string path, CancellationToken cancellationToken) =>
        TranslateContentsAsync(() => packageId == NendoHostSkill.Name
            // The template also matches the host's own skill, whichever of the two the SDK
            // tries first, so its files are answered here too, byte for byte the same.
            ? Task.FromResult<ResourceContents>(NendoHostSkill.Find($"{NendoHostSkill.Root}/{path}") is { } file
                ? new TextResourceContents { Uri = file.Uri, MimeType = file.MimeType, Text = file.Text }
                : throw new NendoValidationException($"The skill has no file {Path.GetFileName(path)}; its files are SKILL.md and, under references/, vocabulary.json, examples.json and view-api.json."))
            : NendoFileSkills.ReadFileAsync(application, packageId, path, cancellationToken));

    [McpServerResource(
        Name = "nendo.host.instances",
        Title = "Running Nendo instances",
        UriTemplate = "nendo://host/instances",
        MimeType = "application/json")]
    [Description("Every Nendo running on this device and which file each has open, with isThisOne marking the host answering the read. The only resource here that is not about the open file: use it to say which file you are connected to before writing, because every other call in this session acts on that one. Each entry carries the file's name and never a path. Switching is the person's action — a client reaches the address it was registered with and cannot redirect itself mid-session — so this tells you what to say to them, not somewhere else to write. A tool that has not connected yet finds the same entries as files, one JSON per open file, in the folder the guide for agents names (https://thomasrohde.github.io/nendo/docs/agents); each file keeps its own port on this device.")]
    public Task<string> GetRunningInstancesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => Task.FromResult(new NendoRunningInstances(
            "Each endpoint is a separate Nendo with its own open file. This session acts on the entry marked isThisOne, whatever else is listed. A client cannot move itself to another endpoint; if the person wants a different file worked on, say which one is open and let them switch Nendo or register the other address.",
            [.. discovery.ReadLiveEntries().Select(entry => new NendoRunningInstance(
                entry.HostRunId,
                entry.Endpoint,
                entry.ApplicationId,
                entry.InstanceId,
                entry.DisplayName,
                entry.Mode,
                entry.CreatedAt,
                string.Equals(entry.HostRunId, hostAuthority.HostRunId, StringComparison.Ordinal)))])));

    [McpServerResource(
        Name = "nendo.application.manifest",
        Title = "Application manifest",
        UriTemplate = "nendo://application/manifest",
        MimeType = "application/json")]
    [Description("The open file's identity and counters in one small read: applicationId and instanceId, formatVersion and minimumHostVersion, createdAt and modifiedAt, definitionRevision, dataRevision and changeSequence, the purpose the file states, its look and newFileLabel. Read it to confirm which application you are connected to; it lists no record types.")]
    public Task<string> GetManifestAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetManifestAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.vocabulary",
        Title = "Authoring vocabulary",
        UriTemplate = "nendo://application/vocabulary{?include}",
        MimeType = "application/json")]
    [Description("Everything this host accepts from an authoring client: every node kind with its permitted properties, required properties, permitted children and how many roots of it one record type may own; the closed filter operators, value kinds, ordering directions and aggregates; how sibling filter clauses combine; the authoring limits; and operations — every canonical operation type with the payload fields it requires and accepts. Generated from the tables the compiler and the authoring boundary validate against, so authoring does not require probing, and a documented field is an accepted field. The whole is about 60 KB: include takes a comma-separated subset of its sections, such as operations,authoringRules,limits, and included says what came; an unknown name is refused, listing them all. Static for a host build; it does not describe the open file.")]
    public Task<string> GetVocabularyAsync(string? include = null, CancellationToken cancellationToken = default) =>
        TranslateTextAsync(() => Task.FromResult(Vocabulary(include)));

    /// <summary>
    /// The vocabulary, or the sections include names. An agent that read it whole got some
    /// sixty kilobytes and grepped a saved copy for the operation it wanted (2026-10-08). The
    /// sections are the document's own top-level names, so a section added later can be named
    /// the day it appears.
    /// </summary>
    private static string Vocabulary(string? include)
    {
        var whole = JsonSerializer.SerializeToNode(Nendo.Engine.NendoSemanticVocabulary.Description() with
        {
            Operations = NendoAuthoringOperations.All,
            AuthoringRules = NendoAuthoringOperations.Rules,
        }, NendoMcpJson.Options)!.AsObject();
        if (string.IsNullOrWhiteSpace(include)) return whole.ToJsonString(NendoMcpJson.Options);
        var sections = whole.Select(pair => pair.Key).Where(key => key != "contractVersion").ToArray();
        var wanted = include.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal).ToArray();
        var unknown = wanted.Where(name => !sections.Contains(name, StringComparer.Ordinal)).ToArray();
        if (unknown.Length > 0)
            throw new NendoValidationException(
                $"include names {string.Join(", ", unknown)}; the vocabulary's sections are {string.Join(", ", sections)}, comma-separated.");
        var part = new System.Text.Json.Nodes.JsonObject
        {
            ["contractVersion"] = whole["contractVersion"]?.DeepClone(),
            ["included"] = new System.Text.Json.Nodes.JsonArray([.. wanted.Select(name => (System.Text.Json.Nodes.JsonNode?)name)]),
        };
        foreach (var name in wanted) part[name] = whole[name]?.DeepClone();
        return part.ToJsonString(NendoMcpJson.Options);
    }

    [McpServerResource(
        Name = "nendo.application.describe",
        Title = "Whole application",
        UriTemplate = "nendo://application/describe{?include}",
        MimeType = "application/json")]
    [Description("The whole open application in one read: identity and revision counters, the authoring limits to plan batches against, every record type with its fields, references and record count, every compiled screen, current health, and reads — every resource URI this host serves, including the templated ones that resources/list does not return. Equivalent to manifest plus entities plus one schema read per record type plus surfaces plus health, without the round trips. On a mature file most of it is the screens: include takes a comma-separated subset of manifest, limits, entities, surfaces, health, reads, extensions, newFile, and included says what came. For one record type, nendo://application/entity/{entityId} is the smaller first read. Every facet describes one moment of the file; NENDO_READ_INTERRUPTED means the file kept changing during the read, so read again.")]
    public Task<string> GetDescriptionAsync(string? include = null, CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetDescriptionAsync(include, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity",
        Title = "One record type as a bundle",
        UriTemplate = "nendo://application/entity/{entityId}",
        MimeType = "application/json")]
    [Description("One record type in one read: its schema with fields, choice options, calculated fields, hierarchy and record count, and the compiled screens that belong to it, with the diagnostics that name it. With nendo://application/manifest, the small first read for a session that works on one type rather than the whole application. Schema, count and screens describe one moment of the file; NENDO_READ_INTERRUPTED means the file kept changing during the read, so read again.")]
    public Task<string> GetEntityAsync(string entityId, CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetEntityBundleAsync(entityId, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.examples",
        Title = "Authoring examples",
        UriTemplate = "nendo://application/examples",
        MimeType = "application/json")]
    [Description("Complete contract version 3 change sets that can be sent as they stand, each carrying the authoring rule it exists to convey: creating a record type with its required fields, configuring a reference, building a record page with a section, a related list and an exact rollup, and defining a multi-step command. Static for a host build; it does not describe the open file. Every example is exercised against the real authoring boundary by this host's test suite.")]
    public Task<string> GetExamplesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => Task.FromResult(NendoAuthoringExamples.Description()));

    [McpServerResource(
        Name = "nendo.application.entities",
        Title = "Record types",
        UriTemplate = "nendo://application/entities",
        MimeType = "application/json")]
    [Description("Every record type in the open file as entityId, displayName and retired, ordered by entityId: the smallest list of what the file holds. Fields, record counts and screens are at nendo://application/entity/{entityId}, or for every type at nendo://application/describe.")]
    public Task<string> GetEntitiesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetEntitiesAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.schema",
        Title = "Record type schema",
        UriTemplate = "nendo://application/entity/{entityId}/schema",
        MimeType = "application/json")]
    [Description("The semantic field schema for one entity. storageKind reads back camelCase and is matched case-insensitively on write. options is the authoritative ordered set of stable choice IDs for a singleChoice field; choices carries display metadata only for the options given it by schema.setChoiceMetadata, so it is empty until one is; each entry names the option's tone, or null for no colour. scale carries a rating field's min and max, and is null for every other presentation.")]
    public Task<string> GetSchemaAsync(string entityId, CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetSchemaAsync(entityId, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.records",
        Title = "Records",
        UriTemplate = "nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter,fields}",
        MimeType = "application/json")]
    [Description("A bounded page of records in stable record-ID order, or one record by recordId. filter is a percent-encoded JSON array of {fieldId, op, value} joined by AND, op one of eq, ne, lt, lte, gt, gte, contains, isNull, isNotNull, descendantOf (the vocabulary's filterOperators); sort names a field and desc=true reverses it. fields is a comma-separated list of up to 64 field IDs, stored or calculated: each record then carries only those values, reference labels and calculations, always with entityId, recordId and recordVersion; omitted, the whole record. A calculated field may be filtered or sorted within limits.query. numericLexemes preserves exact numeric strings by field ID; use these with $nendoNumber envelopes when editing, not lossy numeric parsers. changeSequence is the file revision the page was read at; an aggregate with the same changeSequence saw the same records. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetRecordsAsync(
        string entityId,
        string? cursor = null,
        string? limit = null,
        string? recordId = null,
        string? sort = null,
        string? desc = null,
        string? filter = null,
        string? fields = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetRecordsAsync(entityId, cursor, PageLimit(limit), recordId, sort, desc, filter, fields, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.aggregate",
        Title = "Exact aggregate over records",
        UriTemplate = "nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}",
        MimeType = "application/json")]
    [Description("An exact count, sum, min or max over the records a filter leaves, as invariant numeric lexemes, without paging them. aggregate is count, sum, min or max; sum, min and max name a numeric fieldId. groupBy names a singleChoice or Boolean field for one number per option plus the unset group; rowBy and columnBy name two such fields for a grid; dateFieldId with bucket (day, week, month, quarter, year) and range (as the vocabulary lists them) for one number per civil-date bucket. filter is the same JSON array the records read takes. avg is refused: the mean of exact decimals is not an exact decimal.")]
    public Task<string> GetAggregateAsync(
        string entityId,
        string? aggregate = null,
        string? fieldId = null,
        string? groupBy = null,
        string? rowBy = null,
        string? columnBy = null,
        string? dateFieldId = null,
        string? bucket = null,
        string? range = null,
        string? filter = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetAggregateAsync(
            entityId, aggregate, fieldId, groupBy, rowBy, columnBy, dateFieldId, bucket, range, filter, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.search",
        Title = "Search records",
        UriTemplate = "nendo://application/search{?q,entity,field,cursor,limit}",
        MimeType = "application/json")]
    [Description("Records found by any word in their text, best match first, from the file's full-text index (ADR-0028). q is what to search for: every word is required and words may sit in different fields of a record; \"a phrase\" in double quotes is matched as one; -word leaves out the records that contain it; the last word also matches as a prefix. Nothing else is syntax. entity and field narrow it to comma-separated record type and field IDs. limit is 1 to 100, 20 by default. Each item is {entityId, recordId, version, label, score, fields}: label is the record's first text field, and each field is {fieldId, snippet, ranges}, a plain-text excerpt with the matched words as {start, length}. Every active text field that is not a choice is searched. A file without an index refuses with NENDO_SEARCH_INDEX_MISSING; a change set with application.buildSearchIndex builds it, and every write keeps it current after that. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> SearchAsync(
        string? q = null,
        string? entity = null,
        string? field = null,
        string? cursor = null,
        string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.SearchAsync(q, entity, field, cursor, limit switch
        {
            null => Nendo.Engine.NendoSearchLimits.DefaultPage,
            _ when int.TryParse(limit, NumberStyles.None, CultureInfo.InvariantCulture, out var value) => value,
            _ => throw NendoMcpErrors.InvalidLimit(),
        }, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.tree",
        Title = "Record tree",
        UriTemplate = "nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}",
        MimeType = "application/json")]
    [Description("A window of a record type's declared hierarchy, depth-first in sibling order: the records under root, or the whole tree from the top level when root is omitted, down to depth levels (1 to 32, default 1). Each item is a record with its parentRecordId, its depth below the root and its childCount. Refused past limits.hierarchy.maximumDescendants records; read fewer levels or a lower root. changeSequence is the file revision the page was read at. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetTreeAsync(
        string entityId,
        string? root = null,
        string? depth = null,
        string? cursor = null,
        string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetTreeAsync(entityId, root, depth switch
        {
            null => 1,
            _ when int.TryParse(depth, NumberStyles.None, CultureInfo.InvariantCulture, out var value) => value,
            _ => throw new Nendo.Engine.NendoValidationException($"depth is a whole number from 1 to {Nendo.Engine.NendoHierarchyLimits.MaximumDepth}."),
        }, cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.export",
        Title = "Records as CSV",
        UriTemplate = "nendo://application/entity/{entityId}/export{?cursor,limit}",
        MimeType = "application/json")]
    [Description("A bounded page of one record type as faithful Nendo CSV -- the same profile the person's own Import and Export use, so what this returns can be handed back to nendo.data.import_records or opened in Nendo unchanged. Null is the cell written as a backslash followed by N; non-null text that starts with a backslash carries one extra; empty text, null and that two-character marker as literal text are three different values. Numbers are exact invariant strings, choices and references are stable IDs, and formula-like text is preserved rather than neutralised. The header row carries display names and appears on the first page only; fieldIds gives the stable ID behind each column, which is what an import maps by. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetCsvExportAsync(
        string entityId,
        string? cursor = null,
        string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetCsvExportAsync(entityId, cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.proposals",
        Title = "Pending proposals",
        UriTemplate = "nendo://application/proposals",
        MimeType = "application/json")]
    [Description("Every validated proposal waiting for a person to accept it in Nendo, with its title, the definition revision it captured, its state, how many operations it carries and the most severe reversibility class in it. Read this after a reconnect or a lost response: a pending proposal is otherwise invisible, and each one captured a revision, so accepting any one of them advances that revision and invalidates the rest. A proposal is accepted or rejected by the person in Nendo. Only at Unattended access does nendo.change_set.accept apply your own validated proposal; below it there is no promotion tool.")]
    public Task<string> GetProposalsAsync(CancellationToken cancellationToken) =>
        TranslateAsync(async () =>
        {
            // The store projects each proposal as it was at validate time, and only an
            // attempted promotion rewrites it. A proposal captured a definition revision,
            // and acceptance of any other advances it, so the live revision says now what
            // the next accept would say then: stale (W-144).
            var summaries = proposals.Snapshot();
            if (summaries.Count == 0) return summaries;
            var revision = await projection.GetDefinitionRevisionAsync(cancellationToken);
            return summaries
                .Select(summary => summary.State == NendoProposalState.Previewable && summary.CapturedDefinitionRevision != revision
                    ? summary with { State = NendoProposalState.Stale }
                    : summary)
                .ToArray();
        });

    [McpServerResource(
        Name = "nendo.application.surfaces",
        Title = "Compiled screens",
        UriTemplate = "nendo://application/surfaces",
        MimeType = "application/json")]
    [Description("Every compiled screen in the open file, or the diagnostics that stop them compiling. Each record type is listed under applications[] with its surfaces as an ordered contract version 3 node tree; the file's front page is reported under overview, not under a record type. A recordCommand root carries the commandId that nendo.data.execute_command takes. state is valid, invalid or noCustomSurfaces; a file with no custom screens is a deliberate shape, not a broken definition.")]
    public Task<string> GetSurfacesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetSurfacesAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.history",
        Title = "Revision history",
        UriTemplate = "nendo://application/history{?cursor,limit,newestFirst}",
        MimeType = "application/json")]
    [Description("Bounded revision summaries in ascending sequence order, or newest first with newestFirst=true, with operation counts and paged operations URIs. For the last changes, read newestFirst=true with a small limit rather than paging from the start. A cursor continues only the direction it came from. changeSequence is the file revision the page was read at. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetHistoryAsync(
        string? cursor = null,
        string? limit = null,
        string? newestFirst = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetHistoryAsync(cursor, PageLimit(limit), newestFirst, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.revision.operations",
        Title = "Revision operations",
        UriTemplate = "nendo://application/revision/{revisionId}/operations{?cursor,limit}",
        MimeType = "application/json")]
    [Description("A bounded page of sanitized operation types, reversibility and affected semantic IDs for a revision. An operation an automatic action made carries attribution: the trigger, action and step IDs with their current display names, and the record event that fired it; null on the author's own operations. Ordered by operation ordinal; restart on NENDO_STALE_CURSOR. No raw operation payloads are exposed.")]
    public Task<string> GetRevisionOperationsAsync(string revisionId, string? cursor = null, string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetRevisionOperationsAsync(revisionId, cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.proposal",
        Title = "One proposal in full",
        UriTemplate = "nendo://application/proposal/{proposalId}",
        MimeType = "application/json")]
    [Description("One proposal in full, by the ID nendo://application/proposals or a validate result names: its semantic diff, diagnostics, package changes, behaviour and what the file would hold after acceptance, exactly what the person reads under Pending changes. Needs no lease, so a fresh session reads what its predecessor validated; changeSetId and owner say whose it is. state is live: a proposal whose captured definition revision the file has left reads stale, and one that was accepted reads active, with its title and diff while this host run holds them and from its receipt alone after a restart.")]
    public Task<string> GetProposalAsync(string proposalId, CancellationToken cancellationToken) =>
        TranslateAsync(async () =>
        {
            var preview = proposals.TryGet(proposalId) ?? proposals.TryGetAccepted(proposalId);
            if (preview is null)
            {
                try { preview = await projection.GetProposalAsync(proposalId, cancellationToken); }
                catch (NendoPreconditionException exception) when (exception.Code == "proposal-not-found")
                {
                    // Accepted before this host run, or by the person in Nendo: the Engine
                    // keeps the receipt, not the preview, so the answer is the receipt (F-261).
                    var accepted = await AcceptedFromReceiptAsync(proposalId, cancellationToken);
                    if (accepted is null) throw;
                    return accepted;
                }
            }
            if (preview.State != NendoProposalState.Previewable) return preview;
            // Accepted in Nendo while this adapter still held the preview: the receipt says so.
            if (await projection.GetProposalReceiptAsync(proposalId, cancellationToken) is { Revisions.Count: > 0 })
                return preview with { State = NendoProposalState.Active };
            var revision = await projection.GetDefinitionRevisionAsync(cancellationToken);
            return preview.CapturedDefinitionRevision == revision ? preview : preview with { State = NendoProposalState.Stale };
        });

    /// <summary>An accepted proposal of which only the receipt survives: active, with the digest and revision the acceptance committed.</summary>
    private async Task<NendoAgentProposalPreview?> AcceptedFromReceiptAsync(string proposalId, CancellationToken cancellationToken)
    {
        var receipt = await projection.GetProposalReceiptAsync(proposalId, cancellationToken);
        if (receipt is not { Revisions.Count: > 0 }) return null;
        return new NendoAgentProposalPreview(
            proposalId,
            "Accepted proposal; its title and diff were not kept past the host run that accepted it",
            NendoProposalState.Active,
            NendoProposalRetention.RetainUntilExplicitCleanup,
            receipt.DefinitionRevision,
            receipt.ChangeSetDigest,
            0,
            [],
            [],
            new NendoAgentPreviewSummary(null, 0, 0, [], []));
    }

    [McpServerResource(
        Name = "nendo.application.health",
        Title = "File health",
        UriTemplate = "nendo://application/health",
        MimeType = "application/json")]
    [Description("Sanitized lightweight health, durability state and the time and change sequence of the last integrity check. Reading status does not run a new integrity scan, so integrityResult describes the file as it stood at integrityChangeSequence: changesSinceIntegrityCheck and integrityStale say how far it has moved since. Call nendo.health.verify_integrity for a result measured now.")]
    public Task<string> GetHealthAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetHealthAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.extensions",
        Title = "Custom-view packages",
        UriTemplate = "nendo://application/extensions",
        MimeType = "application/json")]
    [Description("Every custom-view package the open file carries: its ID, title, version, entry point and each file's path, media type, SHA-256 and size. A package is definition, written through extension.setPackage and extension.putFile in a change set; read a file's content at nendo://application/extension/{packageId}/file?path=... with the path percent-encoded. A view that names a package runs its code in the Workbench when the view is shown.")]
    public Task<string> GetExtensionsAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetExtensionsAsync(cancellationToken));

    // W-094. The first sentence is the condition, because it is the one sentence describe's
    // reads index shows: an agent that is not writing a view's code has no reason to read on.
    [McpServerResource(
        Name = "nendo.application.view.api",
        Title = "Custom-view API",
        UriTemplate = "nendo://application/view-api",
        MimeType = "application/json")]
    [Description("Read this only while you write a custom view's code; nothing else needs it. window.nendo as this build serves it to a view's page: every method with its call, parameters and answer, the context and record shapes, the events, filter words, write values, toolbar kinds, icons and keys, theme tokens, limits and refusals, a whole view to start from, and how a person develops a package from a folder. Generated from the tables the view's API script is built from. Static for a host build; it does not describe the open file.")]
    public Task<string> GetViewApiAsync(CancellationToken cancellationToken) =>
        Task.FromResult(NendoViewApi.Json);

    [McpServerResource(
        Name = "nendo.application.extension.file",
        Title = "Custom-view package file",
        UriTemplate = "nendo://application/extension/{packageId}/file{?path,offset,length}",
        MimeType = "application/json")]
    [Description("One file of a custom-view package, a page of its bytes at a time. path is percent-encoded, so tiles/world.bin is sent as tiles%2Fworld.bin. A text file arrives as text and anything else as base64; offset and length are byte positions (length at most 131072, default the rest up to that), and nextOffset is null on the last page. sha256 and byteLength describe the whole file, so a reader can check what it assembled. To change a file, send extension.putFile with text or base64 in a change set; a file larger than one operation's payload arrives as a first putFile followed by putFile operations with append true.")]
    public Task<string> GetExtensionFileAsync(
        string packageId,
        string? path = null,
        string? offset = null,
        string? length = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetExtensionFileAsync(packageId, path, ByteNumber(offset, 0), ByteNumber(length, NendoResourceProjection.ExtensionFilePageBytes), cancellationToken));

    /// <summary>A byte position as a template variable delivers it: text, classified here like a page limit.</summary>
    private static long ByteNumber(string? value, long fallback) => value switch
    {
        null => fallback,
        _ when long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number) => number,
        _ => throw NendoMcpErrors.InvalidLimit(),
    };

    private const int DefaultPageLimit = 50;

    /// <summary>
    /// The SDK binds a template variable before any Nendo code runs, so a limit that
    /// was not an integer — <c>abc</c>, <c>1.5</c>, <c>2147483648</c>, an empty value —
    /// failed inside the binder and reached the client as an internal error carrying
    /// no code, while <c>0</c> and <c>101</c> were refused by name. The variable now
    /// arrives as text and is classified here, inside the translation, so every
    /// malformed limit is the same refusal as an out-of-range one.
    /// </summary>
    private static int PageLimit(string? limit) => limit switch
    {
        null => DefaultPageLimit,
        _ when int.TryParse(limit, NumberStyles.None, CultureInfo.InvariantCulture, out var value) => value,
        _ => throw NendoMcpErrors.InvalidLimit(),
    };

    /// <summary>A read that is already text: served as it is, with the same refusal translation.</summary>
    private static async Task<string> TranslateTextAsync(Func<Task<string>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception exception)
        {
            throw NendoMcpErrors.Translate(exception);
        }
    }

    private static async Task<ResourceContents> TranslateContentsAsync(Func<Task<ResourceContents>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception exception)
        {
            throw NendoMcpErrors.Translate(exception);
        }
    }

    private static async Task<string> TranslateAsync<T>(Func<Task<T>> action)
    {
        try
        {
            return JsonSerializer.Serialize(await action(), NendoMcpJson.Options);
        }
        catch (Exception exception)
        {
            throw NendoMcpErrors.Translate(exception);
        }
    }
}
