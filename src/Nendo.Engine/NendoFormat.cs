namespace Nendo.Engine;

public sealed record NendoFormatDescriptor(
    string FileExtension,
    string Identifier,
    long Version,
    string MinimumHostVersion,
    int SqliteApplicationId);

/// <summary>
/// Identifies the first durable Nendo file contract.
/// </summary>
public static class NendoFormat
{
    public const int SqliteApplicationId = 0x4E454E44;

    public const string FileExtension = ".nendo";

    public const string Identifier = "nendo.sqlite.application";

    public const long CurrentVersion = 1;

    public const string MinimumHostVersion = "1.0.0";

    public const string SemanticMinimumHostVersion = "1.1.0";

    public const string LifecycleMinimumHostVersion = "1.2.0";

    public const string ScalarMinimumHostVersion = "1.3.0";

    public const string EvolutionMinimumHostVersion = "1.4.0";

    public const string ReferenceMinimumHostVersion = "1.5.0";

    public const string DeletionMinimumHostVersion = "1.6.0";

    public const string ChoiceMinimumHostVersion = "1.7.0";

    public const string RetirementMinimumHostVersion = "1.8.0";

    public const string OptionalSurfacesMinimumHostVersion = "1.9.0";

    public const string ReferenceConversionMinimumHostVersion = "1.10.0";

    /// <summary>Contract version 3 composable surfaces, ADR-0004 2026-09-09 amendment.</summary>
    public const string ComposableSurfacesMinimumHostVersion = "1.11.0";

    // The vocabulary-widening ladder, ADR-0004 2026-09-12 amendment. Contract
    // version 3's tree is preserved, so the version on a root no longer says what
    // a host must understand: each widened shape declares its own minimum, and
    // <see cref="NendoSemanticCapability"/> computes which of them a stored
    // definition uses. An intermediate host never advertises a later one.

    /// <summary>Summary tiles on a list or board, with the closed `scope` values.</summary>
    public const string SurfaceSummaryTilesMinimumHostVersion = "1.12.0";

    /// <summary>More than one <c>recordCommand</c> root on one record type.</summary>
    public const string MultipleCommandRootsMinimumHostVersion = "1.13.0";

    /// <summary>More than one <c>recordList</c> or <c>boardSurface</c> root on one record type.</summary>
    public const string MultipleSurfaceRootsMinimumHostVersion = "1.14.0";

    /// <summary>Named tabs on a record page, through <c>tabGroup</c>.</summary>
    public const string TabbedRecordPagesMinimumHostVersion = "1.15.0";

    /// <summary>A Date-field <c>calendarSurface</c> with a month and an undated view.</summary>
    public const string DateCalendarMinimumHostVersion = "1.16.0";

    /// <summary>
    /// Stored behaviour definitions — calculated fields, reusable functions, local
    /// actions and triggers, ADR-0008. A file holding one cannot be edited by a host
    /// that would not run it, because the values it shows and the writes a save makes
    /// both depend on evaluating the definitions the same way.
    /// </summary>
    public const string BehaviourMinimumHostVersion = "1.17.0";

    /// <summary>
    /// A field or section shown only when a calculation says so, ADR-0008 P8. It is
    /// the first consumer of the bounded expression service outside calculated fields
    /// themselves, and a host that cannot evaluate the calculation cannot know whether
    /// to show the node — so it must not compile the surface at all.
    /// </summary>
    public const string ConditionalVisibilityMinimumHostVersion = "1.18.0";

    /// <summary>
    /// Colour and the record-page header, ADR-0004 2026-09-14 amendment, slice S0: a
    /// <c>tone</c> on a choice option, and a <c>detailSurface</c> that names a title,
    /// subtitle or accent field. A host without either would draw a toned board grey
    /// and refuse the page's properties as unknown, so a file using them states the
    /// host it needs.
    /// </summary>
    public const string ColourAndHeaderMinimumHostVersion = "1.19.0";

    /// <summary>
    /// The first charts, ADR-0004 2026-09-14 amendment, slice S1: a
    /// <c>breakdownChart</c> or a <c>progressTile</c> on a surface. A host without
    /// them refuses the kinds as unknown, so a file using either states the host it
    /// needs.
    /// </summary>
    public const string FirstChartsMinimumHostVersion = "1.20.0";

    /// <summary>
    /// The timeline, ADR-0004 2026-09-14 amendment, slice S3: a <c>timelineSurface</c>
    /// placing records on a spine by a Date field, with an optional end date that
    /// draws a span. A host without it refuses the kind as unknown, so a file using
    /// one states the host it needs.
    /// </summary>
    public const string TimelineMinimumHostVersion = "1.21.0";

    /// <summary>
    /// The gallery and the rating scale, ADR-0004 2026-09-14 amendment, slice S2: a
    /// <c>gallerySurface</c> of cards, and an Integer field drawn on a closed scale. One
    /// rung reached two ways, as colour and the record-page header are: the gallery is a
    /// shape of the node tree, and a scale is evidence the field operation carries. A host
    /// without them refuses the kind as unknown and reports the presentation as
    /// unsupported, so a file using either states the host it needs.
    /// </summary>
    public const string GalleryAndRatingMinimumHostVersion = "1.22.0";

    /// <summary>
    /// The overview page, ADR-0004 2026-09-14 amendment, slice S4: an
    /// <c>overviewSurface</c> that belongs to the file rather than to a record type,
    /// with a <c>recentList</c> and a <c>rangeTile</c> under it. One rung for the
    /// three, because none of them is reachable without the root that holds them —
    /// a range tile on a list is the one exception, and it arrived with them. A host
    /// without it refuses the kinds as unknown, so a file using any of them states
    /// the host it needs.
    /// </summary>
    public const string OverviewMinimumHostVersion = "1.23.0";

    /// <summary>
    /// What the file is for, ADR-0004 2026-09-15 amendment: prose the file carries itself,
    /// whether or not it has a front page, led with by the describe resource. Not a rung of
    /// the node tree at all — it is a row in its own protected table, so the ladder cannot
    /// see it and the operation declares this version on its own evidence. A host without it
    /// does not know the table, so a file carrying a purpose states the host it needs;
    /// clearing one never raises anything, because a file with no purpose needs nothing.
    /// </summary>
    public const string ApplicationPurposeMinimumHostVersion = "1.24.0";

    /// <summary>
    /// Over time, ADR-0004 2026-09-16 amendment, slice S5: <c>trendChart</c> and
    /// <c>activityGrid</c>, the first groupings whose groups are generated from a resolved
    /// civil-date range rather than read from a field's options. One rung for the two,
    /// because both stand on the same bucket machinery and neither is reachable without it.
    /// <para>
    /// 1.25.0 rather than the 1.24.0 the plan proposed: 1.24.0 went to the file purpose on
    /// 2026-09-15 while this slice was unwritten. The ladder is monotone and a host never
    /// advertises a later feature than it has, so rungs follow delivery order — the same
    /// correction S2 and S3 already carry.
    /// </para>
    /// </summary>
    public const string OverTimeMinimumHostVersion = "1.25.0";

    /// <summary>
    /// Two crossed choice dimensions with an exact number in every cell, and a ranking of
    /// the few records at the top of one stored number (ADR-0004, 2026-09-17 amendment, S6).
    /// One rung for both: they arrive in the same host, and a host that draws a grid draws
    /// a ranking.
    /// </summary>
    public const string GridsMinimumHostVersion = "1.26.0";

    /// <summary>
    /// A <c>boardSurface</c> whose columns are records of another record type rather than a
    /// field's options (ADR-0004, 2026-09-17 amendment, S7). The first grouping whose members
    /// are neither written in the definition nor computed from a range, so a host that does
    /// not read the target type cannot draw the board at all.
    /// <para>
    /// This is the one rung that is not a node kind, and the only one the stored tree cannot
    /// show on its own: a board grouped by a reference and a board grouped by a choice are the
    /// same shape. It is recognised by reading the grouping field's storage kind beside the
    /// tree, which is why <see cref="NendoSemanticCapability.RequiredHostVersion"/> takes the
    /// entity fields.
    /// </para>
    /// </summary>
    public const string ReferenceBoardMinimumHostVersion = "1.27.0";

    /// <summary>
    /// A section carrying <c>opens</c> (ADR-0004, 2026-09-20 amendment). The property is
    /// what an older host refuses; every section folding is renderer behaviour and puts
    /// nothing in the file, so a file without the property stays where it was.
    /// </summary>
    public const string FoldedSectionMinimumHostVersion = "1.28.0";

    /// <summary>Bounded isolated custom-view references; packages and consent stay on the device.</summary>
    public const string ExtensionViewsMinimumHostVersion = "1.29.0";

    /// <summary>
    /// A custom view at protocol 2 (ADR-0013, 2026-09-24 amendment): disclosed fields and
    /// authored filters as child nodes. A 1.29 host would refuse the children; a file whose
    /// views are all protocol 1 stays at 1.29.0.
    /// </summary>
    public const string ExtensionProtocol2MinimumHostVersion = "1.30.0";

    /// <summary>
    /// A custom view of one record type as typed columns, extensionRecordsSurface (ADR-0013,
    /// 2026-09-24 record-set amendment). A 1.30 host does not know the kind.
    /// </summary>
    public const string ExtensionRecordsMinimumHostVersion = "1.31.0";

    /// <summary>
    /// A custom view on a record page, extensionRecordPanel (ADR-0013, 2026-09-24 record-set
    /// amendment). The record-set shape shipped first, as 1.31.0, and that host does not know
    /// the panel, so the panel is its own rung.
    /// </summary>
    public const string ExtensionRecordPanelMinimumHostVersion = "1.32.0";

    /// <summary>
    /// Custom-view packages carried in the file (ADR-0013, 2026-09-25): the package, file,
    /// content and view-state tables. Like the purpose, a row set in protected tables the node
    /// ladder cannot see, so each package operation declares this version on its evidence and
    /// the layout rung states it at open. A 1.32 host does not know the tables and refuses the
    /// file's layout, which is the refusal it is owed.
    /// </summary>
    public const string ExtensionPackagesMinimumHostVersion = "1.33.0";

    /// <summary>
    /// A custom view the 1.32 rules refuse (ADR-0013, 2026-09-25): no package pin, a
    /// configuration that is not empty, a calculated field shown, a relative filter, more
    /// fields or panels than those rules allowed. A view those rules accept keeps the rung it
    /// had, so a file with an older view is not raised until its definition says something new.
    /// </summary>
    public const string OpenCustomViewsMinimumHostVersion = "1.34.0";

    public const string CurrentHostVersion = OpenCustomViewsMinimumHostVersion;

    internal static string RequireAtLeast(string existing, string required) =>
        Version.Parse(existing) >= Version.Parse(required) ? existing : required;

    public static NendoFormatDescriptor Describe() =>
        new(FileExtension, Identifier, CurrentVersion, MinimumHostVersion, SqliteApplicationId);
}
