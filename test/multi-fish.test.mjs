// 0.6.0: up to 3 outside fish in one DSH. Each fish answers with her own code (two mock towns here, one code each), her decision
// sessions are her own (in the plugin room, titles carry her name), her persona rides on her own turns, the chat tools and /town act on
// the fish bound to the session they are used in, and the page lists / adds / removes fish. Old single-code settings are fish 1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { fishEntries, nextFishId } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'multi-fish')
const towns = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function mockTown(i) {
  const port = 19000 + Math.floor(Math.random() * 800) + i
  const code = 'fbo_' + randomBytes(24).toString('base64url')
  writeFileSync(join(WORK, `code${i}.txt`), code)
  const proc = spawn('python', ['-I', join(ROOT, 'mock', 'mock_town.py'), '--port', String(port), '--code-file', join(WORK, `code${i}.txt`)], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('mock town on')) resolve() })
    proc.on('exit', (c) => reject(new Error('mock exited ' + c)))
  })
  const base = `http://127.0.0.1:${port}`
  return { proc, code, base, api: base + '/town/api/outside/',
    post: (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    report: () => fetch(base + '/mock/report').then((r) => r.json()) }
}

before(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  towns.push(await mockTown(1), await mockTown(2))
})
after(() => { for (const t of towns) t.proc.kill(); rmSync(WORK, { recursive: true, force: true }) })

async function waitFor(fn, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300) }
  throw new Error('timed out waiting')
}

test('settings: old single-code configs are fish 1; ids, max 3, the env code only for fish 1', () => {
  const env = { FISHBOWL_TOWN_CODE: 'fbo_env_code_123' }
  assert.deepEqual(fishEntries({ code: 'fbo_a', persona: 'p', reportSessionId: 's1' }, {}, {}), [{ id: '1', code: 'fbo_a', persona: 'p', chatSid: 's1', enabled: true }])
  assert.equal(fishEntries({}, {}, env)[0].code, 'fbo_env_code_123')
  const many = fishEntries({ fish: [{ id: '1', code: '' }, { id: '2', code: 'fbo_b' }, { id: '2', code: 'dup' }, { id: '3' }, { id: '4' }] }, { code: 'fbo_raw' }, env)
  assert.deepEqual(many.map((x) => [x.id, x.code]), [['1', 'fbo_raw'], ['2', 'fbo_b'], ['3', '']])
  assert.equal(nextFishId([{ id: '1' }, { id: '3' }]), '2')
})

test('0.6.5: a hand-written settings.json without ids keeps every fish (numbered in order, name ignored)', () => {
  const noIds = fishEntries({ fish: [{ name: '金鱼', code: 'fbo_a' }, { name: '小鲸', code: 'fbo_b' }] }, {}, {})
  assert.deepEqual(noIds.map((x) => [x.id, x.code]), [['1', 'fbo_a'], ['2', 'fbo_b']])
  const mixed = fishEntries({ fish: [{ code: 'fbo_x' }, { id: '1', code: 'fbo_a' }] }, {}, {})
  assert.deepEqual(mixed.map((x) => [x.id, x.code]), [['2', 'fbo_x'], ['1', 'fbo_a']]) // a written id keeps its number
  assert.equal(nextFishId(noIds), '3')
})

test('two fish in one DSH: own codes, own sessions, own persona, tools and /town follow the session; the page adds and removes fish', { timeout: 180_000 }, async () => {
  const [A, B] = towns
  await A.post('/mock/reset')
  await B.post('/mock/reset')
  process.env.DSH_HOME = join(WORK, 'home-' + Math.random().toString(16).slice(2, 8))
  delete process.env.FISHBOWL_TOWN_CODE
  const seen = []
  const host = createFakeHost({
    model: async ({ history, title, sessionId }) => {
      const last = history[history.length - 1].text
      seen.push({ title, sessionId, last })
      if (title.startsWith('聊天')) return '好呀'
      if (last.includes('该你自己拿主意')) return JSON.stringify({ action: 'none', next_wake: 30 })
      if (last.includes('"play"')) return '{"play":"布","say":"包住你！"}'
      return '{}'
    },
  })
  const chatA = await host.ownerChat('聊天 · 小圆子')
  const chatB = await host.ownerChat('聊天 · 小橘')
  const elsewhere = await host.ownerChat('写代码')
  mkdirSync(join(process.env.DSH_HOME, 'fishbowl-town'), { recursive: true })
  writeFileSync(join(process.env.DSH_HOME, 'fishbowl-town', 'settings.json'), JSON.stringify({
    fish: [{ id: '1', code: A.code, base: A.api, chatSid: chatA.sid, persona: '' }, { id: '2', code: B.code, base: B.api, chatSid: chatB.sid, persona: '我是小橘，一条橘色的金鱼，说话带点东北口音。' }],
  }))
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { eventsEverySeconds: 15 })
  try {
    await A.post('/mock/game', { rounds: 1 })
    await B.post('/mock/game', { rounds: 1 })
    await waitFor(async () => (await A.report()).games.length === 1 && (await B.report()).games.length === 1, 90_000)
    // each town got answers only from its own fish (own code); the decision sessions are separate and in the room
    const tables = [...host.sessions.entries()].filter(([, s]) => s.title.startsWith('鱼缸小镇 · 牌桌'))
    assert.ok(tables.length >= 2, 'one 牌桌 per fish')
    assert.ok(tables.every(([, s]) => /fishbowl-town[\\/]room$/.test(s.cwd)), 'all in the plugin room')
    const titles = tables.map(([, s]) => s.title)
    assert.ok(titles.every((t) => / · .+$/.test(t.replace('鱼缸小镇 · 牌桌', ''))), 'titles carry her name: ' + titles.join(' / '))
    const bPrompts = seen.filter((x) => x.last.includes('"play"') && x.last.includes('【你是谁】我是小橘'))
    const aPrompts = seen.filter((x) => x.last.includes('"play"') && !x.last.includes('【你是谁】'))
    assert.ok(bPrompts.length >= 1 && aPrompts.length >= 1, 'her own persona rides on her own turns only')
    assert.ok(new Set(bPrompts.map((x) => x.sessionId)).size >= 1 && !bPrompts.some((x) => aPrompts.some((y) => y.sessionId === x.sessionId)), 'no shared session')
    for (const c of [chatA, chatB, elsewhere]) assert.ok(!host.sessions.get(c.sid).messages.length, 'no town message in an owner chat')
    // /town follows the session it is typed in; /town @name; an unbound session is told how to bind
    const stA = await host.runCommand('town', 'status', { sessionId: chatA.sid })
    const stB = await host.runCommand('town', 'status', { sessionId: chatB.sid })
    assert.equal(stA.kind, 'success')
    assert.equal(stB.kind, 'success')
    const lone = await host.runCommand('town', 'status', { sessionId: elsewhere.sid })
    assert.equal(lone.kind, 'error')
    assert.match(lone.text, /绑定到当前会话/)
    const list = await host.runCommand('town', 'fish', { sessionId: chatA.sid })
    assert.match(list.text, /绑定在这个会话/)
    // a chat tool used in her chat acts for her; in an unbound chat it says how to bind
    const toolName = [...host.tools.keys()].find((n) => /look|lobby|看看/.test(n)) || [...host.tools.keys()][0]
    const out = await host.callTool(toolName, {}, { sessionId: elsewhere.sid })
    assert.match(out, /还没绑定小镇里的哪条鱼/)
    // the page: two fish listed; ?fish=2 reads fish 2; add a third, a fourth is refused; remove the third
    const s1 = (await host.http('/fishbowl-town/state')).json
    assert.equal(s1.fish.length, 2)
    assert.equal(s1.fishId, '1')
    assert.equal(s1.reportSessionId, chatA.sid)
    const s2 = (await host.http('/fishbowl-town/state?fish=2')).json
    assert.equal(s2.fishId, '2')
    assert.equal(s2.reportSessionId, chatB.sid)
    assert.match(s2.persona, /小橘/)
    const added = (await host.http('/fishbowl-town/save', { method: 'POST', body: { addFish: true } })).json
    assert.equal(added.added, '3')
    const refused = await host.http('/fishbowl-town/save', { method: 'POST', body: { addFish: true } })
    assert.equal(refused.status, 400)
    // binding fish 3 to chat A takes chat A away from fish 1 (one fish per chat)
    host.sessions.get(chatA.sid).agent.followup({ id: 'o1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } })
    await waitFor(() => host.sessions.get(chatA.sid).messages.length >= 2)
    const bound = (await host.http('/fishbowl-town/save?fish=3', { method: 'POST', body: { bindLatest: true } })).json
    assert.equal(bound.reportSessionId, chatA.sid)
    const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'fishbowl-town', 'settings.json'), 'utf8'))
    assert.equal(saved.fish.find((x) => x.id === '1').chatSid, '')
    const removed = (await host.http('/fishbowl-town/save', { method: 'POST', body: { removeFish: '3' } })).json
    assert.equal(removed.fish.length, 2)
    // the same code cannot be given to two fish
    const dup = await host.http('/fishbowl-town/save?fish=2', { method: 'POST', body: { code: A.code } })
    assert.equal(dup.status, 400)
  } finally {
    await host.dispose()
  }
})

test('one fish (the old way): nothing changes — no name in titles, no persona prefix, /town works in any chat', { timeout: 120_000 }, async () => {
  const [A] = towns
  await A.post('/mock/reset')
  process.env.DSH_HOME = join(WORK, 'home-' + Math.random().toString(16).slice(2, 8))
  const seen = []
  const host = createFakeHost({ model: async ({ history, title }) => { const last = history[history.length - 1].text; seen.push({ title, last }); return last.includes('"play"') ? '{"play":"布"}' : JSON.stringify({ action: 'none', next_wake: 30 }) } })
  const chat = await host.ownerChat('随便聊聊')
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: A.code, base: A.api, persona: '我是小圆子', eventsEverySeconds: 15 })
  try {
    await A.post('/mock/game', { rounds: 1 })
    await waitFor(async () => (await A.report()).games.length === 1, 60_000)
    assert.ok([...host.sessions.values()].some((s) => s.title === '鱼缸小镇 · 牌桌'))
    assert.ok(!seen.some((x) => x.last.includes('【你是谁】')))
    const st = await host.runCommand('town', 'status', { sessionId: chat.sid })
    assert.equal(st.kind, 'success')
    const s = (await host.http('/fishbowl-town/state')).json
    assert.equal(s.fish.length, 1)
  } finally {
    await host.dispose()
  }
})
