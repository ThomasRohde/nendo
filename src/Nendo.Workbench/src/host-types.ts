import type { PendingMutation } from './pending-mutations';

/**
 * The protocol vocabulary: every shape the host sends and every shape it takes.
 *
 * Fifteen modules import from here and all but the entry point import types
 * only, so this holds no transport and no client. The version those shapes
 * belong to is declared in host.ts, which is the one file the production
 * boundary check reads it out of.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';
export type WorkbenchMode = 'desktop' | 'preview' | 'unavailable';

export interface ManifestSnapshot {
  formatIdentifier: string;
  formatVersion: number;
  minimumHostVersion: string;
  applicationId: string;
  instanceId: string;
  createdAt: string;
  modifiedAt: string;
  definitionRevision: number;
  dataRevision: number;
  changeSequence: number;
  // What the file is for, in the author's words, or null when nobody has said. The
  // file's own, not the front page's: a file with no overview still carries one.
  purpose: string | null;
}

export interface EntitySnapshot {
  entityId: string;
  retired?: boolean;
  displayName: string;
  fields: Array<{
    fieldId: string;
    displayName: string;
    storageKind: string | number;
    unsupportedStorageKind?: string | null;
    required: boolean;
    presentation: string | null;
    options: string[];
    reference?: { targetEntityId: string; labelFieldId: string } | null;
    choices?: Array<{ id: string; displayName: string; retired: boolean; tone?: string | null }>;
    /** The closed scale a rating field is drawn on, or null for every other presentation. */
    scale?: { min: number; max: number } | null;
    retired?: boolean;
  }>;
  /** Calculated fields this record type shows. Never editable. */
  derivedFields?: Array<{
    fieldId: string;
    displayName: string;
    calculationId: string;
    resultType: string | number;
    resultNullable: boolean;
    expression: string;
  }>;
}

export interface RecordSnapshot {
  entityId: string;
  recordId: string;
  recordVersion: number;
  values: Record<string, unknown>;
  referenceLabels?: Record<string, string | null>;
  /** In dependency order, so a dependant is read after what it depends on. */
  calculations?: CalculationResult[];
}

export interface UiNodeSnapshot {
  surfaceId: string;
  nodeId: string;
  parentNodeId: string | null;
  kind: string;
  position: number;
  properties: Record<string, unknown>;
}

export interface StorageHealthSnapshot {
  journalMode: string;
  synchronousMode: string;
  busyTimeoutMilliseconds: number;
  integrityResult: string;
  operationalSidecars: string[];
  integrityCheckedAt?: string | null;
  integrityChangeSequence?: number | null;
}

export interface DesktopSessionView {
  fileSessionId: string | null;
  capabilities: FileCapabilities;
  findings: Array<{ code: string; message: string }>;
  agentCleanupNotice?: string | null;
  locationWarning?: { code: string; message: string } | null;
  replacementRecovery?: { hasPendingReplacement: boolean; message: string } | null;
  /** Whether this file's automatic actions need approval here, and whether they have it. */
  behaviourTrust?: {
    requiresApproval: boolean;
    isApproved: boolean;
    createsRecords: boolean;
    updatesRecords: boolean;
    deletesRecords: boolean;
    behaviourDigest?: string | null;
    notice?: string | null;
  } | null;
  hasFile: boolean;
  fileName: string | null;
  health: string;
  manifest: ManifestSnapshot | null;
  entities: EntitySnapshot[];
  records: RecordSnapshot[];
  uiNodes: UiNodeSnapshot[];
  storage: StorageHealthSnapshot | null;
  /** The product version of the running host, present whether or not a file is open. */
  hostVersion?: string;
  /** Whether this file's custom views may run here, and the packages it carries. Absent without a file. */
  extensions?: ExtensionRuntimeView | null;
}

/** Why custom views may not run now (ADR-0013): each is one of the kill switches. */
export type ExtensionOffReason = 'device' | 'file' | 'health' | 'recovery';

/**
 * Whether views may run, and the packages that carry their code. `run` is true only when this
 * device's "Run custom views" is on, this file's own switch is on, the file is healthy and
 * Nendo was not restarted without custom views; the host answers 403 on every view origin
 * whenever it is false, so a frame the Workbench did not mount has nothing to show either.
 */
export interface ExtensionRuntimeView {
  run: boolean;
  offReason: ExtensionOffReason | null;
  deviceEnabled: boolean;
  fileEnabled: boolean;
  /** A sentence from the host about the switches, such as a setting that could not be saved. */
  notice?: string | null;
  packages: ExtensionPackageView[];
}

/** One custom-view package in the open file, and the origin the host serves it from. */
export interface ExtensionPackageView {
  packageId: string;
  title: string;
  version: string | null;
  entryPoint: string;
  description: string | null;
  /** Computed by the host alone, such as https://org-nendo-gantt-3f2a9c01be.example. */
  origin: string;
  fileCount: number;
  totalBytes: number;
  /** Changes whenever the package's content does, so a view restarts on accepted code. */
  contentDigest?: string;
  /** The name of the folder this device runs the package from while it is developed (ADR-0013 Phase 4), or null. */
  developmentFolder?: string | null;
}

export interface FileCapabilities {
  readData: boolean;
  readHistory: boolean;
  backup: boolean;
  export: boolean;
  customSurfaces: boolean;
  mutate: boolean;
  agentAccess: boolean;
}

export function fileCapabilities(enabled: boolean): FileCapabilities {
  return { readData: enabled, readHistory: enabled, backup: enabled, export: enabled, customSurfaces: enabled, mutate: enabled, agentAccess: enabled };
}

export interface DesktopFileActionView { session: DesktopSessionView | null; notice: string | null; refreshNotice?: string | null }
export interface RecentFiles { files: Array<{ id: string; fileName: string; state: string; lastOpened: string }>; notice: string | null }

export type AgentAccessMode = 'off' | 'inspect' | 'editData' | 'shapeApp' | 'unattended';

/**
 * What an agent is doing right now, pushed by the host as it changes.
 *
 * Distinct from `AgentActivity` below, which is one line of history in the Agent page's
 * list. This one is the present tense, and it is the only thing that can be shown while
 * the window is waiting on the gate an agent write is holding.
 */
export interface AgentWork {
  busy: boolean;
  client: string;
  activity: string;
}

export interface AgentActivity {
  timestamp: string;
  client: string;
  category: string;
  name: string;
  outcome: string;
  revisionId: string | null;
  proposalId: string | null;
}

export interface AgentProposalSummary {
  proposalId: string;
  title: string;
  state: string | number;
  operationDigest: string;
  operationCount: number;
  capturedDefinitionRevision: number;
  diagnosticCount: number;
  reversibility: string | number;
}

export interface AgentProposalPreview {
  proposalId: string;
  title: string;
  state: string | number;
  retention: string | number;
  capturedDefinitionRevision: number;
  operationDigest: string;
  operationCount: number;
  diagnostics: CompilerDiagnostic[];
  semanticDiff: SemanticDiffEntry[];
  preview: AgentPreviewSummary;
}

export interface AgentPreviewEntity {
  entityId: string;
  displayName: string;
  fieldCount: number;
  recordCount: number;
  retired: boolean;
}

export interface AgentPreviewSurface {
  nodeId: string;
  kind: string;
  title: string | null;
  /** Null for the file's front page, which belongs to the file rather than to a record type. */
  entityId: string | null;
  /**
   * The size a kind and a title cannot tell you: a matrix's rows, columns and cells,
   * or how many columns a board would have — including none, when its lanes come from
   * a record type that is still empty. Null where the size is not a closed question.
   */
  shape?: string | null;
}

// Contract version 3 composes a node tree, so a proposal is described by what it
// builds across every record type rather than by four fixed slot titles.
export interface AgentPreviewSummary {
  contractVersion: number | null;
  fieldCount: number;
  recordCount: number;
  entities: AgentPreviewEntity[];
  surfaces: AgentPreviewSurface[];
  // Every count is taken over the validated clone: the whole file as it would
  // stand. Field counts used to come from the compiled screens and record counts
  // from the file, so two adjacent numbers had two different denominators.
  scope: string;
  minimumHostVersionBefore: string | null;
  minimumHostVersionAfter: string | null;
  // Named rather than found: a purpose has no record type and no node, so a summary
  // built by walking entities and surfaces would review it as changing nothing.
  purposeBefore: string | null;
  purposeAfter: string | null;
  /** What the proposal does to each custom-view package file, as lines to read. */
  packageChanges?: ExtensionFileChange[];
}

/** One line of a code change: context, removed or added. */
export interface ExtensionDiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
}

/** A run of changed lines with three lines of context, numbered from one on each side. */
export interface ExtensionDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ExtensionDiffLine[];
}

/** How a proposal changes one file of a custom-view package carried in the file (ADR-0013). */
export interface ExtensionFileChange {
  packageId: string;
  path: string;
  change: 'added' | 'replaced' | 'removed';
  mediaTypeBefore: string | null;
  mediaTypeAfter: string | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  textual: boolean;
  hunks: ExtensionDiffHunk[];
  truncated: boolean;
}

export interface AgentStatus {
  available: boolean;
  mode: AgentAccessMode;
  state: 'noFile' | 'readOnly' | 'recoveryRequired' | 'off' | 'ready' | 'unavailable';
  connectedAgent: string | null;
  editingOwner: string | null;
  leaseExpiresAt: string | null;
  recentActivity: AgentActivity[];
  pendingProposals: AgentProposalSummary[];
  leaseExpiry: boolean;
  leaseExpirySeconds: number;
  fixedPort: boolean;
  portPreference: number;
  endpoint: string | null;
  usingPreferredPort: boolean;
  settingsPersisted: boolean;
  settingsNotice: string | null;
}

export interface ApplyResult {
  revisionId: string;
  operationDigest: string;
  definitionRevision: number;
  dataRevision: number;
  changeSequence: number;
  isIdempotentReplay: boolean;
}

export interface DesktopMutationView {
  mutation: ApplyResult;
  session: DesktopSessionView | null;
  refreshNotice?: string | null;
}

export interface CompilerDiagnostic {
  code: string;
  severity: 'error' | 'warning' | number;
  message: string;
  semanticId: string | null;
  propertyPath: string | null;
  hint: string;
}

export interface FieldPlan {
  semanticId: string;
  automationTarget: string;
  displayName: string;
  storageKind: string | number;
  required: boolean;
  presentation: string | null;
  options: string[];
  choices?: Array<{ id: string; displayName: string; retired: boolean; tone?: string | null }>;
  scale?: { min: number; max: number } | null;
  retired?: boolean;
  /**
   * Where a Reference field points and which of the target's fields labels it, or null
   * for every other kind and for a reference nobody has bound. A board grouped by the
   * field draws a column per record of that type, headed by that label.
   */
  reference?: { targetEntityId: string; labelFieldId: string } | null;
}

export interface RecordPlan {
  semanticId: string;
  automationTarget: string;
  version: number;
  values: Record<string, unknown>;
  referenceLabels?: Record<string, string | null>;
  /**
   * Calculated results for this record, keyed by derived field ID. Deliberately not
   * merged into `values`: a result may be a value, empty, still loading or an error,
   * and treating one as a stored value would put a number on screen that no formula
   * produced.
   */
  calculations?: Record<string, CalculationResult>;
}

/** What a calculated field currently is. */
export type CalculationState = 'value' | 'empty' | 'error' | 'pending';

export interface CalculationResult {
  calculationId: string;
  fieldId: string;
  state: CalculationState | number;
  resultType: string | number;
  value: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** A field a surface shows but nobody can type into. */
export interface DerivedFieldPlan {
  semanticId: string;
  automationTarget: string;
  displayName: string;
  resultType: string | number;
  resultNullable: boolean;
  calculationId: string;
  expression: string;
}

/** One compiled surface node. Children are already in declared order. */
export interface SurfaceNodePlan {
  semanticId: string;
  automationTarget: string;
  kind: string;
  properties: Record<string, unknown>;
  children: SurfaceNodePlan[];
}

/** One entity's compiled surfaces. The tree is the only shape a host compiles. */
export interface ApplicationPlan {
  contractVersion: number;
  applicationId: string;
  definitionRevision: number;
  dataRevision: number;
  digest: string;
  entity: {
    semanticId: string;
    automationTarget: string;
    displayName: string;
    fields: FieldPlan[];
    derivedFields?: DerivedFieldPlan[];
  };
  surfaces: SurfaceNodePlan[];
  records: RecordPlan[];
}

/**
 * The file's front page, when it has one. It belongs to the file rather than to
 * a record type, so it carries no entity and no records: every tile, chart and
 * recent list inside it names the record type it reads, and those records travel
 * with the entity plans.
 */
export interface OverviewPlan {
  contractVersion: number;
  applicationId: string;
  definitionRevision: number;
  surface: SurfaceNodePlan;
  /**
   * The record types the front page names, with their fields. A type can be read
   * by a tile without owning a surface of its own, so these are not always among
   * the application plans — and a chart over one still has to label its groups.
   */
  entities: ApplicationPlan['entity'][];
}

export interface CompileResult {
  isValid: boolean;
  diagnostics: CompilerDiagnostic[];
  sourceChangeSequence?: number | null;
  applications?: ApplicationPlan[];
  overview?: OverviewPlan | null;
}

export interface ReadPage<T> {
  items: T[];
  nextCursor: string | null;
  changeSequence: number;
}

export interface RevisionSummary {
  revisionId: string;
  createdAt: string;
  origin: string;
  description: string;
  lane: string | number;
  changeSequence: number;
  compensationOfRevisionId: string | null;
  operationCount: number;
  canRequestCompensation: boolean;
}

export interface SemanticDiffEntry {
  kind: string;
  summary: string;
  semanticIds: string[];
  reversibility: string | number;
}

export interface ProposalPreview {
  previewRecordCounts?: Record<string, number>;
  proposalId: string;
  title: string;
  state: string | number;
  retention: string | number;
  sourceApplicationId: string;
  sourceInstanceId: string;
  capturedDefinitionRevision: number;
  touchedRecords: Array<{ entityId: string; recordId: string; version: number }>;
  operationDigest: string;
  operationCount: number;
  diagnostics: CompilerDiagnostic[];
  semanticDiff: SemanticDiffEntry[];
  previewApplications?: ApplicationPlan[];
  /** The front page the validated clone compiles, when the proposal leaves one. */
  previewOverview?: OverviewPlan | null;
  /** What the proposal does to each custom-view package file, as lines to read. */
  packageChanges?: ExtensionFileChange[];
}

export interface PromotionOutcome {
  proposalId: string;
  state: string | number;
  applied: boolean;
  message: string;
  result: unknown | null;
}

export interface DesktopPromotionView {
  promotion: PromotionOutcome;
  session: DesktopSessionView | null;
  refreshNotice?: string | null;
}

export type DesktopOperationView = DesktopMutationView | DesktopPromotionView;

export interface StoredOperationSnapshot {
  operationId: string;
  operationType: string;
  reversibility: string | number;
  canonicalJson: string;
}

export interface RevisionSnapshot {
  revisionId: string;
  createdAt: string;
  origin: string;
  description: string;
  lane: string | number;
  definitionRevisionBefore: number;
  definitionRevisionAfter: number;
  dataRevisionBefore: number;
  dataRevisionAfter: number;
  changeSequence: number;
  operationDigest: string;
  idempotencyScope: string | null;
  idempotencyKey: string | null;
  proposalId: string | null;
  proposalDigest: string | null;
  compensationOfRevisionId: string | null;
  operations: StoredOperationSnapshot[];
}

/**
 * A view the host asked for, without the renderer asking first.
 *
 * The closed set exists so an unsolicited message can never name a route the
 * router does not have. It is the whole payload: a host event is a nudge to look
 * at something, never a carrier of state the renderer did not read for itself.
 */
export type HostRoute = 'open' | 'agent' | 'health' | 'studio';
/**
 * The renderer behind these custom-view frames ended (ADR-0013). Each name is an iframe's
 * name, `nendo-view-` and its mount ID; the frames show "This view stopped" with Reload,
 * and nothing else in the window is affected.
 */
export interface HostFramesFailed { fileSessionId: string; frames: string[] }

export function isHostRoute(value: unknown): value is HostRoute {
  return value === 'open' || value === 'agent' || value === 'health' || value === 'studio';
}

export interface WorkbenchClient {
  readonly mode: WorkbenchMode;
  request<T>(method: string, payload?: Record<string, unknown>): Promise<T>;
  /** Listen for a view the host asked to show. Returns a function that stops listening. */
  onNavigate?(listener: (route: HostRoute) => void): () => void;
  /** Listen for custom-view frames whose renderer ended. */
  onExtensionFramesFailed?(listener: (failed: HostFramesFailed) => void): () => void;
  /**
   * Listen for the open file having moved, carrying the change sequence it reached.
   *
   * The host says only that something committed. What to re-read, and when it is safe to
   * redraw, is for the renderer to settle — a refresh that lands under an open menu is
   * worse than a screen that is a second behind.
   */
  onFileChanged?(listener: (changeSequence: number) => void): () => void;
  /** A package developed from a folder changed there; its views load it again (ADR-0013 Phase 4). */
  onExtensionDevelopmentChanged?(listener: (packageId: string) => void): () => void;
  /**
   * Listen for an agent starting or finishing a call.
   *
   * The host says only whether work is running, who is doing it and what it named. The
   * delay before anything is drawn belongs here, not there: a read that takes forty
   * milliseconds must not flash an indicator, and the same rule already governs the busy
   * bar. It is the only signal that reaches a person while an agent holds the file's one
   * gate and the window cannot answer anything else.
   */
  onAgentActivity?(listener: (activity: AgentWork) => void): () => void;
  pendingMutation?(): PendingMutation | null;
  retryPendingMutation?(): Promise<DesktopOperationView | null>;
  checkPendingMutation?(): Promise<DesktopOperationView | null>;
  /** Stop whatever is still running, and resolve only once it has actually stopped. */
  cancelInFlight?(): Promise<CancelledRequests>;
  /** Whether a file dropped on the window can be handed to the host at all. */
  readonly acceptsDroppedFiles?: boolean;
  /** Open a file the person dropped on the window. */
  openDroppedFile?<T>(file: File): Promise<T>;
}

/** What a stop actually managed to do, counted rather than assumed. */
export interface CancelledRequests {
  /** Requests the host found still running and stopped. */
  stopped: number;
  /** Requests the host found but that did not stop within its join window. */
  ignored: number;
}

export class WorkbenchHostError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkbenchHostError';
  }
}

/** Narrow an unknown payload before reading fields off it. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
