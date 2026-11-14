// 0.5.2 session guard: a town decision only ever runs in a small session of the plugin's own room, never in a chat
// the owner uses, and never with hundreds of K tokens of context (owner 11-14: JSON steps at ~600K tokens in her chat).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { createDshBrain, approxTokens, usageContext, isOwnerTyped, inspectSession, CONTEXT_ROTATE, CONTEXT_HARD } from '../lib/dsh-brain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'session-guard')
const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function setup({ model = async () => '{"vote":"鲸"}', hijack = null, config = {}, state = {} } = {}) {
  const stateDir = join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  const host = createFakeHost({ model, hijack, latencyMs: 5 })
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town', fastMode: true, ...config }, log: quiet, stateDir, state, saveState: () => {} })
  host.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  const townSessions = () => [...host.sessions.entries()].filter(([, s]) => s.title.startsWith('鱼缸小镇'))
  return { host, brain, state, townSessions }
}

/** The owner's long chat with her: many exchanges, the last request ~600K tokens. */
async function bigOwnerChat(host) {
  const chat = await host.ownerChat('子非的哲学夜话')
  const events = []
  for (let i = 0; i < 30; i++) {
    events.push({ role: 'user', text: '庄子说子非鱼，安知鱼之乐？' + '你怎么看'.repeat(50), source: { kind: 'user', rpcId: 'r' + i } })
    events.push({ role: 'assistant', text: '我想……'.repeat(200), usage: { inputTokens: 20_000 * (i + 1), outputTokens: 300, cacheReadTokens: 0 } })
  }
  host.seed(chat.sid, events)
  return chat
}

test('helpers: tokens, usage, who typed', () => {
  assert.equal(approxTokens('子非鱼'), 3)
  assert.equal(approxTokens('abcdef'), 2)
  assert.equal(usageContext({ usage: { inputTokens: 292, outputTokens: 106, totalTokens: 2574, cacheReadTokens: 2176 } }), 2574)
  assert.equal(usageContext({ message: {} }), 0)
  assert.equal(isOwnerTyped({ kind: 'user' }), true)
  assert.equal(isOwnerTyped({ kind: 'user', rpcId: 'x' }), true, 'typed on the phone / web (session.prompt) is his')
  assert.equal(isOwnerTyped({ kind: 'user', plugin: 'fishbowl-town' }), false)
  assert.equal(isOwnerTyped({ kind: 'fishbowl-town' }), false)
  assert.equal(isOwnerTyped({ kind: 'runtime-context', form: 'snapshot' }), false)
  assert.equal(isOwnerTyped({ kind: 'fishbowl-town-context' }), false)
})

test('the host hands back her owner\'s 600K chat for a new town session: nothing is sent there, it is not renamed, town turns pause after twice', async () => {
  let owner = null
  const { host, brain, state } = setup({ hijack: () => owner?.sid })
  owner = await bigOwnerChat(host)
  const facts = inspectSession(host.sessions.get(owner.sid).agent, { sid: owner.sid })
  assert.ok(facts.ownerTyped && facts.tokens > CONTEXT_HARD, 'the fixture is a big owner chat')
  const before = host.sessions.get(owner.sid).messages.length
  await assert.rejects(brain.ask('game', '轮到你投票', { timeoutMs: 5000 }), (e) => e.code === 'BRAIN_UNSAFE')
  await assert.rejects(brain.ask('game', '轮到你投票', { timeoutMs: 5000 }), (e) => e.code === 'BRAIN_UNSAFE')
  const s = host.sessions.get(owner.sid)
  assert.equal(s.messages.length, before, 'no town turn landed in his chat')
  assert.equal(s.requests || 0, 0, 'his model was never called on it')
  assert.equal(s.title, '子非的哲学夜话', 'his chat keeps its name')
  assert.ok(state.unsafe?.until > Date.now(), 'town turns pause for a while')
  assert.ok((state.notTown || []).includes(owner.sid))
  assert.match(state.pluginNotice.text, /不是干净的新会话/)
  // paused: the next turn does not even try
  let creates = 0
  const orig = host.ctx.sessionController.create
  host.ctx.sessionController.create = async (r) => { creates++; return orig(r) }
  await assert.rejects(brain.ask('game', '轮到你投票', { timeoutMs: 5000 }), (e) => e.code === 'BRAIN_UNSAFE')
  assert.equal(creates, 0)
  brain.dispose()
})

test('a stale state entry that points at a session outside the room is dropped (not renamed, not archived); the turn runs in a new room session', async () => {
  const seen = []
  const { host, brain, state, townSessions } = setup({ model: async ({ sessionId }) => { seen.push(sessionId); return '{"vote":"鲸"}' } })
  const owner = await bigOwnerChat(host)
  state.sessions.game = { sid: owner.sid, turns: 1, createdAt: Date.now() }
  state.townSids = [owner.sid]
  const before = host.sessions.get(owner.sid).messages.length
  const out = await brain.ask('game', '轮到你投票', { timeoutMs: 5000 })
  assert.equal(out, '{"vote":"鲸"}')
  assert.equal(host.sessions.get(owner.sid).messages.length, before)
  assert.equal(host.sessions.get(owner.sid).title, '子非的哲学夜话')
  assert.ok(!host.ctx.workspaceRegistry.archivedSessionIds.includes(owner.sid), 'his chat is not archived')
  const [[sid]] = townSessions()
  assert.deepEqual(seen, [sid])
  assert.match(host.sessions.get(sid).cwd.replace(/\\/g, '/'), /fishbowl-town\/room$/)
  brain.dispose()
})

test('the owner typed into a town session while the plugin was not watching (phone): checked on every turn, given to him, town moves on', async () => {
  const { host, brain, state, townSessions } = setup()
  await brain.ask('game', '第一步', { timeoutMs: 5000 })
  const [[first]] = townSessions()
  host.seed(first, [{ role: 'user', text: '在吗？今晚聊聊庄子', source: { kind: 'user', rpcId: 'phone-1' } }])
  const before = host.sessions.get(first).messages.length
  await brain.ask('game', '第二步', { timeoutMs: 5000 })
  assert.equal(host.sessions.get(first).messages.length, before, 'no town turn after his words')
  assert.equal(host.sessions.get(first).title, '聊天')
  assert.ok(state.ownerTaken.includes(first))
  assert.equal(townSessions().length, 1, 'a new 牌桌 session took over')
  brain.dispose()
})

test('size, not just turns: a town session past the rotate size is replaced before the next step', async () => {
  let big = true
  const { host, brain, townSessions } = setup({
    config: { fastMode: false, turnsPerSession: 20 },
    model: async () => ({ text: '{"vote":"鲸"}', usage: { inputTokens: big ? CONTEXT_ROTATE + 2000 : 3000, outputTokens: 20 } }),
  })
  await brain.ask('game', '第一步', { timeoutMs: 5000 })
  const [[first]] = townSessions()
  big = false
  await brain.ask('game', '第二步', { timeoutMs: 5000 })
  assert.ok(host.ctx.workspaceRegistry.archivedSessionIds.includes(first), 'the big one is archived')
  const live = townSessions().map(([id]) => id).filter((id) => !host.ctx.workspaceRegistry.archivedSessionIds.includes(id))
  assert.equal(live.length, 1)
  assert.notEqual(live[0], first)
  assert.equal(host.sessions.get(first).requests, 1)
  brain.dispose()
})

test('a request that turns out huge stops the turn at once (no more paid steps); the next turn gets a fresh small session', async () => {
  let n = 0
  const { host, brain, townSessions } = setup({ model: async () => ({ text: '{"vote":"鲸"}', usage: { inputTokens: ++n === 1 ? CONTEXT_HARD + 5000 : 2000, outputTokens: 10 } }) })
  await assert.rejects(brain.ask('game', '第一步', { timeoutMs: 5000 }), (e) => e.code === 'BRAIN_UNSAFE')
  const out = await brain.ask('game', '第二步', { timeoutMs: 5000 })
  assert.equal(out, '{"vote":"鲸"}')
  assert.equal(townSessions().length, 2)
  brain.dispose()
})

test('the correction for the same turn stays in the session that has the question, even at the turn limit', async () => {
  const seen = []
  const { brain } = setup({ config: { fastTurnsPerSession: 1 }, model: async ({ sessionId }) => { seen.push(sessionId); return 'x' } })
  await brain.ask('game', '轮到你', { timeoutMs: 5000 })
  await brain.ask('game', '刚才的回答读不了，只回 JSON', { timeoutMs: 5000, followup: true })
  await brain.ask('game', '下一个回合', { timeoutMs: 5000 })
  assert.equal(seen[0], seen[1], 'the correction went where the question was')
  assert.notEqual(seen[2], seen[0], 'a new turn starts a new session')
  brain.dispose()
})

test('cleanup', () => { rmSync(WORK, { recursive: true, force: true }) })
