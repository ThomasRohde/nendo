import { DesktopWorkbenchClient, type WebViewBridge } from './host-desktop';
import { protocolVersion } from './host';
import type { KeptAs } from './host-types';

/**
 * The browser host (ADR-0036): the same Engine and protocol handler, compiled to WebAssembly and
 * carried in this page. The Desktop client speaks to it unchanged, through a bridge that hands each
 * message to the runtime's one exported method and delivers its answer as the WebView2 bridge
 * would. Only the mode differs, which keeps the Windows host's window, tabs and agents out of view.
 *
 * Around each answer the page keeps what a desktop keeps on disk: the open file, written back in
 * place when the browser gave a handle for it, and the device state in IndexedDB.
 */

/** The page carries the runtime's files here, gzipped and base64, with the runtime's boot config. */
export const browserRuntimeId = 'nendo-runtime';

/** An exported page (ADR-0035) carries its file here, gzipped and base64, named by `data-name`. */
const carriedFileId = 'nendo-file';

/** The largest file the page opens; the runtime refuses one too. */
const maximumFileBytes = 256 * 1024 * 1024;

interface RuntimeFiles {
  files: Record<string, string>;
  config: { mainAssemblyName: string };
}

interface BrowserHostExports {
  InvokeAsync(message: string): Promise<string>;
  InvokeWithFileAsync(message: string, bytes: Uint8Array, name: string): Promise<string>;
  ReadOpenFile(): Uint8Array;
  ReadOpenFileIfChanged(): Uint8Array;
  ReadViewPackageAsync(packageId: string): Promise<string>;
  ReadMediaAsync(address: string): Promise<string>;
  ExportDeviceState(): string;
  ImportDeviceState(state: string): void;
  OpenCarriedAsync(bytes: Uint8Array, name: string): Promise<string>;
  CarryOverAsync(previous: Uint8Array, carried: Uint8Array, name: string): Promise<string>;
}

/** A web app's working copy (ADR-0037): the file, and the digest of the export it came from. */
interface WebAppCopy { carried: string; bytes: Uint8Array }

interface DotnetRuntime {
  getAssemblyExports(name: string): Promise<{ Nendo: { Browser: { BrowserHost: BrowserHostExports } } }>;
  setModuleImports(name: string, imports: Record<string, unknown>): void;
}

interface DotnetBuilder {
  withResourceLoader(loader: (type: string, name: string) => string | Promise<Response> | undefined): DotnetBuilder;
  create(): Promise<DotnetRuntime>;
}

/** What the File System Access API gives a page for a file it may write back; absent outside Chromium. */
interface WritableFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<string>;
}

type OpenFilePicker = (options: { types: Array<{ description: string; accept: Record<string, string[]> }>; multiple?: boolean }) => Promise<WritableFileHandle[]>;

/** Whether this page carries the browser host's runtime. */
export function carriesBrowserRuntime(): boolean {
  return typeof document !== 'undefined' && document.getElementById(browserRuntimeId) !== null;
}

/**
 * The file the person opened and how the page keeps it: in place through its handle, as the working
 * copy of the file the page carries (in IndexedDB under `carried`), or in the page only. `picked`
 * waits for the open it was picked for; `baseline` marks a file just opened, whose bytes are as it
 * came in and need no write back; `stored` is false once the browser would not keep the working copy.
 * A web app keeps its copy with the digest of the export it came from (`export`), and the copy a
 * newer export could not carry whole under `previous`.
 */
const kept: {
  handle: WritableFileHandle | null; picked: WritableFileHandle | null; name: string | null; baseline: boolean;
  carried: string | null; export: string | null; previous: string | null; stored: boolean; notice: string | null;
} = { handle: null, picked: null, name: null, baseline: false, carried: null, export: null, previous: null, stored: true, notice: null };

const visitOnly = 'This browser does not keep this file, so your changes last only this visit. Download the file to keep them.';

export class BrowserWorkbenchClient extends DesktopWorkbenchClient {
  private readonly runtime: RuntimeBridge;

  constructor() {
    const runtime = new RuntimeBridge();
    super(runtime, 'browser');
    this.runtime = runtime;
    void registerWebApp(() => runtime.settled());
  }

  whenUpdateReady(listener: (reload: () => Promise<void>) => void): void {
    webApp.listener = listener;
    if (webApp.reload !== null) listener(webApp.reload);
  }

  async readViewPackage(packageId: string): Promise<Record<string, { mediaType: string; base64: string }>> {
    const host = await this.runtime.host;
    return JSON.parse(await host.ReadViewPackageAsync(packageId)) as Record<string, { mediaType: string; base64: string }>;
  }

  async pictureDataUrl(address: string): Promise<string | null> {
    const picture = await readPicture(await this.runtime.host, address);
    return picture === null ? null : `data:${picture.mediaType};base64,${picture.base64}`;
  }

  async downloadOpenFile(): Promise<void> {
    const bytes = (await this.runtime.host).ReadOpenFile();
    if (bytes.length !== 0) download(bytes, kept.name ?? 'file.nendo');
  }

  keptAs(): { held: KeptAs; name: string | null; previous: boolean } {
    return { held: kept.handle !== null ? 'inPlace' : kept.carried === null ? 'page' : kept.stored ? 'browser' : 'visit', name: kept.name, previous: kept.previous !== null };
  }

  async downloadPreviousCopy(): Promise<void> {
    const bytes = kept.previous === null ? null : await readStored('files', kept.previous);
    if (bytes instanceof Uint8Array) download(bytes, kept.name ?? 'file.nendo');
  }

  async startNotice(): Promise<string | null> {
    await this.runtime.host;
    return kept.notice;
  }
}

class RuntimeBridge implements WebViewBridge {
  readonly host: Promise<BrowserHostExports> = bootRuntime();
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  /** The page's saves in order: a later revision's bytes never land before an earlier one's. */
  private saving: Promise<void> = Promise.resolve();
  private deviceState: string | null = null;

  postMessage(message: unknown): void {
    void this.answer(message, (host) => host.InvokeAsync(JSON.stringify(message)));
  }

  /**
   * A message with a file the person dropped: a Nendo file to open, or a picture for a media field.
   * The runtime keeps the bytes in the page's own file system and hands the handler that path, as
   * the Windows host hands it the path Windows names.
   */
  postMessageWithAdditionalObjects(message: unknown, additionalObjects: ArrayLike<unknown>): void {
    const file = additionalObjects[0];
    if (!(file instanceof File)) { this.postMessage(message); return; }
    if (file.size > maximumFileBytes) {
      this.deliver(refusal(message, 'file-too-large', `${file.name} is ${(file.size / 1048576).toFixed(1)} MiB; a browser opens files of up to 256 MiB.`));
      return;
    }
    void this.answer(message, async (host) => host.InvokeWithFileAsync(JSON.stringify(message), new Uint8Array(await file.arrayBuffer()), file.name));
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  /** Once every save so far has landed. */
  settled(): Promise<void> {
    return this.saving;
  }

  private async answer(message: unknown, invoke: (host: BrowserHostExports) => Promise<string>): Promise<void> {
    let host: BrowserHostExports;
    let answer: string;
    try {
      host = await this.host;
      answer = await invoke(host);
    } catch (error) {
      this.deliver(refusal(message, 'host-error', error instanceof Error ? error.message : 'The browser host could not answer.'));
      return;
    }
    this.track(message, answer);
    // Saved before the page hears the answer, so what it shows next is what is on disk.
    this.save(host);
    this.keepDeviceState(host);
    this.deliver(answer);
  }

  /** Which file the page keeps in place: the one the person picked, until another opens or it closes. */
  private track(message: unknown, answer: string): void {
    const method = (message as { method?: unknown }).method;
    if (method !== 'session.openFile' && method !== 'file.openDropped' && method !== 'session.createFile' && method !== 'file.close') return;
    let ok = false;
    let name: string | null = null;
    try {
      const parsed = JSON.parse(answer) as { ok?: boolean; result?: { fileName?: unknown; session?: { fileName?: unknown } } };
      ok = parsed.ok === true;
      const fileName = parsed.result?.session?.fileName ?? parsed.result?.fileName;
      name = typeof fileName === 'string' ? fileName : null;
    } catch { /* An answer the page cannot read changes nothing it keeps. */ }
    if (!ok) { kept.picked = null; return; }
    kept.handle = method === 'session.openFile' ? kept.picked : null;
    kept.picked = null;
    kept.name = name;
    kept.baseline = true;
    // Another file is not the page's own: its working copy is no longer what the page keeps.
    kept.carried = null;
    kept.export = null;
  }

  private save(host: BrowserHostExports): void {
    // The first read after an open is the file as it came in: nothing to write back.
    if (kept.baseline) { host.ReadOpenFileIfChanged(); kept.baseline = false; return; }
    const handle = kept.handle;
    const carried = kept.carried;
    const exported = kept.export;
    if (handle === null && carried === null) return;
    const bytes = host.ReadOpenFileIfChanged();
    if (bytes.length === 0) return;
    if (handle !== null) {
      this.saving = this.saving.then(async () => {
        const writable = await handle.createWritable();
        await writable.write(bytes as BufferSource);
        await writable.close();
      }).catch(() => {
        // A save the browser refused leaves the file where it was; Download still keeps a copy.
        kept.handle = null;
      });
    } else if (carried !== null) {
      // The page's own file: its working copy, kept by this browser for the next visit.
      this.saving = this.saving.then(async () => { kept.stored = await writeStored('files', carried, exported === null ? bytes : { carried: exported, bytes }); });
    }
  }

  private keepDeviceState(host: BrowserHostExports): void {
    const state = host.ExportDeviceState();
    if (state === this.deviceState) return;
    this.deviceState = state;
    void writeDeviceState(state);
  }

  private deliver(data: string): void {
    for (const listener of this.listeners) {
      try { listener({ data } as MessageEvent<unknown>); } catch { /* Another listener must still hear it. */ }
    }
  }
}

/**
 * An exported web app (ADR-0037): a page served with its manifest beside it. Its service worker
 * keeps the folder's files so the installed app opens offline. A newer version published in the
 * folder waits until the person chooses Reload, so nothing is swapped under an open file.
 */
const webApp: { listener: ((reload: () => Promise<void>) => void) | null; reload: (() => Promise<void>) | null } = { listener: null, reload: null };

/** Whether this page is a web app served from a web server: from disk it registers nothing. */
export function servedAsWebApp(): boolean {
  return typeof document !== 'undefined' && document.querySelector('link[rel="manifest"]') !== null
    && window.isSecureContext && window.location.protocol !== 'file:' && 'serviceWorker' in navigator;
}

async function registerWebApp(saved: () => Promise<void>): Promise<void> {
  if (!servedAsWebApp()) return;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch {
    // An app the browser would not install still works as a page.
    return;
  }
  const offer = (worker: ServiceWorker): void => {
    // The first version installed has nothing to take over from.
    if (navigator.serviceWorker.controller === null) return;
    webApp.reload = async () => {
      await saved();
      // Another tab of the app chose Reload first: the version is already in charge.
      if (worker.state !== 'installed') { window.location.reload(); return; }
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
      worker.postMessage('nendo-web-app-take-over');
    };
    webApp.listener?.(webApp.reload);
  };
  if (registration.waiting !== null) offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offer(worker); });
  });
}

function download(bytes: Uint8Array, name: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

function refusal(message: unknown, code: string, text: string): string {
  return JSON.stringify({ protocolVersion, requestId: (message as { requestId?: unknown }).requestId, ok: false, result: null, error: { code, message: text } });
}

/**
 * Starts the .NET runtime from the files the page carries. Each is handed to the runtime by name
 * through its resource loader, so nothing is fetched and the page opens from disk. A blob URL is no
 * base for the runtime's own relative lookups, so each module is told it sits in `_framework`
 * beside the page; every lookup it makes is then answered by name.
 */
async function bootRuntime(): Promise<BrowserHostExports> {
  const element = document.getElementById(browserRuntimeId);
  if (element === null) throw new Error('This page carries no browser host.');
  const { files, config } = JSON.parse(element.textContent ?? '{}') as RuntimeFiles;
  const raw = async (name: string): Promise<Uint8Array> => {
    const gzipped = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
    return new Uint8Array(await new Response(new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  };
  const base = new URL('_framework/', window.location.href).href;
  const modules: Record<string, string> = {};
  for (const name of Object.keys(files).filter((file) => file.endsWith('.js'))) {
    const text = new TextDecoder().decode(await raw(name)).replaceAll('import.meta.url', JSON.stringify(base + name));
    modules[name] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  }
  const { dotnet } = await import(/* @vite-ignore */ modules['dotnet.js']) as { dotnet: DotnetBuilder };
  const runtime = await dotnet.withResourceLoader((_type, name) => {
    if (modules[name] !== undefined) return modules[name];
    if (files[name] === undefined) return undefined;
    return raw(name).then((bytes) => new Response(bytes as BlobPart, {
      headers: { 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
    }));
  }).create();
  runtime.setModuleImports('nendo-browser-host', { pickFile, takeWriterLock, releaseWriterLock });
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  const host = exports.Nendo.Browser.BrowserHost;
  // Kept device state comes back before any file opens, so an approval given on an earlier visit holds.
  const state = await readStored('device', 'state');
  if (typeof state === 'string') host.ImportDeviceState(state);
  await openCarriedFile(host);
  void navigator.storage?.persist?.().catch(() => false);
  watchPictures(host);
  return host;
}

/**
 * The runtime's way to ask for a file. Where the browser offers the File System Access picker the
 * page keeps the file's handle and writes each change back to it; elsewhere the file input gives a
 * copy, kept by Download. Resolves to the file's name and bytes, or null when the person chose none.
 */
async function pickFile(): Promise<{ name: string; base64: string } | null> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  let file: File | null;
  if (picker !== undefined) {
    let handle: WritableFileHandle | undefined;
    try {
      [handle] = await picker({ types: [{ description: 'Nendo file', accept: { 'application/octet-stream': ['.nendo'] } }], multiple: false });
    } catch {
      return null;
    }
    if (handle === undefined) return null;
    // Asked now, while the person's click still counts, rather than at the first save.
    const granted = await handle.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied') ?? 'granted';
    kept.picked = granted === 'granted' ? handle : null;
    file = await handle.getFile();
  } else {
    file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.nendo';
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
      input.click();
    });
  }
  if (file === null) return null;
  if (file.size > maximumFileBytes) throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MiB; a browser opens files of up to 256 MiB.`);
  return { name: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())) };
}

let releaseHeldLock: (() => void) | null = null;

/** One tab of this browser writes a file at a time: a Web Lock held while the file is open. */
function takeWriterLock(key: string): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks === undefined) return Promise.resolve(true);
  releaseWriterLock();
  return new Promise<boolean>((resolve) => {
    void locks.request(key, { ifAvailable: true }, (lock) => {
      if (lock === null) { resolve(false); return undefined; }
      resolve(true);
      return new Promise<void>((release) => { releaseHeldLock = release; });
    });
  });
}

function releaseWriterLock(): void {
  releaseHeldLock?.();
  releaseHeldLock = null;
}

/** The page's own storage: device state, and the working copy of each exported page's file. */
function openPageStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nendo-browser-host', 2);
    request.onupgradeneeded = () => {
      for (const store of ['device', 'files'])
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable.'));
  });
}

/** What an earlier visit kept, or null when there is none or the browser keeps no storage. */
async function readStored(store: 'device' | 'files', key: string): Promise<unknown> {
  try {
    const database = await openPageStore();
    return await new Promise<unknown>((resolve) => {
      const request = database.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Keeps a value for the next visit; false when the browser would not, so it lasts this visit only. */
async function writeStored(store: 'device' | 'files', key: string, value: unknown): Promise<boolean> {
  try {
    const database = await openPageStore();
    return await new Promise<boolean>((resolve) => {
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function writeDeviceState(state: string): Promise<void> {
  await writeStored('device', 'state', state);
}

/**
 * An exported page opens the file it carries as it starts, or the working copy this browser kept of
 * it on an earlier visit. A page's copy is keyed by the carried file's digest, so each exported page
 * has its own, and a new export starts from what it carries. A web app's copy is kept for the
 * app's address instead (ADR-0037): a newer export published there carries the visitor's changes
 * over, and the copy as it was is kept under `previous:` when not all of them could be.
 */
async function openCarriedFile(host: BrowserHostExports): Promise<void> {
  const element = document.getElementById(carriedFileId);
  if (element === null) return;
  const carried = (element.textContent ?? '').trim();
  const name = element.dataset.name ?? 'file.nendo';
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(carried)));
  const digest = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const exported = async (): Promise<Uint8Array> => new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(carried), (c) => c.charCodeAt(0))]).stream()
    .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const webApp = document.querySelector('link[rel="manifest"]') !== null;
  const key = webApp ? `web-app:${new URL('./', window.location.href).href}` : `page-file:${digest}`;
  const stored = await readStored('files', key);
  kept.handle = null;
  kept.name = name;
  kept.baseline = true;
  kept.previous = await readStored('files', `previous:${key}`) instanceof Uint8Array ? `previous:${key}` : null;
  if (!webApp) {
    const bytes = stored instanceof Uint8Array ? stored : await exported();
    const opened = await host.OpenCarriedAsync(bytes, name);
    kept.carried = key;
    // A browser that keeps nothing holds the working copy for this visit only.
    kept.stored = stored instanceof Uint8Array || await writeStored('files', key, bytes);
    kept.notice = [opened, kept.stored ? '' : visitOnly].filter((text) => text !== '').join(' ') || null;
    return;
  }
  const copy = stored !== null && typeof stored === 'object' && (stored as WebAppCopy).bytes instanceof Uint8Array ? stored as WebAppCopy : null;
  let opened: string | null;
  let outcome = 'opened';
  if (copy === null || copy.carried === digest) {
    opened = await host.OpenCarriedAsync(copy?.bytes ?? await exported(), name) || null;
  } else {
    ({ outcome, notice: opened } = JSON.parse(await host.CarryOverAsync(copy.bytes, await exported(), name)) as { outcome: string; notice: string | null });
    // What could not come over stays in this browser, as the visitor left it.
    if ((outcome === 'carriedPartly' || outcome === 'started') && await writeStored('files', `previous:${key}`, copy.bytes)) kept.previous = `previous:${key}`;
  }
  // Another tab is editing this app: this one keeps nothing, so it overwrites nothing.
  kept.carried = outcome === 'readOnly' ? null : key;
  kept.export = outcome === 'kept' ? copy!.carried : digest;
  kept.stored = outcome === 'readOnly' || outcome === 'kept' || (copy !== null && copy.carried === digest)
    || await writeStored('files', key, { carried: digest, bytes: host.ReadOpenFile() });
  kept.notice = [opened ?? '', kept.stored ? '' : visitOnly].filter((text) => text !== '').join(' ') || null;
}

async function readPicture(host: BrowserHostExports, address: string): Promise<{ mediaType: string; base64: string } | null> {
  const answer = await host.ReadMediaAsync(address);
  return answer === '' ? null : JSON.parse(answer) as { mediaType: string; base64: string };
}

/**
 * The file's pictures. Their addresses (`nendo-media://…`) are never fetched; each one the page draws
 * is read from the file and shown from a blob URL instead, once per address.
 */
function watchPictures(host: BrowserHostExports): void {
  const urls = new Map<string, Promise<string | null>>();
  const pictureOf = (address: string): Promise<string | null> => {
    let url = urls.get(address);
    if (url === undefined) {
      url = readPicture(host, address).then((picture) => picture === null ? null
        : URL.createObjectURL(new Blob([Uint8Array.from(atob(picture.base64), (c) => c.charCodeAt(0))], { type: picture.mediaType })));
      urls.set(address, url);
    }
    return url;
  };
  const show = (element: Element): void => {
    for (const attribute of ['src', 'poster']) {
      const address = element.getAttribute(attribute);
      if (address === null || !address.startsWith('nendo-media:')) continue;
      void pictureOf(address).then((url) => {
        if (url !== null && element.getAttribute(attribute) === address) element.setAttribute(attribute, url);
      });
    }
  };
  const visit = (node: Node): void => {
    if (!(node instanceof Element)) return;
    show(node);
    for (const element of node.querySelectorAll('[src^="nendo-media:"], [poster^="nendo-media:"]')) show(element);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') show(record.target as Element);
      else for (const node of record.addedNodes) visit(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster'] });
  visit(document.documentElement);
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
