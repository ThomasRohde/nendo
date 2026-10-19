# Nendo view kit

`nendo-view-kit.js` is what a custom view owes the person, in one versioned file: a focus ring in
the theme's colour, keyboard traversal of a list, grid or graph, a text alternative for a drawing,
fitting, and a status value's tone. The authoring guide explains it under *What a view owes the
person*.

Copy the file unchanged into a package at `kit/nendo-view-kit.js` and import it as a module. When
the kit changes, raise its version, copy it into every package that carries it, and raise those
packages' versions.

## Tests

- `kit.test.mjs` checks the version and that every `extensions/<package>/kit/nendo-view-kit.js` is
  this file byte for byte.
- `tokens.test.mjs` checks that a view stylesheet declaring the Workbench's tokens as its
  fallbacks holds the values `02-tokens.css` declares.
- `tools/Review-Gantt.ps1` runs both, then measures the Gantt's rows with the kit, and a bare
  list without and with it.

## Previewing a package

`node tools/view-kit/preview.mjs extensions/<package>` serves a package folder against Nendo's real
`api.js` and the gate lanes' fixture broker, and prints the address. It is a source test, not the
embedded host. Build the view API first: `npm --prefix src/Nendo.Workbench run build`. What a view
did inside Nendo (an uncaught error, a refused call with its code) an agent reads at
`nendo://application/extension-events`
([ADR-0032](../../docs/decisions/0032-a-views-runtime-events-reach-its-agent.md)).
