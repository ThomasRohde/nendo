---
title: Calculations and actions
description: Calculated fields, reusable functions, automatic actions and triggers, their limits, and why a file with triggers needs approval on each computer.
group: Use
order: 30
---

A Nendo file can hold four kinds of behaviour beside its records and screens:

| Kind | What it does |
| --- | --- |
| Calculation | A field that is computed from other values each time it is read. Nobody types into it. |
| Function | A reusable formula with typed parameters. Calculations call it by name. |
| Action | Ordered steps that set a field, create a record or delete a record. |
| Trigger | Runs an action when a record of one type is created, updated or deleted. |

Behaviour is part of the app definition. You add or change it through a change set that becomes a proposal, and a person accepts the proposal. An agent writes these definitions through the MCP server. Studio shows them but has no editor for them. See [Agents](/nendo/docs/agents) for the authoring flow and [Concepts](/nendo/docs/concepts) for the terms.

## Calculated fields

A calculated field belongs to one record type. It has a result type, a formula and a list of bindings. It has no stored column, and no edit, import or agent write can set it. A write that names one is refused as `NENDO_FIELD_CALCULATED`.

### Result types

A formula works with five kinds of value: `Integer` (64-bit whole number), `Decimal` (exact .NET decimal), `Boolean`, `Text` and `Date` (a calendar date). Each can be declared to allow an empty result. Stored date-time, UUID and reference values are valid data, but a formula cannot use them as values. A reference only resolves a binding.

Numbers stay exact from the file to the screen and to an agent. A decimal total never passes through a floating-point number.

### Bindings

A formula cannot name a field directly. Each name in a formula is a binding, and the binding states where the value comes from by stable ID. A rename of a record type or a field therefore changes no formula. A binding's name, like a function's parameters and call aliases, uses letters, digits and underscore and does not start with a digit: a formula would read `unit-price` as `unit` minus `price`. A binding that follows an optional reference must accept an empty value, and `IsEmpty(x) ? 0 : x` then gives the default.

| Binding | Reads |
| --- | --- |
| `SameRecordField` | A stored field on the same record |
| `SameRecordCalculation` | Another calculated field on the same record |
| `ReferenceTraversal` | A stored field on the record that one reference field points to |
| `RelatedAggregate` | A total over the records that reference this one |
| `SubtreeAggregate` | A total over the records under this one, at every level, in a record type kept as a tree |
| `HierarchyPath` | The record's place in a record type kept as a tree, as 1.2.3, with an optional prefix such as `CAP-` |

A related aggregate is one of three:

- **Count** counts the related records. An empty set gives 0.
- **FilteredCount** counts the related records whose Boolean field is true.
- **Sum** adds an Integer or Decimal field over the related records. An empty set gives 0. The field must be required, because a missing value is an error and not a zero.

A filtered count or a sum can also read a calculated field of each related record: name its calculation in `predicateCalculationId` or `valueCalculationId` instead of the stored field. An invoice can total its lines' calculated totals, and a client the totals of its invoices. Each related record counts against the limit of 256 related records a calculation reads. Its own calculation is worked out as its own read would be, with its own function calls and related records, and only once however many totals read it.

A subtree aggregate is one of the same three, over the records under this one; `includeSelf` adds the record itself. A related aggregate with `acrossSubtree` counts or totals the records that point at this record or at anything under it.

A hierarchy path follows a move at once, because it is worked out on every read. That makes it a display code, not a name to write down: a code people repeat belongs in a numbered field.

An aggregate never returns a partial total. If there are more related rows than the limit, or the total does not fit exactly in the result type, the calculation fails.

### Operators

| Operator | Takes | Gives |
| --- | --- | --- |
| `+` `-` `*` `%` | two numbers | a whole number, or a decimal if either side is decimal |
| `/` | two numbers | always a decimal, also for whole ÷ whole |
| `==` `!=` | two values of the same kind | true or false |
| `<` `<=` `>` `>=` | two numbers, dates or texts | true or false |
| `and` `or` | true or false | true or false; the right side is skipped when the left side decides |
| `not`, unary `-` | true or false, a number | the same kind |
| `? :` | a condition and two values | one of the two values; the other side is not evaluated |

Operators bind in this order, tightest first: `not` and unary `-`; `*` `/` `%`; `+` `-`; `<` `<=` `>` `>=`; `==` `!=`; `and`; `or`; and `? :` last. Operators of one level group from the left, so `a - b - c` is `(a - b) - c`. Two readings differ from some other languages:

- `not` binds tighter than a comparison: `not a == b` means `(not a) == b`. Write `not (a == b)`, or `a != b`.
- A choice inside a choice goes in parentheses, in either outcome: `x > 90 ? 'A' : (x > 80 ? 'B' : 'C')`. Without them the formula is refused, and the refusal says to add them.

Text and true/false values never become numbers: `'2' + 1` and `true + 1` are refused when the definition is installed. Power, bitwise operators, lists, member access and any undeclared name are also refused.

### Functions

The function set is closed:

| Function | Result |
| --- | --- |
| `RoundEven(number, digits)` | Decimal rounded to 0–28 digits, halves to even |
| `RoundAway(number, digits)` | Decimal rounded to 0–28 digits, halves away from zero |
| `Date(text)` | A date from `yyyy-MM-dd` text; an invalid date is an error |
| `DaysBetween(start, end)` | Signed whole number of days |
| `AddDays(date, days)` | The date that many days later, or earlier for a negative number: `AddDays(issued, terms)` is a due date |
| `Concat(a, b, …)` | 2 to 8 texts joined |
| `TextLength(text)` | Number of UTF-16 code units: most characters count as 1, an emoji outside the Basic Multilingual Plane as 2; empty text is 0 |
| `ToText(value)` | A number or a date as text: `42`, `12.5`, `2026-10-13`. Use it inside `Concat`, as in `Concat('INV-', ToText(number))`. A yes/no is refused; write `paid ? 'Yes' : 'No'` |
| `Refuse(text)` | No value; the calculation fails with your text as the reason |
| `IsEmpty(value)` | True when the value is empty; never empty itself |

No function reads a clock, a file, the network or any other part of the computer. The same inputs always give the same result.

Use `Refuse` in one branch of a choice to reject a value, for example `rating > 5 ? Refuse('Ratings go from 1 to 5') : rating`. A formula that can only refuse is invalid.

### Reusable functions

A function has a display name, typed parameters, a result type and a formula. A calculation calls it through a call alias, for example `Percent(done, total)`. A function can call other functions. Calls in a loop are refused, and a chain of definitions can be at most 16 deep.

### Empty results and errors

A result is a value, an empty value or an error.

- An empty input stops the formula when it is used in arithmetic, a comparison, a condition or a function argument. It never counts as 0 or false. `IsEmpty` is the exception: `IsEmpty(billable) ? true : billable` gives an empty value a default.
- If the calculation allows an empty result, the result is empty. If not, the result is an error.
- A division by zero, an overflow, an invalid date, a text that is too long, a refusal or a limit gives an error with a reason.
- If a calculation reads another calculation that failed, it fails too and names that input.

One failed calculation does not affect the other fields of the record. The stored input stays saved. When you correct the input, the calculation recovers.

## Automatic actions and triggers

A trigger belongs to one record type. It subscribes to one or more of the events **Created**, **Updated** and **Deleted**. An update subscription can name the fields that matter, and then fires only when one of them changes. A trigger can also carry a Boolean condition.

An action is a list of steps. Each step is one of:

- `SetField`: set fields on a record;
- `CreateRecord`: create a record;
- `DeleteRecord`: delete a record.

A step targets the record that raised the event (`EventRecord`), or the record that one reference field on it points to (`ReferencedRecord`). If that reference is empty, the step writes nothing and the save still commits. Make the reference field required if every event must reach a target.

A formula cannot produce a reference, so a `CreateRecord` step sets the new record's references with `links`: each names a reference field and points it at the event record, or at the record one of its references names. A new project can create its kickoff task with the task's Project set to that project.

A step writes ordinary record data through the same checks as a person's edit: record versions, required fields and reference targets. It cannot change a definition, the schema, access settings or anything outside the file.

### Order and atomicity

A save and every change its actions make are one transaction and one revision. All of it is stored, or the file does not change.

1. Nendo stages the whole edit.
2. It compares the staged state with the state before the edit. A field set to the value it already had is no change and raises no event.
3. For each event, in a stable order, it runs the matching triggers in order of their stable ID. Each step sees the effects of the steps before it.
4. Writes made by actions raise their own events, which join the same queue.
5. Nendo commits once.

If an action cannot complete, if a limit is reached, or if the save is cancelled, nothing is saved. The refusal names the action, the trigger that ran it, the step and the field, whatever stopped it: a formula, a limit, or the write itself, such as a required field or a delete that other records block. If only a trigger's condition cannot be evaluated, that action does not run and the edit still commits. The save then says which action did not run and why, after a custom view's write too (`blockedConditions` over MCP). A save that runs out of its own budget inside a condition still saves nothing; a limit the data itself reaches, such as a subtree past the hierarchy's descendant bound, only stops that action.

Nendo checks an action against the schema when it is installed, so a step that could never run is refused then rather than at the next save. It refuses a binding that starts from a record the step does not read, a relevant field that is not a stored field of the trigger's record type, a result that can never be stored in its field (such as text into a number, or a decimal into a whole number unless the formula rounds to 0 digits), and a `CreateRecord` step that leaves a required field empty. A later change that makes a field optional under a formula that needs a value, or makes a step have to fill a field it leaves empty (by requiring it, making it active again or removing its sequence), is refused too.

The save result lists every other record that the actions changed (`alsoChanged` over MCP). History records which trigger, action and step produced each change: open the entry with **View changes**, and each change an action made reads "made by the automatic action" and the trigger's name. Reversing the save reverses the edit and every change its actions made, and does not run the actions again.

Nothing runs when a file opens, when a screen draws, or when a person approves the actions. Actions run only when a record changes.

## Worked example

This is taken from the `calculate-and-act-automatically` example that the MCP server publishes at `nendo://application/examples`. A project counts its tasks, and a new task marks its project active. These are three of the operations in that change set. The record types, fields and the `taskProject` reference come earlier in it.

```json
[
  {
    "operationType": "behaviour.setDefinition",
    "payload": {
      "definitionId": "project.totalHours",
      "definitionKind": "Calculation",
      "body": {
        "entityId": "project",
        "fieldId": "totalHours",
        "displayName": "Hours",
        "resultType": "Integer",
        "resultNullable": false,
        "expression": "hours",
        "bindings": [
          {
            "bindingId": "hours", "kind": "RelatedAggregate", "aggregate": "Sum",
            "entityId": "project", "relatedEntityId": "task", "relatedReferenceFieldId": "taskProject",
            "valueFieldId": "taskHours", "resultType": "Integer", "nullable": false
          }
        ],
        "callAliases": []
      }
    }
  },
  {
    "operationType": "behaviour.setDefinition",
    "payload": {
      "definitionId": "project.markActive",
      "definitionKind": "Action",
      "body": {
        "displayName": "Mark the project active",
        "steps": [
          {
            "stepId": "10-status",
            "kind": "SetField",
            "target": { "kind": "ReferencedRecord", "referenceFieldId": "taskProject" },
            "assignments": [
              { "fieldId": "projectStatus", "expression": "'Active'", "bindings": [], "callAliases": [] }
            ]
          }
        ]
      }
    }
  },
  {
    "operationType": "behaviour.setDefinition",
    "payload": {
      "definitionId": "task.onCreated",
      "definitionKind": "Trigger",
      "body": {
        "entityId": "task",
        "displayName": "Mark the project active when a task arrives",
        "events": "Created",
        "actionId": "project.markActive",
        "relevantFieldIds": [],
        "conditionBindings": [],
        "callAliases": []
      }
    }
  }
]
```

The bindings of a step resolve against the record that the step writes to. A step that targets the referenced project can read the project, but not the task that raised the event. Nendo checks each action and its trigger together when either one is installed.

## Limits

The limits belong to the host. A file cannot raise them.

| Resource | Limit |
| --- | ---: |
| Formula length | 2,048 characters |
| Tokens in a formula | 128 |
| Nodes in a parsed formula, and nesting depth | 128, and 24 |
| Depth of the chain of definitions | 16 |
| Functions in a file, or call aliases in one formula | 32 |
| Definitions in a file, of all kinds | 256 |
| Bindings or parameters in one formula | 16 |
| Stable ID or alias length | 128 characters |
| Text value length | 4,096 UTF-16 code units |
| Work units per evaluation or save | 16,384 |
| Function calls per record | 64 |
| Related rows read per record, and by any one total | 256 |
| Records written by actions, per record saved | 64 |

A save and all the actions it starts share one budget. If a chain of triggers reaches a limit, the whole save is refused. A save of several records has each record's function calls, related rows and writes, so a batch is allowed what its records would be one by one, but the work units are the save's whatever its size. Reading the record being worked out, or one the save itself names or creates, is not a related row. A refused save names the action step that spent the most. These limits bound the work a formula can do. They are not a memory sandbox or a time limit.

## What a person sees

A calculated field is shown, but it is not offered for editing. It has four states: a value, empty, still calculating, or failed. A failure reads differently when it was an input that failed:

| On screen | Meaning |
| --- | --- |
| The value | The calculation produced a value. |
| Not set | An input was empty, and the calculation allows an empty result. |
| Calculating… | Nendo is still working it out. |
| Cannot calculate | The calculation failed. The reason is shown beside it. |
| Unavailable | An input calculation failed. The input is named. |

Studio shows the formula below the value. A finished screen in Use shows the value and a *Calculated* mark, without the formula. A total on a summary tile that does not fit exactly in its type reads *Unavailable* with the reason.

## Calculated fields on screens

A calculated field can appear on any screen: a record page, a list column, a board card, or a related list. A list can also be sorted by one, or filtered on one: *Tasks is 0* lists the records nothing points at. Nendo works that out over every record the list could show, up to 10,000 of them; past that, add a filter on an ordinary field to narrow it.

A calculated whole number or decimal can also feed a summary tile or a breakdown chart, and rank a ranked list. Nendo works it out over the same records, up to 10,000, and adds the results exactly. An empty result adds nothing; if one record's result could not be worked out, the tile says so and shows no total rather than one that leaves that record out.

A calculated field still cannot group a screen or place a record on a timeline, because the database decides those over every matching record and a calculated field has no column. A screen that uses one for any of these is refused with `NUI214`, and the refusal names the field:

- group a board or a breakdown chart;
- place a record on a calendar, a timeline, a trend chart or an activity grid;
- be the rows or columns of a matrix;
- feed a trend chart or range tile;
- be set by a command step.

A form made only of calculated fields is refused with `NUI215`, because it has nothing to save. See [Screens](/nendo/docs/screens).

## Approval on this computer

A file that carries a trigger cannot be edited until a person approves its actions on this computer. A file with calculations and no trigger needs no approval, because a calculation writes nothing.

**Why.** Actions change data without a person pressing anything. A file you receive can carry actions that somebody else wrote. Nendo does not let them run until you have seen what they may do: add records, change records or delete records.

**Until you approve.** The file opens, reads, calculates, exports and backs up. Only editing is off, for people and agents alike. Undo in History still works, and so does an agent's undo of its own change: an undo runs no action, so it is the way back from what an action did after you withdraw its approval. The status pill reads *Approval needed*. Nendo never switches a trigger off to let a save through.

**Where to approve.** Use *Approve automatic actions* under Health (in File status) or on the Agent page. A proposal's review says beforehand whether accepting it needs approval first, or pauses editing until you approve. *Withdraw approval* takes it back. The panel shows a short digest of the rules, so two different sets of rules look different.

**What it covers.** An approval names the application, this copy of the file, the exact rules, the behaviour contract version, the definition revision, and the kinds of change the actions can make. Any accepted change to the definition asks again, also one that adds only a screen.

**Where it lives.** Approval is stored on this computer, under `%LocalAppData%\Nendo`, never in the `.nendo` file. A file cannot carry its own permission. A Duplicate, a Fork, or the same file on another computer asks again. A copy made in Explorer and a restored backup keep the file's identity, so on this computer the approval still covers them while their rules and definition revision are the ones you approved. A missing or damaged approval record approves nothing.

**The Unattended exception.** At the Unattended access level, accepting a change set over MCP also records this computer's approval for the actions that the change installs. The person can withdraw it under Agent or Health. Below Unattended, no MCP tool or resource can reach the approval. See [Agents](/nendo/docs/agents).
