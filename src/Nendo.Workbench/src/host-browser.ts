import { DesktopWorkbenchClient, type WebViewBridge } from './host-desktop';
import { protocolVersion } from './host';

/**
 * The browser host (ADR-0036): the same Engine and protocol handler, compiled to WebAssembly and
 * carried in this page. The Desktop client speaks to it unchanged, through a bridge that hands each
 * message to the runtime's one exported method and delivers its answer as the WebView2 bridge
 * would. Only the mode differs, which keeps the Windows host's window, tabs and agents out of view.
 */

/** The page carries the runtime's files here, gzipped and base64, with the runtime's boot config. */
export const browserRuntimeId = 'nendo-runtime';

interface RuntimeFiles {
  files: Record<string, string>;
  config: { mainAssemblyName: string };
}

interface BrowserHostExports {
  InvokeAsync(message: string): Promise<string>;
  InvokeWithFileAsync(message: string, bytes: Uint8Array, name: string): Promise<string>;
  ReadOpenFile(): Uint8Array;
  ReadViewPackageAsync(packageId: string): Promise<string>;
}

interface DotnetRuntime {
  getAssemblyExports(name: string): Promise<{ Nendo: { Browser: { BrowserHost: BrowserHostExports } } }>;
  setModuleImports(name: string, imports: Record<string, unknown>): void;
}

interface DotnetBuilder {
  withResourceLoader(loader: (type: string, name: string) => string | Promise<Response> | undefined): DotnetBuilder;
  create(): Promise<DotnetRuntime>;
}

/** Whether this page carries the browser host's runtime. */
export function carriesBrowserRuntime(): boolean {
  return typeof document !== 'undefined' && document.getElementById(browserRuntimeId) !== null;
}

export class BrowserWorkbenchClient extends DesktopWorkbenchClient {
  private readonly runtime: RuntimeBridge;

  constructor() {
    const runtime = new RuntimeBridge();
    super(runtime, 'browser');
    this.runtime = runtime;
  }

  async readViewPackage(packageId: string): Promise<Record<string, { mediaType: string; base64: string }>> {
    const host = await this.runtime.host;
    return JSON.parse(await host.ReadViewPackageAsync(packageId)) as Record<string, { mediaType: string; base64: string }>;
  }

  /** The open file's bytes as they stand now. */
  async readOpenFile(): Promise<Uint8Array> {
    return (await this.runtime.host).ReadOpenFile();
  }
}

class RuntimeBridge implements WebViewBridge {
  readonly host: Promise<BrowserHostExports> = bootRuntime();
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(message: unknown): void {
    const envelope = message as { requestId?: unknown };
    void this.host
      .then((host) => host.InvokeAsync(JSON.stringify(message)))
      .then((answer) => this.deliver(answer), (error: unknown) => this.deliver(JSON.stringify({
        protocolVersion,
        requestId: envelope.requestId,
        ok: false,
        result: null,
        error: { code: 'host-error', message: error instanceof Error ? error.message : 'The browser host could not answer.' },
      })));
  }

  /**
   * A message with a file the person dropped: a Nendo file to open, or a picture for a media field.
   * The runtime keeps the bytes in the page's own file system and hands the handler that path, as
   * the Windows host hands it the path Windows names.
   */
  postMessageWithAdditionalObjects(message: unknown, additionalObjects: ArrayLike<unknown>): void {
    const file = additionalObjects[0];
    if (!(file instanceof File)) { this.postMessage(message); return; }
    const envelope = message as { requestId?: unknown };
    void Promise.all([this.host, file.arrayBuffer()])
      .then(([host, buffer]) => host.InvokeWithFileAsync(JSON.stringify(message), new Uint8Array(buffer), file.name))
      .then((answer) => this.deliver(answer), (error: unknown) => this.deliver(JSON.stringify({
        protocolVersion,
        requestId: envelope.requestId,
        ok: false,
        result: null,
        error: { code: 'host-error', message: error instanceof Error ? error.message : 'The browser host could not take the file.' },
      })));
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  private deliver(data: string): void {
    for (const listener of this.listeners) {
      try { listener({ data } as MessageEvent<unknown>); } catch { /* Another listener must still hear it. */ }
    }
  }
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
  runtime.setModuleImports('nendo-browser-host', { pickFile });
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  return exports.Nendo.Browser.BrowserHost;
}

/**
 * The runtime's way to ask for a file: the browser's own file input. Resolves to the file's name and
 * bytes, or null when the person chose none.
 */
function pickFile(): Promise<{ name: string; base64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nendo';
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) { resolve(null); return; }
      void file.arrayBuffer().then((buffer) => resolve({ name: file.name, base64: toBase64(new Uint8Array(buffer)) }));
    });
    input.click();
  });
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
