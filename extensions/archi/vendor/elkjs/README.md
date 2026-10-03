# elkjs, vendored

The Eclipse Layout Kernel compiled to JavaScript. The Archi workbench lays a view out with it
and places a generated view (W-115), through archi-online's own layout code. It runs in a Web
Worker on the view's own origin, so a large layout never stalls the view; `canvas.js` carries
elkjs's small `elk-api.js`, which starts the worker from this folder.

| File | SHA-256 |
| --- | --- |
| `elk-worker.min.js` | `458fbe927f19d11d8d054e34b7587011b9a4d1ecbdfb688b60e491fbdfb2a8d7` |
| `LICENSE.md` | `89591d4578fb1ebd91501312a3d25f021bd865a2e436641c1cf7b1bc7e3c1617` |

- **Version:** elkjs 0.11.1, the release archi-online pins, so the worker and the API in
  `canvas.js` are one release. `tools/archi/build-canvas.mjs` copies `lib/elk-worker.min.js`
  and `LICENSE.md` from archi-online's `node_modules/elkjs`, byte for byte, and prints the
  hashes above.
- **Licence:** elkjs is offered under `EPL-2.0 OR GPL-3.0-or-later`; it is used here under the
  Eclipse Public License 2.0, whose text is `LICENSE.md`. The rest of this package is under its
  own `LICENSE.txt`.
- **Source:** the source code of this object code is at <https://github.com/kieler/elkjs>
  (tag `0.11.1`), built from the Eclipse Layout Kernel at <https://github.com/eclipse-elk/elk>.

The Work dependencies view vendors its own copy, of elkjs 0.12.0; the two packages are
separate and each carries what it runs.
