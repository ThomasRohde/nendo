async page => {
  // The conversation tab of a launched agent (ADR-0030), driven in the built Workbench against the
  // browser preview host, which plays the agent from a script. Each check measures one rule: the
  // level shown, keyboard focus, where More opens, what New session keeps, which tab owns the
  // conversation, a double press on Launch and on Enter, a message that waits, the conversation's
  // tab after Back, Open conversation, open disclosures, and a thing that cannot be pointed at. A
  // failure names the last check passed.
  const checks = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The Workbench never asks with a browser dialog, and the Garden has no reason to. Under
  // playwright-cli a dialog stops the probe at the modal, so the lane fails for want of its
  // result line; one that reaches this handler instead is recorded as a failure and dismissed,
  // never accepted in silence.
  page.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__WORKBENCH_URL__?preview=1');
  // Everything the page says aloud, in order: the live region is rewritten for each message.
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => { const text = document.getElementById('announcement').textContent; if (text) window.__said.push(text); })
      .observe(document.getElementById('announcement'), { childList: true, characterData: true, subtree: true });
  });
  const said = () => page.evaluate(() => window.__said.slice());
  const text = selector => page.evaluate(selector => document.querySelector(selector)?.textContent?.trim() ?? null, selector);
  const until = async (fn, arg, what, timeout = 4000) => {
    try { await page.waitForFunction(fn, arg, { timeout }); } catch { throw Error(`Timed out waiting for ${what}.`); }
  };
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('#tab-strip .tab-main')].map(button => ({
    index: Number(button.dataset.tab), label: button.querySelector('.tab-label')?.textContent ?? '', active: button.getAttribute('aria-selected') === 'true' })));
  const goToTab = async label => {
    const tab = (await tabs()).find(candidate => candidate.label === label);
    assert(tab !== undefined, `No tab is labelled ${label}: ${JSON.stringify(await tabs())}.`);
    if (!tab.active) await page.click(`#tab-strip [data-tab="${tab.index}"]`);
    await until(index => document.querySelector(`#tab-strip [data-tab="${index}"]`)?.getAttribute('aria-selected') === 'true', tab.index, `tab ${label}`);
  };
  const setLevel = async mode => {
    await page.click(`[data-agent-mode="${mode}"]`);
    await until(mode => document.querySelector(`[data-agent-mode="${mode}"]`)?.getAttribute('aria-pressed') === 'true', mode, `level ${mode}`);
  };

  // Launch: Shape app, then the scripted agent from the Launch tab, in a conversation tab of its own.
  await until(() => document.querySelector('#nav-agent')?.disabled === false, null, 'the Agent route');
  await page.click('#nav-agent');
  await setLevel('shapeApp');
  await page.click('[data-agent-tab="launch"]');
  await page.click('[data-launch-agent="copilot"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready', null, 'the agent to be ready');
  const agent = await text('#chat-name');
  assert(await text('#chat-level') === 'Shape app', 'The conversation does not show the level it was launched at.');
  checks.push('launch');

  // A level changed on the Agent page shows in the conversation when the person comes back,
  // down and up, with what that level does with a change.
  for (const [mode, label, hint] of [['inspect', 'Inspect', 'It can read this file, not change it'], ['editData', 'Edit data', 'Records it changes are saved at once']]) {
    await page.click('#chat-access');
    await until(() => document.querySelector('[data-agent-mode]') !== null, null, 'the Agent page');
    await setLevel(mode);
    await goToTab(agent);
    try {
      await until(label => document.querySelector('#chat-level')?.textContent === label, label, `the level ${label}`, 3000);
    } catch {
      throw Error(`the Agent page is at ${label}; the conversation still shows ${await text('#chat-level')}.`);
    }
    // What the level does with a change, as the empty conversation says it (the hint under the box
    // names a waiting proposal first, and the preview has one).
    const empty = await text('.chat-empty');
    assert(empty !== null && empty.includes(`works at ${label}`) && empty.includes(hint), `at ${label} the conversation says "${empty}".`);
  }
  checks.push('the level shown follows the Agent page');

  // The keyboard stays on a fold the person opens or closes, and Tab goes into what it showed.
  await page.locator('#agent-prompt').fill('Add a record type for requests');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelector('[data-toggle-input]') !== null, null, 'the permission request');
  const focusOn = () => page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName ?? null, steps: active?.dataset?.toggleSteps ?? null, input: active?.dataset?.toggleInput ?? null,
      expanded: active?.getAttribute?.('aria-expanded') ?? null, item: active?.closest?.('[data-item]')?.dataset.item ?? null };
  });
  const steps = page.locator('[data-toggle-steps]').first();
  const stepsKey = await steps.getAttribute('data-toggle-steps');
  await steps.focus();
  await page.keyboard.press('Enter');
  let at = await focusOn();
  assert(at.steps === stepsKey && at.expanded === 'true', `opening the steps with Enter left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  await page.keyboard.press('Tab');
  at = await focusOn();
  assert(at.item === stepsKey, `Tab after opening the steps went to ${JSON.stringify(at)}, not into them.`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  at = await focusOn();
  assert(at.steps === stepsKey && at.expanded === 'false', `closing the steps with Enter left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  await page.locator('[data-toggle-input]').focus();
  await page.keyboard.press('Enter');
  at = await focusOn();
  assert(at.input !== null && at.expanded === 'true', `showing what a permission does left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  assert(await page.locator('.chat-permission pre').count() > 0, 'the permission request shows nothing after Show what it does.');
  await page.click('[data-answer-entry][data-option-id="allow"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply');
  checks.push('keyboard focus stays on a fold');

  // The agent's options are on the Agent page (ADR-0033). More opens inside the content pane and
  // the window at the widths the page wraps at, in both themes, with its rightmost control in sight.
  await page.click('#chat-access');
  await until(() => document.querySelector('[data-agent-mode]') !== null, null, 'the Agent page');
  await page.click('[data-agent-tab="launch"]');
  await until(() => document.querySelector('#agent-options .chat-more summary') !== null, null, 'the agent\'s options on the Launch card');
  assert(await page.evaluate(() => document.querySelector('[data-agent-chat]') === null), 'the conversation was still on screen.');
  const more = [];
  for (const width of [1024, 900, 800, 760]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(theme => document.querySelector(`[data-theme-option="${theme}"]`)?.click(), theme);
      await page.waitForTimeout(100);
      await page.click('.chat-more summary');
      await until(() => document.querySelector('details.chat-more')?.open === true, null, 'More to open');
      const box = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const panel = document.querySelector('.chat-more-panel');
        const pane = document.getElementById('studio-content');
        const controls = [...panel.querySelectorAll('select, [data-config-switch]')];
        const last = controls.reduce((right, control) => !right || control.getBoundingClientRect().right > right.getBoundingClientRect().right ? control : right, null);
        const lastRect = rect(last);
        const hit = document.elementFromPoint((lastRect.left + lastRect.right) / 2, (lastRect.top + lastRect.bottom) / 2);
        return { panel: rect(panel), pane: rect(pane), last: lastRect, window: window.innerWidth, lastInSight: hit === last || last.contains(hit) };
      });
      more.push({ width, theme, right: Math.round(box.panel.right), paneRight: Math.round(box.pane.right) });
      const inside = box.panel.left >= box.pane.left - 0.5 && box.panel.right <= Math.min(box.pane.right, box.window) + 0.5 && box.panel.top >= box.pane.top - 0.5;
      assert(inside, `at ${width}px in ${theme}, More opens at ${JSON.stringify(box.panel)}, outside the content pane ${JSON.stringify(box.pane)} or the window (${box.window}).`);
      assert(box.last.right <= box.panel.right + 0.5 && box.lastInSight, `at ${width}px in ${theme}, More's rightmost control is cut off or covered: ${JSON.stringify(box.last)}.`);
      await page.keyboard.press('Escape');
      await until(() => document.querySelector('details.chat-more')?.open === false, null, 'More to close');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.querySelector('[data-theme-option="light"]')?.click());
  checks.push('More opens in sight');

  // An on/off setting of the agent's is a switch, set as it is pressed and said aloud.
  await page.click('.chat-more summary');
  await until(() => document.querySelector('details.chat-more')?.open === true, null, 'More to open');
  const verbose = '[data-config-switch="verbose"]';
  assert(await page.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-pressed'), verbose) === 'false',
    'the agent\'s on/off setting is not drawn as a switch that is off.');
  await page.click(verbose);
  await until(() => (window.__said ?? []).includes('Verbose: On.'), null, 'the switch to be set', 3000)
    .catch(async () => { throw Error(`pressing the switch said ${JSON.stringify((await said()).slice(-2))}.`); });
  assert(await page.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-pressed'), verbose) === 'true', 'the switch did not stay on.');
  await page.keyboard.press('Escape');
  await goToTab(agent);
  checks.push('an on/off setting is a switch');

  // New session starts the composer again: what the old message pointed at goes, and the
  // next message points at nothing.
  await page.locator('#agent-prompt').fill('@');
  await until(() => document.querySelector('#chat-mention:not([hidden]) [data-choice]') !== null, null, 'the @ menu');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelectorAll('#chat-attachments .chat-attachment').length === 1, null, 'the chip');
  await page.click('#new-agent-session');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-empty') !== null, null, 'the new session');
  const chips = await page.locator('#chat-attachments .chat-attachment').count();
  assert(chips === 0, `the new session still shows ${chips} thing(s) the old message pointed at.`);
  await page.locator('#agent-prompt').fill('hello');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelector('.chat-you') !== null, null, 'the message');
  const pointed = await text('.chat-you .chat-you-context');
  assert(pointed === null, `the new session's first message went with what the old one pointed at: "${pointed}".`);
  await until(() => document.querySelector('[data-toggle-input]') !== null, null, 'the permission request');
  await page.click('[data-answer-entry][data-option-id="reject"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply');
  checks.push('New session starts the composer again');

  // A new tab beside the conversation is not a second conversation tab, and closing it
  // leaves the agent running; the conversation's own tab, gone on to Data, still ends the agent.
  await goToTab(agent);
  await page.click('#tab-new');
  await page.waitForTimeout(300);
  let now = await tabs();
  const conversationTabs = now.filter(tab => tab.label === agent).length;
  assert(conversationTabs === 1, `+ made ${conversationTabs} tabs of one conversation: ${JSON.stringify(now)}.`);
  const added = now.find(tab => tab.active);
  assert(added.label !== agent, 'the new tab is not the one on screen.');
  await page.click(`#tab-strip [data-close-tab="${added.index}"]`);
  await page.waitForTimeout(500);
  await goToTab(agent);
  assert(await text('#chat-state-label') !== 'Ended', 'closing a new tab beside the conversation ended the agent.');
  assert(!(await said()).some(line => line.includes('ended with its tab')), 'closing a new tab beside the conversation ended the agent.');
  await page.click('#nav-data');
  await until(() => document.querySelector('[data-agent-chat]') === null, null, 'Data');
  now = await tabs();
  await page.click(`#tab-strip [data-close-tab="${now.find(tab => tab.active).index}"]`);
  try {
    await until(() => window.__said.some(line => line.includes('ended with its tab')), null, 'the agent to end', 3000);
  } catch {
    throw Error('the conversation\'s own tab went on to Data and was closed, and the agent ran on with no tab.');
  }
  checks.push('the conversation\'s tab owns it');

  const saidCount = async (words) => (await said()).filter(line => line.includes(words)).length;
  const launchFromAgentPage = async (twice) => {
    if (await page.locator('[data-agent-tab="launch"]').count() === 0) await page.click('#nav-agent');
    await until(() => document.querySelector('[data-agent-tab="launch"]') !== null, null, 'the Agent page');
    await page.click('[data-agent-tab="launch"]');
    await until(() => document.querySelector('[data-launch-agent="copilot"]:not(:disabled)') !== null, null, 'Launch to be offered');
    // Two presses in one turn of the page, before the first launch's answer can arrive.
    await page.evaluate(twice => { const button = document.querySelector('[data-launch-agent="copilot"]'); button.click(); if (twice) button.click(); }, twice);
    await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready', null, 'the launched agent to be ready');
  };

  // A double press on Launch launches once, and says nothing of an agent already running.
  await launchFromAgentPage(true);
  await page.waitForTimeout(300);
  assert(await saidCount('already running') === 0, `a double press on Launch launched twice: ${JSON.stringify((await said()).slice(-3))}.`);
  assert((await tabs()).filter(tab => tab.label === agent).length === 1, `a double press on Launch made two conversation tabs: ${JSON.stringify(await tabs())}.`);
  checks.push('a double press on Launch launches once');

  // The conversation's tab, gone Back to the Agent page and then on to Data, no longer
  // holds the conversation in its trail; it still owns it, and closing it ends the agent.
  const endedBefore = await saidCount('ended with its tab');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Alt+ArrowLeft');
  await until(() => document.querySelector('[data-agent-chat]') === null && document.querySelector('[data-agent-tab]') !== null, null, 'the Agent page by Back');
  await page.click('#nav-data');
  await until(() => document.querySelector('[data-agent-chat]') === null && document.querySelector('[data-agent-tab]') === null, null, 'Data');
  now = await tabs();
  await page.click(`#tab-strip [data-close-tab="${now.find(tab => tab.active).index}"]`);
  try {
    await until(before => window.__said.filter(line => line.includes('ended with its tab')).length > before, endedBefore, 'the agent to end', 3000);
  } catch {
    throw Error('the conversation\'s own tab went Back to the Agent page and on to Data and was closed, and the agent ran on with no tab.');
  }
  checks.push('the conversation\'s tab owns it after Back');

  // Open conversation goes to the conversation's own tab, wherever it has gone, rather
  // than opening a second tab on the conversation.
  await launchFromAgentPage(false);
  const before = await tabs();
  const owner = before.find(tab => tab.active).index;
  await page.click('#nav-agent');
  await until(() => document.querySelector('[data-agent-tab="launch"]') !== null, null, 'the Agent page in the conversation\'s tab');
  await page.click('[data-agent-tab="launch"]');
  await until(() => document.querySelector('.agent-panel:not([hidden]) [data-open-agent-chat]') !== null, null, 'Open conversation');
  await page.click('.agent-panel:not([hidden]) [data-open-agent-chat]');
  await until(() => document.querySelector('[data-agent-chat]') !== null, null, 'the conversation');
  const after = await tabs();
  assert(after.length === before.length && after.find(tab => tab.active)?.index === owner,
    `Open conversation from the conversation's own tab opened another: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}.`);
  checks.push('Open conversation reuses its tab');

  // Two Enters before the first message's answer send it once, and say no refusal.
  await page.locator('#agent-prompt').fill('Add a record type for requests');
  await page.evaluate(() => {
    const box = document.querySelector('#agent-prompt');
    for (let press = 0; press < 2; press += 1) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await until(() => document.querySelector('[data-toggle-input]') !== null, null, 'the permission request');
  assert(await page.locator('.chat-you').count() === 1, `two Enters sent ${await page.locator('.chat-you').count()} messages.`);
  assert(await saidCount('not ready for a message') === 0, `the second Enter was refused aloud as an error: ${JSON.stringify((await said()).slice(-3))}.`);
  // Enter while the agent works keeps the message and says so on screen, not only aloud.
  await page.locator('#agent-prompt').fill('And a due date');
  await page.locator('#agent-prompt').press('Enter');
  try {
    await until(() => { const note = document.querySelector('#chat-composer-note'); return note !== null && !note.hidden && note.textContent.includes('is working'); }, null, 'the note', 2000);
  } catch {
    throw Error('Enter while the agent works showed nothing on screen.');
  }
  assert(await page.locator('#agent-prompt').inputValue() === 'And a due date', 'the message typed while the agent worked was lost.');
  await page.locator('#agent-prompt').fill('');
  await page.click('[data-answer-entry][data-option-id="allow"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply');
  checks.push('Enter sends once, and a message that waits says so');

  // Two steps at once; the person opens the second's "What it sent", then the first
  // gains "What came back". The one the person opened stays open, and the new one stays closed.
  await page.locator('#agent-prompt').fill('parallel');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelectorAll('.chat-permission [data-answer-entry]').length > 0, null, 'the parallel request');
  const run = await page.evaluate(() => [...document.querySelectorAll('[data-toggle-steps]')].at(-1).dataset.toggleSteps);
  await page.click(`[data-toggle-steps="${run}"]`);
  await until(run => document.querySelector(`[data-item="${run}"] details[data-part$=":sent"]`) !== null, run, 'the second step\'s disclosure');
  const sent = await page.evaluate(run => document.querySelector(`[data-item="${run}"] details[data-part$=":sent"]`).dataset.part, run);
  await page.click(`[data-item="${run}"] details[data-part="${sent}"] > summary`);
  await until(part => document.querySelector(`details[data-part="${part}"]`)?.open === true, sent, 'the disclosure to open');
  await page.click('.chat-permission [data-answer-entry][data-option-id="allow"]');
  await until(run => document.querySelectorAll(`[data-item="${run}"] details[data-part$=":back"]`).length === 2, run, 'the first step\'s output');
  const disclosures = await page.evaluate(run => [...document.querySelectorAll(`[data-item="${run}"] details`)].map(details => ({ part: details.dataset.part ?? null, open: details.open })), run);
  const opened = disclosures.filter(item => item.open).map(item => item.part);
  assert(opened.length === 1 && opened[0] === sent, `the person opened ${sent}; after an earlier step gained output, open are ${JSON.stringify(disclosures)}.`);
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready', null, 'the reply');
  checks.push('an open disclosure stays with its step');

  // Past eight things, the next is refused on screen, and its @name is not written into
  // the message with nothing behind it.
  const box = page.locator('#agent-prompt');
  await box.fill('');
  const chipLabels = () => page.evaluate(() => [...document.querySelectorAll('#chat-attachments .chat-attachment')].map(chip => chip.textContent.trim()));
  // The menu offers a few things for a bare @, and a field or a record by a typed word; each
  // query is tried until one offers something not yet pointed at.
  const queries = ['', 'i', 'e', 'a', 't', 'o', 's', 'n', 'r', 'd', 'l', 'u', 'c', 'm', 'p', 'ti', 'st', 'de', 'no', 'in', 'an', 're', 'er', 'on'];
  const pointedTo = new Set();
  const offerFresh = async () => {
    for (const query of queries) {
      const base = await box.inputValue();
      await box.fill(`${base}${base === '' ? '' : ' '}@${query}`);
      let choices = [];
      try {
        await until(() => document.querySelector('#chat-mention:not([hidden]) [data-choice]') !== null, null, 'the @ menu', 700);
        // A record found by name arrives once the typing pauses.
        if (query.length >= 2) await page.waitForTimeout(400);
        choices = await page.evaluate(() => [...document.querySelectorAll('#chat-mention [data-choice]')].map(choice => ({ index: Number(choice.dataset.choice), text: choice.textContent.trim() })));
      } catch { /* nothing offered for this query */ }
      const fresh = choices.find(choice => !pointedTo.has(choice.text));
      if (fresh !== undefined) return fresh;
      await box.fill(base);
      await page.keyboard.press('Escape');
    }
    return null;
  };
  let refusedAt = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const fresh = await offerFresh();
    if (fresh === null) break;
    if ((await chipLabels()).length === 8) { refusedAt = fresh; break; }
    pointedTo.add(fresh.text);
    await page.click(`#chat-mention [data-choice="${fresh.index}"]`);
    await page.waitForTimeout(250);
  }
  assert(refusedAt !== null, `the preview offers too few things to point at to reach eight; chips ${JSON.stringify(await chipLabels())}.`);
  const typed = await box.inputValue();
  await page.click(`#chat-mention [data-choice="${refusedAt.index}"]`);
  try {
    await until(() => { const note = document.querySelector('#chat-composer-note'); return note !== null && !note.hidden && note.textContent.includes('8 things at most'); }, null, 'the refusal on screen', 2000);
  } catch {
    throw Error(`a ninth thing was refused only aloud: ${JSON.stringify((await said()).slice(-2))}.`);
  }
  const written = await box.inputValue();
  assert(written === typed, `the refused thing's @name was written into the message: "${written.slice(typed.length)}".`);
  assert((await chipLabels()).length === 8, 'the refused thing was pointed at after all.');
  checks.push('a thing that cannot be pointed at is refused on screen');

  // A picture dropped on the message box, or pasted into it, goes with the message (the owner
  // could not drop one): the window's own drop (open a .nendo file) leaves it alone, a file that is
  // not a picture is refused on screen, and the person's entry names the pictures it sent.
  await box.fill('');
  const pictureLabels = () => page.evaluate(() => [...document.querySelectorAll('#chat-pictures .chat-attachment')].map(chip => chip.textContent.trim()));
  const hand = (kind, name, type) => page.evaluate(({ kind, name, type }) => {
    const transfer = new DataTransfer();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    transfer.items.add(new File([type === 'image/png' ? png : 'not a picture'], name, { type }));
    const composer = document.querySelector('#chat-composer');
    const prompt = document.querySelector('#agent-prompt');
    if (kind === 'paste') {
      prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      return { hint: !document.querySelector('#file-drop-target').hidden };
    }
    for (const event of ['dragenter', 'dragover']) prompt.dispatchEvent(new DragEvent(event, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    const hint = !document.querySelector('#file-drop-target').hidden;
    prompt.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return { hint };
  }, { kind, name, type });
  assert(await page.evaluate(() => !document.querySelector('#chat-add-picture').hidden), 'an agent that reads pictures shows no picture button.');
  const dropped = await hand('drop', 'shot.png', 'image/png');
  assert(!dropped.hint, 'a picture held over the message box showed the window\'s open-a-file hint.');
  await hand('paste', 'image.png', 'image/png');
  assert(JSON.stringify(await pictureLabels()) === JSON.stringify(['shot.png', 'Pasted picture 1.png']), `the box holds ${JSON.stringify(await pictureLabels())}.`);
  await hand('drop', 'notes.txt', 'text/plain');
  assert((await text('#chat-composer-note'))?.includes('notes.txt is not a PNG') === true, `a file that is not a picture was not refused on screen: "${await text('#chat-composer-note')}".`);
  assert((await pictureLabels()).length === 2, 'a file that is not a picture was added.');
  await box.fill('What is wrong here?');
  await box.press('Enter');
  await until(() => [...document.querySelectorAll('.chat-you')].some(entry => entry.textContent.includes('What is wrong here?') && entry.textContent.includes('shot.png · Pasted picture 1.png')),
    null, 'the message naming its pictures', 6000);
  assert((await pictureLabels()).length === 0, 'the pictures stayed in the box after the message went.');
  checks.push('a picture dropped or pasted goes with the message');

  // How full the agent's context is shows over the box once the agent says, as a share, with the
  // tokens and cost on hover (the preview agent counts each message).
  await until(() => { const chip = document.querySelector('#chat-usage'); return chip !== null && !chip.hidden && /^\d+% of context$/.test(chip.textContent.trim()); },
    null, 'the context chip', 3000).catch(async () => { throw Error(`the context chip shows "${await text('#chat-usage')}", hidden: ${await page.evaluate(() => document.querySelector('#chat-usage')?.hidden)}.`); });
  const usageTitle = await page.evaluate(() => document.querySelector('#chat-usage').title);
  assert(/of the 200,000 tokens/.test(usageTitle) && /\$\d+\.\d\d so far/.test(usageTitle), `the context chip's hover says "${usageTitle}".`);
  checks.push('the context chip shows how full the agent is');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, more, checks, errors };

  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
