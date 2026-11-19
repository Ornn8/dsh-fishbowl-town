// 0.8.0「在聊天里拿主意」（主人 11-16：「插件里会话都不是她……是不是可以直接接到她主会话」→「可以」「默认开」）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAsk, createChatDecide, planOf, PLAN_MARK, NOTE_ASKING, NOTE_WAITING } from '../lib/chat-decide.js'
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
  const brain = { async ask(slot, text) { asked.push(text); brain.slots.push(slot); return reply }, slots: [] }
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => idleMs, ownerLife: () => ['主人（5 分钟前）：今天好累，想吃面'] }
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
  assert.match(ask, /不发给他，也不会出现在你们的聊天里/)
  assert.match(buildAsk(agencyTurn('y'), ['主人（1 分钟前）：想吃面']), /你和主人最近的事[^\n]*\n主人（1 分钟前）：想吃面/)
})

test('0.9.2 a decision turn is her own quiet think (never his chat), with their recent chat; her plan becomes her own wish; the next turn is the town session following it', async () => {
  const w = world()
  const first = w.decide.take(agencyTurn('a1'))
  assert.deepEqual(JSON.parse(first), { action: 'none', next_wake: 8, note: '在聊天里想想接下来去哪' })
  for (let i = 0; i < 20 && w.decide.busy; i++) await sleep(5)
  assert.equal(w.asked.length, 1)
  assert.deepEqual(w.brain.slots, ['agency'])
  assert.match(w.asked[0], /今天好累，想吃面/)
  assert.equal(w.journal.pendingWish(), '去码头泡一会儿')
  assert.equal(w.journal.wishIsOwn(), true)
  assert.match(w.journal.report(), /你定了小镇的打算：「去码头泡一会儿」/)
  // the next decision turn: her plan is waiting -> the town session carries it out
  assert.equal(w.decide.take(agencyTurn('a2')), null)
  assert.deepEqual(w.decide.route(agencyTurn('a3')), { role: 'execute' })
})

// 0.9.0「主聊天拿主意」（主人 11-18「太割裂了」→「新的作为首选」）
test('0.9.0 routes: her plan -> execute; urgent -> rules by her rules; no chat / switch off -> the town session as before', async () => {
  const w = world()
  w.journal.wish('去码头泡一会儿', { own: true })
  assert.deepEqual(w.decide.route(agencyTurn('c1')), { role: 'execute' })
  const must = world()
  assert.deepEqual(must.decide.route(agencyTurn('c2', ['invited'])), { role: 'rules' })
  assert.deepEqual(must.decide.route(agencyTurn('c3', ['meet_ask', 'table'])), { role: 'rules' })
  const pulled = world()
  const r = pulled.decide.route(agencyTurn('c4', ['pulled', 'table']))
  assert.ok(r.answer, 'the plugin\'s own start pull is no longer handed to the town session')
  const off = world()
  off.config.decideInChat = false
  assert.equal(off.decide.route(agencyTurn('c5')), null)
  const none = world()
  none.chatLink.mainChat = () => null
  assert.equal(none.decide.route(agencyTurn('c6')), null)
})

test('0.9.0 he is away: ask once, then wait decideEveryMinutes without calling the town session; no plan line twice -> fallback once', async () => {
  let t = 1_800_000_000_000
  const state = {}
  const journal = createJournal({ state, now: () => t })
  const asked = []
  let reply = '嗯'
  const brain = { async ask(_slot, text) { asked.push(text); return reply } }
  const chatLink = { mainChat: () => ({ sid: 'main-1' }), ownerIdleMs: () => 10 * 60_000 }
  const notes = []
  const diary = { note: (text, tag) => notes.push([tag, text]) }
  const config = {}
  const d = createChatDecide({ brain, chatLink, journal, diary, log, config, state, now: () => t })
  const a1 = JSON.parse(d.route(agencyTurn('d1')).answer)
  assert.deepEqual(a1, { action: 'none', next_wake: 8, note: NOTE_ASKING })
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  assert.equal(state.decideMiss, 1)
  t += 30 * 60_000
  const wait = JSON.parse(d.route(agencyTurn('d2')).answer)
  assert.equal(wait.note, NOTE_WAITING)
  assert.equal(wait.next_wake, 90, 'waits until 120 minutes after the last ask')
  assert.equal(asked.length, 1)
  t += 91 * 60_000
  d.route(agencyTurn('d3'))
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  assert.equal(asked.length, 2)
  assert.equal(state.decideMiss, 2)
  assert.deepEqual(d.route(agencyTurn('d4')), { role: 'fallback' })
  assert.equal(state.decideMiss, 0)
  d.after('fallback', { action: 'pier', note: '想去晒太阳' })
  assert.equal(notes[0][0], 'did')
  assert.match(notes[0][1], /两次没顾上回，这次小镇那边先替你定了：去码头（想去晒太阳）/)
  d.after('rules', { action: 'visit' })
  assert.match(notes[1][1], /按你定的规矩先答了：去找朋友串门/)
  config.decideEveryMinutes = 30
  t += 31 * 60_000
  reply = `好\n${PLAN_MARK}先去码头，晚上八点报名斗地主`
  d.route(agencyTurn('d5'))
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  assert.equal(journal.pendingWish(), '先去码头，晚上八点报名斗地主')
  assert.deepEqual(d.route(agencyTurn('d6')), { role: 'execute' })
})

test('0.9.2 he is talking: nothing rides on his words (owner 11-19 「逐条报影响用户体验」); she still thinks quietly at the interval', async () => {
  let t = 1_800_000_000_000
  const state = {}
  const journal = createJournal({ state, now: () => t })
  const asked = []
  const brain = {
    async ask(_slot, text) { asked.push(text); return `嗯
${PLAN_MARK}去找阿鲸串门` },
    async askOwnerChat() { throw new Error('never in his chat') },
    watchReply() { throw new Error('never watches his chat') },
  }
  const chatLink = { mainChat: () => ({ sid: 'main-1' }), ownerIdleMs: () => 30_000 }
  const d = createChatDecide({ brain, chatLink, journal, log, config: {}, state, now: () => t })
  const a = JSON.parse(d.route(agencyTurn('e1')).answer)
  assert.equal(a.note, NOTE_ASKING)
  assert.equal(d.pendingNote('main-1'), '')
  d.noteSent('main-1')
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  assert.equal(asked.length, 1)
  assert.equal(journal.pendingWish(), '去找阿鲸串门')
  journal.decision({ action: 'visit' })
  t += 10 * 60_000
  assert.equal(JSON.parse(d.route(agencyTurn('e3')).answer).note, NOTE_WAITING)
  assert.equal(asked.length, 1)
})

test('0.9.0 town-context: the waiting ask is appended to his note and marked sent', async () => {
  const { createTownContext } = await import('../lib/town-context.js')
  let pending = '【小镇在等你定】测试'
  const sent = []
  const tc = createTownContext({ fetchBonds: async () => ({ ok: true }), isOwnerChat: () => true, now: () => 1_800_000_000_000, extras: () => ({}),
    decide: { pendingNote: () => pending, noteSent: (sid) => { sent.push(sid); pending = '' } } })
  const out = await tc.forTurn('s1')
  assert.match(out, /【小镇在等你定】测试/)
  assert.match(out, /^【鱼缸小镇插件 · 背景备注】/)
  assert.deepEqual(sent, ['s1'])
})

test('0.9.0 prompts: execute keeps to her plan; rules answers only the urgent thing', async () => {
  const { buildTurnPrompt } = await import('../lib/prompt.js')
  const ex = buildTurnPrompt(agencyTurn('p1'), { wish: '先去码头，晚上八点报名斗地主', wishOwn: true, role: 'execute' })
  assert.match(ex, /照你定的去做/)
  assert.match(ex, /不要换成别的事/)
  assert.match(ex, /办不了：原因/)
  const ru = buildTurnPrompt(agencyTurn('p2', ['invited']), { role: 'rules', rules: { text: '朋友约我都去' } })
  assert.match(ru, /有件事要马上回/)
  assert.match(ru, /只答眼前这件事/)
  assert.match(ru, /朋友约我都去/)
  const plain = buildTurnPrompt(agencyTurn('p3'), {})
  assert.match(plain, /该你自己拿主意了/)
  assert.doesNotMatch(plain, /照你在聊天里定的/)
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
  const calls = []
  const brain = { async ask(slot, text) { calls.push([slot, text]); return `好呀
${PLAN_MARK}去码头泡一会儿` } }
  const decide = createChatDecide({ brain, chatLink: w.chatLink, journal: w.journal, log, config: {}, state: w.state })
  const runner = createRunner({ client, brain, log, journal: w.journal, chatDecide: decide, config: { eventsEveryMs: 60_000 } })
  runner.start()
  try {
    for (let i = 0; i < 50 && !posted.length; i++) await sleep(50)
    assert.equal(posted.length, 1)
    assert.deepEqual(JSON.parse(posted[0][1]), { action: 'none', next_wake: 8, note: '在聊天里想想接下来去哪' })
    for (let i = 0; i < 20 && decide.busy; i++) await sleep(10)
    assert.equal(calls.length, 1, 'only her quiet think; the turn itself was answered at once')
    assert.match(calls[0][1], /不发给他/)
    assert.equal(w.journal.pendingWish(), '去码头泡一会儿')
  } finally {
    await runner.stop()
  }
})

test('0.9.0 runner: with her plan waiting the town session gets the execute prompt and the answer is marked as hers', { timeout: 20_000 }, async () => {
  const w = world()
  w.journal.wish('去码头泡一会儿', { own: true })
  let polled = 0
  const posted = []
  const prompts = []
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [agencyTurn('ot_9')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { next: 1, items: [] } },
  }
  const brain = { async ask(_slot, prompt) { prompts.push(prompt); return '{"action":"pier","note":"晒太阳","plan":{"hours":1,"doing":"码头泡着"}}' } }
  const decide = createChatDecide({ brain, chatLink: w.chatLink, journal: w.journal, log, config: {}, state: w.state })
  const runner = createRunner({ client, brain, log, journal: w.journal, chatDecide: decide, config: { eventsEveryMs: 60_000 } })
  runner.start()
  try {
    for (let i = 0; i < 50 && !posted.length; i++) await sleep(50)
    assert.equal(posted.length, 1)
    assert.match(prompts[0], /照你定的去做/)
    const a = JSON.parse(posted[0][1])
    assert.equal(a.action, 'pier')
    assert.equal(a.note, '照你在聊天里定的：晒太阳')
    assert.equal(w.journal.pendingWish(), '', 'her plan is used up by this decision')
  } finally {
    await runner.stop()
  }
})

test('0.9.0 brain.watchReply: her reply of the turn running in his chat comes back when the turn ends', { timeout: 20_000 }, async () => {
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { createFakeHost } = await import('./fake-dsh-host.mjs')
  const { createDshBrain } = await import('../lib/dsh-brain.js')
  const stateDir = join(tmpdir(), 'fbt-watch-' + Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  const host = createFakeHost({ model: async () => `好呀～\n${PLAN_MARK}去码头泡一会儿`, latencyMs: 5 })
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town', fastMode: true }, log, stateDir, state: {}, saveState: () => {} })
  host.ctx.on('session/event', (session, event) => brain.onSessionEvent(session, event))
  const chat = await host.ownerChat('和小圆子聊天')
  const said = chat.say('今天好累')
  const reply = await brain.watchReply(chat.sid, { timeoutMs: 5000 })
  await said
  assert.equal(planOf(reply), '去码头泡一会儿')
  const { rmSync } = await import('node:fs')
  rmSync(join(stateDir, '..'), { recursive: true, force: true })
})
