using System.Text.Json;

namespace Nendo.Engine;

// The binding and header validators of contract version 3: progress, calendar,
// timeline, gallery and outline bindings, record page headers and summary scope.
public sealed partial class NendoSemanticCompiler
{
    /// <summary>
    /// A progress ring: the records matching its own clauses over the records its
    /// scope covers. A ring with no clause narrows nothing and would always be full,
    /// so it is refused rather than drawn.
    /// </summary>
    private static void ValidateProgressTile(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var clauses = DeclaredClauseCount(node, nodes);
        RequireFilterBudget(node, scope, clauses, null, diagnostics);
        if (clauses == 0)
            AddError(diagnostics, "NUI360", "The progress ring narrows nothing, so it would always be full.", node.NodeId, null,
                "Add at least one filterClause child: the ring shows the records matching them over everything its surface shows.");
    }

    /// <summary>
    /// A calendar places each record on one civil date. This first slice takes a
    /// Date field only: a DateTime carries a time and an offset, and putting one
    /// on a month grid means choosing a time zone to group by. That needs its own
    /// contract change, so the refusal names it rather than guessing UTC.
    /// </summary>
    private static void ValidateCalendarBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var dateFieldId = ReadRequiredString(node, "dateFieldId", "NUI320", diagnostics);
        if (dateFieldId is null) return;
        if (RefuseCalculatedQueryField(node, "dateFieldId", dateFieldId, derived, "place records on a calendar by it", diagnostics)) return;
        RequireActiveDateField(node, "dateFieldId", dateFieldId, fields, "NUI321",
            "places records on a calendar", "place a record on a calendar", diagnostics);
    }

    /// <summary>
    /// The shape rule a calendar and a timeline share: the field must be an active
    /// Date. The refusal names a DateTime rather than guessing UTC, because
    /// placing one on a civil date means choosing a time zone to group by.
    /// </summary>
    private static bool RequireActiveDateField(
        NendoUiNodeSnapshot node,
        string propertyName,
        string fieldId,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        string code,
        string places,
        string verb,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!fields.TryGetValue(fieldId, out var field))
        {
            AddError(diagnostics, code, $"Field '{fieldId}' does not exist or is retired.", node.NodeId, propertyName,
                "Set an active Date field of this record type.");
            return false;
        }
        if (field.StorageKind == NendoStorageKind.DateTime)
        {
            AddError(diagnostics, code,
                $"Field '{fieldId}' is a DateTime, and this host {places} by Date only.",
                node.NodeId, propertyName,
                "Use a Date field. A DateTime needs a declared time zone to group by, which this contract version does not define.");
            return false;
        }
        if (field.StorageKind != NendoStorageKind.Date)
        {
            AddError(diagnostics, code,
                $"Field '{fieldId}' is a {field.StorageKind}, so it cannot {verb}.",
                node.NodeId, propertyName, "Set an active Date field of this record type.");
            return false;
        }
        return true;
    }

    /// <summary>
    /// A timeline, ADR-0004 2026-09-14 amendment (S3): each record on a spine by one
    /// civil date, with an optional end date that turns the entry into a span, a
    /// stored Text field that titles it and a single-choice field that tones its
    /// dot. The date rule is the calendar's and the title and accent rules are the
    /// record page's, shared rather than copied; each is refused by name rather than
    /// drawn as an empty entry.
    /// </summary>
    private static void ValidateTimelineBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var dateFieldId = ReadRequiredString(node, "dateFieldId", "NUI370", diagnostics);
        if (dateFieldId is not null &&
            !RefuseCalculatedQueryField(node, "dateFieldId", dateFieldId, derived, "place records on a timeline by it", diagnostics))
            RequireActiveDateField(node, "dateFieldId", dateFieldId, fields, "NUI371",
                "places records on a timeline", "place a record on a timeline", diagnostics);

        if (node.Properties.ContainsKey("endDateFieldId"))
        {
            var endDateFieldId = HeaderField(node, "endDateFieldId");
            if (endDateFieldId is null)
                AddError(diagnostics, "NUI372", "The end date must name a field.", node.NodeId, "endDateFieldId",
                    "Set the fieldId of an active Date field, or remove endDateFieldId.");
            else if (endDateFieldId == dateFieldId)
                AddError(diagnostics, "NUI372", "The end date repeats the start date.", node.NodeId, "endDateFieldId",
                    "End each span at a different Date field, or remove endDateFieldId.");
            else if (!RefuseCalculatedQueryField(node, "endDateFieldId", endDateFieldId, derived, "end a span by it", diagnostics))
                RequireActiveDateField(node, "endDateFieldId", endDateFieldId, fields, "NUI372",
                    "ends a span", "end a span", diagnostics);
        }

        ValidateTitleField(node, fields, derived, EntryTitle, diagnostics);
        ValidateAccentField(node, fields, derived, EntryAccent, diagnostics);
    }

    /// <summary>
    /// A gallery, ADR-0004 2026-09-14 amendment (S2): a card per record over exactly a
    /// list's window. Both field roles are the record page's rules with card wording, and
    /// both are optional — a card without a declared title leads with its first bound
    /// field, as a timeline entry does, so a gallery card and a board card are titled by
    /// one rule rather than two.
    /// </summary>
    private static void ValidateGalleryBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        ValidateTitleField(node, fields, derived, CardTitle, diagnostics);
        ValidateAccentField(node, fields, derived, CardAccent, diagnostics);
    }

    /// <summary>
    /// An outline (ADR-0019 stage 6): a tree the Engine keeps, so the record type must declare
    /// one. What the outline reads is the hierarchy's own order, which is why it names no
    /// ordering; how far it opens and whether it moves records are the only choices it makes.
    /// </summary>
    private static void ValidateOutlineSurface(
        NendoUiNodeSnapshot node,
        NendoEntitySnapshot entity,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (entity.Hierarchy is null)
            AddError(diagnostics, "NUI430", $"{entity.DisplayName} declares no hierarchy, so there is no tree to outline.", node.NodeId, "entityId",
                "Declare one with schema.declareHierarchy, in the same change set if you like, or show these records in a recordList.");

        ValidateTitleField(node, fields, derived, RowTitle, diagnostics);
        ValidateAccentField(node, fields, derived, RowAccent, diagnostics);

        if (node.Properties.TryGetValue("expandDepth", out var depth) &&
            (depth.ValueKind != JsonValueKind.Number || !depth.TryGetInt32(out var levels) ||
             levels < 1 || levels > NendoSemanticVocabulary.MaximumOutlineExpandDepth))
            AddError(diagnostics, "NUI433",
                $"An outline opens between 1 and {NendoSemanticVocabulary.MaximumOutlineExpandDepth} levels by itself.",
                node.NodeId, "expandDepth",
                $"Declare a whole number from 1 to {NendoSemanticVocabulary.MaximumOutlineExpandDepth}, or leave expandDepth out to open " +
                $"{NendoSemanticVocabulary.DefaultOutlineExpandDepth}. A person can still open any row further.");

        if (node.Properties.TryGetValue("reorder", out var reorder) && reorder.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            AddError(diagnostics, "NUI434", "Whether the outline moves records must be true or false.", node.NodeId, "reorder",
                "Declare reorder as true to let a person move records, or false or absent to keep the outline read-only.");
    }

    /// <summary>
    /// The record-page header, ADR-0004 2026-09-14 amendment (S0). Three optional
    /// properties on a <c>detailSurface</c>: the stored Text field that heads the
    /// page, a field shown under it, and the single-choice field whose option's tone
    /// colours it. Each is refused by name rather than drawn as an empty band: a page
    /// headed by a choice, or coloured by a date, is a definition nobody meant.
    /// </summary>
    private static void ValidateRecordPageHeader(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var title = HeaderField(node, "titleFieldId");
        ValidateTitleField(node, fields, derived, PageTitle, diagnostics);

        if (node.Properties.ContainsKey("subtitleFieldId"))
        {
            var subtitle = HeaderField(node, "subtitleFieldId");
            if (subtitle is null)
                AddError(diagnostics, "NUI341", "The page subtitle must name a field.", node.NodeId, "subtitleFieldId",
                    "Set the fieldId of an active field, or remove subtitleFieldId.");
            else if (!fields.ContainsKey(subtitle) && !derived.ContainsKey(subtitle))
                AddError(diagnostics, "NUI341", $"Field '{subtitle}' does not exist or is retired.", node.NodeId, "subtitleFieldId",
                    "Set the fieldId of an active stored or calculated field of this record type.");
            else if (subtitle == title)
                AddError(diagnostics, "NUI341", "The subtitle repeats the title.", node.NodeId, "subtitleFieldId",
                    "Show a different field under the title, or remove subtitleFieldId.");
        }

        ValidateAccentField(node, fields, derived, PageAccent, diagnostics);
    }

    /// <summary>
    /// What a field-role refusal says depends on what the role does: a title heads
    /// a page or titles an entry, an accent colours a page or an entry. The rule is
    /// one; the wording names the surface a person will see.
    /// </summary>
    private sealed record FieldRoleWording(string Code, string Subject, string Verb, string CalculatedHint, string ShapeHint);

    private static readonly FieldRoleWording PageTitle = new("NUI340", "The page title", "head the page",
        "Head the page with a stored Text field, and bind the calculated field inside the page instead.",
        "Head the page with a stored Text field. A choice can colour the page through accentFieldId instead.");

    private static readonly FieldRoleWording EntryTitle = new("NUI373", "The entry title", "title each entry",
        "Title each entry with a stored Text field, and bind the calculated field on the timeline instead.",
        "Title each entry with a stored Text field. A choice can tone each entry's dot through accentFieldId instead.");

    private static readonly FieldRoleWording PageAccent = new("NUI342", "The page accent", "colour the page",
        "Colour the page by a stored single-choice field whose options carry tones.",
        "Colour the page by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    private static readonly FieldRoleWording CardTitle = new("NUI380", "The card title", "title each card",
        "Title each card with a stored Text field, and bind the calculated field on the gallery instead.",
        "Title each card with a stored Text field. A choice can tone each card's edge through accentFieldId instead.");

    private static readonly FieldRoleWording CardAccent = new("NUI381", "The card accent", "colour each card",
        "Colour each card by a stored single-choice field whose options carry tones.",
        "Colour each card by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    private static readonly FieldRoleWording RowTitle = new("NUI431", "The row title", "title each row",
        "Title each row with a stored Text field, and bind the calculated field as a column of the outline instead.",
        "Title each row with a stored Text field. A choice can tone each row's marker through accentFieldId instead.");

    private static readonly FieldRoleWording RowAccent = new("NUI432", "The row accent", "colour each row",
        "Colour each row by a stored single-choice field whose options carry tones.",
        "Colour each row by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    private static readonly FieldRoleWording EntryAccent = new("NUI374", "The entry accent", "colour each entry",
        "Colour each entry by a stored single-choice field whose options carry tones.",
        "Colour each entry by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    /// <summary>A stored Text field that is not a single choice, when the property is present at all.</summary>
    private static void ValidateTitleField(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        FieldRoleWording wording,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.ContainsKey("titleFieldId")) return;
        var title = HeaderField(node, "titleFieldId");
        if (title is null)
            AddError(diagnostics, wording.Code, $"{wording.Subject} must name a field.", node.NodeId, "titleFieldId",
                "Set the fieldId of an active Text field, or remove titleFieldId.");
        else if (derived.ContainsKey(title))
            AddError(diagnostics, wording.Code, $"Field '{title}' is calculated, so it cannot {wording.Verb}.", node.NodeId, "titleFieldId",
                wording.CalculatedHint);
        else if (!fields.TryGetValue(title, out var field))
            AddError(diagnostics, wording.Code, $"Field '{title}' does not exist or is retired.", node.NodeId, "titleFieldId",
                "Set the fieldId of an active Text field of this record type.");
        else if (field.StorageKind != NendoStorageKind.Text || field.Presentation == "singleChoice")
            AddError(diagnostics, wording.Code, $"Field '{title}' is {HeaderShape(field)}, so it cannot {wording.Verb}.", node.NodeId, "titleFieldId",
                wording.ShapeHint);
    }

    /// <summary>An active single-choice field, when the property is present at all.</summary>
    private static void ValidateAccentField(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        FieldRoleWording wording,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.ContainsKey("accentFieldId")) return;
        var accent = HeaderField(node, "accentFieldId");
        if (accent is null)
            AddError(diagnostics, wording.Code, $"{wording.Subject} must name a field.", node.NodeId, "accentFieldId",
                "Set the fieldId of an active single-choice field, or remove accentFieldId.");
        else if (derived.ContainsKey(accent))
            AddError(diagnostics, wording.Code, $"Field '{accent}' is calculated, so it cannot {wording.Verb}.", node.NodeId, "accentFieldId",
                wording.CalculatedHint);
        else if (!fields.TryGetValue(accent, out var field))
            AddError(diagnostics, wording.Code, $"Field '{accent}' does not exist or is retired.", node.NodeId, "accentFieldId",
                "Set the fieldId of an active single-choice field of this record type.");
        else if (field.Presentation != "singleChoice")
            AddError(diagnostics, wording.Code, $"Field '{accent}' is {HeaderShape(field)}, so it cannot {wording.Verb}.", node.NodeId, "accentFieldId",
                wording.ShapeHint);
    }

    private static string? HeaderField(NendoUiNodeSnapshot node, string propertyName) =>
        node.Properties.TryGetValue(propertyName, out var value) &&
        value.ValueKind == JsonValueKind.String &&
        !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()
            : null;

    private static string HeaderShape(NendoFieldSnapshot field) =>
        field.Presentation == "singleChoice" ? "a single choice" : $"a {field.StorageKind}";

    /// <summary>
    /// Whether the tile asks for one board column. The parent decides: `group` on
    /// anything but a direct <c>boardSurface</c> child is refused rather than
    /// resolved by an ancestor search.
    /// </summary>
    private static bool ValidateSummaryScope(
        NendoUiNodeSnapshot node,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.TryGetValue("scope", out var raw)) return false;
        var declared = raw.ValueKind == JsonValueKind.String ? raw.GetString() : null;
        if (declared is null || !NendoSemanticVocabulary.SummaryScopes.Contains(declared))
        {
            AddError(diagnostics, "NUI296", $"Summary scope '{declared ?? raw.GetRawText()}' is not supported.",
                node.NodeId, "scope",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.SummaryScopes.OrderBy(value => value, StringComparer.Ordinal))}. " +
                $"The default is {NendoSemanticVocabulary.DefaultSummaryScope}.");
            return false;
        }
        if (declared != "group") return false;
        if (scope.ParentKind == "boardSurface") return true;

        AddError(diagnostics, "NUI297",
            "A per-column summary belongs to a board column, and this tile is not a direct child of a board.",
            node.NodeId, "scope",
            "Declare scope group on a summaryTile whose parent is the boardSurface itself, or use scope " +
            $"{NendoSemanticVocabulary.DefaultSummaryScope} to count everything the surface shows.");
        return false;
    }
}
