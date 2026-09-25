import { escapeAttribute, escapeHtml } from './format';
import type { ExtensionOffReason, ExtensionPackageView, ExtensionRuntimeView, SurfaceNodePlan, WorkbenchMode } from './host-types';
import type { ViewSpec } from './extension-model';
import { icon } from './icons';
import { byteSize } from './package-diff-markup';

/**
 * How a custom view sits on a page (ADR-0013), as markup and nothing else: its placeholder,
 * what the placeholder says when the view cannot run, the overlay over a view that stopped,
 * and the frame itself. view-frames.ts puts these on screen and runs them; keeping the
 * markup here lets scripts/view-frames.test.mjs read exactly what the page draws.
 */

/**
 * The frame's sandbox: everything a web page does, except navigating the Workbench away.
 * `allow-top-navigation` in any form is never here, so a view cannot replace Studio.
 */
export const frameSandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation';

/** What a view may ask the browser for. Anything else gets WebView2's own prompt. */
export const frameAllow = 'clipboard-read; clipboard-write; fullscreen; web-share; autoplay; encrypted-media; picture-in-picture; geolocation';

/** The height a view on a record page starts at, until it asks for another. */
export const defaultPanelHeight = 360;

/** A mount's own ID: twelve hex digits, fresh for every mount. */
export function newMountId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** The iframe's name, which is how the host names a frame whose renderer ended. */
export function frameName(mountId: string): string {
  return `nendo-view-${mountId}`;
}

export const frameNamePattern = /^nendo-view-[0-9a-f]{12}$/;

/** An origin the host serves views from: https, one label, under the reserved .example. */
export function isViewOrigin(origin: string): boolean {
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.example$/.test(origin);
}

/** Where the frame starts: the package's entry point on its origin, each path segment encoded. */
export function frameSource(origin: string, entryPoint: string): string {
  return `${origin}/${entryPoint.split('/').map(encodeURIComponent).join('/')}`;
}

export interface FrameSpec { mountId: string; origin: string; entryPoint: string; title: string }

/** The frame's attributes, in the order they are set: the source last, once the sandbox is on. */
export function frameAttributes(frame: FrameSpec): Array<[string, string]> {
  return [
    ['name', frameName(frame.mountId)],
    ['title', frame.title],
    ['sandbox', frameSandbox],
    ['allow', frameAllow],
    ['loading', 'lazy'],
    ['src', frameSource(frame.origin, frame.entryPoint)],
  ];
}

/** The frame as markup, for the guard that reads it; the page builds the same element in code. */
export function frameMarkup(frame: FrameSpec): string {
  return `<iframe ${frameAttributes(frame).map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(' ')}></iframe>`;
}

export function viewTitle(node: SurfaceNodePlan): string {
  const title = node.properties.title;
  if (typeof title === 'string' && title.trim().length > 0) return title;
  return node.kind === 'extensionGraphSurface' ? 'Custom graph' : 'Custom view';
}

/** What a placeholder needs to know about the view it holds. */
export function viewSpecFor(
  node: SurfaceNodePlan,
  placement: 'screen' | 'recordPage',
  entityId: string | null,
  recordId: string | null,
): ViewSpec {
  return {
    viewId: node.semanticId,
    kind: node.kind,
    placement,
    title: viewTitle(node),
    packageId: typeof node.properties.packageId === 'string' ? node.properties.packageId : '',
    entityId,
    recordId,
  };
}

/** The spec back from a placeholder's data attributes. */
export function viewSpecOf(data: Record<string, string | undefined>): ViewSpec | null {
  const placement = data.viewPlacement;
  if (typeof data.viewId !== 'string' || data.viewId === '' || (placement !== 'screen' && placement !== 'recordPage')) return null;
  return {
    viewId: data.viewId,
    kind: data.viewKind ?? '',
    placement,
    title: data.viewTitle ?? 'Custom view',
    packageId: data.viewPackage ?? '',
    entityId: data.viewEntity ? data.viewEntity : null,
    recordId: data.viewRecord ? data.viewRecord : null,
  };
}

function specAttributes(spec: ViewSpec): string {
  return `data-view-mount data-view-id="${escapeAttribute(spec.viewId)}" data-view-kind="${escapeAttribute(spec.kind)}" ` +
    `data-view-placement="${spec.placement}" data-view-title="${escapeAttribute(spec.title)}" data-view-package="${escapeAttribute(spec.packageId)}" ` +
    `data-view-entity="${escapeAttribute(spec.entityId ?? '')}" data-view-record="${escapeAttribute(spec.recordId ?? '')}"`;
}

/**
 * The place a view runs. On a record page it is a titled panel at its authored position; on a
 * screen of its own it fills the screen. The frame goes into the stage when the placeholder
 * scrolls into view, and until then the page draws nothing a view could slow down.
 */
export function viewPlaceholderMarkup(spec: ViewSpec): string {
  if (spec.placement === 'recordPage') {
    const titleId = `view-title-${escapeAttribute(spec.viewId)}`;
    return `<section class="view-mount is-panel" ${specAttributes(spec)} aria-labelledby="${titleId}"><header class="view-header"><h3 id="${titleId}">${escapeHtml(spec.title)}</h3><span class="view-package">${escapeHtml(spec.packageId)}</span></header><div class="view-stage" data-view-stage></div></section>`;
  }
  return `<section class="view-mount is-screen" ${specAttributes(spec)} aria-label="${escapeAttribute(spec.title)}"><div class="view-stage" data-view-stage></div></section>`;
}

/** A panel on a record that has not been saved: no record, so nothing for a view to be about. */
export function unsavedViewMarkup(spec: ViewSpec): string {
  const titleId = `view-title-${escapeAttribute(spec.viewId)}`;
  return `<section class="view-mount is-panel" data-view-unsaved aria-labelledby="${titleId}"><header class="view-header"><h3 id="${titleId}">${escapeHtml(spec.title)}</h3><span class="view-package">${escapeHtml(spec.packageId)}</span></header><div class="view-notice"><p>Save this record to show its custom view.</p></div></section>`;
}

/** Whether a view can run here, and when it cannot, which of the reasons it is. */
export type ViewNotice =
  | { kind: 'run'; pkg: ExtensionPackageView }
  | { kind: 'off'; reason: ExtensionOffReason | null }
  | { kind: 'missing' }
  | { kind: 'preview' }
  | { kind: 'unavailable' }
  | { kind: 'unservable' };

/**
 * The switches are checked before the package: with views off, a missing package is not
 * what stands between the person and the view. A package whose origin is not a view origin
 * is never framed, whatever the host said.
 */
export function viewNotice(extensions: ExtensionRuntimeView | null | undefined, packageId: string, mode: WorkbenchMode): ViewNotice {
  if (extensions === null || extensions === undefined) return mode === 'preview' ? { kind: 'preview' } : { kind: 'unavailable' };
  if (!extensions.run) return { kind: 'off', reason: extensions.offReason };
  const pkg = extensions.packages.find((candidate) => candidate.packageId === packageId);
  if (pkg === undefined) return { kind: 'missing' };
  if (mode !== 'desktop') return { kind: 'preview' };
  if (!isViewOrigin(pkg.origin)) return { kind: 'unservable' };
  return { kind: 'run', pkg };
}

/** Why custom views are off, in the words every placeholder and Studio use. */
export function offReasonSentence(reason: ExtensionOffReason | null): string {
  switch (reason) {
    case 'device': return 'Custom views are off on this device.';
    case 'file': return 'Custom views are off for this file on this device.';
    case 'health': return 'Custom views do not run while this file needs attention.';
    case 'recovery': return 'Custom views are off because Nendo was restarted without them.';
    default: return 'Custom views are off.';
  }
}

/**
 * What a placeholder says when its view cannot run, with the one step that fixes it where
 * there is one. The step is a button, never a link to somewhere that might not answer.
 */
export function viewNoticeMarkup(notice: Exclude<ViewNotice, { kind: 'run' }>, spec: ViewSpec): string {
  const title = escapeHtml(spec.title);
  const packageId = escapeHtml(spec.packageId);
  let body: string;
  switch (notice.kind) {
    case 'off':
      body = notice.reason === 'device' || notice.reason === 'file'
        ? `<p>${escapeHtml(offReasonSentence(notice.reason))} Turn them on under Studio → Surfaces → Custom views.</p><button type="button" class="secondary-button" data-view-settings>Open Custom views</button>`
        : notice.reason === 'health'
          ? `<p>${escapeHtml(offReasonSentence(notice.reason))} Health says why.</p><button type="button" class="secondary-button" data-view-health>Open Health</button>`
          : notice.reason === 'recovery'
            ? `<p>${escapeHtml(offReasonSentence(notice.reason))} They start again with Nendo, or when you run them again here.</p><button type="button" class="secondary-button" data-view-resume>Run custom views again</button>`
            : `<p>${escapeHtml(offReasonSentence(notice.reason))}</p>`;
      break;
    case 'missing':
      body = `<p><strong>${packageId}</strong> is not in this file, so ${title} has no code to run. Adding it is a proposal you review before anything runs.</p><button type="button" class="primary-button" data-action data-view-import>Add package to file…</button>`;
      break;
    case 'preview':
      body = `<p>Custom views run in Nendo Desktop, not in this preview. In Nendo, ${title} runs here from the ${packageId} package in this file.</p>`;
      break;
    case 'unservable':
      body = `<p>${title} cannot be shown: its package has no address Nendo serves views from.</p>`;
      break;
    default:
      body = '<p>Custom views are not available in this session.</p>';
      break;
  }
  return `<div class="view-notice" role="status" data-view-notice="${notice.kind}">${body}</div>`;
}

/** Something happened to a running view that the person should see over it. */
export type ViewTrouble = 'unresponsive' | 'stopped' | 'crashed';

export function viewOverlayMarkup(trouble: ViewTrouble): string {
  switch (trouble) {
    case 'unresponsive':
      return '<div class="view-overlay" role="alert" data-view-overlay="unresponsive"><p><strong>This view is not responding.</strong> Stop ends it; Reload starts it again. The rest of Nendo is unaffected.</p><div class="view-overlay-actions"><button type="button" class="secondary-button" data-view-stop>Stop</button><button type="button" class="primary-button" data-view-reload>Reload</button></div></div>';
    case 'crashed':
      return '<div class="view-overlay" role="alert" data-view-overlay="crashed"><p><strong>This view stopped.</strong> Its page ended unexpectedly; the rest of Nendo is unaffected.</p><div class="view-overlay-actions"><button type="button" class="primary-button" data-view-reload>Reload</button></div></div>';
    default:
      return '<div class="view-overlay" role="status" data-view-overlay="stopped"><p><strong>This view is stopped.</strong> Reload starts it again.</p><div class="view-overlay-actions"><button type="button" class="primary-button" data-view-reload>Reload</button></div></div>';
  }
}

/**
 * The key a frame is kept under across redraws. A redraw of the same view, for the same
 * record, in the same open file, from the same package content keeps its frame; anything
 * else is another view, and starts afresh. The package's size and file count stand in for
 * its content, so an accepted change to its code starts the view on the new code.
 */
export function mountKey(spec: ViewSpec, fileSessionId: string | null, pkg: ExtensionPackageView): string {
  return JSON.stringify([fileSessionId, spec.placement, spec.viewId, spec.recordId, pkg.packageId, pkg.origin,
    pkg.entryPoint, pkg.version, pkg.fileCount, pkg.totalBytes, pkg.contentDigest ?? null]);
}

/**
 * Studio → Surfaces → Custom views: the two switches that decide whether views run here, and
 * the packages this file carries. The switches are this device's and never change the file;
 * adding or removing a package is a proposal, reviewed line by line like any definition change.
 */
export function customViewsPanelMarkup(extensions: ExtensionRuntimeView | null | undefined, fileName: string | null): string {
  const intro = '<p>A custom view runs from code this file carries, on the screen or record page that shows it. Its code comes in through a proposal you review. These two switches belong to this device and change nothing in the file.</p>';
  const open = '<section class="custom-views-panel" id="custom-views" aria-labelledby="custom-views-title" data-testid="custom-views">';
  if (extensions === null || extensions === undefined)
    return `${open}<header class="custom-views-heading"><div><h2 id="custom-views-title">Custom views</h2>${intro}</div></header><p class="custom-views-status">Custom views are not available in this session.</p></section>`;
  const chip = extensions.run
    ? `<span class="health-chip healthy">${icon('check')}Running</span>`
    : `<span class="health-chip warning">${icon('alert')}Off</span>`;
  const status = extensions.run
    ? 'Views run wherever a screen or a record page shows them.'
    : offReasonSentence(extensions.offReason) + (extensions.offReason === 'device' || extensions.offReason === 'file' ? ' Turn both switches on to run them.'
      : extensions.offReason === 'recovery' ? ' They start again with Nendo, or when you run them again here.' : '');
  // After Restart without custom views both switches can still read on; running views again
  // is its own step, and the switch beside it would only turn them off.
  const resume = extensions.offReason === 'recovery'
    ? '<div class="custom-views-resume"><button type="button" class="secondary-button" data-view-resume>Run custom views again</button></div>'
    : '';
  const toggle = (scope: 'device' | 'file', on: boolean, label: string, detail: string): string =>
    `<div class="connection-setting"><button class="connection-toggle" type="button" data-view-switch="${scope}" aria-pressed="${on}"><span class="switch-glyph" aria-hidden="true"></span><span class="toggle-text"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span></button></div>`;
  const toggles = `<div class="connection-settings custom-views-switches">${toggle('device', extensions.deviceEnabled, 'Run custom views', 'On this device, for every file')}${toggle('file', extensions.fileEnabled, 'Run this file’s views', fileName === null ? 'On this device, for this file' : `On this device, for ${fileName}`)}</div>`;
  const packages = extensions.packages.length === 0
    ? '<p class="package-empty">No custom-view packages in this file yet.</p>'
    : `<div class="package-list" role="list" aria-label="Packages in this file">${extensions.packages.map((pkg) => {
      const facts = [pkg.packageId, pkg.version === null ? null : `version ${pkg.version}`,
        `${pkg.fileCount} ${pkg.fileCount === 1 ? 'file' : 'files'}`, byteSize(pkg.totalBytes)].filter((fact): fact is string => fact !== null);
      return `<article class="package-card" role="listitem" data-package="${escapeAttribute(pkg.packageId)}"><span class="surface-icon" aria-hidden="true">${icon('surfaces')}</span><div class="surface-detail"><h3>${escapeHtml(pkg.title)}</h3><p>${escapeHtml(facts.join(' · '))}</p>${pkg.description === null || pkg.description === '' ? '' : `<p class="package-description">${escapeHtml(pkg.description)}</p>`}</div><div class="package-actions"><button type="button" class="secondary-button" data-package-export="${escapeAttribute(pkg.packageId)}">Export…</button><button type="button" class="secondary-button" data-action data-package-remove="${escapeAttribute(pkg.packageId)}">Remove…</button></div></article>`;
    }).join('')}</div>`;
  return `${open}<header class="custom-views-heading"><div><h2 id="custom-views-title">Custom views</h2>${intro}</div>${chip}</header><p class="custom-views-status" role="status">${escapeHtml(status)}</p>${resume}${typeof extensions.notice === 'string' && extensions.notice.length > 0 ? `<p class="custom-views-notice">${escapeHtml(extensions.notice)}</p>` : ''}${toggles}<h3 class="package-heading">Packages in this file</h3>${packages}<div class="package-footer"><button type="button" class="secondary-button" data-action data-package-import>Import package…</button><small>A folder, a .zip or a .nendoview file. Importing prepares a proposal; nothing runs until you accept it.</small></div></section>`;
}
