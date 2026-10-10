async page => {
  // The conversation tab of a launched agent (ADR-0030), driven in the built Workbench against the
  // browser preview host, which plays the agent from a script. Each check measures one defect of
  // the ACP review of 2026-10-10 (ACP.md): the level shown, keyboard focus, where More opens, what
  // New session keeps, and which tab owns the conversation. A failure names the last check passed.
  const checks = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
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

  // ACP-12: a level changed on the Agent page shows in the conversation when the person comes back,
  // down and up, with what that level does with a change.
  for (const [mode, label, hint] of [['inspect', 'Inspect', 'It can read this file, not change it'], ['editData', 'Edit data', 'Records it changes are saved at once']]) {
    await page.click('#chat-access');
    await until(() => document.querySelector('[data-agent-mode]') !== null, null, 'the Agent page');
    await setLevel(mode);
    await goToTab(agent);
    try {
      await until(label => document.querySelector('#chat-level')?.textContent === label, label, `the level ${label}`, 3000);
    } catch {
      throw Error(`ACP-12: the Agent page is at ${label}; the conversation still shows ${await text('#chat-level')}.`);
    }
    // What the level does with a change, as the empty conversation says it (the hint under the box
    // names a waiting proposal first, and the preview has one).
    const empty = await text('.chat-empty');
    assert(empty !== null && empty.includes(`works at ${label}`) && empty.includes(hint), `ACP-12: at ${label} the conversation says "${empty}".`);
  }
  checks.push('ACP-12 the level shown follows the Agent page');

  // ACP-05: the keyboard stays on a fold the person opens or closes, and Tab goes into what it showed.
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
  assert(at.steps === stepsKey && at.expanded === 'true', `ACP-05: opening the steps with Enter left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  await page.keyboard.press('Tab');
  at = await focusOn();
  assert(at.item === stepsKey, `ACP-05: Tab after opening the steps went to ${JSON.stringify(at)}, not into them.`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  at = await focusOn();
  assert(at.steps === stepsKey && at.expanded === 'false', `ACP-05: closing the steps with Enter left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  await page.locator('[data-toggle-input]').focus();
  await page.keyboard.press('Enter');
  at = await focusOn();
  assert(at.input !== null && at.expanded === 'true', `ACP-05: showing what a permission does left the keyboard on ${at.tag} ${JSON.stringify(at)}.`);
  assert(await page.locator('.chat-permission pre').count() > 0, 'ACP-05: the permission request shows nothing after Show what it does.');
  await page.click('[data-answer-entry][data-option-id="allow"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply');
  checks.push('ACP-05 keyboard focus stays on a fold');

  // ACP-04: More opens inside the content pane and the window at the widths the composer wraps at,
  // in both themes, with its rightmost control in sight.
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
        const controls = [...panel.querySelectorAll('select')];
        const last = controls.reduce((right, control) => !right || control.getBoundingClientRect().right > right.getBoundingClientRect().right ? control : right, null);
        const lastRect = rect(last);
        const hit = document.elementFromPoint((lastRect.left + lastRect.right) / 2, (lastRect.top + lastRect.bottom) / 2);
        return { panel: rect(panel), pane: rect(pane), last: lastRect, window: window.innerWidth, lastInSight: hit === last || last.contains(hit) };
      });
      more.push({ width, theme, right: Math.round(box.panel.right), paneRight: Math.round(box.pane.right) });
      const inside = box.panel.left >= box.pane.left - 0.5 && box.panel.right <= Math.min(box.pane.right, box.window) + 0.5 && box.panel.top >= box.pane.top - 0.5;
      assert(inside, `ACP-04: at ${width}px in ${theme}, More opens at ${JSON.stringify(box.panel)}, outside the content pane ${JSON.stringify(box.pane)} or the window (${box.window}).`);
      assert(box.last.right <= box.panel.right + 0.5 && box.lastInSight, `ACP-04: at ${width}px in ${theme}, More's rightmost control is cut off or covered: ${JSON.stringify(box.last)}.`);
      await page.keyboard.press('Escape');
      await until(() => document.querySelector('details.chat-more')?.open === false, null, 'More to close');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.querySelector('[data-theme-option="light"]')?.click());
  checks.push('ACP-04 More opens in sight');

  // ACP-02: New session starts the composer again: what the old message pointed at goes, and the
  // next message points at nothing.
  await page.locator('#agent-prompt').fill('@');
  await until(() => document.querySelector('#chat-mention:not([hidden]) [data-choice]') !== null, null, 'the @ menu');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelectorAll('#chat-attachments .chat-attachment').length === 1, null, 'the chip');
  await page.click('#new-agent-session');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-empty') !== null, null, 'the new session');
  const chips = await page.locator('#chat-attachments .chat-attachment').count();
  assert(chips === 0, `ACP-02: the new session still shows ${chips} thing(s) the old message pointed at.`);
  await page.locator('#agent-prompt').fill('hello');
  await page.locator('#agent-prompt').press('Enter');
  await until(() => document.querySelector('.chat-you') !== null, null, 'the message');
  const pointed = await text('.chat-you .chat-you-context');
  assert(pointed === null, `ACP-02: the new session's first message went with what the old one pointed at: "${pointed}".`);
  await until(() => document.querySelector('[data-toggle-input]') !== null, null, 'the permission request');
  await page.click('[data-answer-entry][data-option-id="reject"]');
  await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply');
  checks.push('ACP-02 New session starts the composer again');

  // ACP-06: a new tab beside the conversation is not a second conversation tab, and closing it
  // leaves the agent running; the conversation's own tab, gone on to Data, still ends the agent.
  await goToTab(agent);
  await page.click('#tab-new');
  await page.waitForTimeout(300);
  let now = await tabs();
  const conversationTabs = now.filter(tab => tab.label === agent).length;
  assert(conversationTabs === 1, `ACP-06: + made ${conversationTabs} tabs of one conversation: ${JSON.stringify(now)}.`);
  const added = now.find(tab => tab.active);
  assert(added.label !== agent, 'ACP-06: the new tab is not the one on screen.');
  await page.click(`#tab-strip [data-close-tab="${added.index}"]`);
  await page.waitForTimeout(500);
  await goToTab(agent);
  assert(await text('#chat-state-label') !== 'Ended', 'ACP-06: closing a new tab beside the conversation ended the agent.');
  assert(!(await said()).some(line => line.includes('ended with its tab')), 'ACP-06: closing a new tab beside the conversation ended the agent.');
  await page.click('#nav-data');
  await until(() => document.querySelector('[data-agent-chat]') === null, null, 'Data');
  now = await tabs();
  await page.click(`#tab-strip [data-close-tab="${now.find(tab => tab.active).index}"]`);
  try {
    await until(() => window.__said.some(line => line.includes('ended with its tab')), null, 'the agent to end', 3000);
  } catch {
    throw Error('ACP-06: the conversation\'s own tab went on to Data and was closed, and the agent ran on with no tab.');
  }
  checks.push('ACP-06 the conversation\'s tab owns it');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, more, checks, errors };

  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
