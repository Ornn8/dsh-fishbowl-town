// 0.9.1（11-18 用户报：「0.9.0「主聊天拿主意」：写【小镇打算】接不住，两台会话、两条鱼、四次全没成」）
// 真 DSH 在插件问她的那一条后面，紧跟着再追加一条 runtime-context 的 user/message（背景快照）；0.9.0 把它当成「主人插话了」，
// 这一问直接作废，她回的【小镇打算】没人接，decideMiss++。只有主人亲手打的话才算插话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { createDshBrain } from '../lib/dsh-brain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'ask-owner-chat')
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const REPLY = '下午还早。去果园再摘一篮。\n\n【小镇打算】现在去果园摘一篮果子，摘完马上收'

async function setup({ runtimeContext = (sid) => '小镇近况：' + sid + ' ' + Date.now(), model = async () => REPLY } = {}) {
  const stateDir = join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  const host = createFakeHost({ model, latencyMs: 5, runtimeContext })
  const chat = await host.ownerChat('和她的主聊天')
  const chatLink = { mainChat: () => ({ sid: chat.sid, how: 'bound' }), ownerIdleMs: () => 10 * 60_000 }
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town' }, log: quiet, stateDir, state: {}, saveState: () => {}, chatLink })
  host.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  return { host, brain, chat }
}

test('her reply is caught although DSH appends a runtime-context message after the ask', async () => {
  const { brain } = await setup()
  const text = await brain.askOwnerChat('（插件发的）小镇在等你定接下来干嘛', { timeoutMs: 3000 })
  assert.equal(text, REPLY)
})

test('without a runtime-context message it works as before', async () => {
  const { brain } = await setup({ runtimeContext: null })
  assert.equal(await brain.askOwnerChat('（插件发的）小镇在等你定', { timeoutMs: 3000 }), REPLY)
})

test('a line the owner types into that turn still cancels the ask', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const model = async () => { await gate; return REPLY }
  const { host, brain, chat } = await setup({ model })
  const asked = brain.askOwnerChat('（插件发的）小镇在等你定', { timeoutMs: 3000 })
  await new Promise((r) => setTimeout(r, 30))
  const session = host.sessions.get(chat.sid).agent.session
  brain.onSessionEvent(session, { type: 'user/message', data: { id: 'typed-1', role: 'user', content: [{ type: 'text', text: '等下' }], source: { kind: 'user', rpcId: 'r1' } } })
  release()
  assert.equal(await asked, null)
})

test.after(() => { try { rmSync(WORK, { recursive: true, force: true }) } catch {} })
