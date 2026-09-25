// A module worker from the view origin that imports a module from the same origin.
import { answer } from '/mod.js';

self.postMessage({ kind: 'module worker', origin: self.location.origin, answer: answer() });
