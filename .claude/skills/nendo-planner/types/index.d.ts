export type WorkItem = {
  ref: string
  title: string
  status: string
  isBlocked: boolean
}

export type Planner = {
  now: WorkItem[]
  next: WorkItem[]
  inbox: number
  leaseHolder: string | null
}

export type Snapshot = {
  // .nendo files in workspace/ that Nendo holds open (a .write-owner sidecar beside them)
  open: string[]
  // null when the planner is closed or did not answer
  planner: Planner | null
  problem: string | null
  checkedAt: number
}

// One step of a Test-Production.ps1 run, as tools/GateProgress.psm1 writes it.
export type GateStep = {
  id: string
  label: string
  // Seconds it took in the last run that passed; null when no run has timed it.
  expectedSeconds: number | null
  startedAt: string | null
  endedAt: string | null
}

// artifacts/gate-progress.json
export type GateFile = {
  version: number
  processId: number
  startedAt: string
  updatedAt: string | null
  state: 'running' | 'passed' | 'failed'
  current: string | null
  failure: string | null
  steps: GateStep[]
}

// What the band draws for a run: interrupted is a run still marked running whose process is gone.
export type GateView = {
  state: 'running' | 'passed' | 'failed' | 'interrupted'
  // 0..1, weighted by each step's time in the last run that passed
  fraction: number
  stepNumber: number
  stepCount: number
  stepLabel: string | null
  elapsedSeconds: number
  // null when too few steps have an earlier time to say
  remainingSeconds: number | null
  failure: string | null
  // When the run ended, for hiding a finished run's line after a while; null while it runs
  endedAtMs: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'nendo-planner': { snapshot: Snapshot | null; gate: GateView | null }
  }
}
