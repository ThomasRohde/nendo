# Nendo brand assets

- `nendo.png` — the static application mark for repository documentation and future prototypes.
- `nendo-mark.png` — the text-free application mark for compact and centered product surfaces.
- `nendo.mp4` — the animated mark and reference that the project owner supplied.
- `nendo-mark.svg` — a vector trace of `nendo-mark.png` for motion work. Its visible pieces match the PNG to within 3 px.

These files are source brand artefacts. `tools/Build-NendoIcon.ps1` derives the Windows app and installer icon from the existing text-free `nendo-mark.png`. It keeps the proportions and transparency of the mark at 16, 24, 32, 48, 64, 128 and 256 pixels. The source images do not change. Store/MSIX artwork is outside the current NSIS delivery.

Do not load `nendo.mp4` at application runtime. It is a 10-second, 1280x720 brand sting with audio, an opaque near-white studio backdrop and the wordmark baked in. Thus it is suitable for documentation and reference. It is not suitable for an in-product surface, where it would conflict with the dark theme and repeat text that is already on screen.

`nendo-mark.svg` exists so the mark can move in parts. It defines three paths in `<defs>`: `#nendo-arch`, `#nendo-leg` and `#nendo-tail`. Every visible layer is a `<use>` of those paths: the white sticker outline, the clay fills and the shadow the arch casts. Set a `transform` (or a new `d`) on one of the three paths, and its outline, shading and shadow follow. The leg and the tail continue as rounded shapes beneath the arch, so lifting the arch shows clay rather than a hole. The clay look is one SVG filter, `#nendo-clay`. It uses only offsets, blurs and noise, which are all in user space, so the mark shades the same at 32 px as at full size. Lighting primitives are left out on purpose, because they compute slopes per device pixel. The SVG approximates the rendered PNG and does not replace it. The icons and the static identity stay on the PNGs. The ids are fixed, so inline one copy per page, or rename the ids for a second copy.

The Workbench empty states animate the static `nendo-mark.png` in CSS instead (`brand-mark-settle` and `brand-mark-breathe` in `src/Nendo.Workbench/src/styles/07-studio.css`). The mark drops in, squashes and settles like moulded clay. Then it continues with a slow idle breath. The animation uses only transforms and opacity, and inherits the effective theme. It adds no payload. Under `prefers-reduced-motion`, it becomes a still mark. The static mark remains the default documentation and app identity asset.
