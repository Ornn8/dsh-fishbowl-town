// 0.9.19 程序放宽到 16k（小镇 fix/1126-code-16k）：查了写程序那一页的回合，递回那一页时说整段 24000 字、程序 16000 字；
// 平常回合的「不超过 N 字」不动；交之前插件量一下，超了把小镇会说的那句给她、请她删短再交。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_ANSWER_MAX, buildReadFollowup, buildTooLongFollowup, codeLimitOf, codeTooLong, isCodeRead } from '../lib/isle.js'
import { createRunner } from '../lib/runner.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const V1 = 'a1b2c3d4e5f6'
const BLOCKS = { rules: '岛上只用鲸币。', verbs: ['open 开店'], goods: '粮 鱼', law: '不许场外买卖。' }

const turnOf = ({ code = 16000, kind = 'agency' } = {}) => ({
  turn_id: 'ot_code', kind, deadline: Date.now() / 1000 + 120,
  packet: { purpose: 'agency', isle: { static: V1, within_s: 120 },
    messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '{"我":{"鲸币":800}}' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400, ...(code ? { code_max_chars: code } : {}) } },
})

// 一段 n 字、带换行的程序
const program = (n) => {
  const line = 'api.say("讲到这里");\n'
  let s = ''
  while ([...s].length < n) s += line
  return [...s].slice(0, n).join('')
}
const openWith = (code) => JSON.stringify({ action: 'none', world: { do: 'open', lot: 'L-12', mode: 'own', code } })

function runWorld({ answers, turn = turnOf() }) {
  const posted = []
  const reads = []
  const asks = []
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
    async isleStatic() { return { version: V1, blocks: BLOCKS } },
    async isleRead(turnId, read) { reads.push([turnId, read]); return { ok: true, text: read.topic === '怎么做' ? '写程序的接口：export function visit(api, guest) {…}' : `1. ${read.topic}`, next: null } },
  }
  let n = 0
  const brain = { async ask(slot, text, opts = {}) { asks.push({ slot, text, opts }); return answers[Math.min(n++, answers.length - 1)] } }
  const runner = createRunner({ client, brain, log, state: {}, config: { eventsEveryMs: 60_000 } })
  return { runner, posted, reads, asks }
}

async function settle(w) {
  w.runner.start()
  try { for (let i = 0; i < 80 && !w.posted.length; i++) await sleep(25) } finally { await w.runner.stop() }
}

const LOOK_CODE = '{"action":"none","world":{"do":"look","topic":"怎么做","verb":"写程序"}}'

test('helpers: the two limits come only with code_max_chars; which pages are the program page; measuring like the town', () => {
  assert.deepEqual(codeLimitOf(turnOf()), { code: 16000, total: CODE_ANSWER_MAX })
  assert.equal(codeLimitOf(turnOf({ code: 0 })), null, 'old town / not an island decision turn')
  assert.equal(codeLimitOf({}), null)
  for (const verb of ['写程序', 'sdk', 'code', '开店 自己写程序']) assert.ok(isCodeRead({ do: 'look', topic: '怎么做', verb }), verb)
  for (const r of [{ topic: '怎么做', verb: '建模' }, { topic: '怎么做', verb: '开店' }, { topic: '地' }, { topic: '店', verb: '写程序' }, null]) assert.equal(isCodeRead(r), false, JSON.stringify(r))
  const lim = codeLimitOf(turnOf())
  assert.equal(codeTooLong(openWith(program(16000)), lim), '', 'exactly 16000 is fine')
  assert.equal(codeTooLong(openWith(program(16001)), lim), '程序太长了：现在 16001 字，最多 16000 字')
  assert.equal(codeTooLong(JSON.stringify({ world: { do: 'door', steps: [{ rules: program(16500) }] } }), lim), '程序太长了：现在 16500 字，最多 16000 字', 'rules deep inside count too')
  const long = JSON.stringify({ action: 'none', note: '字'.repeat(24001) })
  assert.equal(codeTooLong(long, lim), `回答太长了：现在 ${[...long].length} 字，最多 24000 字`)
  assert.equal(codeTooLong('not json', lim), '')
  assert.equal(codeTooLong(openWith(program(20000)), null), '', 'no limits -> no check (the town says)')
  assert.match(buildTooLongFollowup('程序太长了：现在 16001 字，最多 16000 字'), /^这份回答交不了：程序太长了：现在 16001 字，最多 16000 字。.*删短/)
  const f = buildReadFollowup({ topic: '怎么做', verb: '写程序' }, '页', 2, lim)
  assert.match(f, /【这一回合交程序】整段回答最多 24000 字、程序本身（code \/ rules）最多 16000 字，不受开头「不超过 N 字」的限制/)
  assert.doesNotMatch(buildReadFollowup({ topic: '怎么做', verb: '写程序' }, '页', 2), /这一回合交程序/)
})

test('she reads the program page on an island turn: the page comes back with 24000 / 16000; a 15000-char program goes whole, newlines kept', async () => {
  const code = program(15000)
  const w = runWorld({ answers: [LOOK_CODE, openWith(code)] })
  await settle(w)
  assert.match(w.asks[0].text, /只输出一段 JSON（不超过 400 字）/, 'the first prompt keeps N')
  assert.match(w.asks[1].text, /【这一回合交程序】整段回答最多 24000 字、程序本身（code \/ rules）最多 16000 字/)
  assert.equal(w.posted.length, 1)
  const got = JSON.parse(w.posted[0][1]).world.code
  assert.equal([...got].length, 15000)
  assert.equal(got, code)
  assert.ok(got.includes('\n'))
  assert.equal(w.asks.length, 2, 'not too long: no extra ask')
})

test('a normal look on the same turn: no program line, N unchanged', async () => {
  const w = runWorld({ answers: ['{"action":"none","world":{"do":"look","topic":"地"}}', '{"action":"none"}'] })
  await settle(w)
  assert.doesNotMatch(w.asks[1].text, /这一回合交程序/)
  assert.match(w.asks[0].text, /不超过 400 字/)
})

test('after the program page, a later page still carries the line', async () => {
  const w = runWorld({ answers: [LOOK_CODE, '{"action":"none","world":{"do":"look","topic":"地"}}', '{"action":"none"}'] })
  await settle(w)
  assert.match(w.asks[2].text, /【你刚查的：挂着的地】[\s\S]*【这一回合交程序】/)
})

test('old town (no code_max_chars): reading the program page adds nothing', async () => {
  const w = runWorld({ answers: [LOOK_CODE, '{"action":"none"}'], turn: turnOf({ code: 0 }) })
  await settle(w)
  assert.doesNotMatch(w.asks[1].text, /这一回合交程序/)
})

test("over 16000: she gets the town's own sentence once and the shorter one goes", async () => {
  const short = program(9000)
  const w = runWorld({ answers: [LOOK_CODE, openWith(program(16500)), openWith(short)] })
  await settle(w)
  assert.equal(w.asks.length, 3)
  assert.match(w.asks[2].text, /^这份回答交不了：程序太长了：现在 16500 字，最多 16000 字。/)
  assert.equal(w.asks[2].opts.followup, true)
  assert.equal(JSON.parse(w.posted[0][1]).world.code, short)
})

test('still too long after the ask: it goes as it is (the town says why), only one extra ask', async () => {
  const w = runWorld({ answers: [openWith(program(16500))] })
  await settle(w)
  assert.equal(w.asks.length, 2)
  assert.equal([...JSON.parse(w.posted[0][1]).world.code].length, 16500)
})
