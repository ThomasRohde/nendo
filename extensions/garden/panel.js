// The Backlinks panel on a note's record page: what links here, with the line that does, the
// note's tags and its tasks. Each row opens its record. The panel sizes itself to its rows.
import { readRelated, readTags, drawRelated } from './related.mjs';

export async function startPanel(nendo, context, kit) {
  const panel = document.getElementById('panel');
  const status = document.getElementById('panel-status');
  const lists = {
    backlinks: document.getElementById('panel-backlinks'), backlinksCount: document.getElementById('panel-backlinks-count'),
    tags: document.getElementById('panel-tags'), tasks: document.getElementById('panel-tasks'), tasksCount: document.getElementById('panel-tasks-count'),
  };
  panel.hidden = false;
  document.body.classList.add('panel-mode');
  const open = (entityId, recordId) => nendo.ui.openRecord(entityId, recordId).catch(error => { status.textContent = error.message; });
  const keys = kit.roving(panel, { items: 'button.open' });

  let latest = 0;
  async function read() {
    const number = ++latest;
    const noteId = nendo.context.recordId;
    if (!noteId) { status.textContent = 'Save this note to see what links here.'; return; }
    let related, tags;
    try {
      [related, tags] = await Promise.all([readRelated(nendo, noteId), readTags(nendo)]);
    } catch (error) {
      status.textContent = `The links could not be read: ${error.message}`;
      return;
    }
    if (number !== latest) return;
    status.textContent = '';
    drawRelated(related, lists, open, null, new Map(tags.map(tag => [tag.recordId, { title: tag.values['gd.tag.name'] }])));
    keys.refresh();
    window.garden = { ready: true, mode: 'panel', related };
  }

  if (nendo.has('ui.setHeight')) {
    new ResizeObserver(() => {
      nendo.ui.setHeight(Math.ceil(panel.getBoundingClientRect().height) + 24).catch(() => undefined);
    }).observe(panel);
  }
  let pending = null;
  const schedule = () => { if (pending !== null) return; pending = setTimeout(() => { pending = null; read(); }, 250); };
  nendo.on('changes', schedule);
  nendo.on('context', schedule);
  await read();
}
