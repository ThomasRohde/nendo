import type { ApplyResult, DesktopOperationView } from './host';

export interface PendingMutation {
  version: 1;
  fileIdentity: string;
  fileSessionId: string;
  method: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'committed' | 'notApplied';
}

interface RetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
type Send = <T>(method: string, payload?: Record<string, unknown>) => Promise<T>;
const methods = new Set(['data.createRecord', 'data.deleteRecord', 'data.setField', 'data.setFields', 'data.executeCommand', 'history.compensate', 'proposal.promote']);
const rejected = new Set(['validation', 'invalid-request', 'idempotency-conflict', 'record-version-conflict',
  'record-referenced', 'record-id-reserved', 'record-version-exhausted', 'deletion-state-conflict',
  'choice-retired', 'label-conflict', 'definition-version-conflict',
  'entity-retired', 'field-retired', 'entity-referenced', 'retired-binding', 'required-backfill-needed',
  'target-version-required', 'target-version-conflict', 'target-not-found', 'reference-unbound',
  'entity-not-found', 'field-not-found', 'record-not-found', 'command-unavailable', 'compensation-not-supported', 'proposal-not-found',
  // A save refused because an automatic action could not run. The whole transaction
  // rolled back, so nothing is in flight.
  'calculation-missing-input', 'calculation-divide-by-zero', 'calculation-overflow', 'calculation-invalid-date',
  'calculation-text-too-long', 'calculation-limit-reached', 'calculation-dependency-failed', 'calculation-related-unavailable',
  'calculation-refused']);
const maximumCharacters = 131_072;

export function isJournaledMutation(method: string): boolean { return methods.has(method); }

/** A host code that confirms the complete refusal of a request: the file was left
 * unchanged and nothing remains in flight. `sendPending` drops the journal entry on
 * exactly these codes, so a caller that sees one knows the outcome is settled rather
 * than unknown. Any other code — a transport failure, a lost response — leaves the
 * request retained and its outcome undetermined. */
export function isConfirmedRejection(code: string): boolean { return rejected.has(code); }

function validIdentity(method: string, payload: Record<string, unknown>): boolean {
  return method === 'proposal.promote'
    ? typeof payload.proposalId === 'string' && payload.proposalId.length > 0 && payload.proposalId.length <= 80 &&
      typeof payload.expectedOperationDigest === 'string' && /^[0-9a-f]{64}$/i.test(payload.expectedOperationDigest)
    : typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length > 0 && payload.idempotencyKey.length <= 200;
}

/** Bounded device-local retry scratch. The file's canonical receipt is the
 * authority for commit; this record only retains the exact unacknowledged input. */
export class PendingMutationJournal {
  private readonly storage: RetryStorage;
  private readonly confirmed = new Map<string, 'committed' | 'notApplied'>();

  constructor(storage: RetryStorage) { this.storage = storage; }

  private storageKey(fileIdentity: string): string { return 'nendo.pending-mutation.v1.' + fileIdentity; }
  private identity(entry: PendingMutation): string {
    return entry.fileIdentity + ':' + (entry.method === 'proposal.promote'
      ? 'proposal:' + entry.payload.proposalId + ':' + entry.payload.expectedOperationDigest : entry.payload.idempotencyKey);
  }

  read(fileIdentity: string): PendingMutation | null {
    let text: string | null;
    try { text = this.storage.getItem(this.storageKey(fileIdentity)); }
    catch { throw new Error('The local retry record cannot be read. Restore local storage before saving.'); }
    if (text === null) return null;
    try {
      if (text.length > maximumCharacters) throw new Error();
      const entry = JSON.parse(text) as PendingMutation;
      if (entry.version !== 1 || entry.fileIdentity !== fileIdentity || typeof entry.fileSessionId !== 'string' ||
        !methods.has(entry.method) || !entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload) ||
        !validIdentity(entry.method, entry.payload) ||
        (entry.state !== 'pending' && entry.state !== 'committed' && entry.state !== 'notApplied')) throw new Error();
      entry.state = this.confirmed.get(this.identity(entry)) ?? entry.state;
      return entry;
    } catch { throw new Error('The local retry record is invalid. Keep this file unchanged and use Health to close and inspect it.'); }
  }

  async submit(send: Send, fileIdentity: string, fileSessionId: string, method: string,
    payload: Record<string, unknown>): Promise<DesktopOperationView> {
    const previous = this.read(fileIdentity);
    if (previous !== null && previous.state === 'pending')
      throw new Error('A previous save is still unconfirmed. Check or retry that saved request first.');
    let entry: PendingMutation = { version: 1, fileIdentity, fileSessionId, method, payload, state: 'pending' };
    try {
      const serialized = JSON.stringify(entry);
      if (serialized.length > maximumCharacters || !validIdentity(method, payload)) throw new Error();
      this.storage.setItem(this.storageKey(fileIdentity), serialized);
      entry = JSON.parse(serialized) as PendingMutation;
      if (previous !== null) this.confirmed.delete(this.identity(previous));
    } catch { throw new Error('The exact save request could not be retained locally. Nothing was sent. Check available local storage and try again.'); }
    return this.sendPending(send, entry);
  }

  async retry(send: Send, fileIdentity: string, allowReplay = true): Promise<DesktopOperationView | null> {
    const entry = this.read(fileIdentity);
    if (entry === null) return null;
    const receipt = await this.lookup(send, entry);
    if (receipt !== null) return this.acknowledge(entry, receipt);
    if (!allowReplay) return null;
    if (entry.state === 'committed') throw new Error('The saved receipt is no longer recorded in this file state. Inspect History before changing the file.');
    return this.sendPending(send, entry);
  }

  private async lookup(send: Send, entry: PendingMutation): Promise<DesktopOperationView | null> {
    if (entry.method === 'proposal.promote') {
      const receipt = await send<{ changeSetDigest: string } | null>('proposal.getReceipt', { proposalId: entry.payload.proposalId });
      if (receipt === null) return null;
      if (receipt.changeSetDigest !== entry.payload.expectedOperationDigest)
        throw new Error('The saved proposal receipt has a different digest. Inspect History and review the current proposal.');
      return { promotion: { proposalId: String(entry.payload.proposalId), state: 'active', applied: true,
        message: 'Proposal acceptance confirmed from its saved receipt.', result: receipt }, session: null };
    }
    const receipt = await send<ApplyResult | null>(entry.method === 'history.compensate' ? 'history.getCompensationReceipt' : 'data.getReceipt',
      { idempotencyKey: entry.payload.idempotencyKey });
    return receipt === null ? null : { mutation: receipt, session: null };
  }

  private async sendPending(send: Send, entry: PendingMutation): Promise<DesktopOperationView> {
    try {
      const result = await send<DesktopOperationView>(entry.method, entry.payload);
      return this.acknowledge(entry, result);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (rejected.has(code)) {
        this.removeIfMatching(entry);
        throw error;
      }
      if (code !== 'stale-file-session' && code !== 'recovery-required') {
        try {
          const receipt = await this.lookup(send, entry);
          if (receipt !== null) return this.acknowledge(entry, receipt);
        } catch { /* Keep the exact request when either response is unknown. */ }
      }
      throw error;
    }
  }

  private acknowledge(entry: PendingMutation, result: DesktopOperationView): DesktopOperationView {
    this.confirmed.set(this.identity(entry), 'promotion' in result && !result.promotion.applied ? 'notApplied' : 'committed');
    this.removeIfMatching(entry);
    return result;
  }

  private removeIfMatching(entry: PendingMutation): void {
    try {
      const current = this.read(entry.fileIdentity);
      if (current !== null && this.identity(current) === this.identity(entry))
        this.storage.removeItem(this.storageKey(entry.fileIdentity));
      this.confirmed.delete(this.identity(entry));
    } catch { /* Cleanup cannot hide a returned commit or erase another request. */ }
  }
}
