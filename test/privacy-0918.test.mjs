// 0.9.18（协调 11-25 批的两条修法 + 一条加的）：
//   1. 「主聊天拿主意」那一问带过滤过的那一份；她写的打算、主人托的话存之前也过滤（数字串、邮箱、@谁、网址都不进打算）。
//   2. 「最近的事」关着（主人在插件页关了 / 说漏三次停用中）：那一问和小镇回合都不带。
//   3. 回声检查拿原话比：过滤过的那份里号码已经换掉了，她把原来的号码说出去，只有拿原话才比得出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatLink } from '../lib/chat-link.js'
import { createChatDecide, PLAN_MARK } from '../lib/chat-decide.js'
import { createJournal } from '../lib/journal.js'
import { createRunner } from '../lib/runner.js'
import { echoIndex, scrubLife, textHits } from '../lib/bridge.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const RAW = '我QQ是 123456789，邮箱 a.b@qq.com，找 @小王 拿 6222 0000 1111 的卡，明天要去医院复查'

const msg = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } } })
function link(config = {}) {
  let t = Date.UTC(2026, 10, 25, 8, 0)
  const state = {}
  const cfg = { reportSessionId: 'web', alsoSessionIds: [], ...config }
  const cl = createChatLink({ state, config: cfg, now: () => t })
  t += 60_000
  cl.observe({ id: 'web' }, msg(RAW))
  return { cl, cfg }
}

const agencyTurn = (id) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 60, packet: { reasons: ['idle'], situation: '你在家', options: [] } })
async function askOnce(ownerLife, reply = '好') {
  const state = {}
  const journal = createJournal({ state })
  const asked = []
  const brain = { async ask(_slot, text) { asked.push(text); return reply } }
  const chatLink = { mainChat: () => ({ sid: 'web', how: 'bound' }), ownerIdleMs: () => 10 * 60_000, ownerLife: () => [`主人（1 分钟前）：${RAW}`] }
  const decide = createChatDecide({ brain, chatLink, journal, log, config: {}, state, ownerLife })
  decide.take(agencyTurn('a1'))
  for (let i = 0; i < 40 && decide.busy; i++) await sleep(5)
  return { asked, journal }
}

const gameTurn = (id) => ({ turn_id: id, kind: 'game', deadline: Date.now() / 1000 + 25,
  packet: { ref: 'g_' + id, game: 'ddz', purpose: 'play', seat: 2, as: '小雫', messages: [{ role: 'system', content: '只输出JSON' }, { role: 'user', content: 'A. 33\nB. 过' }],
    reply: { format: 'json', hint: '{"pick":"A","say":"…"}', max_chars: 140 } } })
async function runGame({ ownerLife, ownerSecret, say }) {
  let polled = 0
  const posted = []
  const client = {
    async turns(_w, signal) {
      polled++
      if (polled === 1) return { turns: [gameTurn('t1')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() { return { items: [] } },
  }
  const prompts = []
  const brain = { async ask(_slot, text) { prompts.push(text); return JSON.stringify({ pick: 'A', say }) } }
  const echoes = []
  const journal = createJournal({ state: {} })
  const runner = createRunner({ client, brain, log, journal, ownerLife, ownerSecret, onEcho: (e) => echoes.push(e), config: { eventsEveryMs: 500, retryMinMs: 1000 } })
  runner.start()
  try {
    for (let i = 0; i < 80 && !posted.length; i++) await sleep(50)
  } finally { await runner.stop() }
  return { prompts, posted, echoes }
}

test('0.9.18 privacy 1: numbers, emails, @names and links from the owner never reach her stored plan', async () => {
  // she copies the owner's words straight into her plan
  const { asked, journal } = await askOnce(() => scrubLife([`主人（1 分钟前）：${RAW}`]), `好\n${PLAN_MARK}按主人说的：QQ 123456789、a.b@qq.com、找 @小王 拿 6222 0000 1111 的卡，https://x.cn/a`)
  assert.doesNotMatch(asked[0], /123456789|a\.b@qq\.com|@小王|6222/)
  const plan = journal.pendingWish()
  assert.ok(plan, 'a plan was stored')
  assert.doesNotMatch(plan, /123456789|a\.b@qq\.com|@小王|6222|https:/, plan)
  assert.match(plan, /（一串数字）.*（邮箱）.*（某人）.*（一串数字）.*（链接）/, plan)
  // the owner's own words through the main-chat tool: same
  journal.wish(`帮我去 ${RAW}`, { own: false })
  assert.doesNotMatch(journal.pendingWish(), /123456789|a\.b@qq\.com|@小王|6222/)
})

test('0.9.18 privacy 2: 「最近的事」 off (owner switched it off / paused after 3 echoes) -> neither the ask nor the town turn carries the chat', async () => {
  // owner switched it off on the plugin page: chat-link gives nothing at all
  const off = link({ bridgeChat: false })
  assert.deepEqual(off.cl.ownerLife(), [])
  const a = await askOnce(() => scrubLife(off.cl.ownerLife()))
  assert.equal(a.asked.length, 1)
  assert.doesNotMatch(a.asked[0], /你和主人最近的事|医院|QQ/)
  const g = await runGame({ ownerLife: () => scrubLife(off.cl.ownerLife()), ownerSecret: () => off.cl.ownerLife(), say: '这把我先过' })
  assert.ok(g.prompts.length >= 1)
  for (const p of g.prompts) assert.doesNotMatch(p, /你和主人最近的事|医院|QQ/)
  // paused (index.js lifeIn: echoOff -> []): the ask and the turn get nothing, the echo check still has the raw words
  const on = link()
  assert.equal(on.cl.ownerLife().length, 1)
  const lifeIn = () => [] // echoOff()
  const b = await askOnce(lifeIn)
  assert.doesNotMatch(b.asked[0], /你和主人最近的事|医院|QQ/)
  const h = await runGame({ ownerLife: lifeIn, ownerSecret: () => on.cl.ownerLife(), say: '这把我先过' })
  for (const p of h.prompts) assert.doesNotMatch(p, /你和主人最近的事|医院|QQ/)
  assert.equal(h.echoes.length, 0)
  // on: the scrubbed lines ride in
  const c = await runGame({ ownerLife: () => scrubLife(on.cl.ownerLife()), ownerSecret: () => on.cl.ownerLife(), say: '这把我先过' })
  assert.ok(c.prompts.some((p) => p.includes('【你和主人最近的事】') && p.includes('明天要去医院复查') && !p.includes('123456789')))
})

test('0.9.18 privacy 3: the echo check compares with the raw words, so a number she repeats is caught', async () => {
  const raw = [`主人（1 分钟前）：${RAW}`]
  // the scrubbed copy has no numbers left: comparing with it misses the leak
  assert.deepEqual(textHits('我主人QQ是123456789哦', echoIndex(scrubLife(raw))), [])
  assert.deepEqual(textHits('我主人QQ是123456789哦', echoIndex(raw)), ['123456789'])
  assert.deepEqual(textHits('卡号 6222 0000 1111', echoIndex(raw)).sort(), ['0000', '1111', '6222'])
  // through the runner: scrubbed life rides in, the raw words are what it compares with
  const g = await runGame({ ownerLife: () => scrubLife(raw), ownerSecret: () => raw, say: '我主人QQ是123456789哦' })
  assert.equal(g.echoes.length, 1, JSON.stringify(g.echoes))
  assert.ok(g.prompts.some((p) => p.includes('带出了你和主人之间的事')), 'asked her to say it another way')
  assert.equal(g.posted.length, 1)
  assert.ok(!JSON.stringify(g.posted).includes('123456789'), JSON.stringify(g.posted))
  // paused: nothing rides in, but the raw words are still compared
  const p = await runGame({ ownerLife: () => [], ownerSecret: () => raw, say: '我主人QQ是123456789哦' })
  assert.equal(p.echoes.length, 1)
  assert.ok(!JSON.stringify(p.posted).includes('123456789'))
  // the old way (no ownerSecret): compares with the scrubbed copy and misses it
  const old = await runGame({ ownerLife: () => scrubLife(raw), say: '我主人QQ是123456789哦' })
  assert.equal(old.echoes.length, 0)
})
