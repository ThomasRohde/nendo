# Nendo brand assets

- `nendo.png` — the static application mark for documentation.
- `nendo-mark.png` — the text-free application mark for compact and centred product surfaces.
- `nendo.mp4` — the animated mark, for reference.
- `nendo-mark.svg` — a vector trace of `nendo-mark.png` for motion work. Its visible pieces match
  the PNG to within 3 px.

These are source artefacts; the generators never change them. They draw the icons the app ships:

- `tools/Build-NendoIcon.ps1` derives the Windows app and installer icon from `nendo-mark.png`,
  keeping its proportions and transparency at 16, 24, 32, 48, 64, 128 and 256 pixels.
- `tools/Build-NendoDocumentIcon.ps1` draws `src/Nendo.Desktop/Assets/DocumentIcon.ico`, the icon
  a `.nendo` file wears in Explorer: the bare mark below 32 px, a page carrying the mark from 32 px
  up.
- `tools/Build-NendoOverlayIcons.ps1` draws `OverlayAttention.ico` and `OverlayReadOnly.ico` there,
  the badges Windows puts in the corner of the taskbar button.

`tools/Test-BinaryAssets.ps1` checks that all of them read. Store/MSIX artwork is outside the NSIS
delivery.

Do not load `nendo.mp4` at application runtime. It is a 10-second, 1280x720 brand sting with audio,
an opaque near-white backdrop and the wordmark baked in: fit for documentation, not for a product
surface, where it would clash with the dark theme and repeat text already on screen.

`nendo-mark.svg` lets the mark move in parts. It defines three paths in `<defs>`: `#nendo-arch`,
`#nendo-leg` and `#nendo-tail`. Every visible layer (the white sticker outline, the clay fills and
the shadow the arch casts) is a `<use>` of those paths, so a `transform` or a new `d` on one path
moves its outline, shading and shadow with it. The leg and the tail continue beneath the arch, so
lifting the arch shows clay rather than a hole. The clay look is one SVG filter, `#nendo-clay`,
built only from offsets, blurs and noise, which are in user space, so the mark shades the same at
32 px as at full size; lighting primitives are left out because they compute slopes per device
pixel. The SVG approximates the PNG and does not replace it: the icons and the static identity stay
on the PNGs. The ids are fixed, so inline one copy per page, or rename the ids for a second copy.

The Workbench empty states animate `nendo-mark.png` in CSS (`brand-mark-settle` and
`brand-mark-breathe` in `src/Nendo.Workbench/src/styles/07-studio.css`): the mark drops in, squashes
and settles like moulded clay, then breathes slowly. Only transforms and opacity, inheriting the
effective theme, with no added payload. Under `prefers-reduced-motion` it is a still mark.
