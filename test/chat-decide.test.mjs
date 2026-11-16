// 0.8.0「在聊天里拿主意」（主人 11-16：「插件里会话都不是她……是不是可以直接接到她主会话」→「可以」「默认开」）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAsk, createChatDecide, planOf, PLAN_MARK } from '../lib/chat-decide.js'
import { createJournal } from '../lib/journal.js'
import { createRunner } from '../lib/runner.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const agencyTurn = (id, reasons = ['idle']) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 25,
  packet: { purpose: 'agency', reasons, messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '码头上有人在泡水；麦香面包房在烤面包。' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 } } })

function world({ idleMs = 10 * 60_000, reply = `好呀，我想去码头泡一会儿，晒晒太阳。\n${PLAN_MARK}去码头泡一会儿` } = {}) {
  const state = {}
  const journal = createJournal({ state })
  const asked = []
  const brain = { async askOwnerChat(text) { asked.push(text); return reply } }
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => idleMs }
  const config = {}
  const decide = createChatDecide({ brain, chatLink, journal, log, config, state })
  return { state, journal, asked, brain, chatLink, config, decide }
}

test('her plan line is read from her reply; the ask says it is the plugin and shows the town', () => {
  assert.equal(planOf(`嗯嗯\n${PLAN_MARK}报名打一局斗地主。`), '报名打一局斗地主')
  assert.equal(planOf(`${PLAN_MARK}：歇着`), '歇着')
  assert.equal(planOf('今天不想动'), null)
  const ask = buildAsk(agencyTurn('x'))
  assert.match(ask, /插件发的，不是主人说的话/)
  assert.match(ask, /码头上有人在泡水/)
  assert.match(ask, /最后单独一行写「【小镇打算】你要做的事」/)
})

test('a decision turn goes to her chat when he is quiet; her plan becomes her own wish; the next turn is the town session following it', async () => {
  const w = world()
  const first = w.decide.take(agencyTurn('a1'))
  assert.deepEqual(JSON.parse(first), { action: 'none', next_wake: 8, note: '在聊天里想想接下来去哪' })
  for (let i = 0; i < 20 && w.decide.busy; i++) await sleep(5)
  assert.equal(w.asked.length, 1)
  assert.equal(w.journal.pendingWish(), '去码头泡一会儿')
  assert.equal(w.journal.wishIsOwn(), true)
  assert.match(w.journal.report(), /你在聊天里定了小镇的打算：「去码头泡一会儿」/)
  // the next decision turn: her plan is waiting -> the town session takes it (and follows it)
  assert.equal(w.decide.take(agencyTurn('a2')), null)
})

test('not in her chat: he is talking, a must-answer turn, too soon after the last ask, the switch off, or no chat found', async () => {
  const busy = world({ idleMs: 30_000 })
  assert.equal(busy.decide.take(agencyTurn('b1')), null)
  const must = world()
  assert.equal(must.decide.take(agencyTurn('b2', ['invited'])), null)
  assert.equal(must.decide.take(agencyTurn('b3', ['pulled'])), null)
  const soon = world({ reply: '嗯' })
  assert.ok(soon.decide.take(agencyTurn('b4')))
  for (let i = 0; i < 20 && soon.decide.busy; i++) await sleep(5)
  assert.equal(soon.journal.pendingWish(), '', 'no plan line: nothing is taken as her plan')
  assert.equal(soon.decide.take(agencyTurn('b5')), null, 'within 30 minutes of the last ask')
  const off = world()
  off.config.decideInChat = false
  assert.equal(off.decide.take(agencyTurn('b6')), null)
  const none = world()
  none.chatLink.mainChat = () => null
  assert.equal(none.decide.take(agencyTurn('b7')), null)
  const rest = world({ reply: `今天好累\n${PLAN_MARK}歇着` })
  rest.decide.take(agencyTurn('b8'))
  for (let i = 0; i < 20 && rest.decide.busy; i++) await sleep(5)
  assert.equal(rest.journal.pendingWish(), '先歇着，不出门')
})

test('the runner answers the town at once with a short wait and never calls the town session for that turn', { timeout: 20_000 }, async () => {
  const w = world()
  let polled = 0
  const posted = []
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [agencyTurn('ot_1')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { next: 1, items: [] } },
  }
  let townCalls = 0
  const brain = { async ask() { townCalls++; return '{"action":"none"}' }, askOwnerChat: w.brain.askOwnerChat }
  const decide = createChatDecide({ brain, chatLink: w.chatLink, journal: w.journal, log, config: {}, state: w.state })
  const runner = createRunner({ client, brain, log, journal: w.journal, chatDecide: decide, config: { eventsEveryMs: 60_000 } })
  runner.start()
  try {
    for (let i = 0; i < 50 && !posted.length; i++) await sleep(50)
    assert.equal(posted.length, 1)
    assert.deepEqual(JSON.parse(posted[0][1]), { action: 'none', next_wake: 8, note: '在聊天里想想接下来去哪' })
    assert.equal(townCalls, 0)
    for (let i = 0; i < 20 && decide.busy; i++) await sleep(10)
    assert.equal(w.journal.pendingWish(), '去码头泡一会儿')
  } finally {
    await runner.stop()
  }
})
