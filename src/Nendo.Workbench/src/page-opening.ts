import { icon } from './icons';

/**
 * The card a page that carries a file shows on the layer while it opens (ADR-0035): the file's
 * picture, or its tone and letter, a bar and the four steps the page goes through, each ticked with
 * the time it took. The export writes the file's name and look beside the carried file, so the card
 * shows before the runtime has started. It goes once the file's first screen is drawn.
 */
export type OpeningStep = 'unpack' | 'engine' | 'file' | 'draw';

export interface OpeningCard {
  /** Ends the step under way, with its time, and starts this one. */
  begin(step: OpeningStep): void;
  /** Takes the card away once the page shows the file, or at once when the page could not open it. */
  close(drawn: boolean): void;
}

const order: OpeningStep[] = ['unpack', 'engine', 'file', 'draw'];
/** How long the card waits for the first screen before it steps aside anyway. */
const drawLimitMs = 60_000;

export function showOpeningCard(carried: HTMLElement): OpeningCard {
  const name = (carried.dataset.name ?? 'file.nendo').replace(/\.nendo$/i, '');
  const labels: Record<OpeningStep, string> = {
    unpack: 'Unpacking Nendo',
    engine: 'Starting the engine',
    file: `Opening ${carried.dataset.name ?? 'the file'}`,
    draw: 'Drawing the first screen',
  };
  const card = document.createElement('section');
  card.className = 'page-opening';
  card.setAttribute('aria-label', `Opening ${name}`);

  const panel = document.createElement('div');
  panel.className = 'page-opening-card';
  const head = document.createElement('div');
  head.className = 'page-opening-head';
  const picture = carried.dataset.icon;
  if (picture?.startsWith('data:image/png;base64,')) {
    const image = document.createElement('img');
    image.className = 'page-opening-icon';
    image.src = picture;
    image.alt = '';
    head.append(image);
  } else {
    const tile = document.createElement('span');
    tile.className = 'page-opening-icon page-opening-tile';
    tile.dataset.tone = carried.dataset.tone ?? 'grey';
    tile.textContent = carried.dataset.letter ?? name.slice(0, 1).toUpperCase();
    tile.setAttribute('aria-hidden', 'true');
    head.append(tile);
  }
  const titles = document.createElement('div');
  titles.className = 'page-opening-titles';
  const title = document.createElement('h2');
  title.textContent = `Opening ${name}`;
  const hint = document.createElement('p');
  hint.textContent = 'Nendo starts in this page. It takes a few seconds.';
  titles.append(title, hint);
  head.append(titles);

  const bar = document.createElement('div');
  bar.className = 'page-opening-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `Opening ${name}`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(order.length));
  bar.setAttribute('aria-valuenow', '0');
  const fill = document.createElement('span');
  bar.append(fill);

  const list = document.createElement('ol');
  list.className = 'page-opening-steps';
  const rows = new Map<OpeningStep, HTMLLIElement>();
  for (const step of order) {
    const row = document.createElement('li');
    row.dataset.step = step;
    row.dataset.state = 'waiting';
    const mark = document.createElement('span');
    mark.className = 'page-opening-mark';
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = labels[step];
    const time = document.createElement('span');
    time.className = 'page-opening-time';
    row.append(mark, label, time);
    list.append(row);
    rows.set(step, row);
  }

  const note = document.createElement('p');
  note.className = 'page-opening-note';
  note.textContent = 'Everything runs in this browser. Nothing you change leaves it.';
  panel.append(head, bar, list, note);
  card.append(panel);
  (document.querySelector('.workspace-layer') ?? document.body).append(card);

  let current: OpeningStep | null = null;
  let startedAt = performance.now();
  let closed = false;
  const finish = (step: OpeningStep): void => {
    const row = rows.get(step)!;
    row.dataset.state = 'done';
    row.querySelector('.page-opening-mark')!.innerHTML = icon('check');
    row.querySelector('.page-opening-time')!.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
    const done = order.indexOf(step) + 1;
    bar.setAttribute('aria-valuenow', String(done));
    fill.style.width = `${(done / order.length) * 100}%`;
  };
  const close = (drawn: boolean): void => {
    if (closed) return;
    closed = true;
    if (drawn && current !== null) finish(current);
    card.remove();
  };
  const awaitDrawn = (): void => {
    const drawn = (): boolean => document.querySelector('[data-rail-place]') !== null;
    if (drawn()) { close(true); return; }
    const watcher = new MutationObserver(() => { if (drawn()) { watcher.disconnect(); close(true); } });
    watcher.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => { watcher.disconnect(); close(false); }, drawLimitMs);
  };

  return {
    begin(step) {
      if (closed) return;
      if (current !== null) finish(current);
      current = step;
      startedAt = performance.now();
      const row = rows.get(step)!;
      row.dataset.state = 'running';
      row.querySelector('.page-opening-mark')!.innerHTML = '<span class="busy-spinner"></span>';
      if (step === 'draw') awaitDrawn();
    },
    close,
  };
}
