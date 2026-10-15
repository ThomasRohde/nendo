import type { OpEventResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { GateFile, GateStep } from '../types'
import { bar, gateLine, gateShown, gateView, SHOWN_AFTER_END_MS } from '../hooks/gate'

// The full gate's progress bar (2026-10-15): Test-Production.ps1 writes artifacts/gate-progress.json
// (tools/GateProgress.psm1) and the band draws how far it has got. Run with `claude plugin test`.

const T0 = Date.parse('2026-10-15T10:00:00Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

function step(id: string, expectedSeconds: number | null, started?: number, ended?: number): GateStep {
  return { id, label: id.toUpperCase(), expectedSeconds, startedAt: started === undefined ? null : at(started), endedAt: ended === undefined ? null : at(ended) }
}

function run(steps: GateStep[], fields: Partial<GateFile> = {}): GateFile {
  const current = steps.find(s => s.startedAt !== null && s.endedAt === null)?.id ?? null
  return { version: 1, processId: 4242, startedAt: at(0), updatedAt: at(0), state: 'running', current, failure: null, steps, ...fields }
}

test('the bar is weighted by how long each step took in the last passing run', () => {
  // 100 s done, then 150 s into a 300 s step, of 500 s in all: half way.
  const view = gateView(run([step('a', 100, 0, 100), step('b', 300, 100), step('c', 100)]), T0 + 250_000)
  expect(view.fraction).toBe(0.5)
  expect(view.stepNumber).toBe(2)
  expect(view.stepCount).toBe(3)
  expect(view.stepLabel).toBe('B')
  expect(view.elapsedSeconds).toBe(250)
  expect(view.remainingSeconds).toBe(250)
})

test('a step that runs long holds short of its end rather than passing it', () => {
  const view = gateView(run([step('a', 100, 0), step('b', 100)]), T0 + 1_000_000)
  expect(view.fraction).toBe(0.475)
})

test('steps no run has timed weigh the median of those that were, and no estimate is made from guesses', () => {
  const view = gateView(run([step('a', 10, 0, 10), step('b', null, 10), step('c', null), step('d', null)]), T0 + 10_000)
  // a=10 done of 10+10+10+10: the untimed ones weigh the median, 10.
  expect(view.fraction).toBe(0.25)
  expect(view.remainingSeconds).toBe(null)
})

test('a run that ended says how, and a run whose process is gone is not drawn as running', () => {
  const passed = gateView(run([step('a', 5, 0, 5)], { state: 'passed', current: null, updatedAt: at(5) }), T0 + 6_000)
  expect(passed.fraction).toBe(1)
  expect(gateLine(passed, 10)).toBe('Gate ██████████ passed in 0:05')

  const failed = gateView(run([step('a', 5, 0, 5), step('b', 5, 5, 7), step('c', 5)], { state: 'failed', current: null, failure: 'boom', updatedAt: at(7) }), T0 + 8_000)
  expect(gateLine(failed, 10)).toContain('failed at B after 0:07')

  const gone = gateView(run([step('a', 5, 0)]), T0 + 3_000, false)
  expect(gone.state).toBe('interrupted')
  expect(gateLine(gone, 10)).toContain('stopped at A')
})

test('a finished run is shown for ten minutes and then goes; a running one stays', () => {
  const passed = gateView(run([step('a', 5, 0, 5)], { state: 'passed', current: null, updatedAt: at(5) }), T0 + 6_000)
  expect(gateShown(passed, T0 + 5_000 + SHOWN_AFTER_END_MS - 1)).toBe(true)
  expect(gateShown(passed, T0 + 5_000 + SHOWN_AFTER_END_MS)).toBe(false)
  expect(gateShown(gateView(run([step('a', 5, 0)]), T0 + 999_999_000), T0 + 999_999_000)).toBe(true)
})

test('the bar fills its cells in proportion', () => {
  expect(bar(0.5, 10)).toEqual({ filled: '█████', empty: '░░░░░' })
  expect(bar(0, 10).filled).toBe('')
  expect(bar(1.4, 10).empty).toBe('')
})

test('/gate reads the file the gate writes, and says once when a watched run ends', async ($, on) => {
  const root = 'C:/work/nendo'
  let file = run([step('a', 100, 0, 100), step('b', 100, 100)])
  let now = T0 + 150_000
  const toasts: string[] = []
  on('session.root', async () => ({ value: root }))
  on('clock.now', async () => ({ value: now }))
  on('fs.read', async ($, e): Promise<OpEventResult<'fs.read'>> =>
    e.path.replace(/\\/g, '/') === `${root}/artifacts/gate-progress.json` ? { value: JSON.stringify(file) } : { deny: 'no file' })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '"pwsh.exe","4242","Console","1","90,000 K"', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('ui.toast', async ($, e) => { toasts.push(e.text); return { value: undefined } })

  const running = await $.command.run({ command: 'gate', args: '', origin: { kind: 'plugin', name: 'test' }, presentation: { layout: 'main', columns: 100 } } as any)
  expect(running.text ?? '').toContain('75% · 2/2 B · 2:30')
  expect(toasts).toEqual([])

  file = run([step('a', 100, 0, 100), step('b', 100, 100, 190)], { state: 'passed', current: null, updatedAt: at(190) })
  now = T0 + 200_000
  const ended = await $.command.run({ command: 'gate', args: '', origin: { kind: 'plugin', name: 'test' }, presentation: { layout: 'main', columns: 100 } } as any)
  expect(ended.text ?? '').toContain('passed in 3:10')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('passed in 3:10')
})

test('the band draws the bar while a run goes, on each surface', async ($, on) => {
  const root = 'C:/work/nendo'
  const file = run([step('a', 100, 0, 100), step('b', 100, 100)])
  on('session.root', async () => ({ value: root }))
  on('clock.now', async () => ({ value: T0 + 150_000 }))
  on('fs.read', async ($, e): Promise<OpEventResult<'fs.read'>> =>
    e.path.replace(/\\/g, '/') === `${root}/artifacts/gate-progress.json` ? { value: JSON.stringify(file) } : { deny: 'no file' })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '"pwsh.exe","4242"', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  await $.command.run({ command: 'gate', args: '', origin: { kind: 'plugin', name: 'test' }, presentation: { layout: 'main', columns: 100 } } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'nendo-planner', surface, component: 'AbovePrompt', props: { bodyColumns: 100, hasSurvey: false } } as any)
    const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text ?? '')
    expect(texts).toContain('Gate ')
    expect(texts.some(text => /^█+$/.test(text))).toBe(true)
    expect(texts.some(text => /^░+$/.test(text))).toBe(true)
    expect(texts.some(text => text.includes('75% · 2/2 B'))).toBe(true)
    await ui.unmount()
  }
})
