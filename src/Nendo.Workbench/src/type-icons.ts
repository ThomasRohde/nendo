import { knownIcon, setIconMarkup } from './chosen-icons';
import { icon, type IconName } from './icons';

/**
 * A record type's icon, guessed from its name (G, Mica with tabs).
 *
 * Every record type drew the same box, so a file with ten of them was a column of identical
 * icons. The name usually says what a record is: its head noun -- the last word, in English --
 * is looked up in a short table of everyday nouns, and the first word that matches decides. A
 * name that matches nothing gets a box, and the person can choose an icon in Settings.
 *
 * This is a guess and only a guess. A record type that should choose its own icon needs it in
 * the file, which is not built.
 */

const table: Array<[IconName, string[]]> = [
  ['users', ['crew', 'person', 'people', 'member', 'staff', 'team', 'employee', 'user', 'contact', 'customer', 'client', 'owner', 'author', 'participant', 'stakeholder', 'astronaut', 'volunteer', 'supplier', 'vendor', 'partner']],
  ['alert', ['incident', 'issue', 'risk', 'bug', 'problem', 'alarm', 'alert', 'defect', 'fault', 'hazard', 'complaint']],
  ['wrench', ['maintenance', 'repair', 'service', 'fix', 'upkeep', 'servicing']],
  ['gauge', ['reading', 'measurement', 'metric', 'kpi', 'sample', 'observation', 'score']],
  ['cpu', ['system', 'device', 'hardware', 'machine', 'computer', 'server', 'application', 'app']],
  ['layers', ['module', 'layer', 'stack', 'level', 'section', 'segment']],
  ['rss', ['feed', 'source', 'stream', 'channel', 'subscription']],
  ['flask', ['experiment', 'test', 'trial', 'study', 'research', 'lab', 'hypothesis']],
  ['box', ['component', 'part', 'item', 'product', 'asset', 'equipment', 'inventory', 'stock', 'material', 'supply', 'package']],
  ['calendar', ['event', 'meeting', 'booking', 'appointment', 'schedule', 'shift', 'session', 'visit', 'deadline']],
  ['formSurface', ['order', 'inspection', 'check', 'audit', 'checklist', 'review', 'request', 'form', 'application']],
  ['task', ['task', 'todo', 'action', 'work', 'job', 'ticket', 'step', 'chore', 'deliverable']],
  ['document', ['document', 'note', 'report', 'page', 'article', 'log', 'file', 'entry', 'journal', 'minute', 'policy', 'contract']],
  ['lightbulb', ['proposal', 'suggestion', 'concept', 'opportunity', 'insight']],
  ['pin', ['location', 'site', 'place', 'area', 'room', 'zone', 'address', 'venue', 'station', 'region', 'country', 'city']],
  ['open', ['project', 'programme', 'program', 'portfolio', 'initiative', 'campaign', 'folder', 'collection']],
  ['tag', ['category', 'tag', 'label', 'type', 'kind', 'topic', 'theme', 'class']],
  ['link', ['dependency', 'relation', 'relationship', 'link', 'connection', 'interface']],
  ['structure', ['organisation', 'organization', 'department', 'unit', 'hierarchy', 'capability', 'process', 'org']],
  ['history', ['change', 'revision', 'version', 'release', 'milestone']],
  ['sprout', ['garden', 'plant', 'seed', 'seedling', 'sprout', 'nursery', 'crop', 'harvest']],
];

const byWord = new Map<string, IconName>();
for (const [name, words] of table) for (const word of words) if (!byWord.has(word)) byWord.set(word, name);

/** The singular of an everyday English plural, roughly: enough for a lookup, not for print. */
function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function wordsOf(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');
}

/** The icon a name suggests, or null when none of its words is in the table. */
export function typeIcon(name: string): IconName | null {
  const words = wordsOf(name);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const found = byWord.get(words[index]) ?? byWord.get(singular(words[index]));
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * The icon for a record type: the one the file chose for it (ADR-0038), else the one its name
 * suggests, else a box. Never a tile of letters.
 */
export function typeGlyph(name: string, chosen?: string | null): string {
  const known = knownIcon(chosen);
  if (known !== null) return setIconMarkup(known);
  return icon(typeIcon(name) ?? 'box');
}
