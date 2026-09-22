# Nendo Workbench

Framework-free TypeScript/Vite implementation of the Nendo UI. It is a local
asset bundle for `Nendo.Desktop`, not a hosted web application.

The page talks to the host over a closed, versioned WebView message protocol.
It never receives a database path, a connection, or generic host invocation
capability — see [the architecture](../../docs/architecture.md).

## What it renders

- **Studio** — the permanent host-owned workspace: Data, Structure, Surfaces,
  History and Health. AG Grid Community backs the data table.
- **Use** — compiled custom surfaces across all three contract versions: forms,
  lists, boards, record pages, related lists, declared filters, summary tiles
  and record commands. Hand-rolled DOM; AG Grid stays in Studio.
- **Proposal review** — the read-only semantic diff and the accept gate.
- **Help** and **Agent** — offline guides and the MCP connection surface.

Studio stays reachable when a custom surface is absent, invalid or fails to
render. That is a product axiom, not a fallback.

## Commands

```powershell
npm ci
npm run check                 # tsc --noEmit
npm test                      # node --test over scripts/*.test.mjs
npm run verify:dependencies   # AG Grid Community only; no React, no Enterprise
npm run build                 # bundled into the Desktop output
npm run dev                   # local dev server on 127.0.0.1
```

`Test-Production.ps1` runs all of these, so prefer it before handing work off.

## Dependency boundary

The package intentionally contains `ag-grid-community` only. React, AG Grid
Enterprise, licence keys, CDNs and arbitrary host-object bridges are out of
scope, and `verify:dependencies` fails the build if one appears. AG Grid
calculates theme styles at runtime, so the page CSP allows inline styles while
keeping scripts and network access restricted to the bundled origin.

## Browser preview

Append `?preview=1` for browser-only visual work. That mode uses an in-memory
protocol double and labels itself **Browser preview · not saved**. It is not
storage, bridge or durability evidence — the normal browser page fails closed
unless Nendo Desktop is hosting it.
