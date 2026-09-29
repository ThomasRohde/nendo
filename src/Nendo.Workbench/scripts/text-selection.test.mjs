import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Headings, labels and buttons were selectable everywhere: a press that slid a few pixels
// swept a selection across the page, which no Windows app does. The shell now selects
// nothing by default and restates `text` on what people copy. WebView2 builds no selection
// from synthetic pointer events, so this holds the rule itself; an agent-run probe of
// every screen in both themes measured no selectable text outside the list below.
const base = readFileSync(new URL('../src/styles/03-base.css', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../src/styles/11-agent-access.css', import.meta.url), 'utf8');
const view = readFileSync(new URL('../src/view-agent.ts', import.meta.url), 'utf8');

const rule = (css, selector) => {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

test('the page selects nothing by default', () => {
  const body = base.slice(base.search(/\nbody \{\n  background/), base.indexOf('}', base.search(/\nbody \{\n  background/)));
  assert.match(body, /\n  user-select: none;/, 'body no longer turns selection off');
  assert.match(body, /-webkit-user-select: none;/);
});

test('what people copy stays selectable', () => {
  const at = base.indexOf('input,\ntextarea,\n[contenteditable="true"],');
  assert.notEqual(at, -1, 'the selectable list is gone');
  const list = base.slice(at, base.indexOf('}', at));
  for (const selector of ['input', 'textarea', 'code', 'pre', 'output', '[role="alert"]', '.message-slot']) {
    assert.ok(list.includes(selector), `${selector} is no longer selectable`);
  }
  assert.match(list, /\n  user-select: text;/);
});

test('the server name in the connection sentence wraps as one word', () => {
  // break-all on every code in the panel split "nendo" into "nend" and "o".
  assert.doesNotMatch(rule(agent, '.connection-endpoint code'), /word-break/);
  assert.match(rule(agent, '.connection-endpoint > code'), /word-break: break-all/);
  assert.match(rule(agent, '.connection-endpoint small code'), /white-space: nowrap/);
  assert.doesNotMatch(view, /No credential\./, 'the sentence that added nothing is back');
});
