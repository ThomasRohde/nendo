using System.Collections.ObjectModel;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// One rule for one contract version 3 node kind. The compiler validates against
/// these rules and <see cref="NendoSemanticVocabulary.Describe"/> serializes the
/// same table, so a client is never told about a kind the host does not accept.
/// </summary>
/// <param name="MaxRootsPerEntity">
/// How many roots of this kind one entity may own. Null for a kind that cannot be
/// a root. This is published rather than discovered: a record page wanting both a
/// Mark won and a Mark lost button used to meet the rule only by failing
/// validation, because nothing said the ceiling was one. Under the 2026-09-12
/// amendment the widened kinds declare eight; the record page kinds keep one, and
/// which of them a record page uses is existing precedence, not a new rule.
/// </param>
/// <param name="MaxRootsPerFile">
/// How many roots of this kind the file may own, for a root that belongs to the
/// file rather than to a record type. Null for every other kind. Under the
/// 2026-09-14 amendment's S4 entry <c>overviewSurface</c> declares one and is the
/// only kind that does: it carries no <c>entityId</c>, so there is no entity for
/// <see cref="MaxRootsPerEntity"/> to count it against, and a ceiling counted per
/// entity would have counted every file-scoped root into one nameless bucket.
/// </param>
internal sealed record NendoNodeKindRule(
    string Kind,
    IReadOnlySet<string> Properties,
    IReadOnlySet<string> RequiredProperties,
    IReadOnlySet<string> Children,
    bool CanBeRoot,
    int? MaxRootsPerEntity = null,
    int? MaxRootsPerFile = null)
{
    /// <summary>
    /// Whether this kind names the record type it reads. Every root did until the
    /// S4 overview, and every child still takes its entity from the surface it
    /// sits on unless an overview put it somewhere there is no surface entity to
    /// take.
    /// </summary>
    internal bool IsFileScopedRoot => CanBeRoot && MaxRootsPerFile is not null;
}

/// <summary>
/// The contract version 3 vocabulary accepted by ADR-0004's 2026-09-09
/// amendment. Kinds appear here only once this host compiles them; the
/// remaining amendment kinds arrive with their own slices.
/// </summary>
public static class NendoSemanticVocabulary
{
    public const int ContractVersion = 3;

    private static IReadOnlySet<string> Set(params string[] values) =>
        new HashSet<string>(values, StringComparer.Ordinal);

    internal static IReadOnlyDictionary<string, NendoNodeKindRule> Kinds { get; } =
        new ReadOnlyDictionary<string, NendoNodeKindRule>(
            new Dictionary<string, NendoNodeKindRule>(StringComparer.Ordinal)
            {
                [NendoExtensionViewDefinition.NodeKind] = new(
                    NendoExtensionViewDefinition.NodeKind,
                    Set("definitionVersion", "entityId", "title", "packageId", "packageVersion", "packageDigest",
                        "protocolVersion", "configurationVersion", "configuration", "edgeEntityId", "labelFieldId",
                        "sourceFieldId", "targetFieldId", "statusFieldId"),
                    Set("definitionVersion", "entityId", "title", "packageId", "packageVersion", "packageDigest",
                        "protocolVersion", "configurationVersion", "configuration", "edgeEntityId", "labelFieldId",
                        "sourceFieldId", "targetFieldId"),
                    Set(), CanBeRoot: true, MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                ["recordForm"] = new(
                    "recordForm",
                    Set("definitionVersion", "entityId", "title"),
                    Set("definitionVersion", "entityId"),
                    Set("section", "tabGroup", "fieldBinding", "recordCommand"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: 1),
                ["recordList"] = new(
                    "recordList",
                    Set("definitionVersion", "entityId", "title", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId"),
                    Set("fieldBinding", "filterClause", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                ["boardSurface"] = new(
                    "boardSurface",
                    Set("definitionVersion", "entityId", "title", "groupByFieldId", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId", "groupByFieldId"),
                    Set("fieldBinding", "filterClause", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // Two crossed choice dimensions, ADR-0004 2026-09-17 amendment (S6). A board
                // with a second axis: one bounded window placed into cells, and one grouped
                // read answering every cell of the cross product exactly. It counts and takes
                // no aggregate, because a cell states its number beside the cards it holds and
                // "showing 4 of 17" is only a sentence about counting.
                ["matrixSurface"] = new(
                    "matrixSurface",
                    Set("definitionVersion", "entityId", "title", "rowByFieldId", "columnByFieldId", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId", "rowByFieldId", "columnByFieldId"),
                    Set("fieldBinding", "filterClause", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // A month of one Date field, plus its own undated view. DateTime,
                // time zones, week and day scheduling, duration, recurrence and
                // drag-to-date are deferred: a due-date calendar is useful
                // without inventing time semantics for it.
                ["calendarSurface"] = new(
                    "calendarSurface",
                    Set("definitionVersion", "entityId", "title", "dateFieldId", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId", "dateFieldId"),
                    Set("fieldBinding", "filterClause"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // Records on a spine by one Date field, one civil year at a time,
                // with an optional end date that turns an entry into a span
                // (ADR-0004 2026-09-14 amendment, S3). Placement is by the start
                // date only: an overlap query needs an OR the closed clause set
                // has not got, so a span that began earlier is on that year's spine.
                ["timelineSurface"] = new(
                    "timelineSurface",
                    Set("definitionVersion", "entityId", "title", "dateFieldId", "endDateFieldId", "titleFieldId", "accentFieldId", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId", "dateFieldId"),
                    Set("fieldBinding", "filterClause"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // A card per record, over exactly a list's bounded window (ADR-0004
                // 2026-09-14 amendment, S2). Cards are typographic because there are no
                // image fields: the title leads, the accent option tones the card's edge,
                // and the bound fields are the body. It takes the tiles and charts a list
                // takes, in the same row above the grid.
                ["gallerySurface"] = new(
                    "gallerySurface",
                    Set("definitionVersion", "entityId", "title", "titleFieldId", "accentFieldId", "orderByFieldId", "orderDirection"),
                    Set("definitionVersion", "entityId"),
                    Set("fieldBinding", "filterClause", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // The file's front page (ADR-0004 2026-09-14 amendment, S4). The first
                // root that belongs to the file rather than to a record type: it carries
                // no entityId, so every tile, chart and recent list under it names the
                // record type it reads. It composes nothing across those types — an
                // overview is several bounded reads side by side, each spending its own
                // budget over the one type it names.
                ["overviewSurface"] = new(
                    "overviewSurface",
                    Set("definitionVersion", "title", "description"),
                    Set("definitionVersion"),
                    Set("section", "tabGroup", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid", "recentList", "rankedList"),
                    CanBeRoot: true,
                    MaxRootsPerFile: MaximumOverviewRootsPerFile),
                // A short ordered window of one record type, for an overview that wants
                // to show the last few of something rather than count it.
                ["recentList"] = new(
                    "recentList",
                    Set("entityId", "title", "limit", "orderByFieldId", "orderDirection"),
                    Set("entityId"),
                    Set("fieldBinding", "filterClause"),
                    CanBeRoot: false),
                // The few records at the top of one stored number, ADR-0004 2026-09-17
                // amendment (S6). It is a recentList ordered by size rather than by recency:
                // rank numerals and a bar against the exact largest. A record with no number
                // is not ranked, so the host adds one predicate of its own and the author
                // carries seven clauses rather than eight.
                ["rankedList"] = new(
                    "rankedList",
                    Set("entityId", "rankByFieldId", "orderDirection", "limit", "title"),
                    Set("entityId", "rankByFieldId"),
                    Set("fieldBinding", "filterClause"),
                    CanBeRoot: false),
                // Both ends of one field, from the two exact aggregates min and max. Not
                // a chart: it has no grouping, so it is not drawn as proportion and has
                // nothing to drill into. A Date is ordered by comparison, which is why
                // this is the one tile that reads one.
                ["rangeTile"] = new(
                    "rangeTile",
                    Set("entityId", "fieldId", "title", "scope"),
                    Set("fieldId"),
                    Set("filterClause"),
                    CanBeRoot: false),
                ["recordCommand"] = new(
                    "recordCommand",
                    Set("definitionVersion", "entityId", "label"),
                    Set("definitionVersion", "entityId", "label"),
                    Set("commandStep"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: MaximumRootsPerKindPerEntity),
                // The first charts, ADR-0004 2026-09-14 amendment (S1). Both are tiles
                // in the sense a summaryTile is: accepted where it is accepted, scoped
                // as it is scoped, and read over the records that scope covers.
                // entityId on a tile or a chart is the S4 addition: required under an
                // overview, which has no record type of its own to lend one, and refused
                // anywhere else, where it could only disagree with the surface it sits on.
                ["breakdownChart"] = new(
                    "breakdownChart",
                    Set("entityId", "groupByFieldId", "aggregate", "fieldId", "title", "scope"),
                    Set("groupByFieldId", "aggregate"),
                    Set("filterClause"),
                    CanBeRoot: false),
                ["progressTile"] = new(
                    "progressTile",
                    Set("entityId", "title"),
                    Set(),
                    Set("filterClause"),
                    CanBeRoot: false),
                // Over time, ADR-0004 2026-09-16 amendment (S5). The first groupings whose
                // groups are not knowable from the definition: a choice field's options are
                // written down and a month is not, so the host generates the buckets from
                // the range it resolves and fills them from the read. A bucket with nothing
                // in it is therefore a bucket — the shape a person sees is the shape of the
                // range, not the shape of the data that happens to exist.
                //
                // range is a closed word the host resolves when it reads, as today already
                // is, so a stored definition never carries a date and never goes stale.
                // Neither reads a DateTime: truncating one to its date means picking a time
                // zone this product has not chosen, so it is refused by name.
                ["trendChart"] = new(
                    "trendChart",
                    Set("entityId", "dateFieldId", "bucket", "range", "aggregate", "fieldId", "title", "scope"),
                    Set("dateFieldId", "bucket", "range", "aggregate"),
                    Set("filterClause"),
                    CanBeRoot: false),
                // One count per day over a year, drawn as toned squares. It counts and takes
                // no aggregate or fieldId at all: a square toned by a sum is a heat map of
                // something a person cannot recover from the square.
                ["activityGrid"] = new(
                    "activityGrid",
                    Set("entityId", "dateFieldId", "range", "title", "scope"),
                    Set("dateFieldId", "range"),
                    Set("filterClause"),
                    CanBeRoot: false),
                ["summaryTile"] = new(
                    "summaryTile",
                    Set("entityId", "aggregate", "title", "fieldId", "scope"),
                    Set("aggregate"),
                    Set("filterClause"),
                    CanBeRoot: false),
                ["commandStep"] = new(
                    "commandStep",
                    Set("fieldId", "valueKind", "value"),
                    Set("fieldId", "valueKind"),
                    Set(),
                    CanBeRoot: false),
                ["detailSurface"] = new(
                    "detailSurface",
                    Set("definitionVersion", "entityId", "title", "titleFieldId", "subtitleFieldId", "accentFieldId"),
                    Set("definitionVersion", "entityId"),
                    Set("section", "tabGroup", "fieldBinding", "relatedList", "recordCommand", "summaryTile", "breakdownChart",
                        "progressTile", "rangeTile", "trendChart", "activityGrid"),
                    CanBeRoot: true,
                    MaxRootsPerEntity: 1),
                ["relatedList"] = new(
                    "relatedList",
                    Set("targetEntityId", "viaFieldId", "title", "orderByFieldId", "orderDirection"),
                    Set("targetEntityId", "viaFieldId"),
                    // A chart inside a related list is not drawn in S1, so it is not
                    // accepted there rather than compiled and silently missing.
                    Set("fieldBinding", "filterClause", "summaryTile"),
                    CanBeRoot: false),
                ["section"] = new(
                    "section",
                    Set("title", "visibleWhen", "opens"),
                    Set("title"),
                    Set("section", "tabGroup", "fieldBinding", "relatedList", "summaryTile", "breakdownChart", "progressTile",
                        "rangeTile", "trendChart", "activityGrid", "recentList", "rankedList"),
                    CanBeRoot: false),
                // Tabs organise named record information. They contain sections
                // and nothing else, so a tab is always a titled section and the
                // group cannot become a general layout API.
                ["tabGroup"] = new(
                    "tabGroup",
                    Set("title"),
                    Set(),
                    Set("section"),
                    CanBeRoot: false),
                ["filterClause"] = new(
                    "filterClause",
                    Set("fieldId", "operator", "valueKind", "value"),
                    Set("fieldId", "operator"),
                    Set(),
                    CanBeRoot: false),
                // visibleWhen names a Boolean calculated field of the record type in
                // context. It decides what is on screen and nothing else: the field is
                // still part of the form, still saved, and Studio still shows it.
                ["fieldBinding"] = new(
                    "fieldBinding",
                    Set("fieldId", "visibleWhen"),
                    Set("fieldId"),
                    Set(),
                    CanBeRoot: false),
            });

    /// <summary>
    /// Closed filter operators. The durable contract keeps `lte` and `gte`; the
    /// internal record query spells the same comparisons `le` and `ge`.
    /// </summary>
    internal static IReadOnlySet<string> FilterOperators { get; } =
        Set("eq", "ne", "lt", "lte", "gt", "gte", "isNull", "isNotNull");

    /// <summary>Closed value vocabulary, shared with a command step.</summary>
    internal static IReadOnlySet<string> ValueKinds { get; } = Set("literal", "today", "now", "null");

    /// <summary>
    /// How a <c>trendChart</c> divides its range. Closed to the two the amendment names:
    /// a month and a week are the two a person reads without being taught the axis.
    /// </summary>
    internal static IReadOnlySet<string> TrendBuckets { get; } = Set("month", "week");

    /// <summary>
    /// The stretch of time a <c>trendChart</c> covers, as a closed word the host resolves
    /// to civil-date bounds when it reads. Never a stored date: a definition written in
    /// January would otherwise still mean January in December.
    /// </summary>
    internal static IReadOnlySet<string> TrendRanges { get; } =
        Set("last12Months", "last6Months", "last90Days", "last30Days");

    /// <summary>
    /// The same for an <c>activityGrid</c>, and deliberately a different set: a grid draws
    /// one square per day and is bounded by <see cref="MaximumAggregateGroups"/>, so only
    /// the two year-shaped ranges fit it.
    /// </summary>
    internal static IReadOnlySet<string> ActivityRanges { get; } = Set("thisYear", "lastTwelveMonths");

    internal static IReadOnlySet<string> OrderDirections { get; } = Set("ascending", "descending");

    /// <summary>
    /// What a tile on a list or board counts. `surface` is the whole filtered set
    /// the surface shows, independent of which page is loaded. `group` is one
    /// board column, and only a direct child of a <c>boardSurface</c> may declare
    /// it: there is no ancestor search, because a tile three sections deep inside
    /// something else has no column to belong to.
    /// </summary>
    internal static IReadOnlySet<string> SummaryScopes { get; } = Set("surface", "group");

    internal const string DefaultSummaryScope = "surface";

    /// <summary>
    /// How a section starts, ADR-0004 2026-09-20 amendment. Every section can be folded
    /// away by the person reading it; this is the one thing an author says about it,
    /// and what the person has done since never reaches the file. A tab's body neither
    /// folds nor takes it.
    /// </summary>
    internal static IReadOnlySet<string> SectionOpens { get; } = Set("open", "closed");

    internal const string DefaultSectionOpens = "open";

    /// <summary>
    /// The colours a choice option may carry, ADR-0004 2026-09-14 amendment. Eight
    /// named hues: enough to tell five board columns apart, few enough to stay one
    /// palette across every surface an agent builds. A tone is a semantic token in
    /// the sense a field presentation is — the renderer owns the Light and Dark
    /// colours behind it — so a file never stores a hex value.
    /// </summary>
    internal static IReadOnlySet<string> ChoiceTones { get; } =
        Set("red", "orange", "amber", "green", "teal", "blue", "violet", "grey");

    /// <summary>The tones in their published order, which is also the order a picker offers them.</summary>
    internal static IReadOnlyList<string> ChoiceToneOrder { get; } =
        ["red", "orange", "amber", "green", "teal", "blue", "violet", "grey"];

    /// <summary>
    /// The properties whose value is not what their name suggests, explained once
    /// where the kinds are published. A review guessed visibleWhen's value as the
    /// calculation's definitionId; the refusal corrected it, one round trip late.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> PropertyNoteTable { get; } = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["visibleWhen"] = "The fieldId of a calculated field on this record type whose result is Boolean — not its definitionId, " +
            "and not a stored field. Only a definite false hides the node; Studio never reads it.",
        ["opens"] = "How a section starts on the page: open, which it is when the property is absent, or closed. Every section " +
            "can be folded away by the person reading it and opened again, and what they do is never stored; this is the one " +
            "thing an author says about it. A closed section reads nothing until it is opened. Refused on a tab's body " +
            "(NUI313), where the tab strip already opens and closes it, and on every kind but section.",
        ["fieldId"] = "A stored or calculated field of the surface's record type. On a fieldBinding a calculated field is shown, " +
            "never edited; a filterClause, orderByFieldId, groupByFieldId, dateFieldId, endDateFieldId or summaryTile names a stored field only. " +
            "On a rangeTile it is the stored Integer, Decimal or Date field whose smallest and largest value the strip states; a Date is " +
            "ordered by comparison, which is why a range reads one where a sum does not.",
        ["entityId"] = "On a root, the record type the surface is about. An overviewSurface has none: it belongs to the file, so each " +
            "summaryTile, breakdownChart, progressTile, rangeTile, trendChart, activityGrid, recentList and rankedList under it names its own record type instead, and that " +
            "property is required there. Anywhere else a tile takes its record type from the surface it sits on, and declaring one is " +
            "refused rather than resolved, because a tile that disagreed with its surface would have two answers.",
        ["packageId"] = "On an extensionGraphSurface, the exact lowercase namespaced package ID. The file carries a reference, never package code or execution consent.",
        ["packageVersion"] = "The exact semantic version of the separately installed offline custom-view package. No ranges or automatic updates.",
        ["packageDigest"] = "Lowercase SHA-256 of the exact package archive. Changing this pin invalidates device execution consent.",
        ["protocolVersion"] = "Positive custom-view protocol version. This host executes version 1; future versions are preserved with a disabled fallback.",
        ["configurationVersion"] = "Positive version of the bounded custom-view configuration. This host executes version 1 only.",
        ["configuration"] = "JSON text containing an object, at most 8192 UTF-8 bytes and depth 8. Version 1 requires an empty object. Future versions are retained without interpretation or execution.",
        ["edgeEntityId"] = "The active record type holding graph edges, with two distinct configured References to this surface's node entity.",
        ["labelFieldId"] = "The active stored Text field disclosed as each graph node's label.",
        ["sourceFieldId"] = "The edge type's Reference to the source node. Must differ from targetFieldId.",
        ["targetFieldId"] = "The edge type's Reference to the target node. Both graph References must target entityId.",
        ["statusFieldId"] = "Optional active stored scalar disclosed as exact text on graph nodes. References and calculations are refused.",
        ["description"] = "On an overviewSurface, prose drawn under the title saying what this file is for. Plain text the author " +
            "writes: not markup, not a template, and never a field reference. Optional, and absent rather than invented when it is not set.",
        ["limit"] = "On a recentList or a rankedList, how many records it shows, from one up to that kind's published ceiling — ten " +
            "for a recent list and fifty for a ranking. Refused above it rather than clamped, so the stored definition and the " +
            "screen cannot say different things. Without it the list shows the ceiling.",
        ["bucket"] = "On a trendChart, how the range is divided: month or week, and nothing else. Both are read off the axis without " +
            "being taught it; a day bucket over a year is an activityGrid, which draws it as squares rather than as columns.",
        ["range"] = "On a trendChart or an activityGrid, the stretch of time it covers, as a closed word the host resolves to civil-date " +
            "bounds each time it reads. A trendChart takes last12Months, last6Months, last90Days or last30Days; an activityGrid takes " +
            "thisYear or lastTwelveMonths, because it draws one square per day and must fit the published group ceiling. It is never a " +
            "stored date and there is no literal alternative: a definition written in January would otherwise still mean January in December.",
        ["titleFieldId"] = "On a detailSurface, the stored Text field whose value heads the record page. Optional; the page " +
            "is unchanged without it. Neither a single-choice field nor a calculated field can be the title. " +
            "On a timelineSurface, the stored Text field whose value titles each entry; without it the first bound field does. " +
            "On a gallerySurface, the same for each card.",
        ["subtitleFieldId"] = "On a detailSurface, a stored or calculated field shown under the page title. It must differ from titleFieldId.",
        ["accentFieldId"] = "On a detailSurface, a single-choice field whose option colours the page header with that option's tone. " +
            "On a timelineSurface, the single-choice field whose option tones each entry's dot. " +
            "On a gallerySurface, the single-choice field whose option tones each card's edge.",
        ["dateFieldId"] = "On a calendarSurface or a timelineSurface, the active Date field that places each record. On a trendChart " +
            "or an activityGrid, the active Date field whose value decides which bucket a record counts in. A DateTime is " +
            "refused by name: placing one on a civil date means choosing a time zone to group by, which this contract version does not define.",
        ["endDateFieldId"] = "On a timelineSurface, an active Date field other than dateFieldId. A record with both is drawn as a span " +
            "from its start date; an end before the start is stated on the entry as a data issue; and placement stays by dateFieldId, " +
            "so a span that began in an earlier year is on that year's spine.",
        ["tone"] = "On schema.setChoiceMetadata, one of choiceTones, or null for no colour. The operation sets the whole of an " +
            "option's metadata, so read the schema first: a rename that omits the tone clears it. Never a hex value.",
        ["min"] = "On schema.addField with presentation rating, the lowest value of the scale, paired with max. Both are required " +
            "for a rating, refused on every other presentation, and set once: a scale is part of how the field is drawn, as a " +
            "presentation is, and neither changes after the field exists.",
        ["max"] = "On schema.addField with presentation rating, the highest value of the scale. The span counts both ends and is at " +
            "most ten values. A stored number outside the scale is read back as itself and stated as a data issue; it is never " +
            "refused on write and never drawn as a count nobody chose.",
        ["rowByFieldId"] = "On a matrixSurface, the single-choice or Boolean field whose values are the rows. It is not a filter " +
            "and spends none of the filter budget, and it must differ from columnByFieldId: a field against itself is a diagonal " +
            "with empty corners. A calculated field cannot be an axis, as it cannot group.",
        ["columnByFieldId"] = "On a matrixSurface, the same for the columns. The two option sets multiply, and the product plus an " +
            "unset lane on each axis must fit the published group ceiling, so the widest honest grid is about nineteen by nineteen.",
        ["rankByFieldId"] = "On a rankedList, the active stored Integer or Decimal field the ranking is by, largest first unless " +
            "orderDirection says otherwise. A Date is refused by name: min and max over a Date are comparisons, and a bar is " +
            "arithmetic. A record with no value there is not ranked, and that predicate is one the host adds.",
        ["groupByFieldId"] = "On a boardSurface, the single-choice field whose options are the columns, or a bound Reference " +
            "field whose target records are the columns, ordered by the reference's label field. A reference board draws every " +
            "active record of the target type, because an empty lane is an answer, and refuses to draw at all above " +
            $"{MaximumReferenceBoardColumns} of them, naming the type and its count — it is a read-time bound, because a " +
            "definition cannot know how many records a record type holds. An unbound reference is refused when it is authored. " +
            "On a breakdownChart, the single-choice or Boolean field whose values are the groups; it is not a filter and spends " +
            "none of the filter budget. A calculated field cannot group either.",
    };

    /// <summary>
    /// The ceiling on the filters one bounded query may carry, including the ones
    /// the host adds itself. Published because composition is what spends it: a
    /// board column tile pays for the board's clauses, its own, and the column
    /// predicate, and an author who met the ceiling two-thirds of the way through
    /// a build had no way to plan around it.
    /// </summary>
    internal const int MaximumEffectiveFilters = 8;

    /// <summary>
    /// How many roots of one widened kind an entity may own. A bounded initial
    /// product choice under the 2026-09-12 amendment, not a measured optimum: an
    /// application with a Mark won and a Mark lost button, or an Open and a Closed
    /// list, is ordinary, and one of each was a ceiling nothing stated.
    /// </summary>
    internal const int MaximumRootsPerKindPerEntity = 8;

    /// <summary>
    /// How many overview roots one file may own. One to begin with, under the
    /// 2026-09-14 amendment's S4 entry: several would need a file-level selector
    /// that nothing else needs yet, and a front page a person has to choose
    /// between is not a front page.
    /// </summary>
    internal const int MaximumOverviewRootsPerFile = 1;

    /// <summary>
    /// How many records a <c>recentList</c> shows. Declared on the node and
    /// refused above this rather than clamped: a silently narrowed limit would
    /// make the stored definition and the screen say different things.
    /// </summary>
    internal const int MaximumRecentListRows = 10;

    /// <summary>
    /// How many records a <c>rankedList</c> ranks. Five times a recent list, because a
    /// leaderboard is read as a whole where a recent list is read as the last few, and
    /// refused above this rather than clamped for the same reason.
    /// </summary>
    internal const int MaximumRankedListRows = 50;

    /// <summary>
    /// How many groups one grouped aggregate answers, the unset group included. A
    /// choice field's options and a Boolean's two values sit far inside it; the
    /// ceiling is published now so the day buckets of a later slice have a stated
    /// bound rather than a new rule.
    /// </summary>
    internal const int MaximumAggregateGroups = 366;

    /// <summary>
    /// How many columns a board grouped by a reference draws (ADR-0004, 2026-09-17 amendment,
    /// S7). Above it the board draws nothing at all and states the target type, its record
    /// count and this number, rather than drawing the first few — a board missing its last
    /// lanes looks exactly like a board.
    /// <para>
    /// The bound is read-time only, which is the one place this departs from the grid ceiling
    /// it is modelled on. A grid is refused when it is authored because a definition carries
    /// both option sets; a definition cannot carry how many records a record type holds, so
    /// there is nothing to refuse until something reads.
    /// </para>
    /// <para>
    /// Twenty-four because a board places one bounded window of records client-side: at
    /// twenty-four lanes that window averages two cards a lane and at forty it averages one,
    /// and past that the sideways scroll is the interface rather than the board.
    /// </para>
    /// </summary>
    internal const int MaximumReferenceBoardColumns = 24;

    /// <summary>The field kinds that close the groups of a chart.</summary>
    internal static IReadOnlyList<string> ChartGroupings { get; } = ["singleChoice", "boolean"];

    /// <summary>
    /// How each context composes its effective filters. Generated into the
    /// published description, and read by the compiler's budget check, so the
    /// stated rule and the rule that refuses cannot drift.
    /// </summary>
    internal static IReadOnlyList<NendoEffectiveFilterContext> EffectiveFilterContexts { get; } =
    [
        new("List, board, gallery or matrix window", "the surface's own filterClause children"),
        new("Surface tile", "the surface's clauses plus the tile's own"),
        new("Board column tile", "the board's clauses, the tile's own, and one column predicate"),
        new("Related list, and a tile inside one",
            "the relation's clauses, the tile's own if there is one, and one reference predicate"),
        new("Calendar month or undated view",
            "the calendar's clauses plus two date-bound predicates, so at most six declared clauses"),
        new("Timeline year or undated view",
            "the timeline's clauses plus two date-bound predicates, so at most six declared clauses"),
        new("Record page tile", "the tile's own clauses, over the whole record type"),
        new("Overview tile, chart or recent list",
            "its own clauses, over the whole record type it names; an overview adds no predicate of its own"),
        new("Chart on a surface", "the surface's clauses plus the chart's own; the grouping is not a filter"),
        new("Board column chart", "the board's clauses, the chart's own, and one column predicate"),
        new("Trend chart or activity grid",
            "the clauses of wherever it sits, as for a chart there, plus the two date bounds of its range, so two fewer declared clauses"),
        new("Ranked list", "its own clauses plus one predicate keeping the records that have a number to rank, so at most seven declared clauses"),
        new("Progress ring", "its own clauses over its scope for the numerator, and the scope alone for the denominator, as two counts"),
    ];

    /// <summary>
    /// Aggregates this host computes exactly. `count` is exact over any filtered
    /// set. `sum`, `min` and `max` are exact over an integer or decimal field:
    /// the host folds the stored lexemes itself rather than asking SQLite, which
    /// would coerce a `nendo.decimal:` string to zero. See
    /// <see cref="ExactAggregate"/>.
    /// <para>
    /// `avg` is refused by name under the 2026-09-10 ADR-0004 amendment. The mean
    /// of exact decimals is not generally an exact decimal — three values summing
    /// to 1 have no exact mean — so accepting it would put the one rounded number
    /// on a record page full of exact ones. It needs its own contract change
    /// declaring a scale and a rounding rule.
    /// </para>
    /// </summary>
    internal static IReadOnlySet<string> Aggregates { get; } = Set("count", "sum", "min", "max");

    /// <summary>The aggregates that read one numeric field, so require `fieldId`.</summary>
    internal static IReadOnlySet<string> NumericAggregates { get; } = Set("sum", "min", "max");

    /// <summary>
    /// Named refusals. An aggregate here is rejected with its own reason rather
    /// than the generic "not supported" list, because an author who asks for it
    /// is owed the reason it cannot be exact.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> RefusedAggregates { get; } =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["avg"] = "The mean of exact decimals is not generally an exact decimal, and this host does not put a rounded number on a record page. Use sum with count.",
        };

    internal static string QueryOperatorFor(string contractOperator) => contractOperator switch
    {
        "lte" => "le",
        "gte" => "ge",
        _ => contractOperator,
    };

    /// <summary>
    /// How sibling <c>filterClause</c> children combine, published rather than
    /// left to be inferred. An author who declared two clauses intending AND had
    /// no way to confirm it from the interface, and no way to express anything
    /// else either.
    /// </summary>
    internal static NendoFilterCombinatorDescription FilterCombinator { get; } = new(
        "and",
        "Every filterClause child of one surface, board or related list must hold for a record to appear: " +
        "siblings are ANDed. Contract version 3 has no OR and no grouping, so a condition that needs either " +
        "cannot be expressed here; narrow it with a stored field instead.");

    /// <summary>
    /// The hint a cardinality refusal carries, generated from the same table the
    /// refusal is taken from. The grammar follows the number: a ceiling of one
    /// and a ceiling of eight do not read the same, and a hint that says "more
    /// than one" against a table that permits eight is worse than no hint. A kind
    /// that may be nested names where, because with a ceiling above one that is
    /// no longer the first remedy but it is still a real one.
    /// </summary>
    internal static string RootCardinalityHint(string kind)
    {
        if (Kinds.TryGetValue(kind, out var fileScoped) && fileScoped.MaxRootsPerFile is { } perFile)
        {
            return perFile == 1
                ? $"A file owns at most one {kind} root. It belongs to the file rather than to a record type, so a second one is " +
                  "not a second view of anything — remove or replace the one that is there."
                : $"A file owns at most {perFile} {kind} roots.";
        }
        if (!Kinds.TryGetValue(kind, out var rule) || rule.MaxRootsPerEntity is not { } maximum)
        {
            return "Keep one root of each kind per entity.";
        }
        var parents = Kinds.Values
            .Where(candidate => candidate.Children.Contains(kind))
            .Select(candidate => candidate.Kind)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        var ceiling = maximum == 1
            ? $"An entity owns at most one {kind} root."
            : $"An entity owns at most {maximum} {kind} roots.";
        return parents.Length == 0
            ? ceiling
            : $"{ceiling} Nest a further one inside a {string.Join(" or ", parents)} on the same entity, where it is " +
              (kind == "recordCommand"
                  ? "accepted and still receives the commandId execute_command takes."
                  : "accepted as a child rather than a root.");
    }

    /// <summary>
    /// A deterministic machine-readable description of the accepted vocabulary,
    /// generated from <see cref="Kinds"/>. An authoring client reads this rather
    /// than discovering the contract by probing unknown kinds.
    /// </summary>
    public static string Describe() => JsonSerializer.Serialize(Description(), NendoRenderPlanJson.Options);

    /// <summary>The same description as a value, for adapters that serialize it themselves.</summary>
    public static NendoVocabularyDescription Description()
    {
        return new NendoVocabularyDescription(
            ContractVersion,
            NendoAuthoringLimits.Current,
            [.. FilterOperators.OrderBy(value => value, StringComparer.Ordinal)],
            [.. ValueKinds.OrderBy(value => value, StringComparer.Ordinal)],
            [.. OrderDirections.OrderBy(value => value, StringComparer.Ordinal)],
            [.. Aggregates.OrderBy(value => value, StringComparer.Ordinal)],
            RefusedAggregates.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => new NendoRefusedAggregateDescription(pair.Key, pair.Value))
                .ToArray(),
            Kinds.Values
                .OrderBy(rule => rule.Kind, StringComparer.Ordinal)
                .Select(rule => new NendoNodeKindDescription(
                    rule.Kind,
                    rule.CanBeRoot,
                    [.. rule.Properties.OrderBy(value => value, StringComparer.Ordinal)],
                    [.. rule.RequiredProperties.OrderBy(value => value, StringComparer.Ordinal)],
                    [.. rule.Children.OrderBy(value => value, StringComparer.Ordinal)])
                {
                    MaxRootsPerEntity = rule.MaxRootsPerEntity,
                    MaxRootsPerFile = rule.MaxRootsPerFile,
                    RootCardinality = rule.CanBeRoot ? RootCardinalityHint(rule.Kind) : null,
                })
                .ToArray())
        {
            FilterClauses = FilterCombinator,
            SummaryScopes = new NendoSummaryScopeDescription(
                [.. SummaryScopes.OrderBy(value => value, StringComparer.Ordinal)],
                DefaultSummaryScope,
                "A summaryTile on a recordList or boardSurface states one exact number over the records that " +
                "surface shows, independent of which page is loaded. scope group narrows it to one board column " +
                "and is accepted only on a direct child of a boardSurface; anywhere else it is refused rather " +
                "than resolved by searching for an ancestor board. A tile on a record page keeps its existing " +
                "meaning and takes no scope."),
            SectionOpens = new NendoSectionOpensDescription(
                [.. SectionOpens.OrderBy(value => value, StringComparer.Ordinal)],
                DefaultSectionOpens,
                "Every section on a record page or the front page can be folded away by the person reading it and " +
                "opened again; nothing is authored for that, and what they do is never stored. opens is the one thing " +
                "an author says: how the section starts. A closed section reads none of its tiles, charts, lists or " +
                "relations until it is opened. A tab's body neither folds nor takes opens (NUI313)."),
            Behaviour = NendoBehaviourVocabulary.Description(),
            PropertyNotes = PropertyNoteTable,
            Charts = new NendoChartDescription(
                ChartGroupings,
                MaximumAggregateGroups,
                "A breakdownChart states one exact number per group of a closed grouping — a single-choice field's " +
                "options in their configured order, or false and true for a Boolean — plus the unset group, over the " +
                "records its scope covers; the grouping is not a filter. A progressTile states the records matching its " +
                "own filterClause children over everything its scope covers, and needs at least one. Both take the " +
                "scope a summaryTile takes and are accepted where it is. Every number is exact or absent; a value stored " +
                "outside the options is counted apart, never drawn as a group. The renderer shows the numbers beside the " +
                "shape and a table of them behind one toggle."),
            Overview = new NendoOverviewDescription(
                MaximumOverviewRootsPerFile,
                MaximumRecentListRows,
                "An overviewSurface is the file's front page and the one root with no entityId: it belongs to the file, " +
                "so every tile, chart and recentList under it names the record type it reads, and that entityId is " +
                "required there and refused anywhere else. It composes nothing across record types — no join, no number " +
                "made from two of them — and adds no predicate of its own, so each child spends its own filter budget " +
                "over the one type it names. A recentList shows up to the stated number of records in a declared order; " +
                "above it the definition is refused rather than narrowed. A rangeTile is not a chart: it has no grouping, " +
                "states the min and the max of one Integer, Decimal or Date field, and says so when the set is empty " +
                "rather than drawing zero to zero."),
            OverTime = new NendoOverTimeDescription(
                [.. TrendBuckets.OrderBy(value => value, StringComparer.Ordinal)],
                [.. TrendRanges.OrderBy(value => value, StringComparer.Ordinal)],
                [.. ActivityRanges.OrderBy(value => value, StringComparer.Ordinal)],
                "A trendChart states one exact number per bucket of a range, and an activityGrid one exact count per " +
                "day of one. Their groups are generated from the range rather than read from a field, so a bucket with " +
                "no records in it is stated as empty and drawn as a gap at zero or as the lightest tone — a month with " +
                "nothing is never a missing month. range is a closed word resolved to civil-date bounds each time the " +
                "host reads, never a stored date and with no literal alternative, so a definition does not go stale. " +
                "dateFieldId is a stored Date field and a DateTime is refused by name rather than truncated. An " +
                "activityGrid counts only and takes no aggregate or fieldId. Both are bounded by the same published " +
                "group ceiling as every other grouped read, which a day grid over a leap year meets exactly. A " +
                "trendChart or an activityGrid takes two fewer authored filterClause children than the effective " +
                "budget, because the host adds the two bounds of its range to it; in a board column it takes the " +
                "column predicate as well."),
            Boards = new NendoBoardDescription(
                MaximumReferenceBoardColumns,
                "A boardSurface groups by a single-choice field, whose options are its columns, or by a bound Reference " +
                "field, whose target records are. A reference board's columns are every active record of the target " +
                "type, ordered by the reference's label field ascending \u2014 not only the records something points at, " +
                "because an empty lane is an answer and because which records are pointed at could only be read from " +
                "the board's own loaded window. orderDirection orders the cards in a lane and never the lanes. A " +
                "reference column carries no tone, because a tone is something an author arranged on an option and a " +
                "record has nowhere to hold one. Above the stated ceiling the board draws no columns at all and names " +
                "the target type, its record count and the ceiling: it is a read-time bound, because a definition " +
                "cannot know how many records a record type holds, and it is all or nothing, because a board missing " +
                "its last lanes looks exactly like a board. An unbound Reference field is refused when it is authored. " +
                "A card dragged between reference columns writes the grouping field with the target record's current " +
                "version, which the board holds because it read the target type to draw them.",
                NendoFormat.ReferenceBoardMinimumHostVersion),
            Grids = new NendoGridDescription(
                MaximumAggregateGroups,
                MaximumRankedListRows,
                "A matrixSurface crosses two closed groupings and states one exact count in every cell. The cells are " +
                "the cross product of the two option sets, each axis carrying its own unset lane, and every one of them " +
                "is produced before a record is read \u2014 so a cell with nothing in it is stated as empty rather than left " +
                "out, exactly as an empty month is. The whole grid is one read whatever its size, which is why each " +
                "cell's number is exact over everything the surface covers while the cards inside it are the surface's " +
                "one loaded window; a cell states both. The two axes must be different fields, neither is a filter, and " +
                "the cross product plus an unset lane on each axis must fit the published group ceiling. Rows and " +
                "columns are the field's options less the ones the surface's own eq and ne clauses exclude, as a board's " +
                "columns are; an unset lane is drawn only when its exact number is not zero, because nobody arranged it. " +
                "A rankedList states the few records at the top of one stored Integer or Decimal field, each with a bar " +
                "against the exact largest; a Date is refused by name, because min and max over a Date are comparisons " +
                "and a bar is arithmetic. A record with no value there is not ranked, and that predicate is one the host " +
                "adds, so a ranking carries one fewer authored filterClause child than the effective budget. Equal " +
                "numbers share a rank numeral and the next numeral skips; the limit is a limit on rows, so a tie " +
                "straddling it is cut. When the largest value is not greater than zero no bars are drawn at all and " +
                "every row states its number."),
            ChoiceTones = new NendoChoiceToneDescription(
                [.. ChoiceToneOrder],
                "A choice option may carry one of these as its tone, set with schema.setChoiceMetadata. It colours the " +
                "option's board column, chips, list dots and any record page whose accentFieldId is the field. The " +
                "renderer owns the Light and Dark colours behind each name; a hex value is refused."),
            EffectiveFilters = new NendoEffectiveFilterBudget(
                MaximumEffectiveFilters,
                EffectiveFilterContexts,
                "One bounded query carries at most this many filters, counting the ones the host adds itself. " +
                "A definition over the ceiling is refused with the node and the property path; the host never " +
                "drops a clause, widens the query or raises the limit as a convenience."),
        };
    }
}

/// <summary>
/// What a list or board tile counts, and where the per-column value may be asked
/// for. Published because the restriction is contextual: the parent decides
/// whether a property is accepted, which a flat kind table cannot say.
/// </summary>
public sealed record NendoSummaryScopeDescription(
    IReadOnlyList<string> Values,
    string Default,
    string Note);

/// <summary>How a section may say it starts, and what it means that every section folds.</summary>
public sealed record NendoSectionOpensDescription(
    IReadOnlyList<string> Values,
    string Default,
    string Note);

/// <summary>
/// The colours a choice option may carry. Published because an author who guessed a
/// hex value, or "gray", would otherwise learn the closed set one refusal late.
/// </summary>
public sealed record NendoChoiceToneDescription(IReadOnlyList<string> Values, string Note);

/// <summary>
/// The rules a chart is drawn under. Published so an author knows which fields
/// close a grouping and what the numbers mean before the first refusal says so.
/// </summary>
public sealed record NendoChartDescription(IReadOnlyList<string> Groupings, int MaximumGroups, string Note);

/// <summary>
/// What the file's front page is, and the two bounds it carries. Published beside
/// the chart rules because an overview's children look like a list's tiles and are
/// scoped by a different rule.
/// </summary>
public sealed record NendoOverviewDescription(int MaximumRootsPerFile, int MaximumRecentListRows, string Note);

/// <summary>
/// The closed words the two over-time kinds take, and the rules that follow from
/// their groups being generated rather than declared. Published so an author picks
/// a range from a list instead of discovering which ones a compiler accepts.
/// </summary>
public sealed record NendoOverTimeDescription(
    IReadOnlyList<string> TrendBuckets,
    IReadOnlyList<string> TrendRanges,
    IReadOnlyList<string> ActivityRanges,
    string Note);

/// <summary>
/// Where a board's columns come from, and the ceiling a reference board spends.
/// Published so an author knows before building that a reference to a large record
/// type is not a board, rather than learning it from a surface that will not draw.
/// </summary>
public sealed record NendoBoardDescription(
    int MaximumReferenceColumns,
    string Note,
    string ReferenceColumnsMinimumHostVersion);

/// <summary>
/// What the two grid kinds are, and the two ceilings they spend. Published so an
/// author sizes a matrix before building one rather than discovering the ceiling
/// from a refusal.
/// </summary>
public sealed record NendoGridDescription(
    int MaximumCells,
    int MaximumRankedListRows,
    string Note);

/// <summary>
/// The effective-filter ceiling and how each context composes against it. Stated
/// with the vocabulary so an author plans a surface around it rather than
/// discovering it from a refusal halfway through a build.
/// </summary>
public sealed record NendoEffectiveFilterBudget(
    int MaximumClauses,
    IReadOnlyList<NendoEffectiveFilterContext> Contexts,
    string Note);

/// <summary>One context and the clauses that count against its budget.</summary>
public sealed record NendoEffectiveFilterContext(string Context, string Composition);

public sealed record NendoNodeKindDescription(
    string Kind,
    bool CanBeRoot,
    IReadOnlyList<string> Properties,
    IReadOnlyList<string> RequiredProperties,
    IReadOnlyList<string> Children)
{
    /// <summary>
    /// How many roots of this kind one entity may own; null when the kind cannot
    /// be a root. Declaring the ceiling turns a guaranteed validation failure into
    /// something an author plans around.
    /// </summary>
    public int? MaxRootsPerEntity { get; init; }

    /// <summary>
    /// How many roots of this kind the whole file may own, for a root that belongs
    /// to the file rather than to a record type; null for every other kind. A
    /// client that reads only <see cref="MaxRootsPerEntity"/> would find nothing
    /// here and infer no ceiling at all, so the two are published side by side.
    /// </summary>
    public int? MaxRootsPerFile { get; init; }

    /// <summary>The ceiling in a sentence, including where a further one may be nested.</summary>
    public string? RootCardinality { get; init; }
}

/// <summary>
/// How sibling filter clauses combine, and what cannot be said with them. Stated
/// because an author who wrote two clauses had no way to confirm the semantics
/// they intended.
/// </summary>
public sealed record NendoFilterCombinatorDescription(string Combinator, string Note);

/// <summary>
/// The bounds an authoring client plans against. Published rather than discovered
/// by hitting them: a change set that crosses a ceiling two-thirds of the way
/// through a build costs the whole build.
/// </summary>
/// <param name="OperationsPerChangeSet">
/// Operations a caller may submit to one change set. An <c>ui.addNode</c> that
/// carries an inline <c>properties</c> map counts once here and expands to one
/// canonical operation per property, bounded separately by
/// <paramref name="CanonicalOperationsPerChangeSet"/>.
/// </param>
/// <param name="CanonicalOperationsPerChangeSet">
/// Operations the change set may hold once inline properties have expanded. This
/// is the Engine's own ceiling on a canonical change set, and it is what a
/// UI-heavy build actually spends.
/// </param>
/// <param name="PropertiesPerNodeOperation">
/// Properties one inline <c>ui.addNode</c> may carry. No node kind in the
/// vocabulary declares more than this.
/// </param>
public sealed record NendoAuthoringLimits(
    int OperationsPerCall,
    int MutationsPerCall,
    int OperationsPerChangeSet,
    int MutationsPerChangeSet,
    int DraftsPerSession,
    int RecordsPerReferenceConversion,
    int ValuesPerRecord,
    int MinimumPageLimit,
    int MaximumPageLimit,
    int CanonicalOperationsPerChangeSet,
    int PropertiesPerNodeOperation,
    int ApplicationPurposeCharacters)
{
    /// <summary>
    /// The enforcement points read these values rather than repeating them, so a
    /// published limit cannot drift from the limit that actually refuses.
    /// </summary>
    public static NendoAuthoringLimits Current { get; } = new(
        OperationsPerCall: 16,
        MutationsPerCall: 8,
        OperationsPerChangeSet: 128,
        MutationsPerChangeSet: 32,
        DraftsPerSession: 8,
        RecordsPerReferenceConversion: ConvertLegacyReferenceOperation.MaximumRecords,
        ValuesPerRecord: 128,
        MinimumPageLimit: 1,
        MaximumPageLimit: 100,
        CanonicalOperationsPerChangeSet: CanonicalChangeSetRequestCompiler.MaximumOperations,
        PropertiesPerNodeOperation: 16,
        ApplicationPurposeCharacters: SetApplicationPurposeOperation.MaximumCharacters);
}

public sealed record NendoVocabularyDescription(
    int ContractVersion,
    NendoAuthoringLimits Limits,
    IReadOnlyList<string> FilterOperators,
    IReadOnlyList<string> ValueKinds,
    IReadOnlyList<string> OrderDirections,
    IReadOnlyList<string> Aggregates,
    IReadOnlyList<NendoRefusedAggregateDescription> RefusedAggregates,
    IReadOnlyList<NendoNodeKindDescription> Kinds)
{
    /// <summary>How sibling filterClause children combine, and what they cannot say.</summary>
    public NendoFilterCombinatorDescription? FilterClauses { get; init; }

    /// <summary>What a list or board tile counts, and where per-column is accepted.</summary>
    public NendoSummaryScopeDescription? SummaryScopes { get; init; }

    /// <summary>How a section starts, and that folding it is the person's and never stored.</summary>
    public NendoSectionOpensDescription? SectionOpens { get; init; }

    /// <summary>The effective-filter ceiling and how each context composes against it.</summary>
    public NendoEffectiveFilterBudget? EffectiveFilters { get; init; }

    /// <summary>
    /// Every canonical operation an agent may author, with the payload fields each
    /// takes. Supplied by the adapter that owns the authoring union, so this
    /// describes what the host accepts rather than a prose copy of it. The tool
    /// description points here instead of restating the table, which was long
    /// enough to be truncated mid-token in a client's tool listing.
    /// </summary>
    public IReadOnlyList<NendoOperationDescription> Operations { get; init; } = [];

    /// <summary>The closed colours a choice option may carry, in picker order, with the rule.</summary>
    public NendoChoiceToneDescription? ChoiceTones { get; init; }

    /// <summary>What a chart is: the closed groupings, the ceiling on groups, and the exactness rule.</summary>
    public NendoChartDescription? Charts { get; init; }

    /// <summary>What the file's front page is, how many it may have, and how long a recent list may be.</summary>
    public NendoOverviewDescription? Overview { get; init; }

    /// <summary>The two kinds that group by a civil date; see <see cref="NendoOverTimeDescription"/>.</summary>
    public NendoOverTimeDescription? OverTime { get; init; }

    /// <summary>Where a board's columns come from; see <see cref="NendoBoardDescription"/>.</summary>
    public NendoBoardDescription? Boards { get; init; }

    /// <summary>The matrix and the ranking, and the ceilings they spend; see <see cref="NendoGridDescription"/>.</summary>
    public NendoGridDescription? Grids { get; init; }

    /// <summary>
    /// Everything a formula may say: the closed function set, the operators, the
    /// scalar domain, the binding kinds, the aggregate rules and the ceilings.
    /// <para>
    /// Generated from the tables the Engine enforces, and published here rather than
    /// in a catalogue of its own, so an authoring client learns calculations from the
    /// same read it learns surfaces from.
    /// </para>
    /// </summary>
    public NendoBehaviourDescription? Behaviour { get; init; }

    /// <summary>
    /// What a property's value is, for the properties whose name alone does not say.
    /// <c>visibleWhen</c> takes a calculated field's <c>fieldId</c>; a client that had
    /// only the name sent the definition ID first.
    /// </summary>
    public IReadOnlyDictionary<string, string> PropertyNotes { get; init; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

/// <summary>
/// One canonical operation type and the payload it takes. <paramref name="Lane"/>
/// is definition or data; a definition-lane mutation advances the definition
/// revision by one.
/// </summary>
public sealed record NendoOperationDescription(
    string OperationType,
    string Lane,
    IReadOnlyList<string> RequiredPayload,
    IReadOnlyList<string> OptionalPayload,
    string Summary);

/// <summary>
/// An aggregate this host names and refuses, with the reason. An author who
/// reaches for it is told why rather than left to infer it from an absence.
/// </summary>
public sealed record NendoRefusedAggregateDescription(string Aggregate, string Reason);
