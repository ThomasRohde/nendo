# Brandkits

Brand kits in one `.nendo` file. `workspace/Brandkits.nendo` is the owner's file and stays out of
git; this repository holds what the file carries and how to bring it up to date.

- `extensions/brandkits/` is the view package `app.brandkits.view`. Every file in it but
  `nendo-package.json` is what the file carries.
- `tools/brandkits/skill/` is the skill package `app.brandkits`: `SKILL.md` and the help page.
- `tools/brandkits/file.json` is the file's record types as they were built over MCP, with the
  Ember & Oak example kit. `slides-operations.json` adds the Kit's slide fields.
- `tools/Review-Brandkits.ps1` is the lane: the node tests, then `tools/Gate-Brandkits.mjs` in the
  fixture broker.

## Slides and the Deck design

The board's **Slides** tile draws the kit as Deck draws a deck, with Deck's own engine. The engine
is copied into `extensions/brandkits/deck/`, because a view reads only its own package. After a
change to a file that `engine.mjs` names, run `node tools/brandkits/Sync-DeckEngine.mjs` and commit
both folders together; `tools/deck/engine-copy.test.mjs` fails while the copy differs.

`slides.js` turns a kit and its `kitSlides` choices into a `.deckdesign` file
(`extensions/deck/design.mjs` reads and writes the format). **Export, then Deck design** downloads
it, and Deck imports it on its Design tab.

## Bringing the file up to date

With Brandkits.nendo open in Nendo, send both packages to its MCP endpoint:

```text
node tools/Put-NendoPackage.mjs extensions/brandkits --endpoint <endpoint> --operations tools/brandkits/slides-operations.json
node tools/Put-NendoPackage.mjs tools/brandkits/skill --endpoint <endpoint>
```

Each one is a proposal the person accepts in Nendo. Send `--operations` only to a file whose Kit has
no `kitSlides` field yet; after that, send the package alone.
