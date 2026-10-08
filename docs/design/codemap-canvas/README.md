# Codemap canvas artboards

These are the four artboards of the Codemap design canvas
(<https://claude.ai/artifact/M4b2TTHP6EfHBoytiS9m5r>, private to the owner), copied on
2026-10-08 so that every session can read them. The owner chose all four, each as a view of
its own (D-004); [the design](../codemap.md#custom-views) says how they fit together.

| File | Direction | View |
| --- | --- | --- |
| `A-map.dc.html` | A · Treemap and inspector | Map (`cm.map`), W-189 |
| `B-links.dc.html` | B · Links and outline | Links (`cm.links`), W-190 |
| `C-tours.dc.html` | C · Atlas and tour rail | Tours (`cm.tours`), W-192 |
| `D-brief.dc.html` | D · Repository brief | Brief (`cm.brief`), W-196 |

They are reference markup, not code to ship:

- Each file is a Design Component page. The canvas's own runtime (`support.js`) renders it,
  so it does not open on its own in a browser.
- The markup and the script show the layout, the copy and the interaction.
- The `theme` property switches Light and Dark. The tokens in each file's style block are the
  Mica tokens (`../mica-direction.md`), which the views take from `--nendo-*`.
- The sample data is this repository at 7890b05. Files, lines and changes per unit are
  measured from git. The questions, answers and the tour were written for the canvas.

The canvas stays the place where the owner compares and comments. If it changes, copy the
changed artboard here again.
