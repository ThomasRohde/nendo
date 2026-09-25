import { state } from './app-state';
import { client } from './client';
import { brokerMethodNames, createExtensionBroker, type BrokerMount, type ExtensionBroker } from './extension-broker';
import { describeSchema, viewContext, viewTheme, type ViewSpec } from './extension-model';
import type { ViewTheme } from './extension-api/protocol';
import { openRecordFromView, openScreenFromView, openStudioFromView, toastFromView } from './extension-ui';
import { content, root } from './shell';
import {
  defaultPanelHeight, frameAttributes, frameName, frameSource, mountKey, newMountId, viewNotice, viewNoticeMarkup,
  viewOverlayMarkup, viewSpecOf, type ViewNotice, type ViewTrouble,
} from './view-frame-markup';
import { refreshHealth } from './view-health';
import { importPackage, openCustomViews, setViewSwitch } from './view-packages';

/**
 * Custom views on the page (ADR-0013): one cross-origin frame per view, in the placeholder
 * its screen or record page drew.
 *
 * A mount is created for each placeholder a view is drawn into and starts when the
 * placeholder comes into view, with the frame's source set only then: the browser's own
 * lazy loading starts a frame about 2.4k px early (spike S17). A redraw replaces the page's
 * markup, which would reload every frame in it, so before a redraw each live frame is parked
 * in a hidden container with `moveBefore` and adopted by its new placeholder afterwards,
 * which keeps its document (S12). A browser without `moveBefore` reloads the view instead.
 *
 * Views run only while the session's `extensions.run` is true. Otherwise the placeholder
 * says why, and offers the step that changes it where there is one. The broker is created
 * here, with the Workbench's own reads, navigation and theme handed to it.
 */

interface Mount extends BrokerMount {
  readonly key: string;
  readonly origin: string;
  readonly entryPoint: string;
  spec: ViewSpec;
  placeholder: HTMLElement | null;
  frame: HTMLIFrameElement | null;
  /** The ID in the current frame's name; fresh for every frame, so a late event cannot name its successor. */
  frameId: string | null;
  started: boolean;
  loaded: boolean;
  /** Waiting to start again once the renderer its package shared has gone. */
  restarting: boolean;
  trouble: ViewTrouble | null;
  height: number;
  seen: number;
}

const mounts = new Map<string, Mount>();
const byPlaceholder = new WeakMap<Element, Mount>();
let generation = 0;
let parking: HTMLElement | null = null;
let broker: ExtensionBroker | null = null;
let observer: IntersectionObserver | null = null;
let ticker: number | null = null;
let themeMode: string | null = null;

/** Whether this browser keeps a frame's document when the frame moves (`Element.moveBefore`). */
const keepsFrames = typeof Element !== 'undefined' &&
  typeof (Element.prototype as { moveBefore?: unknown }).moveBefore === 'function';

/**
 * How long a frame sent to about:blank is kept before its element goes. Navigating a view's
 * frames away ends their renderer in about half a second, where removing the element alone
 * leaves it running for ten (spike S3).
 */
const retireMs = 1_000;

function currentTheme(): ViewTheme {
  const style = getComputedStyle(root);
  return viewTheme(root.dataset.theme === 'dark' ? 'dark' : 'light', (name) => style.getPropertyValue(`--${name}`));
}

/** Create the broker and listen for what views need to hear. Called once, before the first render. */
export function installViewFrames(): void {
  if (broker !== null) return;
  broker = createExtensionBroker({
    request: (method, payload) => client.request(method, payload),
    mounts: () => [...mounts.values()].filter((mount) => mount.frame !== null),
    running: () => state.session.extensions?.run === true,
    context: (mount) => viewContext((mount as Mount).spec, state.session, currentTheme(), navigator.language || 'en', brokerMethodNames),
    describe: () => describeSchema(state.session),
    ui: {
      openRecord: (_mount, target) => openRecordFromView(target.entityId, target.recordId),
      openScreen: (_mount, target) => openScreenFromView(target.surfaceId),
      openStudio: (_mount, target) => openStudioFromView(target.entityId),
      toast: (mount, text) => toastFromView((mount as Mount).spec.title, text),
      setHeight: (mount, pixels) => setHeight(mount as Mount, pixels),
    },
    responsive: (mount, responsive) => {
      const view = mount as Mount;
      if (responsive && view.trouble === 'unresponsive') setTrouble(view, null);
      else if (!responsive && view.trouble === null) setTrouble(view, 'unresponsive');
    },
    connected: (mount) => {
      const view = mount as Mount;
      if (view.trouble === 'unresponsive') setTrouble(view, null);
      else markState(view);
      keepTicking();
    },
    now: () => Date.now(),
    later: (callback, milliseconds) => { window.setTimeout(callback, milliseconds); },
  });
  window.addEventListener('message', (event) => broker?.receive(event));
  client.onFileChanged?.((changeSequence) => broker?.changes(changeSequence));
  client.onExtensionFramesFailed?.((failed) => {
    if (failed.fileSessionId === state.session.fileSessionId) framesFailed(failed.frames);
  });
  // The theme is an attribute the shell sets on the root, on every apply; only a change of
  // mode changes the colours a view is handed.
  themeMode = root.dataset.theme ?? null;
  new MutationObserver(() => {
    const mode = root.dataset.theme ?? null;
    if (mode === themeMode) return;
    themeMode = mode;
    broker?.theme(currentTheme());
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

/** Pings go out once a second while any view is connected, and stop with the last one. */
function keepTicking(): void {
  if (ticker !== null || broker === null) return;
  ticker = window.setInterval(() => {
    broker?.tick();
    if ((broker?.connectionCount() ?? 0) === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }, 1_000);
}

function parkingLot(): HTMLElement {
  if (parking === null || !parking.isConnected) {
    parking = document.createElement('div');
    parking.id = 'view-frame-parking';
    parking.hidden = true;
    parking.setAttribute('aria-hidden', 'true');
    document.body.append(parking);
  }
  return parking;
}

/**
 * Before a redraw: take every live frame out of the page it is about to lose. Only
 * `moveBefore` keeps a frame's document through the move; without it the frame is left to
 * go with the page and its view starts again in the new one.
 */
export function parkViewFrames(): void {
  generation += 1;
  if (!keepsFrames) return;
  for (const mount of mounts.values()) {
    const frame = mount.frame;
    if (frame === null || !content.contains(frame)) continue;
    try { parkingLot().moveBefore(frame, null); } catch { /* It goes with the page, and its view starts again. */ }
  }
}

/** After a redraw: a frame no placeholder adopted belongs to a view that is no longer on screen. */
export function releaseViewFrames(): void {
  for (const mount of [...mounts.values()]) if (mount.seen !== generation) dispose(mount);
}

function dispose(mount: Mount): void {
  broker?.disconnect(mount);
  if (mount.frame !== null) retire(mount.frame);
  mount.frame = null;
  if (mount.placeholder !== null) observer?.unobserve(mount.placeholder);
  mounts.delete(mount.key);
}

/** End a frame promptly: away to about:blank, which ends its renderer, then gone. */
function retire(frame: HTMLIFrameElement): void {
  frame.src = 'about:blank';
  if (keepsFrames && frame.isConnected && frame.parentElement !== parking) {
    try { parkingLot().moveBefore(frame, null); } catch { /* Left where it is, it goes with the page. */ }
  }
  window.setTimeout(() => frame.remove(), retireMs);
}

function stageOf(mount: Mount): HTMLElement | null {
  return mount.placeholder?.querySelector<HTMLElement>('[data-view-stage]') ?? null;
}

/** What a placeholder is doing, for the stylesheet and for the journeys that look. */
function markState(mount: Mount): void {
  if (mount.placeholder === null) return;
  mount.placeholder.dataset.viewState = mount.trouble !== null ? mount.trouble
    : mount.frame === null ? (mount.restarting ? 'starting' : 'waiting')
      : broker?.isConnected(mount) === true || mount.loaded ? 'running' : 'starting';
}

/**
 * Wire every view placeholder under `scope`: adopt the frame a view already has, start one
 * when its placeholder comes into view, or say why it does not run. Called by each view
 * that draws placeholders, after it has drawn them.
 */
export function wireViewFrames(scope: ParentNode): void {
  for (const element of scope.querySelectorAll<HTMLElement>('[data-view-mount]')) {
    const spec = viewSpecOf(element.dataset);
    const stage = element.querySelector<HTMLElement>('[data-view-stage]');
    if (spec === null || stage === null) continue;
    const notice = viewNotice(state.session.extensions, spec.packageId, client.mode);
    if (notice.kind !== 'run') {
      showNotice(element, stage, notice, spec);
      continue;
    }
    const key = mountKey(spec, state.session.fileSessionId, notice.pkg);
    let mount = mounts.get(key);
    if (mount === undefined) {
      mount = createMount(key, spec, notice.pkg.origin, notice.pkg.entryPoint);
      mounts.set(key, mount);
    }
    if (mount.placeholder !== null && mount.placeholder !== element) observer?.unobserve(mount.placeholder);
    mount.spec = spec;
    mount.seen = generation;
    mount.placeholder = element;
    byPlaceholder.set(element, mount);
    applyHeight(mount, stage);
    if (mount.frame !== null) adopt(mount, stage);
    else if (!mount.started) observe(element);
    else if (mount.trouble === null && !mount.restarting) start(mount);
    drawTrouble(mount);
    broker?.refreshContext(mount);
  }
}

function createMount(key: string, spec: ViewSpec, origin: string, entryPoint: string): Mount {
  const mount: Mount = {
    key, origin, entryPoint, spec,
    placeholder: null, frame: null, frameId: null,
    started: false, loaded: false, restarting: false, trouble: null,
    height: defaultPanelHeight, seen: generation,
    frameWindow: () => mount.frame?.contentWindow ?? null,
  };
  return mount;
}

function adopt(mount: Mount, stage: HTMLElement): void {
  const frame = mount.frame!;
  if (frame.parentElement === stage) return;
  if (keepsFrames && frame.isConnected) {
    try {
      stage.moveBefore(frame, stage.firstChild);
      return;
    } catch { /* Moved any other way it reloads, so it starts afresh below. */ }
  }
  broker?.disconnect(mount);
  frame.remove();
  mount.frame = null;
  mount.frameId = null;
  start(mount);
}

/** Put the view's frame in its stage. Its source is set here, which is what starts it. */
function start(mount: Mount): void {
  const stage = stageOf(mount);
  if (stage === null || mount.frame !== null) return;
  const frameId = newMountId();
  const frame = document.createElement('iframe');
  for (const [name, value] of frameAttributes({ mountId: frameId, origin: mount.origin, entryPoint: mount.entryPoint, title: mount.spec.title }))
    frame.setAttribute(name, value);
  frame.className = 'view-frame';
  frame.addEventListener('load', () => {
    if (mount.frame !== frame) return;
    mount.loaded = true;
    markState(mount);
  });
  mount.frame = frame;
  mount.frameId = frameId;
  mount.started = true;
  mount.loaded = false;
  mount.restarting = false;
  stage.prepend(frame);
  markState(mount);
}

function observe(element: HTMLElement): void {
  if (typeof IntersectionObserver === 'undefined') {
    const mount = byPlaceholder.get(element);
    if (mount !== undefined) start(mount);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      const mount = byPlaceholder.get(entry.target);
      if (mount !== undefined && mount.placeholder === entry.target && !mount.started) start(mount);
    }
  }, { rootMargin: '120px 0px' });
  observer.observe(element);
  const mount = byPlaceholder.get(element);
  if (mount !== undefined) markState(mount);
}

function applyHeight(mount: Mount, stage: HTMLElement): void {
  if (mount.spec.placement !== 'screen') stage.style.height = `${mount.height}px`;
}

/** A view's own height: a panel takes it; a screen fills its area and says how tall that is. */
function setHeight(mount: Mount, pixels: number): number {
  const stage = stageOf(mount);
  if (mount.spec.placement === 'screen') return Math.round(stage?.getBoundingClientRect().height ?? 0);
  mount.height = pixels;
  if (stage !== null) applyHeight(mount, stage);
  return pixels;
}

function showNotice(element: HTMLElement, stage: HTMLElement, notice: Exclude<ViewNotice, { kind: 'run' }>, spec: ViewSpec): void {
  element.dataset.viewState = notice.kind;
  stage.classList.add('is-notice');
  stage.innerHTML = viewNoticeMarkup(notice, spec);
  stage.querySelector<HTMLButtonElement>('[data-view-settings]')?.addEventListener('click', () => void openCustomViews());
  stage.querySelector<HTMLButtonElement>('[data-view-health]')?.addEventListener('click', () => void refreshHealth());
  stage.querySelector<HTMLButtonElement>('[data-view-import]')?.addEventListener('click', () => void importPackage('use'));
  stage.querySelector<HTMLButtonElement>('[data-view-resume]')?.addEventListener('click', () => void setViewSwitch('device', true));
}

function setTrouble(mount: Mount, trouble: ViewTrouble | null): void {
  mount.trouble = trouble;
  drawTrouble(mount);
}

function drawTrouble(mount: Mount): void {
  const stage = stageOf(mount);
  if (stage === null) return;
  stage.querySelector(':scope > .view-overlay')?.remove();
  markState(mount);
  if (mount.trouble === null) return;
  stage.insertAdjacentHTML('beforeend', viewOverlayMarkup(mount.trouble));
  const overlay = stage.lastElementChild as HTMLElement;
  overlay.querySelector<HTMLButtonElement>('[data-view-reload]')?.addEventListener('click', () => reload(mount));
  overlay.querySelector<HTMLButtonElement>('[data-view-stop]')?.addEventListener('click', () => stop(mount));
}

/**
 * End every frame of one package. Its frames share one renderer (spike S1), so a view that
 * stopped answering has taken the others with it, and only sending all of them away ends
 * that renderer.
 */
function endPackage(origin: string): Mount[] {
  const affected = [...mounts.values()].filter((mount) => mount.origin === origin && mount.frame !== null);
  for (const mount of affected) {
    broker?.disconnect(mount);
    retire(mount.frame!);
    mount.frame = null;
    mount.frameId = null;
    mount.loaded = false;
  }
  return affected;
}

function stop(mount: Mount): void {
  for (const ended of endPackage(mount.origin)) setTrouble(ended, 'stopped');
  if (mount.frame === null && mount.trouble !== 'stopped') setTrouble(mount, 'stopped');
}

function reload(mount: Mount): void {
  if (mount.trouble === 'unresponsive') {
    // The renderer is not answering, so the frames it holds start again only once it has gone.
    const affected = endPackage(mount.origin);
    for (const ended of affected) {
      ended.restarting = true;
      setTrouble(ended, null);
    }
    window.setTimeout(() => {
      for (const ended of affected) if (mounts.get(ended.key) === ended && ended.restarting) start(ended);
    }, retireMs);
    return;
  }
  if (mount.trouble === 'crashed' && mount.frame !== null) {
    // The renderer is already gone; the same frame navigates again, into a new one (spike S4).
    broker?.disconnect(mount);
    mount.loaded = false;
    setTrouble(mount, null);
    mount.frame.src = frameSource(mount.origin, mount.entryPoint);
    return;
  }
  setTrouble(mount, null);
  if (mount.frame === null) start(mount);
}

/** The host says these frames' renderer ended: each shows that, with Reload. */
function framesFailed(names: readonly string[]): void {
  for (const name of names) {
    const mount = [...mounts.values()].find((candidate) => candidate.frameId !== null && frameName(candidate.frameId) === name);
    if (mount === undefined) continue;
    broker?.disconnect(mount);
    setTrouble(mount, 'crashed');
  }
}
