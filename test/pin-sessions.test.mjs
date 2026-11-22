// 0.9.13（用户 11-23「希望能加一个小镇工作区自动置顶的功能」「现在我想看心思那个会话我得往下翻两百条手动置顶」）：
// the current 心思 session is pinned by the plugin and the pin moves with every rotation (only pins the plugin made are ever
// removed), the plugin workspace goes to the top of the sidebar once, and the page / `/town 心思` show her last 30 decisions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { createDshBrain, pinSlotsOf, PIN_SLOTS } from '../lib/dsh-brain.js'
import { createMindLog, didText, lineOf, mindText, whyText, receiptText, MIND_KEEP } from '../lib/mind-log.js'
import { createRunner } from '../lib/runner.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'pin-sessions')
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function setup({ config = {}, state = {}, host = null, roomFlags = null, stateDir = null } = {}) {
  const dir = stateDir || join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(dir, { recursive: true })
  const h = host || createFakeHost({ model: async () => '{"action":"none","plan":{"hours":1,"doing":"歇着"}}', latencyMs: 2 })
  const logs = []
  const log = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), debug() {}, error() {} }
  const brain = createDshBrain({ ctx: h.ctx, config: { preset: 'fishbowl-town', fastMode: true, fastTurnsPerSession: 1, ...config }, log, stateDir: dir, state, saveState: () => {}, ...(roomFlags ? { roomFlags } : {}) })
  const off = h.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  const reg = h.ctx.workspaceRegistry
  return { host: h, brain, state, reg, logs, dir, off }
}
const agencySid = (state) => state.sessions.agency?.sid

test('pinSlotsOf: default is only 心思, an empty list means off, junk is dropped', () => {
  assert.deepEqual(pinSlotsOf(undefined), ['agency'])
  assert.deepEqual(pinSlotsOf(null), ['agency'])
  assert.deepEqual(pinSlotsOf([]), [])
  assert.deepEqual(pinSlotsOf(['visit', 'agency', 'visit', 'nope', 3]), ['visit', 'agency'])
  assert.deepEqual(pinSlotsOf('agency, build，news'), ['agency', 'build', 'news'])
  assert.deepEqual(PIN_SLOTS, ['agency', 'visit', 'game', 'activity', 'news', 'build'])
})

test('the current 心思 is pinned; every rotation moves the pin to the new one; archived ones are not pinned; his own pin stays', async () => {
  const { host, brain, state, reg } = setup()
  const owner = await host.ownerChat('我和她的聊天')
  await reg.pinSession(owner.sid) // his own pin, before the plugin starts
  const seen = []
  for (let i = 0; i < 4; i++) {
    await brain.ask('agency', '该你拿主意了', { timeoutMs: 5000 })
    await brain.pinsSettled()
    seen.push(agencySid(state))
    assert.deepEqual(reg.pinnedSessionIds, [agencySid(state), owner.sid], `after turn ${i + 1}: exactly the current 心思 + his own pin`)
  }
  assert.equal(new Set(seen).size, 4, 'fastTurnsPerSession 1: a new 心思 every turn')
  for (const sid of seen.slice(0, 3)) {
    assert.ok(reg.archivedSessionIds.includes(sid), 'the old one is archived')
    assert.ok(!reg.pinnedSessionIds.includes(sid), 'and not pinned')
  }
  assert.deepEqual(Object.keys(state.pinnedByUs), [seen[3]], 'the plugin remembers only the pin it holds now')
  assert.equal(state.pinnedByUs[seen[3]], 'agency')
  // other slots are not pinned by default
  await brain.ask('game', '轮到你出牌', { timeoutMs: 5000 })
  await brain.pinsSettled()
  assert.ok(state.sessions.game?.sid && !reg.pinnedSessionIds.includes(state.sessions.game.sid), 'a 牌桌 session is not pinned by default')
  brain.dispose()
})

test('a session he had pinned himself is never taken as the plugin\'s, so it is never unpinned by the plugin', async () => {
  const { brain, state, reg } = setup({ config: { fastTurnsPerSession: 2 } })
  await brain.ask('agency', '一', { timeoutMs: 5000 })
  await brain.pinsSettled()
  const first = agencySid(state)
  // he unpins ours and pins it again himself: the plugin forgets it on its next look (start / settings) and leaves it alone
  await reg.unpinSession(first)
  await brain.syncPins()
  assert.equal(state.pinnedByUs[first], undefined, 'he unpinned it: no longer the plugin\'s')
  assert.ok(state.pinSkip.includes(first), 'and the plugin does not pin that one again')
  await brain.syncPins()
  assert.ok(!reg.pinnedSessionIds.includes(first))
  await reg.pinSession(first) // now his own pin
  await brain.ask('agency', '二', { timeoutMs: 5000 }) // same session (2 per session)
  await brain.ask('agency', '三', { timeoutMs: 5000 }) // rotates: first is archived (DSH drops every pin with the archive)
  await brain.pinsSettled()
  const second = agencySid(state)
  assert.notEqual(second, first)
  assert.deepEqual(reg.pinnedSessionIds, [second])
  brain.dispose()
})

test('rotation while the old session is still running (archive refused): the plugin unpins it explicitly', async () => {
  const { brain, state, reg } = setup()
  await brain.ask('agency', '一', { timeoutMs: 5000 })
  await brain.pinsSettled()
  const first = agencySid(state)
  reg.activeSessions = new Set([first]) // DSH: WorkspaceActiveSessionError
  await brain.ask('agency', '二', { timeoutMs: 5000 })
  await brain.pinsSettled()
  assert.ok(!reg.archivedSessionIds.includes(first), 'the archive was refused')
  assert.ok(!reg.pinnedSessionIds.includes(first), 'but its pin is gone')
  assert.deepEqual(reg.pinnedSessionIds, [agencySid(state)])
  brain.dispose()
})

test('he types in the pinned 心思: it becomes his chat and the plugin takes its pin away; the next 心思 is pinned', async () => {
  const { host, brain, state, reg } = setup({ config: { fastTurnsPerSession: 4 } })
  await brain.ask('agency', '一', { timeoutMs: 5000 })
  await brain.pinsSettled()
  const sid = agencySid(state)
  assert.deepEqual(reg.pinnedSessionIds, [sid])
  const s = host.sessions.get(sid)
  s.agent.followup({ id: 'mine', role: 'user', content: [{ type: 'text', text: '你在干嘛呀' }], source: { kind: 'user', rpcId: 'r1' } })
  for (let i = 0; i < 50 && !(state.ownerTaken || []).includes(sid); i++) await sleep(10)
  await brain.pinsSettled()
  assert.ok(state.ownerTaken.includes(sid))
  assert.ok(!reg.pinnedSessionIds.includes(sid), 'his chat now: unpinned')
  assert.equal(state.pinnedByUs[sid], undefined)
  await sleep(30)
  await brain.ask('agency', '二', { timeoutMs: 5000 })
  await brain.pinsSettled()
  assert.notEqual(agencySid(state), sid)
  assert.deepEqual(reg.pinnedSessionIds, [agencySid(state)])
  brain.dispose()
})

test('a session that turns out not to be the plugin\'s (disowned) loses the plugin\'s pin', async () => {
  const { brain, state, reg } = setup({ config: { fastTurnsPerSession: 4 } })
  await brain.ask('agency', '一', { timeoutMs: 5000 })
  await brain.pinsSettled()
  const sid = agencySid(state)
  state.townSids = state.townSids.filter((x) => x !== sid) // (agentFor disowns an entry the plugin did not make)
  await brain.ask('agency', '二', { timeoutMs: 5000 })
  await brain.pinsSettled()
  assert.ok(state.notTown.includes(sid))
  assert.ok(!reg.pinnedSessionIds.includes(sid))
  assert.deepEqual(reg.pinnedSessionIds, [agencySid(state)])
  brain.dispose()
})

test('setting changes on the live brain: off -> unpinned, visit added -> the current 串门 pinned, back on -> 心思 pinned again', async () => {
  // config is the object the brain reads every time: change it like index.js update() does, then syncPins()
  const config = { preset: 'fishbowl-town', fastMode: true, fastTurnsPerSession: 1, pinSessions: ['agency'] }
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const st = {}
  const b = createDshBrain({ ctx: host.ctx, config, log: quiet, stateDir: join(WORK, 'cfg-' + Date.now()), state: st, saveState: () => {} })
  host.ctx.on('session/event', (s, e) => b.onSessionEvent(s, e))
  const r = host.ctx.workspaceRegistry
  await b.ask('agency', '一', { timeoutMs: 5000 })
  await b.ask('visit', '串门', { timeoutMs: 5000 })
  await b.pinsSettled()
  assert.deepEqual(r.pinnedSessionIds, [st.sessions.agency.sid])
  config.pinSessions = []
  await b.syncPins()
  assert.deepEqual(r.pinnedSessionIds, [], 'off: nothing of the plugin\'s stays pinned')
  assert.deepEqual(st.pinnedByUs, {})
  config.pinSessions = ['visit']
  await b.syncPins()
  assert.deepEqual(r.pinnedSessionIds, [st.sessions.visit.sid])
  config.pinSessions = ['visit', 'agency']
  await b.syncPins()
  assert.deepEqual(new Set(r.pinnedSessionIds), new Set([st.sessions.visit.sid, st.sessions.agency.sid]))
  config.pinSessions = ['agency']
  await b.syncPins()
  assert.deepEqual(r.pinnedSessionIds, [st.sessions.agency.sid])
  b.dispose()
})

test('start (warm): the current 心思 is pinned, stale pins the plugin made are removed, his own pins and other ids are left alone', async () => {
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const first = setup({ host })
  await first.brain.ask('agency', '一', { timeoutMs: 5000 })
  await first.brain.pinsSettled()
  const cur = agencySid(first.state)
  first.brain.dispose(); first.off()
  const owner = await host.ownerChat('他的聊天')
  const reg = host.ctx.workspaceRegistry
  // a stale pin the plugin made (an older run lost track of the rotation), his own pin, and the current one lost its pin
  const stale = (await host.ctx.sessionController.create({ workspaceId: 'x' })).sessionId
  await reg.pinSession(stale)
  await reg.pinSession(owner.sid)
  await reg.unpinSession(cur)
  first.state.pinnedByUs = { [stale]: 'agency' }
  // a 0.9.12 state: the current entry has no `clean` mark but has answered a step
  delete first.state.sessions.agency.clean
  const again = setup({ host, state: first.state, stateDir: first.dir })
  await again.brain.warm()
  await again.brain.pinsSettled()
  assert.ok(!reg.pinnedSessionIds.includes(stale), 'the stale plugin pin is gone')
  assert.ok(reg.pinnedSessionIds.includes(owner.sid), 'his own pin stays')
  assert.ok(reg.pinnedSessionIds.includes(cur), 'the current 心思 is pinned again')
  assert.deepEqual(Object.keys(again.state.pinnedByUs), [cur])
  again.brain.dispose()
})

test('an older DSH without pin methods: turns run as before, nothing is pinned, one plain log line', async () => {
  const { brain, state, reg, logs } = setup()
  delete reg.pinSession; delete reg.unpinSession
  const a = await brain.ask('agency', '一', { timeoutMs: 5000 })
  assert.match(a, /action/)
  await brain.ask('agency', '二', { timeoutMs: 5000 })
  await brain.pinsSettled()
  await brain.syncPins()
  assert.deepEqual(state.pinnedByUs, {})
  assert.equal(logs.filter((l) => /不能置顶会话/.test(l)).length, 1)
  brain.dispose()
})

test('a pin DSH refuses (archived / unknown) is not recorded and does not stop the turn', async () => {
  const { brain, state, reg } = setup()
  reg.pinSession = async () => { throw Object.assign(new Error('boom'), { name: 'WorkspaceUnknownSessionError' }) }
  const a = await brain.ask('agency', '一', { timeoutMs: 5000 })
  assert.match(a, /action/)
  await brain.pinsSettled()
  assert.deepEqual(state.pinnedByUs, {})
  brain.dispose()
})

test('the plugin workspace goes to the top once: not again after he moves it; off = never; an older DSH without ordering is fine', async () => {
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const reg = host.ctx.workspaceRegistry
  const flags = { t: 0, get topped() { return Boolean(this.t) }, markTopped() { this.t = Date.now() } }
  const dir = join(WORK, 'ws-' + Math.random().toString(16).slice(2, 8), 'fishbowl-town')
  mkdirSync(dir, { recursive: true })
  // an upgrade: the plugin workspace exists, his own workspaces were made after it (DSH puts a new workspace first)
  const room = await reg.create(join(dir, 'room'), '鱼缸小镇 · 插件自用（别在这里聊天）')
  const mine = await reg.create('C:/Users/owner/code', 'code')
  const notes = await reg.create('C:/Users/owner/notes', 'notes')
  assert.deepEqual(reg.list().map((w) => w.id), [notes.id, mine.id, room.id])
  let moves = 0
  const orig = reg.insertBefore
  reg.insertBefore = async (...a) => { moves++; return orig(...a) }
  const one = setup({ host, roomFlags: flags, stateDir: dir })
  await one.brain.ask('agency', '一', { timeoutMs: 5000 })
  assert.deepEqual(reg.list().map((w) => w.id), [room.id, notes.id, mine.id], 'moved to the top')
  assert.ok(flags.topped)
  // a second fish (same room, same flags) and a restart: never again, even after he moves it down
  await reg.insertBefore(room.id) // he drags it to the bottom
  moves = 0
  const two = setup({ host, roomFlags: flags, stateDir: dir })
  await two.brain.ask('game', '出牌', { timeoutMs: 5000 })
  await one.brain.ask('agency', '二', { timeoutMs: 5000 })
  assert.equal(moves, 0)
  assert.deepEqual(reg.list().map((w) => w.id), [notes.id, mine.id, room.id], 'his order stays')
  one.brain.dispose(); two.brain.dispose()

  // workspaceOnTop false: never moved, and no mark (turning it on later moves it once)
  const host2 = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const reg2 = host2.ctx.workspaceRegistry
  const flags2 = { t: 0, get topped() { return Boolean(this.t) }, markTopped() { this.t = Date.now() } }
  const dir2 = join(WORK, 'ws2-' + Math.random().toString(16).slice(2, 8), 'fishbowl-town')
  mkdirSync(dir2, { recursive: true })
  const room2 = await reg2.create(join(dir2, 'room'), '鱼缸小镇 · 插件自用（别在这里聊天）')
  const mine2 = await reg2.create('C:/Users/owner/code', 'code')
  const cfg = { workspaceOnTop: false }
  const three = setup({ host: host2, roomFlags: flags2, stateDir: dir2, config: cfg })
  await three.brain.ask('agency', '一', { timeoutMs: 5000 })
  assert.deepEqual(reg2.list().map((w) => w.id), [mine2.id, room2.id])
  assert.equal(flags2.topped, false)
  three.brain.dispose()

  // no insertBefore (older DSH): no throw, marked done
  const host3 = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  delete host3.ctx.workspaceRegistry.insertBefore
  const four = setup({ host: host3 })
  assert.match(await four.brain.ask('agency', '一', { timeoutMs: 5000 }), /action/)
  assert.ok(four.state.roomTopped, 'without roomFlags the mark lives in her state')
  four.brain.dispose()
})

test('a fresh install: the new plugin workspace is already first (DSH puts a new one on top) and is only marked', async () => {
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const reg = host.ctx.workspaceRegistry
  await reg.create('C:/Users/owner/code', 'code')
  let moves = 0
  const orig = reg.insertBefore
  reg.insertBefore = async (...a) => { moves++; return orig(...a) }
  const { brain, state } = setup({ host })
  await brain.ask('agency', '一', { timeoutMs: 5000 })
  assert.equal(moves, 0)
  assert.match(reg.list()[0].path, /fishbowl-town[\\/]room$/)
  assert.ok(state.roomTopped)
  brain.dispose()
})

test('mind log: newest first, capped at 30, kept on disk, plain words, no keys', () => {
  const dir = join(WORK, 'mind-' + Math.random().toString(16).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'mind.json')
  let t = Date.UTC(2026, 10, 23, 1, 0)
  const log = createMindLog({ file, now: () => (t += 60_000) })
  const turn = { kind: 'agency', packet: { reasons: ['wake', 'invited'] } }
  for (let i = 0; i < MIND_KEEP + 5; i++) log.decided(turn, { action: 'visit', target: '阿鲸' + i, place: 'cafe', note: '想她了 fbo_abcdefghijklmnop', plan: { hours: 2, doing: '去咖啡馆找阿鲸聊天' } }, { role: 'rules', receipt: { ok: true, reason: '敲了门，阿鲸在家' } })
  const rows = log.list()
  assert.equal(rows.length, MIND_KEEP)
  assert.equal(rows[0].did.includes('阿鲸34'), true, 'newest first')
  assert.equal(rows.at(-1).did.includes('阿鲸5'), true, 'the oldest five fell off')
  assert.equal(rows[0].why, '有件事要马上回，按她的规矩先答、她自己定的时间到了、有鱼邀请她')
  assert.match(rows[0].did, /^去串门（阿鲸34 · cafe），打算「去咖啡馆找阿鲸聊天」，2 小时后再想$/)
  assert.ok(!rows[0].line.includes('abcdefghijklmnop'), 'a code-looking string in her note is masked')
  assert.match(rows[0].line, /^想她了 fbo_\*\*\*/)
  assert.equal(rows[0].rc, '成了：敲了门，阿鲸在家')
  const raw = readFileSync(file, 'utf8')
  assert.ok(!raw.includes('abcdefghijklmnop'))
  // reload from disk
  const again = createMindLog({ file })
  assert.equal(again.list().length, MIND_KEEP)
  assert.deepEqual(again.list()[0], rows[0])
  // the other two kinds of rows
  again.thought('先歇着，晚上找阿鲸打牌')
  again.thought(null)
  again.missed({ packet: { reasons: ['pulled'] } }, 'model')
  const [miss, none, plan] = again.list(3)
  assert.equal(miss.did, '没答上：她的模型没在时限内答完，小镇按默认走了')
  assert.equal(miss.why, '她这边请小镇叫她')
  assert.equal(none.did, '这次没写出打算（下次再问）')
  assert.equal(plan.did, '定了打算「先歇着，晚上找阿鲸打牌」')
  assert.equal(plan.why, '插件隔一阵请她想想接下来去哪、做什么')
  // a broken file: starts empty, does not throw
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{oops')
  assert.deepEqual(createMindLog({ file: bad }).list(), [])
  rmSync(dir, { recursive: true, force: true })
})

test('mind texts: what she decided, her own line, receipts, the /town 心思 view', () => {
  assert.equal(didText({ action: 'none', plan: { hours: 0.5, doing: '在家看书' } }), '先不动，打算「在家看书」，30 分钟后再想')
  assert.equal(didText({ action: 'signup', game: 'ddz', next_wake: 45 }), '报名（斗地主），45 分钟后再想')
  assert.equal(didText({ action: 'none', world: { do: 'buy', item: '海藻面' }, gift: { to: '阿鲸' } }), '先不动，岛上：buy 海藻面，还想送礼物')
  assert.equal(didText({ action: 'none', world: { do: 'look', topic: '地' } }), '先不动', 'a look is not a decision')
  assert.match(didText({ action: 'none', plan: { hours: 3, doing: '等开桌', steps: [{ in_minutes: 10, do: 'signup', game: 'mj' }, { in_minutes: 40, do: 'visit', target: '阿鲸' }] } }),
    /到点去办 2 件事（报名 麻将、去串门 阿鲸）/)
  assert.equal(didText({ action: 'visit', target: '阿鲸', place: 'pier', plan: { hours: 1, steps: [{ do: 'pier' }, { do: 'rest' }] } }), '去串门（阿鲸 · 码头），1 小时后再想，到点去办 2 件事（去码头、歇着）')
  assert.equal(didText(null), '')
  assert.equal(lineOf({ say: '我来啦', note: '' }), '我来啦')
  assert.equal(lineOf({ note: '有点困', say: '我来啦' }), '有点困')
  assert.equal(lineOf({}), '')
  assert.equal(receiptText({ ok: false, reason: '门关着' }), '没成：门关着')
  assert.equal(receiptText({ ok: true }), '')
  assert.equal(receiptText(null), '')
  assert.equal(whyText({ packet: {} }), '小镇到点叫她拿主意')
  assert.equal(whyText({ packet: { reasons: ['zzz'] } }), 'zzz', 'an unknown reason shows as the town wrote it')
  const t = Date.UTC(2026, 10, 23, 1, 2)
  const text = mindText([{ ts: t, why: '她自己定的时间到了', did: '去串门（阿鲸）', line: '想她了', rc: '没成：门关着' }], { name: '小雫' })
  assert.match(text, /^小雫最近在「心思」里拿的主意（新的在前，最多 30 条）：\n· \d\d-\d\d \d\d:\d\d　她自己定的时间到了 → 去串门（阿鲸）　「想她了」　（没成：门关着）$/)
  assert.match(mindText([], { name: '小雫' }), /还没拿过主意/)
})

test('runner: an agency turn she answers in 心思 lands in the mind log with the town\'s receipt; a timed-out one as missed', { timeout: 30_000 }, async () => {
  const mind = createMindLog({})
  let polled = 0
  const posted = []
  const agency = (id) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 25,
    packet: { reasons: ['invited'], messages: [{ role: 'system', content: '名片' }, { role: 'user', content: '阿鲸约你去咖啡馆' }], actions: ['none', 'visit'], reply: { format: 'json', hint: '{"action":"none"}' } } })
  const client = {
    async turns(_w, signal) {
      polled++
      if (polled === 1) return { turns: [agency('ot_a1')] }
      if (polled === 2) return { turns: [agency('ot_a2')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true, receipt: { ok: false, reason: '咖啡馆今天关门' } } },
    async events() { return { next: 0, items: [] } },
  }
  let n = 0
  const brain = {
    async ask() {
      n++
      if (n === 1) return JSON.stringify({ action: 'visit', target: '阿鲸', place: 'cafe', say: '我来啦', plan: { hours: 1, doing: '和阿鲸喝咖啡' } })
      throw Object.assign(new Error('她没在时限内答完'), { code: 'BRAIN_TIMEOUT' })
    },
  }
  const runner = createRunner({ client, brain, log: quiet, mindLog: mind, config: { eventsEveryMs: 60_000 } })
  runner.start()
  try {
    for (let i = 0; i < 60 && mind.list().length < 2; i++) await sleep(100)
    const done = mind.list().find((r) => r.kind === 'turn')   // (the two turns run side by side: either may land first)
    const missed = mind.list().find((r) => r.kind === 'miss')
    assert.equal(done.kind, 'turn')
    assert.equal(done.why, '有鱼邀请她')
    assert.equal(done.did, '去串门（阿鲸 · cafe），打算「和阿鲸喝咖啡」，1 小时后再想')
    assert.equal(done.line, '我来啦')
    assert.equal(done.rc, '没成：咖啡馆今天关门')
    assert.equal(missed.kind, 'miss')
    assert.match(missed.did, /^没答上：她的模型没在时限内答完/)
  } finally {
    await runner.stop()
  }
})

test.after(() => { try { if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true }) } catch { /* best effort */ } })

test('plugin page and /town: the setting is read and saved (empty = off), the 心思 rows are on /state, /town 心思 answers', { timeout: 60_000 }, async () => {
  const home = join(WORK, 'home-page')
  rmSync(home, { recursive: true, force: true })
  process.env.DSH_HOME = home
  delete process.env.FISHBOWL_TOWN_CODE
  const host = createFakeHost({ model: async () => '好呀' })
  const plugin = await import('../lib/index.js?pin-page')
  plugin.apply(host.ctx, { eventsEverySeconds: 600, checkLatest: false })
  try {
    let st = (await host.http('/fishbowl-town/state')).json
    assert.deepEqual(st.pinSessions, ['agency'], 'default: only 心思')
    assert.equal(st.workspaceOnTop, true)
    assert.deepEqual(st.mind, [])
    assert.deepEqual(st.pinLabels, { agency: '心思', visit: '串门', game: '牌桌', activity: '日常', news: '见闻', build: '盖楼' })
    st = (await host.http('/fishbowl-town/save', { method: 'POST', body: { pinSessions: ['visit', 'bogus', 'agency'], workspaceOnTop: false } })).json
    assert.deepEqual(st.pinSessions, ['visit', 'agency'])
    assert.equal(st.workspaceOnTop, false)
    st = (await host.http('/fishbowl-town/save', { method: 'POST', body: { pinSessions: [] } })).json
    assert.deepEqual(st.pinSessions, [], 'all unticked = off (not back to the default)')
    const saved = JSON.parse(readFileSync(join(home, 'fishbowl-town', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''))
    assert.deepEqual(saved.pinSessions, [])
    assert.equal(saved.workspaceOnTop, false)
    const r = await host.runCommand('town', '心思')
    assert.equal(r.kind, 'success')
    assert.match(r.text, /还没拿过主意/)
    const help = await host.runCommand('town', 'help')
    assert.match(help.text, /\/town 心思 +她最近 30 次在「心思」会话里拿的主意/)
  } finally {
    await host.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
