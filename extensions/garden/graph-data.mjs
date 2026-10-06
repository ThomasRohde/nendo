// The garden as a graph: notes (and, when asked, tags) as nodes, links as edges. Pure: it takes
// records as the view reads them and answers what the drawing needs, so it is tested in Node.
//
//   buildGraph({ notes, links, tags, noteTags }, { showTags, showOrphans, focus, depth })
//     -> { nodes: [{id, type, title, stage, kind, degree}], links: [{id, source, target, type, kind, manual, count}],
//          neighbours: Map(id -> Set(id)), hidden }
//
// One edge per direction between two notes, however many link records say it; a link from a
// note to itself is left out; `focus` keeps only what lies within `depth` steps of one node,
// either way along a link, which is the local graph under a note.

const N = { title: 'gd.note.title', stage: 'gd.note.stage', kind: 'gd.note.kind' };
const L = { from: 'gd.link.from', to: 'gd.link.to', kind: 'gd.link.kind', source: 'gd.link.source' };
const T = { name: 'gd.tag.name', note: 'gd.noteTag.note', tag: 'gd.noteTag.tag' };

export function buildGraph({ notes = [], links = [], tags = [], noteTags = [] } = {}, { showTags = false, showOrphans = true, focus = null, depth = 1 } = {}) {
  const nodes = new Map();
  for (const note of notes) {
    nodes.set(note.recordId, { id: note.recordId, type: 'note', title: String(note.values[N.title] ?? note.recordId),
      stage: note.values[N.stage] ?? null, kind: note.values[N.kind] ?? null, degree: 0 });
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
    for (const tag of tags) nodes.set(tag.recordId, { id: tag.recordId, type: 'tag', title: `#${tag.values[T.name] ?? tag.recordId}`, stage: null, kind: null, degree: 0 });
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

/** A node's radius: notes grow with the square root of their links, as Obsidian draws them. */
export function radius(node) {
  if (node.type === 'tag') return 3.5;
  return 5 + Math.min(13, Math.sqrt(node.degree) * 2.6);
}
