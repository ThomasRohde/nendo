// ELK for the Archi workbench (W-115). archi-online's layouts load elkjs whole, on the page; the
// workbench builds them against this module instead, which runs ELK in a Web Worker from the
// package's own copy (extensions/archi/vendor/elkjs), as the Work dependencies view does, so a
// large layout never stalls the view. Under Node, which has no Worker, a test hands in elkjs's
// own stand-in with useElkWorkerFactory.

import ElkApi from 'elkjs/lib/elk-api.js';

export const ELK_WORKER_URL = 'vendor/elkjs/elk-worker.min.js';
const LAYOUT_TIMEOUT_MS = 30_000;

type WorkerFactory = (url: string) => unknown;
let factory: WorkerFactory | null = null;

/** The worker ELK runs in, made by `make` rather than `new Worker`: for a test under Node. */
export function useElkWorkerFactory(make: WorkerFactory | null) { factory = make; }

interface ElkInstance { layout(graph: unknown): Promise<unknown>; terminateWorker(): void }

/**
 * What archi-online constructs as `new ELK()`. A layout that takes longer than 30 seconds ends its
 * worker and is refused, and the next one starts a fresh worker.
 */
export default class Elk {
  private api: ElkInstance | null = null;

  layout(graph: unknown): Promise<unknown> {
    this.api ??= new (ElkApi as unknown as new (options: object) => ElkInstance)({
      workerUrl: ELK_WORKER_URL, ...(factory ? { workerFactory: factory } : {}),
    });
    const api = this.api;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.api === api) this.api = null;
        try { api.terminateWorker(); } catch { /* already ended */ }
        reject(new Error(`The layout took longer than ${LAYOUT_TIMEOUT_MS / 1000} seconds.`));
      }, LAYOUT_TIMEOUT_MS);
    });
    return Promise.race([api.layout(graph), late]).finally(() => clearTimeout(timer));
  }
}
