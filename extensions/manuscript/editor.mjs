// The continuous sheet: one Tiptap editor over the manuscript's blocks, each carrying the ID of
// the block record it stands for. Splitting a paragraph keeps the ID on the part before the
// caret and gives the rest a new one; joining two keeps the first; turning a paragraph into a
// heading keeps its ID; pasted text arrives as new blocks, never as a second copy of an
// existing one. A list item is a paragraph with a List and a Level; a table, each of its rows
// and each of its cells carry IDs of their own, as the blocks they are.
import { Editor, Extension, InputRule, Mark, Node, StarterKit, Placeholder, Plugin, PluginKey, Slice, Decoration, DecorationSet, Lexer, Table, TableRow, TableCell, TableHeader } from './vendor/editor.js';
import { numberLists } from './export.mjs';
import { levelOf, kindOf, newBlockId, LISTS, MAX_LEVEL } from './model.mjs';
import { inlineToMarkdown, markdownToInline, pictureOf, pictureMarkdown } from './inline.mjs';

// Blocks at the top of the sheet, and the blocks a table holds.
const TYPES = ['paragraph', 'heading', 'picture', 'table'];
const NESTED = ['tableRow', 'tableCell', 'tableHeader'];
const random = () => {
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] / 256;
};
export const freshId = () => newBlockId(random);

const blockId = {
  default: null,
  keepOnSplit: false,
  parseHTML: () => null,
  renderHTML: attributes => attributes.blockId ? { 'data-block': attributes.blockId } : {},
};

const BlockIds = Extension.create({
  name: 'blockIds',
  addGlobalAttributes() {
    return [{
      types: [...TYPES, ...NESTED],
      attributes: { blockId },
    }, {
      types: ['paragraph', 'heading', 'picture'],
      attributes: {
        // How the block's lines are set: the Align field's value, or null for the layout's own
        // setting. Enter carries it on, as a word processor does. Pasted text keeps a centred,
        // right or justified setting; a left one is what it would have anyway.
        align: {
          default: null,
          keepOnSplit: true,
          parseHTML: element => ALIGN_CSS[element.style?.textAlign] ?? null,
          renderHTML: attributes => attributes.align && CSS_ALIGN[attributes.align] ? { 'data-align': attributes.align, style: `text-align: ${CSS_ALIGN[attributes.align]}` } : {},
        },
        // A verse or a quotation goes on when Enter splits it.
        role: {
          default: null,
          keepOnSplit: true,
          parseHTML: element => element.getAttribute('data-role') || null,
          renderHTML: attributes => attributes.role ? { 'data-role': attributes.role } : {},
        },
      },
    }, {
      types: ['paragraph'],
      attributes: {
        // A list item, and how deep: Enter makes the next paragraph an item of the same list.
        list: {
          default: null,
          keepOnSplit: true,
          parseHTML: element => LISTS.includes(element.getAttribute('data-list')) ? element.getAttribute('data-list') : null,
          renderHTML: attributes => attributes.list ? { 'data-list': attributes.list, 'data-level': String(attributes.depth ?? 0) } : {},
        },
        // Named depth, not level: a heading's level is an attribute of the same block when it
        // turns into a paragraph, and would come along as the list's depth.
        depth: {
          default: 0,
          keepOnSplit: true,
          parseHTML: element => Math.max(0, Math.min(MAX_LEVEL, Number(element.getAttribute('data-level')) || 0)),
          renderHTML: () => ({}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('blockIds'),
      appendTransaction(transactions, before, after) {
        if (!transactions.some(t => t.docChanged)) return null;
        const present = new Map();
        after.doc.forEach(node => { const id = node.attrs.blockId; if (id) present.set(id, (present.get(id) ?? 0) + 1); });
        // Positions in the new document, mapped back to the old one, find the block a node came
        // from when a change (a heading made from a paragraph) dropped its ID.
        const back = transactions.map(t => t.mapping).reduceRight((acc, m) => { acc.appendMapping(m.invert()); return acc; }, new transactions[0].mapping.constructor());
        const seen = new Set(), reused = new Set();
        let tr = null;
        after.doc.forEach((node, offset) => {
          if (!TYPES.includes(node.type.name)) return;
          let id = node.attrs.blockId;
          if (id && !seen.has(id)) { seen.add(id); return; }
          let next = null;
          if (!id) {
            const old = before.doc.resolve(Math.min(back.map(offset + 1, -1), before.doc.content.size));
            const from = old.depth >= 1 ? old.node(1) : null;
            const candidate = from?.attrs?.blockId;
            if (candidate && !present.has(candidate) && !reused.has(candidate) && (from.type.name === 'table') === (node.type.name === 'table')) { next = candidate; reused.add(candidate); }
          }
          next ??= freshId();
          seen.add(next);
          tr ??= after.tr;
          tr.setNodeMarkup(offset, undefined, { ...node.attrs, blockId: next });
        });
        // A table's rows and cells: a new one, or a copy of another, takes a fresh ID.
        after.doc.forEach((node, offset) => {
          if (node.type.name !== 'table') return;
          node.descendants((child, pos) => {
            if (!NESTED.includes(child.type.name)) return false;
            const id = child.attrs.blockId;
            if (!id || seen.has(id)) {
              const next = freshId();
              seen.add(next);
              tr ??= after.tr;
              tr.setNodeMarkup(offset + 1 + pos, undefined, { ...child.attrs, blockId: next });
            } else seen.add(id);
            return child.type.name === 'tableRow';
          });
        });
        if (tr) tr.setMeta('addToHistory', false);
        return tr;
      },
    })];
  },
});

// The Align field's values as CSS, and back.
const CSS_ALIGN = { Left: 'left', Centre: 'center', Right: 'right', Justify: 'justify' };
const ALIGN_CSS = { center: 'Centre', right: 'Right', justify: 'Justify' };

/** Highlighted words, kept in a block's text as <mark>. */
const Highlight = Mark.create({
  name: 'highlight',
  parseHTML() { return [{ tag: 'mark' }]; },
  // Pointed at, highlighted words say what they are and how to take it off.
  renderHTML() { return ['mark', { title: 'Highlighted. Ctrl+Shift+H, or Highlight in the bar, takes it off.' }, 0]; },
  addKeyboardShortcuts() { return { 'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name) }; },
});

/** Alignment keys, as Word and Tiptap set them; they do nothing in a file without the Align field. */
function alignKeys(canAlign, setAlign) {
  return Extension.create({
    name: 'alignKeys',
    addKeyboardShortcuts() {
      const to = value => () => { if (!canAlign()) return false; setAlign(value); return true; };
      return { 'Mod-Shift-l': to('Left'), 'Mod-Shift-e': to('Centre'), 'Mod-Shift-r': to('Right'), 'Mod-Shift-j': to('Justify') };
    },
  });
}

/**
 * Lists as Word makes them: "- " or "* " starts a bulleted item and "1. " a numbered one, Tab and
 * Shift+Tab move an item in and out, Enter on an empty item moves it out and then ends the list,
 * and Backspace at an item's start makes it a paragraph again. None of it in a file without the
 * List field.
 */
function listKeys(canList, sheet) {
  return Extension.create({
    name: 'listKeys',
    addKeyboardShortcuts() {
      const item = () => {
        const { $from, empty } = this.editor.state.selection;
        if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || !$from.parent.attrs.list) return null;
        return { node: $from.parent, pos: $from.before(1), atStart: empty && $from.parentOffset === 0, empty };
      };
      const set = (it, attrs) => { this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(it.pos, undefined, { ...it.node.attrs, ...attrs })); return true; };
      const toggle = list => () => { if (!canList()) return false; sheet().setList(sheet().listHere() === list ? null : list); return true; };
      return {
        'Mod-Shift-8': toggle('Bulleted'),
        'Mod-Shift-7': toggle('Numbered'),
        Tab: () => { const it = item(); return it && canList() ? set(it, { depth: Math.min(MAX_LEVEL, (it.node.attrs.depth ?? 0) + 1) }) : false; },
        'Shift-Tab': () => { const it = item(); if (!it || !canList()) return false; return set(it, it.node.attrs.depth ? { depth: it.node.attrs.depth - 1 } : { list: null, depth: 0 }); },
        Enter: () => { const it = item(); if (!it || !it.empty || it.node.content.size) return false; return set(it, it.node.attrs.depth ? { depth: it.node.attrs.depth - 1 } : { list: null, depth: 0 }); },
        Backspace: () => { const it = item(); return it && it.atStart ? set(it, { list: null, depth: 0 }) : false; },
      };
    },
    addInputRules() {
      const rule = (find, list) => new InputRule({
        find,
        handler: ({ state, range }) => {
          const { $from } = state.selection;
          if (!canList() || $from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.attrs.list) return null;
          state.tr.delete(range.from, range.to).setNodeMarkup($from.before(1), undefined, { ...$from.parent.attrs, list, depth: 0 });
        },
      });
      return [rule(/^\s*[-*]\s$/, 'Bulleted'), rule(/^\s*1[.)]\s$/, 'Numbered')];
    },
  });
}

/**
 * A pasted list (from Word, a web page) becomes list items: each item one paragraph with its
 * list and level, since the sheet holds no nested list nodes. Other HTML is left as it is.
 */
function flattenLists(html) {
  if (!/<(ul|ol)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const flatten = (list, level) => {
    const out = [];
    for (const li of list.children) {
      if (li.tagName !== 'LI') continue;
      const nested = [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL');
      nested.forEach(n => n.remove());
      const p = doc.createElement('p');
      p.dataset.list = list.tagName === 'OL' ? 'Numbered' : 'Bulleted';
      p.dataset.level = String(Math.min(level, MAX_LEVEL));
      // An item's own paragraphs run together into the one block it is.
      const paragraphs = [...li.children].filter(c => c.tagName === 'P');
      if (paragraphs.length) paragraphs.forEach((para, i) => { if (i) p.append(doc.createElement('br')); p.append(...para.childNodes); });
      else p.append(...li.childNodes);
      out.push(p, ...nested.flatMap(n => flatten(n, level + 1)));
    }
    return out;
  };
  for (const list of [...doc.body.querySelectorAll('ul, ol')].filter(l => !l.parentElement.closest('ul, ol'))) list.replaceWith(...flatten(list, 0));
  return doc.body.innerHTML;
}

/**
 * Each list item's marker, as data-marker on its paragraph for CSS to draw: the numbers come
 * from numberLists, the rule the exports number by, so the sheet and a document always agree.
 */
const ListMarkers = Extension.create({
  name: 'listMarkers',
  addProseMirrorPlugins() {
    const markers = doc => {
      const items = [], at = [];
      doc.forEach((node, pos) => {
        const listed = node.type.name === 'paragraph' && node.attrs.list;
        items.push(listed ? { type: 'paragraph', list: node.attrs.list, listLevel: Math.min(MAX_LEVEL, node.attrs.depth ?? 0) } : { type: node.type.name });
        at.push(listed ? { pos, size: node.nodeSize } : null);
      });
      numberLists(items);
      return DecorationSet.create(doc, items.flatMap((item, i) => at[i] ? [Decoration.node(at[i].pos, at[i].pos + at[i].size, { 'data-marker': item.marker })] : []));
    };
    return [new Plugin({
      key: new PluginKey('listMarkers'),
      state: { init: (_, state) => markers(state.doc), apply: (tr, set) => tr.docChanged ? markers(tr.doc) : set },
      props: { decorations(state) { return this.getState(state); } },
    })];
  },
});

// A table cell holds paragraphs only; on the sheet its first row is the header row.
const Cell = TableCell.extend({ content: 'paragraph+' });
const HeaderCell = TableHeader.extend({ content: 'paragraph+' });

function nodeJSON(n) {
  const picture = levelOf(n.kind) ? null : pictureOf(n.text);
  const role = n.role ?? null, align = n.align ?? null;
  if (picture) return { type: 'picture', attrs: { blockId: n.id, address: picture.address, alt: picture.alt, role } };
  const content = markdownToInline(n.text, Lexer);
  const level = levelOf(n.kind);
  return level
    ? { type: 'heading', attrs: { level, blockId: n.id, role, align }, content }
    : { type: 'paragraph', attrs: { blockId: n.id, role, align, list: n.list ?? null, depth: n.list ? n.level ?? 0 : 0 }, content };
}

/** The blocks as the editor's document: a table gathers the rows and cells that follow it. */
function documentJSON(nodes) {
  const content = [];
  let table = null, row = null;
  for (const n of nodes) {
    if (n.kind === 'Table') { table = { type: 'table', attrs: { blockId: n.id }, content: [] }; row = null; content.push(table); continue; }
    if (n.kind === 'Row' && table) { row = { type: 'tableRow', attrs: { blockId: n.id }, content: [] }; table.content.push(row); continue; }
    if (n.kind === 'Cell' && row) {
      const inline = markdownToInline(n.text, Lexer);
      row.content.push({ type: table.content.length === 1 ? 'tableHeader' : 'tableCell', attrs: { blockId: n.id }, content: [inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }] });
      continue;
    }
    table = row = null;
    content.push(nodeJSON(n));
  }
  // A table needs a row and a row a cell: an empty one is given them, as new blocks.
  for (const t of content.filter(c => c.type === 'table')) {
    if (!t.content.length) t.content.push({ type: 'tableRow', content: [] });
    t.content.forEach((r, i) => { if (!r.content.length) r.content.push({ type: i === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph' }] }); });
  }
  return content.length ? content : [{ type: 'paragraph', attrs: { blockId: freshId() } }];
}

/** A cell's paragraphs as one run of inline content, a line break between each. */
function cellInline(cell) {
  const parts = [];
  cell.forEach((paragraph, _, i) => { if (i) parts.push({ type: 'hardBreak' }); parts.push(...(paragraph.toJSON().content ?? [])); });
  return parts;
}

/**
 * A block whose text is one picture. It is an atom: selected whole, deleted whole, never typed
 * into. `resolve(address)` answers where an img can load it, or null.
 */
function pictureNode(resolve) {
  return Node.create({
    name: 'picture',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        address: { default: null, parseHTML: element => element.getAttribute('data-address') },
        alt: { default: '', parseHTML: element => element.getAttribute('data-alt') ?? '' },
      };
    },
    parseHTML() { return [{ tag: 'figure[data-address]' }]; },
    renderHTML({ node }) { return ['figure', { 'data-address': node.attrs.address, 'data-alt': node.attrs.alt, class: 'picture' }]; },
    addNodeView() {
      return ({ node }) => {
        const figure = document.createElement('figure');
        figure.className = 'picture';
        figure.dataset.block = node.attrs.blockId ?? '';
        figure.contentEditable = 'false';
        const show = attrs => {
          figure.dataset.block = attrs.blockId ?? '';
          figure.replaceChildren();
          const missing = () => {
            const note = document.createElement('div');
            note.className = 'picture-missing';
            note.textContent = `Picture not found${attrs.alt ? `: ${attrs.alt}` : ''}`;
            figure.replaceChildren(note);
          };
          Promise.resolve(resolve(attrs.address)).then(url => {
            if (!url) { missing(); return; }
            const img = document.createElement('img');
            img.alt = attrs.alt ?? '';
            img.decoding = 'async';
            img.addEventListener('error', missing, { once: true });
            img.src = url;
            const caption = document.createElement('figcaption');
            caption.textContent = attrs.alt ?? '';
            figure.replaceChildren(img, caption);
          }, missing);
        };
        show(node.attrs);
        let current = node;
        return {
          dom: figure,
          update(next) {
            if (next.type.name !== 'picture') return false;
            if (next.attrs.address !== current.attrs.address || next.attrs.alt !== current.attrs.alt) show(next.attrs);
            else figure.dataset.block = next.attrs.blockId ?? '';
            current = next;
            return true;
          },
        };
      };
    },
  });
}

/**
 * Makes the sheet in `element`. `onChange` hears every edit; `onSelect` hears where the
 * selection is: {id, index, empty, single} for the block it starts in. `canAlign` and
 * `canList` say whether the file has the Align and List fields.
 */
export function createSheet({ element, editable, onChange, onSelect, placeholder, resolvePicture = () => null, canAlign = () => false, canList = () => false }) {
  let setAlign = () => {};
  let sheet = null;
  const editor = new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false,
        codeBlock: false, horizontalRule: false, link: false,
        // A trailing empty paragraph after a closing picture would be a new block written on open.
        trailingNode: false,
      }),
      // Only the sheet's own paragraphs say what to write; a cell's paragraph says nothing.
      Placeholder.configure({ placeholder: ({ node, pos }) => node.type.name === 'heading' ? 'Heading' : editor.state.doc.resolve(pos).depth ? '' : placeholder, showOnlyCurrent: true }),
      Highlight,
      alignKeys(canAlign, value => setAlign(value)),
      listKeys(canList, () => sheet),
      ListMarkers,
      Table.configure({ resizable: false, HTMLAttributes: { class: 'sheet-table' } }),
      TableRow, HeaderCell, Cell,
      pictureNode(resolvePicture),
      BlockIds,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: freshId() } }] },
    editorProps: {
      attributes: { class: 'sheet-text', 'aria-label': 'Manuscript', spellcheck: 'true' },
      transformPastedHTML: html => canList() ? flattenLists(html) : html,
      // A pasted list goes in as whole items: left open, its first item would join the paragraph
      // it lands in and take that paragraph's settings, losing its own list.
      transformPasted: slice => slice.openStart > 0 && slice.content.firstChild?.type.name === 'paragraph' && slice.content.firstChild.attrs.list
        ? new Slice(slice.content, 0, slice.openEnd) : slice,
    },
  });
  // What each block held when it was last read or saved, by ID, as the editor holds it.
  const base = new Map();
  const remember = () => { base.clear(); for (const b of blocks()) base.set(b.id, b.signature); };
  editor.on('update', ({ transaction }) => { if (transaction.docChanged) onChange?.(); });
  editor.on('selectionUpdate', () => onSelect?.(where()));
  editor.on('focus', () => onSelect?.(where()));

  function signature(node) {
    return `${node.type.name}:${node.attrs.level ?? ''}:${node.attrs.role ?? ''}:${node.attrs.align ?? ''}:${node.attrs.list ?? ''}:${node.attrs.depth ?? ''}:${node.attrs.address ?? ''}:${node.attrs.alt ?? ''}:${JSON.stringify(node.toJSON().content ?? [])}`;
  }

  /** Every block the sheet holds, in reading order: a table, then its rows, each followed by its cells. */
  function* blocks() {
    const nodes = [];
    editor.state.doc.forEach(node => nodes.push(node));
    for (const node of nodes) {
      const id = node.attrs.blockId;
      if (node.type.name === 'table') {
        yield { id, kind: 'Table', text: '', signature: 'table' };
        const rows = [];
        node.forEach(row => rows.push(row));
        for (const row of rows) {
          yield { id: row.attrs.blockId, kind: 'Row', text: '', signature: 'row' };
          const cells = [];
          row.forEach(cell => cells.push(cell));
          for (const cell of cells) {
            const inline = cellInline(cell);
            yield { id: cell.attrs.blockId, kind: 'Cell', text: inlineToMarkdown(inline), signature: `cell:${JSON.stringify(inline)}` };
          }
        }
        continue;
      }
      const text = node.type.name === 'picture' ? pictureMarkdown(node.attrs.alt, node.attrs.address) : inlineToMarkdown(node.toJSON().content ?? []);
      const list = node.type.name === 'paragraph' ? node.attrs.list ?? null : null;
      yield { id, kind: node.type.name === 'heading' ? kindOf(node.attrs.level) : 'Paragraph', text, role: node.attrs.role ?? null, align: node.attrs.align ?? null,
        list, level: list ? node.attrs.depth ?? 0 : 0, signature: signature(node) };
    }
  }

  function where() {
    const { selection } = editor.state;
    const { $from, $to } = selection;
    if (selection.node && TYPES.includes(selection.node.type.name) && $from.depth === 0) return { id: selection.node.attrs.blockId, index: $from.index(0), empty: false, single: true, pos: selection.from };
    if ($from.depth < 1) return null;
    const node = $from.node(1);
    return { id: node.attrs.blockId, index: $from.index(0), empty: selection.empty, single: $from.index(0) === $to.index(0), pos: $from.before(1) };
  }

  /** A table of `rows` by `columns` at `pos`, its first row the header, the caret in its first cell. */
  function insertTableAt(pos, rows, columns) {
    const cell = type => ({ type, content: [{ type: 'paragraph' }] });
    const table = { type: 'table', content: Array.from({ length: rows }, (_, r) => ({ type: 'tableRow', content: Array.from({ length: columns }, () => cell(r === 0 ? 'tableHeader' : 'tableCell')) })) };
    // Into the table's first cell: table, row, cell, then the cell's paragraph.
    editor.chain().focus().insertContentAt(pos, table).setTextSelection(pos + 4).run();
  }

  /** The top-level paragraphs the selection touches. */
  function paragraphsInSelection() {
    const { from, to } = editor.state.selection, found = [];
    editor.state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (parent === editor.state.doc && node.type.name === 'paragraph') found.push({ node, pos });
      return false;
    });
    return found;
  }

  sheet = {
    editor,
    /** Replaces the whole sheet with these blocks, without counting it as an edit. */
    load(nodes) {
      editor.commands.setContent({ type: 'doc', content: documentJSON(nodes) }, { emitUpdate: false });
      remember();
    },
    /** The blocks the sheet shows, in reading order, each saying whether it was edited. */
    read() {
      const nodes = [];
      for (const b of blocks()) nodes.push({ ...b, changed: base.get(b.id) !== b.signature });
      return nodes;
    },
    /** Marks what a save wrote as what the blocks now hold. */
    saved(nodes) { for (const n of nodes) base.set(n.id, n.signature); },
    forget(id) { base.delete(id); },
    /** Gives a block a new ID, for one whose record is gone. */
    renumber(oldId) {
      let tr = null;
      editor.state.doc.descendants((node, pos) => {
        if (![...TYPES, ...NESTED].includes(node.type.name)) return false;
        if (node.attrs.blockId === oldId) { tr ??= editor.state.tr; tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: freshId() }); }
        return node.type.name === 'table' || node.type.name === 'tableRow';
      });
      if (tr) { tr.setMeta('addToHistory', false); editor.view.dispatch(tr); }
    },
    where,
    /** The DOM element and document position of a block, a table's rows and cells included. */
    locate(id) {
      let found = null;
      editor.state.doc.descendants((node, pos) => {
        if (found || ![...TYPES, ...NESTED].includes(node.type.name)) return false;
        if (node.attrs.blockId === id) { found = { pos, node, dom: editor.view.nodeDOM(pos) }; return false; }
        return node.type.name === 'table' || node.type.name === 'tableRow';
      });
      return found;
    },
    /** Takes a block out of the sheet (it has moved elsewhere in the file). */
    remove(id) {
      const at = this.locate(id);
      if (!at) return;
      if (editor.state.doc.childCount === 1) {
        editor.chain().insertContentAt(at.pos + at.node.nodeSize, { type: 'paragraph', attrs: { blockId: freshId() } }).run();
      }
      const again = this.locate(id);
      editor.view.dispatch(editor.state.tr.delete(again.pos, again.pos + again.node.nodeSize));
    },
    /** Puts the caret at the start of a block, or of a cell's text, and scrolls it into view. */
    focusBlock(id) {
      const at = this.locate(id);
      if (!at) return;
      const inside = at.node.type.name === 'tableCell' || at.node.type.name === 'tableHeader' ? 2 : at.node.type.name === 'tableRow' ? 3 : at.node.type.name === 'table' ? 4 : 1;
      editor.chain().focus().setTextSelection(at.pos + inside).scrollIntoView().run();
    },
    /** Makes the block the selection is in a paragraph or a heading of a container kind. */
    setStyle(kind) {
      const level = levelOf(kind);
      if (level) editor.chain().focus().setNode('heading', { level }).run();
      else editor.chain().focus().setNode('paragraph').run();
    },
    /** Gives the block the selection is in a role, or none. */
    setRole(role) {
      const at = where();
      if (!at) return;
      const node = editor.state.doc.nodeAt(at.pos);
      if (!node || node.type.name === 'table') return;
      const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, { ...node.attrs, role: role || null });
      editor.view.dispatch(tr);
      editor.commands.focus();
    },
    roleHere() {
      const at = where();
      return at ? editor.state.doc.nodeAt(at.pos)?.attrs.role ?? '' : '';
    },
    /** Sets how the block the selection is in is aligned: Left, Centre, Right, Justify, or null for its layout's setting. */
    setAlign(align) {
      const at = where();
      const node = at ? editor.state.doc.nodeAt(at.pos) : null;
      if (!node || node.type.name === 'picture' || node.type.name === 'table') return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(at.pos, undefined, { ...node.attrs, align: align || null }));
      editor.commands.focus();
    },
    alignHere() {
      const at = where();
      return at ? editor.state.doc.nodeAt(at.pos)?.attrs.align ?? null : null;
    },
    /** Makes every paragraph the selection touches an item of a Bulleted or Numbered list, or no list. */
    setList(list) {
      const found = paragraphsInSelection();
      if (!found.length) return;
      const tr = editor.state.tr;
      for (const { node, pos } of found) tr.setNodeMarkup(pos, undefined, { ...node.attrs, list: list || null, depth: list ? node.attrs.depth ?? 0 : 0 });
      editor.view.dispatch(tr);
      editor.commands.focus();
    },
    listHere() {
      const at = where();
      const node = at ? editor.state.doc.nodeAt(at.pos) : null;
      return node?.type.name === 'paragraph' ? node.attrs.list ?? null : null;
    },
    /** Moves the list items the selection touches in (1) or out (-1); out of the outermost level ends the list. */
    indent(step) {
      const found = paragraphsInSelection().filter(f => f.node.attrs.list);
      if (!found.length) return;
      const tr = editor.state.tr;
      for (const { node, pos } of found) {
        const depth = (node.attrs.depth ?? 0) + step;
        tr.setNodeMarkup(pos, undefined, depth < 0 ? { ...node.attrs, list: null, depth: 0 } : { ...node.attrs, depth: Math.min(MAX_LEVEL, depth) });
      }
      editor.view.dispatch(tr);
      editor.commands.focus();
    },
    /** Puts a table of `rows` by `columns`, its first row the header, after the block the selection is in. */
    insertTable(rows = 3, columns = 3) {
      const at = where();
      const node = at ? editor.state.doc.nodeAt(at.pos) : null;
      if (node) insertTableAt(at.pos + node.nodeSize, rows, columns);
    },
    /**
     * Puts a new block after the block `id` and the caret in it: a Paragraph, a list item of a
     * Bulleted or Numbered list, a Part, Chapter or Section heading, or a Table.
     */
    insertAfter(id, kind) {
      const at = this.locate(id);
      if (!at || !TYPES.includes(at.node.type.name)) return;
      const after = at.pos + at.node.nodeSize;
      if (kind === 'Table') { insertTableAt(after, 3, 3); return; }
      const level = levelOf(kind);
      const block = level ? { type: 'heading', attrs: { level } } : { type: 'paragraph', attrs: { list: LISTS.includes(kind) ? kind : null, depth: 0 } };
      editor.chain().focus().insertContentAt(after, block).setTextSelection(after + 1).run();
    },
    /** Adds a row at the end of a table, or a column at its right, or deletes it, from the table as a whole. */
    tableAction(id, action) {
      const at = this.locate(id);
      if (!at || at.node.type.name !== 'table') return;
      let last = null;
      at.node.descendants((child, pos) => { if (child.type.name === 'tableCell' || child.type.name === 'tableHeader') last = at.pos + 1 + pos; return child.type.name === 'tableRow'; });
      if (last === null) return;
      editor.chain().focus().setTextSelection(last + 2)[action]().run();
    },
    inTable() {
      const { $from } = editor.state.selection;
      return $from.depth >= 1 && $from.node(1).type.name === 'table';
    },
    styleHere() {
      const { $from } = editor.state.selection;
      if ($from.depth < 1) return 'Paragraph';
      const node = $from.node(1);
      return node.type.name === 'heading' ? kindOf(node.attrs.level) : 'Paragraph';
    },
    /** Puts back a sheet kept as a draft, measured against what was last read, not as read. */
    restore(json) { editor.commands.setContent(json, { emitUpdate: false }); },
    json() { return editor.getJSON(); },
    plainText() { return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n'); },
  };
  setAlign = sheet.setAlign;
  return sheet;
}
