# Deck

Slide decks in one `.nendo` file. `workspace/Deck.nendo` opens on the Deck view (`dk.view`, an
`extensionView` with `opensFile`). The package is `org.nendo.deck`; everything in this folder but
`nendo-package.json` and `README.md` is what the file carries. `tools/Build-Deck.mjs` builds a Deck
file from `tools/deck/definition.mjs` into an empty file Nendo has open, and brings a built file's
package up to this folder with `upgrade`. Its `tour` stage adds the example slides a built file lacks
and puts the example's new words over its old ones, and leaves anything the person changed;
`tools/Review-Deck.ps1` is its lane.

## The records

| Record type | What it holds |
| --- | --- |
| Decks (`dk.deck`) | Title, subtitle, author, date, audience, goal, shape (16:9 or 4:3), template, brand kit, footer, slide numbers, status, transition, talk length in minutes |
| Slides (`dk.slide`) | Deck, order, layout, title, kicker, body and body 2 (Markdown), speaker notes, picture (a media field), picture text, three more pictures for a Picture grid (media fields), chart kind, hidden, text format (JSON), build (all at once or one by one), transition (the deck's or its own), rehearsed seconds |
| Templates (`dk.template`) | A family's shapes with its own fonts and seven colours; six are seeds. A Design's template also holds light or dark, a style, per-kind backgrounds (four background pictures as media), chart colours, the logo's place, its Brand kit and the kit it came from |
| Brand kits (`dk.brand`) | Seven colour roles, three fonts, logo, logo on dark and mark (media fields), voice, tagline, the imported tokens |
| Asks (`dk.ask`) | One request to the person's agent: scope, request, selection, status, progress, reply |
| Variants (`dk.variant`) | Another version of one slide from an ask: label, the slide fields it sets as JSON, why, status |

The six templates and the example deck (twenty slides, one per layout but Image left) are kept in
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

## Slides arranged

The slide list and the slide sorter (a grid of every slide over the whole view) take the same
gestures, as PowerPoint's slide pane and sorter do. A click picks a slide; `Ctrl` adds or takes one
out and `Shift` picks the run from the anchor (`order.mjs` `pick`); the current slide is always in
the pick. `arrange.mjs` drags with the pointer rather than the browser's drag and drop, so it draws
its own: the picked slides lifted, a stack with their count under the pointer, a line (a bar in the
sorter) where they will land, scrolling while the pointer is near the list's edge, `Ctrl` at the
drop to copy, and `Esc` to put them back. A drop moves the pick as one block in its own order
(`moveBlock`); `Ctrl` and an arrow steps each picked slide over its neighbour (`nudge`), and with
`Shift` to the start or the end. The list shows the new order at once and the slides slide into it.

A slide's place is its integer order. `ordersFor` keeps the longest run of orders that still rise
and writes only the others, into the gaps between, ten apart where they fit, so a move of one slide
writes one order. A gap too narrow takes in its nearest kept neighbours until the slides fit, so a
paste of 100 slides between two others writes about 110 orders. One step is one `records.batch`, at
most 200 writes: a paste that would need more says so and writes nothing. A step keeps the deck it
changed, so `Ctrl` `Z` in another deck leaves it alone. Copy puts the picked slides on
the clipboard as Deck's own type (`application/x-nendo-deck-slides`, format `nendo.deck-slides`
version 1, every slide field by its model name) and their words as plain text; a paste in any deck,
in this file or another, makes them after the pick. A paste reads at most 100 slides, so cut and
copy refuse a bigger pick and say so before anything is deleted. A picture another file holds is not this file's
to point at: when the file refuses one, the slides are pasted without their pictures, and the view
says so. A menu's Copy and Paste reach the clipboard where the browser allows it, and Deck's own
last copy where not. The slides' menu is Nendo's (`nendo.ui.showMenu`), and the view's own where the
frame has none.

Adding, duplicating, pasting, moving, hiding, a layout and deleting are each one batch, which
Nendo's notice offers to undo, and one step of the view's own undo, which Ctrl Z and Ctrl Y walk
together with the stage's typing, the later first. A step is taken back through `records.undo` and
`records.redo`; Nendo refuses one whose slides changed since, such as a moved slide typed in
afterwards, so each step also keeps the fields it wrote before and after, and a refused step is put
back by a batch of its own. A slide deleted and made again that way comes back under a new ID, since
a deleted record's ID stays the file's, with its variants made again on it in the same batch; every
kept step, and the stage's typing steps, then name the slide by its new ID. A step in another deck
waits until that deck is open.

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
by its address, and one linked from a folder on the computer is left out, which the export says.

- **Builds.** A slide set to *One by one* brings its points on one click at a time. `layout.mjs`
  gives each primitive a `step`: a paragraph and the lines under it, a card, a big number, a table
  row, a process or cycle step, a picture of a grid with its caption, a chart's category, series or
  doughnut or pie part. `render.mjs` writes it as `data-step`, the stage
  marks the first point of each click with its number, and the player and PowerPoint both count the
  same clicks.
- **Transitions.** The deck has one (None, Fade, Push, Zoom) and a slide may set its own. The player
  draws them with the Web Animations API, and as a fade when the machine asks for reduced motion.
- **The presenter console** (`P`): this slide as the audience sees it, the next point or slide,
  the notes with their own size, a strip of slides, the talk's clock with pause and reset, the
  slide's own time, the time of day, and the pace against the talk's length. Laser (`L`), pen
  (`D`, `E` clears), black (`B`) and white (`W`) reach the audience; the console's slide shows a
  black or white screen as a notice over it. A number and Enter goes to a
  slide; `G` opens a grid, `F` full screen, `#N` in the address a slide.
- **The audience window.** In the HTML file opened in a browser, the console opens the slides in a
  second window and keeps both in step; keys pressed in either drive the talk.
- **Rehearse** opens the console with its clock running. Finish offers the seconds spent on each
  slide, and Keep writes them in one step Nendo offers to undo. `export-html.mjs`'s `planOf` fits
  those times, and the notes' spoken length for the rest, to the talk's length for the pace.
- **The Check tab** (`check.mjs`): the talk's length against its target, from rehearsed times and
  from the notes at 130 words a minute, then what to look at, worst first: text that runs over, a
  slide with no title or an empty body, a picture still to place or without picture text, more than
  60 words on a slide, a build with nothing to bring on, a slide with no notes. A click opens the slide.

When printed, the HTML shows one slide per page with every point. The PowerPoint export writes each
slide's transition and its clicks as on-click fade entrances, by paragraph for text. It reads each
embedded picture with `nendo.media.read`, and draws an SVG or WebP to PNG first.

## Limits

- Fonts are the opening machine's. A font not on a Windows machine loads from Google Fonts in the
  view and in the HTML file when online; PowerPoint substitutes a font it does not have.
- A picture only linked by URL is drawn on the stage but left out of the PowerPoint file, which
  says so.
- Charts are column, bar, line, area, stacked column, pie and doughnut, from a Markdown table;
  there is no chart editor. A pie or a doughnut draws the table's first number column; a doughnut
  names it under the total.
- Process and Cycle are drawn diagrams with two to six steps, not PowerPoint SmartArt: in PowerPoint
  they open as shapes and text boxes. Title only gives PowerPoint an empty space under the title to
  draw in; Deck itself has no free shapes or text boxes.
- One person edits a slide at a time: a save that meets a newer version reads the record again and
  saves the typing over it. Typing still waiting for its save, or refused by the file, is kept in the
  package's storage on the device with the version it was typed over (`drafts.mjs`). When the view
  starts again it saves what meets that version, and holds what meets a newer one under a notice:
  Put mine back writes it over the change, Discard mine drops it.
- Ctrl X, C and V are the browser's own in the slide list, so they are not declared as Nendo keys;
  from Nendo's row and the slides' menu they reach the clipboard only where the browser lets a
  view, and otherwise paste Deck's own last copy. A slide pasted from another file loses its
  picture. Undo walks one view visit: a frame mounted again starts with no steps, and Nendo's
  History still has every batch.
- `Ctrl` `B` is Nendo's own key and never reaches the view, so Bold is in the text menu and its
  toolbar but has no key inside Nendo. Font, colour and highlight are the template's and the brand
  kit's, not a box's own; the text menu sets bold, italic, underline, size, alignment and lists.
- Nendo opens no second window for a view, so the audience window is in the HTML export opened in a
  browser; inside Nendo the console and the slides share the one frame.
- A Markdown link keeps its address, on the stage and in both exports, only for `http:`, `https:`
  and `mailto:`; any other link is shown as its words alone, so nothing in a slide runs in the view's frame.
