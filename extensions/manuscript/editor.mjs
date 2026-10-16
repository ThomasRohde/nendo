// The continuous sheet: one Tiptap editor over the manuscript's headings and paragraphs, each
// carrying the ID of the block record it stands for. Splitting a paragraph keeps the ID on the
// part before the caret and gives the rest a new one; joining two keeps the first; turning a
// paragraph into a heading keeps its ID; pasted text arrives as new blocks, never as a second
// copy of an existing one.
import { Editor, Extension, Node, StarterKit, Placeholder, Plugin, PluginKey, Lexer } from './vendor/editor.js';
import { levelOf, kindOf, newBlockId } from './model.mjs';
import { inlineToMarkdown, markdownToInline, pictureOf, pictureMarkdown } from './inline.mjs';

const TYPES = ['paragraph', 'heading', 'picture'];
const random = () => {
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] / 256;
};
export const freshId = () => newBlockId(random);

const BlockIds = Extension.create({
  name: 'blockIds',
  addGlobalAttributes() {
    return [{
      types: TYPES,
      attributes: {
        blockId: {
          default: null,
          keepOnSplit: false,
          parseHTML: () => null,
          renderHTML: attributes => attributes.blockId ? { 'data-block': attributes.blockId } : {},
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
            if (candidate && !present.has(candidate) && !reused.has(candidate)) { next = candidate; reused.add(candidate); }
          }
          next ??= freshId();
          seen.add(next);
          tr ??= after.tr;
          tr.setNodeMarkup(offset, undefined, { ...node.attrs, blockId: next });
        });
        if (tr) tr.setMeta('addToHistory', false);
        return tr;
      },
    })];
  },
});

function nodeJSON(n) {
  const picture = levelOf(n.kind) ? null : pictureOf(n.text);
  if (picture) return { type: 'picture', attrs: { blockId: n.id, address: picture.address, alt: picture.alt } };
  const content = markdownToInline(n.text, Lexer);
  const level = levelOf(n.kind);
  return level
    ? { type: 'heading', attrs: { level, blockId: n.id }, content }
    : { type: 'paragraph', attrs: { blockId: n.id }, content };
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
            figure.replaceChildren(img);
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
 * selection is: {id, index, empty, single} for the block it starts in.
 */
export function createSheet({ element, editable, onChange, onSelect, placeholder, resolvePicture = () => null }) {
  const editor = new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false,
        codeBlock: false, horizontalRule: false, link: false, underline: false,
        // A trailing empty paragraph after a closing picture would be a new block written on open.
        trailingNode: false,
      }),
      Placeholder.configure({ placeholder: ({ node }) => node.type.name === 'heading' ? 'Heading' : placeholder, showOnlyCurrent: true }),
      pictureNode(resolvePicture),
      BlockIds,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: freshId() } }] },
    editorProps: { attributes: { class: 'sheet-text', 'aria-label': 'Manuscript', spellcheck: 'true' } },
  });
  // What each block held when it was last read or saved, by ID, as the editor holds it.
  const base = new Map();
  const remember = () => { base.clear(); editor.state.doc.forEach(node => base.set(node.attrs.blockId, signature(node))); };
  editor.on('update', ({ transaction }) => { if (transaction.docChanged) onChange?.(); });
  editor.on('selectionUpdate', () => onSelect?.(where()));
  editor.on('focus', () => onSelect?.(where()));

  function signature(node) { return `${node.type.name}:${node.attrs.level ?? ''}:${node.attrs.address ?? ''}:${node.attrs.alt ?? ''}:${JSON.stringify(node.toJSON().content ?? [])}`; }

  function where() {
    const { selection } = editor.state;
    const { $from, $to } = selection;
    if (selection.node && TYPES.includes(selection.node.type.name)) return { id: selection.node.attrs.blockId, index: $from.index(0), empty: false, single: true, pos: selection.from };
    if ($from.depth < 1) return null;
    const node = $from.node(1);
    return { id: node.attrs.blockId, index: $from.index(0), empty: selection.empty, single: $from.index(0) === $to.index(0), pos: $from.before(1) };
  }

  return {
    editor,
    /** Replaces the whole sheet with these blocks, without counting it as an edit. */
    load(nodes) {
      const content = nodes.length ? nodes.map(nodeJSON) : [{ type: 'paragraph', attrs: { blockId: freshId() } }];
      editor.commands.setContent({ type: 'doc', content }, { emitUpdate: false });
      remember();
    },
    /** The blocks the sheet shows, in reading order, each saying whether it was edited. */
    read() {
      const nodes = [];
      editor.state.doc.forEach(node => {
        const id = node.attrs.blockId;
        const text = node.type.name === 'picture' ? pictureMarkdown(node.attrs.alt, node.attrs.address) : inlineToMarkdown(node.toJSON().content ?? []);
        nodes.push({ id, kind: node.type.name === 'heading' ? kindOf(node.attrs.level) : 'Paragraph', text, changed: base.get(id) !== signature(node), signature: signature(node) });
      });
      return nodes;
    },
    /** Marks what a save wrote as what the blocks now hold. */
    saved(nodes) { for (const n of nodes) base.set(n.id, n.signature); },
    forget(id) { base.delete(id); },
    /** Gives a block a new ID, for one whose record is gone. */
    renumber(oldId) {
      let tr = null;
      editor.state.doc.forEach((node, offset) => {
        if (node.attrs.blockId !== oldId) return;
        tr ??= editor.state.tr;
        tr.setNodeMarkup(offset, undefined, { ...node.attrs, blockId: freshId() });
      });
      if (tr) { tr.setMeta('addToHistory', false); editor.view.dispatch(tr); }
    },
    where,
    /** The DOM element and document position of a block. */
    locate(id) {
      let found = null;
      editor.state.doc.forEach((node, offset) => { if (!found && node.attrs.blockId === id) found = { pos: offset, node, dom: editor.view.nodeDOM(offset) }; });
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
    /** Puts the caret at the start of a block and scrolls it into view. */
    focusBlock(id) {
      const at = this.locate(id);
      if (!at) return;
      editor.chain().focus().setTextSelection(at.pos + 1).scrollIntoView().run();
    },
    /** Makes the block the selection is in a paragraph or a heading of a container kind. */
    setStyle(kind) {
      const level = levelOf(kind);
      if (level) editor.chain().focus().setNode('heading', { level }).run();
      else editor.chain().focus().setNode('paragraph').run();
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
}
