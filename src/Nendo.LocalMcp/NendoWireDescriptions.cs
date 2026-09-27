using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// What each member of an Engine record means on the wire, where a tool returns one.
/// <para>
/// The adapter's own result records carry <see cref="System.ComponentModel.DescriptionAttribute"/>
/// beside each member, which the schema exporter reads. The Engine's records are shared
/// with the window and say nothing about one adapter's wording, so their descriptions live
/// here and the transform hook writes them onto the output schema. Until 2026-09-27 the
/// twenty output schemas carried no property description at all: what a null
/// <c>recordVersion</c> or an entry in <c>alsoChanged</c> meant lived in XML comments no
/// client reads. Entries are keyed with <c>nameof</c>, so a renamed member fails the build,
/// and a test fails on any output property left without a description.
/// </para>
/// </summary>
internal static class NendoWireDescriptions
{
    internal static IReadOnlyDictionary<(Type Type, string Member), string> Members { get; } =
        new Dictionary<(Type, string), string>
        {
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.RevisionId))] =
                "The History revision the original write committed.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.OperationDigest))] =
                "Digest of the canonical operations the original write committed.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.DefinitionRevision))] =
                "The file's definition revision after the original write.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.DataRevision))] =
                "The file's data revision after the original write.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.ChangeSequence))] =
                "The file's change sequence after the original write.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.IsIdempotentReplay))] =
                "True: a receipt is the original write's stored outcome, read back, and reading it wrote nothing.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.GeneratedChanges))] =
                "The records the write's automatic actions changed, rebuilt from its revision, with recordVersion null because the file may have moved since.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.AssignedValues))] =
                "Empty in a receipt: read the records for any codes the host assigned.",
            [(typeof(NendoApplyResult), nameof(NendoApplyResult.RecordVersion))] =
                "Null in a receipt: the record may have moved since the write, so read it before writing to it.",

            [(typeof(NendoGeneratedChange), nameof(NendoGeneratedChange.EntityId))] =
                "The record type of the changed record.",
            [(typeof(NendoGeneratedChange), nameof(NendoGeneratedChange.RecordId))] =
                "The record an automatic action changed.",
            [(typeof(NendoGeneratedChange), nameof(NendoGeneratedChange.Change))] =
                "created, updated or deleted.",
            [(typeof(NendoGeneratedChange), nameof(NendoGeneratedChange.RecordVersion))] =
                "The version the record now holds; null after a delete, on a replay and in a receipt.",

            [(typeof(NendoAssignedValue), nameof(NendoAssignedValue.EntityId))] =
                "The record type of the numbered record.",
            [(typeof(NendoAssignedValue), nameof(NendoAssignedValue.RecordId))] =
                "The record that received the code.",
            [(typeof(NendoAssignedValue), nameof(NendoAssignedValue.FieldId))] =
                "The numbered field.",
            [(typeof(NendoAssignedValue), nameof(NendoAssignedValue.Value))] =
                "The code written: the field's prefix and the zero-padded next number.",

            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.Code))] =
                "Stable diagnostic code.",
            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.Severity))] =
                "error stops the proposal validating; warning does not.",
            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.Message))] =
                "What is wrong, naming stable IDs and never a stored value.",
            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.SemanticId))] =
                "The node, field or record type it concerns, or null.",
            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.PropertyPath))] =
                "The property it concerns, or null.",
            [(typeof(NendoCompilerDiagnostic), nameof(NendoCompilerDiagnostic.Hint))] =
                "What to change, to correct it with nendo.change_set.amend.",

            [(typeof(NendoSemanticDiffEntry), nameof(NendoSemanticDiffEntry.Kind))] =
                "What kind of change this line describes.",
            [(typeof(NendoSemanticDiffEntry), nameof(NendoSemanticDiffEntry.Summary))] =
                "The sentence the person reads under What changes.",
            [(typeof(NendoSemanticDiffEntry), nameof(NendoSemanticDiffEntry.SemanticIds))] =
                "The stable IDs the change touches.",
            [(typeof(NendoSemanticDiffEntry), nameof(NendoSemanticDiffEntry.Reversibility))] =
                "reversible, reversibleWithRetainedState or irreversibleDeclared.",

            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.PackageId))] =
                "The custom-view package.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.Path))] =
                "The file's path inside the package.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.Change))] =
                "added, replaced or removed.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.MediaTypeBefore))] =
                "The media type now, or null when the file is added.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.MediaTypeAfter))] =
                "The media type after acceptance, or null when the file is removed.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.BytesBefore))] =
                "The size now, or null when the file is added.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.BytesAfter))] =
                "The size after acceptance, or null when the file is removed.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.Textual))] =
                "True when the change is shown as lines; false for a binary file, whose sizes say the change.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.Hunks))] =
                "The changed lines with three lines of context.",
            [(typeof(NendoExtensionFileChange), nameof(NendoExtensionFileChange.Truncated))] =
                "True when the lines shown stop before the change does.",

            [(typeof(NendoExtensionDiffHunk), nameof(NendoExtensionDiffHunk.OldStart))] =
                "First line of the hunk in the file now, numbered from one.",
            [(typeof(NendoExtensionDiffHunk), nameof(NendoExtensionDiffHunk.OldLines))] =
                "Lines of the file now that the hunk spans.",
            [(typeof(NendoExtensionDiffHunk), nameof(NendoExtensionDiffHunk.NewStart))] =
                "First line of the hunk after acceptance, numbered from one.",
            [(typeof(NendoExtensionDiffHunk), nameof(NendoExtensionDiffHunk.NewLines))] =
                "Lines after acceptance that the hunk spans.",
            [(typeof(NendoExtensionDiffHunk), nameof(NendoExtensionDiffHunk.Lines))] =
                "The hunk's lines in order.",

            [(typeof(NendoExtensionDiffLine), nameof(NendoExtensionDiffLine.Kind))] =
                "context, removed or added.",
            [(typeof(NendoExtensionDiffLine), nameof(NendoExtensionDiffLine.Text))] =
                "The line's text.",
        };

    /// <summary>Write the description of an Engine member that carries none of its own.</summary>
    internal static void Describe(AIJsonSchemaCreateContext context, JsonNode node)
    {
        if (node is not JsonObject target || target.ContainsKey("description")) return;
        if (context.PropertyInfo?.AttributeProvider is not MemberInfo { DeclaringType: { } declaring } member) return;
        if (Members.TryGetValue((declaring, member.Name), out var text)) target["description"] = text;
    }
}
