# Brandkits

Make professional brand kits with the agent you launched from Nendo. Write one line and it drafts a whole kit; select one part and it reworks only that.

## The loop

1. **Ask.** Type one line in the Brandkits view's ask bar and press Send, such as "A brand kit for a small coffee roaster in Aarhus". With nothing selected it asks about the whole kit; with a colour, a typeface, a logo, a sample or the voice selected, about the selection only.
2. **Watch.** On an empty kit the agent writes the voice, then the colours one by one, then the type, logos and samples, and the view draws each as it lands. Its running notes show under the ask bar. Stop ends its turn.
3. **Pick.** On a kit that already has content the agent never changes what is there. It offers up to three variants in a strip at the bottom, changes outlined in violet. Hover one to see it in the kit, then **Use this** or **None**.
4. **Undo.** Using a variant and every edit by hand show Undo in Nendo's notice.

## Contrast

Nendo works out every contrast ratio itself, by WCAG 2.2: 4.5:1 for body text (AA), 3:1 for large text and for buttons and graphics, 7:1 for AAA. The **Contrast** section lists each text colour on each background with its ratio and marks the pairs that fail. A sample whose ink fails on its background is marked on the card. Ratios in a variant's preview are worked out the same way, before you use it.

## Slides

The **Slides** tile shows four slides in the kit's look: a title, a section, cards and a chart, drawn the way Deck draws them. Its menus choose the family, a light or dark stage, the title weight, the corners, the kicker, where the logo sits, and what is behind each kind of slide: a colour of the kit, a blend of two, or a picture you pick. Each choice is one step that Undo takes back. Ask the agent for a slide look and it offers variants, previewed on the tile.

## Editing by hand

- **Select** a part with a click; Shift-click adds more. Click the voice block to select the kit's own words.
- **Change a colour** with a double-click on its swatch: type a new hex or use the colour picker, then Enter.
- **Rename** anything else with a double-click. **Delete** removes the selected colours, typefaces, logos or samples.
- **Add** with Nendo's Add button: a colour.

## Export

**Export** in the toolbar downloads the kit as CSS custom properties or as design tokens (the W3C Design Tokens format), and each logo as an SVG file.

**Claude Design bundle** downloads one zip with the kit's guidelines (README.md), its tokens, its logos and a preview page each for colours, type, logos, voice and samples, marked for Claude Design's Design System pane. Unzip it and run `/design-sync` in Claude Code to put it in a Claude Design design-system project.

**Deck design** downloads one `.deckdesign` file with the kit's whole slide look: the choices on the Slides tile, the colours, the type, the logos and the pictures. Drop it on the **Design** tab of a Deck file, or choose it there with **Import from Brandkits…**, and it shows under **Designs**. Import it again after a change and the design is updated in place.

## Where the agent works

Nendo never runs an agent by itself. The view's Send asks the agent you launched from Nendo's Agent page; Nendo may ask you first, in its own card, whether the view may message it. Without a launched agent, Send still writes the Ask: say **tidy the kits** in any agent session connected to this file and it finishes every waiting Ask by this file's Brandkits skill.

Every request is an **Ask** record, so it survives a reload: a kit whose Ask is still Working shows that state when you come back.

## Screens

- **Brandkits**, the custom view the file opens on.
- **Kits**, and each Kit's page with its Colours, Typefaces, Logos, Samples and Asks.
- **Asks**, every request with its state and reply, and each Ask's page with its Variants.
