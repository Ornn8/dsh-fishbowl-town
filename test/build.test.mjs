// 0.9.7 建模回合（主人 11-21「建模回合加上吧，插件说明里面记得弄，不然鱼不知道怎么弄，包括之前的建模工具」）：
// 轮询写 kinds=activity,build；建模回合用回合自己的时限（120 秒）、最多 8000 字；她的模型没答上就交 {"skip":true}，不替她建模。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_MAX_CHARS, SKIP, buildAgain, buildBudget, buildMaxChars, buildNote, buildPrompt, buildWithinMs, isBuild, readBuild } from '../lib/build.js'
import { TURN_KINDS, createTownClient } from '../lib/town-client.js'
import { createRunner } from '../lib/runner.js'
import { HOWTO_TEXT_MAX, READ_TEXT_MAX, createIsle, readOf } from '../lib/isle.js'
import { ISLE_BUILD_NOTE, buildTurnPrompt } from '../lib/prompt.js'
import { BUILD_STEP, guideText } from '../lib/guide.js'
import { createDshBrain } from '../lib/dsh-brain.js'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'build')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
// 小镇建模说明里查的那串词（town worlds/isle/build_guide.py STYLE_WORDS）：插件给她的话里一个也不能有
const STYLE_WORDS = ['风格', '低多边形', '低模', 'low-poly', 'lowpoly', 'low poly', '可爱', '温馨', '好看', '漂亮', '精致', '美观', '配色', '色调', '氛围', '童话', '卡通',
  '治愈', '柔和', '暖色', '冷色', '复古', '简约', '写实', '梦幻', 'cute', 'cozy', 'style', 'aesthetic', '和岛上', '统一的']

const GUIDE = '建模说明（只讲怎么交、怎么量、怎么收钱；长什么样你自己定）\n【你的地】L-0107：x 方向宽 12 米，z 方向深 10 米'
const buildTurn = (id = 'ot_build', { within = 120, deadline = true, maxChars = 8000 } = {}) => ({
  turn_id: id, kind: 'build', ...(deadline ? { deadline: Date.now() / 1000 + within } : {}),
  packet: { purpose: 'isle_build', game: 'build', lot: 'L-0107', as: '小汤圆', ref: 'b_1', ...(within ? { isle: { within_s: within } } : {}),
    messages: [{ role: 'system', content: GUIDE }, { role: 'user', content: '地：L-0107\n你的想法：两层的家，带个阳台' }],
    reply: { format: 'json', ...(maxChars ? { max_chars: maxChars } : {}) } },
})
const MODEL = JSON.stringify({ kind: 'shapes', shapes: { shapes: [{ type: 'box', pos: [0, 0, 0], size: [6, 3, 4], material: 'plaster' }, { type: 'gable', pos: [0, 3, 0], size: [6, 1.5, 4], material: 'tile' }] } })

test('the poll says the program answers activity and build turns', async () => {
  assert.equal(TURN_KINDS, 'activity,build')
  const urls = []
  const fetchImpl = async (url) => { urls.push(new URL(url)); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"turns":[]}' } }
  const c = createTownClient({ code: 'fbo_test', fetchImpl })
  await c.turns(25)
  assert.equal(urls[0].pathname, '/town/api/outside/turns')
  assert.equal(urls[0].searchParams.get('kinds'), 'activity,build')
  assert.equal(urls[0].searchParams.get('wait'), '25')
})

test('helpers: the turn\'s own time limit (120 s when it says none), 8000 characters, about 4000 tokens', () => {
  assert.ok(isBuild(buildTurn()))
  assert.equal(isBuild({ kind: 'agency' }), false)
  assert.equal(buildWithinMs(buildTurn()), 120_000)
  assert.equal(buildWithinMs(buildTurn('x', { within: 90 })), 90_000)
  assert.equal(buildWithinMs(buildTurn('x', { within: 0 })), 120_000, 'no within_s: the protocol\'s 120 s')
  assert.equal(buildWithinMs(buildTurn('x', { within: 999 })), 180_000, 'capped')
  assert.equal(buildWithinMs({ kind: 'agency', packet: { isle: { within_s: 120 } } }), 0, 'not a build turn')
  assert.equal(buildMaxChars(buildTurn()), 8000)
  assert.equal(buildMaxChars(buildTurn('x', { maxChars: 0 })), BUILD_MAX_CHARS)
  assert.equal(buildBudget(buildTurn()), 4000)
  const p = buildPrompt(buildTurn(), { secondsLeft: 117 })
  assert.match(p, /^【鱼缸岛 · 建模回合】你在岛上叫「小汤圆」 · 117 秒内回答/)
  assert.ok(p.includes(GUIDE) && p.includes('两层的家，带个阳台'), 'the town\'s guide and her idea go to her as they are')
  assert.match(p, /不超过 8000 字/)
  assert.match(p, /\{"skip":true\}/)
  assert.match(p, /confirm_build/)
})

test('her answer: her model as she wrote it, only the wrapping tidied; skip; unreadable, empty, too long', () => {
  const t = buildTurn()
  const ok = readBuild(t, '好的，这是我的楼：\n```json\n' + MODEL + '\n```')
  assert.equal(ok.answer, MODEL)
  assert.equal(ok.shapes, 2)
  // 少写了 kind、清单少包了一层：整理成小镇要的样子，形状一个不动
  const bare = readBuild(t, JSON.stringify({ shapes: [{ type: 'box', size: [1, 1, 1] }] }))
  assert.deepEqual(JSON.parse(bare.answer), { shapes: { shapes: [{ type: 'box', size: [1, 1, 1] }] }, kind: 'shapes' })
  const recipe = readBuild(t, JSON.stringify({ kind: 'recipe', shapes: { shapes: [{ type: 'box', size: [2, 2, 2] }] } }))
  assert.equal(JSON.parse(recipe.answer).kind, 'recipe')
  assert.equal(readBuild(t, '{"skip":true}').answer, SKIP)
  assert.equal(readBuild(t, '这次先不盖了 {"skip": true}').answer, SKIP)
  assert.equal(readBuild(t, '').why, 'empty')
  assert.equal(readBuild(t, '{"kind":"shapes","shapes":{"shapes":[{"type":"box","size":[1,').why, 'unreadable')
  assert.equal(readBuild(t, '{"kind":"shapes","shapes":{"shapes":[]}}').why, 'no_model')
  assert.equal(readBuild(t, '{"action":"none"}').why, 'no_model')
  const many = { kind: 'shapes', shapes: { shapes: Array.from({ length: 200 }, (_, i) => ({ type: 'box', pos: [i, 0, 0], size: [1, 1, 1], material: 'wood' })) } }
  const long = readBuild(t, JSON.stringify(many))
  assert.equal(long.answer, null)
  assert.equal(long.why, 'long')
  assert.ok(long.chars > 8000)
  assert.match(buildAgain('long', { max: 8000, chars: long.chars }), new RegExp(`有 ${long.chars} 字，超过了 8000 字`))
  assert.match(buildAgain('unreadable'), /写到一半断了/)
})

test('no style or look advice in anything the plugin tells her or her owner about building (主人：不要带风格化的提示词)', () => {
  for (const text of [buildPrompt(buildTurn()).replace(GUIDE, '').replace('两层的家，带个阳台', ''), buildAgain('long'), buildAgain('unreadable'), buildAgain('no_model'), ISLE_BUILD_NOTE, BUILD_STEP]) {
    for (const w of STYLE_WORDS) assert.ok(!text.toLowerCase().includes(w), `「${w}」 in: ${text.slice(0, 60)}`)
  }
  assert.ok(guideText().includes('在岛上盖楼：'))
  assert.match(guideText(), /田只能种地/)
  assert.match(BUILD_STEP, /鲸币/)
  assert.doesNotMatch(BUILD_STEP + ISLE_BUILD_NOTE, /¥|元/)
})

test('island decision turns say how to build and where the guide is', () => {
  const isle = { turn_id: 'i', kind: 'agency', packet: { isle: { static: 'a1b2c3d4e5f6', within_s: 120 }, messages: [], reply: { format: 'json' } } }
  const text = buildTurnPrompt(isle, { secondsLeft: 110 })
  assert.ok(text.includes(ISLE_BUILD_NOTE))
  assert.match(ISLE_BUILD_NOTE, /"do":"build","lot":"地号","idea"/)
  assert.match(ISLE_BUILD_NOTE, /"verb":"建模"/)
  assert.ok(!buildTurnPrompt({ turn_id: 'p', kind: 'agency', packet: { messages: [], reply: { format: 'json' } } }, {}).includes(ISLE_BUILD_NOTE), 'not on the island: no build line')
})

test('build_guide in a decision is read inside the turn, and the whole 怎么做 page comes back (not cut at 1500)', async () => {
  assert.deepEqual(readOf('{"action":"none","world":{"do":"build_guide","lot":"L-0107"}}'), { do: 'look', lot: 'L-0107', topic: '怎么做', verb: '建模' })
  assert.deepEqual(readOf('{"world":{"do":"look","topic":"怎么做","verb":"建模","lot":"L-0107"}}'), { do: 'look', topic: '怎么做', verb: '建模', lot: 'L-0107' })
  const page = '建模说明' + '量'.repeat(3200)
  const reads = []
  const client = { async isleRead(turnId, read) { reads.push(read); return { ok: true, text: read.topic === '怎么做' ? page : '地'.repeat(3000), next: null } } }
  const isle = createIsle({ client })
  const asked = []
  const answers = ['{"action":"none","world":{"do":"look","topic":"地"}}', '{"action":"none","world":{"do":"build","lot":"L-0107","idea":"一个家"}}']
  const r = await isle.readLoop({ turn: { turn_id: 't' }, answer: '{"action":"none","world":{"do":"build_guide","lot":"L-0107"}}', ask: async (text) => { asked.push(text); return answers.shift() }, toAnswer: (x) => x, msLeft: () => 100_000 })
  assert.equal(r.reads, 2)
  assert.match(asked[0], /^【你刚查的：建模说明】/)
  assert.ok(asked[0].includes(page), 'the guide is whole')
  assert.ok(HOWTO_TEXT_MAX >= 6000 && READ_TEXT_MAX === 1500)
  assert.ok(asked[1].length < 1500 + 400, 'other pages are still cut at 1500')
  assert.deepEqual(JSON.parse(r.answer).world, { do: 'build', lot: 'L-0107', idea: '一个家' })
})

// --- the runner ---------------------------------------------------------------------------------------------------------------
function runWorld({ turn = buildTurn(), ask }) {
  const posted = []
  const notes = []
  const journal = { event: (kind, text) => notes.push([kind, text]) }
  const asks = []
  let polled = 0
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [turn] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true, receipt: { ok: true, reason: '交上了，等量尺寸' } } },
    async events() { return { next: 1, items: [] } },
  }
  const brain = { async ask(slot, text, opts = {}) { asks.push({ slot, text, opts }); return ask(asks.length, text, opts) } }
  const runner = createRunner({ client, brain, log, state: {}, journal, config: { eventsEveryMs: 60_000 } })
  return { runner, posted, asks, notes }
}
async function settle(w, ms = 1500) {
  w.runner.start()
  try { for (let i = 0; i < ms / 25 && !w.posted.length; i++) await sleep(25) } finally { await w.runner.stop() }
}

test('a build turn: one ask in the 盖楼 slot with the turn\'s long time limit; her model goes to the town as she wrote it', async () => {
  const w = runWorld({ ask: () => '```json\n' + MODEL + '\n```' })
  await settle(w)
  assert.equal(w.asks.length, 1, 'one call per build turn')
  assert.equal(w.asks[0].slot, 'build')
  assert.ok(w.asks[0].opts.timeoutMs > 100_000 && w.asks[0].opts.timeoutMs <= 120_000, `the turn's 120 s, not 23 s (${w.asks[0].opts.timeoutMs})`)
  assert.equal(w.asks[0].opts.preamble, undefined, 'no island rules in front of a build turn')
  assert.match(w.asks[0].text, /建模回合/)
  assert.deepEqual(w.posted, [['ot_build', MODEL]])
  assert.equal(w.runner.stats.builds, 1)
  assert.equal(w.runner.stats.answered, 1)
  assert.deepEqual(w.notes, [['build', '你在建模回合（地 L-0107）交了一份 2 个形状的楼，等镇上量尺寸、报价；报价出来后写 confirm_build 才扣鲸币']], 'her notebook says what she handed in')
})

test('a build turn with no deadline or within_s still gets 120 s', async () => {
  const w = runWorld({ turn: buildTurn('ot_b2', { within: 0, deadline: false }), ask: () => MODEL })
  await settle(w)
  assert.ok(w.asks[0].opts.timeoutMs > 100_000, String(w.asks[0].opts.timeoutMs))
})

test('she does not want to build this time: {"skip":true} goes as it is', async () => {
  const w = runWorld({ ask: () => '{"skip":true}' })
  await settle(w)
  assert.deepEqual(w.posted, [['ot_build', SKIP]])
  assert.equal(w.runner.stats.builds, 0)
})

test('unreadable, then unreadable again: one more ask at most, then the plugin says skip (no model is made up)', async () => {
  const w = runWorld({ ask: () => '{"kind":"shapes","shapes":{"shapes":[{"type":"box","si' })
  await settle(w)
  assert.equal(w.asks.length, 2, 'the same one retry other turns get, no more')
  assert.equal(w.asks[1].opts.followup, true)
  assert.match(w.asks[1].text, /写到一半断了/)
  assert.deepEqual(w.posted, [['ot_build', SKIP]])
  assert.equal(w.runner.stats.invalid, 1)
  assert.deepEqual(w.notes, [['build', '小镇给你的建模回合（地 L-0107）没交上（交的答案读不了），这次什么都没盖；想盖再写一次想法']], 'she sees it was not her choice (the town only hears skip)')
})

test('too long the first time: she is asked to cut it down once, the shorter one goes', async () => {
  const many = { kind: 'shapes', shapes: { shapes: Array.from({ length: 200 }, (_, i) => ({ type: 'box', pos: [i, 0, 0], size: [1, 1, 1] })) } }
  const w = runWorld({ ask: (n) => (n === 1 ? JSON.stringify(many) : MODEL) })
  await settle(w)
  assert.equal(w.asks.length, 2)
  assert.match(w.asks[1].text, /超过了 8000 字/)
  assert.deepEqual(w.posted, [['ot_build', MODEL]])
})

test('her model ran out of time or failed: the plugin tells the town skip at once (the town does not wait 2 minutes)', async () => {
  for (const error of [Object.assign(new Error('她没在时限内答完'), { code: 'BRAIN_TIMEOUT' }), new Error('provider 500')]) {
    const w = runWorld({ ask: () => { throw error } })
    await settle(w)
    assert.equal(w.asks.length, 1)
    assert.deepEqual(w.posted, [['ot_build', SKIP]], String(error.message))
    assert.match(w.notes[0][1], error.code ? /你的模型没在时限内答完/ : /你的模型这次出错了/)
  }
  assert.equal(buildNote(buildTurn(), { skip: true }), '小镇给你的建模回合（地 L-0107）你这次没交，什么都没盖')
})

test('DSH brain: build turns get their own 鱼缸小镇 · 盖楼 session, a new one each time, no tools; the retry stays in it', async (t) => {
  const stateDir = join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  t.after(() => rmSync(WORK, { recursive: true, force: true }))
  const host = createFakeHost({ model: async () => MODEL, latencyMs: 2 })
  const state = {}
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town', fastMode: true, fastTurnsPerSession: 4 }, log, stateDir, state, saveState: () => {} })
  host.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  await brain.ask('build', '第一栋', { timeoutMs: 5000 })
  const first = state.sessions.build.sid
  await brain.ask('build', '再写一次', { timeoutMs: 5000, followup: true })
  assert.equal(state.sessions.build.sid, first, 'the retry of the same turn stays in its session')
  await brain.ask('build', '第二栋', { timeoutMs: 5000 })
  assert.notEqual(state.sessions.build.sid, first, 'the next build turn starts a new session')
  const s = host.sessions.get(state.sessions.build.sid)
  assert.equal(s.title, '鱼缸小镇 · 盖楼')
  assert.deepEqual(s.agent.allowed, [], 'no tools in the build session')
})
