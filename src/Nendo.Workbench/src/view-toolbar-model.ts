import { WorkbenchHostError } from './host-types';
import { extensionLimits, hostKeys, normalizeKeys, parseKeys, utf8Length } from './extension-api/protocol';

/**
 * A custom view's controls in Nendo's own chrome (ADR-0013, 2026-09-28; W-090), as data.
 *
 * A view declares what it can do and Nendo draws it with its own parts: a toolbar strip above
 * the view's frame, Nendo's menus, Ctrl K and the keys. The declaration crosses from the view's
 * origin, so it is rebuilt here key by key into a closed set of kinds and icons, each label
 * plain text and bounded. Nothing a view sends becomes markup or a method name; what the
 * Workbench draws from it is view-toolbar-markup.ts's business.
 *
 * No DOM here, so scripts/view-toolbar.test.mjs and the broker's own suite drive it directly.
 */

/** The icons a view may put on a control: Nendo's own outline set, named. */
export const toolbarIcons = [
  'plus', 'minus', 'search', 'fit', 'pan', 'export', 'filter', 'list', 'link', 'focus', 'more', 'check',
  'edit', 'external', 'trash', 'arrowUp', 'arrowDown', 'chevronLeft', 'chevronRight', 'indent', 'outdent',
  'layers', 'chain', 'refresh', 'settings', 'eye', 'command', 'info',
  // W-115, for the Archi workbench's row: Copy and paste, Lay out, Undo and Redo.
  'clipboard', 'layout', 'undo', 'redo',
] as const;
export type ToolbarIcon = typeof toolbarIcons[number];

export interface ToolbarOption { value: string; label: string; disabled: boolean }

interface Pressable { id: string; label: string; icon: ToolbarIcon | null; iconOnly: boolean; keys: string | null; disabled: boolean }
export interface ToolbarButton extends Pressable { kind: 'button' }
export interface ToolbarToggle extends Pressable { kind: 'toggle'; pressed: boolean }
export interface ToolbarChoice { kind: 'choice'; id: string; label: string; hideLabel: boolean; options: ToolbarOption[]; value: string | null; disabled: boolean }
export interface ToolbarSelect { kind: 'select'; id: string; label: string; hideLabel: boolean; options: ToolbarOption[]; value: string | null; disabled: boolean }
export interface ToolbarSearch { kind: 'search'; id: string; label: string; placeholder: string | null; value: string; keys: string | null; disabled: boolean }
export interface ToolbarMenu { kind: 'menu'; id: string; label: string; icon: ToolbarIcon | null; iconOnly: boolean; disabled: boolean; items: MenuItem[] }
export interface ToolbarGroup { kind: 'group'; label: string; items: Array<ToolbarButton | ToolbarToggle> }
export interface ToolbarText { kind: 'text'; text: string; mono: boolean }
export interface ToolbarSeparator { kind: 'separator' }
export interface ToolbarSpacer { kind: 'spacer' }

export type ToolbarItem =
  | ToolbarButton | ToolbarToggle | ToolbarChoice | ToolbarSelect | ToolbarSearch | ToolbarMenu
  | ToolbarGroup | ToolbarText | ToolbarSeparator | ToolbarSpacer;

export interface MenuCommand { kind: 'item'; id: string; label: string; detail: string | null; icon: ToolbarIcon | null; keys: string | null; disabled: boolean; danger: boolean }
export interface MenuCheck { kind: 'check'; id: string; label: string; checked: boolean; keys: string | null; disabled: boolean }
export interface MenuRadio { kind: 'radio'; id: string; value: string; label: string; checked: boolean; disabled: boolean }
export interface MenuLabel { kind: 'label'; label: string }
export interface MenuSeparator { kind: 'separator' }
export type MenuItem = MenuCommand | MenuCheck | MenuRadio | MenuLabel | MenuSeparator;

/**
 * What a view declared: its controls, and which of its commands Nendo's own Add button runs
 * on its screen, if any. A toolbar with no items and no Add is no toolbar.
 */
export interface ViewToolbar { items: ToolbarItem[]; add: string | null }

/** A menu the view asked Nendo to draw at a point in its frame, in the frame's CSS pixels. */
export interface ViewMenuRequest { items: MenuItem[]; x: number; y: number }

type Params = Record<string, unknown>;

function invalid(message: string): WorkbenchHostError {
  return new WorkbenchHostError('invalid-params', message);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function object(value: unknown, where: string): Params {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${where} must be an object.`);
  return value as Params;
}

function list(value: unknown, where: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${where} must be a list of at most ${maximum}.`);
  return value;
}

function id(item: Params, where: string): string {
  const value = item.id;
  if (typeof value !== 'string' || !idPattern.test(value))
    throw invalid(`${where}.id must be 1 to 64 letters, digits and . _ : -, starting with a letter or a digit.`);
  return value;
}

function label(item: Params, where: string, key = 'label', maximum: number = extensionLimits.labelCharacters): string {
  const value = item[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum)
    throw invalid(`${where}.${key} must be text of 1 to ${maximum} characters.`);
  return value.trim();
}

function optionalLabel(item: Params, where: string, key: string, maximum: number = extensionLimits.labelCharacters): string | null {
  return item[key] === undefined || item[key] === null ? null : label(item, where, key, maximum);
}

function flag(item: Params, where: string, key: string): boolean {
  const value = item[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid(`${where}.${key} must be true or false.`);
  return value;
}

function icon(item: Params, where: string): ToolbarIcon | null {
  const value = item.icon;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(toolbarIcons as readonly string[]).includes(value))
    throw invalid(`${where}.icon must be one of Nendo's icons: ${toolbarIcons.join(', ')}.`);
  return value as ToolbarIcon;
}

/**
 * A key a control declares, normalised. Refused when it is not a key a view may declare, and
 * when it is one of Nendo's own, which a view never takes from the window.
 */
function keys(item: Params, where: string): string | null {
  const value = item.keys;
  if (value === undefined || value === null) return null;
  const parsed = parseKeys(value);
  if (parsed !== null && hostKeys.includes(parsed)) throw invalid(`${where}.keys: ${parsed} is Nendo's own key; choose another.`);
  const normalised = normalizeKeys(value);
  if (normalised === null)
    throw invalid(`${where}.keys must be a key with Ctrl or Alt, such as "Ctrl+Shift+F" or "Alt+ArrowUp", or one of F2 to F12.`);
  return normalised;
}

function optionValue(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw invalid(`${where} must be text of 1 to 128 characters.`);
  return value;
}

function options(item: Params, where: string, maximum: number): ToolbarOption[] {
  const raw = list(item.options, `${where}.options`, maximum);
  if (raw.length === 0) throw invalid(`${where}.options must hold at least one option.`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const option = object(entry, `${where}.options[${index}]`);
    const value = optionValue(option.value, `${where}.options[${index}].value`);
    if (seen.has(value)) throw invalid(`${where}.options holds ${value} twice.`);
    seen.add(value);
    return { value, label: label(option, `${where}.options[${index}]`), disabled: flag(option, `${where}.options[${index}]`, 'disabled') };
  });
}

function chosen(item: Params, where: string, choices: ToolbarOption[]): string | null {
  const value = item.value;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !choices.some((option) => option.value === value))
    throw invalid(`${where}.value must be the value of one of its options.`);
  return value;
}

function pressable(item: Params, where: string): Pressable {
  return {
    id: id(item, where), label: label(item, where), icon: icon(item, where),
    iconOnly: flag(item, where, 'iconOnly'), keys: keys(item, where), disabled: flag(item, where, 'disabled'),
  };
}

function menuItems(raw: unknown, where: string): MenuItem[] {
  return list(raw, where, extensionLimits.menuItems).map((entry, index): MenuItem => {
    const at = `${where}[${index}]`;
    const item = object(entry, at);
    switch (item.kind ?? 'item') {
      case 'item': return {
        kind: 'item', id: id(item, at), label: label(item, at), detail: optionalLabel(item, at, 'detail', extensionLimits.detailCharacters),
        icon: icon(item, at), keys: keys(item, at), disabled: flag(item, at, 'disabled'), danger: flag(item, at, 'danger'),
      };
      case 'check': return { kind: 'check', id: id(item, at), label: label(item, at), checked: flag(item, at, 'checked'), keys: keys(item, at), disabled: flag(item, at, 'disabled') };
      case 'radio': return {
        kind: 'radio', id: id(item, at), value: optionValue(item.value, `${at}.value`), label: label(item, at),
        checked: flag(item, at, 'checked'), disabled: flag(item, at, 'disabled'),
      };
      case 'label': return { kind: 'label', label: label(item, at) };
      case 'separator': return { kind: 'separator' };
      default: throw invalid(`${at}.kind must be item, check, radio, label or separator.`);
    }
  });
}

function toolbarItem(entry: unknown, where: string, inGroup: boolean): ToolbarItem {
  const item = object(entry, where);
  const kind = item.kind;
  if (inGroup && kind !== 'button' && kind !== 'toggle') throw invalid(`${where}.kind must be button or toggle: a group holds buttons.`);
  switch (kind) {
    case 'button': return { kind: 'button', ...pressable(item, where) };
    case 'toggle': return { kind: 'toggle', ...pressable(item, where), pressed: flag(item, where, 'pressed') };
    case 'choice':
    case 'select': {
      const choices = options(item, where, kind === 'choice' ? extensionLimits.choiceOptions : extensionLimits.selectOptions);
      return {
        kind, id: id(item, where), label: label(item, where), hideLabel: flag(item, where, 'hideLabel'),
        options: choices, value: chosen(item, where, choices), disabled: flag(item, where, 'disabled'),
      };
    }
    case 'search': {
      const value = item.value;
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 256)) throw invalid(`${where}.value must be text of at most 256 characters.`);
      return {
        kind: 'search', id: id(item, where), label: label(item, where), placeholder: optionalLabel(item, where, 'placeholder'),
        value: typeof value === 'string' ? value : '', keys: keys(item, where), disabled: flag(item, where, 'disabled'),
      };
    }
    case 'menu': {
      const items = menuItems(item.items, `${where}.items`);
      if (items.every((entry) => entry.kind === 'label' || entry.kind === 'separator')) throw invalid(`${where}.items must hold at least one item to pick.`);
      return {
        kind: 'menu', id: id(item, where), label: label(item, where), icon: icon(item, where),
        iconOnly: flag(item, where, 'iconOnly'), disabled: flag(item, where, 'disabled'), items,
      };
    }
    case 'group': {
      const items = list(item.items, `${where}.items`, extensionLimits.groupItems);
      if (items.length === 0) throw invalid(`${where}.items must hold at least one button.`);
      return { kind: 'group', label: label(item, where), items: items.map((child, index) => toolbarItem(child, `${where}.items[${index}]`, true) as ToolbarButton | ToolbarToggle) };
    }
    case 'text': return { kind: 'text', text: label(item, where, 'text'), mono: flag(item, where, 'mono') };
    case 'separator': return { kind: 'separator' };
    case 'spacer': return { kind: 'spacer' };
    default: throw invalid(`${where}.kind must be button, toggle, choice, select, search, menu, group, text, separator or spacer.`);
  }
}

/** Every command ID the toolbar names, with the kind that holds it, for the one-name-one-control rule. */
function commandIds(items: readonly ToolbarItem[]): Array<{ id: string; kind: string }> {
  const ids: Array<{ id: string; kind: string }> = [];
  for (const item of items) {
    if (item.kind === 'group') ids.push(...commandIds(item.items));
    else if (item.kind === 'menu') {
      ids.push({ id: item.id, kind: 'menu' });
      for (const entry of item.items) if (entry.kind === 'item' || entry.kind === 'check' || entry.kind === 'radio') ids.push({ id: entry.id, kind: entry.kind });
    } else if ('id' in item) ids.push({ id: item.id, kind: item.kind });
  }
  return ids;
}

/**
 * The toolbar a view declared, rebuilt. Refused as a whole, naming the first rule it breaks,
 * so a view never sees half of what it asked for drawn.
 */
export function readToolbar(params: Params): ViewToolbar {
  let size: number;
  try { size = utf8Length(JSON.stringify({ items: params.items ?? null, add: params.add ?? null }) ?? '', extensionLimits.toolbarBytes); }
  catch { throw invalid('The toolbar is not JSON.'); }
  if (size > extensionLimits.toolbarBytes) throw invalid(`A toolbar may take at most ${extensionLimits.toolbarBytes / 1024} KiB.`);
  const items = list(params.items ?? [], 'items', extensionLimits.toolbarItems).map((entry, index) => toolbarItem(entry, `items[${index}]`, false));
  const add = params.add === undefined || params.add === null ? null : id({ id: params.add }, 'add');
  const seen = new Map<string, string>();
  for (const { id: name, kind } of commandIds(items)) {
    const earlier = seen.get(name);
    // The items of one radio set share their command; anything else names one control.
    if (earlier !== undefined && !(earlier === 'radio' && kind === 'radio')) throw invalid(`Two controls are named ${name}; each id names one control.`);
    seen.set(name, kind);
  }
  const declared = new Set<string>();
  for (const found of declaredKeys({ items, add })) {
    if (declared.has(found.keys)) throw invalid(`Two controls declare ${found.keys}; a key runs one command.`);
    declared.add(found.keys);
  }
  return { items, add };
}

/** A menu the view asked for, rebuilt, and where it goes in the frame's own pixels. */
export function readMenu(params: Params): ViewMenuRequest {
  let size: number;
  try { size = utf8Length(JSON.stringify(params.items ?? null) ?? '', extensionLimits.toolbarBytes); }
  catch { throw invalid('The menu is not JSON.'); }
  if (size > extensionLimits.toolbarBytes) throw invalid(`A menu may take at most ${extensionLimits.toolbarBytes / 1024} KiB.`);
  const items = menuItems(params.items, 'items');
  if (!items.some((item) => item.kind === 'item' || item.kind === 'check' || item.kind === 'radio')) throw invalid('items must hold at least one item to pick.');
  const point = (key: 'x' | 'y'): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -10_000 || value > 100_000) throw invalid(`${key} must be a point in the view's own pixels.`);
    return Math.round(value);
  };
  return { items, x: point('x'), y: point('y') };
}

/**
 * What pressing a control does to it, as the view will hear it: a toggle's or a check's new
 * state, the option chosen, a radio item's value. Null for a button and a menu item.
 */
export type CommandValue = string | boolean | null;

/** A key the toolbar declares, and what it does: run a command, or put the person in the search box. */
export type KeyTarget = { keys: string; id: string; value: CommandValue; focus: boolean };

/** Every enabled control that declares a key, in the order the toolbar lists them. */
export function declaredKeys(toolbar: ViewToolbar): KeyTarget[] {
  const found: KeyTarget[] = [];
  const visit = (items: readonly ToolbarItem[]): void => {
    for (const item of items) {
      if (item.kind === 'group') visit(item.items);
      else if (item.kind === 'button' && item.keys !== null && !item.disabled) found.push({ keys: item.keys, id: item.id, value: null, focus: false });
      else if (item.kind === 'toggle' && item.keys !== null && !item.disabled) found.push({ keys: item.keys, id: item.id, value: !item.pressed, focus: false });
      else if (item.kind === 'search' && item.keys !== null && !item.disabled) found.push({ keys: item.keys, id: item.id, value: null, focus: true });
      else if (item.kind === 'menu' && !item.disabled) {
        for (const entry of item.items) {
          if (entry.kind === 'item' && entry.keys !== null && !entry.disabled) found.push({ keys: entry.keys, id: entry.id, value: null, focus: false });
          if (entry.kind === 'check' && entry.keys !== null && !entry.disabled) found.push({ keys: entry.keys, id: entry.id, value: !entry.checked, focus: false });
        }
      }
    }
  };
  visit(toolbar.items);
  return found;
}

/**
 * The toolbar as it stands once the person has pressed something, before the view answers:
 * the toggle pressed, the option chosen, the text typed. The view's next declaration decides.
 */
export function afterCommand(toolbar: ViewToolbar, commandId: string, value: CommandValue): ViewToolbar {
  const apply = (items: readonly ToolbarItem[]): ToolbarItem[] => items.map((item): ToolbarItem => {
    if (item.kind === 'group') return { ...item, items: apply(item.items) as Array<ToolbarButton | ToolbarToggle> };
    if (item.kind === 'toggle' && item.id === commandId && typeof value === 'boolean') return { ...item, pressed: value };
    if ((item.kind === 'choice' || item.kind === 'select') && item.id === commandId && typeof value === 'string' &&
        item.options.some((option) => option.value === value)) return { ...item, value };
    if (item.kind === 'search' && item.id === commandId && typeof value === 'string') return { ...item, value };
    if (item.kind === 'menu') {
      return {
        ...item,
        items: item.items.map((entry): MenuItem => {
          if (entry.kind === 'check' && entry.id === commandId && typeof value === 'boolean') return { ...entry, checked: value };
          if (entry.kind === 'radio' && entry.id === commandId && typeof value === 'string') return { ...entry, checked: entry.value === value };
          return entry;
        }),
      };
    }
    return item;
  });
  return { ...toolbar, items: apply(toolbar.items) };
}

/** One Ctrl K entry for a view's command: what it says, its key, and what it sends. */
export interface PaletteEntry { key: string; label: string; keys: string | null; id: string; value: CommandValue; focus: boolean }

/**
 * A view's commands as Ctrl K lists them, in the order the toolbar shows them. A choice or a
 * select is one entry per option not already chosen; a menu is one entry per item; a toggle
 * says which way it goes. A disabled control is left out, as the palette leaves out
 * whatever is disabled on screen.
 */
export function paletteEntries(toolbar: ViewToolbar): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const visit = (items: readonly ToolbarItem[]): void => {
    for (const item of items) {
      switch (item.kind) {
        case 'group': visit(item.items); break;
        case 'button':
          if (!item.disabled) entries.push({ key: item.id, label: item.label, keys: item.keys, id: item.id, value: null, focus: false });
          break;
        case 'toggle':
          if (!item.disabled) entries.push({ key: item.id, label: `${item.pressed ? 'Turn off' : 'Turn on'} ${item.label}`, keys: item.keys, id: item.id, value: !item.pressed, focus: false });
          break;
        case 'choice':
        case 'select':
          if (item.disabled) break;
          for (const option of item.options) {
            if (option.disabled || option.value === item.value) continue;
            entries.push({ key: `${item.id}=${option.value}`, label: `${item.label}: ${option.label}`, keys: null, id: item.id, value: option.value, focus: false });
          }
          break;
        case 'search':
          if (!item.disabled) entries.push({ key: item.id, label: item.label, keys: item.keys, id: item.id, value: null, focus: true });
          break;
        case 'menu':
          if (item.disabled) break;
          for (const entry of item.items) {
            if (entry.kind === 'item' && !entry.disabled)
              entries.push({ key: entry.id, label: `${item.label}: ${entry.label}`, keys: entry.keys, id: entry.id, value: null, focus: false });
            else if (entry.kind === 'check' && !entry.disabled)
              entries.push({ key: entry.id, label: `${item.label}: ${entry.checked ? 'Turn off' : 'Turn on'} ${entry.label}`, keys: entry.keys, id: entry.id, value: !entry.checked, focus: false });
            else if (entry.kind === 'radio' && !entry.disabled && !entry.checked)
              entries.push({ key: `${entry.id}=${entry.value}`, label: `${item.label}: ${entry.label}`, keys: null, id: entry.id, value: entry.value, focus: false });
          }
          break;
        default: break;
      }
    }
  };
  visit(toolbar.items);
  return entries;
}
