// What the file says about one note besides its body: the links into and out of it, its tags and
// its tasks. Read through bounded queries, drawn as rows, shared by the workspace and the panel.
import { F } from './sync.mjs';

const where = (fieldId, value) => [{ fieldId, operator: 'eq', value }];

export async function readRelated(nendo, noteId) {
  const [backlinks, links, noteTags, tasks] = await Promise.all([
    nendo.records.queryAll({ entityId: 'gd.link', filters: where(F.link.to, noteId) }, { max: 2000 }),
    nendo.records.queryAll({ entityId: 'gd.link', filters: where(F.link.from, noteId) }, { max: 2000 }),
    nendo.records.queryAll({ entityId: 'gd.noteTag', filters: where(F.noteTag.note, noteId) }, { max: 500 }),
    nendo.records.queryAll({ entityId: 'gd.task', filters: where(F.task.note, noteId) }, { max: 1000 }),
  ]);
  // The host applies the filter; a plainer broker may not, so the rows are checked here as well.
  const only = (rows, fieldId) => rows.filter(row => row.values[fieldId] === noteId);
  return { backlinks: only(backlinks, F.link.to), links: only(links, F.link.from), noteTags: only(noteTags, F.noteTag.note), tasks: only(tasks, F.task.note) };
}

export const readTags = nendo => nendo.records.queryAll({ entityId: 'gd.tag' }, { max: 5000 });

/** A stored context line as reading text: Markdown marks dropped, a wikilink shown by its words. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\[\[([^[\]|]+?)\|([^[\]]+?)\]\]/g, '$2').replace(/\[\[([^[\]]+?)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1').replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s?)/, '');
}

/** A reference's label as the host read it, or the target's title from an index, or its ID. */
export function labelOf(record, fieldId, index) {
  const id = record.values[fieldId];
  return record.labels?.[fieldId] ?? index?.get?.(id)?.title ?? id ?? '';
}

export function row(label, onOpen, detail = null, { className = '' } = {}) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `open ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', onOpen);
  item.append(button);
  if (detail) {
    const context = document.createElement('span');
    context.className = 'context';
    context.textContent = detail;
    item.append(context);
  }
  return item;
}

export function none(text) {
  const item = document.createElement('li');
  item.className = 'none';
  item.textContent = text;
  return item;
}

/** Fills the lists a note's page shows; the links in and out only where `lists` has a place for them.
 *  `open(entityId, recordId)` is what a row does. */
export function drawRelated({ backlinks, links = [], noteTags, tasks }, lists, open, index, tagNames = null) {
  const linkRows = (rows, end, empty) => rows.length ? rows.map(link =>
    row(labelOf(link, end, index), () => open('gd.note', link.values[end]),
      [link.values[F.link.kind], plainText(link.values[F.link.context])].filter(Boolean).join(' · ')))
    : [none(empty)];
  if (lists.backlinks) {
    lists.backlinks.replaceChildren(...linkRows(backlinks, F.link.from, 'Nothing links here yet.'));
    lists.backlinksCount.textContent = backlinks.length ? String(backlinks.length) : '';
  }
  if (lists.outlinks) {
    lists.outlinks.replaceChildren(...linkRows(links, F.link.to, 'Links to nothing yet.'));
    lists.outlinksCount.textContent = links.length ? String(links.length) : '';
  }
  lists.tags.replaceChildren(...(noteTags.length ? noteTags.map(noteTag =>
    row(`#${labelOf(noteTag, F.noteTag.tag, tagNames)}`, () => open('gd.tag', noteTag.values[F.noteTag.tag]), null, { className: 'chip' }))
    : [none('No tags.')]));
  // The workspace shows a note's tasks in the strip under its title (tasks.mjs); the panel lists them here.
  if (!lists.tasks) return;
  const sorted = [...tasks].sort((a, b) => Number(a.values[F.task.done]) - Number(b.values[F.task.done]));
  lists.tasks.replaceChildren(...(sorted.length ? sorted.map(task =>
    row(plainText(task.values[F.task.title] ?? task.recordId), () => open('gd.task', task.recordId),
      [task.values[F.task.due] ? `due ${task.values[F.task.due]}` : null, task.values[F.task.source] === 'Manual' ? 'added by hand' : null].filter(Boolean).join(' · ') || null,
      { className: task.values[F.task.done] ? 'done' : '' }))
    : [none('No tasks.')]));
  const open_ = tasks.filter(task => !task.values[F.task.done]).length;
  lists.tasksCount.textContent = tasks.length ? `${open_} open of ${tasks.length}` : '';
}
