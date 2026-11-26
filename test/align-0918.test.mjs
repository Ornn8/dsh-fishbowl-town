// 0.9.18 主聊天里的她和小镇回合对齐（协调 11-24 批，方案「插件-主聊天和小镇回合对齐-方案-1126」）：
//   A 打算办到或说办不成为止（最多 6 小时）；B 办不成不换事（只在她手上有打算时）；C 回执照实说；D 主聊天里刚做的钉在回合里（办完 / 过时松开）；
//   没新事不叫 B：问过她以后那一下、她没定、小镇也没新事，不叫模型；手上压着打算到点自己请小镇叫她一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatDecide, PLAN_MARK, NOTE_WAITING, NOTE_EXECUTED, buildAsk, wishPullDue } from '../lib/chat-decide.js'
import { createJournal, wishReceipt, etaOf, cantWhy, PIN_HEAD } from '../lib/journal.js'
import { createRunner } from '../lib/runner.js'
import { buildTurnPrompt, WISH_TRY } from '../lib/prompt.js'
import { createIsleTools } from '../lib/isle-tools.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const agencyTurn = (id, reasons = ['idle'], extra = {}) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 25,
  packet: { purpose: 'agency', reasons, messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '码头上有人在泡水；麦香面包房在烤面包。' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 }, ...extra } })

function clockWorld(t0 = Date.UTC(2026, 10, 26, 4, 0, 0)) {
  const clock = { t: t0 }
  const state = {}
  const journal = createJournal({ state, now: () => clock.t })
  return { clock, state, journal }
}

test('A: her plan stays until done (gone, 「照你说的」) or blocked (kept with why, 「没办成…打算还留着」), max 6 h; the same words again = try again', () => {
  const { clock, state, journal: j } = clockWorld()
  j.wish('坐火车去温泉站', { own: true })
  const w = j.wishState()
  assert.equal(w.st, 'pending')
  // blocked
  j.decision({ action: 'none', note: '办不了：岛上没看到火车站' }, { wish: { ts: w.ts, verdict: 'blocked', why: '岛上没看到火车站' } })
  assert.equal(j.pendingWish(), '', 'a blocked plan is not 「waiting」 (no execute role)')
  assert.equal(j.wishState().st, 'blocked')
  assert.equal(j.wishState().why, '岛上没看到火车站')
  const lines = j.decisionLines(2)
  assert.equal(lines[0], '你想「坐火车去温泉站」，没办成：岛上没看到火车站，打算还留着')
  const rep = j.report()
  assert.match(rep, /你想「坐火车去温泉站」，小镇回合没办成：岛上没看到火车站。打算还留着/)
  assert.doesNotMatch(rep, /你在小镇定了：什么都不做/)
  // a later turn that only sees it (no verdict): kept, and that decision is not its receipt
  clock.t += 30 * 60_000
  j.decision({ action: 'none', note: '先歇会儿' }, { wish: { ts: w.ts, verdict: '', why: '' } })
  assert.equal(j.wishState().st, 'blocked')
  assert.equal(state.journal[0].wish, undefined)
  // the same words again from the main chat = try again
  j.wish('坐火车去温泉站', { own: true })
  assert.equal(j.pendingWish(), '坐火车去温泉站')
  const w2 = j.wishState()
  j.decision({ action: 'none', note: '照你在聊天里定的：坐 22:51 的火车' }, { wish: { ts: w2.ts, verdict: 'done' } })
  assert.equal(j.wishState(), null)
  assert.match(j.decisionLines(1)[0], /^照你说的：什么都不做，歇着——「坐 22:51 的火车」/)
  // owner's words, done
  j.wish('去钓会儿鱼')
  j.decision({ action: 'none', note: '钓到一条' }, { wish: { ts: j.wishState().ts, verdict: 'done' } })
  assert.match(j.decisionLines(1)[0], /^照主人说的：/)
  // 6 h
  j.wish('去找阿鲸', { own: true })
  j.decision({ action: 'none', note: '办不了：阿鲸不在岛上' }, { wish: { ts: j.wishState().ts, verdict: 'blocked', why: '阿鲸不在岛上' } })
  clock.t += 6 * 3600_000 + 1000
  assert.equal(j.wishState(), null)
  assert.match(j.decisionLines(1)[0], /^你想「去找阿鲸」，没办成：阿鲸不在岛上$/, 'no 「打算还留着」 once it is gone')
})

test('A: no verdict = as before (gone after one decision, 「你在小镇定了」 + 那时…); a new plan in the middle of a turn is not eaten', () => {
  const { journal: j } = clockWorld()
  j.wish('去码头', { own: true })
  j.decision({ action: 'none', note: '想歇着' }, { wish: { ts: j.wishState().ts, verdict: '' } })
  assert.equal(j.wishState(), null)
  assert.match(j.report(), /你在小镇定了：什么都不做，歇着——「想歇着」（那时你跟主人说过想：「去码头」）/)
  // a turn started with plan 1; plan 2 arrived while it ran
  j.wish('去码头', { own: true })
  const old = j.wishState().ts
  j.wish('去镜湖', { own: true })
  j.decision({ action: 'none' }, { wish: { ts: old - 1, verdict: 'done' } })
  assert.equal(j.pendingWish(), '去镜湖')
})

test('C helpers: receipts, 「办不了」 reason, minutes to go', () => {
  assert.equal(wishReceipt({ wish: '坐火车', wishOwn: true, wishBlocked: true, why: '没说去哪' }, { kept: true }), '你想「坐火车」，没办成：没说去哪，打算还留着')
  assert.equal(wishReceipt({ wish: '去钓鱼', wishBlocked: true, why: '码头关着' }), '主人想让你「去钓鱼」，没办成：码头关着')
  assert.equal(wishReceipt({ action: 'none' }), '')
  assert.equal(cantWhy('办不了：码头关着'), '码头关着')
  assert.equal(cantWhy('办不了 没这个'), '没这个')
  assert.equal(cantWhy('码头关着'), '')
  assert.equal(etaOf('往温泉站去了，1000 米，13.9 分钟到'), 13.9)
  assert.equal(etaOf('往X去了：走…共 9 分钟'), 9)
  assert.equal(etaOf('买到了'), 0)
})

test('B prompts: execute / pull / wake-with-plan say 「办不成不换事」 and the wish field; a turn without a plan is word for word as before', () => {
  const t = agencyTurn('p', ['wake'])
  const exec = buildTurnPrompt(t, { role: 'execute', wish: '坐火车', wishOwn: true })
  assert.match(exec, /"wish":"blocked"/)
  assert.match(exec, /"wish":"done"/)
  const pull = buildTurnPrompt(agencyTurn('p2', ['pulled']), { role: 'pull', wish: '去钓鱼', wishOwn: false })
  assert.ok(pull.includes(WISH_TRY))
  const wake = buildTurnPrompt(t, { role: 'wake', wish: '去钓鱼', wishOwn: false })
  assert.ok(wake.includes(WISH_TRY))
  // condition 1: no plan -> unchanged (no B line, no wish field)
  for (const role of ['wake', 'pull', 'fallback', 'rules', '']) {
    const p = buildTurnPrompt(t, { role })
    assert.ok(!p.includes(WISH_TRY), role)
    assert.doesNotMatch(p, /"wish"/, role)
    assert.equal(p, buildTurnPrompt(t, { role, wishBlocked: false, wishWhy: '', pins: [] }), role)
  }
  // a blocked plan rides as information only (she is free; no B line)
  const b = buildTurnPrompt(t, { role: 'wake', wish: '坐火车', wishOwn: true, wishBlocked: true, wishWhy: '没说去哪' })
  assert.match(b, /【你之前定的打算（上次没办成）】/)
  assert.match(b, /还是办不了，就照你自己的心意定/)
  assert.ok(!b.includes(WISH_TRY))
  assert.doesNotMatch(b, /【你自己定的打算】/)
})

test('D: pins ride in their own block (not twice in 「最近」); walking ones go at arrival, done-at-once ones after one turn, all after 2 h', () => {
  const { clock, journal: j } = clockWorld()
  const src1 = j.event('self', '你在聊天里在岛上走过去：往温泉站去了，1000 米，13.9 分钟到')
  j.pin('走过去：往温泉站去了，1000 米，13.9 分钟到', { etaMin: 13.9, src: src1 })
  const src2 = j.event('self', '你在聊天里在岛上买东西：买到了一杯奶茶')
  j.pin('买东西：买到了一杯奶茶', { etaMin: 0, src: src2 })
  const pins = j.pins()
  assert.equal(pins.length, 2)
  assert.equal(j.recentForAgency().filter((x) => x.includes('你在聊天里在岛上')).length, 0)
  const p = buildTurnPrompt(agencyTurn('d'), { pins: pins.map((x) => `- ${x.line}`) })
  assert.ok(p.includes(PIN_HEAD))
  assert.match(p, /往温泉站去了/)
  j.pinsSeen(pins.map((x) => x.text))
  assert.deepEqual(j.pins().map((x) => x.text), ['走过去：往温泉站去了，1000 米，13.9 分钟到'], 'the one done at once is let go after a turn')
  clock.t += 17 * 60_000 + 1000
  assert.deepEqual(j.pins(), [], 'arrived: let go')
  // at most 2, newest first; 2 h cap
  for (const x of ['a', 'b', 'c']) j.pin(`做了${x}`, { etaMin: 500 })
  assert.deepEqual(j.pins().map((x) => x.text), ['做了c', '做了b'])
  clock.t += 2 * 3600_000 + 1000
  assert.deepEqual(j.pins(), [])
})

test('D: the main-chat island tool pins what was done (with the minutes to walk); a failed one is not pinned', async () => {
  const { journal: j } = clockWorld()
  const client = { async isleAct(world) { return world.do === 'walk' ? { ok: true, text: '往温泉站去了，1000 米，13.9 分钟到' } : { ok: false, code: 'closed', text: '关门了' } } }
  const [, act] = createIsleTools({ live: () => ({ client }), journal: j, log: { info() {} } })
  await act.execute({ world: { do: 'walk', to: '温泉站' } }, {})
  await act.execute({ world: { do: 'buy', what: '奶茶' } }, {})
  const pins = j.pins()
  assert.equal(pins.length, 1)
  assert.match(pins[0].text, /往温泉站去了/)
})

function runnerWorld({ reply, wish = null, reasons = ['idle'], pins = 0 } = {}) {
  const state = {}
  const journal = createJournal({ state })
  if (wish) journal.wish(wish.text, { own: wish.own })
  for (let i = 0; i < pins; i++) journal.pin(`买东西：买到了第 ${i + 1} 样`, { etaMin: 0 })
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => 10 * 60_000, ownerLife: () => [] }
  let polled = 0
  const posted = []
  const prompts = []
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [agencyTurn('ot_1', reasons)] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { next: 1, items: [] } },
  }
  const brain = { async ask(_slot, prompt) { prompts.push(prompt); return reply } }
  const decide = createChatDecide({ brain, chatLink, journal, log, config: {}, state })
  const runner = createRunner({ client, brain, log, journal, chatDecide: decide, config: { eventsEveryMs: 60_000 } })
  return { state, journal, posted, prompts, runner }
}

test('runner A+B: execute that cannot be done -> none, 「办不了」 kept as is (no 「照你在聊天里定的」), the wish field never reaches the town, the plan stays', { timeout: 20_000 }, async () => {
  const w = runnerWorld({ wish: { text: '坐火车', own: true }, reply: '{"action":"none","note":"办不了：没说去哪","wish":"blocked","plan":{"hours":1,"doing":"等主人说去哪"}}' })
  w.runner.start()
  try {
    for (let i = 0; i < 50 && !w.posted.length; i++) await sleep(50)
    assert.equal(w.posted.length, 1)
    assert.match(w.prompts[0], /照你定的去做/)
    const a = JSON.parse(w.posted[0][1])
    assert.equal(a.wish, undefined, 'plugin-only field is taken out')
    assert.equal(a.note, '办不了：没说去哪')
    assert.equal(w.journal.wishState().st, 'blocked')
    assert.equal(w.journal.wishState().why, '没说去哪')
    assert.equal(w.journal.decisionLines(1)[0], '你想「坐火车」，没办成：没说去哪，打算还留着')
  } finally {
    await w.runner.stop()
  }
})

test('runner A: execute done -> the field is taken out, 「照你在聊天里定的」 to the town, 「照你说的」 in the main chat, the plan is gone', { timeout: 20_000 }, async () => {
  const w = runnerWorld({ wish: { text: '去码头泡一会儿', own: true }, reply: '{"action":"pier","note":"晒太阳","wish":"done","plan":{"hours":1,"doing":"码头泡着"}}' })
  w.runner.start()
  try {
    for (let i = 0; i < 50 && !w.posted.length; i++) await sleep(50)
    const a = JSON.parse(w.posted[0][1])
    assert.equal(a.wish, undefined)
    assert.equal(a.note, `${NOTE_EXECUTED}：晒太阳`)
    assert.equal(w.journal.wishState(), null)
    assert.match(w.journal.decisionLines(1)[0], /^照你说的：去码头——「晒太阳」/)
  } finally {
    await w.runner.stop()
  }
})

test('runner D: pins ride in the turn and the done-at-once ones are let go after it is answered', { timeout: 20_000 }, async () => {
  const w = runnerWorld({ reply: '{"action":"none","plan":{"hours":1,"doing":"歇着"}}', pins: 1, reasons: ['invited'] })
  w.runner.start()
  try {
    for (let i = 0; i < 50 && !w.posted.length; i++) await sleep(50)
    assert.ok(w.prompts[0].includes(PIN_HEAD))
    assert.match(w.prompts[0], /买到了第 1 样/)
    assert.deepEqual(w.journal.pins(), [])
  } finally {
    await w.runner.stop()
  }
})

test('没新事不叫 B: after asking her, the follow-up with no plan and nothing new is answered by the plugin; news / her own time / a plan still go to her model', async () => {
  const state = {}
  const journal = createJournal({ state })
  let t = Date.UTC(2026, 10, 26, 4, 0, 0)
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => 10 * 60_000, ownerLife: () => [] }
  const brain = { async ask() { return '嗯……还没想好' } }
  const d = createChatDecide({ brain, chatLink, journal, log, config: {}, state, now: () => t })
  assert.deepEqual(JSON.parse(d.take(agencyTurn('a1'))), { action: 'none', next_wake: 8, note: '在聊天里想想接下来去哪' })
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  assert.ok(d.followUntil() > t)
  t += 8 * 60_000
  // nothing new: no model
  const q = d.route(agencyTurn('a2', ['wake']))
  assert.equal(q.quiet, true)
  assert.equal(JSON.parse(q.answer).note, NOTE_WAITING)
  assert.equal(JSON.parse(q.answer).next_wake, 112)
  // her own time later (the follow-up is used up): her model
  t += 30 * 60_000
  assert.deepEqual(d.route(agencyTurn('a3', ['wake'])), { role: 'wake' })
  // a new ask; the follow-up brings news -> her model
  t += 3 * 3600_000
  state.decideMiss = 0 // (two misses in a row -> fallback, as before; here she answered in between)
  d.take(agencyTurn('a4'))
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  t += 8 * 60_000
  assert.deepEqual(d.route(agencyTurn('a5', ['wake', 'game_over'])), { role: 'wake' })
  // a new ask; the owner's words are waiting -> her model (wake with his words)
  t += 3 * 3600_000
  state.decideMiss = 0
  d.take(agencyTurn('a6'))
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  journal.wish('去钓会儿鱼')
  t += 8 * 60_000
  assert.deepEqual(d.route(agencyTurn('a7', ['wake'])), { role: 'wake' })
  // urgent still wins
  assert.deepEqual(d.route(agencyTurn('a8', ['wake', 'invited'])), { role: 'rules' })
})

test('没新事不叫 B: she wrote a plan -> the follow-up executes it; the one after (her own time) is her model again', async () => {
  const state = {}
  const journal = createJournal({ state })
  let t = Date.UTC(2026, 10, 26, 4, 0, 0)
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => 10 * 60_000, ownerLife: () => [] }
  const brain = { async ask() { return `好\n${PLAN_MARK}去镜湖边走走` } }
  const d = createChatDecide({ brain, chatLink, journal, log, config: {}, state, now: () => t })
  d.take(agencyTurn('b1'))
  for (let i = 0; i < 20 && d.busy; i++) await sleep(5)
  t += 8 * 60_000
  assert.deepEqual(d.route(agencyTurn('b2', ['wake'])), { role: 'execute' })
  journal.decision({ action: 'none' }, { wish: { ts: journal.wishState().ts, verdict: 'done' } })
  t += 40 * 60_000
  assert.deepEqual(d.route(agencyTurn('b3', ['wake'])), { role: 'wake' })
})

test('没新事不叫 B: a plan held in hand is pulled once at her time (not before the follow-up, not while blocked, not twice)', () => {
  const t = Date.UTC(2026, 10, 26, 4, 0, 0)
  const w = { text: '去钓鱼', ts: t, st: 'pending' }
  assert.equal(wishPullDue(w, { now: t + 30_000, due: 0 }), false, 'give the immediate pull a minute')
  assert.equal(wishPullDue(w, { now: t + 5 * 60_000, due: t + 10 * 60_000 }), false, 'the follow-up / her time is not here yet')
  assert.equal(wishPullDue(w, { now: t + 11 * 60_000, due: t + 10 * 60_000 }), true)
  assert.equal(wishPullDue(w, { now: t + 11 * 60_000, due: 0, mayPull: false }), false, 'resting / quiet hours')
  assert.equal(wishPullDue({ ...w, st: 'blocked' }, { now: t + 11 * 60_000 }), false)
  assert.equal(wishPullDue({ ...w, pulled: t + 60_000 }, { now: t + 11 * 60_000 }), false)
  assert.equal(wishPullDue({ ...w, pullAfter: t + 20 * 60_000 }, { now: t + 11 * 60_000 }), false)
  assert.equal(wishPullDue({ ...w, pullTries: 3 }, { now: t + 11 * 60_000 }), false)
  assert.equal(wishPullDue(null, { now: t }), false)
})

test('A in the decide ask: the plan that did not work out is told with why', () => {
  const ask = buildAsk(agencyTurn('x'), [], { text: '坐火车', why: '没说去哪' })
  assert.match(ask, /你上次定的小镇打算「坐火车」没办成：没说去哪。还想办就把缺的补上、再写一遍/)
  assert.doesNotMatch(buildAsk(agencyTurn('y')), /上次定的小镇打算/)
})
