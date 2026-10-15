import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Test-Production.ps1 says where it has got to in artifacts/gate-progress.json (GateProgress.psm1),
// which the nendo-planner mod draws as a progress bar. These hold the file's shape and the plan
// against the steps the gate enters.
const tools = fileURLToPath(new URL('.', import.meta.url));
const module = join(tools, 'GateProgress.psm1');

function run(script) {
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function withFolder(body) {
  const folder = mkdtempSync(join(tmpdir(), 'gate-progress-'));
  try { body(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
}

const quoted = (path) => `'${path.replace(/'/g, "''")}'`;

test('a run that passes records each step and keeps its seconds for the next run', () => withFolder((folder) => {
  const progress = join(folder, 'gate-progress.json');
  const timings = join(folder, 'gate-timings.json');
  writeFileSync(timings, JSON.stringify({ version: 1, steps: { first: 12.5 } }));
  run(`Import-Module ${quoted(module)} -Force
    Start-GateProgress -Path ${quoted(progress)} -Steps @(
      , @('first', 'First step')
      , @('second', 'Second step')
    ) -TimingsPath ${quoted(timings)}
    Enter-GateStep 'first'
    Enter-GateStep 'second'
    Complete-GateProgress`);
  const read = JSON.parse(readFileSync(progress, 'utf8'));
  assert.equal(read.state, 'passed');
  assert.equal(read.current, null);
  assert.deepEqual(read.steps.map((step) => step.id), ['first', 'second']);
  assert.equal(read.steps[0].expectedSeconds, 12.5, 'The last passing run\'s seconds were not carried.');
  assert.equal(read.steps[1].expectedSeconds, null);
  assert.ok(read.steps.every((step) => step.startedAt !== null && step.endedAt !== null), JSON.stringify(read.steps));
  const kept = JSON.parse(readFileSync(timings, 'utf8'));
  assert.deepEqual(Object.keys(kept.steps), ['first', 'second'], 'A passing run did not keep its seconds.');
}));

test('a run that fails says so and names the failure, and keeps the earlier timings', () => withFolder((folder) => {
  const progress = join(folder, 'gate-progress.json');
  const timings = join(folder, 'gate-timings.json');
  writeFileSync(timings, JSON.stringify({ version: 1, steps: { first: 3 } }));
  run(`Import-Module ${quoted(module)} -Force
    Start-GateProgress -Path ${quoted(progress)} -Steps @(
      , @('first', 'First')
      , @('second', 'Second')
    ) -TimingsPath ${quoted(timings)}
    Enter-GateStep 'first'
    $mid = Get-Content -LiteralPath ${quoted(progress)} -Raw | ConvertFrom-Json
    if ($mid.state -ne 'running' -or $mid.current -ne 'first') { throw "mid-run: $($mid.state) $($mid.current)" }
    Complete-GateProgress -Failure 'Engine tests failed.'`);
  const read = JSON.parse(readFileSync(progress, 'utf8'));
  assert.equal(read.state, 'failed');
  assert.equal(read.failure, 'Engine tests failed.');
  assert.equal(read.steps[1].startedAt, null, 'A step that never ran was marked as started.');
  assert.deepEqual(JSON.parse(readFileSync(timings, 'utf8')).steps, { first: 3 }, 'A failed run overwrote the timings.');
}));

test('Test-Production plans exactly the steps it enters, in the order it enters them', () => {
  const gate = readFileSync(join(tools, 'Test-Production.ps1'), 'utf8');
  const planned = [...gate.matchAll(/, @\('([^']+)', '[^']+'\)/g)].map((match) => match[1]);
  const entered = [...gate.matchAll(/Enter-GateStep (?:'([^']+)'|"dotnet\.\$suite")/g)].flatMap((match) => match[1] !== undefined
    ? [match[1]]
    : [...gate.match(/foreach \(\$suite in @\(([^)]+)\)\)/)[1].matchAll(/'([^']+)'/g)].map((suite) => `dotnet.${suite[1]}`));
  assert.ok(planned.length >= 20, `Only ${planned.length} planned steps were found.`);
  assert.deepEqual(entered, planned, 'The plan and the steps the gate enters differ, so the bar would skip or stall.');
});
