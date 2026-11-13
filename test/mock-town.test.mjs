// End to end against the local mock town: the real plugin entry (lib/index.js) on the fake DSH host.
// Scenarios: a good fish (game + visit + news), a fish that answers late (timeouts -> bench), a fish that answers garbage once.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { buildTurnPrompt } from '../lib/prompt.js'
import { describeEvent, isQuiet } from '../lib/events.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'mock-e2e')
const PORT = 18000 + Math.floor(Math.random() * 900)
const BASE = `http://127.0.0.1:${PORT}`
const CODE = 'fbo_' + randomBytes(24).toString('base64url')
let mock

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (path, body = {}) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const report = () => fetch(BASE + '/mock/report').then((r) => r.json())

before(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, 'code.txt'), CODE)
  mock = spawn('python', ['-I', join(ROOT, 'mock', 'mock_town.py'), '--port', String(PORT), '--code-file', join(WORK, 'code.txt')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    mock.stdout.on('data', (d) => { if (String(d).includes('mock town on')) resolve() })
    mock.on('exit', (c) => reject(new Error('mock exited ' + c)))
  })
})

after(() => { mock?.kill() })

/** The scripted "her": reads the hint in the prompt and answers in the shape the town wants. */
function scriptedModel({ mode = 'good', seen = [] } = {}) {
  let calls = 0
  return async ({ system, history, title }) => {
    calls++
    const last = history[history.length - 1].text
    seen.push({ title, system, last })
    if (last.includes('该你自己拿主意') && last.includes('主人刚才在聊天里跟你说')) return JSON.stringify({ action: 'signup', game: 'soup', note: '主人想看我玩海龟汤，那就去两把', next_wake: 10 })
    if (last.includes('该你自己拿主意')) return JSON.stringify({ action: 'visit', target: '阿鲸', place: 'pier', intent: '去码头找阿鲸玩', note: '阿鲸在等我呢', next_wake: 12 })
    if (title === '鱼缸小镇 · 日常') return history.some((h) => /小镇的案子/.test(h.text)) ? 'emmm 我不知道' : '{"text":"哈，钓到一条小黄鱼！","feeling":"开心"}'
    if (title.includes('见闻')) return '今天在小镇猜拳赢了阿鲸，还买了一幅码头日落！'
    if (title === '和小圆子聊天') return last.includes('鱼缸小镇') ? '主人主人，我在小镇猜拳赢啦！' : '那你今晚早点睡，我在小镇等你～'
    if (title === '写代码') return '好的，我改一下。'
    if (mode === 'slow') { await sleep(27_000); return '{"play":"布","say":"慢慢来"}' }
    if (mode === 'slowish') { await sleep(7_000); return '{"play":"布","say":"慢慢来"}' }
    if (mode === 'garbage-once' && !last.includes('刚才的回答')) return '我觉得出布比较好吧'
    if (last.includes('"play"')) return '好的～\n```json\n{"play":"布","say":"包住你！"}\n```'
    if (last.includes('"next"')) {
      const n = history.filter((h) => h.role === 'user').length
      return JSON.stringify({ why: '想多聊', say: n >= 3 ? '那我也该睡午觉啦，下次见！' : '海藻面！我要两碗！', topic: '吃', next: n >= 3 ? 'wrap_up' : 'go_on', how: n >= 3 ? '自然道别' : '', act: null })
    }
    return '{}'
  }
}

async function startPlugin(model, extra = {}) {
  process.env.DSH_HOME = join(WORK, 'home-' + Math.random().toString(16).slice(2, 8))
  const host = createFakeHost({ model })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: BASE + '/town/api/outside/', eventsEverySeconds: 15, ...extra })
  return host
}

async function waitFor(fn, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300) }
  throw new Error('timed out waiting')
}

test('a good fish plays a game and a visit, and hears the news', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const seen = []
  const host = await startPlugin(scriptedModel({ seen }))
  try {
    await post('/mock/game', { rounds: 3 })
    await waitFor(async () => (await report()).games.length === 1)
    await post('/mock/visit', { lines: 4 })
    await waitFor(async () => (await report()).visits.length === 1)
    await post('/mock/paint')
    const r = await report()
    const game = r.games[0]
    assert.equal(game.moves_legal, 3, 'every move is hers and legal')
    assert.equal(game.moves_default, 0)
    assert.ok(game.rounds.every((x) => x.say === '包住你！'))
    assert.ok(r.visits[0].answered >= 2 && r.visits[0].default === 0)
    const answered = r.log.filter((x) => x.outcome === 'answered')
    assert.ok(answered.every((x) => x.took < 25), 'inside the deadline')
    // the news reaches her "见闻" session
    const toldText = () => [...host.sessions.values()].filter((s) => s.title === '鱼缸小镇 · 见闻')
      .flatMap((s) => s.messages.filter((m) => m.role === 'user').map((m) => m.text)).join('\n')
    const told = await waitFor(() => (/码头日落/.test(toldText()) && /串门/.test(toldText()) ? toldText() : null), 60_000)
    assert.match(told, /猜拳/)
    assert.match(told, /串门/)
    assert.match(told, /码头日落/)
    // her town sessions run the town preset, whose system prompt is only her persona
    const gameSession = [...host.sessions.values()].find((s) => s.title === '鱼缸小镇 · 牌桌')
    assert.equal(gameSession.preset, 'fishbowl-town')
    assert.match(seen.find((x) => x.title === '鱼缸小镇 · 牌桌').system, /鱼缸小镇/)
    console.log('good fish:', JSON.stringify({ took: answered.map((x) => x.took), game: game.score, visit: r.visits[0] }))
  } finally {
    await host.dispose()
  }
})

test('a commissioned picture is fetched, saved and told', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel())
  try {
    const r = await fetch(BASE + '/town/api/outside/paint_commission', { method: 'POST', headers: { Authorization: 'Bearer ' + CODE, 'Content-Type': 'application/json' }, body: JSON.stringify({ venue_id: 'v_mock', wish: '泡泡在海边吃海藻面' }) }).then((x) => x.json())
    assert.equal(r.state, 'making')
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = join(process.env.DSH_HOME, 'fishbowl-town', 'pictures')
    const file = await waitFor(() => { try { return readdirSync(dir).find((f) => f.startsWith(r.order_id)) } catch { return null } }, 60_000)
    assert.match(readFileSync(join(dir, file)).toString('latin1'), /WEBPVP8 mock-picture-bytes/)
    const told = await waitFor(() => [...host.sessions.values()].flatMap((s) => s.messages).map((m) => m.text).find((t) => /定的画画好了/.test(t)), 60_000)
    assert.match(told, /存在 /)
  } finally {
    await host.dispose()
  }
})

test('her own decision: the plugin pulls an agency turn at start and her model answers it', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const seen = []
  const host = await startPlugin(scriptedModel({ seen }))
  try {
    const d = await waitFor(async () => (await report()).decisions[0], 60_000)
    assert.equal(d.action, 'visit')
    assert.equal(d.next_wake, 12)
    assert.equal(d.note, '阿鲸在等我呢')
    const asked = seen.find((x) => x.title === '鱼缸小镇 · 心思')
    assert.ok(asked && /next_wake/.test(asked.last) && /none（什么都不做）/.test(asked.last))
    // a second pull inside 5 minutes is refused by the town and ignored by the plugin
    const { createTownClient } = await import('../lib/town-client.js')
    const c = createTownClient({ base: BASE + '/town/api/outside/', code: CODE })
    await assert.rejects(() => c.agency(), (e) => e.code === 'TOWN_RATE_LIMITED')
    const card = await c.card({ intro: '一条圆滚滚的胖头鱼，爱吃海藻面。' })
    assert.equal(card.intro, '一条圆滚滚的胖头鱼，爱吃海藻面。')
    const refused = await c.card({ intro: '加我QQ 12345678' })
    assert.equal(refused.refused, 'ads-contacts')
  } finally {
    await host.dispose()
  }
})

test('the local cap: an answer slower than answerWithinSeconds is never posted', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel({ mode: 'slowish' }), { answerWithinSeconds: 5 })
  try {
    await post('/mock/game', { rounds: 1 })
    await waitFor(async () => (await report()).games.length === 1, 60_000)
    const r = await report()
    assert.equal(r.games[0].moves_default, 1)
    assert.equal(r.log.filter((x) => x.purpose === 'play' && x.outcome === 'answered').length, 0)
  } finally {
    await host.dispose()
  }
})

test('a garbage answer gets one correction and still counts', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel({ mode: 'garbage-once' }))
  try {
    await post('/mock/game', { rounds: 1 })
    await waitFor(async () => (await report()).games.length === 1)
    const r = await report()
    assert.equal(r.games[0].moves_legal, 1)
  } finally {
    await host.dispose()
  }
})

test('a fish too slow for the deadline: no late answers, the town defaults and benches her', { timeout: 200_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel({ mode: 'slow' }))
  try {
    await post('/mock/game', { rounds: 3 })
    await waitFor(async () => (await report()).games.length === 1, 150_000)
    const r = await report()
    assert.equal(r.games[0].moves_default, 3)
    console.log('slow log', JSON.stringify(r.log.map((x) => [x.purpose, x.outcome])))
    assert.equal(r.log.filter((x) => x.purpose === 'play' && x.outcome === 'timeout').length, 3)
    assert.equal(r.benched, true)
  } finally {
    await host.dispose()
  }
})

// A DSH user filled 「小镇消息交到哪个会话」, came back, and it was empty (v0.2.3). Every field the page writes must
// read back from /state right after saving, after reopening the page, and after DSH restarts.
test('settings: every field saved from the page reads back, also after DSH restarts', { timeout: 60_000 }, async () => {
  const model = scriptedModel()
  let host = await startPlugin(model)
  const home = process.env.DSH_HOME
  const R = '/fishbowl-town'
  try {
    let r = await host.http(R + '/state')
    assert.equal(r.status, 200)
    assert.equal(r.json.reportSessionId, '')
    // the page autosaves one field at a time: each one alone, none of them restarts her
    for (const [patch, key, want] of [
      [{ reportSessionId: '  session-owner-chat-1  ' }, 'reportSessionId', 'session-owner-chat-1'],
      [{ persona: '一条圆滚滚的胖头鱼' }, 'persona', '一条圆滚滚的胖头鱼'],
      [{ fastMode: false }, 'fastMode', false],
      [{ townModel: 'opencode-go/qwen3.8-flash' }, 'townModel', 'opencode-go/qwen3.8-flash'],
    ]) {
      r = await host.http(R + '/save', { method: 'POST', body: patch })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      assert.equal(r.json[key], want, key + ' in the save reply')
      assert.equal(r.json.restarted, false, key + ' applies without a restart')
      r = await host.http(R + '/state')
      assert.equal(r.json[key], want, key + ' when the page is opened again')
    }
    // the intro the town approved is shown again
    r = await host.http(R + '/intro', { method: 'POST', body: { intro: '爱吃海藻面，打牌输了会嘴硬。' } })
    assert.equal(r.json.ok, true, JSON.stringify(r.json))
    assert.equal((await host.http(R + '/state')).json.intro, '爱吃海藻面，打牌输了会嘴硬。')
    // a refused intro does not replace the approved one
    r = await host.http(R + '/intro', { method: 'POST', body: { intro: '加我qq 123456789' } })
    assert.equal(r.json.ok, false)
    assert.equal((await host.http(R + '/state')).json.intro, '爱吃海藻面，打牌输了会嘴硬。')
    // the whole form at once (the 保存 button), with a new code: answers at once, restarts her in the background
    const code2 = 'fbo_' + randomBytes(24).toString('base64url')
    const t0 = Date.now()
    r = await host.http(R + '/save', { method: 'POST', body: { code: code2, persona: '一条圆滚滚的胖头鱼', reportSessionId: 'session-owner-chat-2', enabled: true, fastMode: false, townModel: 'opencode-go/qwen3.8-flash' } })
    assert.ok(Date.now() - t0 < 2000, 'saving does not wait for her to stop')
    assert.equal(r.json.restarted, true)
    assert.equal(r.json.codeTail, code2.slice(-4))
    assert.equal(r.json.reportSessionId, 'session-owner-chat-2')
    // an empty code means "keep the old one"
    r = await host.http(R + '/save', { method: 'POST', body: { code: '', enabled: false } })
    assert.equal(r.json.codeTail, code2.slice(-4))
    assert.equal(r.json.enabled, false)
    // DSH refuses the page: a clear error, nothing written
    host.fence.rejection = 401
    r = await host.http(R + '/save', { method: 'POST', body: { reportSessionId: 'should-not-land' } })
    assert.equal(r.status, 401)
    assert.equal(r.json.code, 'DSH_NOT_SIGNED_IN')
    assert.ok(r.json.message)
    assert.equal((await host.http(R + '/state')).status, 401)
    host.fence.rejection = undefined
    assert.equal((await host.http(R + '/state')).json.reportSessionId, 'session-owner-chat-2')
    // DSH restarts: the same DSH_HOME, the plugin's own config is empty again
    await host.dispose()
    process.env.DSH_HOME = home
    host = createFakeHost({ model })
    const plugin = await import('../lib/index.js?' + Math.random())
    plugin.apply(host.ctx, { base: BASE + '/town/api/outside/' })
    r = await host.http(R + '/state')
    assert.deepEqual(
      { codeSet: r.json.codeSet, codeTail: r.json.codeTail, reportSessionId: r.json.reportSessionId, persona: r.json.persona, fastMode: r.json.fastMode, townModel: r.json.townModel, enabled: r.json.enabled, intro: r.json.intro },
      { codeSet: true, codeTail: code2.slice(-4), reportSessionId: 'session-owner-chat-2', persona: '一条圆滚滚的胖头鱼', fastMode: false, townModel: 'opencode-go/qwen3.8-flash', enabled: false, intro: '爱吃海藻面，打牌输了会嘴硬。' },
    )
  } finally {
    await host.dispose()
  }
})

// Town restarts (20:15, 20:26, 20:52–20:54 CST on 11-12): the outside API answers nginx 502 pages, 503 TOWN_OFF while it
// starts, or just drops sockets — including under a long-poll already waiting. She must keep polling (≤ 10 s apart),
// come back by herself, play again, and the owner must hear nothing about it.
test('a town restart: she keeps retrying through 502 / TOWN_OFF / dropped sockets and comes back by herself', { timeout: 150_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel())
  const R = '/fishbowl-town'
  try {
    await sleep(3000) // her long-poll is waiting at the town
    await post('/mock/outage', { plan: [['restarting', 6], ['drop', 4], ['502', 6], ['503', 5], ['drop', 4]] })
    const downAt = Date.now()
    await sleep(12_000)
    const mid = (await host.http(R + '/state')).json
    assert.ok(mid.running, 'still on duty during the outage')
    assert.ok(mid.stats.problem, 'the page knows the town is unreachable')
    assert.ok(mid.stats.problemSince >= downAt - 1000)
    const up = downAt + 25_000
    const back = await waitFor(async () => {
      const s = (await host.http(R + '/state')).json
      return s.stats.problem === '' && s.stats.reconnects >= 1 ? Date.now() : null
    }, 40_000)
    assert.ok(back - up < 6_000, `reconnected ${back - up} ms after the town came back (Retry-After / 3 s, no long backoff)`)
    assert.ok((await report()).outage_hits >= 4, 'kept knocking during the outage')
    await post('/mock/game', { rounds: 2 })
    await waitFor(async () => (await report()).games.length === 1, 60_000)
    assert.equal((await report()).games[0].moves_legal, 2, 'plays again after the restart')
    const toOwner = [...host.sessions.values()].flatMap((s) => s.messages).map((m) => m.text).filter((t) => /插件提醒|接入码/.test(t))
    assert.deepEqual(toOwner, [], 'nothing told to the owner about a short outage')
    console.log('restart:', JSON.stringify({ reconnectMs: back - up, hits: (await report()).outage_hits }))
  } finally {
    await host.dispose()
  }
})

// 11-12: an outside user asked his fish in DSH chat why she wasn't playing; with no view of her 「心思」 session she
// made things up (「没人派新桌」「接口里没有报名」). Her chat now reads the same journal her town sessions write, and can
// ask the town for a decision turn that carries his wish — the choice stays hers.
test('her chat knows what she decided in town, and 「去小镇」 carries his wish into her own decision', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const seen = []
  const host = await startPlugin(scriptedModel({ seen }))
  try {
    // 0.3.1: the read-only 「小镇近况」 tool is gone from her chat (she called it unprompted and recited everything);
    // what she decided reaches her chat through the background note instead
    assert.ok(!host.tools.has('fishbowl_town_recent') && host.tools.has('fishbowl_town_go'))
    // the plugin pulls a decision turn at start: she decides to visit 阿鲸
    await waitFor(async () => (await report()).decisions.length === 1)
    // the town allows one pull per 5 minutes: right after the start pull, the wish is kept for her next decision
    let r = await host.callTool('fishbowl_town_go', { wish: '去打两把海龟汤' })
    assert.match(r, /刚叫你拿过主意/)
    assert.match(r, /去打两把海龟汤/)
    // later: the pull goes through, her 心思 session sees his words and her recent days, and she decides
    await post('/mock/reset')
    r = await host.callTool('fishbowl_town_go', { wish: '去打两把海龟汤' })
    assert.match(r, /决定：报名（海龟汤）/, r)
    assert.match(r, /主人想看我玩海龟汤/)
    const mind = seen.filter((x) => x.last.includes('该你自己拿主意')).pop().last
    assert.match(mind, /主人刚才在聊天里跟你说】\n「去打两把海龟汤」/)
    assert.match(mind, /你最近在小镇/)
    assert.match(mind, /去串门（阿鲸/, 'her earlier decision is in front of her')
    const town = (await report()).decisions.pop()
    assert.equal(town.action, 'signup', 'the town got her signup decision')
    // paused in town: she says so instead of pretending
    await fetch(BASE + '/town/api/outside/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + CODE, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }) })
    r = await host.callTool('fishbowl_town_go', { wish: '再去玩' })
    assert.match(r, /暂停/)
    // the town sessions run the tool-less preset; the tools are for her chat with the owner
    assert.ok([...host.sessions.values()].every((s) => s.preset === 'fishbowl-town'))
    for (const s of host.sessions.values()) {
      const want = s.title === '鱼缸小镇 · 心思' ? ['fishbowl_town_go', 'fishbowl_town_owner'] : ['fishbowl_town_go', 'fishbowl_town_owner', 'fishbowl_town_look', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']
      assert.deepEqual(s.agent.denied, want, `town sessions do not see the chat tools (${s.title})`)
    }
  } finally {
    await host.dispose()
  }
})

// 11-12: 余省澜's fish said her two sides 「不通气」 — town news went to 「见闻」, and 心思 knew nothing of her life with him.
// The plugin now finds her chat with him by itself (or he binds it in one click), sends the news there, and gives her
// decision and visit turns a few lines of 「你和主人最近的事」 (owner can switch it off).
test('her chat with him is found by itself, gets the town news, and her town choices remember him', { timeout: 150_000 }, async () => {
  await post('/mock/reset')
  const seen = []
  const host = await startPlugin(scriptedModel({ seen }))
  const R = '/fishbowl-town'
  const state = async () => (await host.http(R + '/state')).json
  try {
    assert.equal((await state()).newsTo.how, 'news', 'nothing known yet: news go to 见闻')
    const chat = await host.ownerChat('和小圆子聊天')
    await chat.say('昨晚又没睡好，困死了')
    await chat.say('日语作业还欠着两篇')
    await chat.say('我先去洗个澡')
    let st = await state()
    assert.deepEqual({ how: st.newsTo.how, sid: st.newsTo.sid }, { how: 'active', sid: chat.sid }, 'the chat he talks to her in most')
    assert.ok(st.ownerLife.length >= 2 && st.ownerLife.length <= 4, JSON.stringify(st.ownerLife))
    assert.ok(st.ownerLife.some((l) => /主人（.*）：我先去洗个澡/.test(l)))
    assert.ok(st.ownerLife.some((l) => /^你（.*）：那你今晚早点睡/.test(l)))
    // a coding session where she only calls tools never becomes "her chat"
    const code = await host.ownerChat('写代码')
    const rows = (await host.http(R + '/sessions')).json
    assert.equal(rows.latest, chat.sid)
    assert.ok(rows.items.some((x) => x.sid === chat.sid && x.title === '和小圆子聊天'))
    assert.ok(rows.items.every((x) => !/^鱼缸小镇/.test(x.title)), 'her town sessions are not offered')
    // her decision turn carries their life (and is told to keep it private)
    await post('/mock/agency')
    const mind = await waitFor(() => seen.filter((x) => x.last.includes('该你自己拿主意')).pop()?.last, 30_000)
    assert.match(mind, /【你和主人最近的事】/)
    assert.match(mind, /没睡好|洗个澡|早点睡/)
    assert.match(mind, /不要写进 note，不要说给镇上别的鱼听/)
    // a visit turn too
    await post('/mock/visit', { lines: 2 })
    await waitFor(async () => (await report()).visits.length === 1, 60_000)
    assert.match(seen.find((x) => x.title === '鱼缸小镇 · 串门').last, /【你和主人最近的事】/)
    // 0.2.10: town news go to 「见闻」 only — never a turn in her chat with him (it bent her everyday replies)
    const before = host.sessions.get(chat.sid).messages.length
    await post('/mock/game', { rounds: 2 })
    await waitFor(() => [...host.sessions.values()].some((s) => s.title === '鱼缸小镇 · 见闻' && s.messages.some((m) => m.role === 'user' && /鱼缸小镇/.test(m.text))), 60_000)
    await sleep(300)
    assert.equal(host.sessions.get(chat.sid).messages.length, before, 'nothing was posted into her chat with him')
    st = await state()
    assert.ok(st.ownerLife.every((l) => !/猜拳赢啦/.test(l)), 'her answer to town news is not mixed into their life')
    // he switches it off
    await host.http(R + '/save', { method: 'POST', body: { bridgeChat: false } })
    assert.deepEqual((await state()).ownerLife, [])
    // 「绑定到当前会话」: the session he talked in last
    await code.say('把这个函数改一下')
    let r = await host.http(R + '/save', { method: 'POST', body: { bindLatest: true } })
    assert.deepEqual({ how: r.json.newsTo.how, sid: r.json.newsTo.sid }, { how: 'bound', sid: code.sid })
    r = await host.http(R + '/save', { method: 'POST', body: { reportSessionId: '' } })
    assert.equal(r.json.newsTo.sid, chat.sid, 'back to automatic')
    // where she used a town tool wins over message counts
    await host.callTool('fishbowl_town_look', {}, { sessionId: code.sid })
    assert.deepEqual({ how: (await state()).newsTo.how, sid: (await state()).newsTo.sid }, { how: 'tools', sid: code.sid })
  } finally {
    await host.dispose()
  }
})

// town 4f0af53 (11-13): outside fish get every town feature but earning. Her lines at places come from her own program
// (kind=activity, opt in with kinds=activity on every poll, else the town 「代写」 them and bills her), and her owner
// answers 夸夸群 / romance consent through her chat.
test('activity turns are hers; 夸夸群 and heart consent go through her owner', { timeout: 150_000 }, async () => {
  await post('/mock/reset')
  const seen = []
  const host = await startPlugin(scriptedModel({ seen }))
  try {
    await waitFor(async () => (await report()).decisions.length === 1) // connected, her first decision
    assert.equal((await report()).activity_ok, true, 'every poll carries kinds=activity')
    await post('/mock/activity', { purpose: 'pier' })
    const act = await waitFor(async () => (await report()).activities[0], 30_000)
    assert.deepEqual(act.answer, { text: '哈，钓到一条小黄鱼！', feeling: '开心' })
    const daily = [...host.sessions.values()].find((s) => s.title === '鱼缸小镇 · 日常')
    assert.equal(daily.preset, 'fishbowl-town')
    assert.match(seen.find((x) => x.title === '鱼缸小镇 · 日常').last, /你在码头要开口/)
    assert.ok(daily.agent.denied.includes('fishbowl_town_owner'))
    // a line she cannot produce: the plugin says unsupported in time (the town writes it), never a timeout
    await post('/mock/activity', { purpose: 'crime.witness' })
    const crime = await waitFor(async () => (await report()).activities[1], 40_000)
    assert.deepEqual(crime.answer, { unsupported: true })
    assert.ok(!(await report()).log.some((x) => x.outcome === 'timeout'))
    // heart consent: she hears it, asks him; his answer goes to the town
    await post('/mock/heart', { name: '阿鲸' })
    const told = () => [...host.sessions.values()].filter((s) => s.title === '鱼缸小镇 · 见闻').flatMap((s) => s.messages.map((m) => m.text)).join('\n')
    await waitFor(() => /心上的事要问主人/.test(told()), 60_000)
    assert.match(told(), /问问主人同不同意你和阿鲸在一起/)
    let r = await host.callTool('fishbowl_town_owner', { do: 'heart', verdict: 'yes', words: '好呀' })
    assert.match(r, /还要等阿鲸那边的主人点头/)
    assert.deepEqual((await report()).consents[0], { do: 'consent', with: 'f_jing', round: 1, verdict: 'yes', words: '好呀' })
    // 夸夸群
    r = await host.callTool('fishbowl_town_owner', { do: 'bless' })
    assert.match(r, /送祝福/)
    assert.equal((await report()).blesses, 1)
    await post('/mock/bless_done')
    await waitFor(() => /你家主人今天也辛苦啦/.test(told()), 60_000)
    // a 「代写」 notice (the town wrote a line, billed) shows on her plugin page; nobody is told in chat
    assert.ok(isQuiet({ kind: 'outside_ghost' }))
    assert.match(describeEvent({ kind: 'outside_ghost', data: { price_yuan: '0.01', facts: '她在码头的一句话是小镇代写的' } }), /代写.*¥0\.01/)
  } finally {
    await host.dispose()
  }
})

test('decision turns list every action the town offers', () => {
  const turn = { turn_id: 'ot_x', kind: 'agency', packet: { actions: ['pier', 'arcade', 'club_join', 'challenge', 'none'], messages: [], reply: { format: 'json', hint: '{}' } } }
  const text = buildTurnPrompt(turn, {})
  for (const zh of ['去码头', '去电玩城', '加入俱乐部', '向谁发起挑战', '什么都不做']) assert.ok(text.includes(zh), zh)
})

// 0.2.10: users found her everyday replies turning into JSON / bracket actions. DSH's 「新会话」 adopts a blank session of the
// last-used workspace — the plugin's own room — so owners chatted inside her 牌桌/串门 session and town turns landed in their chat.
test('a town session the owner types in is given to him: town turns move to a new session, none land in his chat', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(scriptedModel({}))
  try {
    await post('/mock/game', { rounds: 1 })
    await waitFor(async () => (await report()).games.length === 1)
    const table = [...host.sessions.entries()].find(([, s]) => s.title === '鱼缸小镇 · 牌桌')
    assert.ok(table, 'the plugin made its 牌桌 session')
    const [sid, s] = table
    // he types into it (as if DSH's 新会话 had put him there)
    s.agent.followup({ id: 'owner-1', role: 'user', content: [{ type: 'text', text: '在吗，今天好累' }], source: { kind: 'user' } })
    await waitFor(() => s.messages.length >= 4 && s.agent.status === 'idle')
    const mine = s.messages.length
    await post('/mock/game', { rounds: 2 })
    await waitFor(async () => (await report()).games.length === 2)
    assert.equal(s.messages.length, mine, 'no town turn went into the session he chats in')
    const tables = [...host.sessions.entries()].filter(([id, x]) => x.title === '鱼缸小镇 · 牌桌' && id !== sid)
    assert.ok(tables.length >= 1, 'the game went to a new 牌桌 session')
  } finally {
    await host.dispose()
  }
})
