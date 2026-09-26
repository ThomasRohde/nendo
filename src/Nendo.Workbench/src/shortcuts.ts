/**
 * The window's keyboard shortcuts, and how the command palette ranks what was typed.
 *
 * No DOM here: the table says which keys do what, `matchShortcut` reads a key event, and
 * `rankCommands` orders the palette. main.ts and command-palette.ts do the wiring, and
 * scripts/shortcuts.test.mjs holds this file to its word.
 *
 * Every shortcut presses a control that is already on screen, so a key does exactly what
 * the click does -- a page holding unsaved typing refuses to be left either way.
 */

export type ShortcutId =
  | 'palette' | 'use' | 'data' | 'structure' | 'surfaces' | 'history' | 'health' | 'agent'
  | 'help' | 'back' | 'forward' | 'rail' | 'file' | 'hints';

export interface Shortcut {
  id: ShortcutId;
  /** What the person reads, e.g. "Ctrl K". */
  keys: string;
  /** The same keys in the form aria-keyshortcuts takes. */
  aria: string;
  label: string;
}

export const shortcuts: readonly Shortcut[] = [
  { id: 'palette', keys: 'Ctrl K', aria: 'Control+K', label: 'Go to or run a command' },
  { id: 'use', keys: 'Ctrl 1', aria: 'Control+1', label: 'Use' },
  { id: 'data', keys: 'Ctrl 2', aria: 'Control+2', label: 'Data' },
  { id: 'structure', keys: 'Ctrl 3', aria: 'Control+3', label: 'Structure' },
  { id: 'surfaces', keys: 'Ctrl 4', aria: 'Control+4', label: 'Surfaces' },
  { id: 'history', keys: 'Ctrl 5', aria: 'Control+5', label: 'History' },
  { id: 'health', keys: 'Ctrl 6', aria: 'Control+6', label: 'Health' },
  { id: 'agent', keys: 'Ctrl 7', aria: 'Control+7', label: 'Agent access' },
  { id: 'help', keys: 'F1', aria: 'F1', label: 'Help' },
  { id: 'back', keys: 'Alt ←', aria: 'Alt+ArrowLeft', label: 'Back' },
  { id: 'forward', keys: 'Alt →', aria: 'Alt+ArrowRight', label: 'Forward' },
  { id: 'rail', keys: 'Ctrl B', aria: 'Control+B', label: 'Fold or open the navigation' },
  { id: 'file', keys: 'Alt F', aria: 'Alt+F', label: 'File menu' },
  { id: 'hints', keys: 'Ctrl /', aria: 'Control+/', label: 'Show or hide keyboard shortcuts' },
];

export function shortcut(id: ShortcutId): Shortcut {
  return shortcuts.find((entry) => entry.id === id)!;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The shortcut a key event means, or null.
 *
 * Back and Forward are answered where they always were, in main.ts, so they are not
 * matched here; they are in the table so the palette and the hints can name them.
 * Modifiers must be exactly the ones named: Ctrl+Shift+K is somebody else's key.
 */
export function matchShortcut(event: KeyLike): ShortcutId | null {
  if (event.metaKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'k') return 'palette';
    if (key === 'b') return 'rail';
    if (key === '/') return 'hints';
    const numbered: Record<string, ShortcutId> = {
      '1': 'use', '2': 'data', '3': 'structure', '4': 'surfaces', '5': 'history', '6': 'health', '7': 'agent',
    };
    return numbered[key] ?? null;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && key === 'f') return 'file';
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && key === 'F1') return 'help';
  return null;
}

/** A command the palette can run. `run` is the click it stands for. */
export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
}

export interface RankedCommand {
  command: PaletteCommand;
  /** Indexes into the label of the characters that matched, for highlighting. */
  matched: number[];
}

/**
 * The commands that match what was typed, best first.
 *
 * Every typed character has to appear in the label, in order, ignoring case and spaces
 * in the query. A match at the start of a word beats one in the middle, and runs of
 * consecutive characters beat scattered ones; ties keep the order the commands were
 * given in, which is the order the window shows them. An empty query is every command
 * as given.
 */
export function rankCommands(query: string, commands: readonly PaletteCommand[]): RankedCommand[] {
  const wanted = query.toLowerCase().replace(/\s+/g, '');
  if (wanted.length === 0) return commands.map((command) => ({ command, matched: [] }));
  const scored: { ranked: RankedCommand; score: number; order: number }[] = [];
  commands.forEach((command, order) => {
    const hay = `${command.label}`.toLowerCase();
    const matched: number[] = [];
    let score = 0;
    let from = 0;
    for (const character of wanted) {
      const at = hay.indexOf(character, from);
      if (at === -1) return;
      const wordStart = at === 0 || /[\s·/\-(]/.test(hay[at - 1]);
      const follows = matched.length > 0 && matched[matched.length - 1] === at - 1;
      score += (wordStart ? 8 : 1) + (follows ? 4 : 0);
      matched.push(at);
      from = at + 1;
    }
    // The group counts too, a little: "file" finds every File command.
    scored.push({ ranked: { command, matched }, score, order });
  });
  for (const command of commands) {
    if (scored.some((entry) => entry.ranked.command === command)) continue;
    if (command.group.toLowerCase().replace(/\s+/g, '').startsWith(wanted))
      scored.push({ ranked: { command, matched: [] }, score: 0, order: commands.indexOf(command) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.ranked);
}

export const shortcutsStorageKey = 'nendo.shortcuts';

/** Whether the person asked to see every shortcut beside its control. Off unless they did. */
export function shortcutsShownFrom(stored: string | null): boolean {
  return stored === 'shown';
}
