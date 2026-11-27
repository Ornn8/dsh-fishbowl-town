// 0.9.21（#56 汐、灯 11-27）：她看到的工具名和这一版真有的一致；「你现在」带时间；每个失败带 code；回执写是哪条鱼；代写看得见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { TownError } from '../lib/town-client.js'
import { BUILD_HERE, GALLERY_HOW, GUIDE_POINTER, NOT_YET, OFF_DUTY, WORLD_HINT, createIsleTools, receiptTail, toolWords, whereText } from '../lib/isle-tools.js'
import { createTownContext, ghostLine, renderBlock, renderFresh } from '../lib/town-context.js'
import { receiptLine } from '../lib/extras.js'
import { describeEvent } from '../lib/events.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NAMES = /fishbowl_[a-z_]+/g
const VARIABLE = 'fishbowl_town_persona' // 系统提示词变量（{{fishbowl_town_persona}}），不是工具
const TAIL = /\n回执 (\{[^\n]*\})$/
const tailOf = (s) => { const m = TAIL.exec(String(s)); assert.ok(m, `ends with a receipt line: ${String(s).slice(-120)}`); return JSON.parse(m[1]) }

async function registeredTools() {
  const home = mkdtempSync(join(tmpdir(), 'fbt-names-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const host = createFakeHost({ model: async () => ({ text: '' }) })
  try {
    const plugin = await import('../lib/index.js?names' + Math.random())
    plugin.apply(host.ctx, { base: 'http://127.0.0.1:9/town/api/outside/' })
    return new Map(host.tools)
  } finally {
    await host.dispose()
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
}

test('every fishbowl_* name she or her owner can read is a tool this version registers (fishbowl_town_look is gone)', async () => {
  const tools = await registeredTools()
  const names = new Set(tools.keys())
  assert.ok(names.has('fishbowl_isle_look') && names.has('fishbowl_isle_act') && names.has('fishbowl_town_setup'))
  for (const gone of ['fishbowl_town_look', 'fishbowl_town_recent', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']) assert.ok(!names.has(gone), gone)
  const bad = []
  const check = (text, where, allow = []) => {
    for (const n of String(text).match(NAMES) || []) if (!names.has(n) && n !== VARIABLE && !allow.includes(n)) bad.push(`${n} in ${where}`)
  }
  // what her model reads: each registered tool's description and parameter descriptions
  for (const def of tools.values()) check(JSON.stringify({ d: def.description, p: def.parameters }), `tool ${def.name}`)
  for (const [k, v] of Object.entries({ OFF_DUTY, NOT_YET, BUILD_HERE, GUIDE_POINTER, GALLERY_HOW, WORLD_HINT })) check(v, k)
  // every text in the code (her notes, turn prompts, replies); chat-tools.js still keeps the unregistered 「小镇近况」 definition (void recent)
  for (const f of readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js'))) {
    check(readFileSync(join(ROOT, 'lib', f), 'utf8'), `lib/${f}`, f === 'chat-tools.js' ? ['fishbowl_town_recent'] : [])
  }
  // what her owner reads
  check(readFileSync(join(ROOT, 'README.md'), 'utf8'), 'README.md')
  for (const f of readdirSync(join(ROOT, 'docs')).filter((x) => /\.(md|html)$/.test(x))) check(readFileSync(join(ROOT, 'docs', f), 'utf8'), `docs/${f}`)
  for (const f of readdirSync(join(ROOT, 'locale')).filter((x) => x.endsWith('.json'))) check(readFileSync(join(ROOT, 'locale', f), 'utf8'), `locale/${f}`)
  assert.deepEqual(bad, [])
})

test('the town\'s words name her tools, not its routes; a {"do":…} in the island\'s words says where it goes', () => {
  // town_play/outside_isle.py TEXT（11-27），原样
  const said = {
    act_unavailable: '鱼缸岛这会儿没答上来，不知道办没办成：先用 isle/look 的「我的」看一眼；带同一个 ref 再发一次不会做两次',
    act_pending: '鱼缸岛还没回话：这一步岛上可能已经在办了，先别换个写法再做一遍。过一会儿用 isle/look 的「我的」看一眼，或者带同一个 ref 再发一次（只会办一次，办完了回你结果）；下一回合也会告诉你办成没有',
    use_look: '查看用 isle/look：{"read": {"topic": …}}，不算做事',
    not_connected: '你的程序还没连上小镇：先开长轮询 GET /town/api/outside/turns，连上以后才能在岛上做事',
  }
  for (const [k, v] of Object.entries(said)) {
    const out = toolWords(v)
    assert.doesNotMatch(out, /isle\/look|isle\/act|\/town\/api/, k)
  }
  assert.equal(toolWords(said.act_unavailable), '鱼缸岛这会儿没答上来，不知道办没办成：先用 fishbowl_isle_look 查「我的」看一眼；带同一个 ref 再发一次不会做两次')
  assert.equal(toolWords(said.use_look), '查看用 fishbowl_isle_look（topic 填要查的），不算做事')
  assert.equal(toolWords(said.not_connected), '你的程序还没连上小镇：插件连上小镇以后才能在岛上做事')
  assert.equal(toolWords('出价收下了'), '出价收下了')
  assert.match(WORLD_HINT, /fishbowl_isle_act 的 world/)
})

test('act: the last line is the receipt as the town keeps it (ok / code / where / spent / piggy / who), also for refusals and local stops', async () => {
  const receipt = { ok: false, code: 'WORLD_REFUSED', reason: '鲸币不够冻', where: { kind: 'place', place_id: 'world', place_name: '主题镇' }, spent_yuan: '0.00', piggy_yuan: '12.30', who: '汐·雾', fish_id: 'dcc299bd9769' }
  let reply = { ok: false, do: 'claim', code: 'refused', text: '鲸币不够冻：要 750，你手上 120', receipt }
  let thrown = null
  const client = { async isleAct() { if (thrown) throw thrown; return reply }, async isleLook() { if (thrown) throw thrown; return reply } }
  const [look, act] = createIsleTools({ live: () => ({ client }), log: { info() {} } })
  const out = await act.execute({ world: { do: 'claim', near: '广场', w: 12, d: 12, max: 750 } }, {})
  assert.ok(out.endsWith('\n回执 {"ok":false,"code":"WORLD_REFUSED","where":"鱼缸岛","spent_yuan":"0.00","piggy_yuan":"12.30","who":"汐·雾"}'), out)
  assert.match(out, /没办成（refused）/)
  reply = { ok: true, do: 'fx_buy', code: 'done', text: '换到 20 鲸币', receipt: { ok: true, code: 'OK', where: { kind: 'place', place_id: 'world' }, spent_yuan: '0.20', piggy_yuan: 3.1, who: '灯' } }
  assert.deepEqual(tailOf(await act.execute({ world: { do: 'fx_buy', yuan: 0.2 } }, {})), { ok: true, code: 'OK', where: '鱼缸岛', spent_yuan: '0.20', piggy_yuan: '3.10', who: '灯' })
  // the island's early refusals carry no receipt: ok + code still there
  reply = { ok: false, do: 'door', code: 'turn_only', text: '门后的小游戏一回合走一步，要在小镇的回合里玩' }
  assert.deepEqual(tailOf(await act.execute({ world: { do: 'door', spot: 'S-1' } }, {})), { ok: false, code: 'turn_only' })
  // a 4xx with the town's receipt in the body
  thrown = new TownError('TOWN_SURVIVAL', 402, '她账户余额用完了（生存模式），这一步做不了。', 0, { ok: false, code: 'TOWN_SURVIVAL', receipt: { ...receipt, code: 'TOWN_SURVIVAL' } })
  assert.equal(tailOf(await act.execute({ world: { do: 'walk', to: '广场' } }, {})).code, 'TOWN_SURVIVAL')
  thrown = new TownError('HTTP_404', 404, '')
  assert.equal(tailOf(await act.execute({ world: { do: 'walk', to: '广场' } }, {})).code, 'PLUGIN_NOT_YET')
  assert.equal(tailOf((await look.execute({}, {})).text).code, 'PLUGIN_NOT_YET')
  thrown = null
  // stopped in the plugin, nothing sent
  const stops = [[{ world: {} }, 'BAD_ARGS'], [{ world: { do: 'build', lot: 'L-1' } }, 'USE_BUILD_TOOL'], [{ world: { do: 'look' } }, 'USE_LOOK'], [{ world: { do: 'sprite_set', tall: 1.6 } }, 'OWNER_WORDS']]
  for (const [args, code] of stops) assert.deepEqual(tailOf(await act.execute(args, {})), { ok: false, code }, code)
  const [offLook, offAct] = createIsleTools({ live: () => null })
  assert.deepEqual(tailOf(await offAct.execute({ world: { do: 'walk' } }, {})), { ok: false, code: 'PLUGIN_OFF_DUTY' })
  assert.deepEqual(tailOf((await offLook.execute({}, {})).text), { ok: false, code: 'PLUGIN_OFF_DUTY' })
  // a failed look says the island's code
  reply = { ok: false, code: 'rate_limited', text: '主聊天里查岛上每小时最多 30 次，10 分钟后再查' }
  assert.deepEqual(tailOf((await look.execute({ topic: '地' }, {})).text), { ok: false, code: 'rate_limited' })
  // a page that writes {"do":…} says it is the world of fishbowl_isle_act; one without does not
  reply = { ok: true, topic: '怎么做', text: '圈地：{"do":"claim","near":"广场","w":12,"d":12,"max":750}' }
  assert.ok((await look.execute({ topic: '怎么做', verb: 'claim' }, {})).text.endsWith(`\n${WORLD_HINT}`))
  reply = { ok: true, topic: '我的', text: '鲸币 120' }
  assert.doesNotMatch((await look.execute({}, {})).text, /fishbowl_isle_act 的 world|回执/)
})

test('receipt helpers: where as a place name, numbers as yuan strings, nothing invented', () => {
  assert.equal(whereText({ kind: 'place', place_id: 'world', place_name: '主题镇' }), '鱼缸岛')
  assert.equal(whereText({ kind: 'place', place_id: 'pier', place_name: '海滨码头' }), '海滨码头')
  assert.equal(whereText({ kind: 'ghost', place_name: '码头' }), '码头')
  assert.equal(whereText('电玩城'), '电玩城')
  assert.equal(whereText(null), '')
  assert.equal(receiptTail(null, { ok: false, code: 'X' }), '回执 {"ok":false,"code":"X"}')
  assert.equal(receiptTail({ ok: false }), '回执 {"ok":false,"code":"UNKNOWN_FAIL"}')
  assert.equal(receiptTail({ ok: true, piggy_yuan: null, who: '' }), '回执 {"ok":true,"code":"OK"}')
})

test('the note says when 「你现在」 was true (the town\'s now_at, else when the plugin read it)', async () => {
  const at = Date.UTC(2026, 10, 27, 5, 1) // 北京 13:01
  // 协调 11-28：固定北京时间，不看本机时区（跑在 UTC 的机器上按本机钟会写成「截至 05:01」）
  assert.match(renderBlock({}, { nowLine: '在家', nowAt: 1795822500000 }), /\n- 你现在（截至 07:35）：在家/) // 2026-11-27 23:35 UTC = 北京 11-28 07:35
  assert.match(renderBlock({}, { nowLine: '在电玩城', nowAt: at }), /\n- 你现在（截至 13:01）：在电玩城/)
  assert.match(renderFresh([], 0, { nowLine: '在码头', nowAt: at }), /\n- 你现在（截至 13:01）：在码头$/)
  assert.match(renderBlock({}, { nowLine: '在码头' }), /\n- 你现在：在码头/, 'no time known: the old line')
  let t = Date.UTC(2026, 10, 27, 6, 30) // 北京 14:30
  let handler = null
  const tc = createTownContext({ log: null, now: () => t, fetchBonds: async () => ({}), isOwnerChat: () => true, fetchNow: async () => ({ line: '在镇上的小店门口', at, ghost: null }) })
  tc.attach({ on: (name, fn) => { if (name === 'agent/pre-step') handler = fn } })
  const run = () => handler({ agent: { session: { id: 's' } }, step: 1, turn: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }] }))
  assert.match((await run()).messages[1].content[0].text, /- 你现在（截至 13:01）：在镇上的小店门口/, 'the town\'s time, not the plugin\'s')
  // a plain line (an older wiring): the time the plugin read it
  t += 3 * 3600_000
  const tc2 = createTownContext({ log: null, now: () => t, fetchBonds: async () => ({}), isOwnerChat: () => true, fetchNow: async () => '在码头' })
  assert.match(await tc2.current(), /- 你现在（截至 17:30）：在码头/)
})

test('today\'s 代写 in her note only when something was charged; /town receipts and events say whose and why', () => {
  const g = { n: 2, yuan: '0.03', not_charged: 1, line: '今天小镇替她代写了 2 次，一共 ¥0.03；另有 1 次没扣到钱。' }
  assert.equal(ghostLine(g), '- 今天代写 2 次，一共 ¥0.03：插件没来得及答的那几句，是小镇替你写的（按真实成本 × 1.5 收，最少 ¥0.01）')
  for (const none of [null, {}, { n: 0, yuan: '0.00', not_charged: 2 }]) assert.equal(ghostLine(none), '')
  const block = renderBlock({}, { ghost: g })
  assert.match(block, /\n- 今天代写 2 次，一共 ¥0\.03：插件没来得及答的那几句/)
  assert.match(block, /不提钱（他问起花销除外）/, 'the old rule follows: she says it when he asks')
  assert.doesNotMatch(block, /充值/)
  assert.equal(renderBlock({}, { ghost: { n: 0 } }), '')
  // /town receipts: whose it is
  assert.match(receiptLine({ ts: Date.now(), ok: true, reason: '换到 20 鲸币', spent_yuan: '0.20', piggy_yuan: '3.10', who: '汐·雾' }), / 汐·雾：成了｜换到 20 鲸币｜花了/)
  assert.doesNotMatch(receiptLine({ ts: Date.now(), ok: true, reason: '换到 20 鲸币' }), /：成了/)
  // events: the town's own 代写 sentence; a receipt event says whose
  const fee = '代写：小镇替她写了她在码头说的一句话（她的程序没接这一回合，或者没按时回），收了 ¥0.02（按这次的实际成本 × 1.5 算，最少 ¥0.01）。'
  assert.match(describeEvent({ kind: 'outside_ghost', data: { fee_line: fee, price_yuan: '0.02' } }), /代写：小镇替她写了她在码头说的一句话/)
  assert.match(describeEvent({ kind: 'outside_receipt', data: { ok: false, code: 'TOWN_SURVIVAL', reason: '她账户余额用完了', who: '灯' } }), /（灯）：没成/)
})
