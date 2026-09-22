using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>One record type a validated proposal leaves behind.</summary>
public sealed record NendoAgentPreviewEntity(
    string EntityId,
    string DisplayName,
    int FieldCount,
    int RecordCount)
{
    public bool Retired { get; init; }
}

/// <summary>
/// One compiled screen a validated proposal leaves behind, named so the review
/// panel can say what it is asking someone to approve.
/// </summary>
/// <param name="EntityId">
/// The record type this surface is about, or null for the file's front page: an
/// <c>overviewSurface</c> belongs to the file, and each tile under it names the
/// record type it reads.
/// </param>
/// <param name="Shape">
/// What this surface would draw, where its kind has a size worth knowing before
/// accepting it: a matrix's rows and columns, or the number of columns a board
/// would have. Null where the kind has no such size. Listing a matrix by title
/// alone asks someone to approve a screen without saying whether it is nine cells
/// or forty-five, and a board whose lanes come from a record type holding nothing
/// says so here rather than after acceptance, when it draws empty.
/// </param>
public sealed record NendoAgentPreviewSurface(
    string NodeId,
    string Kind,
    string? Title,
    string? EntityId)
{
    public string? Shape { get; init; }
}

/// <summary>
/// What the file holds once this proposal is accepted. The previous shape was one
/// entity name and four contract version 2 slot titles, so a version 3 proposal
/// described itself as a single unnamed record type with no screens, and a
/// five-record-type proposal reported zero fields and zero records.
/// <para>
/// <paramref name="Scope"/> is stated because the counts previously mixed two.
/// Entities came from the compiled screens and records from the whole file, so a
/// schema-only change set — which adds no screen — previewed as entirely empty
/// while its diff described every one of its operations, and a populated preview
/// counted fields over three record types and records over four. Every count here
/// is now taken over the validated clone: the whole file as it would stand.
/// </para>
/// </summary>
public sealed record NendoAgentPreviewSummary(
    int? ContractVersion,
    int FieldCount,
    int RecordCount,
    IReadOnlyList<NendoAgentPreviewEntity> Entities,
    IReadOnlyList<NendoAgentPreviewSurface> Surfaces)
{
    public string Scope { get; init; } = "wholeFileAfterChange";

    /// <summary>The minimum host version the file requires now.</summary>
    public string? MinimumHostVersionBefore { get; init; }

    /// <summary>
    /// The minimum host version the file would require after acceptance. A
    /// different value is a durable compatibility change and carries its own
    /// <c>raiseMinimumHostVersion</c> entry in the semantic diff.
    /// </summary>
    public string? MinimumHostVersionAfter { get; init; }

    /// <summary>What the file says it is for now, or null if it has never said.</summary>
    public string? PurposeBefore { get; init; }

    /// <summary>
    /// What it would say after acceptance. Named here rather than left to be discovered:
    /// this summary lists record types and surfaces, and the purpose is neither, so a
    /// proposal that only says what the file is for would otherwise be reviewed as changing
    /// nothing at all — the mistake the front page taught.
    /// </summary>
    public string? PurposeAfter { get; init; }
}

public sealed record NendoAgentProposalPreview(
    string ProposalId,
    string Title,
    NendoProposalState State,
    NendoProposalRetention Retention,
    long CapturedDefinitionRevision,
    string OperationDigest,
    int OperationCount,
    IReadOnlyList<NendoCompilerDiagnostic> Diagnostics,
    IReadOnlyList<NendoSemanticDiffEntry> SemanticDiff,
    NendoAgentPreviewSummary Preview);

public sealed record NendoAgentProposalSummary(
    string ProposalId,
    string Title,
    NendoProposalState State,
    string OperationDigest,
    int OperationCount,
    long CapturedDefinitionRevision,
    int DiagnosticCount,
    NendoReversibilityClass Reversibility);

public sealed class NendoAgentProposalStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private string? _applicationId;
    private string? _instanceId;

    internal void Bind(string applicationId, string instanceId)
    {
        lock (_gate)
        {
            if (_applicationId is null)
            {
                _applicationId = applicationId;
                _instanceId = instanceId;
                return;
            }
            if (_applicationId != applicationId || _instanceId != instanceId)
            {
                throw new InvalidOperationException(
                    "Agent proposal review state belongs to a different open file session.");
            }
        }
    }

    /// <summary>
    /// One-way notification that a validated proposal has joined the queue, carrying
    /// how many are now waiting.
    /// <para>
    /// For trusted host adapters only, and called synchronously off the agent's own
    /// request: a handler must queue work rather than do it here, and must never wait
    /// on this store or the coordinator behind it. It exists because the person who
    /// has to accept a proposal is the one part of this loop with nothing polling for
    /// them once the Agent view is not on screen.
    /// </para>
    /// </summary>
    public event Action<int>? ProposalAdded;

    internal void Add(
        string changeSetId,
        string hostRunId,
        string sessionId,
        NendoProposalPreview preview)
    {
        ArgumentNullException.ThrowIfNull(preview);
        int pending;
        lock (_gate)
        {
            RequireBound(preview);
            _entries.Add(
                preview.ProposalId,
                new Entry(changeSetId, hostRunId, sessionId, preview));
            pending = _entries.Count;
        }
        // Raised outside the lock: a handler that blocked here would hold every other
        // caller of this store behind whatever it was doing.
        ProposalAdded?.Invoke(pending);
    }

    internal NendoAgentProposalPreview GetOwned(
        string changeSetId,
        string hostRunId,
        string sessionId) =>
        TryGetOwned(changeSetId, hostRunId, sessionId)
            ?? throw new NendoAgentAuthoringException(
                "CHANGE_SET_NOT_FOUND",
                "The change set is not owned by this agent session.");

    /// <summary>
    /// The validated proposal a change set became, when this session owns one. A
    /// change set leaves the draft table the moment it validates, so an agent that
    /// then sent it more operations was told it did not exist.
    /// </summary>
    internal NendoAgentProposalPreview? TryGetOwned(
        string changeSetId,
        string hostRunId,
        string sessionId)
    {
        lock (_gate)
        {
            var entry = _entries.Values.SingleOrDefault(value =>
                value.ChangeSetId == changeSetId &&
                value.HostRunId == hostRunId &&
                value.SessionId == sessionId);
            return entry is null ? null : ProjectPreview(entry.Preview);
        }
    }

    internal NendoProposalPreview RemoveOwned(
        string changeSetId,
        string hostRunId,
        string sessionId)
    {
        lock (_gate)
        {
            var pair = _entries.SingleOrDefault(value =>
                value.Value.ChangeSetId == changeSetId &&
                value.Value.HostRunId == hostRunId &&
                value.Value.SessionId == sessionId);
            if (pair.Value is null)
            {
                throw new NendoAgentAuthoringException(
                    "CHANGE_SET_NOT_FOUND",
                    "The change set is not owned by this agent session.");
            }
            _entries.Remove(pair.Key);
            return pair.Value.Preview;
        }
    }

    public IReadOnlyList<NendoAgentProposalSummary> Snapshot()
    {
        lock (_gate)
        {
            return _entries.Values
                .Select(value => ProjectSummary(value.Preview))
                .OrderBy(value => value.Title, StringComparer.Ordinal)
                .ThenBy(value => value.ProposalId, StringComparer.Ordinal)
                .ToArray();
        }
    }

    public NendoAgentProposalPreview Get(string proposalId)
    {
        lock (_gate)
        {
            return ProjectPreview(RequireEntry(proposalId).Preview);
        }
    }

    /// <summary>
    /// What a pending proposal has to do with a semantic ID the file does not
    /// hold. An agent that has just validated a change set and then writes to the
    /// record type it creates gets "the entity does not exist", which reads as a
    /// bad identifier and invites the wrong repair. The likely cause is that the
    /// proposal is still waiting for a person, and the host already knows that.
    /// </summary>
    internal string? PendingCause(params string?[] semanticIds)
    {
        var wanted = semanticIds
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!)
            .ToHashSet(StringComparer.Ordinal);
        Entry[] pending;
        lock (_gate)
        {
            pending = _entries.Values.ToArray();
        }
        if (pending.Length == 0) return null;

        var named = pending
            .Where(entry => entry.Preview.SemanticDiff.Any(change => change.SemanticIds.Any(wanted.Contains)))
            .OrderBy(entry => entry.Preview.Title, StringComparer.Ordinal)
            .FirstOrDefault();
        return named is not null
            ? $"A validated proposal that changes this ID is waiting for someone to accept it in Nendo: " +
              $"\"{named.Preview.Title}\" ({named.Preview.ProposalId}). Definition changes reach the file only on " +
              "acceptance, so a write that depends on one fails until then. There is no promotion tool; ask the person " +
              "to accept it, or reject it with nendo.change_set.reject."
            : $"{pending.Length} validated {(pending.Length == 1 ? "proposal is" : "proposals are")} waiting for " +
              "someone to accept them in Nendo. If this write depends on a definition change one of them makes, it " +
              "fails until that proposal is accepted.";
    }

    public async Task<NendoPromotionOutcome> PromoteAsync(
        NendoApplicationService application,
        string proposalId,
        CancellationToken cancellationToken = default,
        string? expectedOperationDigest = null)
    {
        await RequireMatchingFileAsync(application, cancellationToken);
        _ = Get(proposalId);
        var outcome = await application.PromoteProposalAsync(proposalId, cancellationToken, expectedOperationDigest);
        if (outcome.Applied)
        {
            Remove(proposalId);
        }
        else
        {
            // Retain the host review and its current diagnostics when promotion
            // did not commit. A successful RPC is not acceptance of a proposal.
            var preview = await application.GetProposalAsync(proposalId, cancellationToken);
            lock (_gate)
            {
                if (_entries.TryGetValue(proposalId, out var entry))
                    _entries[proposalId] = entry with { Preview = preview };
            }
        }
        return outcome;
    }

    public async Task<NendoPromotionOutcome> RejectAsync(
        NendoApplicationService application,
        string proposalId,
        CancellationToken cancellationToken = default)
    {
        await RequireMatchingFileAsync(application, cancellationToken);
        _ = Get(proposalId);
        var outcome = await application.RejectProposalAsync(proposalId, cancellationToken);
        Remove(proposalId);
        return outcome;
    }

    public async Task CloseFileSessionAsync(
        NendoApplicationService application,
        CancellationToken cancellationToken = default)
    {
        string[] proposalIds;
        lock (_gate)
        {
            proposalIds = _entries.Keys.ToArray();
        }
        foreach (var proposalId in proposalIds)
        {
            try
            {
                await application.RejectProposalAsync(proposalId, cancellationToken);
            }
            finally
            {
                Remove(proposalId);
            }
        }
        lock (_gate)
        {
            _applicationId = null;
            _instanceId = null;
        }
    }

    private void RequireBound(NendoProposalPreview preview)
    {
        if (_applicationId is null ||
            _applicationId != preview.SourceApplicationId ||
            _instanceId != preview.SourceInstanceId)
        {
            throw new InvalidOperationException(
                "The proposal does not belong to the bound open file session.");
        }
    }

    private Entry RequireEntry(string proposalId)
    {
        if (string.IsNullOrWhiteSpace(proposalId) || !_entries.TryGetValue(proposalId, out var entry))
        {
            throw new NendoPreconditionException(
                "proposal-not-found",
                "The pending agent proposal does not exist.");
        }
        return entry;
    }

    private void Remove(string proposalId)
    {
        lock (_gate)
        {
            _entries.Remove(proposalId);
        }
    }

    private async Task RequireMatchingFileAsync(
        NendoApplicationService application,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(application);
        var snapshot = await application.GetSnapshotAsync(cancellationToken);
        lock (_gate)
        {
            if (_applicationId != snapshot.Manifest.ApplicationId ||
                _instanceId != snapshot.Manifest.InstanceId)
            {
                throw new NendoPreconditionException(
                    "proposal-file-mismatch",
                    "The pending proposal belongs to a different open file session.");
            }
        }
    }

    internal static NendoAgentProposalSummary ProjectSummary(NendoProposalPreview preview) => new(
        preview.ProposalId,
        preview.Title,
        preview.State,
        preview.OperationDigest,
        preview.OperationCount,
        preview.CapturedDefinitionRevision,
        preview.Diagnostics.Count,
        preview.SemanticDiff.Count == 0
            ? NendoReversibilityClass.Reversible
            : preview.SemanticDiff
                .OrderByDescending(value => value.Reversibility)
                .First()
                .Reversibility);

    internal static NendoAgentProposalPreview ProjectPreview(NendoProposalPreview preview) => new(
        preview.ProposalId,
        preview.Title,
        preview.State,
        preview.Retention,
        preview.CapturedDefinitionRevision,
        preview.OperationDigest,
        preview.OperationCount,
        preview.Diagnostics.ToArray(),
        preview.SemanticDiff.ToArray(),
        Summarize(preview));

    private static NendoAgentPreviewSummary Summarize(NendoProposalPreview preview)
    {
        var applications = preview.PreviewApplications;
        // Record types come from the validated clone, screens from what compiled
        // against it. A change set that adds a record type and no screen is then
        // described by what it adds rather than by the screens it does not.
        var entities = preview.PreviewEntities
            .Select(entity => new NendoAgentPreviewEntity(
                entity.EntityId,
                entity.DisplayName,
                entity.FieldCount,
                entity.RecordCount) { Retired = entity.Retired })
            .ToArray();
        // The front page is not one of the applications, because it belongs to the
        // file rather than to a record type. Left out here, a proposal that adds one
        // is reviewed as adding no screen at all: the diff names it and this summary
        // did not, which is the two of them disagreeing about the same change set.
        var surfaces = applications.SelectMany(app => SurfacesOf(app, applications))
            .Concat(preview.PreviewOverview is null
                ? []
                : [Describe(preview.PreviewOverview.Surface, null, null, applications)])
            .ToArray();
        return new NendoAgentPreviewSummary(
            applications.Count == 0 ? null : applications[0].ContractVersion,
            entities.Sum(entity => entity.FieldCount),
            entities.Sum(entity => entity.RecordCount),
            entities,
            surfaces)
        {
            MinimumHostVersionBefore = preview.MinimumHostVersionBefore,
            MinimumHostVersionAfter = preview.MinimumHostVersionAfter,
            PurposeBefore = preview.PurposeBefore,
            PurposeAfter = preview.PurposeAfter,
        };
    }

    private static IEnumerable<NendoAgentPreviewSurface> SurfacesOf(NendoApplicationPlan app, IReadOnlyList<NendoApplicationPlan> applications)
    {
        var entityId = app.Entity.SemanticId;
        foreach (var root in app.Surfaces)
        {
            yield return Describe(root, entityId, app, applications);
            // A command may sit inside a record page rather than stand alone, and
            // it is still a button this proposal adds. List it wherever it is, or
            // the review names everything except the thing that writes.
            foreach (var nested in Nested(root).Where(node => node.Kind == "recordCommand"))
            {
                yield return Describe(nested, entityId, app, applications);
            }
        }
    }

    private static NendoAgentPreviewSurface Describe(
        NendoSurfaceNodePlan node,
        string? entityId,
        NendoApplicationPlan? app,
        IReadOnlyList<NendoApplicationPlan> applications) => new(
        node.SemanticId,
        node.Kind,
        node.Properties.TryGetValue("title", out var title) && title.ValueKind == JsonValueKind.String
            ? title.GetString()
            : node.Properties.TryGetValue("label", out var label) && label.ValueKind == JsonValueKind.String
                ? label.GetString()
                : null,
        entityId)
    {
        Shape = ShapeOf(node, app, applications),
    };

    /// <summary>
    /// The size of a surface whose size is the thing a reviewer cannot guess. A matrix
    /// crosses two closed groupings and its cell count follows from them; a board's
    /// columns follow from whatever it groups by, and a board grouped by a reference
    /// draws one column per record of the target type — none at all when that type is
    /// still empty, which is worth knowing before accepting rather than after.
    /// </summary>
    private static string? ShapeOf(NendoSurfaceNodePlan node, NendoApplicationPlan? app, IReadOnlyList<NendoApplicationPlan> applications)
    {
        if (app is null) return null;
        switch (node.Kind)
        {
            case "matrixSurface":
                if (GroupCount(app, Property(node, "rowByFieldId")) is not { } rows) return null;
                if (GroupCount(app, Property(node, "columnByFieldId")) is not { } columns) return null;
                return $"{rows} rows by {columns} columns, {rows * columns} cells";
            case "boardSurface":
                var grouping = Field(app, Property(node, "groupByFieldId"));
                if (grouping?.Reference is { } reference)
                {
                    var target = applications.FirstOrDefault(other => other.Entity.SemanticId == reference.TargetEntityId);
                    if (target is null) return null;
                    // "per {name} record" reads the same whether the person named the type
                    // Account or Initiatives; "per Initiatives, 6 of them" did not (W-044).
                    return target.Records.Count == 0
                        ? $"one column per {target.Entity.DisplayName} record, and there are none yet, so it would draw nothing"
                        : $"one column per {target.Entity.DisplayName} record, {target.Records.Count} of them";
                }
                return GroupCount(app, Property(node, "groupByFieldId")) is { } lanes ? $"{lanes} columns" : null;
            default:
                return null;
        }
    }

    private static string? Property(NendoSurfaceNodePlan node, string name) =>
        node.Properties.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static NendoFieldPlan? Field(NendoApplicationPlan app, string? fieldId) =>
        fieldId is null ? null : app.Entity.Fields.FirstOrDefault(field => field.SemanticId == fieldId);

    /// <summary>
    /// How many groups a field yields, for the two kinds that have a closed answer. A
    /// count is only stated where it is exact, because a guessed size is worse in a
    /// review than none.
    /// </summary>
    private static int? GroupCount(NendoApplicationPlan app, string? fieldId) => Field(app, fieldId) switch
    {
        { StorageKind: NendoStorageKind.Boolean } => 2,
        { Presentation: "singleChoice", Options.Count: > 0 } field => field.Options.Count,
        _ => null,
    };

    private static IEnumerable<NendoSurfaceNodePlan> Nested(NendoSurfaceNodePlan node) =>
        node.Children.Concat(node.Children.SelectMany(Nested));

    private sealed record Entry(
        string ChangeSetId,
        string HostRunId,
        string SessionId,
        NendoProposalPreview Preview);
}

internal sealed class NendoAgentAuthoringException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
