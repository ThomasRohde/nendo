# Writing a manuscript

The **Manuscript** screen is one quiet page: the whole manuscript, from its first heading to its last paragraph. Write as you would in any editor. Nendo keeps it paragraph by paragraph.

## More than one manuscript

A file can hold several manuscripts. The first box in the toolbar names the one you are in: choose another to open it, or **New manuscript…** to start one. Back and Forward go between the manuscripts you have opened.

## Saving

There is no Save button. A pause in your typing saves what changed, and the line in Nendo's toolbar says **Saving…**, then **Saved** with the time. **Not saved** means Nendo refused the write; your text stays on the page and the message above it says why.

## Parts, chapters and sections

**Style** in the toolbar makes the line you are on a **Part**, **Chapter**, **Section** or **Paragraph**. You can also start a line with `#`, `##` or `###` and a space. A heading holds the paragraphs after it, until the next heading at its level or above, so moving a heading moves its chapter.

**Outline** opens the headings beside the page; choose one to go there.

## Roles

**Role** in the toolbar says what the line you are on is for, apart from being a paragraph or a heading: a **Dedication**, an **Epigraph**, a **Quotation**, a **Verse**, a **Scene break**, a **Caption**, an **Abstract**, the **References** and more. Give a heading a role and everything under it has it: make the chapter called *Summary* an Abstract and its paragraphs are the abstract. Exports set each role the way books and papers do: an epigraph to the right in italics, verse with its line breaks, a scene break centred, references with hanging indents.

## The bar over your selection

Select a few words and a bar of icons appears over them. Point at an icon, or move to it with the keyboard, and its name and keys appear. The icons on the bar are the tools you use most; **More** (the three dots) holds the rest:

| Tools | What they do | Keys |
| --- | --- | --- |
| **Bold**, **Italic**, **Underline**, **Strikethrough**, **Inline code**, **Highlight** | Mark the selected words; choose again to take the mark off. | `Ctrl` `B`, `Ctrl` `I`, `Ctrl` `U`, `Ctrl` `Shift` `S`, `Ctrl` `E`, `Ctrl` `Shift` `H` |
| **Clear formatting** | Take every mark off the selected words, and the paragraph's own alignment. | |
| **Align left**, **Centre**, **Align right**, **Justify** | Set the paragraph's lines. Choose the same one again and the paragraph goes back to its layout's setting. | `Ctrl` `Shift` `L`, `E`, `R`, `J` |
| **Paragraph**, **Part heading**, **Chapter heading**, **Section heading** | Make the line a paragraph or a heading, as **Style** in the toolbar does. | |
| **Quotation** | Give the paragraph the Quotation role, or take it away. | |
| **Link to a passage**, **Add a note**, **Keep as cutting**, **Copy for the agent** | See *Notes, links and cuttings* below. | |

To keep a tool on the bar, open **More** and choose the pin beside it. To put one back under More, right-click it on the bar (or press the menu key while it has the keyboard). The bar you make is this computer's, like the appearance settings.

Each paragraph is kept as Markdown, which Studio shows formatted: underlined words are written `<u>…</u>` and highlighted ones `<mark>…</mark>`. Alignment is the paragraph's **Align** field. A Word export keeps the marks and the alignment; a Markdown export keeps the marks. A file made before alignment has no Align field, and the bar does not offer it there.

## Pictures

A paragraph that is a single picture, written as `![description](address)` in Studio or by an agent, shows as a small picture with its description beside it, so the writing stays in front; choose **Full width** under Pictures in the settings button to see pictures at the width of the text. Click a picture to select it; Delete removes it, and Enter adds a paragraph after it.

## Notes, links and cuttings

The last group on the bar acts on the whole paragraph:

| Choose | To |
| --- | --- |
| **Link to a passage** | Link this paragraph to another one, by kind: elaborates, supports, contradicts, foreshadows, resolves or see also. |
| **Add a note** | Write a comment, question, task or issue on this paragraph. |
| **Keep as cutting** | Take the paragraph out of the manuscript and keep it under **Cuttings**, where Studio and the Outline screen still show it. |
| **Copy for the agent** | Copy a reference to this paragraph to paste into the Agent tab. Its tooltip names the paragraph and its version. |

A paragraph with notes or links shows how many in the margin; choose the number to select it. **Notes** and **Related** in the toolbar show them in full.

## Export

**Export** in the toolbar saves the page and downloads the manuscript to your Downloads folder:

- **Markdown**: the text with its headings and emphasis. With pictures it is a `.zip` holding the `.md` file and a `media` folder.
- **Word document, book layout**: a 6 by 9 inch book with a title page, each part or chapter on a new page.
- **Word document, paper layout**: an article in the two-column style arXiv papers use. The lines before the first heading become the centred author block, a section called *Abstract* runs across the page and narrower, the rest is set in two columns with numbered headings in capitals (*1. INTRODUCTION*), pictures placed one after another sit side by side, a line after a picture that starts *Figure 1.* becomes its caption, and a section called *References* gets hanging indents.

Notes, links and cuttings are not exported. If a picture cannot be included, its description stands in its place and the message above the page says which.

## Preview

**Book** and **Paper** at the left of the toolbar show the manuscript as a reader would see it: on pages of a 6 by 9 inch book or of a Letter-sized article, laid out as the Word export lays it out. **Write** takes you back to writing. The preview is close to what Word produces, not identical: Word may break a paragraph across two pages where the preview moves it whole.

## Appearance

The settings button in the toolbar chooses the typeface, the size and the line length: Narrow, Medium, Wide, or Full, which gives the text all the width of the window. In Book and Paper the line length scales the pages, so their text runs about as wide as it does while you write, and Full fits a whole page to the window; Small and Large make the pages smaller or larger, as they do the text while you write. A page is never drawn wider than the window, so in a narrow window Large or Wide may look the same as Medium. They are this computer's, not the manuscript's: they change how the page looks to you, and nothing in the file.
