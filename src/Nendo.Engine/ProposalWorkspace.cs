using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

internal sealed class ProposalContext(
    string proposalId,
    string title,
    string origin,
    string workspacePath,
    NendoChangeSet changeSet,
    string sourceApplicationId,
    string sourceInstanceId,
    long capturedDefinitionRevision,
    IReadOnlyList<NendoTouchedRecordVersion> touchedRecords,
    IReadOnlyList<NendoSemanticDiffEntry> semanticDiff)
{
    internal string ProposalId { get; } = proposalId;
    internal string Title { get; } = title;
    internal string Origin { get; } = origin;
    internal string WorkspacePath { get; } = workspacePath;
    internal NendoChangeSet ChangeSet { get; } = changeSet;
    internal string SourceApplicationId { get; } = sourceApplicationId;
    internal string SourceInstanceId { get; } = sourceInstanceId;
    internal long CapturedDefinitionRevision { get; } = capturedDefinitionRevision;
    internal IReadOnlyList<NendoTouchedRecordVersion> TouchedRecords { get; } = touchedRecords;

    // Set once more after clone validation: the operations alone do not say
    // whether the file's minimum host version moved, and that is a change the
    // person accepting is owed as a line of its own.
    internal IReadOnlyList<NendoSemanticDiffEntry> SemanticDiff { get; set; } = semanticDiff;
    internal string OperationDigest { get; } = changeSet.OperationDigest;

    /// <summary>
    /// The digest of what promoting this proposal actually commits: the authored change
    /// set with its reviewed generated effects folded in. This is what a client is shown
    /// and sends back on acceptance, so it matches the committed revision's stored digest.
    /// Equal to <see cref="OperationDigest"/> for a proposal whose actions generated
    /// nothing. Publishing the unexpanded digest instead made every retry of an
    /// effect-bearing proposal fail its digest check against the committed receipt.
    /// </summary>
    internal string ReviewedDigest { get; set; } = changeSet.OperationDigest;

    /// <summary>
    /// What the automatic actions did when this proposal was reviewed, together with
    /// the preconditions that made those effects correct. Promotion replays this; it
    /// never works it out again.
    /// </summary>
    internal PreparedBehaviourPlan BehaviourPlan { get; set; } = PreparedBehaviourPlan.Empty;
    internal NendoProposalState State { get; set; } = NendoProposalState.Draft;
    internal IReadOnlyList<NendoCompilerDiagnostic> Diagnostics { get; set; } = [];
    internal IReadOnlyList<NendoApplicationPlan> PreviewApplications { get; set; } = [];
    internal NendoOverviewPlan? PreviewOverview { get; set; }
    internal IReadOnlyDictionary<string, int> PreviewRecordCounts { get; set; } = new Dictionary<string, int>();
    internal IReadOnlyList<NendoProposalEntitySummary> PreviewEntities { get; set; } = [];
    internal string? MinimumHostVersionBefore { get; set; }
    internal string? MinimumHostVersionAfter { get; set; }
    internal string? PurposeBefore { get; set; }
    internal string? PurposeAfter { get; set; }
    internal IReadOnlyList<NendoExtensionFileChange> PackageChanges { get; set; } = [];

    internal NendoProposalPreview ToPreview() => new(
        ProposalId,
        Title,
        State,
        NendoProposalRetention.RetainUntilExplicitCleanup,
        SourceApplicationId,
        SourceInstanceId,
        CapturedDefinitionRevision,
        TouchedRecords,
        ReviewedDigest,
        ChangeSet.Mutations.Sum(mutation => mutation.Operations.Count),
        Diagnostics,
        SemanticDiff)
    {
        PreviewApplications = PreviewApplications,
        PreviewOverview = PreviewOverview,
        PreviewRecordCounts = PreviewRecordCounts,
        PreviewEntities = PreviewEntities,
        MinimumHostVersionBefore = MinimumHostVersionBefore,
        MinimumHostVersionAfter = MinimumHostVersionAfter,
        PurposeBefore = PurposeBefore,
        PurposeAfter = PurposeAfter,
        PackageChanges = PackageChanges,
    };
}

internal static class ProposalWorkspace
{
    internal const string InterpreterVersion = "semantic-v1";

    internal static string RootFor(NendoAuthoritySnapshot authority)
    {
        var identity = $"{authority.ApplicationId}\n{authority.InstanceId}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))
            .ToLowerInvariant()[..24];
        return Path.Combine(Path.GetTempPath(), "nendo-proposals-v1", hash);
    }

    internal static bool CleanupAbandoned(string root, IReadOnlySet<string>? retained = null)
    {
        try
        {
            if (!Directory.Exists(root)) return true;
            var complete = true;
            var fullRoot = Path.GetFullPath(root);
            foreach (var directory in Directory.GetDirectories(fullRoot, "proposal-*", SearchOption.TopDirectoryOnly))
            {
                if (retained?.Contains(Path.GetFileName(directory)) == true) continue;
                var fullDirectory = Path.GetFullPath(directory);
                if (!string.Equals(Path.GetDirectoryName(fullDirectory), fullRoot, StringComparison.OrdinalIgnoreCase))
                    throw new NendoValidationException("An abandoned proposal workspace escaped its host-owned root.");
                complete &= TryDeleteDirectory(fullDirectory);
            }
            if (!Directory.EnumerateFileSystemEntries(fullRoot).Any()) Directory.Delete(fullRoot);
            return complete;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal static void ValidateId(string proposalId)
    {
        if (proposalId is null || !proposalId.StartsWith("proposal-", StringComparison.Ordinal) ||
            proposalId.Length != "proposal-".Length + 32 || !proposalId["proposal-".Length..].All(Uri.IsHexDigit))
            throw new NendoValidationException("Proposal identity is invalid.");
    }

    internal static string Create(string root, string proposalId)
    {
        if (!proposalId.StartsWith("proposal-", StringComparison.Ordinal) ||
            proposalId.Length != "proposal-".Length + 32 ||
            !proposalId["proposal-".Length..].All(Uri.IsHexDigit))
        {
            throw new NendoValidationException("Proposal identity is invalid.");
        }
        Directory.CreateDirectory(root);
        var path = Path.GetFullPath(Path.Combine(root, proposalId));
        if (!string.Equals(Path.GetDirectoryName(path), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
        {
            throw new NendoValidationException("Proposal workspace identity escaped its host-owned root.");
        }
        Directory.CreateDirectory(path);
        return path;
    }

    internal static async Task PersistAsync(
        ProposalContext context,
        CancellationToken cancellationToken)
    {
        var options = new JsonSerializerOptions(NendoRenderPlanJson.Options) { WriteIndented = true };
        var preview = context.ToPreview();
        var metadata = new
        {
            preview.ProposalId,
            preview.Title,
            preview.State,
            preview.Retention,
            preview.SourceApplicationId,
            preview.SourceInstanceId,
            preview.CapturedDefinitionRevision,
            preview.TouchedRecords,
            preview.OperationDigest,
            preview.OperationCount,
            interpreterVersion = InterpreterVersion,
        };
        await File.WriteAllTextAsync(
            Path.Combine(context.WorkspacePath, "proposal.json"),
            JsonSerializer.Serialize(metadata, options),
            cancellationToken);
        await File.WriteAllTextAsync(
            Path.Combine(context.WorkspacePath, "operations.json"),
            SerializeOperations(context.ChangeSet),
            cancellationToken);
        await File.WriteAllTextAsync(
            Path.Combine(context.WorkspacePath, "behaviour-plan.json"),
            context.BehaviourPlan.Serialize(),
            cancellationToken);
        await File.WriteAllTextAsync(
            Path.Combine(context.WorkspacePath, "validation.json"),
            JsonSerializer.Serialize(context.Diagnostics, options),
            cancellationToken);
        await File.WriteAllTextAsync(
            Path.Combine(context.WorkspacePath, "semantic-diff.json"),
            JsonSerializer.Serialize(context.SemanticDiff, options),
            cancellationToken);
    }

    /// <summary>
    /// Reads back a proposal's reviewed plan from its workspace.
    /// <para>
    /// A proposal outlives the session that made it, and the plan is the part that
    /// must survive: an in-memory copy would mean that closing the application quietly
    /// turned "promote exactly what you reviewed" into "work it out again now".
    /// </para>
    /// </summary>
    internal static async Task<PreparedBehaviourPlan> ReadPlanAsync(
        string workspacePath,
        CancellationToken cancellationToken)
    {
        var path = Path.Combine(workspacePath, "behaviour-plan.json");
        if (!File.Exists(path)) return PreparedBehaviourPlan.Empty;
        return PreparedBehaviourPlan.Deserialize(await File.ReadAllTextAsync(path, cancellationToken));
    }

    internal static void Delete(ProposalContext context)
    {
        if (Directory.Exists(context.WorkspacePath))
        {
            Directory.Delete(context.WorkspacePath, recursive: true);
        }
    }

    /// <summary>
    /// The same removal for a failure handler: a workspace that cannot be removed right
    /// now is left for <see cref="CleanupAbandoned"/> rather than allowed to replace the
    /// failure being reported.
    /// </summary>
    internal static bool TryDelete(ProposalContext context) => TryDeleteDirectory(context.WorkspacePath);

    private static string SerializeOperations(NendoChangeSet changeSet)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartArray();
            foreach (var mutation in changeSet.Mutations)
            {
                writer.WriteStartObject();
                writer.WriteString("description", mutation.Description);
                writer.WriteString("lane", mutation.Operations[0].Lane.ToString());
                writer.WriteStartArray("operations");
                foreach (var operation in mutation.Operations)
                {
                    using var document = JsonDocument.Parse(operation.CanonicalJson());
                    document.RootElement.WriteTo(writer);
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }
}
