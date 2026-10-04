import type { EngineInterface, Register } from 'claude-code'

import type { Planner, Snapshot, WorkItem } from '../types'

const SNAPSHOT = { plugin: 'nendo-planner', key: 'snapshot' } as const

const PLANNER = 'Planner.nendo'
const EVERY_MS = 60_000
const SHOWN = 3
const CLOSED = new Set(['Done', 'Dropped'])

type $ = EngineInterface

// One stateless JSON-RPC call on the 2026-07-28 discover path, as tools/Nendo-McpClient.mjs makes it.
// Deliberately not an import of that client (W-159): a hook runs on the hook engine's $.http.fetch,
// which returns a whole response, while the client is built on Node's fetch and AbortSignal; the
// two cannot share a transport, and a listen stream (W-151) is out of this engine's reach.
async function rpc($: $, endpoint: string, method: string, params: Record<string, unknown>) {
  const name = (params.name ?? params.uri) as string | undefined
  const response = await $.http.fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'nendo-planner-mod', version: '0.1.0' },
        },
      },
    }),
  })
  if (!response.ok) throw Error(`${method}: HTTP ${response.status}`)
  const messages = (response.headers['content-type'] ?? '').includes('text/event-stream')
    ? response.text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)))
    : [JSON.parse(response.text)]
  const reply = messages.find(m => m.id === 1)
  if (!reply || reply.error) throw Error(`${method}: ${reply?.error?.message ?? 'no reply'}`)
  return reply.result
}

async function openFiles($: $, workspace: string): Promise<string[]> {
  const entries = await $.fs.list(workspace).catch(() => [])
  return entries
    .map(entry => entry.name)
    .filter(name => name.endsWith('.nendo.write-owner'))
    .map(name => name.slice(0, -'.write-owner'.length))
    .sort((a, b) => (a === PLANNER ? -1 : b === PLANNER ? 1 : a.localeCompare(b)))
}

async function plannerEndpoint($: $): Promise<string | null> {
  const local = await $.env.get('LOCALAPPDATA')
  if (!local) return null
  const folder = `${local}/Nendo/Mcp/active`
  const entries = await $.fs.list(folder).catch(() => [])
  let best: { endpoint: string; createdAt: string } | null = null
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    const found = await $.fs.read(`${folder}/${entry.name}`).then(t => JSON.parse(t as string)).catch(() => null)
    if (found?.displayName !== PLANNER || typeof found.endpoint !== 'string') continue
    if (!best || found.createdAt > best.createdAt) best = found
  }
  return best?.endpoint ?? null
}

async function readPlanner($: $, endpoint: string): Promise<Planner> {
  const lease = await rpc($, endpoint, 'tools/call', { name: 'nendo.lease.status', arguments: {} })
  const holder = lease.structuredContent?.hasLease ? lease.structuredContent.clientDisplayName ?? 'someone' : null

  const records: any[] = []
  let cursor: string | null = null
  do {
    const uri = 'nendo://application/entity/nd.work/records?'
      + (cursor ? `cursor=${encodeURIComponent(cursor)}&` : '') + 'limit=100'
    const result = await rpc($, endpoint, 'resources/read', { uri })
    const page = JSON.parse(result.contents[0].text)
    records.push(...page.items)
    cursor = page.nextCursor ?? null
  } while (cursor)

  const open = records.filter(r => !CLOSED.has(r.values['nd.work.status']))
  const lane = (horizon: string): WorkItem[] => open
    .filter(r => r.values['nd.work.horizon'] === horizon)
    .sort((a, b) => (a.values['nd.work.order'] ?? 0) - (b.values['nd.work.order'] ?? 0))
    .map(r => ({
      ref: r.values['nd.work.ref'] ?? '?',
      title: r.values['nd.work.title'] ?? '',
      status: r.values['nd.work.status'] ?? '',
      isBlocked: r.calculations?.find((c: any) => c.fieldId === 'nd.work.isBlocked')?.value === true,
    }))

  return {
    now: lane('Now'),
    next: lane('Next'),
    inbox: open.filter(r => r.values['nd.work.status'] === 'Inbox').length,
    leaseHolder: holder,
  }
}

function statusLine(s: Snapshot): string {
  if (s.open.length === 0) return 'Nendo: nothing open'
  const names = s.open.map(n => n.replace(/\.nendo$/, '')).join(', ')
  const lease = s.planner ? (s.planner.leaseHolder ? ` · lease: ${s.planner.leaseHolder}` : ' · lease free') : ''
  return `Nendo: ${names} open${lease}`
}

let isRefreshing = false

async function refresh($: $) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const root = await $.session.root()
    const open = await openFiles($, `${root}/workspace`)
    let planner: Planner | null = null
    let problem: string | null = null
    if (open.includes(PLANNER)) {
      const endpoint = await plannerEndpoint($)
      if (!endpoint) problem = 'Planner is open but has no MCP endpoint'
      else planner = await readPlanner($, endpoint).catch(error => {
        problem = `Planner did not answer (${String(error?.message ?? error).slice(0, 60)})`
        return null
      })
    }
    const next: Snapshot = { open, planner, problem, checkedAt: await $.clock.now() }
    await $.state.set(SNAPSHOT, next)
    $.ui.status(statusLine(next))
  } finally {
    isRefreshing = false
  }
}

function summary(s: Snapshot | null): string {
  if (!s) return 'Not checked yet.'
  if (!s.planner) return s.problem ?? 'Planner.nendo is not open.'
  const line = (w: WorkItem) => `${w.ref} ${w.status}${w.isBlocked ? ' (blocked)' : ''}: ${w.title}`
  const parts = [
    `Now: ${s.planner.now.length ? '' : 'empty'}`, ...s.planner.now.map(line),
    `Next: ${s.planner.next.length ? '' : 'empty'}`, ...s.planner.next.map(line),
    `Inbox: ${s.planner.inbox}`,
    `Lease: ${s.planner.leaseHolder ?? 'free'}`,
  ]
  return parts.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'planner',
      description: 'Refresh and print the Nendo planner\'s Now and Next lanes',
    })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'planner' }, async $ => {
    await refresh($)

    return { text: summary((await $.state.get(SNAPSHOT)).value ?? null) }
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = (await $.state.get(SNAPSHOT)).value ?? null
    if (e.props.hasSurvey || !s || (!s.planner && !s.problem)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns

    if (!s.planner) {
      return (
        <Box>
          <Text dimColor wrap="truncate">{s.problem}</Text>
        </Box>
      )
    }

    const { now, next: upNext, inbox } = s.planner
    const item = (w: WorkItem, label: string) => (
      <Box key={`${label}-${w.ref}`} width={width}>
        <Text color="cyan">{label} </Text>
        <Text bold>{w.ref} </Text>
        <Text color={w.isBlocked || w.status === 'Blocked' ? 'red' : 'yellow'}>{w.status} </Text>
        <Text wrap="truncate">{w.title}</Text>
      </Box>
    )

    const rows = now.length > 0
      ? now.slice(0, SHOWN).map(w => item(w, 'Now '))
      : upNext.length > 0
        ? [item(upNext[0], 'Next')]
        : [<Text key="empty" dimColor>Now and Next are empty · {inbox} in the Later inbox</Text>]

    const more = now.length > SHOWN ? now.length - SHOWN : now.length === 0 && upNext.length > 1 ? upNext.length - 1 : 0

    return (
      <Box flexDirection="column">
        {rows}
        <Box>
          <Text dimColor>
            {now.length === 0 && upNext.length > 0 ? 'Now is empty · ' : ''}
            {more > 0 ? `+${more} more · ` : ''}
            {inbox} in inbox · /planner for the list{' '}
          </Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}
