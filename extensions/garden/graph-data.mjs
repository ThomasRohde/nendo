// The garden as a graph: notes (and, when asked, tags) as nodes, links as edges. Pure: it takes
// records as the view reads them and answers what the drawing needs, so it is tested in Node.
//
//   buildGraph({ notes, links, tags, noteTags }, { showTags, showOrphans, focus, depth })
//     -> { nodes: [{id, type, title, stage, kind, branch, degree}], links: [{id, source, target, type, kind, manual, count}],
//          neighbours: Map(id -> Set(id)), hidden }
//   branchesOf(notes) -> Map(noteId -> branchId | null);  branchTones(notes) -> Map(branchId -> tone)
//
// One edge per direction between two notes, however many link records say it; a link from a
// note to itself is left out; `focus` keeps only what lies within `depth` steps of one node,
// either way along a link, which is the local graph under a note. A note's branch is the note
// just under a top-level note on its way up the tree (a section of the garden); a top-level note
// is in none. Branches take the theme's tones in the order the tree shows them.

const N = { title: 'gd.note.title', stage: 'gd.note.stage', kind: 'gd.note.kind', parent: 'gd.note.parent', order: 'gd.note.order' };
const L = { from: 'gd.link.from', to: 'gd.link.to', kind: 'gd.link.kind', source: 'gd.link.source' };
const T = { name: 'gd.tag.name', note: 'gd.noteTag.note', tag: 'gd.noteTag.tag' };

export function buildGraph({ notes = [], links = [], tags = [], noteTags = [] } = {}, { showTags = false, showOrphans = true, focus = null, depth = 1 } = {}) {
  const nodes = new Map();
  const branch = branchesOf(notes);
  for (const note of notes) {
    nodes.set(note.recordId, { id: note.recordId, type: 'note', title: String(note.values[N.title] ?? note.recordId),
      stage: note.values[N.stage] ?? null, kind: note.values[N.kind] ?? null, branch: branch.get(note.recordId) ?? null, degree: 0 });
  }
  const edges = new Map();
  let hidden = 0;
  for (const link of links) {
    const source = link.values[L.from], target = link.values[L.to];
    if (!nodes.has(source) || !nodes.has(target)) { hidden += 1; continue; }
    if (source === target) continue;
    const id = `${source}>${target}`;
    const known = edges.get(id);
    if (known) { known.count += 1; known.manual ||= link.values[L.source] === 'Manual'; continue; }
    edges.set(id, { id, source, target, type: 'link', kind: link.values[L.kind] ?? 'Mentions', manual: link.values[L.source] === 'Manual', count: 1 });
  }
  if (showTags) {
    for (const tag of tags) nodes.set(tag.recordId, { id: tag.recordId, type: 'tag', title: `#${tag.values[T.name] ?? tag.recordId}`, stage: null, kind: null, branch: null, degree: 0 });
    for (const row of noteTags) {
      const source = row.values[T.note], target = row.values[T.tag];
      if (!nodes.has(source) || !nodes.has(target)) continue;
      const id = `${source}#${target}`;
      if (!edges.has(id)) edges.set(id, { id, source, target, type: 'tag', kind: null, manual: false, count: 1 });
    }
  }
  const neighbours = new Map([...nodes.keys()].map(id => [id, new Set()]));
  for (const edge of edges.values()) {
    nodes.get(edge.source).degree += 1;
    nodes.get(edge.target).degree += 1;
    neighbours.get(edge.source).add(edge.target);
    neighbours.get(edge.target).add(edge.source);
  }

  let keep = new Set([...nodes.values()].filter(node => node.type === 'note' || node.degree > 0).map(node => node.id));
  if (!showOrphans) keep = new Set([...keep].filter(id => nodes.get(id).degree > 0 || id === focus));
  if (focus !== null && nodes.has(focus)) {
    const near = new Set([focus]);
    let frontier = [focus];
    for (let step = 0; step < depth; step += 1) {
      const next = [];
      for (const id of frontier) for (const other of neighbours.get(id)) if (!near.has(other) && keep.has(other)) { near.add(other); next.push(other); }
      frontier = next;
    }
    keep = near;
  }
  const kept = [...nodes.values()].filter(node => keep.has(node.id));
  const keptLinks = [...edges.values()].filter(edge => keep.has(edge.source) && keep.has(edge.target));
  return { nodes: kept, links: keptLinks, neighbours, hidden };
}

/** A node's radius: notes grow with the square root of their links, as Obsidian draws them, within
 *  bounds that leave the names readable in a dense garden; the local graph under a note smaller still. */
export function radius(node, { compact = false } = {}) {
  if (node.type === 'tag') return 3.5;
  return compact ? 4 + Math.min(5, Math.sqrt(node.degree) * 1.1) : 4 + Math.min(7, Math.sqrt(node.degree) * 1.4);
}

/** The tones a branch takes, in turn; grey is left for the notes in no branch. */
export const BRANCH_TONES = ['blue', 'teal', 'violet', 'orange', 'green', 'red', 'amber'];

const topLevel = (note, byId) => !note.values[N.parent] || !byId.has(note.values[N.parent]);

/** Each note's branch: the note just under a top-level note on its way up, or null for a top-level note. */
export function branchesOf(notes = []) {
  const byId = new Map(notes.map(note => [note.recordId, note]));
  const branch = new Map();
  for (const note of notes) {
    if (topLevel(note, byId)) { branch.set(note.recordId, null); continue; }
    // The host refuses a cycle and a tree deeper than 32 (ADR-0019); the guard is for a plainer broker.
    let current = note;
    for (let step = 0; step < 64; step += 1) {
      const up = byId.get(current.values[N.parent]);
      if (topLevel(up, byId)) break;
      current = up;
    }
    branch.set(note.recordId, current.recordId);
  }
  return branch;
}

/** A tone for every branch, in the order the tree shows the branches: by their top-level note, then their own order. */
export function branchTones(notes = [], branch = branchesOf(notes)) {
  const byId = new Map(notes.map(note => [note.recordId, note]));
  const order = note => Number(note?.values[N.order] ?? 0);
  const ids = [...new Set([...branch.values()].filter(Boolean))];
  const rootOf = id => byId.get(byId.get(id).values[N.parent]);
  ids.sort((a, b) => order(rootOf(a)) - order(rootOf(b)) || String(rootOf(a)?.recordId).localeCompare(String(rootOf(b)?.recordId))
    || order(byId.get(a)) - order(byId.get(b)) || a.localeCompare(b));
  return new Map(ids.map((id, index) => [id, BRANCH_TONES[index % BRANCH_TONES.length]]));
}
