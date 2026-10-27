# Writing a manuscript

The **Manuscript** screen is one quiet page: the whole manuscript, from its first heading to its last paragraph. Write as you would in any editor. Nendo keeps it paragraph by paragraph.

## More than one manuscript

A file can hold several manuscripts. The first box in the toolbar names the one you are in: choose another to open it, or **New manuscript…** to start one. Back and Forward go between the manuscripts you have opened.

## Saving

There is no Save button. A pause in your typing saves what changed, and the line in Nendo's toolbar says **Saving…**, then **Saved** with the time. **Not saved** means Nendo refused the write; your text stays on the page and the message above it says why. If Nendo closes before a save, what you changed is kept on this computer and saved when the manuscript opens again. If someone changed the same passage in the meantime, Manuscript asks: **Put mine back** or **Discard mine**.

## Parts, chapters and sections

**Style** in the toolbar makes the line you are on a **Part**, **Chapter**, **Section** or **Paragraph**. You can also start a line with `#`, `##` or `###` and a space. A heading holds the paragraphs after it, until the next heading at its level or above, so moving a heading moves its chapter.

**Outline** opens the headings beside the page; choose one to go there. Its arrows move a part, chapter or section, with everything under it, past the one before or after it; so do **Alt** **Shift** **↑** and **↓** on its name, and dragging it onto another heading moves it there.

## Roles

**Role** in the toolbar says what the line you are on is for, apart from being a paragraph or a heading: a **Dedication**, an **Epigraph**, a **Quotation**, a **Verse**, a **Scene break**, a **Caption**, an **Abstract**, the **References** and more. Give a heading a role and everything under it has it: make the chapter called *Summary* an Abstract and its paragraphs are the abstract. Exports set each role the way books and papers do: an epigraph to the right in italics, verse with its line breaks, a scene break centred, references with hanging indents.

## The bar over your selection

Select a few words and a bar of icons appears over them. Point at a paragraph and two faint controls appear in the margin beside it: **+** adds a paragraph, a list, a table or a heading below it, and the grip (six dots) opens the paragraph's menu, to turn it into a heading, a list or a quotation, set its alignment, or link, note, cut or copy it. **Format** in Nendo's toolbar lists every tool by name, with a tick by what is on where the caret is; **Ctrl** **K** finds them too. Point at an icon, or move to it with the keyboard, and its name and keys appear. The icons on the bar are the tools you use most; **More** (the three dots) holds the rest:

| Tools | What they do | Keys |
| --- | --- | --- |
| **Bold**, **Italic**, **Underline**, **Strikethrough**, **Inline code**, **Highlight** | Mark the selected words; choose again to take the mark off. | `Ctrl` `B`, `Ctrl` `I`, `Ctrl` `U`, `Ctrl` `Shift` `S`, `Ctrl` `E`, `Ctrl` `Shift` `H` |
| **Clear formatting** | Take every mark off the selected words, and the paragraph's own alignment. | |
| **Align left**, **Centre**, **Align right**, **Justify** | Set the paragraph's lines. Choose the same one again and the paragraph goes back to its layout's setting. | `Ctrl` `Shift` `L`, `E`, `R`, `J` |
| **Paragraph**, **Part heading**, **Chapter heading**, **Section heading** | Make the line a paragraph or a heading, as **Style** in the toolbar does. | |
| **Quotation** | Give the paragraph the Quotation role, or take it away. | |
| **Bulleted list**, **Numbered list** | Make the paragraph a list item, or a paragraph again. | `Ctrl` `Shift` `8`, `Ctrl` `Shift` `7` |
| **Indent list item**, **Outdent list item** | Move a list item a level in or out. | `Tab`, `Shift` `Tab` |
| **Insert table** | Put a table of three rows and three columns after the paragraph. | |
| **Add row below**, **Add column right**, **Delete row**, **Delete column**, **Delete table** | Shown while you are in a table. | |
| **Link to a passage**, **Add a note**, **Keep as cutting**, **Ask the agent** | See *Notes, links and cuttings* below. | |

To keep a tool on the bar, open **More** and choose the pin beside it. To put one back under More, right-click it on the bar (or press the menu key while it has the keyboard). The bar you make is this computer's, like the appearance. The appearance (typeface, text size, line length, pictures) is also under Manuscript in Nendo's **Settings** (Ctrl ,). Text size can be kept in the file as every reader's size, and your own choice still wins on your computer.

Each paragraph is kept as Markdown, which Studio shows formatted: underlined words are written `<u>…</u>` and highlighted ones `<mark>…</mark>`. Alignment is the paragraph's **Align** field. A Word export keeps the marks and the alignment; a Markdown export keeps the marks. A file made before alignment, lists or tables lacks their fields, and the bar does not offer them there.

## Lists

Start a line with `- ` or `* ` for a bulleted list, or `1. ` for a numbered one, or use the bar. **Enter** starts the next item, **Tab** and **Shift** **Tab** move an item in and out (up to five levels), **Enter** on an empty item moves it out a level and then ends the list, and **Backspace** at the start of an item makes it a paragraph again. Numbering starts again wherever a list does.

Each item is a paragraph of its own: a note or a link can attach to it, Studio shows it with its **List** and **Level**, and it moves with its chapter. A pasted list keeps its items and levels.

## Tables

**Insert table** in the bar (under **More** until you pin it) puts a table after the paragraph you are in, its first row the header. **Tab** goes to the next cell, and a **Tab** in the last cell adds a row. While you are in a table the bar offers **Add row below**, **Add column right**, **Delete row**, **Delete column** and **Delete table**, with the marks for the words in a cell.

A table is a block that holds its rows, and each row holds its cells, so Studio shows a table as **Table**, **Row** and **Cell** blocks, and a cell's text is kept as Markdown, like a paragraph's. Word export writes a real table with its header row repeated on each page; Markdown export writes a pipe table.

## Pictures

A paragraph that is a single picture, written as `![description](address)` in Studio or by an agent, shows as a small picture with its description beside it, so the writing stays in front; choose **Full width** under Pictures in the settings button to see pictures at the width of the text. Click a picture to select it; Delete removes it, and Enter adds a paragraph after it.

## Find, web links and pictures

**Ctrl** **F**, or **Find** in the toolbar, finds a word or a phrase anywhere in the manuscript, the parts off the screen and the table cells included; tick **Cuttings too** to look there as well. **Enter** goes to the next one and **Shift** **Enter** back. **Ctrl** **H** opens it to replace: **Replace** changes the one you are on, **Replace all** every one, and one **Ctrl** **Z** puts them all back. Paste a reference made by **Copy reference** to go straight to that paragraph.

Select some words and choose **Web link** to link them to a web page; with the caret in a link, the same tool changes the address or removes the link. A Word export keeps the links.

**Insert picture**, in **More** or from **+** beside a paragraph, puts a picture from this computer in the file and below the paragraph. Its file name is its description until you choose **Describe picture** in its menu; **Add a caption below** starts its caption.

## Links that keep up

A link remembers the words at both its ends. Change either passage and the link is marked **Needs review**: **Links** in the toolbar lists every link to review, in the order of the manuscript, showing what changed word by word, and **Related** shows it beside the paragraph. **Reviewed** says you have looked, and the link remembers the words as they are now. Moving a passage does not need a review.

**Links** also follows a thread. Choose a kind of link, such as *Thread: Foreshadows*, to read every passage it joins in the order of the manuscript, with its chapter and how far it is from the one before; or **Connected to this paragraph** to follow everything linked to where the caret is. **Context** shows the paragraphs either side, and choosing a passage goes there.

## Footnotes

**Footnote** on the bar (in **More**), or **Ctrl** **Alt** **F**, puts a footnote's number at the caret and opens a box beside it for its words; they are saved as you type. Click a number to read or change its footnote, and delete the number to remove it. Numbers follow the order the footnotes come in the manuscript. A Word export puts each footnote at the foot of its page; a Markdown export lists them at the end, and so does the preview.

## Notes, links and cuttings

The last group on the bar acts on the whole paragraph:

| Choose | To |
| --- | --- |
| **Link to a passage** | Link this paragraph to another one, by kind: elaborates, supports, contradicts, foreshadows, resolves or see also. When you change the words at either end, the link asks to be reviewed. |
| **Add a note** | Write a comment, question, task or issue on this paragraph. |
| **Keep as cutting** | Take the paragraph out of the manuscript and keep it under **Cuttings**, where Studio and the Outline screen still show it. |
| **Move up**, **Move down** | Move the paragraph, or the paragraphs you have selected, past the one above or below. `Alt` `Shift` `↑` and `↓` do the same. |
| **Ask the agent** | Ask the agent you launched from Nendo's Agent page about this paragraph, or about a whole section from its heading. Say what you want, such as *tighten it* or *check the facts*, and choose what it may do: **Add notes only**, the default, which leaves your text as it is and puts each suggestion in a note in the margin, **Change the text** or **Only answer**. Nendo asks you first whether Manuscript may message the agent, and to launch one if none is running. The answer shows here; close it and go on writing, and it comes as a notice. **Copy reference** copies a reference to paste into an agent instead; with a Nendo that cannot message an agent, the tool is **Copy for the agent** and does only that. Its tooltip names the paragraph and its version. |

A paragraph keeps its notes and links wherever it goes. Move it, or cut it and paste it somewhere else in the manuscript, and they go with it; cut it without pasting and it waits under **Cuttings**. Join two paragraphs with **Backspace** and the second one's notes and links go to the first. **Ctrl** **Z** after Manuscript has saved brings a deleted paragraph back with its notes.

A paragraph with notes or links shows how many of each in the right margin, a note icon for notes and a link icon for links; choose them to open its notes, or what it is linked to, beside the page. **Notes** in the toolbar counts the notes in this manuscript and lists them all in reading order, each under the passage it is on: choose the passage to go to it. **Related** shows what the paragraph the caret is in is linked to. **Edit** on a note changes its words and its kind.

**Cuttings** in the toolbar lists what you kept out of the manuscript. **Put back** sets a cutting after the paragraph the caret is in, with its notes and links; **Delete**, pressed twice, removes it for good.

## Export

**Export** in the toolbar saves the page and downloads the manuscript to your Downloads folder:

- **Markdown**: the text with its headings and emphasis. With pictures it is a `.zip` holding the `.md` file and a `media` folder.
- **Word document, book layout**: a 6 by 9 inch book with a title page, each part or chapter on a new page.
- **Word document, paper as typeset**: the paper line for line as the Paper preview sets it, as TeX would: each line ends where TeX ends it and Word only draws it. Use it to print or share the paper as it looks; its lines do not reflow if you edit the text in Word, so edit in Nendo and export again.
- **Word document, paper layout**: an article in the two-column style arXiv papers use (AASTeX), with its measures: Times at 10 points on Letter, two columns, every paragraph indented, hyphenated and justified. The lines before the first heading become the centred author block, a section called *Abstract* runs across the page and narrower, the rest is set in two columns with numbered headings in capitals (*1. INTRODUCTION*), pictures placed one after another sit side by side, a line after a picture that starts *Figure 1.* becomes its caption, tables have rules above and below, and a section called *References* gets its heading across the page and hanging indents.

Notes, links and cuttings are not exported. If a picture cannot be included, its description stands in its place and the message above the page says which.

## Preview

**Book** and **Paper** at the left of the toolbar show the manuscript as a reader would see it: on pages of a 6 by 9 inch book or of a Letter-sized article, laid out as the Word export lays it out. **Write** takes you back to writing. The book preview is close to what Word produces, not identical: Word may break a paragraph across two pages where the preview moves it whole. The paper preview sets its lines as TeX would, so a paragraph runs on from one column to the next and its lines break as in the article arXiv would show. The paper layout's Word document lets Word break the lines, so its columns can end a line or two apart; **Word document, paper as typeset** keeps the preview's lines.

## Page setup

**Page setup** in the toolbar sets the page for each layout of this manuscript: the page size, the margins, the typeface and its size, the line spacing and page numbers. Choose the layout at the top, then change what you want; anything you leave as *The layout's own* stays as the layout sets it. These settings are kept in the file with the manuscript, and the Word export and the preview use them. **Use the layout's own** puts a layout back. If the typeface you choose is not on this computer, Page setup says so: the preview shows a stand-in, and so will Word wherever the typeface is missing.

A Word export uses Word's own styles, one for each kind of paragraph: change **Quotation** in Word and every quotation changes. **Word document, manuscript layout** in **Export** gives a submission copy: double-spaced Times at 12 points on Letter.

## Appearance

The settings button in the toolbar chooses the typeface, the size and the line length: Narrow, Medium, Wide, or Full, which gives the text all the width of the window. In Book and Paper the line length scales the pages, so their text runs about as wide as it does while you write, and Full fits a whole page to the window; Small and Large make the pages smaller or larger, as they do the text while you write. A page is never drawn wider than the window, so in a narrow window Large or Wide may look the same as Medium. They are this computer's, not the manuscript's: they change how the page looks to you, and nothing in the file.
