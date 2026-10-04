using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// The one skill this host serves over the Skills extension (W-154, SEP-2640): a
/// <c>SKILL.md</c> that says when to read each of the authoring resources, with the
/// vocabulary, the examples and the view API as its supporting files. Generated from the
/// same tables the vocabulary is, build-static, so the manifest's digests are the bytes
/// served. A file that carries its own skill is a separate decision (ADR-0024).
/// </summary>
internal static class NendoHostSkill
{
    internal const string ExtensionId = "io.modelcontextprotocol/skills";
    internal const string Name = "nendo-authoring";
    internal const string Root = "skill://" + Name;
    internal const string SkillUri = Root + "/SKILL.md";
    internal const string ReferencesRoot = Root + "/references";
    internal const string DescriptionText =
        "Author a Nendo file over its local MCP: which read answers which question, the lease and the receipt, how a change set becomes a proposal, and the refusals to expect.";

    /// <summary>One hour, as every build-static read carries.</summary>
    internal static readonly long TimeToLiveMs = (long)NendoMcpResources.StaticTimeToLive.TotalMilliseconds;

    private static readonly Lazy<IReadOnlyList<SkillFile>> Files = new(() =>
    [
        new SkillFile(SkillUri, "text/markdown", Encoding.UTF8.GetBytes(SkillMarkdown())),
        new SkillFile(ReferencesRoot + "/vocabulary.json", "application/json", Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(NendoSemanticVocabulary.Description() with
            {
                Operations = NendoAuthoringOperations.All,
                AuthoringRules = NendoAuthoringOperations.Rules,
            }, NendoMcpJson.Options))),
        new SkillFile(ReferencesRoot + "/examples.json", "application/json", Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(NendoAuthoringExamples.Description(), NendoMcpJson.Options))),
        new SkillFile(ReferencesRoot + "/view-api.json", "application/json", Encoding.UTF8.GetBytes(NendoViewApi.Json)),
    ]);

    /// <summary>Every URI the skill serves, SKILL.md first.</summary>
    internal static IReadOnlyList<string> Uris => Files.Value.Select(file => file.Uri).ToArray();

    internal static SkillFile? Find(string uri) => Files.Value.FirstOrDefault(file => file.Uri == uri);

    /// <summary>A supporting file by the name under <c>references/</c>, or null.</summary>
    internal static SkillFile? Reference(string file) => Find($"{ReferencesRoot}/{file}");

    /// <summary>The skill entry as skills/list and skills/get return it: frontmatter and the complete manifest.</summary>
    internal static JsonObject Entry() => new()
    {
        ["uri"] = SkillUri,
        ["frontmatter"] = new JsonObject { ["name"] = Name, ["description"] = DescriptionText },
        ["resources"] = new JsonArray(Files.Value.Select(file => (JsonNode)new JsonObject
        {
            ["uri"] = file.Uri,
            ["digest"] = file.Digest,
            ["size"] = file.Size,
        }).ToArray()),
    };

    internal static JsonObject ListResult() => new()
    {
        ["resultType"] = "complete",
        ["skills"] = new JsonArray(Entry()),
        ["ttlMs"] = TimeToLiveMs,
        ["cacheScope"] = "public",
    };

    internal static JsonObject GetResult(JsonNode? parameters)
    {
        var uri = parameters?["uri"]?.GetValue<string>();
        if (uri != SkillUri)
        {
            throw new McpProtocolException(
                $"NENDO_SKILL_NOT_FOUND: This host serves one skill, {SkillUri}; '{uri}' is not it.",
                McpErrorCode.InvalidParams);
        }
        return new JsonObject
        {
            ["resultType"] = "complete",
            ["skill"] = Entry(),
            ["ttlMs"] = TimeToLiveMs,
            ["cacheScope"] = "public",
        };
    }

    /// <summary>
    /// The instructions, written from the tables rather than by hand so a new operation or
    /// example appears here when it appears in the vocabulary. The frontmatter is what
    /// skills/list reports, field for field, which a host verifies.
    /// </summary>
    private static string SkillMarkdown()
    {
        var text = new StringBuilder();
        text.Append("---\nname: ").Append(Name).Append("\ndescription: ").Append(DescriptionText).Append("\n---\n\n");
        text.Append("# Authoring a Nendo file over MCP\n\n");
        text.Append("A Nendo file holds record types and records, screens, calculated fields, reusable functions and automatic actions. ");
        text.Append("Records are written directly with the `nendo.data.*` tools. Everything else is authored as a change set: `nendo.change_set.begin`, ");
        text.Append("`add_operations` (or `amend` to replace a tail), `validate`, and then a person accepts the proposal in Nendo, or ");
        text.Append("`nendo.change_set.accept` applies your own at the Unattended level. Nothing reaches the file from a change set before acceptance.\n\n");
        text.Append("## Which read answers which question\n\n");
        text.Append("| Question | Read |\n| --- | --- |\n");
        text.Append("| What is this file, and every read path this host serves | `nendo://application/describe` (or `describe?include=manifest,entities` for the record types without the screens) |\n");
        text.Append("| One record type: its fields, record count and screens | `nendo://application/entity/{entityId}` |\n");
        text.Append("| One record, or a filtered and sorted page | `nendo://application/entity/{entityId}/records{?recordId,filter,sort,desc}` |\n");
        text.Append("| A count, sum, min or max, whole or grouped | `nendo://application/entity/{entityId}/aggregate` |\n");
        text.Append("| Every operation with its payload, the authoring rules and the limits | `references/vocabulary.json` here, or `nendo://application/vocabulary` |\n");
        text.Append("| Change sets you can send as they stand | `references/examples.json` here, or `nendo://application/examples` |\n");
        text.Append("| What is waiting for the person, including a predecessor session's work | `nendo://application/proposals`, and one in full at `nendo://application/proposal/{proposalId}` |\n");
        text.Append("| What compiled, and the command IDs | `nendo://application/surfaces` |\n");
        text.Append("| The API a custom view's code calls | `references/view-api.json` here, only when you write a view |\n\n");
        text.Append("## Before writing\n\n");
        text.Append("Call `nendo.lease.acquire` with an `idempotencyKey`; keep `applicationHandle` private and pass it with `leaseId` on every owned call. ");
        text.Append("Save `receiptContext`: after a lost response, `nendo.data.get_receipt` reads the original outcome, and an unresolved receipt is not permission to resubmit under a new key. ");
        text.Append("Release the lease when finished; to take it again later under the same handle, pass `resumeApplicationHandle`. ");
        text.Append("Every write carries the record's current version; every result returns the version it left.\n\n");
        text.Append("## The operations a change set takes\n\n");
        foreach (var lane in NendoAuthoringOperations.All.GroupBy(operation => operation.Lane))
        {
            text.Append("### ").Append(lane.Key == "data" ? "Data lane" : "Definition lane").Append("\n\n");
            foreach (var operation in lane)
            {
                text.Append("- `").Append(operation.OperationType).Append("` takes ")
                    .Append(string.Join(", ", operation.RequiredPayload));
                if (operation.OptionalPayload.Count > 0)
                    text.Append(" and optionally ").Append(string.Join(", ", operation.OptionalPayload));
                text.Append(".\n");
            }
            text.Append('\n');
        }
        text.Append("The payload rules, the node kinds a screen is built from and the behaviour catalogue are in `references/vocabulary.json`; ");
        text.Append("a payload key it does not list is refused by name.\n\n");
        text.Append("## The bounds\n\n");
        var limits = NendoAuthoringLimits.Current;
        text.Append("A call carries up to ").Append(limits.MutationsPerCall).Append(" mutations and ").Append(limits.OperationsPerCall).Append(" operations; ");
        text.Append("a change set up to ").Append(limits.OperationsPerChangeSet).Append(" submitted operations expanding to at most ").Append(limits.CanonicalOperationsPerChangeSet).Append(" canonical ones; ");
        text.Append("a session up to ").Append(limits.DraftsPerSession).Append(" open drafts and ").Append(limits.ProposalsPerSession).Append(" validated proposals. ");
        text.Append("A batch create takes ").Append(limits.RecordsPerCreateBatch).Append(" records, a batch of writes ").Append(limits.RecordWritesPerCall)
            .Append(", an update ").Append(limits.FieldsPerRecordUpdate).Append(" fields, an import ").Append(limits.Import!.RowsPerCall).Append(" rows. ");
        text.Append("Every limit is published under `limits` in the vocabulary and echoed by the result that meets it.\n\n");
        text.Append("## The examples\n\n");
        foreach (var example in NendoAuthoringExamples.Description().Examples)
        {
            text.Append("- `").Append(example.Name).Append("`: ").Append(example.Purpose).Append('\n');
        }
        text.Append("\n## The refusals to expect\n\n");
        text.Append("Every refusal begins with a `NENDO_` code and says what to do; a tool refusal also carries the same code and sentence as an object in the result's `_meta` ");
        text.Append("under `io.github.thomasrohde.nendo/refusal`. A write refused for an ID a pending proposal creates names that proposal. ");
        text.Append("`NENDO_RECORD_VERSION_CONFLICT` means read the record and carry its current version. `NENDO_BEHAVIOUR_NOT_APPROVED` means the file's automatic actions wait for the person's approval in Nendo. ");
        text.Append("A proposal answered `stale` was overtaken by another acceptance: reject it and begin again against the current revision.\n\n");
        text.Append("## The rules\n\n");
        foreach (var rule in NendoAuthoringOperations.Rules)
        {
            text.Append("- ").Append(rule).Append('\n');
        }
        return text.ToString();
    }

    internal sealed record SkillFile(string Uri, string MimeType, byte[] Bytes)
    {
        internal string Digest { get; } = "sha256:" + Convert.ToHexString(SHA256.HashData(Bytes)).ToLowerInvariant();

        internal long Size => Bytes.LongLength;

        internal string Text => Encoding.UTF8.GetString(Bytes);
    }
}
