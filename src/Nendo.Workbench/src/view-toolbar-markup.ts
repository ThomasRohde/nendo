import { escapeAttribute, escapeHtml } from './format';
import { icon } from './icons';
import type {
  MenuItem, ToolbarButton, ToolbarIcon, ToolbarItem, ToolbarToggle, ViewToolbar,
} from './view-toolbar-model';

/**
 * A custom view's toolbar and menus as Nendo draws them (ADR-0013, 2026-09-28; W-090), as
 * markup and nothing else. Every control is the Workbench's own: the segmented control of the
 * view switcher, the labelled select, a search box, bordered buttons, and the File menu's
 * panel. The view's words are escaped where they land, and its icons are Nendo's, by name.
 *
 * view-toolbar.ts puts these on screen and wires them; keeping the markup here lets
 * scripts/view-toolbar.test.mjs read exactly what the page draws.
 */

const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Plus: '+' };

/** A normalised key as the person reads it, the way Nendo's own table writes keys: "Ctrl Shift F". */
export function keyDisplay(keys: string): string {
  return keys.split('+').map((part) => arrows[part] ?? part).join(' ');
}

/** The same key in the form aria-keyshortcuts takes: "Control+Shift+F". */
export function keyAria(keys: string): string {
  return keys.split('+').map((part) => (part === 'Ctrl' ? 'Control' : part)).join('+');
}

/** A key beside its control: shown only while the person asks for the hints, as every other one. */
function hint(keys: string | null): string {
  return keys === null ? '' : `<kbd class="kbd-hint" aria-hidden="true">${escapeHtml(keyDisplay(keys))}</kbd>`;
}

function keyAttributes(keys: string | null): string {
  return keys === null ? '' : ` aria-keyshortcuts="${escapeAttribute(keyAria(keys))}"`;
}

function glyph(name: ToolbarIcon | null): string {
  return name === null ? '' : icon(name);
}

/** The tooltip a control carries: its label, and its key when it has one. */
function titleOf(label: string, keys: string | null): string {
  return keys === null ? label : `${label} (${keyDisplay(keys)})`;
}

function pressableMarkup(item: ToolbarButton | ToolbarToggle, joined: boolean): string {
  const iconOnly = item.iconOnly && item.icon !== null;
  const classes = ['view-toolbar-button', iconOnly ? 'is-icon' : '', joined ? 'is-joined' : ''].filter((name) => name !== '').join(' ');
  const pressed = item.kind === 'toggle' ? ` aria-pressed="${item.pressed}"` : '';
  const name = iconOnly ? ` aria-label="${escapeAttribute(item.label)}"` : '';
  const body = iconOnly ? glyph(item.icon) : `${glyph(item.icon)}<span>${escapeHtml(item.label)}</span>`;
  return `<button type="button" class="${classes}" data-view-command="${escapeAttribute(item.id)}"${pressed}${name}${keyAttributes(item.keys)} title="${escapeAttribute(titleOf(item.label, item.keys))}"${item.disabled ? ' disabled' : ''}>${body}${hint(item.keys)}</button>`;
}

function itemMarkup(item: ToolbarItem, prefix: string): string {
  switch (item.kind) {
    case 'button':
    case 'toggle':
      return pressableMarkup(item, false);
    case 'choice': {
      const labelId = `${prefix}-${item.id}-label`;
      const buttons = item.options.map((option) =>
        `<button type="button" aria-pressed="${option.value === item.value}" data-view-command="${escapeAttribute(item.id)}" data-view-value="${escapeAttribute(option.value)}"${option.disabled || item.disabled ? ' disabled' : ''}>${escapeHtml(option.label)}</button>`).join('');
      const group = `<div class="view-switcher view-toolbar-choice${item.options.every((option) => option.label.length <= 3) ? ' is-tight' : ''}" role="group" ${item.hideLabel ? `aria-label="${escapeAttribute(item.label)}"` : `aria-labelledby="${escapeAttribute(labelId)}"`}>${buttons}</div>`;
      return item.hideLabel ? group : `<span class="view-toolbar-field"><span class="view-toolbar-label" id="${escapeAttribute(labelId)}">${escapeHtml(item.label)}</span>${group}</span>`;
    }
    case 'select': {
      const options = `${item.value === null ? '<option value="" selected disabled hidden></option>' : ''}${item.options.map((option) =>
        `<option value="${escapeAttribute(option.value)}"${option.value === item.value ? ' selected' : ''}${option.disabled ? ' disabled' : ''}>${escapeHtml(option.label)}</option>`).join('')}`;
      const select = `<select data-view-command="${escapeAttribute(item.id)}"${item.hideLabel ? ` aria-label="${escapeAttribute(item.label)}"` : ''}${item.disabled ? ' disabled' : ''}>${options}</select>`;
      return item.hideLabel ? `<span class="select-field view-toolbar-select">${select}</span>` : `<label class="select-field view-toolbar-select">${escapeHtml(item.label)}${select}</label>`;
    }
    case 'search':
      return `<label class="view-toolbar-search"><span class="visually-hidden">${escapeHtml(item.label)}</span>${icon('search')}<input type="search" autocomplete="off" spellcheck="false" data-view-command="${escapeAttribute(item.id)}" data-view-search value="${escapeAttribute(item.value)}" placeholder="${escapeAttribute(item.placeholder ?? item.label)}"${keyAttributes(item.keys)}${item.disabled ? ' disabled' : ''}>${hint(item.keys)}</label>`;
    case 'menu': {
      const iconOnly = item.iconOnly && item.icon !== null;
      const body = iconOnly ? glyph(item.icon) : `${glyph(item.icon)}<span>${escapeHtml(item.label)}</span>${icon('chevron')}`;
      return `<button type="button" class="view-toolbar-button${iconOnly ? ' is-icon' : ''}" data-view-menu="${escapeAttribute(item.id)}" aria-haspopup="menu" aria-expanded="false"${iconOnly ? ` aria-label="${escapeAttribute(item.label)}"` : ''} title="${escapeAttribute(item.label)}"${item.disabled ? ' disabled' : ''}>${body}</button>`;
    }
    case 'group':
      return `<div class="view-toolbar-joined" role="group" aria-label="${escapeAttribute(item.label)}">${item.items.map((child) => pressableMarkup(child, true)).join('')}</div>`;
    case 'text':
      // The title carries the whole text where the row has cut it short (W-092).
      return `<span class="view-toolbar-text${item.mono ? ' is-mono' : ''}" title="${escapeAttribute(item.text)}">${escapeHtml(item.text)}</span>`;
    case 'separator':
      return '<span class="view-toolbar-separator" role="separator" aria-orientation="vertical"></span>';
    case 'spacer':
      return '<span class="toolbar-spacer" aria-hidden="true"></span>';
    default:
      return '';
  }
}

/**
 * The strip above a view's frame, or the controls in its panel's header on a record page.
 * `prefix` keeps the IDs that tie a label to its control apart between two views.
 */
export function viewToolbarMarkup(toolbar: ViewToolbar, options: { title: string; compact: boolean; prefix: string; inline?: boolean }): string {
  if (toolbar.items.length === 0) return '';
  return `<div class="view-toolbar${options.compact ? ' is-compact' : ''}${options.inline === true ? ' is-inline' : ''}" role="toolbar" aria-label="${escapeAttribute(options.title)}" data-view-toolbar>${toolbar.items.map((item) => itemMarkup(item, options.prefix)).join('')}</div>`;
}

/**
 * One of Nendo's menus: a toolbar's, or the one a view asked for at a point. Every item that
 * can be picked is a button in the menu's order, with its index; the menu's key, if any, is
 * always shown, as a menu shows its accelerators.
 */
export function viewMenuMarkup(items: readonly MenuItem[], label: string): string {
  const body = items.map((item, index) => {
    switch (item.kind) {
      case 'separator': return '<div class="view-menu-separator" role="separator"></div>';
      case 'label': return `<div class="view-menu-label" role="presentation">${escapeHtml(item.label)}</div>`;
      case 'item': {
        const text = item.detail === null ? `<span class="view-menu-text">${escapeHtml(item.label)}</span>`
          : `<span class="view-menu-text"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>`;
        return `<button type="button" class="view-menu-item${item.danger ? ' is-danger' : ''}${item.detail === null ? '' : ' is-rich'}" role="menuitem" tabindex="-1" data-menu-index="${index}"${item.disabled ? ' disabled aria-disabled="true"' : ''}>${item.icon === null ? '<span class="view-menu-glyph"></span>' : `<span class="view-menu-glyph">${icon(item.icon)}</span>`}${text}${item.keys === null ? '' : `<kbd class="view-menu-keys">${escapeHtml(keyDisplay(item.keys))}</kbd>`}</button>`;
      }
      case 'check':
      case 'radio':
        return `<button type="button" class="view-menu-item" role="${item.kind === 'check' ? 'menuitemcheckbox' : 'menuitemradio'}" aria-checked="${item.checked}" tabindex="-1" data-menu-index="${index}"${item.disabled ? ' disabled aria-disabled="true"' : ''}><span class="view-menu-glyph">${item.checked ? icon('check') : ''}</span><span class="view-menu-text">${escapeHtml(item.label)}</span>${item.kind === 'check' && item.keys !== null ? `<kbd class="view-menu-keys">${escapeHtml(keyDisplay(item.keys))}</kbd>` : ''}</button>`;
      default: return '';
    }
  }).join('');
  return `<div class="view-menu" role="menu" aria-label="${escapeAttribute(label)}" data-view-menu-open>${body}</div>`;
}
