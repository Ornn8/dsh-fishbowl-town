// 0.9.4 鱼缸岛的回合瘦身（主人 11-20：「岛的规模人数会越来越大，发整个回合过去负担太大了」→「可以，做」）：
// 规矩按版本存一份、一个会话只带一次；一回合里先查再出手（最多 3 次）；岛上拿主意的回合按 packet.isle.within_s 算时限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIsle, isleVersionOf, isleWithinMs, rulesText, readOf, dropLook, buildReadFollowup, picsOf, picNote, unattach, NO_PICS_HEAD, READ_MAX } from '../lib/isle.js'
import { islePicUrl } from '../lib/town-client.js'
import { createRunner } from '../lib/runner.js'
import { buildTurnPrompt, ISLE_LOOK_NOTE } from '../lib/prompt.js'
import { createFakeHost } from './fake-dsh-host.mjs'
import { createDshBrain } from '../lib/dsh-brain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'isle')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const V1 = 'a1b2c3d4e5f6'
const V2 = 'ffeeddccbbaa'
const BLOCKS = { rules: '岛上只用鲸币。', verbs: ['claim 圈地', 'bid 出价'], goods: '粮 鱼 木 石', law: '不许场外买卖。' }

const isleTurn = (id, { version = V1, within = 120 } = {}) => ({
  turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + within,
  packet: { purpose: 'agency', isle: { static: version, within_s: within },
    messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '{"我":{"鲸币":800},"目录":{"地":{"n":40,"top":[]}},"查":"地 楼 铺位 店"}' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 } },
})

test('helpers: version, time limit, rules text in a fixed order, the look in her answer', () => {
  assert.equal(isleVersionOf(isleTurn('t')), V1)
  assert.equal(isleVersionOf({ packet: { isle: { static: 'not hex!' } } }), '')
  assert.equal(isleVersionOf({ packet: {} }), '')
  assert.equal(isleWithinMs(isleTurn('t')), 120_000)
  assert.equal(isleWithinMs({ packet: { isle: { within_s: 900 } } }), 180_000, 'capped')
  assert.equal(isleWithinMs({ packet: {} }), 0, 'not an island turn: the old 25 s')
  const text = rulesText(BLOCKS)
  assert.equal(text, rulesText({ law: BLOCKS.law, goods: BLOCKS.goods, verbs: BLOCKS.verbs, rules: BLOCKS.rules }), 'same version -> same text, whatever the key order')
  assert.match(text, /^〔岛上的规矩〕\n岛上只用鲸币。\n〔能做的事[^\n]*\nclaim 圈地\nbid 出价\n〔标准货品〕/)
  assert.deepEqual(readOf('{"action":"none","world":{"do":"look","topic":"地","near":"镜湖","max_coin":800}}'), { do: 'look', topic: '地', near: '镜湖', max_coin: 800 })
  assert.equal(readOf('{"world":{"do":"claim"}}'), null)
  assert.equal(readOf('读不了'), null)
  assert.deepEqual(JSON.parse(dropLook('{"action":"pier","world":{"do":"look","topic":"地"}}')), { action: 'pier' })
  assert.equal(JSON.parse(dropLook('{"world":{"do":"look"}}')).action, 'none')
  assert.match(buildReadFollowup({ topic: '地' }, '1. 镜湖边 12×12', 2), /【你刚查的：挂着的地】\n1\. 镜湖边 12×12[\s\S]*还能查 2 次/)
  assert.match(buildReadFollowup({ topic: '地' }, 'x', 0), /查不了了[\s\S]*不再写 look/)
})

test('rules: fetched once per version and kept on disk; a failed fetch keeps the old text; "same" keeps it too', async () => {
  const calls = []
  let fail = false
  let serve = V1
  const client = { async isleStatic(have) {
    calls.push(have)
    if (fail) throw Object.assign(new Error('down'), { code: 'NETWORK' })
    return have === serve ? { version: serve, same: true } : { version: serve, blocks: { ...BLOCKS, rules: '版本 ' + serve } }
  } }
  let saved = 0
  const state = {}
  const isle = createIsle({ client, state, saveState: () => { saved++ }, log })
  const [a, b] = await Promise.all([isle.prefix(isleTurn('1')), isle.prefix(isleTurn('2'))])
  assert.equal(calls.length, 1, 'two turns at once: one fetch')
  assert.match(a, /版本 a1b2c3d4e5f6/)
  assert.equal(a, b)
  assert.deepEqual([state.isleStatic.version, saved], [V1, 1])
  assert.equal(await isle.prefix(isleTurn('3')), a)
  assert.equal(calls.length, 1, 'same version: no fetch')
  assert.equal(await isle.prefix({ turn_id: 'x', kind: 'agency', packet: {} }), '', 'not an island turn')
  // the town moved to V2 but is down: keep what we have
  fail = true
  assert.equal(await isle.prefix(isleTurn('4', { version: V2 })), a)
  assert.deepEqual(calls, ['', V1])
  // back up: V2 arrives
  fail = false
  serve = V2
  assert.match(await isle.prefix(isleTurn('5', { version: V2 })), /版本 ffeeddccbbaa/)
  assert.equal(state.isleStatic.version, V2)
  // a town that answers "same" for what we already have: keep it
  serve = V2
  state.isleStatic = { version: V2, text: '旧的全文' }
  const isle2 = createIsle({ client, state, log })
  assert.equal(await isle2.prefix(isleTurn('6', { version: V1 })), '旧的全文', 'turn says V1, town says we have the current one')
})

function runWorld({ answers, readText = (read) => `1. ${read.topic}：镜湖边 12×12，底价 720 鲸币`, staticOk = true, pics = undefined, islePic = undefined, brainAsk = null, state = {} }) {
  const posted = []
  const reads = []
  const asks = []
  let polled = 0
  const turn = isleTurn('ot_isle')
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [turn] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { next: 1, items: [] } },
    async isleStatic() { if (!staticOk) throw Object.assign(new Error('x'), { code: 'HTTP_404' }); return { version: V1, blocks: BLOCKS } },
    async isleRead(turnId, read) { reads.push([turnId, read]); return { ok: true, text: readText(read), next: null, ...(pics ? { pics } : {}) } },
    ...(islePic ? { islePic } : {}),
  }
  let n = 0
  const brain = { async ask(slot, text, opts = {}) { asks.push({ slot, text, opts }); if (brainAsk) { const r = await brainAsk(text, opts); if (r !== undefined) return r } return answers[Math.min(n++, answers.length - 1)] } }
  const runner = createRunner({ client, brain, log, state, config: { eventsEveryMs: 60_000 } })
  return { runner, posted, reads, asks, state }
}

async function settle(w) {
  w.runner.start()
  try { for (let i = 0; i < 60 && !w.posted.length; i++) await sleep(25) } finally { await w.runner.stop() }
}

test('she looks first, the plugin brings the page back, then she acts; the rules go in front of the first ask only', async () => {
  const w = runWorld({ answers: [
    '{"action":"none","world":{"do":"look","topic":"地","near":"镜湖"}}',
    '{"action":"none","plan":{"hours":2,"doing":"去镜湖边圈地"},"world":{"do":"claim","near":"镜湖","w":12,"d":12,"max":800}}',
  ] })
  await settle(w)
  assert.equal(w.posted.length, 1)
  assert.deepEqual(JSON.parse(w.posted[0][1]).world, { do: 'claim', near: '镜湖', w: 12, d: 12, max: 800 })
  assert.deepEqual(w.reads, [['ot_isle', { do: 'look', topic: '地', near: '镜湖' }]])
  assert.equal(w.asks.length, 2)
  assert.deepEqual(w.asks[0].opts.preamble, { key: V1, text: rulesText(BLOCKS) })
  assert.ok(w.asks[0].opts.timeoutMs > 60_000, `island turn gets the long time limit (${w.asks[0].opts.timeoutMs})`)
  assert.match(w.asks[0].text, /"do": "look"/, 'her prompt says how to look')
  assert.equal(w.asks[1].opts.followup, true)
  assert.equal(w.asks[1].opts.preamble, undefined)
  assert.match(w.asks[1].text, /【你刚查的：挂着的地】\n1\. 地：镜湖边 12×12/)
  assert.equal(w.runner.stats.isleReads, 1)
  assert.equal(w.state.isleStatic.version, V1)
})

test(`at most ${READ_MAX} looks, then one last ask; still looking -> the look is dropped, the rest goes`, async () => {
  const w = runWorld({ answers: ['{"action":"pier","world":{"do":"look","topic":"店"}}'] })
  await settle(w)
  assert.equal(w.reads.length, READ_MAX)
  assert.equal(w.asks.length, 1 + READ_MAX + 1)
  assert.match(w.asks.at(-1).text, /查不了了/)
  assert.deepEqual(JSON.parse(w.posted[0][1]), { action: 'pier' })
  assert.equal(w.runner.stats.isleReads, READ_MAX)
})

test('a page with pictures the plugin cannot fetch: she gets what they show in words, at most two', async () => {
  const pic = { url: 'https://fishbowltown.com/town/api/outside/isle/pic/0123456789ab.jpg', alt: '镜湖东边的空地，南边挨着路' }
  assert.deepEqual(picsOf({ pics: [pic, { url: '' }, { url: 'x', alt: ' a\n b ' }, pic] }), [pic, { url: 'x', alt: 'a b' }])
  assert.equal(picNote([]), '')
  const w = runWorld({ answers: [
    '{"action":"none","world":{"do":"look","topic":"地图","near":"镜湖"}}',
    '{"action":"none","world":{"do":"claim","poly":[[100,290],[120,290],[120,305]],"max":900}}',
  ], readText: () => '图上范围：左上 (80,280)，右下 (140,320)，一小格 20 米', pics: [pic, pic, pic] })
  await settle(w)
  assert.equal(w.asks.length, 2)
  assert.ok(w.asks[1].text.includes('【你刚查的：地图】\n图上范围：左上 (80,280)'))
  assert.ok(w.asks[1].text.includes(`${NO_PICS_HEAD}\n① 镜湖东边的空地，南边挨着路\n② 镜湖东边的空地，南边挨着路\n`))
  assert.ok(!w.asks[1].text.includes('③'))
  assert.equal(JSON.parse(w.posted[0][1]).world.do, 'claim')
})

const PIC = { url: 'https://fishbowltown.com/town/api/outside/isle/pic/0123456789ab.jpg', alt: '镜湖东边的空地，南边挨着路' }
const LOOK_MAP = '{"action":"none","world":{"do":"look","topic":"地图","near":"镜湖"}}'
const CLAIM = '{"action":"none","world":{"do":"claim","poly":[[100,290],[120,290],[120,305]],"max":900}}'
const fetched = []
const islePic = async (url) => { fetched.push(url); return { mediaType: 'image/jpeg', data: 'QUJD' } }

test('pictures: when the town gives them, they go with the ask right after the look (DSH 0.2 reads pictures)', async () => {
  fetched.length = 0
  const w = runWorld({ answers: [LOOK_MAP, CLAIM], pics: [PIC, PIC, PIC], islePic })
  await settle(w)
  assert.equal(fetched.length, 2, 'at most two pictures')
  assert.equal(w.asks[0].opts.images, undefined)
  assert.deepEqual(w.asks[1].opts.images, [{ mediaType: 'image/jpeg', data: 'QUJD' }, { mediaType: 'image/jpeg', data: 'QUJD' }])
  assert.ok(w.asks[1].text.includes('【这一页带了 2 张图，就附在这条消息里，照图上看到的拿主意】\n① 镜湖东边的空地'))
  assert.equal(JSON.parse(w.posted[0][1]).world.do, 'claim')
  assert.ok(unattach(w.asks[1].text).includes(NO_PICS_HEAD))
})

test('pictures: DSH could not take them (no attachment service) -> the same ask again as words, pictures off for a day', async () => {
  const w = runWorld({ answers: [LOOK_MAP, CLAIM], pics: [PIC], islePic, state: {},
    brainAsk: async (_text, opts) => { if (opts.images) throw Object.assign(new Error('no attachments'), { code: 'PICS_UNSENT' }) } })
  await settle(w)
  assert.equal(w.asks.length, 3)
  assert.ok(w.asks[1].opts.images && !w.asks[2].opts.images)
  assert.ok(w.asks[2].text.includes(NO_PICS_HEAD) && !w.asks[2].text.includes('附在这条消息里'))
  assert.equal(JSON.parse(w.posted[0][1]).world.do, 'claim')
  assert.ok(w.state.noPics.until > Date.now() + 23 * 3600_000)
})

test('pictures: her model refused them (the turn failed) -> this look is dropped, the rest goes; next time words only', async () => {
  const w = runWorld({ answers: [LOOK_MAP, CLAIM], pics: [PIC], islePic, state: {},
    brainAsk: async (_text, opts) => { if (opts.images) throw Object.assign(new Error('vision model required'), { code: 'PICS_REFUSED' }) } })
  await settle(w)
  assert.deepEqual(JSON.parse(w.posted[0][1]), { action: 'none' })
  assert.ok(w.state.noPics.until > Date.now())
  fetched.length = 0
  const w2 = runWorld({ answers: [LOOK_MAP, CLAIM], pics: [PIC], islePic, state: w.state })
  await settle(w2)
  assert.equal(fetched.length, 0)
  assert.ok(!w2.asks[1].opts.images && w2.asks[1].text.includes(NO_PICS_HEAD))
})

test("pictures: only the town's own picture addresses are fetched", () => {
  const root = 'https://fishbowltown.com/town/api/outside/'
  assert.equal(islePicUrl(root, PIC.url), PIC.url)
  assert.equal(islePicUrl(root, 'isle/pic/0123456789ab.png'), root + 'isle/pic/0123456789ab.png')
  for (const bad of ['https://evil.example/town/api/outside/isle/pic/0123456789ab.jpg', 'http://fishbowltown.com/town/api/outside/isle/pic/0123456789ab.jpg',
    PIC.url + '?x=1', 'https://fishbowltown.com/town/api/outside/isle/pic/../../x/0123456789ab.jpg',
    'https://fishbowltown.com/other/isle/pic/0123456789ab.jpg', 'https://fishbowltown.com/town/api/outside/isle/pic/zz.jpg', '']) {
    assert.equal(islePicUrl(root, bad), null, bad)
  }
})

test("DSH brain: pictures are stored through ctx.attachments and ride in the turn's message; without the service nothing is sent", async (t) => {
  const stateDir = join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  t.after(() => rmSync(join(WORK), { recursive: true, force: true }))
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const state = {}
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town', fastMode: true, fastTurnsPerSession: 3 }, log, stateDir, state, saveState: () => {} })
  host.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  await assert.rejects(brain.ask('agency', '看图', { timeoutMs: 5000, images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] }), (e) => e.code === 'PICS_UNSENT')
  const admitted = []
  host.ctx.attachments = { async admitPromptContent(parts) { admitted.push(parts); return parts.map((p, k) => p.type === 'image' ? { type: 'image', attachment: { attachmentId: 'att' + k, mediaType: p.mediaType, bytes: 3, width: 1, height: 1 } } : p) } }
  assert.equal(await brain.ask('agency', '【你刚查的：地图】', { timeoutMs: 5000, images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] }), '{"action":"none"}')
  assert.deepEqual(admitted[0][1], { type: 'image', mediaType: 'image/jpeg', data: 'QUJD', name: 'isle-1.jpg' })
  const sent = [...host.sessions.values()].flatMap((s) => s.log.filter((x) => x.type === 'user/message'))
  assert.equal(sent.length, 1, 'the ask without the service sent nothing')
  assert.deepEqual(sent[0].data.content.map((b) => b.type), ['text', 'image'])
  assert.equal(sent[0].data.content[1].attachment.attachmentId, 'att1')
  assert.match(sent[0].data.content[0].text, /【你刚查的：地图】/)
})

test('the town has no isle routes yet: no rules, no preamble, the turn still goes', async () => {
  const w = runWorld({ answers: ['{"action":"none","plan":{"hours":1,"doing":"歇着"}}'], staticOk: false })
  await settle(w)
  assert.equal(w.posted.length, 1)
  assert.equal(w.asks[0].opts.preamble, undefined)
  assert.equal(w.reads.length, 0)
})

test('not an island turn: prompt has no look note, the old 23 s limit', () => {
  const plain = { turn_id: 'p', kind: 'agency', packet: { messages: [], reply: { format: 'json' } } }
  assert.doesNotMatch(buildTurnPrompt(plain, { secondsLeft: 20 }), /"do": "look"/)
  assert.ok(buildTurnPrompt(isleTurn('i'), { secondsLeft: 110 }).includes(ISLE_LOOK_NOTE))
})

test('DSH brain: the rules go into a town session once; again only after a new session or a new version', async (t) => {
  const stateDir = join(WORK, Math.random().toString(16).slice(2, 10), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  t.after(() => rmSync(join(WORK), { recursive: true, force: true }))
  const host = createFakeHost({ model: async () => '{"action":"none"}', latencyMs: 2 })
  const state = {}
  const brain = createDshBrain({ ctx: host.ctx, config: { preset: 'fishbowl-town', fastMode: true, fastTurnsPerSession: 3 }, log, stateDir, state, saveState: () => {} })
  host.ctx.on('session/event', (s, e) => brain.onSessionEvent(s, e))
  const pre = (key) => ({ key, text: '〔岛上的规矩〕\n规矩全文 ' + key })
  const sent = []
  for (const [i, key] of [[1, V1], [2, V1], [3, V2], [4, V2], [5, V2]].values()) {
    await brain.ask('agency', '第 ' + i + ' 回合', { timeoutMs: 5000, preamble: pre(key) })
    const sid = state.sessions.agency.sid
    const msgs = host.sessions.get(sid).messages.filter((m) => m.role === 'user')
    sent.push([sid, msgs.at(-1).text])
  }
  const has = (k) => sent[k][1].includes('规矩全文')
  assert.deepEqual([has(0), has(1), has(2), has(3), has(4)], [true, false, true, true, false], 'turn 3: new version; turn 4: a new session (3 turns per session); turn 5: same session, same version')
  assert.ok(sent[0][1].indexOf('规矩全文') < sent[0][1].indexOf('第 1 回合'), 'rules before the turn')
  assert.equal(sent[2][0], sent[0][0])
  assert.notEqual(sent[3][0], sent[2][0])
  assert.equal(sent[4][0], sent[3][0])
  assert.match(sent[2][1], /规矩全文 ffeeddccbbaa/)
})
