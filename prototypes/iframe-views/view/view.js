'use strict';

// One view package page. Every origin serves the same files; window.name tells frames apart.
(() => {
  const params = new URLSearchParams(location.search);
  const view = { clicks: 0, contextmenus: 0, results: [], onAct: null };
  window.view = view;

  document.getElementById('act').addEventListener('click', async () => {
    view.clicks += 1;
    if (!view.onAct) return;
    try {
      view.results.push(await view.onAct());
    } catch (e) {
      view.results.push({ error: e.name + ': ' + e.message });
    }
  });
  document.addEventListener('contextmenu', () => { view.contextmenus += 1; });

  const blob = new Blob(['iframe views spike: blob download from ' + location.origin + '\n'], { type: 'text/plain' });
  document.getElementById('dlblob').href = URL.createObjectURL(blob);

  // A modest body for the memory rows: a table of `rows` rows by five cells.
  const rows = Number(params.get('rows') || 0);
  if (rows > 0) {
    const table = document.createElement('table');
    for (let i = 0; i < rows; i++) {
      const row = table.insertRow();
      for (let j = 0; j < 5; j++) row.insertCell().textContent = 'r' + i + ' c' + j;
    }
    document.getElementById('rows').append(table);
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'ping') {
      e.source.postMessage({ type: 'pong', name: window.name, timeOrigin: performance.timeOrigin }, '*');
    }
  });
  parent.postMessage({ type: 'hello', name: window.name, href: location.href, timeOrigin: performance.timeOrigin }, '*');
})();
