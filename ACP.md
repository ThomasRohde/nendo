# ACP implementation review

Review completed 2026-10-10. Scope: launched-agent functionality, protocol and process lifecycle, authority boundaries, Agent page, conversation UI, keyboard/accessibility, context mentions, and recovery. **12 findings: 1 P1 and 11 P2.** Review only; product fixes are not part of this task. This tally was written incrementally during the review.

## Checkpoint

- Planner: W-195 — Launch the person's own agent over ACP, in a tab (`nd.work.r.acp.launch`), Within accepted scope, Review; related delivered iterations included.
- Owner reports Codex, Claude Code and Copilot work. A fresh read-only protocol smoke also passed for all three; scope and versions are below.
- Initial checkout has an unrelated untracked `workspace/Copilot.nendo`; preserve it and all owner files.
- Deliverable: this report. Review probes and screenshots live in task-owned ignored scratch; the temporary provider test is removed from the test project at handoff. No product source edits.
- Remaining product work: triage and fix these findings, add guards and falsify each fix. No fixes or falsifications of proposed fixes are claimed. The repository gate is blocked by the open Garden file; native installed UI, installer, and full production lanes were not run for this review.

## Prioritized tally

P1 = high impact; P2 = material defect or friction; P3 = minor issue. Each finding distinguishes source evidence from executed reproduction. Reviewed HEAD: `04095035a168b0d49050ecfbb85168dcfb7c00f2`.

| ID | Priority | Finding | Evidence so far |
| --- | --- | --- | --- |
| ACP-07 | P1 | Late responses from a replaced conversation contaminate the new conversation and its revision cursor | Executed delayed-read browser reproduction |
| ACP-12 | P2 | Returning to an idle conversation shows the previous access level and review policy | Executed browser reproduction; host source trace |
| ACP-11 | P2 | Permission cards discard supplied operation content and file diffs | Executed production-source probe; ACP contract |
| ACP-08 | P2 | Handle redaction covers tool payloads but misses messages, thoughts and terminal notices | Executed synthetic-handle source probe |
| ACP-09 | P2 | An agent's own shell tool is labelled Nendo merely because its input mentions a Nendo URI | Executed production-source probe |
| ACP-01 | P2 | Refused startup leaves the agent process alive while the UI says Ended | Executed production-source harness |
| ACP-06 | P2 | Tab duplication and navigation make closing tabs end the wrong lifetime | Executed browser reproductions |
| ACP-02 | P2 | New session clears the message but carries its old context attachments forward | Executed browser reproduction |
| ACP-03 | P2 | The Workbench never drops old transcript entries, defeating the host's 1,000-entry bound | Executed host and renderer model probes |
| ACP-04 | P2 | More opens beyond the clipped content pane at ordinary window widths | Measured browser geometry |
| ACP-05 | P2 | Expanding steps or permission input drops keyboard focus to the document body | Executed keyboard reproduction |
| ACP-10 | P2 | The @ picker can assemble context the host refuses as too large | Executed bound check plus producer trace |

<a id="acp-07"></a>

### ACP-07 — A late response crosses conversation generations

`view-agent-chat.ts:followAgentChat` and `act` choose `chat.key` **after** awaiting a request, rather than capturing and checking the launch generation before it. Responses carry no host conversation identity. A late response from the old conversation is consequently passed to `mergeChat` under the new conversation's key, importing old entry IDs and a larger revision. Subsequent new-session reads use that old revision and miss new entries. **This is a same-file conversation replacement defect:** `host-desktop.ts:249-253` does reject responses across file-session changes, so a cross-file disclosure is not claimed.

Executed in the browser with a completed preview turn and exactly one read response delayed by 1.7 seconds: start New session while that read waits. **Old revision 10; new host revision 1; new host entries 0; UI displays the old prompt, tools, permission answer and reply.** No old preview turn timers were outstanding in this reproduction. Capture a generation token for every read/action, discard responses after it changes, and preferably bind requests/responses to a host-minted conversation ID too. Guard this for launch, file switch, option changes and permission answers; an old permission control must never address a replacement session's reused entry ID.

<a id="acp-01"></a>

### ACP-01 — Refused startup does not end the program

`AgentConversation.StartAsync` calls `End` for unsupported protocol/HTTP capability, session refusal, or handshake timeout. That cancels conversation requests but does not close `AcpConnection`. `DesktopLaunchedAgent.WatchAsync` waits only for process exit or connection close; it does not observe conversation end. `HasEnded` nonetheless becomes true, and `DescribeLaunchableCore` reports no running agent. A refused adapter that keeps stdin open therefore survives until an explicit end, replacement launch, or file close. The tab-close handler skips an already-ended conversation, making closing that tab insufficient. Route every terminal conversation state through process cleanup. Guard: a fake adapter refuses startup and keeps running; assert its PID and session folder disappear before any fixture disposal.

<a id="acp-02"></a>

### ACP-02 — Old attachments survive New session

`view-agent-chat.ts:launchAgent` clears `draft`, `expanded`, and `drawn`, but never calls `resetMentions` or `clearPointedAt`. `agent-mention.ts` keeps `attached` at module scope and redraws it when the new tab mounts. Starting again after composing an unsent message therefore silently carries its selected records/context into the new session, including when switching agents. Reset the entire composer at launch, and invalidate pending asynchronous attachment reads. Guard: select context, start a new session, and measure both visible chips and the next prompt's context payload.

<a id="acp-03"></a>

### ACP-03 — Transcript retention is unbounded in the renderer

`AgentConversation.Add` evicts at 1,000 entries, but `AgentConversation.Read` communicates only changed entries. `agent-chat-model.ts:mergeChat` adds them to a Map without removing evicted IDs. A continuously open Workbench therefore retains and processes the entire conversation; `threadItems`, `waitingForYou`, and `patchChat` scan it repeatedly. A fresh renderer sees a different history from a continuously open one. Publish an eviction watermark or explicit removals and apply it before rendering. Guard: stream more than 1,000 entries and compare host and renderer entry IDs, retained size, and pending permission state.

<a id="acp-04"></a>

### ACP-04 — More is clipped at ordinary window widths

`styles/22-agent-chat.css` places `.chat-more-panel` at `left: 0` relative to More, with a fixed 300px width, inside `.studio-content.is-fill { overflow: hidden }`. It does not flip or clamp to the available space. In the browser preview at 1024px width, the panel's right edge measured **1062.28125px**, outside the viewport; at 900px it was still 1062.28125px. Its settings can be partially or wholly inaccessible. Position within the content bounds, and measure the popup itself, including its rightmost control, at the wrap breakpoints in both themes.

<a id="acp-05"></a>

### ACP-05 — Expanding transcript details loses keyboard focus

`view-agent-chat.ts:patchChat` replaces a whole thread item with `held.replaceWith(next)` after a steps/input toggle, restoring open details but not focus. Browser reproduction: focus `[data-toggle-steps]`, press Enter, and `document.activeElement.tagName` becomes **BODY**. This disrupts keyboard review of what the agent did; the next Tab starts outside the disclosure rather than entering its contents. The same replacement path redraws permission input and changing tool output. Restore the corresponding focused control (or patch it without replacing it), and test repeated keyboard expand/collapse and permission inspection during updates.

<a id="acp-06"></a>

### ACP-06 — Closing a duplicate conversation tab ends the remaining one

`workspace-tabs.ts:newTab` duplicates every current place, including `agentChat`, despite `openTabOn` treating that page as unique. The conversation's `onTabClosed` handler ends the process whenever any closing tab's current place is `agentChat`, without checking another tab still shows it. Browser reproduction: press the tab strip's + on a conversation, measure **2 conversation tabs**, close one, and the remaining conversation reads **Ended**. The inverse also reproduces: navigate that tab to Data, then close it; **0 conversation tabs remain, but `agentSession.list.running.state` is `ready`**. Enforce one conversation owner and an explicit lifecycle independent of a tab's current navigation place. Guard both journeys.

<a id="acp-08"></a>

### ACP-08 — Redaction is incomplete across transcript channels

`AgentConversation.Redact` protects raw tool input, tool content and remote errors. `AppendChunk`, plan content, titles, and `End` do not apply it; `DesktopLaunchedAgent.WatchAsync` passes stderr into `End` unchanged. An agent echoing a grant in its reply/reasoning or diagnostic can therefore put an application handle in the transcript. The existing test covers the tool and permission payloads only. Executed with an explicitly synthetic handle in an `agent_message_chunk`: **agentMessageLeaksSyntheticHandle=True**. No real handle was collected or printed. Apply a common redaction boundary before any transcript content reaches the Workbench, including streaming chunks whose sensitive field is split across updates. Guard each channel and chunk-boundary cases.

<a id="acp-09"></a>

### ACP-09 — The Nendo tool badge can misidentify a shell operation

`AgentConversation.Options.cs:Origin` classifies a tool as `nendo` if **either its title or arbitrary raw input** contains `nendo://` (or a matching tool-name fragment). A normal shell operation that prints a resource address gets the same Nendo badge as a typed MCP call. Executed with title **Run shell command**, kind **execute**, and synthetic input `echo nendo://application/manifest`: **ownShellClassifiedAs=nendo**. This undermines the distinction the UI uses to explain computer access versus file access. Use trustworthy structured routing metadata when available; otherwise say the origin is unknown/agent-reported, rather than inferring authority from payload prose. Guard shell inputs that happen to mention Nendo.

<a id="acp-10"></a>

### ACP-10 — The picker exceeds the host's context budget

`agent-context-model.ts` offers eight attachments and descriptions up to 6,000 characters each; `agent-mention.ts` enforces only the attachment count. `AgentConversation.Context.cs` refuses a combined total above 32,000. Six valid maximum-size picker descriptions therefore make a message unsendable, despite each item and the visible item count being valid. Production validator result: **What a message points at is described in 32.000 characters at most, together.** There is no per-chip size or remaining-budget indication. Labels are also sent unbounded even though the host permits only 120 title characters. Budget/truncate the combined context and labels before adding/sending, preserve the read-more URI, and show which item needs removal if it cannot fit. Guard six large types, eight attachments, and long record/field labels through the UI-to-host boundary.

<a id="acp-11"></a>

### ACP-11 — Permission cards lose the operation details supplied by ACP

`AgentConversation.AskPersonAsync` extracts only title, kind and rawInput, ignoring `toolCall.content` and `locations`; it also ignores content already stored on a known tool when creating the permission entry. `ToolContentText` reduces a diff to `Changed <path>` and discards old/new text. A permission request can legitimately supply its details in the tool-call update, including a diff, without rawInput. The UI then offers Allow/Reject with no way to inspect that supplied operation. Synthetic request with a path and before/after text produced **textLength=0; inputNull=True; title=Edit configuration**; the UI's disclosure is rendered only when input is non-null. Preserve and render the supplied details as bounded, escaped text, with explicit truncation, before asking for a decision. This does not grant Nendo filesystem access. Guard content-only permission requests and diff-only updates. Source: [ACP v1 tool calls and permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls).

<a id="acp-12"></a>

### ACP-12 — The conversation shows an obsolete access level

`renderAgentChat` does not read again for an existing conversation, while `patchChat` takes both the access chip and review hint from cached `chat.level`. A same-address mode change keeps the launched agent and does not touch the conversation revision or raise `LaunchedAgentChanged`; `setAgentMode` refreshes the Agent page only. Browser reproduction: start at Shape app, use the access chip to open Agent, change to Inspect, then select the existing conversation tab: **hostLevel=Inspect; uiLevel=Shape app**. The next agent update can correct it, but while idle the displayed grant and review policy are wrong. Refresh level on mode changes and on conversation activation, or derive it from the current agent status independently of transcript revisions. Guard both downgrade and upgrade, including Unattended's different review policy.

## Coverage and evidence

- Existing focused Workbench tests: `node --test scripts/agent-chat.test.mjs scripts/agent-context.test.mjs scripts/agent-launch.test.mjs scripts/agent-working.test.mjs` from `src/Nendo.Workbench`: **33 passed, 0 failed, 0 skipped**.
- Sandbox infrastructure: initial `dotnet test` exited 1 with no output; sandboxed Chrome could not launch its crash server (`TransactNamedPipe ... 0x6D`). Retrying the same bounded checks outside the sandbox; these are not product test failures.
- Preview startup: the remembered `scripts/run-framework.mjs` no longer exists. Current package command `npm run dev -- --port 5187` starts Vite successfully.
- Desktop ACP tests: `dotnet test tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj --no-restore -p:Platform=x64 --filter 'FullyQualifiedName~DesktopLaunchedAgentTests|FullyQualifiedName~WorkbenchAgentSessionProtocolTests'`: **Passed 25, Failed 0, Skipped 0**.
- Cleanup check: after moving the temporary provider smoke source out of the test project, the same Desktop command rebuilt the test assembly and again returned **Passed 25, Failed 0, Skipped 0**. Ordinary later test runs will not inherit that temporary real-provider test.
- Production-source harness (isolated console, linked unchanged conversation/process sources, minimal command/exception stubs): `dotnet run --project artifacts/acp-review/harness/Review.csproj`. For both `--no-http` and `--refuse-session`: **state=ended; HasEnded=True; processAlive=True; folderExists=True** before disposal. Disposal then cleaned up the fake processes and folders. No `.nendo` file was opened.
- Retention probes: host **1000** entries; `node ../../artifacts/acp-review/model-probe.mjs` from the Workbench retained **1010**, oldest ID **e1**.
- Attachment reproduction in Chrome, real Workbench with scripted preview host: **1 chip before New session, 1 after**, and the next plain message's transcript still said **Pointed at Idea**.
- Repository gate: `pwsh ./tools/Test-Repository.ps1` stopped at the binary-asset interlock: **workspace/Garden.nendo is open in Nendo (Garden.nendo.write-owner is beside it)**. The owner file was left open. This is a blocked check, not a corrupt-file result or a product test failure.
- Real-provider smoke: temporary `AcpReviewSmokeTests.ReadOnlyProviderSmoke`, using `DesktopSessionController` with a distinct disposable empty file per provider, at **Inspect**, asked each to read only `nendo://application/manifest`. Command: `dotnet test tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj --no-restore -p:Platform=x64 --filter 'FullyQualifiedName~AcpReviewSmokeTests' --logger 'console;verbosity=detailed'`. **3 passed**: Claude Agent **0.88.0** (14s, 2 tool entries), Codex **2.1.1** (19s, 1 tool entry), Copilot **1.0.94** (46s, 1 tool entry). All reached ready, finished, named `nendo.application`, and had **0 pending permission requests**. No permission was auto-approved. Each controller was disposed afterward. This is real provider/protocol evidence without the native window, not a fresh installed UI journey or write test.

## Coverage assessment

| Area | What was inspected or exercised | Practical limit |
| --- | --- | --- |
| Launch/catalog/device settings | Five known commands, PATH resolution, renamed npm shims, custom command and hidden-agent persistence; existing Desktop and Workbench tests pass | No installs, updates or provider login changes performed |
| ACP transport and handshake | JSON-RPC framing/correlation, version and HTTP capability refusal, unknown methods, timeout, sign-in, cancellation, unexpected process exit, stderr, Job Object cleanup; fake-agent tests plus production-source probes | Fresh real-provider sign-in and Windows-host crash timing not exercised |
| MCP authority | Typed MCP endpoint only, fs/terminal capabilities off, access gate, actor restriction, file-session binding, data/proposal paths and level changes traced; fake tests and real Inspect reads | No real-provider mutation, proposal acceptance, billing limits or account failure scenarios |
| Options and content | Current config options and legacy modes/models tests, offered-value validation, Markdown escaping, text bounds, transcript merge, tool updates and plans | Synthetic refused-model selection correctly restored; not a finding. ACP resources/images/audio remain the documented text-oriented presentation |
| Agent page | Activity/Launch/Connect, level change, launch, hide/copy models, running-agent route, status polling and keyboard selection inspected; browser launch exercised | Preview catalog is scripted; actual providers tested through Desktop services separately |
| Conversation UI/UX | Light and Dark screenshots inspected; sizes 1440, 1280, 1024, 900, 800, 760; composer docking, More, mentions, New session, Stop, permission controls, disclosure focus, tabs and delayed reads measured | Browser preview, not WinUI/WebView2 rendering, native DPI, screen-reader speech, or owner usability acceptance |
| Recovery and lifecycle | File close, Off, moved endpoint and child cleanup in existing tests; startup refusal, replacement reads and tab ownership probed | Installed renderer-crash/restart journey and computer shutdown not run |

The 58 existing focused tests and three fresh provider smoke checks pass while the findings above reproduce. The existing node tests mainly exercise pure models; they do not pin the cross-module DOM, asynchronous generation and host/renderer lifetime cases uncovered here. Add the stated guards to lanes that already run, then falsify each against its original defect when implementing fixes.

Accepted scope is kept distinct from defects: no `session/load`, no transcript persistence, one launched agent per file window, no host-provided filesystem/terminal capability, and no sandbox over the agent's own tools are ADR-0030 decisions. No new provider framework, permanent transcript store or remote service is proposed by this review.

## Suggested repair order

1. Bind all conversation requests/responses to a generation (ACP-07); refresh access policy independently of transcript activity (ACP-12).
2. Make permission details, redaction and origin labels dependable (ACP-11, ACP-08, ACP-09).
3. Unify terminal cleanup and tab ownership; reset composer context on replacement (ACP-01, ACP-06, ACP-02).
4. Synchronize retention, clamp menus, preserve keyboard focus and budget context (ACP-03, ACP-04, ACP-05, ACP-10).

## Source index at the reviewed revision

| Findings | Primary locations |
| --- | --- |
| ACP-07 | `src/Nendo.Workbench/src/view-agent-chat.ts:190`, `:333`; `agent-chat-model.ts:49`; host conversation response in `src/Nendo.Desktop/Agents/DesktopSessionController.LaunchedAgent.cs` |
| ACP-12 | `src/Nendo.Workbench/src/view-agent-chat.ts:214`, `:317`, `:364`; `src/Nendo.Desktop/DesktopAgentAccess.cs:264` |
| ACP-01 | `src/Nendo.Desktop/Agents/AgentConversation.cs:113`, `:357`; `DesktopLaunchedAgent.cs:45`, `:78`; `src/Nendo.Workbench/src/view-agent-chat.ts:99` |
| ACP-02 | `src/Nendo.Workbench/src/view-agent-chat.ts:152`; module state, `choose` and `resetMentions` in `agent-mention.ts` |
| ACP-03 | `src/Nendo.Desktop/Agents/AgentConversation.cs:550`; `src/Nendo.Workbench/src/agent-chat-model.ts:49` |
| ACP-04 | `src/Nendo.Workbench/src/styles/22-agent-chat.css:214`, `:962` |
| ACP-05 | `src/Nendo.Workbench/src/view-agent-chat.ts:423` |
| ACP-06 | `src/Nendo.Workbench/src/workspace-tabs.ts:124`, `:157`; `view-agent-chat.ts:99` |
| ACP-08 | `src/Nendo.Desktop/Agents/AgentConversation.cs:494`, `:648`; `DesktopLaunchedAgent.cs:78` |
| ACP-09 | `src/Nendo.Desktop/Agents/AgentConversation.Options.cs:55` |
| ACP-10 | `src/Nendo.Workbench/src/agent-context-model.ts:77`; `src/Nendo.Desktop/Agents/AgentConversation.Context.cs:22`, `:44` |
| ACP-11 | `src/Nendo.Desktop/Agents/AgentConversation.cs:398`, `:612`; `src/Nendo.Workbench/src/agent-chat-model.ts:permissionMarkup` |

Small review scratch is under `artifacts/acp-review/`: the linked-source harness, renderer model probe, provider smoke source, two screenshots, and command logs. These are disposable reproductions, not a retained evidence archive or a replacement for regression tests. `chat-light.png` shows the permission/composer layout; `chat-dark-clipped.png` shows the clipped More control at 1024px. No installer or owner installation was changed; builds were test dependencies, not a new app deliverable.

## Planner handoff

Prepared **ACP review 2026-10-10 — 12 findings and measured evidence**, proposal `proposal-53922d3db6e6a69f4a91b9ccba2b7e8f`. Validation returned **previewable, isValid=true, 17 operations, no diagnostics**. It contains 12 Findings, four Checks and the next-action handoff on W-195 (`nd.work.r.acp.launch`). The edit lease was released. **The proposal has not been accepted or applied.** W-195 remains in Review; completion of this review does not mark the feature Done. References for the proposed new records are assigned by Nendo on acceptance.

## Fix pass

Fixed 2026-10-10, all twelve findings. Each guard runs in a lane that already runs, and each
was watched failing with its defect put back (the text below is the failure quoted from that
run); with the fixes in place all pass. Falsification restored the exact bytes of every file.

| Finding | Fix | Failure with the defect put back |
| --- | --- | --- |
| ACP-07 | Every read carries a host-minted `conversationId`; the tab fixes the launch key before a request goes out and drops a late answer, `mergeChat` never merges another conversation, and a request naming a replaced one is refused as `agent-conversation-replaced`. | Node `agent-chat.test.mjs`: `ACP-07: a late read from a replaced conversation changes nothing` — `Expected values to be strictly deep-equal`. Desktop `ARequestMeantForAReplacedConversationIsRefused`: `Assert.ThrowsExactly failed. Expected exception type:<NendoPreconditionException> but no exception was thrown.` |
| ACP-12 | A new level raises `LaunchedAgentChanged` (preview host too); the tab reads again whenever it is shown and when the Agent page changes the level. | Browser `Review-AgentChat.ps1`: `ACP-12: the Agent page is at Inspect; the conversation still shows Shape app.` Desktop `AnotherLevelKeepsTheAgentAndOffEndsIt`: `Actual value <0> is not greater than expected value <0>. … The tab was not told the level changed; it would go on showing Edit data.` |
| ACP-11 | A permission request keeps its tool call's content (a diff as path, before and after, each cut at 8,000) and locations as the entry's text, or the known tool's; the card offers **Show what it does** whenever there is text or input. | Desktop `APermissionShowsTheChangeTheAgentSupplied`: `String '' does not contain string 'C:/work/config.json'. The permission card does not say what it changes.` Node: `ACP-11 … The card offers no way to see what the operation does.` |
| ACP-08 | One redaction boundary: every entry's text, title and input are redacted as they are read, plus plan items, the End notice (stderr) and the snapshot notice; the pattern also takes `application_handle`, prose `:`/`=` forms and a value cut off at the end of a streaming message. | Desktop `AHandleTheAgentRepeatsIsHiddenInEveryPartOfTheTranscript`: `Assert.DoesNotContain failed. … The agent's application handle reached the tab.` |
| ACP-09 | `Origin` judges only from the tool's `_meta` name, its title and its kind; input is never evidence, and an `execute` tool is the agent's own unless its metadata names Nendo's tool. | Desktop `AShellCommandThatMentionsNendoIsStillTheAgentsOwn`: `expected "agent" … actual OriginOf("Run shell command") … A shell whose input names nendo:// was told as Nendo's.` |
| ACP-01 | `DesktopLaunchedAgent.WatchAsync` also waits on the conversation's new `Ended`, and ends the program and removes its folder when the conversation ends first. | Desktop `AnAgentRefusedAtTheHandshakeIsEndedWithItsFolder` (`--no-http`, `--refuse-session`): `The agent refused with --no-http kept running after its conversation ended.` and the same for `--refuse-session`. |
| ACP-06 | A new tab beside a one-of-a-kind page starts from the place before it (or the Agent page); the conversation ends when the last tab whose trail holds it closes (`tab-set.ts` `trailForNewTab`, `trailHolds`). | Browser: `ACP-06: + made 2 tabs of one conversation` and, separately, `ACP-06: the conversation's own tab went on to Data and was closed, and the agent ran on with no tab.` Node `navigation-trail.test.mjs`: `A conversation tab that went on to Data lost the conversation.` |
| ACP-02 | Launch (and so New session) calls `resetMentions`, which also moves a composer generation on, so a record still being read for an old chip is dropped. | Browser: `ACP-02: the new session still shows 1 thing(s) the old message pointed at.` |
| ACP-03 | Each read carries `firstOrder`, the oldest entry kept; `mergeChat` drops every entry before it. | Node: `ACP-03 … The tab kept entries the host had let go.` Desktop `TheTabIsToldWhichEntriesTheTranscriptStillKeeps`: `Actual value <1> is not greater than expected value <1>. … The read does not say the oldest entries are gone.` |
| ACP-04 | More's panel is placed from the composer (`right: 8px; bottom: calc(100% + 6px); width: min(300px, 100% - 16px)`), not from More. | Browser: `ACP-04: at 1024px in light, More opens at {"left":762.28125,"right":1062.28125,…}, outside the content pane {…"right":1024…} or the window (1024).` — the review's measurement exactly. |
| ACP-05 | `patchChat` puts focus back on the replaced item's counterpart control (by fold, answer or position). | Browser: `ACP-05: opening the steps with Enter left the keyboard on BODY`. |
| ACP-10 | `withAttachment` cuts a description to the room left of the host's 32,000, keeping its read-more address, refuses an item that cannot fit and names the largest to take back; `contextForHost` cuts names to 120. `readMore` no longer cuts off its own address at 6,000. | Node `agent-context.test.mjs`: `The descriptions came to 48000 characters; the host takes 32000 together, and refuses the message.` |

New lane: `tools/Review-AgentChat.ps1` (with `Gate-AgentChat.mjs` and
`Workbench-PreviewServer.mjs`) drives the built Workbench against the browser preview's
scripted agent in Edge, and is run by `Test-Production.ps1`. It measures ACP-12, ACP-05,
ACP-04 (1,024, 900, 800 and 760 px, light and dark, including the rightmost control in
sight), ACP-02 and both ACP-06 journeys. It does not cover WebView2, native DPI or a real
agent program; the Desktop tests cover the host against the stand-in agent.

Checks run with the fixes in place:

- `dotnet test tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj --no-restore -p:Platform=x64 --filter 'FullyQualifiedName~DesktopLaunchedAgentTests|FullyQualifiedName~WorkbenchAgentSessionProtocolTests'`: **Passed 32, Failed 0**.
- `node --test scripts/agent-chat.test.mjs scripts/agent-context.test.mjs scripts/agent-launch.test.mjs scripts/agent-working.test.mjs`: **37 passed, 0 failed**; `navigation-trail.test.mjs` passes with the ACP-06 test.
- `pwsh -NoProfile -File tools/Review-AgentChat.ps1`: passed, 0 browser exceptions.
- Falsification: 5 node, 6 browser and 8 Desktop failures, quoted above (the Desktop ones in one build with all seven host defects back: 8 failed, 22 passed).
