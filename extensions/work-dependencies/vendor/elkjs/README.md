# elkjs, vendored

The Eclipse Layout Kernel compiled to JavaScript, used unchanged by the work-dependencies
view to lay its graph out. It runs in a Web Worker on the view's own origin, so a large
layout never stalls the view.

| File | SHA-256 |
| --- | --- |
| `elk-api.js` | `ccca46175c05bbd280b5de6c9853103711e52c666a101f145b717e345363e24d` |
| `elk-worker.min.js` | `e4f5c51c6f2fd564bb64e52e81c4a85a316ef2f24f8b90e1db5eb886c765b030` |
| `LICENSE.md` | `637e81f4a1b6b4079535c499fca05e238cf7605c1ff5b76d60d7da7ce96700c9` |

- **Version:** elkjs 0.12.0, from the npm registry (`npm pack elkjs@0.12.0`), files
  `lib/elk-api.js`, `lib/elk-worker.min.js` and `LICENSE.md`, byte for byte.
- **Licence:** elkjs is offered under `EPL-2.0 OR GPL-3.0-or-later`; it is used here under
  the Eclipse Public License 2.0, whose text is `LICENSE.md`. The rest of this package is
  under its own `LICENSE.txt`.
- **Source:** the source code of this object code is at
  <https://github.com/kieler/elkjs> (tag `0.12.0`), built from the Eclipse Layout Kernel at
  <https://github.com/eclipse-elk/elk>.

To update, pack the new version the same way, replace the three files, and update this
table and the version above.
