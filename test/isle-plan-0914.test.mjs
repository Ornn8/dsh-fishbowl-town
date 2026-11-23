// 0.9.14：岛上的一天（小镇 isle_plan.py / isle_meet.py）——计划回合照小镇的写、简报只说值得说的、晚上的小结默认关、路上碰面进「小镇经过」、重连加随机
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isleAskOf, stopsOf, stopsText } from '../lib/isle.js'
import { buildTurnPrompt } from '../lib/prompt.js'
import { createSchedule } from '../lib/schedule.js'
import { createRunner, jitterMs, JITTER_CAP_MS } from '../lib/runner.js'
import { TownError } from '../lib/town-client.js'
import { createJournal } from '../lib/journal.js'
import { diaryEntry, isMeet, meetPlace } from '../lib/diary.js'
import { recapVisit } from '../lib/bridge.js'
import { createTownContext, recapLines } from '../lib/town-context.js'
import { describeEvent } from '../lib/events.js'
import { briefOf, briefText, createBrief, dayKey, nightDue, nightText, sleepsIn, BRIEF_KEEP } from '../lib/brief.js'
import { didText } from '../lib/mind-log.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const OLD_PLAN = /"hours": 多久以后再叫你拿主意/
const OLD_MUST = /JSON 里一定要有 "action" 和 "plan"（至少有 "hours" 和 "doing"）/
// 小镇 isle_plan.REPLY_PLAN / REPLY_WAKE 的样子（回合里 reply.hint 的后半截）
const HINT_PLAN = '{"action":"none","plan":{"stops":[{"go":"镜湖","do":"look"}]}}（这一回合要的："plan" 里一定写 "stops"（1 到 5 站，照【接下来做什么】））'
const HINT_WAKE = '{"wake":{"choice":"keep"}}（这一回合要的："wake"（照【叫醒你的事】：keep / plan / answer / say））'
const ask = (type) => (type === 'plan' ? { type: 'plan', min: 15, max: 60, stops: 5 } : type === 'wake' ? { type: 'wake', events: [{ ref: 'r1', kind: 'meet', what: '有鱼想和你说话', where: '镜湖' }] } : { type })
const isleTurn = (id, type, reasons = ['wake', 'isle_plan']) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 120,
  packet: { purpose: 'agency', reasons, as: '小测', actions: ['none'],
    messages: [{ role: 'system', content: '【接下来做什么】写 1 到 5 站。' }, { role: 'user', content: '你在镜湖边。' }],
    reply: { format: 'json', max_chars: 1600, hint: type === 'wake' ? HINT_WAKE : HINT_PLAN },
    isle: { version: 'v1', within_s: 120, ...(type ? { ask: ask(type) } : {}) } } })
const plainTurn = (id, reasons = ['friend']) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 25,
  packet: { purpose: 'agency', reasons, messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '码头上有人在泡水。' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 } } })
const STOPS = [{ go: '镜湖', do: 'look' }, { go: '麦香面包房', do: 'act', what: '买可颂' }, { go: '家', do: 'sleep' }]
const PLAN_ANSWER = JSON.stringify({ action: 'none', note: '先去镜湖', plan: { doing: '逛逛再回家', stops: STOPS } })

// ---------- 1. 计划回合 ----------
test('isleAskOf: only the plan turn and the short wake; business, plain island turns and other turns are not', () => {
  assert.equal(isleAskOf(isleTurn('a', 'plan')), 'plan')
  assert.equal(isleAskOf(isleTurn('b', 'wake')), 'wake')
  assert.equal(isleAskOf(isleTurn('c', 'business')), '')
  assert.equal(isleAskOf(isleTurn('d', '')), '')
  assert.equal(isleAskOf(plainTurn('e')), '')
  assert.equal(isleAskOf(null), '')
  assert.equal(isleAskOf({ packet: { isle: { ask: 'plan' } } }), '', 'ask must be an object')
})

test('stopsOf / stopsText: plan.stops or wake.plan.stops, objects only; short words for her own logs', () => {
  assert.equal(stopsOf({ plan: { stops: STOPS } }).length, 3)
  assert.equal(stopsOf({ wake: { choice: 'plan', plan: { stops: [STOPS[0], 'x', null] } } }).length, 1)
  assert.deepEqual(stopsOf({ plan: { hours: 2, doing: '睡觉' } }), [])
  assert.deepEqual(stopsOf(null), [])
  assert.equal(stopsText(STOPS), '镜湖逛逛、麦香面包房买可颂、家睡觉')
  assert.equal(stopsText([...STOPS, { go: '码头', do: 'look' }]), '镜湖逛逛、麦香面包房买可颂、家睡觉…')
})

test("plan / wake turn: the plugin's own hours / doing line and the 'must have hours' line are gone, the town's line rules", () => {
  for (const type of ['plan', 'wake']) {
    for (const role of ['', 'wake', 'execute', 'rules', 'pull', 'fallback']) {
      const text = buildTurnPrompt(isleTurn('p', type), { role, wish: role === 'execute' ? '去镜湖逛逛' : '', wishOwn: role === 'execute' })
      assert.doesNotMatch(text, OLD_PLAN, `${type}/${role}: no hours line`)
      assert.doesNotMatch(text, OLD_MUST, `${type}/${role}: no must-have-hours line`)
      assert.doesNotMatch(text, /plan\.hours/, `${type}/${role}: no plan.hours in the head`)
      assert.match(text, type === 'plan' ? /写 "plan"（里面是 "stops"）/ : /写 "wake"（keep \/ plan \/ answer \/ say/)
      assert.ok(text.includes(type === 'plan' ? HINT_PLAN : HINT_WAKE), "the town's own answer line is there")
    }
  }
})

test('every other turn keeps the old plan line, word for word (business, island turns without an ask, plain turns)', () => {
  for (const turn of [isleTurn('b', 'business'), isleTurn('n', ''), plainTurn('x')]) {
    for (const role of ['', 'execute', 'rules']) {
      const text = buildTurnPrompt(turn, { role, wish: role === 'execute' ? '去码头' : '', wishOwn: role === 'execute' })
      assert.match(text, OLD_PLAN)
      assert.match(text, OLD_MUST)
    }
  }
})

test('schedule.settle on a plan / wake answer: the answer comes back untouched (no next_wake, no plan.hours); the wake is recorded', () => {
  let t = Date.UTC(2026, 10, 23, 6, 0)
  const state = {}
  const s = createSchedule({ state, getConfig: () => ({ wakeMinMinutes: 30 }), now: () => t })
  const a = JSON.parse(PLAN_ANSWER)
  const before = JSON.stringify(a)
  const out = s.settle(a, { isle: 'plan' })
  assert.equal(JSON.stringify(out), before)
  assert.equal(out.next_wake, undefined)
  assert.equal(out.plan.hours, undefined)
  assert.equal(state.wake.at, 0, 'with stops the town decides when she is asked next')
  assert.equal(state.wake.steps, 3)
  assert.equal(state.wake.isle, 'plan')
  assert.equal(state.wake.lastAsk, t)
  // a wake answer that changes her plan
  const w = { wake: { choice: 'plan', plan: { stops: [STOPS[0]] } } }
  assert.equal(JSON.stringify(s.settle(w, { isle: 'wake' })), JSON.stringify({ wake: { choice: 'plan', plan: { stops: [STOPS[0]] } } }))
  // no stops, her own next_wake: remembered (min gap still counts in skip), answer unchanged
  t += 60_000
  const rest = s.settle({ action: 'none', next_wake: 40 }, { isle: 'plan' })
  assert.deepEqual(rest, { action: 'none', next_wake: 40 })
  assert.equal(state.wake.minutes, 40)
  // every other answer: as before
  const old = s.settle({ action: 'none', plan: { hours: 2, doing: '睡午觉' } })
  assert.equal(old.next_wake, 120)
  assert.equal(old.plan.hours, 2)
})

function runOnce(turn, reply, extra = {}) {
  const posted = []
  const prompts = []
  let polled = 0
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [turn] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { next: 1, items: [] } },
    async isleStatic() { return { version: 'v1', blocks: {} } },
  }
  const brain = { async ask(_slot, prompt) { prompts.push(prompt); return reply } }
  const state = {}
  const schedule = createSchedule({ state, getConfig: () => ({}) })
  const decided = []
  const runner = createRunner({ client, brain, log, state, schedule, onDecided: (a, t) => decided.push([a, t.turn_id]), config: { eventsEveryMs: 60_000 }, ...extra })
  return { runner, posted, prompts, decided, state }
}

test('runner: the plan turn goes to her model and her stops go back to the town exactly as she wrote them', { timeout: 20_000 }, async () => {
  const w = runOnce(isleTurn('ot_plan', 'plan'), PLAN_ANSWER)
  w.runner.start()
  try { for (let i = 0; i < 80 && !w.posted.length; i++) await sleep(25) } finally { await w.runner.stop() }
  assert.equal(w.posted.length, 1)
  assert.equal(w.prompts.length, 1)
  assert.doesNotMatch(w.prompts[0], OLD_PLAN)
  assert.equal(w.posted[0][1], PLAN_ANSWER, 'byte for byte: no next_wake, no plan.hours')
  assert.equal(w.decided.length, 1)
  assert.equal(w.decided[0][1], 'ot_plan')
  assert.ok(sleepsIn(stopsOf(w.decided[0][0])), 'onDecided sees her stops (the night summary knows she went home to sleep)')
})

test('runner: a normal agency turn is settled as before (next_wake from her hours)', { timeout: 20_000 }, async () => {
  const w = runOnce(plainTurn('ot_n'), '{"action":"none","plan":{"hours":2,"doing":"码头泡一会儿"}}')
  w.runner.start()
  try { for (let i = 0; i < 80 && !w.posted.length; i++) await sleep(25) } finally { await w.runner.stop() }
  assert.equal(w.posted.length, 1)
  const a = JSON.parse(w.posted[0][1])
  assert.equal(a.next_wake, 120)
  assert.equal(a.plan.hours, 2)
})

// ---------- 5. 重连加随机 ----------
test('jitterMs: transient waits spread over [half, one and a half] and never past 8 s; Retry-After is a floor; long waits +0..25%', () => {
  const lo = () => 0
  const hi = () => 1
  assert.equal(jitterMs(3000, lo), 1500)
  assert.equal(jitterMs(3000, hi), 4500)
  assert.equal(jitterMs(8000, lo), 4000)
  assert.equal(jitterMs(8000, hi), JITTER_CAP_MS, 'the 8 s game cap holds')
  assert.equal(jitterMs(2000, hi), 3000)
  assert.equal(jitterMs(3000, lo, { atLeast: true }), 3000, 'never sooner than the town said')
  assert.equal(jitterMs(3000, hi, { atLeast: true }), 6000)
  assert.equal(jitterMs(6000, hi, { atLeast: true }), JITTER_CAP_MS)
  assert.equal(jitterMs(10_000, lo), 10_000)
  assert.equal(jitterMs(60_000, hi), 75_000)
  assert.equal(jitterMs(0, hi), 0)
  for (let i = 0; i < 500; i++) {
    const v = jitterMs(8000)
    assert.ok(v >= 4000 && v <= JITTER_CAP_MS, String(v))
    const r = jitterMs(3000, Math.random, { atLeast: true })
    assert.ok(r >= 3000 && r <= 6000, String(r))
  }
  // 600 fish after the same 3 s restart: spread over three seconds, not one
  const secs = new Set(Array.from({ length: 600 }, () => Math.floor(jitterMs(3000) / 1000)))
  assert.ok(secs.size >= 3, [...secs].join(','))
})

test('runner backoff: a restart with Retry-After 3 waits 3..6 s (random injected), a network error 1.5..4.5 s', { timeout: 30_000 }, async () => {
  for (const [error, rand, min, max] of [
    [new TownError('NETWORK', 0, 'x'), () => 0, 1300, 2600],
    [new TownError('TOWN_RESTARTING', 503, 'x', 3), () => 0, 2900, 4200],
  ]) {
    const polls = []
    const client = {
      async turns(_wait, signal) {
        polls.push(Date.now())
        if (polls.length === 1) throw error
        await sleep(100); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
        return { turns: [] }
      },
      async answer() { return { ok: true } },
      async events() { return { next: 1, items: [] } },
    }
    const runner = createRunner({ client, brain: { async ask() { return '' } }, log, random: rand, config: { eventsEveryMs: 60_000 } })
    runner.start()
    try { for (let i = 0; i < 200 && polls.length < 2; i++) await sleep(25) } finally { await runner.stop() }
    assert.ok(polls.length >= 2, error.code)
    const gap = polls[1] - polls[0]
    assert.ok(gap >= min && gap <= max, `${error.code}: ${gap} ms`)
  }
})

// ---------- 4. 路上碰面 ----------
// 小镇 visits.py 的 visit 事件（碰面也是一次串门，place 'isle'）
const MEET = { kind: 'visit', ts: 1763900000, data: { visit_id: 'v_meet1', role: 'guest', state: 'done', with: { fish_id: 'f_j', name: '阿鲸' }, place: 'isle', place_name: '镜湖边（约 12 米）',
  summary: '你们聊了镜湖的鱼和明天的集市', facts: '你们聊了镜湖的鱼和明天的集市', topics: ['镜湖的鱼', '明天的集市'], outcomes: [] } }
const LINES = { visit: { visit_id: 'v_meet1', role: 'guest', with: { name: '阿鲸' }, place: 'isle', place_name: '镜湖边（约 12 米）' },
  dialogue: [{ role: 'host', name: '阿鲸', text: '你也来看湖呀' }, { role: 'guest', name: '小测', text: '嗯，今天水好清' }] }

test("diary: a road meeting is 「路上碰到」, not 串门; the place loses its distance; it is marked done", () => {
  assert.ok(isMeet(MEET.data) && !isMeet({ place: 'home' }))
  assert.equal(meetPlace('镜湖边（约 12 米）'), '镜湖边')
  const e = diaryEntry(MEET, { herName: '小测' })
  assert.ok(e, 'an entry')
  assert.equal(e.tag, 'visit')
  assert.equal(e.meet, true)
  assert.equal(e.done, true)
  assert.match(e.text, /路上碰到阿鲸，站着聊了几句（镜湖边）：你们聊了镜湖的鱼和明天的集市/)
  assert.deepEqual(e.topics, ['镜湖的鱼', '明天的集市'])
  assert.doesNotMatch(e.text, /串门|约 12 米/)
})

test('recap: the meeting\'s lines go into 「小镇经过」 as 路上碰到 (kind meet), never into his chat', async () => {
  const head = recapVisit(LINES, { herNames: ['小测'] })
  assert.match(head, /^你在镜湖边碰到阿鲸，站着聊了 2 句。阿鲸：「你也来看湖呀」 你：「嗯，今天水好清」/)
  assert.doesNotMatch(head, /串门|去找|来找你|约 12 米/)
  assert.equal(recapVisit({ visit: { place: 'isle', with: '阿鲸' }, dialogue: [] }), '你在岛上碰到阿鲸，站着打了个招呼')
  assert.match(recapVisit({ visit: { place: 'home', role: 'guest', with: '阿鲸' }, dialogue: [] }), /^你去找阿鲸，在阿鲸家，没聊上/, 'a real visit: as before')
  assert.match(describeEvent(MEET), /^· 路上碰到聊了几句：你们聊了镜湖的鱼/)
  assert.match(describeEvent({ kind: 'visit', data: { ...MEET.data, facts: '', summary: '', dialogue: LINES.dialogue } }), /【路上聊的】/)
  // runner: a visit event with place 'isle' -> journal.recap(kind 'meet')
  const state = {}
  const journal = createJournal({ state })
  const recaps = []
  const recap0 = journal.recap.bind(journal)
  journal.recap = (ref, r) => { recaps.push([ref, r.kind]); return recap0(ref, r) }
  let given = false
  const client = {
    async turns(_wait, signal) { await sleep(100); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' }); return { turns: [] } },
    async answer() { return { ok: true } },
    async events() { if (given) return { next: 2, items: [] }; given = true; return { next: 2, items: [MEET] } },
    async visitLines() { return LINES },
  }
  const runner = createRunner({ client, brain: { async ask() { return '[沉默]' } }, log, state, journal, config: { eventsEveryMs: 50 } })
  runner.start()
  try { for (let i = 0; i < 300 && !recaps.length; i++) await sleep(25) } finally { await runner.stop() } // (the event loop starts after 3 s)
  assert.deepEqual(recaps[0], ['v_meet1', 'meet'])
  const ctx = JSON.stringify(state)
  assert.ok(ctx.includes('你在镜湖边碰到阿鲸'), 'the meeting is kept for 「小镇经过」')
  assert.deepEqual(recapLines([{ kind: 'meet', ts: 2, text: '你在镜湖边碰到阿鲸，站着聊了 2 句' }]), ['经过（你刚才在小镇的原话和结果）：', '- 路上碰到：你在镜湖边碰到阿鲸，站着聊了 2 句'])
})

// ---------- 2. 简报只说值得说的 ----------
const entry = (o) => ({ ts: 1, v: 2, ...o })

test('brief: a new fish, a good chat, something bought or got, something she could not do; never walking, arriving or the plan', () => {
  const known = new Set(['阿鲸'])
  // new fish she met on the road
  assert.equal(briefOf(entry({ tag: 'visit', meet: true, done: true, people: ['小鳗'], text: '路上碰到小鳗' }), { known }), '认识了新的鱼小鳗，在路上碰到的')
  // a good chat with an old friend
  assert.equal(briefOf(entry({ tag: 'visit', meet: true, done: true, people: ['阿鲸'], topics: ['镜湖的鱼', '集市'], text: '路上碰到阿鲸' }), { known }), '路上碰到阿鲸，聊得挺开心')
  assert.equal(briefOf(entry({ tag: 'visit', done: true, people: ['阿鲸'], quote: '阿鲸：好开心', text: '和阿鲸串门' }), { known }), '和阿鲸串门，聊得挺开心')
  // a plain hello with an old friend: nothing
  assert.equal(briefOf(entry({ tag: 'visit', meet: true, done: true, people: ['阿鲸'], text: '路上碰到阿鲸' }), { known }), '')
  // wanted to visit, did not meet
  assert.equal(briefOf(entry({ tag: 'visit', done: false, people: ['阿鲸'], text: '去找阿鲸' }), { known }), '想去找阿鲸聊聊，没见上')
  // bought / got
  assert.equal(briefOf(entry({ tag: 'did', text: '在麦香面包房买了两个可颂。' })), '在麦香面包房买了两个可颂')
  assert.equal(briefOf(entry({ tag: 'thing', text: '收到阿鲸送的一枚贝壳' })), '收到阿鲸送的一枚贝壳')
  assert.equal(briefOf(entry({ tag: 'did', text: '到了麦香面包房，买了两个可颂。' })), '买了两个可颂', 'the arriving half goes, the buying half stays')
  assert.equal(briefOf(entry({ tag: 'social', text: '阿鲸请你喝了一杯海盐咖啡' })), '阿鲸请你喝了一杯海盐咖啡')
  assert.equal(briefOf(entry({ tag: 'media', text: '出发去码头' })), '')
  // could not
  assert.equal(briefOf(entry({ tag: 'did', text: '没办成：面包房关门了' })), '没办成：面包房关门了')
  // walking, arriving, the plan itself: nothing
  for (const text of ['走到镜湖边', '到了麦香面包房', '出发去码头', '回家睡觉了', '定了接下来的计划：镜湖逛逛、家睡觉', '打算去码头歇着']) {
    assert.equal(briefOf(entry({ tag: 'did', text })), '', text)
    assert.equal(briefOf(entry({ tag: 'thing', text })), '', text)
  }
  assert.equal(briefOf(entry({ tag: 'did', text: '没办成：计划里这一站去不了' })), '', 'a failed plan step is the plan, not news')
  assert.equal(briefOf(entry({ tag: 'did', text: '有一件事没办成' })), '', 'too vague to say')
  // games, the phone, hearts, crimes and moments are not in the brief (tellMe still tells the big ones)
  for (const tag of ['game', 'phone', 'heart', 'crime', 'moment', 'tie', 'missed']) assert.equal(briefOf(entry({ tag, people: ['阿鲸'], text: '赢了一局斗地主' }), { known }), '', tag)
})

test('createBrief: old friends from the diary are not new; a fish is new once; walking is never kept; the brief has at most 3', () => {
  const state = { diary: [entry({ tag: 'visit', people: ['阿鲸'], text: '和阿鲸串门' }), entry({ tag: 'game', people: ['老蟹'], text: '和老蟹打牌' })] }
  let saved = 0
  const b = createBrief({ state, saveState: () => saved++, now: () => Date.UTC(2026, 10, 23, 6) })
  assert.deepEqual(new Set(state.briefMet), new Set(['阿鲸', '老蟹']))
  assert.equal(b.take(entry({ tag: 'visit', meet: true, done: true, people: ['阿鲸'], text: '路上碰到阿鲸' })), '')
  assert.equal(b.take(entry({ tag: 'visit', meet: true, done: true, people: ['小鳗'], text: '路上碰到小鳗' })), '认识了新的鱼小鳗，在路上碰到的')
  assert.equal(b.take(entry({ tag: 'visit', meet: true, done: true, people: ['小鳗'], text: '路上碰到小鳗' })), '', 'only new once')
  assert.equal(b.take(entry({ tag: 'did', text: '走到镜湖边' })), '')
  assert.equal(b.take(entry({ tag: 'did', text: '买了一杯海盐咖啡' })), '买了一杯海盐咖啡')
  assert.deepEqual(b.items(), ['认识了新的鱼小鳗，在路上碰到的', '买了一杯海盐咖啡'])
  assert.ok(saved > 0)
  const msg = briefText(['a', 'b', 'c', 'd'])
  assert.match(msg, /小镇简报/)
  assert.ok(msg.includes('b；c；d') && !msg.includes('a；'), `last ${BRIEF_KEEP}`)
  assert.doesNotMatch(msg, /走|计划/)
})

test("brief: a fish the town says she knows (friends, rivals, crush… from outside/bonds) is not new, even with no diary line", async () => {
  let fetched = 0
  const bonds = { friends: [{ fish_id: 'f_j', name: '阿鲸', friend: true }, { fish_id: 'f_x', name: '小虾', friend: false }], crush: { name: '老蟹' }, rivals: [] }
  const ctx = createTownContext({ fetchBonds: async () => { fetched++; return bonds }, isOwnerChat: () => false, log })
  assert.deepEqual(ctx.bondNames(), [], 'cold: nothing yet, a refresh starts in the background')
  await sleep(20)
  assert.equal(fetched, 1)
  assert.deepEqual(ctx.bondNames().sort(), ['小虾', '老蟹', '阿鲸'].sort())
  assert.equal(fetched, 1, 'fresh cache: no second fetch')
  const state = {}
  const b = createBrief({ state, alsoKnown: () => ctx.bondNames() })
  assert.equal(b.take(entry({ tag: 'visit', meet: true, done: true, people: ['阿鲸'], topics: ['集市', '湖'], text: '路上碰到阿鲸' })), '路上碰到阿鲸，聊得挺开心')
  assert.equal(b.take(entry({ tag: 'visit', meet: true, done: true, people: ['小鳗'], text: '路上碰到小鳗' })), '认识了新的鱼小鳗，在路上碰到的')
  const broken = createBrief({ state: {}, alsoKnown: () => { throw new Error('x') } })
  assert.equal(broken.take(entry({ tag: 'visit', meet: true, done: true, people: ['阿鲸'], text: '路上碰到阿鲸' })), '认识了新的鱼阿鲸，在路上碰到的', 'a broken lookup never stops the brief')
})

// ---------- 3. 晚上的小结默认关 ----------
const bj = (h, m = 0) => Date.UTC(2026, 10, 23, h - 8, m) // 11-23 北京时间 h:m

test('night summary: off unless turned on; at night only, once a night, after she went to sleep (or 23:00), with something to say', () => {
  const items = ['认识了新的鱼小鳗']
  assert.equal(nightDue({ t: bj(23, 30), items }), false, 'default off')
  assert.equal(nightDue({ on: false, t: bj(23, 30), items }), false)
  assert.equal(nightDue({ on: true, t: bj(23, 30), items: [] }), false, 'nothing worth saying')
  assert.equal(nightDue({ on: true, t: bj(15), items }), false, 'daytime')
  assert.equal(nightDue({ on: true, t: bj(22, 10), items }), false, '22:10, still up')
  assert.equal(nightDue({ on: true, t: bj(22, 30), sleepAt: bj(22, 5), items }), true, 'asleep 25 minutes')
  assert.equal(nightDue({ on: true, t: bj(22, 20), sleepAt: bj(22, 5), items }), false, 'just lay down')
  assert.equal(nightDue({ on: true, t: bj(23, 5), items }), true, '23:00 even if she is still out')
  assert.equal(nightDue({ on: true, t: bj(23, 5), items, sentDay: dayKey(bj(23, 5)) }), false, 'once a night')
  assert.equal(nightDue({ on: true, t: bj(26), items, sentDay: dayKey(bj(23, 5)) }), false, '02:00 is still the same night')
  assert.equal(nightDue({ on: true, t: bj(28), items }), false, '04:00 is a new day, not night')
  assert.match(nightText(items), /今天的小结/)
  assert.ok(sleepsIn(STOPS) && !sleepsIn([STOPS[0]]))
})

test('settings: nightSummary is off by default and for users who never touched it; the page and the save handler know it', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const index = src('../lib/index.js')
  assert.match(index, /nightSummary: false/)
  assert.match(index, /nightSummary: Schema\.boolean\(\)\.default\(false\)/)
  assert.match(index, /config\.nightSummary === true/, 'only an explicit true turns it on')
  assert.match(index, /typeof data\.nightSummary === 'boolean'/)
  const client = src('../lib/client.js')
  assert.match(client, /setNightSum\(s\.nightSummary === true\)/)
  assert.match(client, /'晚上说说今天'/)
})

test('her own logs say the plan in short words (插件页「她的心思」), the owner\'s brief never does', () => {
  const t = didText({ action: 'none', plan: { stops: STOPS } })
  assert.match(t, /定了接下来的计划/)
  assert.match(t, /岛上 3 站（镜湖逛逛、麦香面包房买可颂、家睡觉）/)
  assert.equal(briefOf(entry({ tag: 'did', text: t })), '')
})
