// What Find found, marked where the note is read and written: in the reading view and the preview
// as a CSS highlight over the rendered text, and in the editor on a layer behind the textarea, which
// cannot colour its own text. The words are Find's: every word typed, a phrase as its words, a
// left-out word not at all, and the last word also as the start of a longer one while it is typed.

const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
const WORD = /[\p{L}\p{N}]+/gu;

/** The words to mark for what was typed into Find, each with whether it may be the start of a longer word. */
export function searchTerms(text) {
  const typed = String(text ?? '');
  const tokens = [];
  for (const match of typed.matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
    if (match[2] !== undefined) tokens.push({ text: match[2], phrase: true, excluded: match[1] === '-' });
    else tokens.push({ text: match[4], phrase: false, excluded: match[3] === '-' && match[4].length > 0 });
  }
  const kept = tokens.filter(token => !token.excluded && fold(token.text).match(WORD));
  const terms = [];
  kept.forEach((token, index) => {
    const words = fold(token.text).match(WORD) ?? [];
    const open = index === kept.length - 1 && !token.phrase && !typed.endsWith(' ');
    words.forEach((word, at) => terms.push({ word, prefix: open && at === words.length - 1 }));
  });
  return terms;
}

/** Where the terms sit in a text: the start and end of each matched word, in order. */
export function textRanges(text, terms) {
  if (terms.length === 0) return [];
  const ranges = [];
  for (const match of String(text ?? '').matchAll(WORD)) {
    const word = fold(match[0]);
    if (terms.some(term => term.prefix ? word.startsWith(term.word) : word === term.word))
      ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * The marks on one note. `mark(hosts, terms)` highlights the rendered text under each host and
 * answers the first range; `markEditor(terms)` redraws the layer behind the editor. Both answer how
 * many words they marked, which the probe reads.
 */
export function createFindMarks(document, { editor, name = 'garden-find' }) {
  const window = document.defaultView;
  const supported = typeof window?.CSS?.highlights?.set === 'function' && typeof window.Highlight === 'function';
  const backdrop = document.createElement('div');
  backdrop.className = 'find-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  const layer = document.createElement('div');
  layer.className = 'find-layer';
  backdrop.append(layer);
  editor.before(backdrop);
  const follow = () => {
    layer.style.width = `${editor.clientWidth}px`;
    layer.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  };
  editor.addEventListener('scroll', follow);
  new window.ResizeObserver(follow).observe(editor);

  return {
    mark(hosts, terms) {
      const ranges = [];
      for (const host of hosts) {
        if (terms.length === 0) break;
        const walker = document.createTreeWalker(host, window.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const { start, end } of textRanges(node.data, terms)) {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            ranges.push(range);
          }
        }
      }
      if (supported) {
        if (ranges.length === 0) window.CSS.highlights.delete(name);
        else window.CSS.highlights.set(name, new window.Highlight(...ranges));
      }
      return { count: ranges.length, first: ranges[0] ?? null };
    },
    markEditor(terms, { reveal = false } = {}) {
      const text = editor.value;
      const nodes = [];
      let at = 0;
      for (const { start, end } of textRanges(text, terms)) {
        if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        nodes.push(mark);
        at = end;
      }
      // A last empty line still takes its height in the textarea, so the layer keeps it too.
      nodes.push(document.createTextNode(`${text.slice(at)}\n`));
      layer.replaceChildren(...nodes);
      follow();
      const first = layer.querySelector('mark');
      if (reveal && first !== null) {
        editor.scrollTop = Math.max(0, first.offsetTop - editor.clientHeight / 3);
        follow();
      }
      return layer.querySelectorAll('mark').length;
    },
  };
}
