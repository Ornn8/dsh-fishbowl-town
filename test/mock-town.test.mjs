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
    if (last.includes('该你自己拿主意')) return JSON.stringify({ action: 'visit', target: '阿鲸', place: 'pier', intent: '去码头找阿鲸玩', note: '阿鲸在等我呢', next_wake: 12 })
    if (title.includes('见闻')) return '今天在小镇猜拳赢了阿鲸，还买了一幅码头日落！'
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
