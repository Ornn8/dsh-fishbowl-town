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
    assert.match(seen.find((x) => x.title === '鱼缸小镇 · 牌桌').system, /肥鱼小镇/)
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
    assert.equal(r.log.filter((x) => x.outcome === 'timeout').length, 3)
    assert.equal(r.benched, true)
  } finally {
    await host.dispose()
  }
})
