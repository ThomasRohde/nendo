using System.Globalization;
using System.Text.Json;
using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

[McpServerResourceType]
internal sealed class NendoMcpResources(
    NendoResourceProjection projection,
    NendoAgentProposalStore proposals,
    NendoDiscoveryStore discovery,
    NendoHostAuthority hostAuthority)
{
    [McpServerResource(
        Name = "nendo.host.instances",
        UriTemplate = "nendo://host/instances",
        MimeType = "application/json")]
    [Description("Every Nendo running on this device and which file each has open, with isThisOne marking the host answering the read. The only resource here that is not about the open file: use it to say which file you are connected to before writing, because every other call in this session acts on that one. Each entry carries the file's name and never a path. Switching is the person's action — a client reaches the address it was registered with and cannot redirect itself mid-session — so this tells you what to say to them, not somewhere else to write.")]
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
        UriTemplate = "nendo://application/manifest",
        MimeType = "application/json")]
    [Description("Identity and semantic revision counters for the open Nendo application.")]
    public Task<string> GetManifestAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetManifestAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.vocabulary",
        UriTemplate = "nendo://application/vocabulary",
        MimeType = "application/json")]
    [Description("Everything this host accepts from an authoring client: every node kind with its permitted properties, required properties, permitted children and how many roots of it one record type may own; the closed filter operators, value kinds, ordering directions and aggregates; how sibling filter clauses combine; the authoring limits; and operations — every canonical operation type with the payload fields it requires and accepts. Generated from the tables the compiler and the authoring boundary validate against, so authoring does not require probing, and a documented field is an accepted field. Static for a host build; it does not describe the open file.")]
    public Task<string> GetVocabularyAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => Task.FromResult(Nendo.Engine.NendoSemanticVocabulary.Description() with
        {
            Operations = NendoAuthoringOperations.All,
        }));

    [McpServerResource(
        Name = "nendo.application.describe",
        UriTemplate = "nendo://application/describe",
        MimeType = "application/json")]
    [Description("The whole open application in one read: identity and revision counters, the authoring limits to plan batches against, every record type with its fields and references, every compiled screen, current health, and reads — every resource URI this host serves, including the templated ones that resources/list does not return. Equivalent to manifest plus entities plus one schema read per record type plus surfaces plus health, without the round trips. Read a record back at nendo://application/entity/{entityId}/records.")]
    public Task<string> GetDescriptionAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetDescriptionAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.examples",
        UriTemplate = "nendo://application/examples",
        MimeType = "application/json")]
    [Description("Complete contract version 3 change sets that can be sent as they stand, each carrying the authoring rule it exists to convey: creating a record type with its required fields, configuring a reference, building a record page with a section, a related list and an exact rollup, and defining a multi-step command. Static for a host build; it does not describe the open file. Every example is exercised against the real authoring boundary by this host's test suite.")]
    public Task<string> GetExamplesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => Task.FromResult(NendoAuthoringExamples.Description()));

    [McpServerResource(
        Name = "nendo.application.entities",
        UriTemplate = "nendo://application/entities",
        MimeType = "application/json")]
    [Description("Stable semantic entities in the open Nendo application.")]
    public Task<string> GetEntitiesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetEntitiesAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.schema",
        UriTemplate = "nendo://application/entity/{entityId}/schema",
        MimeType = "application/json")]
    [Description("The semantic field schema for one entity. storageKind reads back camelCase and is matched case-insensitively on write. options is the authoritative ordered set of stable choice IDs for a singleChoice field; choices carries display metadata only for the options given it by schema.setChoiceMetadata, so it is empty until one is; each entry names the option's tone, or null for no colour. scale carries a rating field's min and max, and is null for every other presentation.")]
    public Task<string> GetSchemaAsync(string entityId, CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetSchemaAsync(entityId, cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.records",
        UriTemplate = "nendo://application/entity/{entityId}/records{?cursor,limit}",
        MimeType = "application/json")]
    [Description("A bounded page of records in stable record-ID order. numericLexemes preserves exact numeric strings by field ID; use these with $nendoNumber envelopes when editing, not lossy numeric parsers. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetRecordsAsync(
        string entityId,
        string? cursor = null,
        string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetRecordsAsync(entityId, cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.entity.export",
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
        UriTemplate = "nendo://application/proposals",
        MimeType = "application/json")]
    [Description("Every validated proposal waiting for a person to accept it in Nendo, with its title, the definition revision it captured, its state, how many operations it carries and the most severe reversibility class in it. Read this after a reconnect or a lost response: a pending proposal is otherwise invisible, and each one captured a revision, so accepting any one of them advances that revision and invalidates the rest. A proposal is accepted or rejected by the person in Nendo; there is no promotion tool.")]
    public Task<string> GetProposalsAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => Task.FromResult(proposals.Snapshot()));

    [McpServerResource(
        Name = "nendo.application.surfaces",
        UriTemplate = "nendo://application/surfaces",
        MimeType = "application/json")]
    [Description("Every compiled screen in the open file, or the diagnostics that stop them compiling. Contract version 3 files describe themselves under applications[].surfaces as an ordered node tree; the form/list/board/command slots beside it are the version 1 and 2 shape and stay null for a version 3 file. A recordCommand root carries the commandId that nendo.data.execute_command takes. state is valid, invalid or noCustomSurfaces; a file with no custom screens is a deliberate shape, not a broken definition.")]
    public Task<string> GetSurfacesAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetSurfacesAsync(cancellationToken));

    [McpServerResource(
        Name = "nendo.application.history",
        UriTemplate = "nendo://application/history{?cursor,limit}",
        MimeType = "application/json")]
    [Description("Bounded revision summaries in ascending sequence order, with operation counts and paged operations URIs. A file change invalidates continuation; restart on NENDO_STALE_CURSOR.")]
    public Task<string> GetHistoryAsync(
        string? cursor = null,
        string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetHistoryAsync(cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.revision.operations",
        UriTemplate = "nendo://application/revision/{revisionId}/operations{?cursor,limit}",
        MimeType = "application/json")]
    [Description("A bounded page of sanitized operation types, reversibility and affected semantic IDs for a revision. Ordered by operation ordinal; restart on NENDO_STALE_CURSOR. No raw operation payloads are exposed.")]
    public Task<string> GetRevisionOperationsAsync(string revisionId, string? cursor = null, string? limit = null,
        CancellationToken cancellationToken = default) =>
        TranslateAsync(() => projection.GetRevisionOperationsAsync(revisionId, cursor, PageLimit(limit), cancellationToken));

    [McpServerResource(
        Name = "nendo.application.health",
        UriTemplate = "nendo://application/health",
        MimeType = "application/json")]
    [Description("Sanitized lightweight health, durability state and the time and change sequence of the last integrity check. Reading status does not run a new integrity scan, so integrityResult describes the file as it stood at integrityChangeSequence: changesSinceIntegrityCheck and integrityStale say how far it has moved since. Call nendo.health.verify_integrity for a result measured now.")]
    public Task<string> GetHealthAsync(CancellationToken cancellationToken) =>
        TranslateAsync(() => projection.GetHealthAsync(cancellationToken));

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
