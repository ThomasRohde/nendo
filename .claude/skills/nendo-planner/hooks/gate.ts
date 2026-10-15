import type { GateFile, GateStep, GateView } from '../types'

// The full gate's progress, from the file Test-Production.ps1 writes as it runs
// (tools/GateProgress.psm1). Pure: the hooks module reads the file and the clock.

export const GATE_FILE = 'artifacts/gate-progress.json'

// A finished run's line stays this long, then goes.
export const SHOWN_AFTER_END_MS = 10 * 60_000

// A step still running counts at most this share of its expected time, so the bar never
// reaches the end of a step before the step does.
const STEP_CAP = 0.95

// A step no passing run has timed is weighed as the median of those that have, or this.
const UNTIMED_SECONDS = 60

function ms(iso: string | null): number | null {
  if (iso === null) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function parseGateFile(text: string): GateFile | null {
  try {
    const file = JSON.parse(text)
    if (file?.version !== 1 || !Array.isArray(file.steps) || typeof file.startedAt !== 'string') return null
    if (!['running', 'passed', 'failed'].includes(file.state)) return null
    return file as GateFile
  } catch {
    return null
  }
}

/** What to draw for a run at `nowMs`. `alive` is false once the run's process is known to be gone. */
export function gateView(file: GateFile, nowMs: number, alive = true): GateView {
  const timed = file.steps.map(step => step.expectedSeconds).filter((value): value is number => typeof value === 'number' && value > 0)
  const fallback = median(timed) ?? UNTIMED_SECONDS
  const weight = (step: GateStep) => (typeof step.expectedSeconds === 'number' && step.expectedSeconds > 0 ? step.expectedSeconds : fallback)
  const total = file.steps.reduce((sum, step) => sum + weight(step), 0)

  let done = 0
  for (const step of file.steps) {
    const started = ms(step.startedAt)
    const ended = ms(step.endedAt)
    if (ended !== null) done += weight(step)
    else if (started !== null) done += Math.min(Math.max(0, (nowMs - started) / 1000), weight(step) * STEP_CAP)
  }

  const state: GateView['state'] = file.state === 'running' && !alive ? 'interrupted' : file.state
  const currentIndex = file.steps.findIndex(step => step.id === file.current)
  const lastStarted = file.steps.reduce((last, step, index) => (step.startedAt !== null ? index : last), -1)
  const stepIndex = currentIndex >= 0 ? currentIndex : lastStarted
  const endedAtMs = state === 'running' ? null : ms(file.updatedAt) ?? nowMs
  const startedAtMs = ms(file.startedAt) ?? nowMs
  // An estimate only when most steps have an earlier time; otherwise the guess is mostly fallback.
  const estimable = timed.length * 2 >= file.steps.length

  return {
    state,
    fraction: state === 'passed' ? 1 : total > 0 ? Math.min(1, done / total) : 0,
    stepNumber: stepIndex + 1,
    stepCount: file.steps.length,
    stepLabel: stepIndex >= 0 ? file.steps[stepIndex]!.label : null,
    elapsedSeconds: Math.max(0, Math.round(((endedAtMs ?? nowMs) - startedAtMs) / 1000)),
    remainingSeconds: state === 'running' && estimable ? Math.max(0, Math.round(total - done)) : null,
    failure: file.failure,
    endedAtMs,
  }
}

/** Whether a run's line is still worth showing at `nowMs`. */
export function gateShown(view: GateView | null, nowMs: number): view is GateView {
  return view !== null && (view.endedAtMs === null || nowMs - view.endedAtMs < SHOWN_AFTER_END_MS)
}

export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

/** The bar itself: `width` cells, filled to `fraction`. */
export function bar(fraction: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(4, width)
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(cells - filled) }
}

/** The words beside the bar. */
export function gateWords(view: GateView): string {
  const percent = `${Math.floor(view.fraction * 100)}%`
  switch (view.state) {
    case 'passed': return `passed in ${clock(view.elapsedSeconds)}`
    case 'failed': return `failed at ${view.stepLabel ?? 'the start'} after ${clock(view.elapsedSeconds)}`
    case 'interrupted': return `stopped at ${view.stepLabel ?? 'the start'} (its process is gone)`
    default: {
      const left = view.remainingSeconds === null ? '' : ` · ~${Math.max(1, Math.round(view.remainingSeconds / 60))} min left`
      return `${percent} · ${view.stepNumber}/${view.stepCount} ${view.stepLabel ?? ''} · ${clock(view.elapsedSeconds)}${left}`
    }
  }
}

/** One line of text, for /gate and the toast. */
export function gateLine(view: GateView, width = 30): string {
  const { filled, empty } = bar(view.fraction, width)
  return `Gate ${filled}${empty} ${gateWords(view)}`
}
