// Mermaid diagrams in a note. render.mjs leaves a closed ```mermaid fence as a figure.diagram
// holding its source as code; draw(root) turns each one into SVG with vendor/mermaid.min.js. The
// library is about 3.5 MB, so it loads the first time a page has a diagram, not with the view.
// Until a diagram is drawn its source shows as code, and one that does not parse keeps its source
// with Mermaid's message under it. Mermaid runs at its strict security level: its output passes
// through its own sanitizer, and click handlers and scripts in a diagram are not bound.
//
// The colours are the theme's tokens, read as resolved colours because Mermaid computes shades
// from them; a theme change redraws every diagram on the page. Drawings are cached by theme and
// source, so typing elsewhere in a note does not draw its diagrams again, and a diagram being
// typed is drawn once the typing pauses. Every copy on the page has IDs of its own, or an arrow
// would point at a marker in a hidden copy and not be drawn.
//
//   createDiagrams({ src }) -> { draw(root) }

const PAUSE_MS = 250;
const CACHE_LIMIT = 64;

export function createDiagrams({ src = 'vendor/mermaid.min.js' } = {}) {
  const cache = new Map();          // theme + source -> { svg } or { error }
  const roots = new Set();
  const timers = new Map();
  let loading = null, queue = Promise.resolve(), counter = 0, theme = themeKey();

  function load() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    loading ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => window.mermaid ? resolve(window.mermaid) : reject(Error('Mermaid did not start.'));
      script.onerror = () => { loading = null; reject(Error('Mermaid could not be loaded.')); };
      document.head.append(script);
    });
    return loading;
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  // Fill what the cache already holds at once; draw the rest after a pause, one at a time,
  // because Mermaid's render must not run twice at the same time.
  function draw(root) {
    if (!root) return;
    roots.add(root);
    let waiting = false;
    for (const figure of root.querySelectorAll('figure.diagram')) {
      const known = cache.get(`${theme}\n${sourceOf(figure)}`);
      if (known) fill(figure, known); else waiting = true;
    }
    clearTimeout(timers.get(root));
    if (waiting) timers.set(root, setTimeout(() => { timers.delete(root); queue = queue.then(() => drawPending(root)); }, PAUSE_MS));
  }

  async function drawPending(root) {
    if (!root.isConnected) return;
    const figures = [...root.querySelectorAll('figure.diagram')].filter(figure => figure.dataset.state !== 'drawn' || figure.dataset.theme !== theme);
    if (figures.length === 0) return;
    let mermaid;
    try { mermaid = await load(); } catch (error) {
      for (const figure of figures) fill(figure, { error: error.message });
      return;
    }
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', ...themeSettings() });
    for (const figure of figures) {
      if (!figure.isConnected) continue;
      const source = sourceOf(figure), key = `${theme}\n${source}`;
      let result = cache.get(key);
      if (!result) {
        const id = `garden-diagram-${++counter}`;
        try {
          const { svg } = await mermaid.render(id, source);
          result = { svg, id };
        } catch (error) {
          result = { error: String(error?.message ?? error).split('\n').filter(Boolean).slice(0, 4).join('\n') };
          // A failed render can leave its scratch element behind in the body.
          document.getElementById(`d${id}`)?.remove();
          document.getElementById(id)?.remove();
        }
        remember(key, result);
      }
      fill(figure, result);
    }
  }

  function fill(figure, result) {
    if (figure.dataset.theme === theme && figure.dataset.state === (result.svg ? 'drawn' : 'error')) return;
    figure.querySelector(':scope > .diagram-svg, :scope > figcaption')?.remove();
    figure.dataset.theme = theme;
    if (result.svg) {
      const holder = document.createElement('div');
      holder.className = 'diagram-svg';
      // The SVG's styles and arrowheads are addressed by its ID, and a page shows the same drawing
      // in more than one place, so each copy gets an ID of its own.
      holder.innerHTML = result.svg.replaceAll(result.id, `garden-diagram-${++counter}`);
      const svg = holder.querySelector('svg');
      if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Diagram'); }
      figure.prepend(holder);
      figure.dataset.state = 'drawn';
    } else {
      const caption = document.createElement('figcaption');
      caption.className = 'diagram-error';
      caption.textContent = `This diagram could not be drawn: ${result.error}`;
      figure.append(caption);
      figure.dataset.state = 'error';
    }
  }

  // api.js sets the theme on the root element; when its colours change, every diagram is redrawn.
  new MutationObserver(() => {
    const next = themeKey();
    if (next === theme) return;
    theme = next;
    for (const root of [...roots]) {
      if (!root.isConnected) { roots.delete(root); continue; }
      draw(root);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-nendo-theme'] });

  return { draw };
}

function sourceOf(figure) {
  return figure.querySelector('code')?.textContent ?? '';
}

// The page's own variables, resolved to colours Mermaid can compute shades from.
const COLOURS = ['--bg', '--panel', '--soft', '--ink', '--muted', '--line', '--line-strong', '--accent', '--accent-soft', '--danger'];
function resolved() {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.append(probe);
  const colours = {};
  for (const name of COLOURS) {
    probe.style.color = `var(${name})`;
    colours[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  return colours;
}

function themeKey() {
  if (!document.body) return '';
  return `${document.documentElement.dataset.nendoTheme ?? ''}|${Object.values(resolved()).join('|')}`;
}

function themeSettings() {
  const c = resolved();
  const dark = document.documentElement.dataset.nendoTheme === 'dark';
  return {
    darkMode: dark,
    fontFamily: getComputedStyle(document.documentElement).fontFamily,
    themeVariables: {
      darkMode: dark,
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      fontSize: '14px',
      background: c['--bg'],
      mainBkg: c['--accent-soft'],
      primaryColor: c['--accent-soft'],
      primaryTextColor: c['--ink'],
      primaryBorderColor: c['--accent'],
      secondaryColor: c['--soft'],
      secondaryTextColor: c['--ink'],
      secondaryBorderColor: c['--line-strong'],
      tertiaryColor: c['--panel'],
      tertiaryTextColor: c['--ink'],
      tertiaryBorderColor: c['--line-strong'],
      textColor: c['--ink'],
      lineColor: c['--muted'],
      nodeBorder: c['--accent'],
      nodeTextColor: c['--ink'],
      clusterBkg: c['--soft'],
      clusterBorder: c['--line-strong'],
      titleColor: c['--ink'],
      edgeLabelBackground: c['--bg'],
      noteBkgColor: c['--soft'],
      noteTextColor: c['--ink'],
      noteBorderColor: c['--line-strong'],
      actorBkg: c['--accent-soft'],
      actorBorder: c['--accent'],
      actorTextColor: c['--ink'],
      actorLineColor: c['--muted'],
      signalColor: c['--ink'],
      signalTextColor: c['--ink'],
      labelBoxBkgColor: c['--soft'],
      labelBoxBorderColor: c['--line-strong'],
      labelTextColor: c['--ink'],
      loopTextColor: c['--ink'],
      errorBkgColor: c['--panel'],
      errorTextColor: c['--danger'],
    },
  };
}
