import type { FsEntry, On, OpEventResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// R2SP-14. The mod picked the Planner's endpoint by display name, so a crashed run's entry, or
// another file named Planner.nendo, won over the workspace planner; and a commit between two page
// reads refused the next cursor, failing the whole refresh. Run with `claude plugin test`.

const ROOT = 'C:/work/nendo'
const LOCAL = 'C:/Users/someone/AppData/Local'
const ACTIVE = `${LOCAL}/Nendo/Mcp/active`
const LIVE = 'http://127.0.0.1:41766/mcp'
const DEAD = 'http://127.0.0.1:41799/mcp'

// The engine hands a hook the path as Windows writes it.
const slashes = (path: string) => path.replace(/\\/g, '/')

type World = { pages: number; staleOnce: boolean; asked: string[] }

function item(ref: string, title: string) {
  return { values: { 'nd.work.ref': ref, 'nd.work.title': title, 'nd.work.status': 'Doing', 'nd.work.horizon': 'Now', 'nd.work.order': 1 } }
}

function reply(message: object): OpEventResult<'http.fetch'> {
  return { value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) } }
}

const answer = (result: unknown) => reply({ result })
const refuse = (message: string) => reply({ error: { code: -32602, message } })

const file = (name: string): FsEntry => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })

// The machine beneath the mod: a workspace with Planner.nendo held by process 222, a discovery
// folder whose newest Planner.nendo entry is a crashed run's (process 111), and a planner that
// pages its work items and refuses a stale cursor once.
function world(on: On, state: World) {
  on('session.root', async () => ({ value: ROOT }))
  on('env.get', async ($, e) => ({ value: e.name === 'LOCALAPPDATA' ? LOCAL : undefined }))
  on('fs.list', async ($, e): Promise<OpEventResult<'fs.list'>> => {
    const path = slashes(e.path)
    if (path === `${ROOT}/workspace`) return { value: [file('Planner.nendo'), file('Planner.nendo.write-owner')] }
    if (path === ACTIVE) return { value: [file('crashed.json'), file('live.json')] }
    return { value: [] }
  })
  on('fs.read', async ($, e): Promise<OpEventResult<'fs.read'>> => {
    const path = slashes(e.path)
    if (path === `${ROOT}/workspace/Planner.nendo.write-owner`) return { value: JSON.stringify({ ownerId: 'x', processId: 222 }) }
    if (path === `${ACTIVE}/crashed.json`) return { value: JSON.stringify({ displayName: 'Planner.nendo', endpoint: DEAD, processId: 111, createdAt: '2026-10-14T09:00:00Z' }) }
    if (path === `${ACTIVE}/live.json`) return { value: JSON.stringify({ displayName: 'Planner.nendo', endpoint: LIVE, processId: 222, createdAt: '2026-10-14T08:00:00Z' }) }
    return { deny: `no file ${path}` }
  })
  on('http.fetch', async ($, e): Promise<OpEventResult<'http.fetch'>> => {
    state.asked.push(e.url)
    if (e.url !== LIVE) return { deny: 'fetch failed' }
    const body = JSON.parse(String(e.init?.body))
    if (body.method === 'tools/call') return answer({ structuredContent: { hasLease: false } })
    const uri: string = body.params.uri
    state.pages++
    if (!uri.includes('cursor=')) return answer({ contents: [{ text: JSON.stringify({ items: [item('W-001', 'First')], nextCursor: 'page-2' }) }] })
    if (state.staleOnce) {
      state.staleOnce = false
      return refuse('The file changed during paging. Restart from the first page.')
    }
    return answer({ contents: [{ text: JSON.stringify({ items: [item('W-002', 'Second')], nextCursor: null }) }] })
  })
}

test('the workspace planner is read through its own live endpoint, and a stale cursor starts again', async ($, on) => {
  const state: World = { pages: 0, staleOnce: true, asked: [] }
  world(on, state)
  on('clock.every', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: 0 }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }) as any)

  const result = await $.command.run({ command: 'planner', args: '', origin: { kind: 'plugin', name: 'test' }, presentation: { layout: 'main', columns: 100 } } as any)

  expect(state.asked).not.toContain(DEAD)
  expect(result.text ?? '').not.toContain('did not answer')
  expect(result.text ?? '').toContain('W-001 Doing: First')
  expect(result.text ?? '').toContain('W-002 Doing: Second')
  expect(state.pages).toBe(4)
})
