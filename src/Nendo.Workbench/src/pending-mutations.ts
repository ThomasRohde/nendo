import type { ApplyResult, DesktopOperationView } from './host';
import { WorkbenchHostError } from './host-types';

export interface PendingMutation {
  version: 1;
  fileIdentity: string;
  fileSessionId: string;
  method: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'committed' | 'notApplied';
  /**
   * The file it was made in, by name, and when. A raw copy or a backup keeps the file's
   * application and instance IDs, so it finds this request under the same key; the name is what
   * stops Check or retry sending it into the copy. Absent from a request kept by an older build.
   */
  fileName?: string;
  savedAt?: string;
  /**
   * The open file has another name than the one this was made in: a copy, a backup, or the same
   * file renamed. Only the person can tell which, so it is neither sent nor dropped on its own.
   * Worked out by the host adapter as it reads the request; never stored.
   */
  madeElsewhere?: boolean;
  /**
   * The host stopped this request when the person pressed Stop, and the receipt check that
   * followed found nothing, so it may be discarded unsent. Known to this renderer only:
   * never stored, so after a restart the save is resolved by Check or retry.
   */
  discardable?: boolean;
}

interface RetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
type Send = <T>(method: string, payload?: Record<string, unknown>) => Promise<T>;
/** A save refused before it was sent; nothing reached the file. */
export const notSentCode = 'not-sent';
const methods = new Set(['data.createRecord', 'data.deleteRecord', 'data.moveRecord', 'data.setKeptInNewFiles', 'data.setField', 'data.setFields', 'data.executeCommand', 'history.compensate', 'proposal.promote']);
const rejected = new Set(['validation', 'invalid-request', 'idempotency-conflict', 'record-version-conflict',
  'record-referenced', 'record-id-reserved', 'record-version-exhausted', 'deletion-state-conflict',
  'choice-retired', 'label-conflict', 'definition-version-conflict',
  'entity-retired', 'field-retired', 'entity-referenced', 'retired-binding', 'field-requirement-in-use', 'required-backfill-needed',
  'target-version-required', 'target-version-conflict', 'target-not-found', 'reference-unbound',
  'entity-not-found', 'field-not-found', 'record-not-found', 'command-unavailable', 'compensation-not-supported', 'proposal-not-found',
  'hierarchy-not-declared', 'hierarchy-order-not-declared', 'hierarchy-sibling-not-found',
  'hierarchy-cycle', 'hierarchy-too-deep', 'move-unchanged',
  // ADR-0026: the whole mutation was refused at its end, so nothing of it landed.
  'link-not-allowed', 'links-not-allowed',
  // ADR-0031: a picture's address, content or bounds, refused before the mutation committed.
  'media-missing', 'media-address-invalid', 'media-type-mismatch', 'media-too-large', 'media-budget-exceeded', 'field-not-media',
  'media-unavailable', 'media-clipboard-empty', 'media-download-failed', 'media-already-embedded',
  // A picture that cannot be the file's icon, refused before it was embedded.
  'icon-invalid',
  // Refused inside the write's own transaction before it committed (ADR-0019, ADR-0020 and
  // the open ceilings). Left out, a duplicate in a unique field kept the save pending for
  // good and locked editing of the file on this device. refusal-codes.test.mjs
  // fails when the Engine gains a code that is neither listed here nor named as unsettled.
  'value-not-unique', 'field-values-not-unique', 'kept-in-new-files-unchanged',
  'hierarchy-parent-invalid', 'hierarchy-parent-required', 'hierarchy-order-invalid', 'hierarchy-cycle-present',
  'write-ceiling-bytes', 'write-ceiling-rows', 'write-ceiling-schema', 'action-target-mismatch', 'read-only',
  // Another program kept the file busy past the timeout: the write rolled back whole.
  'file-busy',
  'revision-not-found', 'revision-not-yours', 'not-an-undo',
  'record-exists-or-invalid', 'behaviour-not-approved', 'definition-not-found', 'field-calculated',
  // A save refused because an automatic action could not run. The whole transaction
  // rolled back, so nothing is in flight.
  'calculation-missing-input', 'calculation-divide-by-zero', 'calculation-overflow', 'calculation-invalid-date',
  'calculation-text-too-long', 'calculation-limit-reached', 'calculation-dependency-failed', 'calculation-related-unavailable',
  'calculation-refused', 'calculation-stored-value-invalid',
  // Refused here, before anything was sent: the request could not be kept on this device, or a
  // previous one is still unconfirmed. The file is untouched, so the person's typing stays.
  notSentCode]);
/**
 * The most a kept request may hold: the host's own message limit (262,144 characters,
 * WorkbenchProtocol.MaximumMessageCharacters) less room for the envelope around the payload. Half
 * of that refused saves the host would have taken, and said the cause was local storage.
 */
export const maximumCharacters = 262_144 - 4_096;

export function isJournaledMutation(method: string): boolean { return methods.has(method); }

/** Whether two file names name one file as Windows reads them: letter case does not count. */
export function sameFileName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Whether a kept request was made in a file of another name than the one open now. */
export function madeElsewhere(entry: PendingMutation, fileName: string | null): boolean {
  return entry.fileName !== undefined && fileName !== null && !sameFileName(entry.fileName, fileName);
}

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
  /** Requests the host stopped and whose receipt was then not found. */
  private readonly stopped = new Set<string>();

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
      if (entry.state === 'pending' && this.stopped.has(this.identity(entry))) entry.discardable = true;
      return entry;
    } catch { throw new Error('The local retry record is invalid. Keep this file unchanged and use Health to close and inspect it.'); }
  }

  async submit(send: Send, fileIdentity: string, fileSessionId: string, method: string,
    payload: Record<string, unknown>, fileName: string | null = null): Promise<DesktopOperationView> {
    const previous = this.read(fileIdentity);
    if (previous !== null && previous.state === 'pending')
      throw new WorkbenchHostError(notSentCode, 'A previous save is still unconfirmed. Check or retry that saved request first. Nothing was sent.');
    let entry: PendingMutation = { version: 1, fileIdentity, fileSessionId, method, payload, state: 'pending',
      ...(fileName === null ? {} : { fileName, savedAt: new Date().toISOString() }) };
    const serialized = JSON.stringify(entry);
    // Each refusal says its own cause and is coded as unsent, so the typing it refused stays on
    // screen: both were a plain error once, which redrew the form from stored values.
    if (serialized.length > maximumCharacters)
      throw new WorkbenchHostError(notSentCode, `This change is too large to save from here: ${serialized.length.toLocaleString()} characters, and at most ${maximumCharacters.toLocaleString()} can be sent. Nothing was sent.`);
    if (!validIdentity(method, payload))
      throw new WorkbenchHostError(notSentCode, 'This change has no request key to retry it by. Nothing was sent.');
    try {
      this.storage.setItem(this.storageKey(fileIdentity), serialized);
      entry = JSON.parse(serialized) as PendingMutation;
      if (previous !== null) { this.confirmed.delete(this.identity(previous)); this.stopped.delete(this.identity(previous)); }
    } catch {
      throw new WorkbenchHostError(notSentCode, 'The exact save request could not be kept on this device, so nothing was sent. Check that local storage is available, then save again.');
    }
    return this.sendPending(send, entry);
  }

  async retry(send: Send, fileIdentity: string, allowReplay = true, fileName: string | null = null, intoThisFile = false): Promise<DesktopOperationView | null> {
    const entry = this.read(fileIdentity);
    if (entry === null) return null;
    const receipt = await this.lookup(send, entry);
    if (receipt !== null) return this.acknowledge(entry, receipt);
    if (!allowReplay) return null;
    // Sent only into the file it was made in. A copy or a backup of that file carries the same
    // identity, and Check or retry wrote the original's change into the copy. A file
    // renamed since is that file, which only the person can say: `intoThisFile` is their word.
    if (!intoThisFile && madeElsewhere(entry, fileName))
      throw new WorkbenchHostError('pending-in-another-file', `This unconfirmed save was made in ${entry.fileName}, not in ${fileName}, so it is not sent here on its own. Send it into this file if this is ${entry.fileName} renamed; discard it here if this is a copy.`);
    if (entry.state === 'committed') throw new Error('The saved receipt is no longer recorded in this file state. Inspect History before changing the file.');
    return this.sendPending(send, entry);
  }

  /**
   * Drops a request the host stopped, without sending it. Offered only after the host
   * answered the stop and a receipt check found nothing; the receipt is checked once more here,
   * and a request that landed after all is acknowledged as committed instead. Null when it was
   * discarded.
   */
  async discard(send: Send, fileIdentity: string, fileName: string | null = null): Promise<DesktopOperationView | null> {
    const entry = this.read(fileIdentity);
    if (entry === null) return null;
    // A save made under another file name may be dropped here too, once the person has said so:
    // otherwise a copy opened before the original was checked stayed locked.
    if (entry.state !== 'pending' || (!this.stopped.has(this.identity(entry)) && !madeElsewhere(entry, fileName)))
      throw new Error('Only a save that was stopped, and found not to have landed, can be discarded. Check or retry it instead.');
    const receipt = await this.lookup(send, entry);
    if (receipt !== null) return this.acknowledge(entry, receipt);
    this.removeIfMatching(entry);
    return null;
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
      if (isConfirmedRejection(code)) {
        this.removeIfMatching(entry);
        throw error;
      }
      if (code !== 'stale-file-session' && code !== 'recovery-required') {
        try {
          const receipt = await this.lookup(send, entry);
          if (receipt !== null) return this.acknowledge(entry, receipt);
          // The host answers a stop only once the work has stopped, and nothing landed: the
          // person may now drop it rather than send what they stopped.
          if (code === 'cancelled') this.stopped.add(this.identity(entry));
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
      this.stopped.delete(this.identity(entry));
    } catch { /* Cleanup cannot hide a returned commit or erase another request. */ }
  }
}
