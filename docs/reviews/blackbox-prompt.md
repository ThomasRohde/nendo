*Maintained in the Nendo repository as `docs/reviews/blackbox-prompt.md`. Copy it whole
into an empty working directory and hand it over as the reviewer's entire instruction.
[`README.md`](README.md) beside it says how to run a round and how to keep this current.*

# Nendo blackbox review

You are reviewing Nendo as an outside client. You have never seen its source and you must
not look: do not open, read, list, grep or clone the Nendo source repository, wherever it
sits on this machine. If you ever feel you need it, stop and write that down — needing the
source is the most valuable finding you can produce.

Everything you learn must come off the wire, out of the interface, or from the person at
the keyboard. Work only in the directory you were started in. Write your notes and your
evidence there; never write into the product's repository.

## What Nendo is, as far as you know

A local Windows app for building small database applications. It exposes a local MCP
server so an external agent can inspect and reshape the open file. The person at the
keyboard owns acceptance: you propose, they accept. You will need them several times, so
batch your requests rather than interrupting every few minutes.

## Before you start

The Nendo MCP server should already be registered — its tools should be listed under
`/mcp`. Ask the person to confirm all of this and to tell you when it is done:

1. Nendo is running with a **new, empty** file open, created from File → New **in the same
   window** — a second window moves the endpoint out from under you.
2. Agent access is set to **Shape app**. You will ask them to raise it to **Unattended**
   in Phase 4b and to lower it again afterwards; do not ask for it before then.
3. Under Agent → Connection, **Fixed port** is on (it is the default), so your registration
   survives the restart in Phase 6.
4. The window stays open for the whole session.

If the tools are missing or every call fails, say so and stop. Do not work around it: a
review that routes around a broken connection tells nobody anything.

Then, before you call anything, write down your first impression of what you were handed —
the tool names, their descriptions, their input schemas, whatever the server says about
itself. Could you tell from that alone what this product is and where to begin? That first
impression is a finding either way.

## Focus for this round

Updated 2026-09-25, when custom views began to run from the file. Every phase below still
gets a pass; spend your extra time on these, which changed most recently:

- A view that lives in the file (Phase 10), the newest thing a change set can carry. Its
  code arrives as a package the person reviews line by line, and once accepted it runs
  wherever its screen is shown, with nothing to install and nothing to allow. Record
  whether the wire told you, before you tried, what that code can reach; whether the
  review said so in words the person could weigh; and what the person could do when a
  view misbehaved.
- The board whose columns are records (Phase 3), the newest shape. Its columns are not in
  the definition at all: they are rows of another record type, read when the board opens,
  and there is a point past which the board stops drawing. Find that point rather than
  reading about it, and say what the screen tells you when it is reached.
- The matrix and the ranking (Phase 3). A matrix states a number and
  shows cards in the same cell and they are not the same quantity; a ranking draws bars
  against a number read separately from the rows. Both are places where something
  plausible can be drawn from the wrong arithmetic, so count rather than glance.
- The front page (Phase 3), the newest shape and the only screen that is not about one
  record type. Before you author one, record what the wire told you: how many a file may
  have, whether the root takes a record type, where each tile gets one instead, and what
  happens to a field binding placed on it. Then build one over **two** record types and
  say whether the result tells you anything the separate screens did not. Put a range on
  a date field and one on a number, and record what each says when the set is empty and
  when it holds exactly one record. Ask a recent list for eleven records and record what
  the host did with that. Then open the file fresh and say what you saw first.
- Nendo as a Windows application (Phase 7). Everything here happens outside the window,
  which is exactly why no lane can reach it. In a folder of files, does a .nendo file look
  like a Nendo document rather than like the application, or like nothing at all? Does
  double-clicking one open it? Right-click in a folder: is there a *New > Nendo
  application*, and does choosing it leave you with a file you can work in or an error?
  Right-click Nendo's taskbar button: are yesterday's files there, and does picking one
  open that file? Open a read-only file and look at the taskbar button rather than at the
  window — does it say anything? And drag a .nendo file from Explorer onto the window:
  say what the window told you while the file was in the air, and what happened when you
  let go.
- The notification area (Phase 7). Close the window and say where you think the app
  went, then find your way back to it. Read every item in that menu and say what you
  expect each to do, including the two that are switched on — one decides what the close
  button does, the other whether a view failure is written down. Turn the second off and
  say whether anything told you what you had just stopped keeping.
- A screen with an agent writing underneath it (Phase 3). Put a front page or a board with
  totals on screen, have your agent write records steadily for a few minutes, and say what
  the numbers do, whether the app stays usable, and whether you can still work the Showing
  picker with a mouse while it happens. Then stop writing and say how long the screen took
  to agree with the file.
- What the file is for (Phase 1), the newest thing in the file and the first thing a read
  hands you. Record whether you were told it before you were told anything else, whether a
  file with no front page can carry one, where a person finds it when there is no front
  page to show it, and whether the front page's own sentence and the file's are ever
  confused for each other. Then clear it and say what the review said you
  were about to do.
- The gallery and the rating (Phase 2, Phase 3). Before you author a
  rating, record whether the wire told you that a scale takes two bounds, what its
  ceiling is and whether it can be changed later. Then store a value outside the scale
  and record what the write, the read and the screen each said about it. Open a record
  that carries one and say how many marks each value of the scale shows, whether the
  chosen one is unambiguous, and whether a press that lands on a field's name and drags
  a little sweeps a selection over the form. Then try to select and copy a value.
- The timeline (Phase 3). Before you author one with an end date, record whether the
  vocabulary told you how a span is placed and what happens to an end before its start;
  afterwards, ask the person whether the year, the span sentence, the scale note and the
  Undated view read as you authored them.
- What the tool list says about its arguments (Before you start, Phase 1). Every input
  node should now declare a type; if your client validates schemas, record whether any
  call was refused on your side before it was sent.
- Refusals that used to name the wrong thing (Phase 5): a write to a calculated field, a
  page limit that is not a whole number, and more operations sent to a change set after
  it validated. Record whether each named what it was refusing and what to do instead.
- A write that fires an action, and its receipt (Phase 4, Phase 6): does the result say
  what else changed, and does the receipt you recover after a lost response say the
  same?
- An action whose target reference is empty (Phase 4): what did the write report, and
  had the catalogue told you what to expect?
- An action step aimed at the wrong record (Phase 4). Write one deliberately: bind the
  step to the record the event was raised on, and assign a field that belongs to the
  record it references. Record when you were told — at install, or at the next save —
  and whether the refusal named the action, the step, the record type and the field, or
  left you to work out which of several steps it meant. Then try a step that follows a
  reference the trigger's record type has not got, and record whether that read as a
  refusal or as something internal.
- What a refused install leaves behind (Phase 4, Phase 5). After any refusal, read the
  file again before doing anything else. Record whether the file still answers, whether
  what you read matches what was there before, and whether a corrected install then
  works in the same session — a refusal that costs you the session is worth reporting
  even when the file on disk is untouched.
- Which Nendo you are talking to (Before you start, Phase 1). `nendo://host/instances` is
  the one read here that is not about the open file. Record whether you could say which
  file you were connected to before you wrote anything, and whether the list told you what
  you could do about it — you cannot move yourself to another endpoint, and the resource
  should not leave you thinking you can. If only one Nendo is running, say so; the case
  worth reporting is two.
- Whether a published rule is true (Phase 2). Take one constraint the resources state about
  an operation — the reference-binding rule is the obvious one — and try the thing it tells
  you not to do. Record whether the boundary agreed with the text. A rule that is published
  and not enforced costs you operations against the change-set ceiling for nothing, and is
  worth reporting as loudly as one that is enforced and not published.
- What the host says about how much it will hold (Phase 1, Phase 5). Before you write in
  bulk, record what the published limits told you about how large a file may become, and
  whether anything said what happens as it fills. If a write is ever refused for the file's
  size, record whether the refusal told you the number, what it counted, whether anything
  had been changed, and whether the file could still be opened — and whether you could tell
  all four apart. The same refusal can arrive from a record write or from accepting a
  proposal; if you meet it both ways, say whether they read the same.
- What a proposal says (Phase 3). Name one record type in the plural, group a board by a
  reference to it, and give two screens a condition each. Read the review as the person
  will: does the board's line read naturally with that name in it, and is each condition
  one sentence naming the field, the comparison and the value — rather than a line that
  says nothing followed by three that say a third each?
- Help (Phase 7). Record whether the MCP surface article agreed with the wire on every
  name, limit and refusal, including the ones above.
- Connecting (Before you start, Phase 1, Phase 6). The address was your whole
  registration. Record whether anything the server said still sent you looking for a
  credential, a header or a handshake rule, and whether your registration came back
  after the reopen in Phase 6 without the person doing anything.
- The Agent page (Before you start, Phase 6). It was rearranged on 2026-09-14: what the
  person sets is in a left pane (Access level, Connection), what agents are doing is on
  the right (state, editing owner, Pending changes, Recent activity). Each time you ask
  the person to change access, copy the address or review a proposal, record whether
  your directions matched what they saw.

## Phase 1 — Discovery

Read every resource the server offers, including the templated ones a plain list does not
return. Then answer honestly: could you build an application from what you just read,
without guessing at a shape? Wherever the answer is no, write down the exact thing you
would have had to invent, and the call you made that should have told you.

Before you build anything, say what the file you opened is for, and where that came from.
Then say what an empty file says about itself. A file whose author has never said should
read as having said nothing — if you find a sentence there, say where you think it came
from. Later, once you have a file of your own, say what it is for, read it back, clear it,
and record what each of those three reads said.

## Phase 2 — A shape of your own

Invent a domain — do not copy any example the server publishes, and say what you chose so
a later reader can tell your work from the examples.

Create record types covering every storage kind you can find, a required field, a bounded
choice field, a whole number shown on a rating scale, and a reference from one type to
another. Store a rating outside its own scale on purpose, and record what the write
reported, what the read gave back and what the screen showed. Add records, including at least one
whole number larger than 9,007,199,254,740,992 and one decimal whose trailing zeros
matter. Read them back and check the digits survived the round trip exactly.

Then push on the shape itself: rename a field that already holds data; point a reference at
a record and then try to delete that record; retire a field and see what happens to what it
held. Record what each refusal or acceptance told you.

**Before you accept any of it, read the review and answer from it alone.** Cover the change
set you sent and work only from the sentences the person accepting would see: which record
types does this add, and which fields, of what kind? Which are required? What are the
choice field's options — and give one choice field no tones at all, then answer the same
question about it. What points at what, and by which label? Then go back to the change set
and count how many of your answers were wrong. Say whether any sentence contains an
identifier you would have to look up, whether any two lines describe the same thing twice,
and whether the summary tells you the size of a screen — a matrix's cells, a board's
columns — or only its title. A reviewer who cannot answer these from the review is being
asked to approve something they have not been shown.

## Phase 3 — Screens

Build every kind of screen the vocabulary describes, including more than one of a kind on
the same record type: a record page with sections and tabs, a list with filters and an
ordering, a board, a gallery of cards titled by a text field and toned by a choice, a
calendar, a timeline of a date field with an end date so that one entry is a span, a
related list, a total, a command with more than one step, a record
page whose header is a title field and a status colour, a choice field whose options
carry tones, a breakdown chart of that field and a progress ring with one condition.
Then build the file one front page, which belongs to the file rather than to a record
type: give it a sentence saying what the file is for, a total and a chart of one record
type, a range over a date field, and a short recent list of a *different* record type.
Read the screens back afterwards and check the description matches what you authored,
check a chart's numbers against a count you make yourself, check the timeline's
year, its span and its Undated view against the records you gave it, and check the front
page's numbers and both ends of its range the same way. Say where you found the front
page when you looked for it, and whether a person opening this file would understand
what it is for without being told.

Give one section on the front page and one on a record page `opens: closed`, and have the
person read both pages. Does a closed section read as something that opens, from the
keyboard as well as with the pointer? Does a number inside it appear only once it is
opened, and stay when it is folded again? Does a fold survive moving around the file, and
closing and reopening it? Does a copy of the file on the same computer open with the same
folds, and is the file itself unchanged by folding? And on the record page, does opening a
section keep what was typed elsewhere on the form?

The navigation down the left of the window folds. Find the control that folds it without
being told where it is, and say whether you would have found it at all. With it folded,
get to every route you built above — by pointer and then by keyboard alone — and say
which ones you could no longer name. Restart the application and say whether it opened
folded or open, and whether that is what you had left it as. Then make the window narrow
enough that the navigation rearranges itself on its own, and say what the fold control
does there.

Then go round every one of those screens **while it still has nothing on it**: a list
before its first record, a related list on a record nothing points at, a calendar and a
timeline with no dated records, a grid, a board. Write down what each one says, word for
word. Can you tell them apart — which is empty, which has not loaded, which is filtered
so that nothing matches, and which one is a screen that has gone wrong? Where a sentence
tells you to do something, do it from that screen without navigating away, and report any
that you could not.

### Recording something from the page you are on

- Open a record page with a related list on it and add a record to the relation from that
  page. Before you press Save, look at the form: does it say what the new record will point
  at, and does it name it in words you recognise or as an identifier you do not? Could you
  tell, from the form alone, which record you would be linking it to?
- Save it. Where are you afterwards, and is the new record in the list you added it from?
  Does the number beside that list move? Count how many times you had to leave the page to
  record one linked record, and compare it with doing the same thing from the other record
  type's own Add button.
- Change the pre-filled link to a different record before saving, and say whether the
  screen let you, whether you expected it to, and where the record ended up.
- Add to a relation whose record type's own page does **not** show the field pointing back
  at the parent. Is the link on the form at all? Save it and then find the record from the
  other end: is it linked?
- Now type something into the record page's own fields, leave it unsaved, and press Add.
  What happens, and does what it says tell you what to do? Do the same with the button that
  opens a related row. Then switch tabs on that page instead, and say whether your typing
  survived.
- With the typing still unsaved, try every other way off the page you can find: another
  screen in the View picker, another record type, another record in the list, the Next
  button above the list, a month or a year if the screen has one, a chart segment, a
  command on the record, and a view in the rail. For each, say whether your typing survived,
  whether you were told anything, and whether what you were told named the way out. Then
  find a relation with more than one page and press its Next: did the page turn, and is your
  typing still there?
- Open a reference picker on a record page, type a search, and cancel without choosing.
  Now try to leave the page. Were you refused, and if so, for what? Edit a field, put back
  exactly what was there, and press Save. What does it say, and can you leave afterwards?
  Then actually choose a record in the picker and try to leave: were you held, and should
  you have been?
- Have a second client delete a record that a related list on your page still shows, then
  click that row before the list refreshes. What happens, and where are you afterwards? A
  click that does nothing and says nothing is a finding.
- Click a related row. Where do you land, and how do you get back? Take the way back and
  then look for it again. If you open a second record from there, and a third, say what the
  way back means by then and whether that is what you expected.
- Find a relation whose record type has **no screen of its own**. What does it offer, and
  does it say why? Is the answer one you can act on, or one you have to work out?
- Order a relation so that the record you want is not on its first page, then open one from
  the second page. Did it open, and did the screen behind it change to make that possible?
- Look at what the file says it needs before and after you use any of this. Did anything
  about the file change? Should it have?
- Open the same file in the Structure and agent views and look for the two actions in what
  the file stores. Report whether you can find them, and say what that tells you about who
  decides they are there.

### Getting back to where you were

- Find the two arrows in the header. Before you press either, say what you expect each to
  do, and whether anything on screen tells you where they would take you. Hover one, and
  then reach them with the keyboard only: can you, and does what you hear or see name a
  screen or just a direction?
- Move around on purpose: change record type, change the view within it, drill into a
  chart, open a tab on a record page, move a calendar to another month, open a related
  row. Now walk all the way back. At each step, say whether you arrived at the screen you
  actually left — the same view, the same filter still on or off, the same tab, the same
  month — or at something that merely looks like it. Then walk forward again and say
  whether you got the same list of places back.
- Go back a few steps and then navigate somewhere new. What happened to the way forward,
  and was that what you expected?
- There are now two ways back on a record page opened from a relation: the labelled one in
  the toolbar and the arrow in the header. Press each and say whether they go to the same
  place. If they do not, say which one surprised you.
- Delete a record you visited earlier, then try to go back to it. What does the screen say,
  where are you afterwards, and does pressing back again do something sensible? Do the same
  for a screen removed by a proposal you accept.
- Type something into a record page without saving it, then press back. What happens, and
  does what it says tell you what to do?
- Open a different file. Does the way back still lead into the file you just closed? Should
  it? Then look at what the file says it needs, and whether anything about the file changed
  while you were doing all of this.

## Phase 4 — Calculations and automatic actions

- Find the formula vocabulary on the wire: what a formula may say, which functions exist
  with which argument and result types, how a formula reaches a value, what each aggregate
  does over an empty collection and over one it cannot read, and what the ceilings are.
- Author a reusable function, and calculated fields using every way of reaching a value you
  can find — including one calculation that reads another.
- Author an action and a trigger, so that editing one record changes another.
- Create a record whose action target reference is empty. Record what the write said,
  and whether the catalogue had told you what to expect before you tried.
- Author a screen that shows a field only when a calculation says so.
- Read the results back and check the numbers are exact. A calculation that divides is the
  interesting case.
- Make a calculation fail on purpose — divide by zero — and check what a reader is told,
  both over the wire and, by asking the person, on screen.
- Leave an optional input blank under two calculations over it: one declared to allow an
  empty result and one declared always to answer. Report what each reads over the wire
  and on screen — the first should be a blank that says *Not set*, the second an error —
  and whether a third calculation reading the first reads a blank rather than an error.
- Write a formula that refuses by name — `Refuse('…')` in one outcome of a choice — and
  report the sentence a reader is told, on the wire and on screen. Then put a refusal
  on its own, inside arithmetic, and in both outcomes, and report what validation says.

### Charts over time

- Build a trend of something per month and an activity grid of a year of days, over a Date
  field. Seed records so that **some months and most days have nothing in them**, and say
  what the chart does with those: is a quiet month a gap in the line, or is it missing from
  the axis altogether? Is a quiet day a pale square, or a hole? Count the columns and the
  squares against the range you asked for, rather than reading the shape.
- Ask for a range and then work out what it resolved to. Can you find a stored date anywhere
  in the definition? Try to author one — a literal start and end instead of the word — and
  report what you are told.
- Point one at a DateTime field rather than a Date, and report whether the refusal names the
  field and says why, or silently picks a time zone for you.
- Put as many conditions on a trend as it will take. How many is it, how many does a tile
  elsewhere take, and does the refusal explain the difference?
- Click a column and a square. Where do you land, and does what you land on match the number
  you clicked?

### Grids and rankings

- Build a matrix crossing two choice fields, and seed records so that **most of the cells
  have nothing in them**. Count the cells against the two option sets rather than reading
  the shape: is every combination there, or only the ones with records? Then look at a
  filled cell — it states a number and shows cards. Are they the same quantity? Seed one
  cell with more records than the surface loads in a page and report what it says.
- Leave one axis unset on a record, both axes unset on another. Where do they go, and do
  the cells still add up to the record type?
- Try a matrix of a field against itself, and one crossing two fields with enough options
  between them to be a very large grid. Report what each refusal says and whether it tells
  you what to do instead.
- Put a condition on an axis field. Does the lane it excludes disappear, or stay and read
  zero? Say which you think is right before you look.
- Click a cell. Where do you land, does it match the number you clicked, and how many
  conditions did it apply?
- Build a ranking on the front page. Try ranking by a Date and report the refusal. Then
  seed a record with no value in the rank field, and two records with the **same** value,
  and report where each one ends up and what numeral the tied pair carries.
- Set the rank field so that the largest value is zero, or negative. What do the bars do?
- Put as many conditions on a ranking as it will take. How many is it, and does the
  refusal say what the host added?

### A board whose columns are records

- Point one record type at another, then group a board by that reference rather than by a
  choice field. Before you look: where do you think the columns come from, and how many do
  you think there can be? Then count them against the target record type.
- Make a record of the target type that **nothing points at**. Does it get a lane? Say
  which answer you think is right before you look, and whether the one you got tells you
  anything useful.
- What order are the columns in, and what orders them? Change `orderDirection` on the
  board and report what moved.
- Do the columns carry colour? Where would a colour come from, and does the answer change
  what you think of the screen?
- Make the board **before you make a single record of the target type**, and look at it.
  Can you tell an empty record type from a screen that is broken or a board somebody set up
  wrong? Read every sentence on it aloud and say whether there is anything it tells you to
  do that you cannot do from the screen you are on.
- Keep adding records to the target type. Find the point where the board changes what it
  does, and report exactly what it says there: does it name a number, and does it tell you
  what to do instead? Then take one record away again and say whether it came back.
- Group a board by a Reference field that has never been pointed at a record type. What
  does the refusal say, and does it send you to the right place?
- Drag a card from one column to another. Did it move? Now, while the board is open,
  change the target record from somewhere else and drag a card onto it. Report the message
  word for word, and whether you could act on it from the board you were looking at.
- Put a condition on the board that excludes every value of the field it groups by, and
  then do the same to a grid. What does each say, and does it tell you which of its own
  clauses to take off?
- Leave a record's reference unset and report which lane it lands in. Then compare that
  lane's heading and its number with the one a choice-grouped board shows for the same
  case.
- Open the file with a board like this in it and look at what the file says it needs. Does
  the number change when you add the board, and does the review say so before you accept?

### A screen while somebody else writes

- Ask the person to leave a list or a board open and not touch it. Write to those records
  over MCP, then ask what they see and how long it took. Report whether the screen followed
  on its own, and whether anything jumped or moved under them while they were reading.
- Do it again while they hold a menu open or have a half-typed form on screen. Report
  whether the menu closed, whether the typing survived, and whether the screen caught up
  afterwards. Then have them type, click somewhere harmless on the page so the field loses
  focus, and wait a few seconds before you write: does the typing survive that too, and
  does the screen catch up once they save or close the record?
- Write repeatedly, a few times a second, for half a minute. Report whether the screen
  keeps up, gives up, or becomes unusable.

## Phase 4b — Data in bulk, and a level that does not ask

Two surfaces landed on 2026-09-22 and neither has been reviewed from outside.

**Getting data in and out.** There is a read that returns a record type as CSV and a tool
that takes CSV or JSON back. Find both without being told their names. Then:

- Export a record type you have filled with awkward values — an empty text, a null, a
  quote, a newline inside a cell, text that begins with a backslash, something that looks
  like a spreadsheet formula, and a whole number larger than 9,007,199,254,740,992. Import
  it into the same file and compare every stored value. Say which of the eight survived
  and which did not, by reading them back rather than by trusting the answer.
- The export is paged. Read all of its pages and say whether they join into one document
  you could hand to the import unchanged, or whether you had to repair something first.
  Then change the file between two pages and record what the second page told you.
- Find the ceiling on one import call by crossing it. Did the refusal give you both
  numbers — what the limit is and what you sent — so you could write the loop from it?
- Send an import that fails partway: make one row invalid and put it past the fiftieth.
  Record what committed, what `NENDO_IMPORT_PARTIAL` said committed, the first
  uncommitted row and the revision IDs; compare them with the stored records.
  Then retry the identical call with the identical key and say whether you ended
  up with one copy of the data or two.
- Send an unknown CSV field ID, a duplicate field mapping and an out-of-range
  column. For each, record whether the refusal is `NENDO_INVALID_REQUEST` before
  any write. Send both CSV text and JSON records in one call, once for each
  declared format; neither may silently ignore the extra payload.
- Try to make either of them name a file on disk, in any argument, in either direction.

**The level that does not ask.** There are five access levels now. The fifth lets an agent
accept its own proposals and lets the file run the actions it installs, without showing
anybody first.

- Before you ask for it: from the wire alone, at Shape app, could you tell that a fifth
  level exists, what it is called, and what it would let you do? Say where that came from
  or that nothing said so.
- At Shape app, try to accept your own validated proposal anyway. Record the refusal
  verbatim and say whether it told you what to ask the person for.
- Ask the person to set it. Record what they were shown before it took effect — whether
  anything asked them to confirm, and whether the sentence they saw matched what actually
  changed. Then build something: a record type, a screen, a calculation, an automatic
  action, and two hundred records, without them touching the window again.
- Say what you could see afterwards about what you had done. Is the acceptance in History?
  Does anything anywhere record that nobody reviewed it? Answer as the person would, from
  the screens alone.
- Then ask them to close and reopen the file, and report what access level it came back
  at. If it came back at the fifth, that is the most serious finding available in this
  phase.
- While you work, ask the person what the window is doing. They should be able to see that
  an agent is writing without opening the Agent page; ask them to tell you, in their own
  words, what it says and where. Then ask them to click something in Use while you run a
  long validate, and record what they saw and how long it lasted.

## Phase 5 — What must not work

This matters more than the happy path. For each, record whether the refusal named the
problem, named the thing it was refusing, and offered a remedy you could act on:

- Sorting, filtering, grouping or totalling a list by a calculated field.
- Writing to a calculated field, through a single-field edit and through a create.
- A form made only of calculated fields.
- Adding to, amending or re-validating a change set after it validated.
- A page limit that is not a whole number: letters, a fraction, nothing at all.
- Removing a definition that something else still reads.
- Writing data after an action exists but before the person has approved it.
- Finding *any* route — a tool, a resource, or a field on one — that lets you grant that
  approval yourself. Look hard. Report exactly what you searched. **Do this at Shape app
  and below.** At the fifth level the host grants it for you, which is a stated part of
  that level; if you find a way at any level beneath it, that is a defect and the most
  valuable thing in this phase.
- A formula that calls a function the catalogue does not list, including one that sounds
  like it reaches the network, a file, or the clock.
- A formula, a batch or a change set that exceeds a published ceiling.
- Anything that looks like SQL, a file path, a process, or a generic "run this".
- Reading or writing past whatever bound the read path puts on a page.
- **How far can you fill a file before it stops being openable?** There is a bound on how
  large a file may be and still be opened, and another on how many writes its audit tables
  may carry. Find out what they are without being told: does anything warn you as you
  approach one, does anything refuse the write that would cross it, and if you do cross
  it, what does the person see the next time they open the file — and what route back to
  their data are they offered? Say plainly whether you could get a file into a state its
  own application will not open, and whether you were told before or after.

## Phase 6 — Losing things, and getting them back

- Change a record, then compensate that change. Do the same for a save that fired an
  automatic action, and check what came back and what the data looks like afterwards.
- Repeat a write with the same idempotency key.
- Pretend you lost a response, and recover the outcome without re-sending it. If the
  write fired an action, does the recovered receipt say what the action changed?
- Ask for an integrity check, and read what it says about how stale the previous answer was.
- Have the person rename a board from Studio's Surfaces page and accept the proposal it
  previews. Then, on a screen that reads on its own account — a board or the front page —
  arrange for the view to be unreadable right after an acceptance, if you can, and watch
  the sentence that says so: it should stay on the page with its Refresh view button
  until that button is pressed, not vanish with the next automatic read.
- On the same kind of screen, go back to a record that has since been deleted, and then
  leave the page alone while an agent writes to the file. The sentence saying the place
  has gone should still be there after the screen follows the write; it should go with
  your next press. Report whether it did both.
- Leave a proposal waiting, then start a fresh session against the same file. Report what
  you can still see and what you can no longer do.
- Ask the person to close the file and reopen it, then confirm everything you built still
  works — the screens, the calculations, the trigger — with no agent connected. If your
  connection does not come back, say so and finish the report from what you have.
- Ask the person to press the window's close button and then leave it alone. Does your
  connection survive? Author and validate a change set while the window is away, then ask
  what they saw and how long it took to arrive. Report whether anything told you the
  person was not looking — and whether anything should have.

## Phase 7 — Their eyes, not yours

Ask the person to look at the app and tell you, in their words:

- Do the calculated fields read correctly in both Studio and the Use view, and is it clear
  which fields nobody can type into? Open the record from a list or board in the Use view
  — Studio's editor always shows every stored field, whatever the screens say.
- Does the approval panel explain what will happen to their data, rather than naming a
  permission?
- Press the close button. Where did the window go, and did anything say so? Ask them to
  find their way back to it without your help, and to find the way to actually quit. If
  they look for Nendo in the taskbar first, say so — that is the finding.
- Show them a folder containing a .nendo file beside other documents. Ask what kind of
  thing they think it is, and what they expect double-clicking it to do. Then ask them to
  open one of their files without using the Open dialog, and watch which of the three
  routes they reach for: the icon, the New menu, or the taskbar button's list.
- While a file is open read-only, ask them to look at the taskbar and say what state they
  think the app is in. If the badge means nothing to them, that is the finding — it is
  sixteen pixels and it is carrying a word.
- Ask what they think is still happening now that the window is closed: is the file still
  open, can the agent still reach it, and how would they stop it? Compare their answer to
  what the notification area's menu actually says.
- When a notification arrived, did clicking it land them somewhere that answered it? Ask
  whether they expected to be able to approve from the notification itself, and what they
  make of not being able to.
- Open Help → How Nendo works. Without you explaining anything, can the person say what a
  proposal is, why a file with automatic actions asked for approval, and what Compensate
  will and will not do?
- Open Help → Agents → The MCP surface and compare it with the tool list you were handed:
  does it name every tool and resource you saw, and none you did not? Does its account of
  a refusal match one you received?
- Search Help for a word that appears only inside an article — a refusal code, say. Does
  the index find it?
- Does anything look wrong in Light or in Dark?
- Export a record type to CSV and import it back into a new one. Did the exact digits, the
  empty values and anything that looks like a formula survive?
- Does the window stay usable while something slow is running, and can they stop it?
- Run a long agent write and ask them what the window told them: what appeared, where, how
  long it took to appear, and whether it said who was writing. Ask them what they would
  click to stop it, and record whether what they name actually would.
- Can they reach approval and the file actions with the keyboard alone?
- The window has a new look: dense, dark-first, one violet accent. Ask them, before you
  say anything, whether it reads as one application in Light and in Dark, and whether any
  screen still looks like it belongs to an older one. Name the screen.
- Ask them to get to Structure, then to a different view of a record type, then to
  Create backup, without touching the navigation on the left. Watch whether they find the
  box at the top (Ctrl K) and whether what they type finds what they meant. Does a command
  that is switched off on screen show up anyway? With unsaved typing on a record page, does
  a command that leaves the page ask first, as the click would?
- Turn on the keyboard button at the right of the top bar. Does every control that has a
  key now say which, and does the key do what the hint says? Close and reopen the window:
  is the choice still there? Then press Ctrl 1 to Ctrl 7, F1, Ctrl B and Alt F from inside
  a text field, and say which of them did something you did not want there.

## Phase 8 — A development planner as a real application

Use the empty review file or a person-approved disposable copy for this phase.
Never use the owner's live development planner for failure fixtures, compensation
experiments or CSV round trips. This phase needs no repository access: learn the
available shapes and limits from the wire as in the other phases.

- Build linked Initiatives, Work items, Findings and Checks. Give work a Now /
  Next / Later horizon separate from its execution status, and give checks an
  evidence method separate from their outcome (including Not run, Blocked and
  Accepted exception). Does capturing a small observation require too much input?
- Capture a finding, link actionable work, plan it, start it with a dated command,
  attach an acceptance check, and send it for review. Ask the person whether they
  can tell what is next, what is blocked, and why a check does not complete work.
- Keep an unfiltered All work list. Add a status chart and a completion ring on a
  list that excludes Dropped work. Confirm the ring's denominator and drill-through
  from the numbers on screen; do not infer totals from the first record page.
- Put brief, planning and evidence sections in tabs. Link findings and checks on
  the work page; show blocker details through a Boolean calculation. Exercise the
  gallery of initiatives, undated target calendar and delivery timeline.
- Try to add and open evidence from a related list. Distinguish display-only
  relations from actual creation/navigation controls, and report the extra steps
  needed to return to the parent work. Check that compact lists keep references
  and status/outcome visible together rather than hiding one behind a field limit.
- Try an optional value/effort calculation. Before assuming empty or out-of-scale
  ratings can return a blank score, establish what the published expression
  vocabulary supports. Record missing-input behavior and any workaround openly.
- Author a local action that flags the initiative when relevant work changes.
  After the person's separate behavior approval, test reassignment (both old and
  new initiatives), an empty reference, an unrelated edit and a repeated no-op.
  A literal assignment must not accidentally bind fields from the event record.
- Reopen offline and revisit Studio and Use. Ask the person to inspect Light and
  Dark, keyboard paths and tab drafts. Record observed and reported results
  separately; an unchecked UI path stays unchecked.
- If two agent clients are available, hand the same stable work item from one
  to the other. Release editing authority, read current criteria and evidence
  from the receiving client, and record its next result without overwriting the
  first client's work. Confirm that an edit lease does not imply task ownership;
  report client trust prompts separately from Nendo's native approvals.
- Give records short human references and try using one in conversation, Studio
  lookup and a relationship picker. Separate required-field checks from actual
  uniqueness/automatic-numbering support. Rename a title on the disposable file
  and confirm its reference and relationships survive; report any manual upkeep.

## Phase 9 — An operations room somebody else built

Use `workspace/Nendo Station.nendo`, a fictional habitat kept as a reference
application, or a disposable copy of it. Every other phase asks you to build; this
one asks you to arrive at a finished file cold, as a person handed a tool would.
Read nothing about it first.

- Open it and stay on whatever it opens with. From that page alone, say what this
  file is for, how the station is doing, and what you would look at next. Say
  which numbers you trusted and which you had to go and check.
- Find how many systems are in each condition, and which of those matter most.
  There is more than one screen that answers it. Say which you found first, which
  you would use again, and whether any two of them disagree.
- Open one system. Say what the page tells you about capacity, what it tells you
  about its parts, and what it tells you about the readings. Then find a system
  whose page carries a field the first one did not, and work out why.
- Some numbers on this file are worked out rather than typed. Find one. Establish
  which, and say whether the screen made that clear or you had to infer it.
- Take a component out of service using whatever the app offers. Say what changed,
  everywhere you can see it, and how long each of those took to catch up. Then say
  what did **not** change, and whether you expected it to.
- Raise an incident against a system that has none. Something else changes as a
  result. Find it, say what it was, and say whether you could tell it was the
  file's doing rather than yours. Undo it and say how you knew you had.
- The schematic is a custom view whose code the file carries. Get from the open file
  to it without being told how. If it says its package is not in this file, record
  what it offered, and ask the person to add it. Once there: find a loop, and say how
  you know it is a loop rather than a long line. Select a component and ask what would be lost
  without it. **It answers in two different ways for two different components:
  state both in your own words, and say whether you believe the distinction or
  think it is decoration.** Then say what the view claims about failure, in your
  words, and whether the screen earned that claim.
- Anything the schematic told you: check whether the file agrees. Say what the
  view could be wrong about and still look right.
- Ask an agent to add a distinction the file does not draw — temporary
  workarounds against permanent repairs, or one of your own. Read the diff and say
  whether you could accept it without trusting the agent, then accept it and say
  whether you got what you asked for.
- Close the file and reopen it offline with no agent. Say what still works.

## Phase 10 — A view that lives in the file

A custom view is a small web page whose code the file itself carries, as a package. A
view that is shown runs, inline in the app, with nothing to install and no permission to
give. Use the empty review file, at Shape app. Learn what you need from the wire — the
vocabulary, the examples and the resources — and not from the person.

- Before you write, record what the wire told you, and where: the operations that write a
  package, how large one operation's payload may be and how a larger file is sent, the
  bounds on files, packages and change sets, the kinds of node that show a view and what
  each requires, and how a view's own code reaches the file's records. Say whether
  anything told you what that code will be able to do once it runs.
- Author a small view in one change set: a package with an HTML entry point and a script,
  and a screen that shows it over a record type that has a few records, one field
  calculated and one a decimal with more digits than a JavaScript number keeps. Keep your
  own SHA-256 of every file. Validate, and read what the preview says about each file and
  about what the code can do. Ask the person to open the review and say whether they could
  accept this code without trusting you.
- After the person accepts, ask them to show the screen, without telling them where it is.
  Record whether they found it, whether the view ran at once, and what it shows. Ask
  whether its numbers match Studio's to the last digit.
- While the view is on screen, ask the person to change one of its records in Studio and
  come back. Say whether the view followed, and what told it to.
- Change one line of the script in a new change set, have it accepted, and ask whether the
  view now runs the new code, and what the person had to do for that.
- Read every file back through the resources, one of them from a folder with its path
  percent-encoded, and compare each SHA-256 with your own. Record the minimum host the file
  states now, and whether the review told you before you accepted.
- Ask the person to turn views off for this device, and then for this file only, and to
  say each time what the screen showed instead and what it offered. Then both on again.
- Ask the person to right-click inside the running view and choose Inspect. In the
  Console, with the view's frame chosen as the context (the drop-down that starts at
  `top`), ask them to run these one at a time: `parent.document`,
  `top.location.href = 'https://example.com/'`,
  `fetch('https://example.com/', { mode: 'no-cors' })`, and a query of a record type
  through the view's own API. Record each answer as reported: the first two must fail
  without moving the app, the fetch reaches the network, and the query is the one way
  into the file.
- Author a second version whose button starts a loop that never ends, have it accepted,
  and ask the person to press it. Record how long before the app said the view was not
  responding, what it offered, whether the rest of the app answered meanwhile, and what
  Stop and then Reload did.
- Put the repository's `extensions/work-dependencies` package into the file over MCP. One
  of its files is a 1.6 MB layout engine that runs in a Web Worker. Record how you learned
  to send it in parts, how large each part could be once encoded as base64, and how many
  mutations the whole package took. Then show it over two record types where one links
  the other, and ask the person to group it by a field, hide a status, find an item and
  mark the longest chain. Record what they reported, and whether those choices were still
  there after they reopened the file.
- Open the planner's Work dependencies view, select a work item, and ask the person to
  press Complete there. Record what the line below the drawing said, whether the graph
  showed it Done without a reload, and what History names as the author. Then change the
  same item in Studio, press Plan now in the view without reloading it, and record what it
  said and whether anything changed.
- Author a view that changes records: a button that marks the selected record done
  through `nendo.commands.run`, and one that renames it through `nendo.records.update`.
  Ask the person to use both, then open History and say what it names as the author of
  each change, and whether Compensate undoes it. Then change the record in Studio and
  press the view's button again without reloading the view: record what the view was
  told, and whether anything changed. Ask whether they expected Nendo to ask before a
  view changed their records.
- Ask the person, without an agent, to show the package on a second screen and as a
  panel on a record page, from Studio → Surfaces → Custom views. Record whether the
  package's card told them where it was already shown, whether the form let them choose
  anything that would not work (ask them to try a graph over a record type nothing links),
  and where they were taken after accepting. Compare what the review showed with what you
  would have sent.
- Try what must not work, and record whether each refusal named the rule and what to do
  instead, and whether it came where you sent it or only at validation: a record-page
  panel placed as a root, a panel with a record type of its own, a filter on a
  calculated field, a configuration that is not a JSON object, a file under `_nendo/`,
  and a file of 5 MiB. Read the file afterwards to confirm that nothing reached it.
  Then define a view whose package the file does not carry, which is allowed, and
  record what validation said about it and what the screen shows.
- Ask the person to develop the package from its folder: Studio → Surfaces → Custom
  views, **Develop from folder…**. Change the view's page in the folder and ask them what
  the view shows and how long it took. Record what told them the view was not running
  the file's code, and whether the view could hide that. Then break
  `nendo-package.json` and record what the view says. Ask them to press **Save to
  file…**, and compare the review with the folder. Read the file before and after:
  nothing but the accepted save may reach it.
- Ask the person to remove the package from the file, and to say what the screen shows
  afterwards. Then have them compensate that removal from History, and say whether the
  view came back.

## What to produce

`findings.md` in your working directory, with raw responses under `evidence/`:

- What you built, in one paragraph.
- **What surprised you**, ranked. This is the most valuable section.
- **What cost you time**: every round trip you spent on something the interface could have
  told you, with the exact call you made and what you expected.
- **What you could not learn from the wire** and had to guess or ask for.
- A table of every refusal: what you tried, the code that came back, whether the message
  named the thing and offered a remedy.
- Anything you believe is a defect, with the smallest reproduction you can write.
- What you did *not* test, and why.

Two rules for the report. Separate what you measured from what the person told you — label
anything they observed as reported, not as checked. And describe rather than grade: "the
third attempt succeeded after two refusals that did not name the field" is worth more than
"good" or "needs improvement".

Do not fix anything. You are reviewing, not repairing.
