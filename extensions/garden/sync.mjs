// From a note's body to the records that say the same thing: the writes one save makes.
//
// A save is one records.batch. It writes the note, plants a Seed stub for every [[wikilink]] that
// names no note yet, makes a Tag for every #tag the file has not got, and then brings the note's
// Body-sourced Links, Note tags and Tasks level with the body: a row the body no longer says is
// deleted, a row it still says is kept (a task's done state and a link's context follow the body),
// and a row somebody wrote by hand (source Manual) is never touched. Pure: it reads nothing.
//
//   plan({ note, title, body, parsed, index, existing, tags, today, newId }) -> { writes, problems, resolved, stubs, removed }
//   matchTasks(tasks, rows, { before })  -> Map from each of the body's tasks to its Checkbox row, if it has one

import { parse, slugify } from './parse.mjs';

export const F = {
  note: { title: 'gd.note.title', slug: 'gd.note.slug', body: 'gd.note.body', summary: 'gd.note.summary', kind: 'gd.note.kind',
    stage: 'gd.note.stage', date: 'gd.note.date', touched: 'gd.note.touched', pinned: 'gd.note.pinned', parent: 'gd.note.parent',
    order: 'gd.note.order' },
  link: { from: 'gd.link.from', to: 'gd.link.to', kind: 'gd.link.kind', context: 'gd.link.context', source: 'gd.link.source' },
  tag: { name: 'gd.tag.name', description: 'gd.tag.description' },
  noteTag: { note: 'gd.noteTag.note', tag: 'gd.noteTag.tag', source: 'gd.noteTag.source' },
  task: { title: 'gd.task.title', note: 'gd.task.note', done: 'gd.task.done', due: 'gd.task.due', source: 'gd.task.source', key: 'gd.task.key' },
};

/** The MCP adapter's per-value bound: a body over it could never be rewritten by an agent. */
export const BODY_BYTES = 32 * 1024;
export const BATCH_WRITES = 200;

/** The note a wikilink names: by slug, then by title, then by the slug its text would make. */
export function resolveTarget(target, index) {
  const key = String(target).trim().toLowerCase(), slug = slugify(target);
  return index.find(note => (note.slug ?? '').toLowerCase() === key)
    ?? index.find(note => (note.title ?? '').toLowerCase() === key)
    ?? index.find(note => note.slug === slug)
    ?? null;
}

export function plan({ note = null, title, body, parsed, index = [], existing = {}, tags = [], today, newId, values = {} }) {
  const problems = [];
  const writes = [];
  const bytes = new TextEncoder().encode(body ?? '').length;
  if (bytes > BODY_BYTES) problems.push(`The note is ${bytes.toLocaleString('en')} bytes; a note holds at most ${BODY_BYTES.toLocaleString('en')}, so an agent can still rewrite it.`);
  if (!String(title ?? '').trim()) problems.push('A note needs a title.');
  if (problems.length) return { writes, problems, resolved: new Map(), stubs: [] };

  // The record IDs written earlier in this batch: a reference to one needs no target version.
  const written = new Set();
  const versionOf = (record, fieldId) => written.has(record.recordId) ? {} : { [fieldId]: record.version };
  const targetVersions = pairs => {
    const versions = Object.assign({}, ...pairs.map(([record, fieldId]) => versionOf(record, fieldId)));
    return Object.keys(versions).length ? { targetVersions: versions } : {};
  };

  // 1. The note itself.
  let noteId, noteRecord;
  if (note === null) {
    noteId = newId('gd.note', slugify(title));
    const slug = freeSlug(slugify(title), index);
    // What the note was started with (a Daily note's kind and date) fills in; what was written wins.
    writes.push({ op: 'create', entityId: 'gd.note', recordId: noteId, values: {
      [F.note.kind]: 'Note', [F.note.stage]: 'Seed', [F.note.pinned]: false, [F.note.touched]: today, ...values,
      [F.note.title]: title.trim(), [F.note.slug]: slug, [F.note.body]: body,
    } });
    noteRecord = { recordId: noteId, version: 1, slug, title: title.trim() };
    written.add(noteId);
  } else {
    noteId = note.recordId;
    const changed = {};
    if ((note.values?.[F.note.body] ?? '') !== body) changed[F.note.body] = body;
    if ((note.values?.[F.note.title] ?? '') !== title.trim()) changed[F.note.title] = title.trim();
    if (!note.values?.[F.note.slug]) changed[F.note.slug] = freeSlug(slugify(title), index.filter(n => n.recordId !== noteId));
    if (note.values?.[F.note.pinned] === null || note.values?.[F.note.pinned] === undefined) changed[F.note.pinned] = false;
    noteRecord = { recordId: noteId, version: note.version, slug: note.values?.[F.note.slug], title: title.trim() };
    if (Object.keys(changed).length || note.values?.[F.note.touched] !== today) {
      changed[F.note.touched] = today;
      writes.push({ op: 'update', entityId: 'gd.note', recordId: noteId, version: note.version, values: changed });
      written.add(noteId);
    }
  }
  const others = index.filter(n => n.recordId !== noteId);

  // 2. Stubs: a wikilink to a note that is not there yet plants a Seed, so the link has somewhere to point.
  const resolved = new Map();
  const stubs = [];
  const stubBySlug = new Map();
  for (const link of parsed.links) {
    const found = resolveTarget(link.target, others) ?? (resolveTarget(link.target, [noteRecord]) ? noteRecord : null);
    if (found !== null) { resolved.set(link.target, found); continue; }
    const slug = freeSlug(slugify(link.target), [...index, ...stubs]);
    let stub = stubBySlug.get(slug);
    if (stub === undefined) {
      const title = link.label && link.label.length <= 120 && slugify(link.label) === slug ? link.label : link.target;
      stub = { recordId: newId('gd.note', slug), version: 1, slug, title };
      stubBySlug.set(slug, stub);
      stubs.push(stub);
      writes.push({ op: 'create', entityId: 'gd.note', recordId: stub.recordId, values: {
        [F.note.title]: title, [F.note.slug]: slug, [F.note.kind]: 'Note', [F.note.stage]: 'Seed', [F.note.pinned]: false, [F.note.touched]: today,
      } });
      written.add(stub.recordId);
    }
    resolved.set(link.target, stub);
  }

  // 3. Tags the file has not got. Each new one takes an ID of its own, never one made from its name
  // alone: #café and #cafe make the same slug, and a deleted tag's ID stays reserved (ADR-0023).
  const tagRecords = new Map(tags.map(tag => [String(tag.values?.[F.tag.name] ?? '').toLowerCase(), tag]));
  const tagFor = name => {
    let tag = tagRecords.get(name);
    if (tag === undefined) {
      const recordId = newId('gd.tag', name);
      tag = { recordId, version: 1, values: { [F.tag.name]: name } };
      tagRecords.set(name, tag);
      writes.push({ op: 'create', entityId: 'gd.tag', recordId, values: { [F.tag.name]: name } });
      written.add(recordId);
    }
    return tag;
  };

  // 4. Links: one Mentions link per target the body names.
  const wanted = new Map();
  for (const link of parsed.links) {
    const target = resolved.get(link.target);
    if (target.recordId === noteId || wanted.has(target.recordId)) continue;
    wanted.set(target.recordId, { target, excerpt: link.excerpt });
  }
  const bodyLinks = (existing.links ?? []).filter(row => row.values[F.link.source] === 'Body');
  for (const [targetId, { target, excerpt }] of wanted) {
    const row = bodyLinks.find(row => row.values[F.link.to] === targetId);
    if (row === undefined) {
      writes.push({ op: 'create', entityId: 'gd.link', recordId: newId('gd.link', `${noteRecord.slug}-${target.slug}`), values: {
        [F.link.from]: noteId, [F.link.to]: targetId, [F.link.kind]: 'Mentions', [F.link.context]: excerpt, [F.link.source]: 'Body',
      }, ...targetVersions([[noteRecord, F.link.from], [target, F.link.to]]) });
    } else if ((row.values[F.link.context] ?? '') !== excerpt) {
      writes.push({ op: 'update', entityId: 'gd.link', recordId: row.recordId, version: row.version, values: { [F.link.context]: excerpt } });
    }
  }
  const deletions = [];
  for (const row of bodyLinks) if (!wanted.has(row.values[F.link.to])) deletions.push({ op: 'delete', entityId: 'gd.link', recordId: row.recordId, version: row.version });

  // 5. Note tags.
  const bodyNoteTags = (existing.noteTags ?? []).filter(row => row.values[F.noteTag.source] === 'Body');
  const wantedTags = new Set();
  for (const name of parsed.tags) {
    const tag = tagFor(name);
    wantedTags.add(tag.recordId);
    if (bodyNoteTags.some(row => row.values[F.noteTag.tag] === tag.recordId)) continue;
    writes.push({ op: 'create', entityId: 'gd.noteTag', recordId: newId('gd.noteTag', `${noteRecord.slug}-${slugify(name)}`), values: {
      [F.noteTag.note]: noteId, [F.noteTag.tag]: tag.recordId, [F.noteTag.source]: 'Body',
    }, ...targetVersions([[noteRecord, F.noteTag.note], [tag, F.noteTag.tag]]) });
  }
  for (const row of bodyNoteTags) if (!wantedTags.has(row.values[F.noteTag.tag])) deletions.push({ op: 'delete', entityId: 'gd.noteTag', recordId: row.recordId, version: row.version });

  // 6. Tasks from checkboxes, each matched to its row (matchTasks), so a tick or a reworded line is an
  // update that keeps the task's record and its due date, not a new task. A row the body no longer
  // says is deleted, and named in `removed` so the view can say which went.
  const checkboxTasks = (existing.tasks ?? []).filter(row => row.values[F.task.source] === 'Checkbox');
  const matched = matchTasks(parsed.tasks, checkboxTasks, { before: note?.values?.[F.note.body] ?? '' });
  const kept = new Set();
  for (const task of parsed.tasks) {
    const row = matched.get(task);
    if (row === undefined) {
      writes.push({ op: 'create', entityId: 'gd.task', recordId: newId('gd.task', `${noteRecord.slug}-${task.key}`), values: {
        [F.task.title]: task.text, [F.task.note]: noteId, [F.task.done]: task.done, [F.task.source]: 'Checkbox', [F.task.key]: task.key,
      }, ...targetVersions([[noteRecord, F.task.note]]) });
      continue;
    }
    kept.add(row);
    const changed = {};
    if (row.values[F.task.done] !== task.done) changed[F.task.done] = task.done;
    if (row.values[F.task.title] !== task.text) changed[F.task.title] = task.text;
    if (row.values[F.task.key] !== task.key) changed[F.task.key] = task.key;
    if (Object.keys(changed).length) writes.push({ op: 'update', entityId: 'gd.task', recordId: row.recordId, version: row.version, values: changed });
  }
  const removed = [];
  for (const row of checkboxTasks) {
    if (kept.has(row)) continue;
    deletions.push({ op: 'delete', entityId: 'gd.task', recordId: row.recordId, version: row.version });
    removed.push({ recordId: row.recordId, text: String(row.values[F.task.title] ?? ''), due: row.values[F.task.due] ?? null });
  }

  writes.push(...deletions);
  if (writes.length > BATCH_WRITES) problems.push(`This save needs ${writes.length} writes and a save makes at most ${BATCH_WRITES}. Split the note.`);
  return { writes: problems.length ? [] : writes, problems, resolved, stubs, removed };
}

const words = text => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** How alike two lines' words are, from 0 to 1: twice the words they share over the words of both. */
export function likeness(a, b) {
  const x = words(a), y = words(b);
  if (x.size + y.size === 0) return 1;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return 2 * shared / (x.size + y.size);
}
export const LIKE = 0.5;

/**
 * Which Checkbox row each of the body's tasks is. A line that still says its task's words keeps its
 * row: first one in the same place (`before` is the body as saved), then one moved, in their order,
 * so of two lines that say the same, each keeps its own even when the words before them change. A
 * line whose words changed then takes the row of the task its line said before, or failing that the
 * row whose words are most like its own, at least LIKE alike. A task matched to nothing is new; a
 * row matched to nothing is gone.
 */
export function matchTasks(tasks, rows, { before = '' } = {}) {
  const matched = new Map(), used = new Set();
  const pair = (task, row) => { matched.set(task, row); used.add(row); };
  // The key of a task's words, without the -2, -3 its place among lines that say the same adds.
  const textKey = key => String(key ?? '').replace(/-\d+$/, '');
  const lineBefore = new Map(parse(before).tasks.map(task => [task.key, task.line]));
  const oldLine = row => lineBefore.get(row.values[F.task.key]) ?? Infinity;
  const free = () => rows.filter(row => !used.has(row));
  for (const task of tasks) {
    const row = free().find(row => textKey(row.values[F.task.key]) === textKey(task.key) && oldLine(row) === task.line);
    if (row !== undefined) pair(task, row);
  }
  const moved = free().sort((a, b) => (oldLine(a) - oldLine(b) || 0) || String(a.values[F.task.key]).localeCompare(String(b.values[F.task.key])));
  for (const task of tasks) {
    if (matched.has(task)) continue;
    const row = moved.find(row => !used.has(row) && textKey(row.values[F.task.key]) === textKey(task.key));
    if (row !== undefined) pair(task, row);
  }
  const left = free();
  if (left.length === 0) return matched;
  const pairs = [];
  for (const task of tasks) {
    if (matched.has(task)) continue;
    for (const row of left) {
      const like = likeness(task.text, row.values[F.task.title]);
      const inPlace = lineBefore.get(row.values[F.task.key]) === task.line;
      if (inPlace || like >= LIKE) pairs.push({ task, row, score: (inPlace ? 2 : 0) + like });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const { task, row } of pairs) if (!matched.has(task) && !used.has(row)) pair(task, row);
  return matched;
}

function freeSlug(slug, taken) {
  const slugs = new Set(taken.map(note => note.slug));
  if (!slugs.has(slug)) return slug;
  for (let n = 2; ; n++) if (!slugs.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
