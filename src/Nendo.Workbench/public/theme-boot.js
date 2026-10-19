// The theme, before the first paint. The module that themes the page runs only once the whole
// bundle has loaded, and until then a window in dark mode would paint its light canvas and rail.
// Loaded as a classic script from the page's own origin, so the policy's script-src 'self' allows it.
// The stored choice is this window's last one; the Desktop host's device preference, read once
// the module runs, still has the last word.
(function () {
  var preference = 'system';
  try {
    var stored = window.localStorage.getItem('nendo.appearance');
    if (stored === 'system' || stored === 'light' || stored === 'dark') preference = stored;
  } catch (error) {
    // Storage that refuses to answer leaves the page following Windows.
  }
  var dark = preference === 'dark' ||
    (preference === 'system' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme-preference', preference);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
