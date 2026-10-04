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

declare module 'claude-code' {
  interface PluginState {
    'nendo-planner': { snapshot: Snapshot | null }
  }
}
