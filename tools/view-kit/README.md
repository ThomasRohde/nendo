# Nendo view kit

`nendo-view-kit.js` is what a custom view owes the person, in one versioned file a package copies
(W-064): a focus ring in the theme's colour, keyboard traversal of a list, a grid or a graph, a
text alternative for a drawing, fitting, and a status value's tone. The authoring guide explains
it under *What a view owes the person*.

Copy the file into a package unchanged and import it as a module. `kit.test.mjs` checks the
version and that every copy the repository carries (the Gantt's `kit/nendo-view-kit.js`) is this
file byte for byte; `tools/Review-Gantt.ps1` runs it and measures the Gantt's rows with it, and a
bare list without it and then with it.
