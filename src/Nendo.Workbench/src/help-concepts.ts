import type { HelpProvider } from './help';

/**
 * How Nendo works: the model a person needs in order to predict what the app will do,
 * written from the contracts and accepted ADRs. Plain text only; the renderer escapes
 * every string. Every claim here names something the code does today.
 */
export const conceptHelp: HelpProvider = () => [
  { id: 'overview', title: 'What Nendo is', category: 'Getting started', summary: 'One local file, a permanent Studio, screens you shape, and agents you can invite — with you accepting every change to the app.', related: ['one-file', 'lanes', 'limits', 'agent-access'], sections: [
    { heading: 'One file is the whole app', paragraphs: [
      'A .nendo file holds everything: your record types, your records, the screens you use them through, any calculations and automatic actions, and the full history of changes. It is one ordinary file in a local folder. An empty file is already a working application; you can start entering data before anything has been designed.',
      'Nendo works offline and never depends on a service or on an agent. Keep the file in a local folder: folders that sync to the cloud are not supported, and Nendo warns when it recognises one.',
    ] },
    { heading: 'Studio is always there', paragraphs: [
      'Data, Structure, Surfaces, History and Health come from Nendo itself, not from the file. No app content and no agent can remove them or hide the route back to your data. The table works before a screen exists, and it still works after a screen breaks.',
    ] },
    { heading: 'Use is the app, Studio is the data', paragraphs: [
      'Use shows the screens defined in this file: forms, lists, boards, galleries, calendars, timelines, record pages and commands. Studio shows every stored field of every record, whatever the screens say. A record opened from a list or board uses its configured form; without one it opens in Studio’s editor.',
    ] },
    { heading: 'You accept every change to the app’s shape', paragraphs: [
      'Records are edited directly and saved as you go. Record types, fields, screens and rules change through a proposal: Nendo tries the change on a private copy of your file, shows you what it does, and only when you accept applies it to the real file. The path is the same whether Studio or an agent proposed the change. There is no build step and no generated code to maintain.',
    ] },
    { heading: 'What Nendo will not pretend', paragraphs: [
      'There is no universal undo; History can reverse many changes, and says which. A file that was changed outside Nendo, or that needs a newer Nendo, is refused rather than guessed at. Agents never receive SQL, a file path or access to your computer; they work through the same typed operations you do.',
    ] },
  ] },

  { id: 'one-file', title: 'The .nendo file and how it opens', category: 'How Nendo works', summary: 'What the file holds, the ways it can open, and what each kind of copy means.', related: ['files', 'history', 'limits'], sections: [
    { heading: 'What is inside', paragraphs: [
      'One database file. It carries an application identity and an instance identity, your record types and fields, your records, the screen definitions, calculations and actions, and the history of every change. While it runs, Nendo also keeps working files beside it — a journal, private copies for proposals, and the backups you ask for. Those belong to Nendo; you never need to manage them.',
    ] },
    { heading: 'Saving is automatic', paragraphs: [
      'Every successful edit is saved as it happens. There is no Save command. When the outcome of a save is unknown — the app was interrupted, or a request timed out — the status bar reads “Save unconfirmed” and offers “Check or retry save”. That reads the receipt of the original request before anything is sent again, so a save is never applied twice.',
    ] },
    { heading: 'How a file opens', paragraphs: ['Nendo classifies a file before anything else runs, and the status pill says which state it is in.'], terms: [
      { term: 'Normal', meaning: 'Everything works: editing, screens, agents and history.' },
      { term: 'Read-only', meaning: 'The file or its folder does not allow writes. You can inspect, read history, export and create a backup. The status pill reads “Read-only”.' },
      { term: 'Recovery required', meaning: 'Nendo found a problem it will not paper over: an integrity failure, a change made outside Nendo, or an interrupted replacement. Custom screens, commands and agent editing are off. Health explains what was found and carries the way out. The status pill reads “Recovery required”.' },
      { term: 'Incompatible', meaning: 'The file needs a newer Nendo than this one. It is refused outright rather than opened in part. Opening an older file never rewrites it.' },
      { term: 'Approval needed', meaning: 'A healthy file whose automatic actions this device has not yet approved. Reading works; editing waits for your approval under Health or on the Agent page.' },
    ] },
    { heading: 'Changed outside Nendo', paragraphs: [
      'Nendo checks the file against what it last wrote. A change made by another program is detected as drift: editing stops and Health asks for recovery. Nendo does not guess a repair.',
    ] },
    { heading: 'What a copy means', terms: [
      { term: 'Raw copy', meaning: 'A copy made in Explorer keeps the same identity. Nendo notices two files with the same identity and does not silently rewrite either.' },
      { term: 'Duplicate', meaning: 'Another instance of the same application, with its history. Use it for a second working copy of the same app.' },
      { term: 'Fork', meaning: 'A new application identity that starts from the current content and remembers where it came from. Use it to branch into something different.' },
      { term: 'Backup', meaning: 'An exact recovery copy with identity and history preserved.' },
      { term: 'Restore', meaning: 'Replaces the current file with a chosen backup through a verified staged copy, and keeps the previous file so nothing is lost.' },
    ], paragraphs: ['No copy overwrites an existing destination. Moving or renaming the file changes nothing inside it.'] },
  ] },

  { id: 'data-model', title: 'Record types, fields, choices and references', category: 'How Nendo works', summary: 'How data is shaped, what a field can hold, and why renaming never breaks anything.', related: ['records', 'screens', 'csv'], sections: [
    { heading: 'Names are labels; IDs are permanent', paragraphs: [
      'Every record type, field, choice option and record has a stable ID that screens, formulas and other records refer to. The name you see is a label on top of it. Renaming a field keeps every stored value, every screen binding and every board column; renaming a record type keeps every reference to it.',
    ] },
    { heading: 'What a field can hold', terms: [
      { term: 'Text', meaning: 'Any text. Short text, long text and a single choice are ways of presenting text, not separate kinds.' },
      { term: 'Integer', meaning: 'A whole number. Large values keep every digit. A rating is a way of presenting one: a whole number on a scale of at most ten values, shown as dots and chosen by clicking one.' },
      { term: 'Decimal', meaning: 'An exact decimal. It is never rounded on the way in or out, and trailing zeros you typed are kept.' },
      { term: 'True or false', meaning: 'A yes-or-no value.' },
      { term: 'Date', meaning: 'A calendar day.' },
      { term: 'Date and time', meaning: 'A moment with its time zone offset.' },
      { term: 'UUID', meaning: 'A universally unique identifier.' },
      { term: 'Reference', meaning: 'A link to one record of another record type.' },
    ], paragraphs: [
      'A field holds one value. There is no multi-choice field, and no file or image field.',
      'A rating’s scale is set when the field is made and does not change afterwards, as no presentation does. The scale bounds how the value is drawn, not what may be stored: a number outside it stays readable as the number it is, marked as a data issue, so declaring a scale over values you already have never rewrites one of them.',
    ] },
    { heading: 'Required and optional', paragraphs: [
      'A required field must hold a value on every record. Making a field required checks every record first: if some have no value, you enter one for each in reviewed batches of up to 50 records. Nothing is filled in automatically.',
    ] },
    { heading: 'Choices', paragraphs: [
      'A single-choice field has a fixed list of options, each with its own stable ID. Renaming an option keeps the records that use it and the board column it groups. A retired option stays visible on the records that already have it, but cannot be newly chosen or used as a drop target.',
      'An option can carry a colour: one of eight named tones, chosen under Edit choices or set by an agent. Its board column, its chips and any record page coloured by that field pick the tone up, in Light and Dark alike. The file stores the name of the tone, never a colour value.',
    ] },
    { heading: 'References', paragraphs: [
      'A reference points at one record type and shows one of its text fields as a label. What is stored is the target record’s ID, so the label can change freely. A record that other records still reference cannot be deleted: clear or reassign those references first. Nothing cascades.',
    ] },
    { heading: 'Retire, do not delete', paragraphs: [
      'A field or record type can be retired. Retiring keeps everything already stored and stops new writes; Studio → Data shows it under Show retired data, and Structure can reactivate it. A screen that still uses the definition blocks retirement until the screen is changed. Reactivating a required field asks for missing values first.',
    ] },
  ] },

  { id: 'screens', title: 'Screens are definitions, not code', category: 'How Nendo works', summary: 'Forms, lists, boards, galleries, calendars, timelines, record pages and commands are stored descriptions that Nendo compiles and checks as a whole.', related: ['data-model', 'calculations', 'lanes'], sections: [
    { heading: 'What a screen is', paragraphs: [
      'A screen is a stored description of meaning, not a program: a form, a record page, a list, a board, a calendar, a timeline or a command, made of sections, tabs, related lists, totals, field bindings, filters and command steps. Nendo compiles that description and draws it. The file never contains HTML, styling, scripts or SQL, so a screen can never run anything on your computer.',
    ] },
    { heading: 'Limits you can plan around', paragraphs: [
      'Each record type can have one form and one record page, and up to eight lists, boards, galleries, calendars, timelines and commands each. A list or board can filter by up to eight conditions, and all of them must match; there is no “or”. A command sets one field per step, and each step advances the record’s version by one.',
      'A total on a list or board is an exact count, sum, minimum or maximum over the whole filtered set, and is labelled with what it covers. There is no average, because the mean of exact decimals is not generally exact. A total that cannot be represented reads “Unavailable” with the reason rather than a rounded number.',
    ] },
    { heading: 'Galleries', paragraphs: [
      'A gallery shows the same records a list would, as a grid of cards: a large title, a coloured edge from a choice field, and the other bound fields underneath. It reads one page at a time with the same Previous and Next a list has, and carries the same totals and charts above it. Cards are typographic, because a field cannot hold an image.',
    ] },
    { heading: 'The front page', paragraphs: [
      'A file can have one front page: a screen that belongs to the whole file rather than to one record type. Because there is no record type behind it, every total, chart, range and recent list on it names the one it reads, and it can show several side by side — how many of this, the newest few of that. It can also carry a sentence of its own, drawn under its title, saying what the page shows.',
      'It never joins two record types together: each number is read over the one type it names, and there is no total made from two of them. Opening a file with a front page shows it first, with every record type still one step away in the same picker; a file without one opens exactly as it did.',
      'A range states the smallest and largest value of one number or date field — 12 to 480, or 3 Jan to 14 Sep. Both ends are shown or neither is, because one end is a bound rather than a range, and a set with no records has no range at all and says so. A recent list shows up to ten records of one type in an order you choose; clicking one opens it on its own record type.',
    ] },
    { heading: 'What the file is for', paragraphs: [
      'A file can say what it is for, in your own words, and it says so whether or not it has a front page. You read it under the file’s name in the file menu, and an agent connecting to the file is told it before anything else — so a file it has never seen arrives explained rather than as a schema to guess from.',
      'It is prose, kept as written. A file nobody has told says nothing at all, rather than something worked out from its file name, and clearing it leaves it saying nothing again. The front page’s own sentence is a different thing: that one belongs to that page.',
    ] },
    { heading: 'Calendars', paragraphs: [
      'A calendar places one Date field on a month grid, with a separate Undated view so a record without a date is never lost. Records load a page at a time, so a day nobody has loaded yet reads “None loaded yet” rather than empty.',
    ] },
    { heading: 'Timelines', paragraphs: [
      'A timeline places records on a spine by one Date field, one year at a time under a heading for every month, with a coloured dot from a choice field and the same Undated view a calendar has. A second Date field turns an entry into a span, drawn to scale from its start date with both dates and the day count beside it; an entry is placed by its start, so a span that began the year before is on that year’s spine, and an end before its start is stated on the entry rather than drawn backwards. Records load a page at a time, so a month nobody has loaded yet reads “None loaded yet” rather than empty.',
    ] },
    { heading: 'When a definition is wrong', paragraphs: [
      'If any part of the screen definition does not compile, Nendo switches off every custom screen rather than drawing part of an app. Your data, Studio and recovery are untouched. Surfaces shows the diagnostic, and a file with no custom screens at all is a valid shape.',
    ] },
    { heading: 'Choosing a view', paragraphs: [
      'In Use, every list, board, gallery, calendar and timeline of a record type is offered by its own title. Which one is open, which tab is selected, which month a calendar shows and which year a timeline shows are remembered for the session only; they are never written to the file.',
    ] },
    { heading: 'Three version numbers', paragraphs: [
      'Nendo has a product version; screen definitions have a contract version; and each file records the minimum Nendo version its shape needs. An older Nendo refuses a newer file outright rather than opening it partially. When a proposal would raise the minimum, the review shows that as its own line, marked not compensatable.',
    ] },
  ] },

  { id: 'calculations', title: 'Calculations and automatic actions', category: 'How Nendo works', summary: 'Calculated fields, reusable functions, actions and triggers — and why running them needs this device’s approval.', related: ['screens', 'lanes', 'agent-access', 'history'], sections: [
    { heading: 'What can be defined', terms: [
      { term: 'Calculation', meaning: 'A field computed from other fields when it is read. Nobody types into it.' },
      { term: 'Function', meaning: 'A reusable expression that calculations call by name.' },
      { term: 'Action', meaning: 'Ordered steps that set a field, create a record or delete a record.' },
      { term: 'Trigger', meaning: 'Runs an action when a record of a type is created, updated or deleted.' },
    ], paragraphs: ['The vocabulary is closed: a small set of functions, arithmetic and comparisons, and today’s date and the current time. No formula can reach the network, a file or anything else on your computer. Numbers stay exact.'] },
    { heading: 'Reading a calculated field', paragraphs: [
      'A calculated field is shown, not offered for editing. It has four states and each looks different on screen: a value; “Not set” when an input somebody left blank stopped a formula that was declared to allow an empty result; “Calculating…” while Nendo works it out; and “Cannot calculate” with the reason beside it — a formula declared always to answer that met a blank, a zero divisor, or a refusal the author wrote in their own words — so a number nobody computed is never mistaken for one.',
      'A calculated field can appear on any screen, but it cannot sort, filter or group a list, place a record on a calendar or a timeline, feed a total, or be set by a command. A form made only of calculated fields is refused. In Use, a finished screen shows the value and a Calculated mark, not the formula.',
    ] },
    { heading: 'Actions run inside your edit', paragraphs: [
      'When you save a record and a trigger fires, the save and every change the action makes are one unit: all of it is stored, or none of it is. If an action cannot complete, nothing is saved and your typing stays on screen with the reason. History records which trigger produced each change, and the save result names every other record that changed.',
    ] },
    { heading: 'Approval belongs to this device', paragraphs: [
      'A file that carries a trigger cannot be edited until you have approved what its actions may do to your data — add records, change records, delete records. The approval names the exact rules, so a changed definition asks again. It is stored on this computer, never in the file: a copy, a Duplicate, a Fork, a restored backup or another computer asks again.',
      'Until then the file still opens, reads, calculates, exports and backs up, and the status pill reads “Approval needed”. Approve or withdraw with “Approve automatic actions” and “Withdraw approval” under Health or on the Agent page. Nothing runs when a file opens, when a screen draws or when you approve — only when a record changes.',
    ] },
    { heading: 'Agents can write rules but not run them', paragraphs: [
      'An agent proposes calculations, functions, actions and triggers like any other change to the app, and you review them the same way. No tool, resource or request reaches the approval; that stays with you.',
    ] },
  ] },

  { id: 'lanes', title: 'Two lanes: editing records and reshaping the app', category: 'How Nendo works', summary: 'Why a record edit is immediate, why a shape change goes through a proposal, and what a review shows.', related: ['history', 'calculations', 'agent-access'], sections: [
    { heading: 'The data lane', paragraphs: [
      'Creating, editing and deleting records, pasting and importing write straight to the file, one history entry per save. Every record carries a version. An edit made against an old version is refused rather than merged, so two edits never silently overwrite each other. A request repeated with the same key returns the original outcome instead of running again.',
    ] },
    { heading: 'The application lane', paragraphs: [
      'Record types, fields, screens, calculations and commands change through a proposal. A proposal is a set of typed operations — nineteen kinds exist, and nothing else can change the shape of an app. Nendo applies them to a private physical copy of your file, validates the result there, and shows you a readable diff.',
      'When you accept, the same validated operations are replayed onto your real file after checking that nothing moved underneath them. The private copy never replaces your file, and rejecting leaves the file byte for byte as it was.',
    ] },
    { heading: 'What a review shows', paragraphs: [
      '“What changes” lists each operation with its reversibility. “What this builds” describes the whole file as it would stand: record types, fields, screens and record counts. Diagnostics appear when something is wrong, and “Accept changes” stays unavailable until they are gone. If the proposal would raise the file’s minimum Nendo version, the review says so.',
      'Studio’s own structure actions — making a field required, retiring, editing choices — use the same lane, which is why they say “Preview changes” and open the same review.',
    ] },
    { heading: 'Proposals go stale', paragraphs: [
      'Each proposal captures the revision it was built on. Accepting one makes any others still waiting stale, and Nendo says so rather than merging them; an agent can rebuild them on the new revision. An ordinary record edit does not stale a proposal that only changes screens.',
    ] },
  ] },

  { id: 'history', title: 'History, versions and what can be undone', category: 'How Nendo works', summary: 'Every change is a revision. Undo is a new change that reverses one, where that is still possible.', related: ['lanes', 'records', 'files'], sections: [
    { heading: 'Three counters', paragraphs: [
      'Changes to the app’s shape advance the definition revision; changes to records advance the data revision; both share one change sequence, so History shows them in order. Every record also carries its own version, which is what a save checks before it applies.',
    ] },
    { heading: 'Reversibility is declared, not assumed', terms: [
      { term: 'Reversible', meaning: 'Nendo can produce the exact inverse: a field set back to its earlier value, a created record removed.' },
      { term: 'Compensatable with retained state', meaning: 'Nendo kept what it needs to restore — a deleted record’s values, a cleared reference, a retired definition — and can restore it while the current state still allows.' },
      { term: 'Not compensatable', meaning: 'There is no inverse: a new record type or field, a conversion, a change of the file’s identity, a raised minimum version. Make a backup first if that matters.' },
    ], paragraphs: ['The class is shown before you accept a proposal and again in History. A backup does not make an irreversible change reversible; it gives you an older file to return to.'] },
    { heading: 'Compensate, not rewind', paragraphs: [
      'Compensate applies a proven inverse as a new history entry. History is never rewritten and nothing disappears from it. A restored record gets a new version. If something changed in between — a referenced record is gone, a field is now required — Nendo refuses rather than overwrites. Reversing a save that fired an automatic action reverses the whole entry, the action’s changes included. This is not universal undo.',
    ] },
    { heading: 'Receipts', paragraphs: [
      'Every write has a durable receipt. “Save unconfirmed” and “Acceptance unconfirmed” mean Nendo did not hear back; “Check or retry” reads the receipt first and only resubmits if the original never landed. A receipt that cannot be found is unresolved — not proof that nothing happened.',
    ] },
    { heading: 'What an entry shows', paragraphs: [
      'Each entry names its lane (Definition or Data), how many operations it holds, who made it — you, an agent, or a trigger acting on your edit — and offers Compensate when the class and the current state allow it. CSV import batches and agent writes are ordinary entries like any other.',
    ] },
  ] },

  { id: 'limits', title: 'What Nendo deliberately leaves out', category: 'How Nendo works', summary: 'Boundaries, stated as boundaries.', related: ['overview', 'agent-surface'], sections: [
    { heading: 'Scope', paragraphs: [
      'Nendo runs on Windows only, as an unsigned per-user install. It is for one person on one computer: there is no collaboration, no cloud sync and no accounts. Folders that sync to the cloud are warned about, not supported. There is no built-in agent; agents connect from their own app. There are no plug-ins, custom controls, scripts or HTML, and no file, image or multi-choice fields. A chart is an exact count or total per option of a choice field, or per yes and no, drawn as proportion with its numbers beside it; there is no free-form charting.',
    ] },
    { heading: 'Safety', paragraphs: [
      'There is no universal undo. Nendo never guesses a repair. A newer file is refused by an older Nendo. Agent access is not an anti-malware boundary: while it is on, anything running on this computer can connect, so it is the wrong posture for a shared machine.',
    ] },
    { heading: 'Agents', paragraphs: [
      'An agent never receives SQL, a file path, a process or the network. It cannot accept its own proposal, approve automatic actions, restore a deleted record or change a file’s identity. Those stay with you, in Nendo.',
    ] },
    { heading: 'Numbers to know', terms: [
      { term: 'CSV import', meaning: 'Up to 16 MiB, 10,000 rows, 100 columns and 65,536 characters per cell, imported in batches of at most 100 rows.' },
      { term: 'Pages', meaning: 'Data, Use and History show 50 items per page. An agent reads up to 100 records or history entries per page.' },
      { term: 'Screens', meaning: 'Up to eight lists, boards, galleries, calendars, timelines and commands per record type, and up to eight filters per query.' },
      { term: 'Agent writes', meaning: 'Up to 50 records in one batch create; up to 128 operations in one proposal.' },
    ] },
  ] },
];
