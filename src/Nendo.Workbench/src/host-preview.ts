import { type AgentAccessMode, type AgentProposalPreview, type AgentProposalSummary, type AgentStatus, type ApplicationPlan, type ApplyResult, type CompileResult, type DesktopMutationView, type DesktopPromotionView, type DesktopSessionView, type EntitySnapshot, type ProposalPreview, type ReadPage, type RecordPlan, type RecordSnapshot, type RevisionSnapshot, type SemanticDiffEntry, type SurfaceNodePlan, type WorkbenchClient, fileCapabilities } from './host-types';
import {
  previewFixture,
  previewFixtureForEntity,
  previewFixtureName,
  type PreviewFixture,
  type PreviewFixtureName,
} from './preview-fixtures';
import { WorkbenchHostError, isObject } from './host-types';

/**
 * The in-memory host behind ?preview=1.
 *
 * It answers the same protocol against fixtures held in this tab, so the
 * Workbench can be opened in an ordinary browser with no file and no Desktop
 * process. Nothing here reaches a file, and nothing here ships in the path the
 * Desktop host takes.
 */

export class PreviewWorkbenchClient implements WorkbenchClient {
  readonly mode = 'preview' as const;
  private session = emptySession();
  private readonly idempotency = new Map<string, { signature: string; result: DesktopMutationView }>();
  private history: RevisionSnapshot[] = [];
  private previewProposal: ProposalPreview | null = null;
  private agentProposal: AgentProposalPreview | null = null;
  private agentStatus = emptyAgentStatus(false);
  private plan: ApplicationPlan | null = null;
  private proposedFixture: PreviewFixture | null = null;
  private readonly fixtureName: PreviewFixtureName;

  constructor() {
    this.fixtureName = previewFixtureName(new URLSearchParams(window.location.search).get('preview'));
    this.installFixture(previewFixture(this.fixtureName), false);
  }

  async request<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    await Promise.resolve();
    let result: unknown;
    switch (method) {
      case 'session.getSnapshot':
        result = this.session;
        break;
      case 'session.getRecentFiles':
        result = { files: [], notice: null };
        break;
      case 'file.close':
        this.reset(emptySession());
        result = { session: this.session, notice: null };
        break;
      case 'session.createFile':
        this.reset(previewFile('Untitled.nendo'));
        result = this.session;
        break;
      case 'session.openFile':
        this.installFixture(previewFixture(this.fixtureName), false);
        result = this.session;
        break;
      case 'data.createRecord':
        result = this.createRecord(payload);
        break;
      case 'data.setField':
        result = this.setField(payload);
        break;
      case 'data.setFields':
        result = this.setFields(payload);
        break;
      case 'data.executeCommand':
        result = this.executeCommand(payload);
        break;
      case 'semantic.compile':
        result = { ...this.compile(), sourceChangeSequence: this.session.manifest?.changeSequence ?? 0 };
        break;
      case 'proposal.prepareChangeSet':
        result = this.prepareChangeSet(payload);
        break;
      case 'proposal.get':
        result = this.previewProposal;
        break;
      case 'proposal.promote':
        result = this.promoteProposal(payload);
        break;
      case 'proposal.reject':
        result = this.rejectProposal(payload);
        break;
      case 'history.get':
        result = this.history;
        break;
      case 'data.queryRecords':
        if (payload.sortFieldId || payload.descending || (Array.isArray(payload.filters) && payload.filters.length))
          throw new WorkbenchHostError('native-query-required', 'Open the native Nendo app to use typed sorting and filtering.');
        result = this.previewPage(this.session.records.filter(row => row.entityId === payload.entityId)
          .sort((left, right) => left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0), payload, `records:${String(payload.entityId)}`);
        break;
      case 'history.query':
        result = this.previewPage([...this.history].sort((left, right) => right.changeSequence - left.changeSequence)
          .map(row => ({ ...row, operations: undefined, operationCount: row.operations.length, canRequestCompensation: false })), payload, 'history');
        break;
      case 'history.operations':
        result = this.previewPage(this.history.find(row => row.revisionId === payload.revisionId)?.operations ?? [], payload,
          `operations:${String(payload.revisionId)}`);
        break;
      case 'health.verify':
        result = this.session.storage;
        break;
      case 'history.compensate':
        throw new WorkbenchHostError(
          'compensation-not-supported',
          'Preview history does not retain compensation evidence.',
        );
      case 'appearance.set':
        result = payload;
        break;
      case 'agent.getStatus':
        result = this.agentStatus;
        break;
      case 'agent.setMode':
        result = this.setAgentMode(payload);
        break;
      case 'agent.revokeEditing':
        result = this.revokeAgentEditing();
        break;
      case 'agent.getProposal':
        result = this.getAgentProposal(payload);
        break;
      case 'agent.setSettings':
        this.agentStatus = {
          ...this.agentStatus,
          leaseExpiry: Boolean(payload.leaseExpiry),
          leaseExpirySeconds: Number(payload.leaseExpirySeconds),
          fixedPort: Boolean(payload.fixedPort),
          portPreference: Number(payload.port),
        };
        result = this.agentStatus;
        break;
      default:
        throw new WorkbenchHostError('unknown-method', `Preview does not implement ${method}.`);
    }
    return structuredClone(result) as T;
  }

  private previewPage<T>(items: T[], payload: Record<string, unknown>, scope: string): ReadPage<T> {
    const sequence = this.session.manifest?.changeSequence ?? 0;
    const limit = typeof payload.limit === 'number' ? payload.limit : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new WorkbenchHostError('invalid-limit', 'Request 1–200 items.');
    let offset = 0;
    if (payload.cursor) {
      let parts: unknown;
      try { parts = JSON.parse(atob(String(payload.cursor))); } catch { throw new WorkbenchHostError('invalid-cursor', 'The page cursor is invalid.'); }
      if (!Array.isArray(parts) || parts[1] !== scope || !Number.isInteger(parts[2])) throw new WorkbenchHostError('invalid-cursor', 'The page cursor is invalid.');
      if (parts[0] !== sequence) throw new WorkbenchHostError('stale-cursor', 'The file changed. Restart paging.');
      offset = parts[2] as number;
    }
    return { items: items.slice(offset, offset + limit), changeSequence: sequence,
      nextCursor: offset + limit < items.length ? btoa(JSON.stringify([sequence, scope, offset + limit])) : null };
  }

  private createRecord(payload: Record<string, unknown>): DesktopMutationView {
    const idempotencyKey = requiredString(payload, 'idempotencyKey');
    const recordId = requiredString(payload, 'recordId');
    const entityId = requiredString(payload, 'entityId');
    const values = requiredObject(payload, 'values');
    return this.mutate('data.createRecord', idempotencyKey, JSON.stringify({ entityId, recordId, values }), () => {
      const entity = requireEntity(this.session, entityId);
      if (this.session.records.some((record) => record.recordId === recordId)) {
        throw new WorkbenchHostError('record-exists', 'The record ID already exists.');
      }
      validateValues(entity, values);
      this.session.records.push({
        entityId,
        recordId,
        recordVersion: 1,
        values: structuredClone(values),
      });
      return this.advance('data', `Create ${entity.displayName}`, 'data.createRecord');
    });
  }

  private setField(payload: Record<string, unknown>): DesktopMutationView {
    const idempotencyKey = requiredString(payload, 'idempotencyKey');
    const entityId = requiredString(payload, 'entityId');
    const recordId = requiredString(payload, 'recordId');
    const fieldId = requiredString(payload, 'fieldId');
    const expectedRecordVersion = requiredNumber(payload, 'expectedRecordVersion');
    return this.mutate(
      'data.setField',
      idempotencyKey,
      JSON.stringify(payload),
      () => {
        const entity = requireEntity(this.session, entityId);
        const field = entity.fields.find((candidate) => candidate.fieldId === fieldId);
        if (field === undefined) {
          throw new WorkbenchHostError('field-missing', 'The field no longer exists.');
        }
        const record = this.session.records.find((candidate) => candidate.entityId === entityId && candidate.recordId === recordId);
        if (record === undefined) {
          throw new WorkbenchHostError('record-missing', 'The record no longer exists.');
        }
        if (record.recordVersion !== expectedRecordVersion) {
          throw new WorkbenchHostError('version-conflict', 'The record changed. Refresh and try again.');
        }
        validateFieldValue(field, payload.value ?? null);
        record.values[fieldId] = payload.value ?? null;
        record.recordVersion += 1;
        return this.advance('data', `Edit ${entity.displayName}`, 'data.setField');
      },
    );
  }

  private setFields(payload: Record<string, unknown>): DesktopMutationView {
    const idempotencyKey = requiredString(payload, 'idempotencyKey');
    const entityId = requiredString(payload, 'entityId');
    const recordId = requiredString(payload, 'recordId');
    const expectedRecordVersion = requiredNumber(payload, 'expectedRecordVersion');
    const values = Object.entries(requiredObject(payload, 'values')).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return this.mutate('data.setFields', idempotencyKey,
      JSON.stringify({ entityId, recordId, expectedRecordVersion, values }), () => {
        if (values.length < 1 || values.length > 64)
          throw new WorkbenchHostError('validation', 'A form save requires 1-64 fields.');
        const entity = requireEntity(this.session, entityId);
        const record = this.session.records.find(candidate => candidate.entityId === entityId && candidate.recordId === recordId);
        if (record === undefined) throw new WorkbenchHostError('record-not-found', 'The record no longer exists.');
        if (record.recordVersion !== expectedRecordVersion)
          throw new WorkbenchHostError('record-version-conflict', 'The record changed. Refresh and try again.');
        for (const [fieldId, value] of values) {
          const field = entity.fields.find(candidate => candidate.fieldId === fieldId);
          if (field === undefined) throw new WorkbenchHostError('field-not-found', 'The field no longer exists.');
          validateFieldValue(field, value);
        }
        for (const [fieldId, value] of values) record.values[fieldId] = value;
        record.recordVersion += values.length;
        return this.advance('data', 'Edit record fields', 'data.setField');
      });
  }

  private executeCommand(payload: Record<string, unknown>): DesktopMutationView {
    const idempotencyKey = requiredString(payload, 'idempotencyKey');
    const entityId = requiredString(payload, 'entityId');
    const recordId = requiredString(payload, 'recordId');
    const commandId = requiredString(payload, 'commandId');
    const expectedRecordVersion = requiredNumber(payload, 'expectedRecordVersion');
    return this.mutate('data.executeCommand', idempotencyKey, JSON.stringify(payload), () => {
      const entity = requireEntity(this.session, entityId);
      const command = this.plan?.surfaces.find((node) => node.kind === 'recordCommand' && node.semanticId === commandId);
      if (command === undefined || command.properties.entityId !== entityId) {
        throw new WorkbenchHostError('command-missing', 'The command is not available.');
      }
      const record = this.session.records.find((candidate) => candidate.entityId === entityId && candidate.recordId === recordId);
      if (record === undefined) {
        throw new WorkbenchHostError('record-missing', 'The record no longer exists.');
      }
      if (record.recordVersion !== expectedRecordVersion) {
        throw new WorkbenchHostError('version-conflict', 'The record changed. Refresh and try again.');
      }
      // A command owns ordered steps and applies them as one mutation.
      for (const step of command.children.filter((child) => child.kind === 'commandStep')) {
        const fieldId = step.properties.fieldId;
        if (typeof fieldId !== 'string') continue;
        record.values[fieldId] = step.properties.valueKind === 'null' ? null : structuredClone(step.properties.value ?? null);
      }
      record.recordVersion += 1;
      const label = typeof command.properties.label === 'string' ? command.properties.label : 'Command';
      return this.advance('data', `${label}: ${entity.displayName}`, 'data.setField');
    });
  }

  private prepareChangeSet(payload: Record<string, unknown>): ProposalPreview {
    requireFile(this.session);
    const proposalId = requiredString(payload, 'proposalId');
    const title = requiredString(payload, 'title');
    const operations = proposalOperations(payload);
    if (operations.length === 0) {
      throw new WorkbenchHostError('validation', 'A proposal must contain at least one operation.');
    }
    const entityId = operations
      .map((operation) => optionalString(operation.payload.entityId))
      .find((candidate): candidate is string => candidate !== null);
    this.proposedFixture = entityId === undefined ? null : previewFixtureForEntity(entityId);
    const plan = this.proposedFixture === null
      ? this.updatedPlan(operations)
      : this.planForCurrentRecords(this.proposedFixture.plan);
    const touchedRecords = new Map<string, ProposalPreview['touchedRecords'][number]>();
    for (const operation of operations) {
      const touchedEntityId = optionalString(operation.payload.entityId);
      const recordId = optionalString(operation.payload.recordId);
      if (touchedEntityId === null || recordId === null) continue;
      const record = this.session.records.find((candidate) => candidate.entityId === touchedEntityId && candidate.recordId === recordId);
      if (record !== undefined) touchedRecords.set(`${touchedEntityId}:${recordId}`, { entityId: touchedEntityId, recordId, version: record.recordVersion });
    }
    this.previewProposal = {
      proposalId,
      title,
      state: 'previewable',
      retention: 'retainUntilExplicitCleanup',
      sourceApplicationId: this.session.manifest!.applicationId,
      sourceInstanceId: this.session.manifest!.instanceId,
      capturedDefinitionRevision: this.session.manifest!.definitionRevision,
      touchedRecords: [...touchedRecords.values()],
      operationDigest: `preview-proposal-digest-${this.session.manifest!.changeSequence}`,
      operationCount: operations.length,
      diagnostics: [],
      semanticDiff: proposalDiff(operations),
      previewApplications: [plan],
    };
    return this.previewProposal;
  }

  private promoteProposal(payload: Record<string, unknown>): DesktopPromotionView {
    const proposalId = requiredString(payload, 'proposalId');
    if (this.agentProposal?.proposalId === proposalId) {
      const mutation = this.advance('definition', this.agentProposal.title, 'ui.setProperty');
      this.clearAgentProposal();
      return {
        promotion: {
          proposalId,
          state: 'active',
          applied: true,
          message: 'The proposal is active.',
          result: { revisions: [mutation] },
        },
        session: structuredClone(this.session),
      };
    }
    if (this.previewProposal === null || this.previewProposal.proposalId !== proposalId) {
      throw new WorkbenchHostError('proposal-missing', 'The proposal is no longer available.');
    }
    if (this.proposedFixture !== null) {
      this.installFixture(this.proposedFixture, true);
    }
    this.plan = structuredClone(this.previewProposal.previewApplications?.[0] ?? null);
    this.applyPlanTitles();
    const mutation = this.advance('definition', this.previewProposal.title, 'ui.setProperty');
    this.previewProposal.state = 'active';
    const result: DesktopPromotionView = {
      promotion: {
        proposalId,
        state: 'active',
        applied: true,
        message: 'The proposal is active.',
        result: { revisions: [mutation] },
      },
      session: structuredClone(this.session),
    };
    this.previewProposal = null;
    this.proposedFixture = null;
    return result;
  }

  private rejectProposal(payload: Record<string, unknown>): DesktopPromotionView {
    const proposalId = requiredString(payload, 'proposalId');
    if (this.agentProposal?.proposalId === proposalId) {
      this.clearAgentProposal();
      return {
        promotion: { proposalId, state: 'rejected', applied: false, message: 'The proposal was rejected.', result: null },
        session: structuredClone(this.session),
      };
    }
    this.previewProposal = null;
    this.proposedFixture = null;
    return {
      promotion: { proposalId, state: 'rejected', applied: false, message: 'The proposal was rejected.', result: null },
      session: structuredClone(this.session),
    };
  }

  private compile(): CompileResult {
    if (this.plan === null) {
      return {
        isValid: false,
        diagnostics: [{
          code: 'definition.missing',
          severity: 'error',
          message: 'The application surfaces have not been added.',
          semanticId: null,
          propertyPath: null,
          hint: 'Prepare and accept an application recipe in Structure or Surfaces.',
        }],
      };
    }
    return { isValid: true, diagnostics: [], applications: [this.currentPlan()] };
  }

  private mutate(
    method: string,
    idempotencyKey: string,
    signature: string,
    action: () => ApplyResult,
  ): DesktopMutationView {
    const scope = `${method}:${idempotencyKey}`;
    const prior = this.idempotency.get(scope);
    if (prior !== undefined) {
      if (prior.signature !== signature) {
        throw new WorkbenchHostError('idempotency-conflict', 'The idempotency key was already used for different work.');
      }
      return {
        mutation: { ...prior.result.mutation, isIdempotentReplay: true },
        session: prior.result.session,
      };
    }

    const mutation = action();
    const result = { mutation, session: structuredClone(this.session) };
    this.idempotency.set(scope, { signature, result: structuredClone(result) });
    return result;
  }

  private advance(
    lane: 'definition' | 'data',
    description = lane === 'definition' ? 'Change application definition' : 'Edit record',
    operationType = lane === 'definition' ? 'schema.createEntity' : 'data.setField',
  ): ApplyResult {
    const manifest = this.session.manifest;
    if (manifest === null) {
      throw new WorkbenchHostError('no-file-open', 'Open or create a Nendo file first.');
    }
    if (lane === 'definition') {
      manifest.definitionRevision += 1;
    } else {
      manifest.dataRevision += 1;
    }
    manifest.changeSequence += 1;
    manifest.modifiedAt = new Date().toISOString();
    const result = {
      revisionId: `preview-revision-${manifest.changeSequence}`,
      operationDigest: `preview-digest-${manifest.changeSequence}`,
      definitionRevision: manifest.definitionRevision,
      dataRevision: manifest.dataRevision,
      changeSequence: manifest.changeSequence,
      isIdempotentReplay: false,
    };
    this.history.push({
      revisionId: result.revisionId,
      createdAt: manifest.modifiedAt,
      origin: 'studio',
      description,
      lane,
      definitionRevisionBefore: lane === 'definition' ? manifest.definitionRevision - 1 : manifest.definitionRevision,
      definitionRevisionAfter: manifest.definitionRevision,
      dataRevisionBefore: lane === 'data' ? manifest.dataRevision - 1 : manifest.dataRevision,
      dataRevisionAfter: manifest.dataRevision,
      changeSequence: manifest.changeSequence,
      operationDigest: result.operationDigest,
      idempotencyScope: 'preview',
      idempotencyKey: null,
      proposalId: null,
      proposalDigest: null,
      compensationOfRevisionId: null,
      operations: [{
        operationId: `preview-operation-${manifest.changeSequence}`,
        operationType,
        reversibility: operationType === 'schema.createEntity' ? 'irreversibleDeclared' : 'reversibleWithRetainedState',
        canonicalJson: '{}',
      }],
    });
    this.syncPlan();
    return result;
  }

  private reset(session: DesktopSessionView): void {
    this.session = session;
    this.plan = null;
    this.previewProposal = null;
    this.agentProposal = null;
    this.agentStatus = emptyAgentStatus(session.hasFile);
    this.proposedFixture = null;
    this.history = [];
    this.idempotency.clear();
  }

  private installFixture(fixture: PreviewFixture, preserveRecords: boolean): void {
    const session = previewFile(fixture.fileName);
    const existingRecords = preserveRecords ? structuredClone(this.session.records) : structuredClone(fixture.records);
    session.entities = [structuredClone(fixture.entity)];
    session.records = existingRecords.filter((record) => record.entityId === fixture.entity.entityId);
    session.uiNodes = structuredClone(fixture.uiNodes);
    if (session.manifest !== null) {
      session.manifest.definitionRevision = 1;
      session.manifest.dataRevision = session.records.length;
      session.manifest.changeSequence = 1 + session.records.length;
      session.manifest.minimumHostVersion = '1.1.0';
    }
    this.session = session;
    this.plan = structuredClone(fixture.plan);
    this.syncPlan();
    if (!preserveRecords) this.installAgentFixture(fixture);
  }

  private setAgentMode(payload: Record<string, unknown>): AgentStatus {
    const mode = requiredString(payload, 'mode');
    if (!isAgentMode(mode)) {
      throw new WorkbenchHostError('validation', 'Choose Off, Inspect, Edit data or Shape app.');
    }
    this.agentStatus.mode = mode;
    this.agentStatus.state = mode === 'off' ? 'off' : 'ready';
    this.agentStatus.connectedAgent = mode === 'off' ? null : 'Local agent (agent-93b827c021d4)';
    this.agentStatus.editingOwner = null;
    this.agentStatus.leaseExpiresAt = null;
    this.agentStatus.recentActivity.push({
      timestamp: '2026-09-03T12:05:00Z',
      client: 'Nendo Desktop',
      category: 'access',
      name: `mode.${mode}`,
      outcome: 'completed',
      revisionId: null,
      proposalId: null,
    });
    this.agentStatus.recentActivity = this.agentStatus.recentActivity.slice(-20);
    return this.agentStatus;
  }

  private revokeAgentEditing(): AgentStatus {
    this.agentStatus.editingOwner = null;
    this.agentStatus.leaseExpiresAt = null;
    this.agentStatus.recentActivity.push({
      timestamp: '2026-09-03T12:06:00Z',
      client: 'Nendo Desktop',
      category: 'access',
      name: 'editing revoked',
      outcome: 'completed',
      revisionId: null,
      proposalId: null,
    });
    this.agentStatus.recentActivity = this.agentStatus.recentActivity.slice(-20);
    return this.agentStatus;
  }

  private getAgentProposal(payload: Record<string, unknown>): AgentProposalPreview {
    const proposalId = requiredString(payload, 'proposalId');
    if (this.agentProposal === null || this.agentProposal.proposalId !== proposalId) {
      throw new WorkbenchHostError('proposal-not-found', 'The pending agent proposal no longer exists.');
    }
    return this.agentProposal;
  }

  private installAgentFixture(fixture: PreviewFixture): void {
    const proposalId = 'proposal-93b827c021d400000000000000000001';
    this.agentProposal = {
      proposalId,
      title: `Refine ${fixture.entity.displayName} workflow`,
      state: 'previewable',
      retention: 'retainUntilExplicitCleanup',
      capturedDefinitionRevision: this.session.manifest?.definitionRevision ?? 0,
      operationDigest: 'preview-agent-proposal-digest-93b827c021d4',
      operationCount: 4,
      diagnostics: [],
      semanticDiff: [{
        kind: 'surface',
        summary: `Clarify the ${rootLabel(fixture.plan, 'boardSurface')} surface`,
        semanticIds: [rootId(fixture.plan, 'boardSurface')],
        reversibility: 'reversibleWithRetainedState',
      }],
      preview: {
        contractVersion: fixture.plan.contractVersion,
        fieldCount: fixture.entity.fields.length,
        recordCount: fixture.records.length,
        scope: 'wholeFileAfterChange',
        minimumHostVersionBefore: this.session.manifest?.minimumHostVersion ?? null,
        minimumHostVersionAfter: this.session.manifest?.minimumHostVersion ?? null,
        purposeBefore: this.session.manifest?.purpose ?? null,
        purposeAfter: this.session.manifest?.purpose ?? null,
        entities: [{
          entityId: fixture.entity.entityId,
          displayName: fixture.entity.displayName,
          fieldCount: fixture.entity.fields.length,
          recordCount: fixture.records.length,
          retired: false,
        }],
        surfaces: fixture.plan.surfaces.map((root) => ({
          nodeId: root.semanticId,
          kind: root.kind,
          title: rootLabel(fixture.plan, root.kind),
          entityId: fixture.entity.entityId,
        })),
      },
    };
    this.agentStatus = {
      ...emptyAgentStatus(true),
      available: true,
      mode: 'shapeApp',
      state: 'ready',
      connectedAgent: 'Local agent (agent-93b827c021d4)',
      editingOwner: null,
      leaseExpiresAt: null,
      recentActivity: [
        {
          timestamp: '2026-09-03T12:00:00Z',
          client: 'Local agent (agent-93b827c021d4)',
          category: 'resource',
          name: 'nendo://application/manifest',
          outcome: 'completed',
          revisionId: null,
          proposalId: null,
        },
        {
          timestamp: '2026-09-03T12:01:00Z',
          client: 'Local agent (agent-93b827c021d4)',
          category: 'authoring',
          name: 'change set validated',
          outcome: 'completed',
          revisionId: null,
          proposalId,
        },
      ],
      pendingProposals: [agentProposalSummary(this.agentProposal)],
    };
  }

  private clearAgentProposal(): void {
    this.agentProposal = null;
    this.agentStatus.pendingProposals = [];
  }

  private updatedPlan(operations: PreviewOperation[]): ApplicationPlan {
    if (this.plan === null) {
      throw new WorkbenchHostError('definition-missing', 'The preview cannot compile this proposal without an application recipe.');
    }
    const plan = this.currentPlan();
    for (const operation of operations.filter((candidate) => candidate.operationType === 'ui.setProperty')) {
      const propertyName = optionalString(operation.payload.propertyName);
      const title = optionalString(operation.payload.value);
      const surfaceId = optionalString(operation.payload.surfaceId);
      const nodeId = optionalString(operation.payload.nodeId);
      if (propertyName !== 'title' || title === null) continue;
      // The compiled tree carries no surfaceId, so a rename is matched by node.
      for (const root of plan.surfaces) {
        if (root.semanticId === nodeId || root.semanticId === surfaceId) root.properties.title = title;
      }
    }
    return plan;
  }

  private currentPlan(): ApplicationPlan {
    if (this.plan === null) throw new WorkbenchHostError('definition-missing', 'The application has no compiled surfaces.');
    this.syncPlan();
    return structuredClone(this.plan);
  }

  private planForCurrentRecords(source: ApplicationPlan): ApplicationPlan {
    const plan = structuredClone(source);
    const records = this.session.records.filter((record) => record.entityId === plan.entity.semanticId);
    plan.records = records.map(recordPlan);
    return plan;
  }

  private syncPlan(): void {
    if (this.plan === null) return;
    const manifest = this.session.manifest;
    this.plan.applicationId = manifest?.applicationId ?? 'preview';
    this.plan.definitionRevision = manifest?.definitionRevision ?? 0;
    this.plan.dataRevision = manifest?.dataRevision ?? 0;
    this.plan.digest = `preview-plan-${manifest?.changeSequence ?? 0}`;
    this.plan.records = this.session.records
      .filter((record) => record.entityId === this.plan?.entity.semanticId)
      .map(recordPlan);
  }

  private applyPlanTitles(): void {
    if (this.plan === null) return;
    for (const root of this.plan.surfaces) {
      const node = this.session.uiNodes.find((candidate) => candidate.nodeId === root.semanticId);
      if (node !== undefined) node.properties.title = root.properties.title;
    }
  }
}

function rootOf(plan: ApplicationPlan, kind: string): SurfaceNodePlan | undefined {
  return plan.surfaces.find((node) => node.kind === kind);
}

function rootId(plan: ApplicationPlan, kind: string): string {
  return rootOf(plan, kind)?.semanticId ?? kind;
}

function rootLabel(plan: ApplicationPlan, kind: string): string {
  const root = rootOf(plan, kind);
  const label = root?.properties.title ?? root?.properties.label;
  return typeof label === 'string' ? label : kind;
}

interface PreviewOperation {
  operationType: string;
  payload: Record<string, unknown>;
}

function proposalOperations(payload: Record<string, unknown>): PreviewOperation[] {
  if (!Array.isArray(payload.mutations)) {
    throw new WorkbenchHostError('validation', 'mutations must be an array.');
  }
  const operations: PreviewOperation[] = [];
  for (const mutation of payload.mutations) {
    if (!isObject(mutation) || !Array.isArray(mutation.operations)) {
      throw new WorkbenchHostError('validation', 'Each mutation must contain operations.');
    }
    for (const operation of mutation.operations) {
      if (!isObject(operation) || typeof operation.operationType !== 'string' || !isObject(operation.payload)) {
        throw new WorkbenchHostError('validation', 'Each operation must contain an operationType and payload.');
      }
      operations.push({ operationType: operation.operationType, payload: operation.payload });
    }
  }
  return operations;
}

function proposalDiff(operations: PreviewOperation[]): SemanticDiffEntry[] {
  const entries: SemanticDiffEntry[] = [];
  const types = new Set(operations.map((operation) => operation.operationType));
  if ([...types].some((type) => type.startsWith('schema.'))) {
    entries.push({ kind: 'structure', summary: 'Add or update record structure', semanticIds: [], reversibility: 'irreversibleDeclared' });
  }
  if ([...types].some((type) => type.startsWith('ui.'))) {
    entries.push({ kind: 'surface', summary: 'Add or update application surfaces', semanticIds: [], reversibility: 'reversibleWithRetainedState' });
  }
  if ([...types].some((type) => type.startsWith('data.'))) {
    entries.push({ kind: 'data', summary: 'Update existing records', semanticIds: [], reversibility: 'reversibleWithRetainedState' });
  }
  return entries;
}

function recordPlan(record: RecordSnapshot): RecordPlan {
  return {
    semanticId: record.recordId,
    automationTarget: `record-${record.recordId.replaceAll('.', '-').replaceAll('_', '-')}`,
    version: record.recordVersion,
    values: structuredClone(record.values),
  };
}

function requiredObject(payload: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = payload[name];
  if (!isObject(value)) {
    throw new WorkbenchHostError('validation', `${name} must be an object.`);
  }
  return value;
}

function requireEntity(session: DesktopSessionView, entityId: string): EntitySnapshot {
  requireFile(session);
  const entity = session.entities.find((candidate) => candidate.entityId === entityId);
  if (entity === undefined) {
    throw new WorkbenchHostError('entity-missing', 'The record type no longer exists.');
  }
  return entity;
}

function validateValues(entity: EntitySnapshot, values: Record<string, unknown>): void {
  const fields = new Map(entity.fields.map((field) => [field.fieldId, field]));
  for (const fieldId of Object.keys(values)) {
    if (!fields.has(fieldId)) throw new WorkbenchHostError('field-missing', 'The record contains an unknown field.');
  }
  for (const field of entity.fields) validateFieldValue(field, values[field.fieldId] ?? null);
}

function validateFieldValue(field: EntitySnapshot['fields'][number], value: unknown): void {
  if (value === null || value === '') {
    if (field.required) throw new WorkbenchHostError('validation', `${field.displayName} is required.`);
    return;
  }
  if (field.options.length > 0 && (typeof value !== 'string' || !field.options.includes(value))) {
    throw new WorkbenchHostError('validation', `${field.displayName} must use one of its available choices.`);
  }
  if ((field.storageKind === 'integer' || field.storageKind === 'decimal') && typeof value !== 'number') {
    throw new WorkbenchHostError('validation', `${field.displayName} must be a number.`);
  }
  if (field.storageKind === 'boolean' && typeof value !== 'boolean') {
    throw new WorkbenchHostError('validation', `${field.displayName} must be true or false.`);
  }
}

function emptySession(): DesktopSessionView {
  return {
    fileSessionId: null,
    capabilities: fileCapabilities(false),
    findings: [],
    hasFile: false,
    fileName: null,
    health: 'noFile',
    manifest: null,
    entities: [],
    records: [],
    uiNodes: [],
    storage: null,
    // The preview host is not a build of the product; say so rather than invent
    // a version number a reader would take for the real one.
    hostVersion: 'preview',
  };
}

function emptyAgentStatus(available: boolean): AgentStatus {
  return {
    available,
    mode: 'off',
    state: available ? 'off' : 'noFile',
    connectedAgent: null,
    editingOwner: null,
    leaseExpiresAt: null,
    recentActivity: [],
    pendingProposals: [],
    leaseExpiry: false,
    leaseExpirySeconds: 60,
    fixedPort: true,
    portPreference: 41763,
    endpoint: 'http://127.0.0.1:41763/mcp',
    usingPreferredPort: true,
    settingsPersisted: true,
    settingsNotice: null,
  };
}

function isAgentMode(value: string): value is AgentAccessMode {
  return value === 'off' || value === 'inspect' || value === 'editData' ||
    value === 'shapeApp' || value === 'unattended';
}

function agentProposalSummary(preview: AgentProposalPreview): AgentProposalSummary {
  return {
    proposalId: preview.proposalId,
    title: preview.title,
    state: preview.state,
    operationDigest: preview.operationDigest,
    operationCount: preview.operationCount,
    capturedDefinitionRevision: preview.capturedDefinitionRevision,
    diagnosticCount: preview.diagnostics.length,
    reversibility: preview.semanticDiff.some((entry) =>
      entry.reversibility === 'irreversibleDeclared' || entry.reversibility === 2)
      ? 'irreversibleDeclared'
      : 'reversibleWithRetainedState',
  };
}

function previewFile(fileName: string): DesktopSessionView {
  const now = new Date().toISOString();
  return {
    fileSessionId: `preview-${crypto.randomUUID()}`,
    capabilities: fileCapabilities(true),
    findings: [],
    hasFile: true,
    fileName,
    health: 'normal',
    manifest: {
      formatIdentifier: 'nendo.sqlite.application',
      formatVersion: 1,
      minimumHostVersion: '1.0.0',
      purpose: null,
      applicationId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      createdAt: now,
      modifiedAt: now,
      definitionRevision: 0,
      dataRevision: 0,
      changeSequence: 0,
    },
    entities: [],
    records: [],
    uiNodes: [],
    storage: {
      journalMode: 'delete',
      synchronousMode: 'full',
      busyTimeoutMilliseconds: 2000,
      integrityResult: 'ok',
      operationalSidecars: [],
    },
  };
}

function requiredString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkbenchHostError('validation', `${name} is required.`);
  }
  return value;
}

function requiredNumber(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WorkbenchHostError('validation', `${name} must be an integer.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function requireFile(session: DesktopSessionView): void {
  if (!session.hasFile || session.manifest === null) {
    throw new WorkbenchHostError('no-file-open', 'Open or create a Nendo file first.');
  }
}
