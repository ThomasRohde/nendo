# Nendo Workbench

Framework-free TypeScript/Vite implementation of the Nendo UI: a local asset bundle for
`Nendo.Desktop`, not a hosted web application. The page talks to the host over a closed,
versioned WebView message protocol and never receives a database path, a connection or generic
host invocation ([architecture](../../docs/architecture.md)).

## What it renders

- **Studio**: the permanent host-owned workspace (Data, Structure, Surfaces, History, Health).
  AG Grid Community backs its grids.
- **Use**: compiled custom surfaces (forms, lists, boards, record pages, related lists, filters,
  summary tiles, record commands) in hand-rolled DOM, and custom views in their own frames.
- **Proposal review**: the read-only semantic diff and the accept gate.
- **Help** and **Agent**: offline guides and the MCP connection surface.

Studio stays reachable when a custom surface is absent, invalid or fails to render. That is a
product axiom, not a fallback.

## Commands

```powershell
npm ci
npm run check                 # tsc --noEmit
npm test                      # node --test over scripts/*.test.mjs
npm run verify:dependencies   # the production dependency boundary
npm run build                 # bundled into the Desktop output, plus the view API
npm run dev                   # local dev server on 127.0.0.1
```

`Test-Production.ps1` runs all of these.

## Dependency boundary

Production dependencies are exactly AG Grid Community (Studio's grids,
[ADR-0015](../../docs/decisions/0015-host-owned-database-studio-and-ag-grid-community.md)) and
the Markdown field's editor: Tiptap and `marked`
([ADR-0017](../../docs/decisions/0017-production-composition-and-build-layout.md)). React, AG Grid
Enterprise, licence keys, CDNs and host-object bridges are out of scope.

- `verify:dependencies` requires that exact list, each pinned to one version; refuses a lockfile
  holding AG Grid Enterprise, React or React DOM; and requires the notices the build writes to
  `dist/THIRD-PARTY-NOTICES.txt` (`scripts/third-party-notices.mjs`) to carry every production
  licence, Lucide's and Nendo's. It reads no built `dist/`; the installer lanes check the payload.
  It does not look for licence keys, CDN URLs or host-object bridges.
- `scripts/csp.test.mjs` pins the page's content-security policy, so a CDN script, stylesheet or
  fetch is refused at runtime. It does not scan the source for URLs.
- Host objects are switched off by the Desktop host's WebView2 settings; no test here covers that.

AG Grid computes theme styles at runtime, so the CSP allows inline styles while scripts and
network access stay restricted to the bundled origin.

## Browser preview

Append `?preview=1` for browser-only visual work. It answers the same protocol from in-memory
fixtures in the tab (`src/host-preview.ts`) and reaches no file, so it is not storage, bridge or
durability evidence. Without it the page fails closed unless Nendo Desktop hosts it.
