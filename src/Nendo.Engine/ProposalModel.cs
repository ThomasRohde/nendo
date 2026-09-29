namespace Nendo.Engine;

public enum NendoProposalState
{
    Draft,
    Validating,
    Invalid,
    Previewable,
    Applying,
    Active,
    Stale,
    Failed,
    Rejected,
}

public enum NendoProposalRetention
{
    RetainUntilExplicitCleanup,
}

public sealed record NendoTouchedRecordVersion(
    string EntityId,
    string RecordId,
    long Version);

public sealed record NendoSemanticDiffEntry(
    string Kind,
    string Summary,
    IReadOnlyList<string> SemanticIds,
    NendoReversibilityClass Reversibility);

/// <summary>
/// One record type as the validated clone holds it. Counted from the previewed
/// file rather than from the compiled screens, so a change set that adds a record
/// type and no screen still previews as something. The compiled plan describes
/// surfaces; it is not a census of the file.
/// </summary>
public sealed record NendoProposalEntitySummary(
    string EntityId,
    string DisplayName,
    int FieldCount,
    int RecordCount,
    bool Retired);

/// <summary>
/// What accepting a proposal means for this device's consent to the file's automatic
/// actions, said before acceptance rather than discovered after it (ADR-0009, the
/// 2026-09-29 amendment). Facts only: whether consent is held right now is the
/// host's to read, and a review that cached it would keep saying so after a revoke.
/// </summary>
/// <param name="CreatesRecords">The file's automatic actions, once accepted, can create records.</param>
/// <param name="UpdatesRecords">They can change records.</param>
/// <param name="DeletesRecords">They can delete records.</param>
/// <param name="GeneratedEffectCount">
/// Writes the actions made on the validated copy, which acceptance replays. Above zero,
/// acceptance is refused until consent for the behaviour is held here.
/// </param>
/// <param name="ChangesWhatIsApproved">
/// The behaviour the file holds after acceptance is not the behaviour it holds now, so
/// consent given today does not carry over and has to be given again afterwards.
/// </param>
public sealed record NendoProposalBehaviour(
    bool CreatesRecords,
    bool UpdatesRecords,
    bool DeletesRecords,
    int GeneratedEffectCount,
    bool ChangesWhatIsApproved);

public sealed record NendoProposalPreview(
    string ProposalId,
    string Title,
    NendoProposalState State,
    NendoProposalRetention Retention,
    string SourceApplicationId,
    string SourceInstanceId,
    long CapturedDefinitionRevision,
    IReadOnlyList<NendoTouchedRecordVersion> TouchedRecords,
    string OperationDigest,
    int OperationCount,
    IReadOnlyList<NendoCompilerDiagnostic> Diagnostics,
    IReadOnlyList<NendoSemanticDiffEntry> SemanticDiff)
{
    public IReadOnlyList<NendoApplicationPlan> PreviewApplications { get; init; } = [];

    /// <summary>
    /// Who prepared the proposal: <c>workbench</c>, an agent, or <c>extension:‹package›</c>
    /// for a custom view (ADR-0013 Phase 3). The review names a view's package from it.
    /// </summary>
    public string Origin { get; init; } = "";

    /// <summary>
    /// The front page the clone compiles, when it has one. Separate from the
    /// application plans for the reason it is separate everywhere else: it belongs
    /// to the file rather than to a record type.
    /// </summary>
    public NendoOverviewPlan? PreviewOverview { get; init; }

    public IReadOnlyDictionary<string, int> PreviewRecordCounts { get; init; } = new Dictionary<string, int>();

    /// <summary>
    /// Every record type the validated clone holds, whether or not this proposal
    /// gives it a screen. One scope for the whole summary: field counts and record
    /// counts are taken over the same set.
    /// </summary>
    public IReadOnlyList<NendoProposalEntitySummary> PreviewEntities { get; init; } = [];

    /// <summary>The minimum host version the active file requires before this proposal.</summary>
    public string? MinimumHostVersionBefore { get; init; }

    /// <summary>
    /// The minimum host version the file would require after acceptance. A
    /// proposal that raises it makes a durable compatibility change — the file
    /// stops opening in an older Nendo — so the raise also appears in the semantic
    /// diff as its own reviewable line rather than only as a number here.
    /// </summary>
    public string? MinimumHostVersionAfter { get; init; }

    /// <summary>What the file says it is for now, or null if it has never said.</summary>
    public string? PurposeBefore { get; init; }

    /// <summary>
    /// What it would say after acceptance, or null if the proposal clears it. Carried as its
    /// own pair rather than found among the entities or the surfaces, because the purpose
    /// belongs to the file and has no record type and no node to be discovered through — the
    /// same reason a front page had to be named here explicitly.
    /// </summary>
    public string? PurposeAfter { get; init; }

    /// <summary>The look the file chose before the proposal, or null when it chose none.</summary>
    public NendoApplicationLook? LookBefore { get; init; }

    /// <summary>
    /// The look it would have chosen after acceptance: its own pair for the purpose's reason,
    /// because a look has no record type and no node to be found through.
    /// </summary>
    public NendoApplicationLook? LookAfter { get; init; }

    /// <summary>
    /// What the proposal does to each custom-view package file (ADR-0013), compared between
    /// the active file and the validated clone. Code is reviewed as its lines, not as a
    /// sentence about them; a binary file is said by its sizes.
    /// </summary>
    public IReadOnlyList<NendoExtensionFileChange> PackageChanges { get; init; } = [];

    /// <summary>
    /// What accepting means for consent to automatic actions, or null when there is
    /// nothing to say: the file would hold no action that writes, or it keeps exactly
    /// the actions it has and this proposal does not set them off.
    /// </summary>
    public NendoProposalBehaviour? Behaviour { get; init; }
}

public sealed record NendoPromotionOutcome(
    string ProposalId,
    NendoProposalState State,
    bool Applied,
    string Message,
    NendoChangeSetApplyResult? Result)
{
    public bool CleanupPending { get; init; }
}
