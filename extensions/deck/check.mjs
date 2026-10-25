// The deck check: what would trip the talk, slide by slide, and how long it runs. Pure: the view
// draws it in its Check tab, and node's tests hold it.

import { layoutOf, rows, PICTURES } from './model.mjs';

/** A speaker's pace when the notes are read as written. */
export const WORDS_PER_MINUTE = 130;
/** Words on one slide past which it reads as a page, not a slide. */
export const SLIDE_WORDS = 60;
/** The time a slide is given that has neither notes nor a rehearsal. */
export const DEFAULT_SECONDS = 30;
const PICTURE_LAYOUTS = ['Image left', 'Image right', 'Full image'];
const NO_BODY = ['Title', 'Section', 'Statement', 'Closing', 'Full image', 'Quote', 'Title only', 'Picture grid'];

/** Words in Markdown or plain text: marks, table bars and bullets are not words. */
export function wordsOf(text) {
  return String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[|#*_`>~]+/g, ' ')
    .split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w) && !/^-+$/.test(w)).length;
}
/** How long the notes take to say, in whole seconds; null for a slide without notes. */
export function spokenSeconds(notes) {
  const words = wordsOf(notes);
  return words ? Math.max(10, Math.round(words / WORDS_PER_MINUTE * 60)) : null;
}
/** Minutes and seconds, as the check and the console write them: 4:05, or 1:02:30. */
export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

const roleName = role => role === 'body2' ? 'second column' : role === 'chart' ? 'chart' : role || 'text';

/**
 * slides: the deck's slides in order; laid(slide) draws one as it is presented. minutes: the
 * talk's target length. Answers {issues: [{slideId, number, level: error|warn|info, text}],
 * shown, hidden, seconds (planned, each shown slide), total, rehearsed (slides with a time), target}.
 */
export function checkDeck(slides, { laid, minutes = null } = {}) {
  const issues = [];
  const shown = slides.filter(s => !s.hidden);
  const seconds = [];
  shown.forEach((slide, i) => {
    const number = i + 1, layout = layoutOf(slide.layout);
    const add = (level, text) => issues.push({ slideId: slide.id, number, level, text });
    const l = laid(slide);
    const over = [...new Set(l.items.filter(p => p.type === 'text' && p.overflow && !p.ghost).map(p => roleName(p.role)))];
    if (over.length) add('error', `The ${over.join(' and ')} runs over at its smallest size. Shorten it, or split the slide.`);
    if (layout.uses.includes('title') && slide.layout !== 'Quote' && !slide.title.trim()) add('warn', 'No title.');
    if (!NO_BODY.includes(slide.layout) && !slide.body.trim()) add('warn', `Nothing in the ${slide.layout === 'Table' || slide.layout === 'Chart' ? 'table' : 'body'} yet.`);
    if (slide.layout === 'Quote' && !slide.body.trim()) add('warn', 'The quote is empty.');
    if (PICTURE_LAYOUTS.includes(slide.layout) && !slide.image) add('warn', 'No picture yet.');
    if (slide.layout === 'Picture grid') {
      // The grid's places are the ones it draws; each picture's text is its caption, the first's its picture text too.
      const captions = rows(slide.body).map(r => r[0] ?? '');
      const places = l.items.filter(p => p.role === 'image' && Number.isInteger(p.slot)).map(p => p.slot);
      const empty = places.filter(i => !slide[PICTURES[i]]).map(i => i + 1);
      if (empty.length) add('warn', `No picture yet in place ${empty.join(' and ')} of the grid.`);
      const silent = places.filter(i => slide[PICTURES[i]] && !(captions[i] ?? '').trim() && !(i === 0 && slide.imageAlt.trim())).map(i => i + 1);
      if (silent.length) add('info', `Picture ${silent.join(' and ')} has no caption, which a screen reader says in its place.`);
    } else if (slide.image && !slide.imageAlt.trim()) add('info', 'The picture has no picture text, which a screen reader says in its place.');
    const words = wordsOf([slide.kicker, slide.title, slide.body, slide.body2].join('\n'));
    if (words > SLIDE_WORDS) add('warn', `${words} words on the slide. A slide reads best with fewer than ${SLIDE_WORDS}: move some to the notes.`);
    if (slide.build === 'One by one' && !l.steps) add('info', `“One by one” has nothing to bring on in the ${layout.label} layout.`);
    if (!slide.notes.trim()) add('info', 'No speaker notes.');
    seconds.push(slide.seconds ?? spokenSeconds(slide.notes) ?? DEFAULT_SECONDS);
  });
  const total = seconds.reduce((a, b) => a + b, 0);
  const target = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
  return { issues, shown: shown.length, hidden: slides.length - shown.length, seconds, total, rehearsed: shown.filter(s => s.seconds).length, target };
}

/** One line on the talk's length: the plan against the target, and what it is made of. */
export function lengthLine(result) {
  const { total, target, rehearsed, shown } = result;
  if (!shown) return 'No slide is shown.';
  const made = rehearsed === shown ? 'rehearsed' : rehearsed ? `${rehearsed} of ${shown} slides rehearsed, the rest from the notes` : 'from the notes at 130 words a minute';
  if (!target) return `About ${clock(total)} (${made}).`;
  const gap = total - target;
  const how = Math.abs(gap) < Math.max(30, target * 0.05) ? 'on target' : gap > 0 ? `${clock(gap)} over` : `${clock(-gap)} under`;
  return `About ${clock(total)} for a ${clock(target)} talk: ${how} (${made}).`;
}
