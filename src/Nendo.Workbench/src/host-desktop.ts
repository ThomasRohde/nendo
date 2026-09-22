import { type AgentWork, type DesktopFileActionView, type DesktopSessionView } from './host-types';
import { protocolVersion } from './host';
import { PendingMutationJournal, isJournaledMutation, type PendingMutation } from './pending-mutations';
import {
  WorkbenchHostError, isHostRoute,
  type CancelledRequests, type DesktopOperationView, type HostRoute, type HostRecordTarget, type WorkbenchClient,
} from './host-types';

/**
 * The real client, and the one that fails closed.
 *
 * Every request crosses the WebView2 bridge with the protocol version attached
 * and is matched back to its caller by request id. A response from a host
 * speaking a different version is refused rather than parsed. Outside the
 * Desktop host there is no bridge at all, and every request is refused with the
 * same message rather than appearing to work.
 */

interface WorkbenchResponse<T> {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  result: T | null;
  error: { code: string; message: string } | null;
}

/**
 * A message the host sent on its own account.
 *
 * It carries an `event` where a response carries a `requestId`, which is what
 * keeps the two apart without a flag: the response path looks the message up by
 * id, finds nothing, and drops it. That is exactly what a Workbench built before
 * this existed does with one, and why the host may post it to any version.
 */
interface HostEvent {
  protocolVersion: number;
  event: string;
  payload: unknown;
}

interface PendingRequest {
  method: string;
  fileSessionId: string | null;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: number | null;
}

interface WebViewBridge {
  postMessage(message: unknown): void;
  /**
   * The same message with objects from outside the page attached — here, a file the
   * person dropped on the window. It is the only way a path reaches the host: the
   * page never sees one, and the host asks Windows for it rather than taking the
   * page's word. Absent on a host too old to carry files, which is why it is
   * optional rather than assumed.
   */
  postMessageWithAdditionalObjects?(message: unknown, additionalObjects: ArrayLike<unknown>): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

declare global {
  interface Window {
    chrome?: {
      webview?: WebViewBridge;
    };
  }
}

export class DesktopWorkbenchClient implements WorkbenchClient {
  readonly mode = 'desktop' as const;
  private readonly pending = new Map<string, PendingRequest>();
  private fileSessionId: string | null = null;
  private fileIdentity: string | null = null;
  private readonly navigateListeners = new Set<(route: HostRoute) => void>();
  private readonly openRecordListeners = new Set<(target: HostRecordTarget) => void>();
  private readonly fileChangedListeners = new Set<(changeSequence: number) => void>();
  private readonly agentActivityListeners = new Set<(work: AgentWork) => void>();
  private readonly journal = new PendingMutationJournal({
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: key => window.localStorage.removeItem(key),
  });

  constructor(private readonly bridge: WebViewBridge) {
    bridge.addEventListener('message', (event) => this.receive(event.data));
  }

  /** Whether this host can be handed a file that was dropped on the window. */
  get acceptsDroppedFiles(): boolean {
    return typeof this.bridge.postMessageWithAdditionalObjects === 'function';
  }

  /**
   * Opens a file the person dropped on the window.
   *
   * The file goes across as an object rather than as a name, so the host resolves the
   * path itself. A page that had been tampered with could still only ask about a file
   * somebody had physically dropped.
   *
   * A host too old to carry files is refused here rather than at the bridge call. The
   * method is present on every desktop client, so a caller checking for the method
   * would find it and then meet a TypeError from inside the promise instead of the
   * sentence it meant to show.
   */
  openDroppedFile<T>(file: File): Promise<T> {
    if (!this.acceptsDroppedFiles)
      return Promise.reject(new WorkbenchHostError(
        'dropped-files-unsupported',
        'This Nendo cannot open a dropped file. Use Open file from the File menu.'));
    return this.requestCore<T>('file.openDropped', {}, [file]);
  }

  request<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (isJournaledMutation(method) && this.fileIdentity !== null && this.fileSessionId !== null)
      return this.journal.submit(this.fileSender(), this.fileIdentity, this.fileSessionId, method, payload) as Promise<T>;
    return this.requestCore<T>(method, payload);
  }

  /**
   * Stop every request still in flight.
   *
   * The host answers each one only after the work has stopped, so this resolving is
   * the signal that nothing is still writing — which is what makes it safe to offer
   * the next action. A cancel that returned immediately would just be a spinner that
   * disappeared.
   */
  async cancelInFlight(): Promise<CancelledRequests> {
    const targets = [...this.pending.entries()]
      .filter(([, entry]) => entry.method !== 'request.cancel')
      .map(([requestId]) => requestId);
    const answers = await Promise.all(targets.map(async (requestId) => {
      try { return await this.requestCore<{ found: boolean; stopped: boolean }>('request.cancel', { requestId }); }
      catch { return { found: true, stopped: false }; }
    }));
    return {
      stopped: answers.filter((answer) => answer.found && answer.stopped).length,
      ignored: answers.filter((answer) => answer.found && !answer.stopped).length,
    };
  }

  pendingMutation(): PendingMutation | null {
    return this.fileIdentity === null ? null : this.journal.read(this.fileIdentity);
  }

  retryPendingMutation(): Promise<DesktopOperationView | null> {
    return this.fileIdentity === null ? Promise.resolve(null) : this.journal.retry(this.fileSender(), this.fileIdentity);
  }

  checkPendingMutation(): Promise<DesktopOperationView | null> {
    return this.fileIdentity === null ? Promise.resolve(null) : this.journal.retry(this.fileSender(), this.fileIdentity, false);
  }

  private fileSender(): WorkbenchClient['request'] {
    const identity = this.fileIdentity;
    const generation = this.fileSessionId;
    return <T>(method: string, payload?: Record<string, unknown>): Promise<T> => {
      if (this.fileIdentity !== identity || this.fileSessionId !== generation)
        return Promise.reject(new WorkbenchHostError('stale-file-session', 'The file changed while this save was being checked. Refresh the view.'));
      return this.requestCore<T>(method, payload);
    };
  }

  private requestCore<T>(method: string, payload: Record<string, unknown> = {}, additionalObjects?: ArrayLike<unknown>): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      // A native file picker is an interactive wait controlled by the person,
      // not a slow host operation. Starting the RPC timeout before the picker
      // opens discards a valid response whenever choosing a path takes longer
      // than fifteen seconds.
      // The same holds for a custom view's install (picker and review) and permission (consent) dialogs.
      const timeout = method === 'session.createFile' || method === 'session.openFile' || method.startsWith('file.') || method.startsWith('extension.')
        ? null
        : window.setTimeout(() => {
            this.pending.delete(requestId);
            reject(new WorkbenchHostError('host-timeout', 'The Desktop host did not respond.'));
          }, 15_000);

      this.pending.set(requestId, {
        method,
        fileSessionId: this.fileSessionId,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      const envelope = { protocolVersion, requestId, method, fileSessionId: this.fileSessionId, boundedRead: true, payload };
      if (additionalObjects === undefined) this.bridge.postMessage(envelope);
      else this.bridge.postMessageWithAdditionalObjects!(envelope, additionalObjects);
    });
  }

  private receive(value: unknown): void {
    let candidate = value;
    if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate) as unknown;
      } catch {
        return;
      }
    }
    if (isHostEvent(candidate)) {
      this.receiveHostEvent(candidate);
      return;
    }
    if (!isResponse(candidate)) {
      return;
    }

    const pending = this.pending.get(candidate.requestId);
    if (pending === undefined) {
      return;
    }
    if (pending.timeout !== null) {
      window.clearTimeout(pending.timeout);
    }
    this.pending.delete(candidate.requestId);

    if (candidate.protocolVersion !== protocolVersion) {
      pending.reject(new WorkbenchHostError('unsupported-protocol', 'The Desktop host returned an unsupported protocol version.'));
      return;
    }
    if (!candidate.ok || candidate.error !== null) {
      pending.reject(new WorkbenchHostError(
        candidate.error?.code ?? 'host-error',
        candidate.error?.message ?? 'The Desktop host could not complete the request.',
      ));
      return;
    }
    if (pending.method !== 'appearance.set' && pending.method !== 'appearance.get' && pending.method !== 'session.getRecentFiles') {
      if (pending.fileSessionId !== this.fileSessionId) {
        pending.reject(new WorkbenchHostError('stale-file-session', 'The file changed while this action was running. Refresh the view.'));
        return;
      }
      const result = candidate.result as Partial<DesktopSessionView & DesktopFileActionView> | null;
      const snapshot = result?.session ?? result;
      if (typeof snapshot?.fileSessionId === 'string') {
        this.fileSessionId = snapshot.fileSessionId;
        this.fileIdentity = snapshot.manifest?.applicationId && snapshot.manifest.instanceId
          ? encodeURIComponent(snapshot.manifest.applicationId) + '.' + encodeURIComponent(snapshot.manifest.instanceId) : null;
      }
    }
    pending.resolve(candidate.result);
  }

  onNavigate(listener: (route: HostRoute) => void): () => void {
    this.navigateListeners.add(listener);
    return () => { this.navigateListeners.delete(listener); };
  }

  onOpenRecord(listener: (target: HostRecordTarget) => void): () => void {
    this.openRecordListeners.add(listener);
    return () => { this.openRecordListeners.delete(listener); };
  }

  onFileChanged(listener: (changeSequence: number) => void): () => void {
    this.fileChangedListeners.add(listener);
    return () => { this.fileChangedListeners.delete(listener); };
  }

  onAgentActivity(listener: (work: AgentWork) => void): () => void {
    this.agentActivityListeners.add(listener);
    return () => { this.agentActivityListeners.delete(listener); };
  }

  private receiveHostEvent(message: HostEvent): void {
    if (message.protocolVersion !== protocolVersion) {
      return;
    }
    if (message.event === 'openRecord') {
      const target = message.payload as Partial<HostRecordTarget> | null;
      if (!target || target.fileSessionId !== this.fileSessionId ||
          typeof target.entityId !== 'string' || target.entityId.length === 0 || target.entityId.length > 256 ||
          typeof target.recordId !== 'string' || target.recordId.length === 0 || target.recordId.length > 256) return;
      for (const listener of this.openRecordListeners) listener(target as HostRecordTarget);
      return;
    }
    if (message.event === 'agentActivity') {
      const work = message.payload as Partial<AgentWork> | null;
      // Bounded here as well as at the host. The payload is drawn as text, so a client
      // name is capped rather than trusted; nothing else in it reaches the page.
      if (!work || typeof work.busy !== 'boolean' ||
          typeof work.client !== 'string' || work.client.length > 200 ||
          typeof work.activity !== 'string' || work.activity.length > 260) return;
      for (const listener of this.agentActivityListeners) {
        try {
          listener({ busy: work.busy, client: work.client, activity: work.activity });
        } catch {
          // Nothing here can report a failure the person would act on.
        }
      }
      return;
    }
    if (message.event === 'fileChanged') {
      if (typeof message.payload !== 'number' || !Number.isFinite(message.payload)) return;
      for (const listener of this.fileChangedListeners) {
        try {
          listener(message.payload);
        } catch {
          // Nothing here can report a failure the person would act on.
        }
      }
      return;
    }
    if (message.event !== 'navigate' || !isHostRoute(message.payload)) {
      return;
    }
    for (const listener of this.navigateListeners) {
      // One bad listener must not cost the others the event.
      try {
        listener(message.payload);
      } catch {
        // Nothing here can report a failure the person would act on.
      }
    }
  }
}

export class UnavailableWorkbenchClient implements WorkbenchClient {
  readonly mode = 'unavailable' as const;

  request<T>(): Promise<T> {
    return Promise.reject(new WorkbenchHostError(
      'host-unavailable',
      'This Workbench must run inside the Nendo Desktop host.',
    ));
  }
}


function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<HostEvent> & { requestId?: unknown };
  return typeof candidate.protocolVersion === 'number'
    && typeof candidate.event === 'string'
    && candidate.requestId === undefined;
}

function isResponse(value: unknown): value is WorkbenchResponse<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<WorkbenchResponse<unknown>>;
  return typeof candidate.protocolVersion === 'number'
    && typeof candidate.requestId === 'string'
    && typeof candidate.ok === 'boolean';
}
