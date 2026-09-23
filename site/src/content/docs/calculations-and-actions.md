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

Behaviour is part of the app definition. You add or change it through a change set that becomes a proposal, and a person accepts the proposal. Today an agent writes these definitions through the MCP server. Studio shows them but has no editor for them. See [Agents](/nendo/docs/agents) for the authoring flow and [Concepts](/nendo/docs/concepts) for the terms.

## Calculated fields

A calculated field belongs to one record type. It has a result type, a formula and a list of bindings. It has no stored column, and no edit, import or agent write can set it. A write that names one is refused as `NENDO_FIELD_CALCULATED`.

### Result types

A formula works with five kinds of value: `Integer` (64-bit whole number), `Decimal` (exact .NET decimal), `Boolean`, `Text` and `Date` (a calendar date). Each can be declared to allow an empty result. Stored date-time, UUID and reference values are valid data, but a formula cannot use them as values. A reference only resolves a binding.

Numbers stay exact from the file to the screen and to an agent. A decimal total never passes through a floating-point number.

### Bindings

A formula cannot name a field directly. Each name in a formula is a binding, and the binding states where the value comes from by stable ID. A rename of a record type or a field therefore changes no formula.

| Binding | Reads |
| --- | --- |
| `SameRecordField` | A stored field on the same record |
| `SameRecordCalculation` | Another calculated field on the same record |
| `ReferenceTraversal` | A stored field on the record that one reference field points to |
| `RelatedAggregate` | A total over the records that reference this one |

A related aggregate is one of three:

- **Count** counts the related records. An empty set gives 0.
- **FilteredCount** counts the related records whose Boolean field is true.
- **Sum** adds an Integer or Decimal field over the related records. An empty set gives 0. The field must be required, because a missing value is an error and not a zero.

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

Text and true/false values never become numbers: `'2' + 1` and `true + 1` are refused when the definition is installed. Power, bitwise operators, lists, member access and any undeclared name are also refused.

### Functions

The function set is closed:

| Function | Result |
| --- | --- |
| `RoundEven(number, digits)` | Decimal rounded to 0–28 digits, halves to even |
| `RoundAway(number, digits)` | Decimal rounded to 0–28 digits, halves away from zero |
| `Date(text)` | A date from `yyyy-MM-dd` text; an invalid date is an error |
| `DaysBetween(start, end)` | Signed whole number of days |
| `Concat(a, b, …)` | 2 to 8 texts joined |
| `TextLength(text)` | Number of characters; empty text is 0 |
| `Refuse(text)` | No value; the calculation fails with your text as the reason |

No function reads a clock, a file, the network or any other part of the computer. The same inputs always give the same result.

Use `Refuse` in one branch of a choice to reject a value, for example `rating > 5 ? Refuse('Ratings go from 1 to 5') : rating`. A formula that can only refuse is invalid.

### Reusable functions

A function has a display name, typed parameters, a result type and a formula. A calculation calls it through a call alias, for example `Percent(done, total)`. A function can call other functions. Calls in a loop are refused, and a chain of definitions can be at most 8 deep.

### Empty results and errors

A result is a value, an empty value or an error.

- An empty input stops the formula when it is used in arithmetic, a comparison, a condition or a function argument. It never counts as 0 or false.
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

A step writes ordinary record data through the same checks as a person's edit: record versions, required fields and reference targets. It cannot change a definition, the schema, access settings or anything outside the file.

### Order and atomicity

A save and every change its actions make are one transaction and one revision. All of it is stored, or the file does not change.

1. Nendo stages the whole edit.
2. It compares the staged state with the state before the edit. A field set to the value it already had is no change and raises no event.
3. For each event, in a stable order, it runs the matching triggers in order of their stable ID. Each step sees the effects of the steps before it.
4. Writes made by actions raise their own events, which join the same queue.
5. Nendo commits once.

If an action cannot complete, if a limit is reached, or if the save is cancelled, nothing is saved. The refusal names the action, the step and the field. If only a trigger's condition cannot be evaluated, that action does not run and the edit still commits.

The save result lists every other record that the actions changed (`alsoChanged` over MCP). History records which trigger, action and step produced each change. Reversing the save reverses the edit and every change its actions made, and does not run the actions again.

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
| Depth of the chain of definitions | 8 |
| Functions in a file, or call aliases in one formula | 32 |
| Definitions in a file, of all kinds | 256 |
| Bindings or parameters in one formula | 16 |
| Stable ID or alias length | 128 characters |
| Text value length | 4,096 characters |
| Work units per evaluation or save | 16,384 |
| Function calls per evaluation or save | 64 |
| Related rows read per evaluation or save | 256 |
| Records written by actions per save | 64 |

A save and all the actions it starts share one budget. If a chain of triggers reaches a limit, the whole save is refused. These limits bound the work a formula can do. They are not a memory sandbox or a time limit.

## What a person sees

A calculated field is shown, but it is not offered for editing. It has four states, and each looks different:

| On screen | Meaning |
| --- | --- |
| The value | The calculation produced a value. |
| Not set | An input was empty, and the calculation allows an empty result. |
| Calculating… | Nendo is still working it out. |
| Cannot calculate | The calculation failed. The reason is shown beside it. |
| Unavailable | An input calculation failed. The input is named. |

Studio shows the formula below the value. A finished screen in Use shows the value and a *Calculated* mark, without the formula. A total on a summary tile that does not fit exactly in its type reads *Unavailable* with the reason.

## What screens cannot do with calculated fields

A calculated field can appear on any screen: a record page, a list column, a board card, or a related list. It cannot drive a query, because the database decides the query over every matching record and a calculated field has no column. A screen that uses one for any of these is refused with `NUI214`, and the refusal names the field:

- sort a list, or filter it;
- group a board or a breakdown chart;
- place a record on a calendar, a timeline, a trend chart or an activity grid;
- be the rows, columns or rank of a matrix or ranked list;
- feed a summary tile, breakdown chart, trend chart or range tile;
- be set by a command step.

A form made only of calculated fields is refused with `NUI215`, because it has nothing to save. See [Screens](/nendo/docs/screens).

## Approval on this computer

A file that carries a trigger cannot be edited until a person approves its actions on this computer. A file with calculations and no trigger needs no approval, because a calculation writes nothing.

**Why.** Actions change data without a person pressing anything. A file you receive can carry actions that somebody else wrote. Nendo does not let them run until you have seen what they may do: add records, change records or delete records.

**Until you approve.** The file opens, reads, calculates, exports and backs up. Only editing is off, for people and agents alike. The status pill reads *Approval needed*. Nendo never switches a trigger off to let a save through.

**Where to approve.** Use *Approve automatic actions* under Health, in File status, or on the Agent page after you accept a proposal that adds actions. *Withdraw approval* takes it back. The panel shows a short digest of the rules, so two different sets of rules look different.

**What it covers.** An approval names the application, this copy of the file, the exact rules, the behaviour contract version, the definition revision, and the kinds of change the actions can make. Any accepted change to the definition asks again, also one that adds only a screen.

**Where it lives.** Approval is stored on this computer, under `%LocalAppData%\Nendo`, never in the `.nendo` file. A file cannot carry its own permission. A copy, a Duplicate, a Fork, a restored backup, or the same file on another computer asks again. A missing or damaged approval record approves nothing.

**The Unattended exception.** At the Unattended access level, accepting a change set over MCP also records this computer's approval for the actions that the change installs. The person can withdraw it under Agent or Health. Below Unattended, no MCP tool or resource can reach the approval. See [Agents](/nendo/docs/agents).
