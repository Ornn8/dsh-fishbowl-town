// 0.9.6 她住在鱼缸岛上（主人 11-21）：给她的话以岛为先、路要自己走、老镇 11-28 关门；老镇的接口关了不重试。和 AstrBot 的 tests/test_island_home.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as O from '../lib/old-town.js'
import { buildTurnPrompt } from '../lib/prompt.js'
import { buildAsk, buildNoteAsk } from '../lib/chat-decide.js'
import { renderBlock } from '../lib/town-context.js'
import { TOWN_WHO } from '../lib/journal.js'
import { createSelfServe, runTownCommand, COMMAND_HELP, OWNER_DECIDES } from '../lib/self-serve.js'
import { createTownClient, TownError } from '../lib/town-client.js'
import { guideText } from '../lib/guide.js'

const BEFORE = O.CLOSE_AT_MS - 3600_000
const AFTER = O.CLOSE_AT_MS + 60_000
const OLD_WORDS = ['去码头', '报名打一局', '想在镇上做什么', '去不去打牌']

function agency({ isle = true, actions = ['none', 'signup', 'visit', 'pier'] } = {}) {
  const packet = { purpose: 'agency', reasons: ['idle'], actions: [...actions],
    messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '{"我":{"鲸币":800}}' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 } }
  if (isle) packet.isle = { static: 'a1b2c3d4e5f6', within_s: 120 }
  return { turn_id: 't1', kind: 'agency', packet }
}

test('the island lines follow the turn and the date', () => {
  assert.deepEqual(O.isleLines(agency(), BEFORE), [O.ISLE_HOME, O.OLD_TOWN])
  assert.deepEqual(O.isleLines(agency(), AFTER), [O.ISLE_HOME]) // 11-28 起不再提老镇
  assert.deepEqual(O.isleLines(agency({ isle: false }), BEFORE), [O.OLD_TOWN]) // 不在岛上：不说她住在岛上
  assert.deepEqual(O.isleLines(agency({ actions: ['none'] }), BEFORE), [O.ISLE_HOME]) // 小镇不列老镇的动作了：不提
  assert.doesNotMatch(O.ISLE_HOME + O.OLD_TOWN, /¥|饭票/)
})

test('her decision prompt is island-first; old-town tools and plan.steps only while the old town is open', () => {
  try {
    O.setCloseAt(4_000_000_000_000) // 老镇还开着（测试不跟着日子变）
    const text = buildTurnPrompt(agency(), { secondsLeft: 100 })
    assert.ok(text.includes(O.ISLE_HOME) && text.includes('去哪、做什么都照你自己的性子'))
    assert.doesNotMatch(text, /去不去打牌、找谁串门|小镇不替你安排/)
    assert.match(text, /老镇那边想自己挑/)
    const ex = buildTurnPrompt(agency(), { wish: '先去镜湖边走走', wishOwn: true, role: 'execute' })
    const later = buildTurnPrompt(agency({ actions: ['none'] }), { wish: '先去镜湖边走走', wishOwn: true, role: 'execute' })
    assert.match(ex, /老镇的事也可以照下面写进 plan\.steps/)
    assert.doesNotMatch(later, /plan\.steps|"steps"|老镇那边想自己挑/)
    assert.match(later, /还没走到/)
    assert.ok(!(ex + later).includes('{steps}'))
    O.setCloseAt(0) // 11-28 以后：老镇的事一句不提
    const closed = buildTurnPrompt(agency(), { wish: '先去镜湖边走走', wishOwn: true, role: 'execute' })
    assert.doesNotMatch(closed, /plan\.steps|"steps"|老镇/)
    assert.ok(closed.includes(O.ISLE_HOME))
  } finally { O.setCloseAt() }
})

test('her own ask has no old-town examples or prices', () => {
  const ask = buildAsk(agency())
  for (const w of OLD_WORDS) assert.ok(!ask.includes(w), w)
  assert.ok(ask.includes(O.ISLE_HOME) && ask.includes('镜湖') && !ask.includes('按小镇的价钱'))
  for (const w of OLD_WORDS) assert.ok(!buildNoteAsk('岛上的情况').includes(w), w)
  assert.ok(!TOWN_WHO.includes('去码头') && TOWN_WHO.includes('岛上'))
})

test('the owner-chat note names the old-town close only before it', () => {
  const bonds = { friends: [{ fish_id: 'f1', name: '阿鲸', friend: true }] }
  assert.ok(renderBlock(bonds, { nowMs: BEFORE }).includes(O.OLD_TOWN))
  assert.ok(!renderBlock(bonds, { nowMs: AFTER }).includes(O.OLD_TOWN))
  assert.equal(renderBlock({}, { nowMs: BEFORE }), '') // 没别的事：这一行自己不成一段
})

test('status lines use the town\'s isle field', () => {
  assert.equal(O.nowWithIsle({ now_line: '在家歇着，没在镇上哪个地方', isle: { open: true, here: true } }), '在鱼缸岛上')
  assert.equal(O.nowWithIsle({ now_line: '在桌游馆打麻将，正在打', isle: { open: true, here: true } }), '在桌游馆打麻将，正在打')
  assert.equal(O.nowWithIsle({ now_line: '在家歇着，没在镇上哪个地方', isle: { open: true, here: null } }), '在家歇着，没在镇上哪个地方')
  assert.equal(O.isleStatusLine({ isle: { open: true, here: true } }), '鱼缸岛：她在岛上')
  assert.match(O.isleStatusLine({ isle: { open: false, here: false } }), /没对她开放$/)
  assert.equal(O.isleStatusLine({}), '')
  assert.equal(O.isleStatusLine(null), '')
})

test('closed text before and after the close; the old-town tools and commands say it plainly', async () => {
  const e = new TownError('TOWN_OFF', 404, '串门现在没开放。')
  assert.equal(O.closedText(e, { now: BEFORE }), '这一项这会儿没开放：串门现在没开放。')
  const her = O.closedText(e, { now: AFTER })
  const owner = O.closedText(e, { owner: true, now: AFTER })
  assert.match(her, /11 月 28 日关门/)
  assert.match(her, /鱼缸岛/)
  assert.match(her, /去小镇/)
  assert.doesNotMatch(owner, /你不能/)
  assert.match(owner, /由她自己定.*跟她说/)
  assert.equal(O.isClosed(new TownError('TOWN_NOT_FOUND', 404)), false) // 「没有这个」不是关门
  assert.equal(O.isClosed(new TownError('TOWN_OFF', 503)), false) // 503 = 重启中
  try {
    O.setCloseAt(0)
    const shut = async () => { throw new TownError('TOWN_OFF', 404) }
    const client = { lobby: shut, play: shut, visit: shut, goto: shut, signupCancel: shut, status: async () => ({ piggy_yuan: 1 }) }
    const notes = []
    const ss = createSelfServe({ live: () => ({ client }), journal: { event: (k, t) => notes.push(t) } })
    assert.equal(await ss.look(), O.CLOSED_HER)
    assert.equal(await ss.visit('阿鲸', 'her'), O.CLOSED_HER)
    assert.equal(await ss.lookFor('owner'), O.CLOSED_OWNER) // /town tables：主人这边的说法
    assert.doesNotMatch(await ss.lookFor('owner'), /存钱罐|¥/)
    assert.equal((await runTownCommand('visit 阿鲸', { selfServe: ss, status: async () => '' })).text, OWNER_DECIDES) // 命令不替她去
  } finally { O.setCloseAt() }
})

test('help text no longer says the owner moves her', async () => {
  assert.doesNotMatch(COMMAND_HELP, /\/town (play|visit|go|cancel)\b|替她去|替她坐进/)
  assert.match(COMMAND_HELP, /由她自己定，命令不替她挪地方/)
  const g = guideText()
  assert.doesNotMatch(g, /¥0\.10|花的是饭票|\/town tables/)
  assert.match(g, /你不能替她挪地方/)
  assert.match(g, /11 月 28 日关门/)
})

test('a closed old-town route is not asked again for a while; the turn loop routes always are', async () => {
  const calls = []
  let t = 1_000_000
  let restarting = false
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace('/town/api/outside/', '')
    calls.push(path)
    const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (restarting) return json(503, { error: 'TOWN_RESTARTING', retry_after: 3 })
    if (path.startsWith('visits')) return json(404, { error: 'TOWN_OFF' })
    if (path === 'album') return json(404, { error: 'TOWN_NOT_FOUND' }) // 「没有这个」不是关门：照旧每次问
    if (path === 'turns') return json(404, { error: 'TOWN_OFF' })
    if (path === 'lobby') return { ok: false, status: 404, headers: { get: () => null }, text: async () => '404: Not Found' }
    return json(200, { ok: true })
  }
  const c = createTownClient({ base: 'https://t.test/town/api/outside/', code: 'fbo_test', fetchImpl, now: () => t })
  for (let i = 0; i < 3; i++) {
    for (const call of [() => c.visitList(), () => c.album(), () => c.turns(1), () => c.lobby()]) {
      await call().catch((e) => { assert.ok(e instanceof TownError) })
    }
  }
  await assert.rejects(c.visitLines('v1'), (e) => e.code === 'TOWN_OFF' && e.status === 404) // 同一块（visits/…）也不再问
  await assert.rejects(c.lobby(), (e) => e.code === 'HTTP_404' && e.status === 404)
  const n = (p) => calls.filter((x) => x === p).length
  assert.equal(n('visits'), 1)
  assert.equal(n('lobby'), 1)
  assert.equal(n('album'), 3)
  assert.equal(n('turns'), 3)
  assert.ok(!calls.includes('visits/v1'))
  t += 31 * 60_000 // 半小时以后再看一眼
  await c.visitList().catch(() => {})
  assert.equal(n('visits'), 2)
  restarting = true // 小镇重启（回合那条路回 503）：记着的「关了」作废，重启后再问一次
  await c.turns(1).catch(() => {})
  restarting = false
  await c.visitList().catch(() => {})
  assert.equal(n('visits'), 3)
})
