# Nendo brand assets

- `nendo.png` — the static application mark for repository documentation and future prototypes.
- `nendo-mark.png` — the text-free application mark for compact and centered product surfaces.
- `nendo.mp4` — the animated mark and reference that the project owner supplied.

These files are source brand artefacts. `tools/Build-NendoIcon.ps1` derives the Windows app and installer icon from the existing text-free `nendo-mark.png`. It keeps the proportions and transparency of the mark at 16, 24, 32, 48, 64, 128 and 256 pixels. The source images do not change. Store/MSIX artwork is outside the current NSIS delivery.

Do not load `nendo.mp4` at application runtime. It is a 10-second, 1280x720 brand sting with audio, an opaque near-white studio backdrop and the wordmark baked in. Thus it is suitable for documentation and reference. It is not suitable for an in-product surface, where it would conflict with the dark theme and repeat text that is already on screen.

The Workbench empty states animate the static `nendo-mark.png` in CSS instead (`brand-mark-settle` and `brand-mark-breathe` in `src/Nendo.Workbench/src/styles/07-studio.css`). The mark drops in, squashes and settles like moulded clay. Then it continues with a slow idle breath. The animation uses only transforms and opacity, and inherits the effective theme. It adds no payload. Under `prefers-reduced-motion`, it becomes a still mark. The static mark remains the default documentation and app identity asset.
