# Nendo view kit

`nendo-view-kit.js` is what a custom view owes the person, in one versioned file a package copies
(W-064): a focus ring in the theme's colour, keyboard traversal of a list, a grid or a graph, a
text alternative for a drawing, fitting, and a status value's tone. The authoring guide explains
it under *What a view owes the person*.

Copy the file into a package unchanged, at `kit/nendo-view-kit.js`, and import it as a module.
`kit.test.mjs` checks the version and that every copy the repository carries is this file byte
for byte: it finds every `extensions/<package>/kit/nendo-view-kit.js` rather than keeping a list,
so a package that copies the kit is checked from the start. When the kit changes, raise its
version, copy it into every package that carries it, and raise those packages' versions.
`tools/Review-Gantt.ps1` runs it and measures the Gantt's rows with it, and a bare list without
it and then with it. `tokens.test.mjs` checks that a view stylesheet which says its fallbacks are
the Workbench's tokens holds the values `02-tokens.css` declares.
