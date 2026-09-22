# Nendo brand assets

- `nendo.png` — static application mark used by repository documentation and future prototypes.
- `nendo-mark.png` — text-free application mark for compact and centered product surfaces.
- `nendo.mp4` — animated mark/reference supplied by the project owner.

These files are source brand artefacts. `tools/Build-NendoIcon.ps1` derives the Windows app and installer icon from the existing text-free `nendo-mark.png`, preserving its proportions and transparency at 16, 24, 32, 48, 64, 128 and 256 pixels. The source images remain unchanged; Store/MSIX artwork is outside the current NSIS delivery.

Do not load `nendo.mp4` at application runtime. It is a 10-second, 1280x720 brand sting with audio, an opaque near-white studio backdrop and the wordmark baked in, so it suits documentation and reference rather than an in-product surface where it would fight the dark theme and repeat text already on screen.

The Workbench empty states instead animate the static `nendo-mark.png` in CSS (`brand-mark-settle` and `brand-mark-breathe` in `src/Nendo.Workbench/src/styles.css`): the mark drops in, squashes and settles like moulded clay, then keeps a slow idle breath. It is transform-only, inherits the effective theme, adds no payload, and collapses to a still mark under `prefers-reduced-motion`. The static mark remains the default documentation and app identity asset.
