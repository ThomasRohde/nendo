import { state } from './app-state';
import { escapeAttribute, escapeHtml } from './format';
import type { FieldPlan, RecordPlan } from './host';
import { loadsWebPictures, mediaSourceLabel, mediaUrl, parseMediaAddress, type MediaAddress } from './media-model';

/** Where pictures are drawn: the open file's media origin, whether it may be edited, whether web pictures load. */
export interface MediaContext {
  origin: string | null | undefined;
  canEdit: boolean;
  loadWeb: boolean;
}

function currentContext(): MediaContext {
  return { origin: state.session.mediaOrigin, canEdit: state.session.capabilities.mutate, loadWeb: loadsWebPictures() };
}

/**
 * Picture fields as markup (ADR-0031), drawn as the image canvas's direction A: the picture
 * fitted to its column, a source line with a menu under it, a drop zone when empty and a quiet
 * row when the picture is not there. Pure markup, so a page is drawn the same on the server side
 * of a test; media-field.ts wires it.
 */

/** The file name or host a person recognises an address by. */
export function mediaShortName(address: MediaAddress): string {
  if (address.source === 'embedded') return 'Picture in this file';
  if (address.source === 'web') {
    try { return new URL(address.value).hostname; } catch { return address.value; }
  }
  const parts = address.value.split(/[\\/]/);
  return parts[parts.length - 1] || address.value;
}

export function menuItem(action: string, label: string, options: { disabled?: boolean; danger?: boolean } = {}): string {
  return `<button type="button" role="menuitem" class="media-menu-item${options.danger ? ' is-danger' : ''}" data-media-action="${action}"${options.disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

/** The actions a picture offers, by where it comes from. */
export function mediaMenuMarkup(address: MediaAddress | null, saved: boolean): string {
  const embedded = address?.source === 'embedded';
  const local = address?.source === 'localAbsolute' || address?.source === 'localRelative';
  const web = address?.source === 'web';
  return [
    menuItem('pick', address === null ? 'Choose picture…' : 'Replace…', { disabled: !saved }),
    menuItem('paste', 'Paste picture', { disabled: !saved }),
    menuItem('link', address === null ? 'Link a file…' : 'Link to a file instead…', { disabled: !saved }),
    menuItem('web', 'Web address…', { disabled: !saved }),
    ...(address === null ? [] : ['<div class="media-menu-separator" role="separator"></div>',
      menuItem('save', 'Save a copy…', { disabled: !embedded }),
      menuItem('embed-copy', embedded ? 'Embed a copy (already in file)' : 'Embed a copy', { disabled: embedded || !saved }),
      menuItem('reveal', 'Show in folder', { disabled: !local }),
      ...(web ? [menuItem('web-off', 'Stop loading pictures from the internet')] : []),
      '<div class="media-menu-separator" role="separator"></div>',
      menuItem('remove', 'Remove from record', { danger: true, disabled: !saved })]),
  ].join('');
}

/**
 * The control a media field is edited with. Read-only and retired fields show the picture
 * without its actions; a record not saved yet is told to save first, since a picture is stored
 * against a record.
 */
export function mediaFieldMarkup(field: FieldPlan, currentValue: unknown, record: RecordPlan | null = null,
  where: MediaContext = currentContext()): string {
  const name = escapeAttribute(field.semanticId);
  const label = escapeHtml(field.displayName);
  const raw = typeof currentValue === 'string' ? currentValue : '';
  const address = parseMediaAddress(raw);
  const saved = record !== null && where.canEdit;
  const hidden = `<input type="hidden" name="${name}" value="${escapeAttribute(raw)}" data-media-value />`;
  const menuId = `media-menu-${escapeAttribute(field.semanticId.replace(/[^A-Za-z0-9_-]/g, '-'))}`;
  const menu = `<button type="button" class="media-menu-button" aria-label="${escapeAttribute(field.displayName)} actions" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-media-menu-button>⋯</button>
    <div class="media-menu" role="menu" id="${menuId}" aria-label="${escapeAttribute(field.displayName)}" hidden>${mediaMenuMarkup(address, saved)}</div>`;
  const webForm = `<div class="media-web-form" data-media-web-form hidden><label>Web address<input type="url" inputmode="url" placeholder="https://…" data-media-web-input /></label><button type="button" class="primary-button" data-media-action="web-save">Use this address</button><button type="button" class="secondary-button" data-media-action="web-cancel">Cancel</button></div>`;
  const open = `<div class="media-field" data-media-field="${name}" data-media-address="${escapeAttribute(raw)}" tabindex="-1">`;
  if (raw !== '' && address === null) {
    // A value the field was switched over with, or an older client's: shown as text, never dropped.
    return `${open}<span class="media-field-label">${label}</span>${hidden}<p class="media-unreadable">Not a picture's address: <code>${escapeHtml(raw)}</code></p>${saved ? `<div class="media-line">${menu}</div>` : ''}${webForm}</div>`;
  }
  if (address === null) {
    const note = record === null ? '<p class="field-note">Save the record first, then add a picture.</p>' : '';
    return `${open}<span class="media-field-label">${label}</span>${hidden}
      <div class="media-drop" data-media-drop${saved ? '' : ' aria-disabled="true"'}>
        <p>${saved ? 'Drop a picture here, paste one, or choose a file.' : 'No picture.'}</p>
        ${saved ? `<div class="media-drop-actions"><button type="button" class="primary-button" data-media-action="pick">Choose picture…</button><button type="button" class="secondary-button" data-media-action="link">Link a file…</button><button type="button" class="secondary-button" data-media-action="web">Web address…</button></div>` : ''}
      </div>${note}${webForm}</div>`;
  }
  const url = mediaUrl(address, where.origin, where.loadWeb);
  const source = `<span class="media-source">${escapeHtml(mediaSourceLabel(address.source))}</span>`;
  const detail = `<span class="media-detail" title="${escapeAttribute(address.value)}">${escapeHtml(mediaShortName(address))}</span>`;
  const line = `<div class="media-line">${source}${detail}<span class="media-line-spacer"></span>${saved ? menu : ''}</div>`;
  const body = url === null && address.source === 'web'
    ? `<div class="media-waiting"><p>Pictures from the internet are not loaded on this device.</p><button type="button" class="secondary-button" data-media-action="web-on">Load pictures from the internet</button></div>`
    : url === null
    ? `<div class="media-missing" data-media-missing><span class="media-missing-title">Picture not shown</span><code>${escapeHtml(address.value)}</code></div>`
    : `<button type="button" class="media-picture" data-media-open aria-label="Open ${escapeAttribute(field.displayName)} larger"><img src="${escapeAttribute(url)}" alt="${escapeAttribute(field.displayName)}" loading="lazy" decoding="async" data-media-img /></button>
       <div class="media-missing" data-media-missing hidden><span class="media-missing-title">Picture not found</span><code>${escapeHtml(address.value)}</code></div>`;
  return `${open}<span class="media-field-label">${label}</span>${hidden}<div class="media-frame" data-media-drop>${body}</div>${line}${webForm}</div>`;
}

/**
 * A picture as a thumbnail, for a list row, a card, an outline row or Studio's cell: empty for a
 * value that is not a picture's address or not shown on this device, so the caller says Not set.
 */
export function mediaThumbMarkup(value: unknown, label: string, small = false, where: MediaContext = currentContext()): string {
  const address = parseMediaAddress(value);
  if (address === null) return '';
  const url = mediaUrl(address, where.origin, where.loadWeb);
  if (url === null) return `<span class="media-thumb${small ? ' is-small' : ''}" title="${escapeAttribute(address.value)}" role="img" aria-label="${escapeAttribute(`${label}: not loaded on this device`)}"></span>`;
  return `<span class="media-thumb${small ? ' is-small' : ''}" title="${escapeAttribute(address.value)}"><img src="${escapeAttribute(url)}" alt="${escapeAttribute(label)}" loading="lazy" decoding="async" data-media-thumb /></span>`;
}

/** A gallery card's cover: the picture at a square, or nothing when the record has none. */
export function mediaCoverMarkup(value: unknown, where: MediaContext = currentContext()): string {
  const address = parseMediaAddress(value);
  const url = address === null ? null : mediaUrl(address, where.origin, where.loadWeb);
  return url === null ? '<span class="media-cover is-empty" aria-hidden="true"></span>'
    : `<span class="media-cover"><img src="${escapeAttribute(url)}" alt="" loading="lazy" decoding="async" data-media-thumb /></span>`;
}

