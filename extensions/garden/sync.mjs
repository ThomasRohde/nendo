// From a note's body to the records that say the same thing: the writes one save makes.
//
// A save is one records.batch. It writes the note, plants a Seed stub for every [[wikilink]] that
// names no note yet, makes a Tag for every #tag the file has not got, and then brings the note's
// Body-sourced Links, Note tags and Tasks level with the body: a row the body no longer says is
// deleted, a row it still says is kept (a task's done state and a link's context follow the body),
// and a row somebody wrote by hand (source Manual) is never touched. Pure: it reads nothing.
//
//   plan({ note, title, body, parsed, index, existing, tags, today, newId }) -> { writes, problems, resolved, stubs }

import { slugify } from './parse.mjs';

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
    writes.push({ op: 'create', entityId: 'gd.note', recordId: noteId, values: {
      [F.note.title]: title.trim(), [F.note.slug]: slug, [F.note.body]: body, [F.note.kind]: 'Note', [F.note.stage]: 'Seed',
      [F.note.pinned]: false, [F.note.touched]: today, ...values,
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

  // 3. Tags the file has not got.
  const tagRecords = new Map(tags.map(tag => [String(tag.values?.[F.tag.name] ?? '').toLowerCase(), tag]));
  const tagFor = name => {
    let tag = tagRecords.get(name);
    if (tag === undefined) {
      const recordId = freeId(`gd.tag.${slugify(name)}`, tags);
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

  // 6. Tasks from checkboxes, matched by the key their text makes, so a tick is an update, not a new task.
  const checkboxTasks = (existing.tasks ?? []).filter(row => row.values[F.task.source] === 'Checkbox');
  const wantedKeys = new Set();
  for (const task of parsed.tasks) {
    wantedKeys.add(task.key);
    const row = checkboxTasks.find(row => row.values[F.task.key] === task.key);
    if (row === undefined) {
      writes.push({ op: 'create', entityId: 'gd.task', recordId: newId('gd.task', `${noteRecord.slug}-${task.key}`), values: {
        [F.task.title]: task.text, [F.task.note]: noteId, [F.task.done]: task.done, [F.task.source]: 'Checkbox', [F.task.key]: task.key,
      }, ...targetVersions([[noteRecord, F.task.note]]) });
      continue;
    }
    const changed = {};
    if (row.values[F.task.done] !== task.done) changed[F.task.done] = task.done;
    if (row.values[F.task.title] !== task.text) changed[F.task.title] = task.text;
    if (Object.keys(changed).length) writes.push({ op: 'update', entityId: 'gd.task', recordId: row.recordId, version: row.version, values: changed });
  }
  for (const row of checkboxTasks) if (!wantedKeys.has(row.values[F.task.key])) deletions.push({ op: 'delete', entityId: 'gd.task', recordId: row.recordId, version: row.version });

  writes.push(...deletions);
  if (writes.length > BATCH_WRITES) problems.push(`This save needs ${writes.length} writes and a save makes at most ${BATCH_WRITES}. Split the note.`);
  return { writes: problems.length ? [] : writes, problems, resolved, stubs };
}

function freeSlug(slug, taken) {
  const slugs = new Set(taken.map(note => note.slug));
  if (!slugs.has(slug)) return slug;
  for (let n = 2; ; n++) if (!slugs.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

function freeId(id, taken) {
  const ids = new Set(taken.map(record => record.recordId));
  if (!ids.has(id)) return id;
  for (let n = 2; ; n++) if (!ids.has(`${id}-${n}`)) return `${id}-${n}`;
}
