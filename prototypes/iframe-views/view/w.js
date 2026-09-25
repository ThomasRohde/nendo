'use strict';

// A classic dedicated worker from the view origin; its own fetch goes through the same filter.
self.onmessage = async () => {
  const response = await fetch('/data.json', { cache: 'no-store' });
  self.postMessage({ kind: 'classic worker', origin: self.location.origin, isSecureContext: self.isSecureContext, data: await response.json() });
};
