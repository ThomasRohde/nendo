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
| Slides (`dk.slide`) | Deck, order, layout, title, kicker, body and body 2 (Markdown), speaker notes, picture (a media field), picture text, chart kind, hidden |
| Templates (`dk.template`) | A family's shapes with its own fonts and seven colours; six are seeds |
| Brand kits (`dk.brand`) | Seven colour roles, three fonts, logo and logo on dark (media fields), voice, tagline, the imported tokens |
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
replace the template's; a dark template keeps its dark stage and takes the kit's colours as accents.
Every role is then checked against what it sits on and moved until it reads: text 7:1 on the
background, muted text 4.5:1, a colour used as text 3:1, text on the primary 4.5:1.
`tools/deck/themes.test.mjs` holds every template to that with kits made to break it.

## Brand kits

A view cannot read another `.nendo` file, so a kit from Brandkits arrives as one of its exports:
the Claude Design bundle (a zip of `README.md`, `tokens/tokens.json`, `tokens/brand.css` and
`assets/logos/`), the design tokens alone, or the CSS variables alone. `brand-import.mjs` reads token
paths for their role (`text-secondary` is muted text, not the secondary colour), font families, the
README's title, Voice section and tagline, and picks the logo and the logo whose name says dark,
reverse or white. Importing a kit of the same name again updates it.

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
- Charts are column, bar, line and doughnut, from a Markdown table; there is no chart editor.
- One person edits a slide at a time: a save that meets a newer version reads the record again and
  saves the typing over it. Typing still waiting for its save, or refused by the file, is kept in the
  package's storage on the device with the version it was typed over (`drafts.mjs`). When the view
  starts again it saves what meets that version, and holds what meets a newer one under a notice:
  Put mine back writes it over the change, Discard mine drops it.
- A Markdown link keeps its address only for `http:`, `https:` and `mailto:`; any other link is
  shown as its words alone, so nothing in a slide runs in the view's frame.
