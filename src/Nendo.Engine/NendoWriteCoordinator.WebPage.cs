using System.Text.Json;

namespace Nendo.Engine;

/// <summary>A revision of a web page's working file that Apply changes left out, and why (ADR-0035).</summary>
public sealed record NendoWebPageLeftOut(string RevisionId, DateTimeOffset CreatedAt, string Description, string Reason);

/// <summary>
/// What Apply changes from a web page prepared (ADR-0035): the proposal that replays the page's
/// revisions, or null when none is left to replay; how many revisions it replays; how many this
/// file already holds from an earlier Apply; and the revisions it left out.
/// </summary>
public sealed record NendoWebPageChanges(
    string WorkingFileName,
    NendoProposalPreview? Proposal,
    int Replayed,
    int AlreadyApplied,
    IReadOnlyList<NendoWebPageLeftOut> LeftOut);

public sealed partial class NendoWriteCoordinator
{
    /// <summary>The origin of every revision Apply changes from a web page commits.</summary>
    public const string WebPageOrigin = "host.web-page";

    /// <summary>How many times a refused replay is prepared again without the revision refused.</summary>
    private const int WebPagePasses = 16;

    /// <summary>
    /// Prepares the changes made in a web page exported from this file as one proposal (ADR-0035).
    /// <para>
    /// The working file must be of this application and descend from this file: a Duplicate of it,
    /// whose identity transition names this file's instance. Its revisions after that transition are
    /// the page's. Each becomes one mutation of the author's own operations, at the record versions
    /// it was written at; the page's automatic effects are left for this file's own actions to make
    /// again, as they would for any proposal. A revision whose records this file changed since the
    /// export, or that follows one left out, is left out and named, and so is one this file's own
    /// validation refuses. Nothing is applied here: the proposal waits for the person to accept it.
    /// </para>
    /// </summary>
    public async Task<NendoWebPageChanges> PrepareWebPageChangesAsync(string workingFilePath, CancellationToken cancellationToken = default)
    {
        var name = Path.GetFileName(ValidatePath(workingFilePath));
        var active = (await GetDefinitionSnapshotAsync(cancellationToken)).Manifest;
        var activeHistory = await GetHistoryAsync(cancellationToken);
        await using var page = await OpenReadOnlyAsync(workingFilePath, cancellationToken);
        var pageManifest = (await page.GetDefinitionSnapshotAsync(cancellationToken)).Manifest;
        if (pageManifest.ApplicationId != active.ApplicationId)
            throw new NendoPreconditionException("web-page-other-application",
                $"{name} is a file of another application, so its changes cannot be applied to {FileName}.");
        var pageHistory = await page.GetHistoryAsync(cancellationToken);

        // The page's own copy names the file it was exported from, and where that file stood then.
        var export = pageHistory
            .Where(revision => revision.Operations is [{ OperationType: "identity.transition" }])
            .Select(revision => (Revision: revision, Transition: IdentityTransitionOperation.ParseCanonical(revision.Operations[0].CanonicalJson)))
            .LastOrDefault(pair => pair.Transition.Kind == NendoIdentityCopyKind.Duplicate &&
                pair.Transition.Source.InstanceId == active.InstanceId &&
                pair.Transition.ResultInstanceId == pageManifest.InstanceId);
        if (export.Revision is null)
            throw new NendoPreconditionException("web-page-not-exported-here", $"{name} was not exported from {FileName}.");
        var exportedAt = export.Transition.Source.ChangeSequence;
        var activeAtExport = activeHistory.SingleOrDefault(revision => revision.ChangeSequence == exportedAt);
        var pageAtExport = pageHistory.SingleOrDefault(revision => revision.ChangeSequence == exportedAt);
        if (active.ChangeSequence < exportedAt ||
            activeAtExport is not null && pageAtExport is not null && activeAtExport.RevisionId != pageAtExport.RevisionId)
            throw new NendoPreconditionException("web-page-not-exported-here",
                $"{name} was exported from {FileName} as it was before it was restored or replaced, so its changes cannot be applied.");

        var pageRevisions = pageHistory.Where(revision => revision.ChangeSequence > export.Revision.ChangeSequence)
            .OrderBy(revision => revision.ChangeSequence).ToArray();
        if (pageRevisions.Length == 0)
            throw new NendoPreconditionException("web-page-no-changes", $"{name} holds no changes made since it was exported.");

        // What this file did since the export, apart from what an earlier Apply brought from this page.
        var scope = $"{WebPageOrigin}/{pageManifest.InstanceId}";
        var sinceExport = activeHistory.Where(revision => revision.ChangeSequence > exportedAt).ToArray();
        var applied = sinceExport.Where(revision => revision.IdempotencyScope == scope)
            .Select(revision => revision.IdempotencyKey).ToHashSet(StringComparer.Ordinal);
        var ownChanges = sinceExport.Where(revision => revision.IdempotencyScope != scope).ToArray();
        var movedHere = new TouchedKeys(ownChanges.SelectMany(revision => revision.Operations));
        var designChangedHere = ownChanges.Any(revision => revision.Lane == NendoRevisionLane.Definition);
        // The identity transition advanced the page's definition revision, so an operation that
        // names the revision it expects names one more than this file had.
        var definitionOffset = export.Revision.DefinitionRevisionAfter - export.Transition.Source.DefinitionRevision;

        var leftOut = new List<NendoWebPageLeftOut>();
        var poisoned = new TouchedKeys([]);
        var designLeftOut = designChangedHere;
        var candidates = new List<(NendoRevisionSnapshot Revision, NendoMutation Mutation, TouchedKeys Touched)>();
        var alreadyApplied = 0;
        void LeaveOut(NendoRevisionSnapshot revision, TouchedKeys touched, string reason)
        {
            leftOut.Add(new(revision.RevisionId, revision.CreatedAt, revision.Description, reason));
            poisoned.Add(touched);
            if (revision.Lane == NendoRevisionLane.Definition) designLeftOut = true;
        }
        foreach (var revision in pageRevisions)
        {
            if (applied.Contains(revision.RevisionId)) { alreadyApplied++; continue; }
            var touched = new TouchedKeys(revision.Operations);
            var reason = revision.Lane == NendoRevisionLane.Definition && designLeftOut
                ? designChangedHere
                    ? $"The application's design changed in {FileName} since the export."
                    : "It follows a design change that was left out."
                : touched.Meets(movedHere) ? $"Its records changed in {FileName} since the export."
                : touched.Meets(poisoned) ? "It follows a change to the same records that was left out."
                : null;
            if (reason is null)
            {
                try
                {
                    candidates.Add((revision, await ReplayMutationAsync(revision, scope, definitionOffset, page, cancellationToken), touched));
                    continue;
                }
                catch (NendoException refusal) { reason = refusal.Message; }
            }
            LeaveOut(revision, touched, reason);
        }

        for (var pass = 0; pass < WebPagePasses; pass++)
        {
            if (candidates.Count == 0) return new(name, null, 0, alreadyApplied, leftOut);
            var proposalId = $"proposal-{Guid.NewGuid():N}";
            var preview = await BeginProposalAsync(proposalId, $"Changes from {name}", WebPageOrigin,
                new NendoChangeSet(candidates.Select(candidate => candidate.Mutation).ToArray()), cancellationToken);
            if (preview.State == NendoProposalState.Previewable)
                return new(name, await NoteLeftOutAsync(proposalId, leftOut, cancellationToken), candidates.Count, alreadyApplied, leftOut);
            await RejectProposalAsync(proposalId, cancellationToken);
            // This file's validation refused one revision: it is left out with the reason given, as is
            // everything after it that wrote the same records, and the rest is prepared again.
            var refused = preview.Diagnostics.FirstOrDefault(diagnostic => diagnostic.OperationId is not null);
            var at = refused is null ? -1 : candidates.FindIndex(candidate =>
                candidate.Mutation.Operations.Any(operation => operation.OperationId == refused.OperationId));
            if (at < 0)
                throw new NendoPreconditionException("web-page-changes-refused",
                    $"{FileName} refused the changes from {name}. {preview.Diagnostics.FirstOrDefault()?.Message}".TrimEnd());
            LeaveOut(candidates[at].Revision, candidates[at].Touched, refused!.Code == "NPROP008"
                ? $"Its records changed in {FileName} since the export."
                : refused.Message);
            var rest = candidates.Skip(at + 1).ToArray();
            candidates.RemoveRange(at, candidates.Count - at);
            foreach (var candidate in rest)
            {
                if (candidate.Revision.Lane == NendoRevisionLane.Definition && designLeftOut)
                    LeaveOut(candidate.Revision, candidate.Touched, "It follows a design change that was left out.");
                else if (candidate.Touched.Meets(poisoned))
                    LeaveOut(candidate.Revision, candidate.Touched, "It follows a change to the same records that was left out.");
                else candidates.Add(candidate);
            }
        }
        throw new NendoPreconditionException("web-page-changes-refused",
            $"{FileName} refused too many of the changes from {name} to prepare them. Apply them in Nendo by hand.");
    }

    /// <summary>The left-out revisions travel with the proposal, so its review names them.</summary>
    private async Task<NendoProposalPreview> NoteLeftOutAsync(string proposalId, IReadOnlyList<NendoWebPageLeftOut> leftOut, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var context = GetProposal(proposalId);
            if (leftOut.Count > 0)
            {
                context.Diagnostics = [.. context.Diagnostics, .. leftOut.Select(revision => new NendoCompilerDiagnostic(
                    "NPROP013", NendoDiagnosticSeverity.Warning,
                    $"Left out: {revision.Description} ({revision.CreatedAt:yyyy-MM-dd HH:mm}). {revision.Reason}",
                    null, null, "Make this change again in Nendo if it is still wanted."))];
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
            }
            return PreviewOf(context);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// One page revision as a mutation of the operations its author made, each rebuilt from what
    /// the page stored and checked to be the same operation.
    /// </summary>
    private static async Task<NendoMutation> ReplayMutationAsync(
        NendoRevisionSnapshot revision, string scope, long definitionOffset, NendoWriteCoordinator page, CancellationToken cancellationToken)
    {
        var operations = new List<NendoOperation>();
        foreach (var stored in revision.Operations.Where(operation => operation.Attribution is null))
            operations.Add(await ReplayOperationAsync(stored, definitionOffset, page, cancellationToken));
        if (operations.Count == 0)
            throw new NendoPreconditionException("web-page-unreplayable", "It holds only changes the page's automatic actions made.");
        return new NendoMutation(scope, revision.RevisionId, WebPageOrigin, revision.Description, operations).Validate();
    }

    private static async Task<NendoOperation> ReplayOperationAsync(
        NendoStoredOperationSnapshot stored, long definitionOffset, NendoWriteCoordinator page, CancellationToken cancellationToken)
    {
        using var document = JsonDocument.Parse(stored.CanonicalJson);
        var payload = document.RootElement.GetProperty("payload");
        string? Text(string property) => payload.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        NendoOperation rebuilt;
        try
        {
            rebuilt = stored.OperationType switch
            {
                // A picture's bytes are in the page's file beside the operation, never in it.
                "media.put" => PutMediaOperation.FromContent(stored.OperationId,
                    await page.ReadMediaContentAsync(Text("sha256")!, cancellationToken)
                        ?? throw new NendoPreconditionException("web-page-unreplayable", "Its picture is not in the page's file."),
                    Text("mediaType"), Text("name")),
                "extension.setState" => new SetExtensionStateOperation(stored.OperationId, Text("packageId")!, Text("viewId") ?? "",
                    Text("key")!, payload.GetProperty("value") is { ValueKind: not JsonValueKind.Null } value ? value.GetRawText() : null,
                    payload.TryGetProperty("expectedVersion", out var expected) ? expected.GetInt64() : null),
                "identity.transition" or "data.restoreDeletedRecord" or "schema.removeChoice" =>
                    throw new NendoPreconditionException("web-page-unreplayable", $"Nendo does not apply a {stored.OperationType} change from a web page."),
                _ => Compile(stored.OperationId, stored.OperationType, payload),
            };
        }
        catch (NendoValidationException refusal)
        {
            throw new NendoPreconditionException("web-page-unreplayable", $"Its {stored.OperationType} change cannot be replayed: {refusal.Message}");
        }
        if (rebuilt.CanonicalJson() != stored.CanonicalJson)
            throw new NendoPreconditionException("web-page-unreplayable", $"Its {stored.OperationType} change cannot be replayed exactly.");
        if (definitionOffset == 0 || !payload.TryGetProperty("expectedDefinitionRevision", out var revision) || revision.ValueKind != JsonValueKind.Number)
            return rebuilt;
        // The same operation, expecting the definition revision this file is at.
        var shifted = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject()) shifted[property.Name] = property.Value;
        shifted["expectedDefinitionRevision"] = JsonSerializer.SerializeToElement(revision.GetInt64() - definitionOffset);
        return Compile(stored.OperationId, stored.OperationType, JsonSerializer.SerializeToElement(shifted));

        static NendoOperation Compile(string operationId, string operationType, JsonElement payload) =>
            CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(operationId, operationType, payload.Clone()));
    }

    /// <summary>
    /// The records a revision wrote, read from its stored operations: a record by its type and ID,
    /// every record of a type for a data operation that names none, and a view's state by its key.
    /// </summary>
    private sealed class TouchedKeys
    {
        private readonly HashSet<(string Scope, string? Key)> _keys = [];

        internal TouchedKeys(IEnumerable<NendoStoredOperationSnapshot> operations)
        {
            foreach (var operation in operations)
            {
                using var document = JsonDocument.Parse(operation.CanonicalJson);
                var root = document.RootElement;
                if (root.GetProperty("lane").GetString() != nameof(NendoRevisionLane.Data)) continue;
                var payload = root.GetProperty("payload");
                string? Text(string property) => payload.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                if (operation.OperationType == "extension.setState") _keys.Add(($"state:{Text("packageId")}", $"{Text("viewId")}/{Text("key")}"));
                else if (Text("entityId") is { } entityId) _keys.Add((entityId, Text("recordId")));
            }
        }

        internal void Add(TouchedKeys other) => _keys.UnionWith(other._keys);

        /// <summary>Whether a key here is one there, counting every record of a type as each of them.</summary>
        internal bool Meets(TouchedKeys other) => _keys.Any(key =>
            other._keys.Contains(key) || other._keys.Contains((key.Scope, null)) ||
            key.Key is null && other._keys.Any(theirs => theirs.Scope == key.Scope));
    }
}
