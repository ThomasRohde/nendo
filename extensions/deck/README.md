# Deck

Slide decks in one `.nendo` file. `workspace/Deck.nendo` opens on the Deck view (`dk.view`, an
`extensionView` with `opensFile`). The package is `org.nendo.deck`; everything in this folder but
`nendo-package.json` and `README.md` is what the file carries. `tools/Build-Deck.mjs` builds a Deck
file from `tools/deck/definition.mjs` into an empty file Nendo has open, and brings a built file's
package up to this folder with `upgrade`; `tools/Review-Deck.ps1` is its lane.

## The records

| Record type | What it holds |
| --- | --- |
| Decks (`dk.deck`) | Title, subtitle, author, date, audience, goal, shape (16:9 or 4:3), template, brand kit, footer, slide numbers, status |
| Slides (`dk.slide`) | Deck, order, layout, title, kicker, body and body 2 (Markdown), speaker notes, picture (a media field), picture text, chart kind, hidden, text format (JSON) |
| Templates (`dk.template`) | A family's shapes with its own fonts and seven colours; six are seeds. A Design's template also holds light or dark, a style, per-kind backgrounds (four background pictures as media), chart colours, the logo's place, its Brand kit and the kit it came from |
| Brand kits (`dk.brand`) | Seven colour roles, three fonts, logo, logo on dark and mark (media fields), voice, tagline, the imported tokens |
| Asks (`dk.ask`) | One request to the person's agent: scope, request, selection, status, progress, reply |
| Variants (`dk.variant`) | Another version of one slide from an ask: label, the slide fields it sets as JSON, why, status |

The six templates and the example deck (sixteen slides, one per layout but Image left) are kept in
every new file. A person's own decks, kits and asks are not.

## One drawing, four outputs

`layout.mjs` turns a slide and a resolved theme into primitives: rectangles, ellipses, lines, paths,
arcs, pictures and text boxes with paragraphs of runs. It fits each text box by shrinking its size,
never below a floor, and marks a box that still runs over. Everything else draws those primitives:

- `render.mjs` as absolutely placed HTML, for the stage, the thumbnails, the layout and template
  galleries, the variants, Present and the HTML export;
- `pptx.mjs` as PowerPoint shapes: text boxes with real paragraphs and bullets, rounded rectangles,
  custom geometry, block arcs for doughnuts, pictures cropped to cover, notes slides, and a theme
  carrying the template's colours and fonts. A radial glow becomes a soft-edged translucent ellipse,
  the nearest PowerPoint draws alike.

So the stage, the export and the presentation cannot disagree about where a line breaks, beyond the
fonts the opening machine has. Charts are drawn as shapes, not as PowerPoint chart parts, for the
same reason.

`themes.mjs` resolves a template, a brand kit and the deck's options into one theme. A kit's colours
replace the template's; a dark template keeps its dark stage and a light template its light one, and
the kit's colours become accents.
Every role is then checked against what it sits on and moved until it reads: text 7:1 on the
background, muted text 4.5:1, a colour used as text 3:1, text on the primary 4.5:1.
`tools/deck/themes.test.mjs` holds every template to that with kits made to break it.

## Words edited on the stage

Every text box the layout draws from a field says where its words come from (`data-field`,
`data-dialect`, `data-key`, and the paragraphs or the place in the body it covers), so the stage
edits them where they stand, as PowerPoint does. `stage-editor.mjs` makes the box under the pointer
`contenteditable`, so the browser draws the caret and the selection, and takes every change itself:
each `beforeinput` is prevented and applied to the box's paragraphs (`textedit.mjs`, pure), the
paragraphs are written back to the field as Markdown, and the slide is drawn again with the caret
where it was. An input method's text is settled when it ends. A title takes marks and one line per
paragraph; a kicker, a big number and a timeline's "when" take plain words; a cell of a `- a | b`
row or a Markdown table is edited on its own and the rest of its line stays as it was.

The Markdown the stage writes reads back as the same words: `**bold**`, `_italic_`, `<u>underline</u>`,
a backslash before a mark character typed as itself, `<br>` for an empty paragraph, and a lone `-`
or `1.` for an empty item. Undo and redo are the stage's own, per slide, with typing in one place as
one step; Nendo's Undo still takes back a slide's add, move and delete. Copy writes plain text and
HTML; paste reads HTML from Word, PowerPoint, Google Docs and the web for its marks and lists.

The text menu is the view's own, not `nendo.ui.showMenu`, which has no submenus or toolbar. The
slide's text format field (`dk.slide.format`) keeps a size and an alignment for each box by its
key, such as `{"title":{"size":1.25},"body.0":{"align":"center"}}`; the size scales the layout's own,
so a box still shrinks to fit, and the PowerPoint export carries both. A variant never sets it.

## Designs

A Design is the whole look of one Brandkits kit: a Template whose `dk.template.brand` names its
Brand kit. Brandkits exports it as a `.deckdesign` file, a zip of `design.json` (format
`nendo.deck-design`, version 1; `design.mjs` says every field) with the logos and the background
pictures. Both apps read and write it with the same `design.mjs`, and Brandkits draws its preview
with the same layout engine, so what Brandkits shows is what Deck draws. Deck refuses a newer
version in a sentence, and a second import of the same kit (by `dk.template.source`) updates both
records in place. The records land in one revision and the pictures follow as media. A background
names its colours by role, so it follows the kit; a picture background is drawn first, under its
tint, and says whether it is dark, which sets the text on it.

## Brand kits

A view cannot read another `.nendo` file, so a kit from Brandkits arrives as one of its exports:
the Claude Design bundle (a zip of `README.md`, `tokens/tokens.json`, `tokens/brand.css` and
`assets/logos/`), the design tokens alone, or the CSS variables alone. `brand-import.mjs` reads token
paths for their role (`text-secondary` is muted text, not the secondary colour), font families, the
README's title, Voice section and tagline, and picks the logo and the logo whose name says dark,
reverse or white. Importing a kit of the same name again updates the fields its file holds and keeps the rest.

## The agent

Deck has no agent of its own (ADR-0014). The ask bar calls `nendo.assistant.ask` (ADR-0033) after
writing an Ask record, with the ask, the deck and the selected slide as context, and names the skill
the file carries, `skill://dev.nendo.deck/deck/SKILL.md` (source in `tools/deck/skill/`). The agent
writes slides directly for a whole-deck ask, and Variants for a one-slide ask or a mission; the view
shows each variant drawn as the slide would be, and Use writes its fields and dismisses its siblings
in one batch that Nendo offers to undo. A variant may set words and the layout, never the picture.
When the agent ends its turn and leaves its Ask open, the view closes it: Done for a turn that ended as
it should, Cancelled for one the person stopped, and Failed for any other end, such as a turn that ran
out of tokens, since that one may have written only some of the slides.

## Present and export

Present builds the HTML export with the pictures' own URLs and shows it in a frame over the view.
The exported HTML is one file with every picture the file holds inlined; a web picture stays linked
by its address, and one linked from a folder on the computer is left out, which the export says: arrows, space and Page keys, `P` for the
presenter view (this slide, the next, the notes and a clock), `G` for a grid, `F` for full screen,
`B` for black, `#N` in the address for a slide, and one slide per page when printed. The PowerPoint
export reads each embedded picture with `nendo.media.read`, and draws an SVG or WebP to PNG first.

## Limits

- Fonts are the opening machine's. A font not on a Windows machine loads from Google Fonts in the
  view and in the HTML file when online; PowerPoint substitutes a font it does not have.
- A picture only linked by URL is drawn on the stage but left out of the PowerPoint file, which
  says so.
- Charts are column, bar, line and doughnut, from a Markdown table; there is no chart editor. A
  doughnut draws the table's first number column and names it under the total.
- One person edits a slide at a time: a save that meets a newer version reads the record again and
  saves the typing over it. Typing still waiting for its save, or refused by the file, is kept in the
  package's storage on the device with the version it was typed over (`drafts.mjs`). When the view
  starts again it saves what meets that version, and holds what meets a newer one under a notice:
  Put mine back writes it over the change, Discard mine drops it.
- `Ctrl` `B` is Nendo's own key and never reaches the view, so Bold is in the text menu and its
  toolbar but has no key inside Nendo. Font, colour and highlight are the template's and the brand
  kit's, not a box's own; the text menu sets bold, italic, underline, size, alignment and lists.
- A Markdown link keeps its address, on the stage and in both exports, only for `http:`, `https:`
  and `mailto:`; any other link is shown as its words alone, so nothing in a slide runs in the view's frame.
