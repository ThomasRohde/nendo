// The manuscript's records and the sheet the editor shows, with no DOM and no editor: the
// mapping between one declared hierarchy of blocks and a flat run of headings and
// paragraphs, the order numbers siblings keep, and the writes one save makes. Tested in Node
// (tools/manus/model.test.mjs).

export const BLOCK = 'mn.block';
export const NOTE = 'mn.note';
export const LINK = 'mn.link';
export const F = {
  text: 'mn.block.text', kind: 'mn.block.kind', parent: 'mn.block.parent', order: 'mn.block.order', role: 'mn.block.role', align: 'mn.block.align', list: 'mn.block.list', level: 'mn.block.level',
  noteBlock: 'mn.note.block', noteKind: 'mn.note.kind', noteText: 'mn.note.text', noteDone: 'mn.note.done',
  linkFrom: 'mn.link.from', linkTo: 'mn.link.to', linkKind: 'mn.link.kind', linkNote: 'mn.link.note', linkReview: 'mn.link.review',
};
export const KINDS = ['Manuscript', 'Part', 'Chapter', 'Section', 'Paragraph', 'Cuttings', 'Table', 'Row', 'Cell'];
// A table is a block that owns its rows, and a row its cells: each cell is a block whose text
// is inline Markdown, as a paragraph's is. The first row is the table's header.
export const TABLE_KINDS = ['Table', 'Row', 'Cell'];
export const NOTE_KINDS = ['Comment', 'Question', 'Task', 'Issue'];
// What a block is for, apart from its kind: the part a layout gives it. A role on a heading
// applies to everything under it; a role on a paragraph to that paragraph.
export const ROLE_GROUPS = [
  ['Front matter', ['Subtitle', 'Author', 'Dedication', 'Epigraph', 'Foreword', 'Preface', 'Acknowledgements', 'Abstract', 'Keywords']],
  ['Body', ['Quotation', 'Verse', 'Scene break', 'Caption', 'Aside']],
  ['Back matter', ['Appendix', 'Afterword', 'Glossary', 'References', 'About the author', 'Colophon']],
];
export const ROLES = ROLE_GROUPS.flatMap(([, roles]) => roles);
// How a paragraph or heading is set. A block with no value takes its layout's setting: left on
// the sheet, justified body text in a Word export.
export const ALIGNMENTS = ['Left', 'Centre', 'Right', 'Justify'];
const alignOf = value => ALIGNMENTS.includes(value) ? value : null;
// A list item is a paragraph with a List and a Level: consecutive items make a list, as Word
// keeps a list as a property of its paragraphs. Level 0 is the outermost and is stored as none.
export const LISTS = ['Bulleted', 'Numbered'];
export const MAX_LEVEL = 4;
const listOf = value => LISTS.includes(value) ? value : null;
const levelFor = (list, level) => list && Number.isInteger(level) && level > 0 ? Math.min(level, MAX_LEVEL) : null;
export const LINK_KINDS = ['Elaborates', 'Supports', 'Contradicts', 'Foreshadows', 'Resolves', 'See also'];
export const REVIEW = { current: 'Current', needsReview: 'Needs review' };
// Siblings are numbered this far apart, as Nendo numbers them (limits.hierarchy.orderGap).
export const GAP = 1024;
const LEVEL = { Part: 1, Chapter: 2, Section: 3 };

/** The heading level a container kind is drawn at, or 0 for a paragraph. */
export function levelOf(kind) { return LEVEL[kind] ?? 0; }
/** The container kind a heading level stands for. */
export function kindOf(level) { return level === 1 ? 'Part' : level === 2 ? 'Chapter' : level === 3 ? 'Section' : 'Paragraph'; }

/** Siblings in the hierarchy's order: by order number, a block without one last, then by ID. */
function bySiblingOrder(a, b) {
  const oa = a.order ?? null, ob = b.order ?? null;
  if (oa === null && ob !== null) return 1;
  if (ob === null && oa !== null) return -1;
  if (oa !== ob) return oa - ob;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every manuscript in the file, in order: each top-level block of kind Manuscript. */
export function manuscriptsOf(records) {
  return records.map(r => r.record ?? r)
    .filter(r => r.values[F.kind] === 'Manuscript' && !r.values[F.parent])
    .map(r => ({ id: r.recordId, title: r.values[F.text] ?? '', order: r.values[F.order] ?? null }))
    .sort(bySiblingOrder);
}

/**
 * Reads the file's blocks into one manuscript: its root (the one named, or the first), its
 * Cuttings, the run of blocks the sheet shows (everything under the root except the Cuttings,
 * depth first, siblings in order), every block as saved, keyed by ID, and the list of
 * manuscripts. Takes records as a flat read gives them (`records.queryAll`), so the tree is
 * built here and no hierarchy walk bounds how large a manuscript may be; items of a tree read
 * are taken too.
 */
export function readManuscript(input, rootId = null) {
  const records = input.map(x => x.record ?? x);
  const saved = new Map(), children = new Map();
  for (const r of records) {
    const v = r.values;
    const block = { id: r.recordId, kind: v[F.kind] ?? 'Paragraph', text: v[F.text] ?? '', parent: v[F.parent] ?? null,
      order: v[F.order] ?? null, role: v[F.role] ?? null, align: alignOf(v[F.align]), list: listOf(v[F.list]),
      level: levelFor(listOf(v[F.list]), v[F.level]), version: r.version, visible: false };
    saved.set(r.recordId, block);
    if (!children.has(block.parent)) children.set(block.parent, []);
    children.get(block.parent).push(block);
  }
  for (const list of children.values()) list.sort(bySiblingOrder);
  const manuscripts = manuscriptsOf(records);
  const root = rootId !== null && manuscripts.some(m => m.id === rootId) ? rootId : manuscripts[0]?.id ?? null;
  const nodes = [];
  let cuttings = null;
  // A table holds rows and a row holds cells, in that order. A row anywhere else, a cell
  // anywhere else, and any other block Studio or an agent put inside a table are read as
  // paragraphs after the table, and the next save puts them there.
  const walk = (parent, depth, parentKind, spill) => {
    if (depth > 64) return;           // the Engine refuses cycles; this keeps a damaged file from looping
    for (const block of children.get(parent) ?? []) {
      if (block.kind === 'Cuttings') { if (cuttings === null && parent === root) cuttings = block.id; continue; }
      let kind = block.kind === 'Manuscript' ? 'Paragraph' : block.kind;
      const inTable = parentKind === 'Table' || parentKind === 'Row' || parentKind === 'Cell';
      if (inTable && kind !== (parentKind === 'Table' ? 'Row' : parentKind === 'Row' ? 'Cell' : null)) { spill.push(block); continue; }
      if (!inTable && (kind === 'Row' || kind === 'Cell')) kind = 'Paragraph';
      if (!levelOf(kind) && !TABLE_KINDS.includes(kind)) kind = 'Paragraph';
      block.visible = true;
      nodes.push({ id: block.id, kind, text: block.text, role: block.role, align: block.align, list: block.list, level: block.level });
      if (kind === 'Cell') { walk(block.id, depth + 1, 'Cell', spill); continue; }
      if (kind !== 'Table' && kind !== 'Row') { walk(block.id, depth + 1, kind, spill); continue; }
      if (kind === 'Row') { walk(block.id, depth + 1, 'Row', spill); continue; }
      const later = [];
      walk(block.id, depth + 1, 'Table', later);
      for (const stray of later) {
        const strayKind = levelOf(stray.kind) ? stray.kind : 'Paragraph';
        stray.visible = true;
        nodes.push({ id: stray.id, kind: strayKind, text: stray.text, role: stray.role, align: stray.align, list: stray.list, level: stray.level });
        walk(stray.id, depth + 1, strayKind, spill);
      }
    }
  };
  if (root !== null) walk(root, 1, 'Manuscript', []);
  return { root, cuttings, title: root ? saved.get(root).text : '', nodes, saved, manuscripts };
}

/**
 * Where each block of a flat run belongs: a heading closes every heading at its level or
 * deeper and opens itself; a paragraph or a table belongs to the nearest open heading, or the
 * root; a row belongs to the table before it, and a cell to the row before it.
 */
export function deriveTree(nodes, root) {
  const parent = new Map(), children = new Map([[root, []]]);
  const stack = [{ id: root, level: 0 }];
  let table = null, row = null;
  for (const n of nodes) {
    const level = levelOf(n.kind);
    const owner = n.kind === 'Row' ? table : n.kind === 'Cell' ? row : undefined;
    if (owner !== undefined) {
      if (owner === null) throw Error(`A ${n.kind.toLowerCase()} must follow its ${n.kind === 'Row' ? 'table' : 'row'}: ${n.id}.`);
      parent.set(n.id, owner); children.get(owner).push(n.id);
      if (n.kind === 'Row') { row = n.id; children.set(n.id, []); }
      continue;
    }
    table = row = null;
    if (n.kind === 'Table') {
      const p = stack[stack.length - 1].id;
      parent.set(n.id, p); children.get(p).push(n.id); children.set(n.id, []);
      table = n.id;
      continue;
    }
    if (level === 0) {
      const p = stack[stack.length - 1].id;
      parent.set(n.id, p); children.get(p).push(n.id);
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const p = stack[stack.length - 1].id;
    parent.set(n.id, p); children.get(p).push(n.id); children.set(n.id, []);
    stack.push({ id: n.id, level });
  }
  return { parent, children };
}

/**
 * Order numbers for one run of siblings, given the numbers they already hold (null for a
 * block new to this parent). The longest run already in order keeps its numbers, so a move
 * or an insertion writes only the blocks it has to; the rest fit between their neighbours,
 * and only when no room is left is the whole run numbered again, GAP apart.
 */
export function assignOrders(existing) {
  const n = existing.length, keep = new Array(n).fill(false);
  // Longest strictly increasing subsequence of the known numbers (patience sorting).
  const tails = [], tailIndex = [], previous = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = existing[i];
    if (v === null || v === undefined || !Number.isInteger(v)) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIndex[lo] = i; previous[i] = lo > 0 ? tailIndex[lo - 1] : -1;
  }
  for (let i = tailIndex[tails.length - 1] ?? -1; i >= 0; i = previous[i]) keep[i] = true;
  const result = existing.map((v, i) => keep[i] ? v : null);
  for (let i = 0; i < n;) {
    if (result[i] !== null) { i++; continue; }
    let j = i; while (j < n && result[j] === null) j++;
    const k = j - i, left = i > 0 ? result[i - 1] : null, right = j < n ? result[j] : null;
    if (left === null && right === null) for (let x = 0; x < k; x++) result[i + x] = GAP * (x + 1);
    else if (right === null) for (let x = 0; x < k; x++) result[i + x] = left + GAP * (x + 1);
    else if (left === null) for (let x = 0; x < k; x++) result[i + x] = right - GAP * (k - x);
    else if (right - left > k) { const step = Math.floor((right - left) / (k + 1)); for (let x = 0; x < k; x++) result[i + x] = left + step * (x + 1); }
    else return existing.map((_, x) => GAP * (x + 1));
    i = j;
  }
  return result;
}

/** The text a removed block's notes and links should follow: a block that now holds its text. */
function survivorOf(removed, current) {
  const text = (removed.text ?? '').trim();
  if (text === '') return null;
  const probe = text.slice(0, 40);
  return current.find(n => n.changed && n.id !== removed.id && (n.text ?? '').includes(probe))?.id ?? null;
}

/**
 * The writes that make the saved blocks what the sheet now shows, in an order Nendo accepts:
 * creates in reading order (a heading before what it holds), then updates, then the notes and
 * links of removed blocks, then the removed blocks, the deepest first. A removed block whose
 * text now sits in another block (a merge) hands its notes and links to that block, marked for
 * review; any other removed block takes its notes and links with it. Each write names its
 * references in `refs` so the sender can pass their versions.
 * `current`: [{id, kind, text, changed}] in reading order; `changed` says the person edited it.
 */
export function planWrites({ saved, current, root, notes = [], links = [] }) {
  const { parent, children } = deriveTree(current, root);
  const order = new Map();
  for (const [p, ids] of children) {
    const known = ids.map(id => { const s = saved.get(id); return s && s.parent === p ? s.order : null; });
    assignOrders(known).forEach((o, i) => order.set(ids[i], o));
  }
  const creates = [], updates = [], attached = [], deletes = [];
  for (const n of current) {
    const s = saved.get(n.id), p = parent.get(n.id), o = order.get(n.id), text = n.text === '' ? null : n.text;
    if (!s) {
      const values = { [F.text]: text, [F.kind]: n.kind, [F.parent]: p, [F.order]: o };
      if (n.role) values[F.role] = n.role;
      if (n.align) values[F.align] = n.align;
      if (n.list) values[F.list] = n.list;
      if (levelFor(n.list, n.level)) values[F.level] = levelFor(n.list, n.level);
      creates.push({ op: 'create', entityId: BLOCK, recordId: n.id, values, refs: { [F.parent]: p } });
      continue;
    }
    const values = {}, refs = {};
    if (n.changed && (s.text ?? '') !== (n.text ?? '')) values[F.text] = text;
    if (s.kind !== n.kind) values[F.kind] = n.kind;
    if ('role' in n && (s.role ?? null) !== (n.role ?? null)) values[F.role] = n.role ?? null;
    if ('align' in n && (s.align ?? null) !== (n.align ?? null)) values[F.align] = n.align ?? null;
    if ('list' in n && (s.list ?? null) !== (n.list ?? null)) values[F.list] = n.list ?? null;
    if ('list' in n && (s.level ?? null) !== levelFor(n.list, n.level)) values[F.level] = levelFor(n.list, n.level);
    if (s.parent !== p) { values[F.parent] = p; refs[F.parent] = p; }
    if (s.order !== o) values[F.order] = o;
    if (Object.keys(values).length) updates.push({ op: 'update', entityId: BLOCK, recordId: n.id, version: s.version, values, refs });
  }
  const present = new Set(current.map(n => n.id));
  const removed = [...saved.values()].filter(s => s.visible && !present.has(s.id));
  const removedIds = new Set(removed.map(r => r.id));
  const survivor = new Map(removed.map(r => [r.id, survivorOf(r, current)]));
  for (const note of notes) {
    const on = note.values[F.noteBlock];
    if (!removedIds.has(on)) continue;
    const to = survivor.get(on);
    if (to) attached.push({ op: 'update', entityId: NOTE, recordId: note.recordId, version: note.version, values: { [F.noteBlock]: to }, refs: { [F.noteBlock]: to } });
    else attached.push({ op: 'delete', entityId: NOTE, recordId: note.recordId, version: note.version });
  }
  for (const link of links) {
    const from = link.values[F.linkFrom], to = link.values[F.linkTo];
    if (!removedIds.has(from) && !removedIds.has(to)) continue;
    const nextFrom = removedIds.has(from) ? survivor.get(from) : from, nextTo = removedIds.has(to) ? survivor.get(to) : to;
    if (!nextFrom || !nextTo || nextFrom === nextTo) { attached.push({ op: 'delete', entityId: LINK, recordId: link.recordId, version: link.version }); continue; }
    attached.push({ op: 'update', entityId: LINK, recordId: link.recordId, version: link.version,
      values: { [F.linkFrom]: nextFrom, [F.linkTo]: nextTo, [F.linkReview]: REVIEW.needsReview }, refs: { [F.linkFrom]: nextFrom, [F.linkTo]: nextTo } });
  }
  const depth = id => { let d = 0; for (let p = saved.get(id)?.parent; p && saved.has(p) && d < 64; p = saved.get(p).parent) d++; return d; };
  for (const r of removed.sort((a, b) => depth(b.id) - depth(a.id)))
    deletes.push({ op: 'delete', entityId: BLOCK, recordId: r.id, version: r.version });
  return [...creates, ...updates, ...attached, ...deletes];
}

/**
 * Cuts a plan into batches Nendo takes (at most 200 writes and 250,000 characters each) and
 * gives each write the versions of the records its references name. A reference to a record
 * written earlier in the same batch carries none, as the batch rule says; `versionOf` answers
 * the version of anything else, including a record an earlier batch wrote.
 */
export function chunkWrites(plan, { maxWrites = 200, maxChars = 240000 } = {}) {
  const batches = [];
  let batch = [], chars = 0;
  for (const write of plan) {
    const size = JSON.stringify(write.values ?? {}).length + 200;
    if (batch.length && (batch.length >= maxWrites || chars + size > maxChars)) { batches.push(batch); batch = []; chars = 0; }
    batch.push(write); chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function withTargetVersions(batch, versionOf) {
  const written = new Set();
  return batch.map(write => {
    const { refs, ...rest } = write;
    const targetVersions = {};
    for (const [field, target] of Object.entries(refs ?? {})) {
      if (target === null || written.has(target)) continue;
      const version = versionOf(target);
      if (version !== undefined && version !== null) targetVersions[field] = version;
    }
    if (write.op !== 'delete') written.add(write.recordId);
    return Object.keys(targetVersions).length ? { ...rest, targetVersions } : rest;
  });
}

/** Words in a run of text, as a writer counts them. */
export function countWords(text) {
  const words = (text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/** A fresh block ID: `b-` and twelve hex digits. */
export function newBlockId(random = () => Math.random()) {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 16).toString(16);
  return `b-${s}`;
}
