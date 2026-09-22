using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

public sealed partial class NendoSemanticCompiler
{

    public NendoCompileResult Compile(NendoSessionSnapshot source)
    {
        ArgumentNullException.ThrowIfNull(source);

        // A file may deliberately have no custom UI. Studio owns its schema/data
        // view; absence is not a malformed definition or a partial render plan.
        if (source.UiNodes.Count == 0) return new NendoCompileResult(false, []);
        return CompileComposableApplications(source);
    }

    internal NendoCompileResult ProjectRecords(NendoCompileResult definition, NendoSessionSnapshot source)
    {
        if (definition.Applications.Count > 0) return ProjectComposableRecords(definition, source);
        return new(definition.IsValid, definition.Diagnostics.ToList().AsReadOnly());
    }
    private static int? ReadContractVersion(
        IEnumerable<NendoUiNodeSnapshot?> roots,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var versions = new List<int>();
        foreach (var root in roots.Where(value => value is not null))
        {
            if (!root!.Properties.TryGetValue("definitionVersion", out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var version))
            {
                AddError(diagnostics, "NUI001", "The semantic contract version is missing or invalid.", root.NodeId, "definitionVersion", "Declare numeric definitionVersion 3 on every root.");
                continue;
            }
            versions.Add(version);
        }
        if (versions.Count == 0)
        {
            return null;
        }
        if (versions.Distinct().Count() != 1)
        {
            AddError(diagnostics, "NUI002", "Semantic roots declare inconsistent contract versions.", null, "definitionVersion", "Use one contract version across every root.");
            return null;
        }
        if (versions[0] != NendoSemanticVocabulary.ContractVersion)
        {
            AddError(diagnostics, "NUI003", $"Semantic contract version {versions[0]} is not supported.", null, "definitionVersion", $"Use contract version {NendoSemanticVocabulary.ContractVersion}. Contract versions 1 and 2 were removed; rebuild the surfaces through the current vocabulary.");
            return null;
        }
        return versions[0];
    }

    private static void ValidateRecords(
        IReadOnlyList<NendoRecordSnapshot> records,
        NendoEntitySnapshot entity,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        foreach (var duplicate in records
                     .Where(value => value.EntityId == entity.EntityId)
                     .GroupBy(value => value.RecordId, StringComparer.Ordinal)
                     .Where(group => group.Count() > 1))
        {
            AddError(diagnostics, "NDATA001", $"Record ID '{duplicate.Key}' is duplicated.", duplicate.Key, null, "Use one stable record ID per entity.");
        }
        foreach (var record in records
                     .Where(value => value.EntityId == entity.EntityId)
                     .OrderBy(value => value.RecordId, StringComparer.Ordinal))
        {
            foreach (var field in fields.Values.OrderBy(value => value.FieldId, StringComparer.Ordinal))
            {
                var hasValue = record.Values.TryGetValue(field.FieldId, out var value) &&
                               value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) &&
                               (value.ValueKind != JsonValueKind.String || !string.IsNullOrWhiteSpace(value.GetString()));
                if (field.Required && !hasValue)
                {
                    diagnostics.Add(new NendoCompilerDiagnostic(
                        "NDATA010",
                        NendoDiagnosticSeverity.Warning,
                        $"Record '{record.RecordId}' is missing required field '{field.DisplayName}'.",
                        record.RecordId,
                        field.FieldId,
                        "The record remains visible with a validation state."));
                }
                if (hasValue && field.Presentation == "singleChoice" &&
                    (value.ValueKind != JsonValueKind.String ||
                     !field.Options.Contains(value.GetString() ?? string.Empty, StringComparer.Ordinal)))
                {
                    diagnostics.Add(new NendoCompilerDiagnostic(
                        "NDATA011",
                        NendoDiagnosticSeverity.Warning,
                        $"Record '{record.RecordId}' has a value outside '{field.DisplayName}' choices.",
                        record.RecordId,
                        field.FieldId,
                        "The record remains visible until the value is corrected in Studio."));
                }
                // A scale bounds the drawing, not the column: a rating can be declared
                // over values that already exist, so a number outside it is stated rather
                // than refused, and never drawn as a dot count nobody chose.
                if (hasValue && field.Presentation == "rating" && field.Scale is { } scale &&
                    (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var rating) ||
                     rating < scale.Min || rating > scale.Max))
                {
                    diagnostics.Add(new NendoCompilerDiagnostic(
                        "NDATA012",
                        NendoDiagnosticSeverity.Warning,
                        $"Record '{record.RecordId}' has a value outside '{field.DisplayName}' scale {scale.Min}–{scale.Max}.",
                        record.RecordId,
                        field.FieldId,
                        "The record remains visible with the number shown until the value is corrected in Studio."));
                }
            }
        }
    }

    private static string? ReadRequiredString(
        NendoUiNodeSnapshot node,
        string propertyName,
        string code,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (node.Properties.TryGetValue(propertyName, out var value) &&
            value.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(value.GetString()))
        {
            return value.GetString();
        }
        AddError(diagnostics, code, $"Required property '{propertyName}' is missing or invalid.", node.NodeId, propertyName, "Declare a non-empty semantic string.");
        return null;
    }

    private static NendoFieldPlan ToFieldPlan(NendoFieldSnapshot field) => new(
        field.FieldId,
        AutomationTarget(field.FieldId),
        field.DisplayName,
        field.StorageKind,
        field.Required,
        field.Presentation,
        field.Options.ToList().AsReadOnly()) { Choices = field.Choices, Scale = field.Scale, Reference = field.Reference };

    private static NendoRecordPlan ToRecordPlan(NendoRecordSnapshot record)
    {
        var values = new SortedDictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var pair in record.Values.OrderBy(value => value.Key, StringComparer.Ordinal))
        {
            values[pair.Key] = pair.Value.Clone();
        }
        var calculations = new SortedDictionary<string, NendoCalculationResult>(StringComparer.Ordinal);
        foreach (var calculation in record.Calculations) calculations[calculation.FieldId] = calculation;
        return new NendoRecordPlan(
            record.RecordId,
            AutomationTarget(record.RecordId),
            record.RecordVersion,
            new ReadOnlyDictionary<string, JsonElement>(values))
        {
            ReferenceLabels = record.ReferenceLabels,
            Calculations = new ReadOnlyDictionary<string, NendoCalculationResult>(calculations),
        };
    }

    private static NendoDerivedFieldPlan ToDerivedFieldPlan(NendoDerivedFieldSnapshot field, string expression) => new(
        field.FieldId,
        AutomationTarget(field.FieldId),
        field.DisplayName,
        field.ResultType,
        field.ResultNullable,
        field.CalculationId,
        expression);

    private static string AutomationTarget(string semanticId)
    {
        var builder = new StringBuilder("nendo-");
        foreach (var character in semanticId)
        {
            builder.Append(char.IsAsciiLetterOrDigit(character) ? char.ToLowerInvariant(character) : '-');
        }
        return builder.ToString().TrimEnd('-');
    }

    private static bool HasErrors(IEnumerable<NendoCompilerDiagnostic> diagnostics) =>
        diagnostics.Any(value => value.Severity == NendoDiagnosticSeverity.Error);

    private static NendoCompileResult Invalid(IEnumerable<NendoCompilerDiagnostic> diagnostics) =>
        new(false, OrderDiagnostics(diagnostics));

    private static IReadOnlyList<NendoCompilerDiagnostic> OrderDiagnostics(
        IEnumerable<NendoCompilerDiagnostic> diagnostics) => diagnostics
        .OrderBy(value => value.Severity)
        .ThenBy(value => value.Code, StringComparer.Ordinal)
        .ThenBy(value => value.SemanticId, StringComparer.Ordinal)
        .ThenBy(value => value.PropertyPath, StringComparer.Ordinal)
        .ToList()
        .AsReadOnly();

    /// <summary>
    /// The published root ceiling for a kind. An unknown kind is already refused
    /// by NUI011, so one root of it is all this needs to tolerate.
    /// </summary>
    private static int MaximumRootsPerEntity(string kind) =>
        NendoSemanticVocabulary.Kinds.TryGetValue(kind, out var rule) ? rule.MaxRootsPerEntity ?? 1 : 1;

    private static void AddError(
        ICollection<NendoCompilerDiagnostic> diagnostics,
        string code,
        string message,
        string? semanticId,
        string? propertyPath,
        string hint) => diagnostics.Add(new NendoCompilerDiagnostic(
            code,
            NendoDiagnosticSeverity.Error,
            message,
            semanticId,
            propertyPath,
            hint));
}
