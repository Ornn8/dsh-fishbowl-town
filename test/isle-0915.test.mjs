// 0.9.15 说明和工具跟上鱼缸岛 11-23 14:55 上线的那一批（地租减半、大户费分三类、竞拍到点后最多 1 小时随机结束、建楼和室内降价、
// 自由建模、银行存取、自己的地和楼挂出去卖、开张后换店的类、查「玩的」、楼号 B-… 当 lot）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUCTION_RULE, BANK_RULE, BUILD_FREE, BUILD_STEP, RENT_RULE, TAX_RULE, guideText } from '../lib/guide.js'
import { LOOK_TOPICS, createIsleTools, readOf, worldOf } from '../lib/isle-tools.js'
import { BUILD_DESCRIPTION, createBuildTool } from '../lib/cobuild-tool.js'
import { buildReadFollowup } from '../lib/isle.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const VENDORED = readFileSync(join(ROOT, 'lib', 'cobuild', 'README.md'), 'utf8')

function tools(client) {
  const j = []
  const [look, act] = createIsleTools({ live: () => ({ client }), journal: { event: (kind, text) => j.push({ kind, text }) }, log: { info() {} } })
  return { look, act, j }
}

test('the island\'s 大户费 sentence (land.tax_note) and the 1-hour auction tail are in the guide and the README', () => {
  assert.equal(TAX_RULE, '大户费分三类各算各的（同一个主人名下的鱼合起来算）：田、果园、牧场按块数，前 3 块不交，第 4–6 块每块另交它地租的 1 倍，第 7 块起 3 倍；'
    + '商铺、住房按面积，各有 1000 平方米不交：超出的面积占这一类的几成，这一类每块地就另交它地租的几成（1000–3000 平方米那部分按 1 倍算，3000 平方米以上那部分按 3 倍算）')
  assert.match(AUCTION_RULE, /到点以后再挂最多 1 小时，随机结束/)
  assert.match(AUCTION_RULE, /这一小时只有出过价的鱼能接着加价/)
  for (const [where, text] of [['新手引导', guideText()], ['README', README]]) {
    for (const rule of [RENT_RULE, TAX_RULE, AUCTION_RULE, BANK_RULE, BUILD_FREE]) assert.ok(text.includes(rule), `${where} lacks 「${rule.slice(0, 14)}…」`)
    assert.match(text, /11 月 25 日起收/, where)
    assert.match(text, /先抵大户费、再抵地租/, where)
    assert.match(text, /成交价的 95% 给她，拿到满 7 天才能卖/, where)
  }
  assert.ok(BUILD_STEP.includes(BUILD_FREE))
})

test('no stale numbers left anywhere she or her owner reads', () => {
  const [look, act] = createIsleTools({ live: () => null })
  const said = { 新手引导: guideText(), README, 插件自带的建模说明: VENDORED, 做一件事: act.description, 看岛上: look.description, 一起盖楼: BUILD_DESCRIPTION }
  for (const [where, text] of Object.entries(said)) {
    for (const old of ['0.2%', '最多 3 小时', '再挂 3 小时', '12 米高', '512 KB', '起步 50 鲸币', '每平方米 1 鲸币', '每天每平方米 0.05', '每 MB 每天 20 鲸币', '每一万面每天 10 鲸币']) {
      assert.ok(!text.includes(old), `${where} still says 「${old}」`)
    }
  }
  for (const w of ['高：20–40 米 每米 18.75 鲸币', '体积：20000 立方米以上每立方米 0.05 鲸币', '文件：2048–6144 KB 每 MB 100 鲸币', '起步 20 + 96 鲸币，房间 24 间']) assert.ok(README.includes(w), w)
  assert.match(VENDORED, /起步 20 鲸币 \+ 每平方米 0\.2 鲸币/)
  assert.match(VENDORED, /这 14 种是质感，每种都能配任意 `color`；用哪几种、什么颜色不限/)
  assert.match(VENDORED, /样子不限/)
  assert.match(BUILD_DESCRIPTION, /什么材质和颜色、主人贴不贴自己的图，都由你们定，不限；只守地界和上限/)
  assert.match(BUILD_DESCRIPTION, /承包的楼也可以填楼号/)
})

test('look: 「玩的」 is a topic of its own (not turned into 「我的」) and gets its own heading, in the chat tool and in a turn', async () => {
  assert.ok(LOOK_TOPICS.includes('玩的'))
  assert.ok(!LOOK_TOPICS.includes('住宿'), '「住宿」 waits until the island opens it')
  assert.deepEqual(readOf({ topic: '玩的', kind: '狼人杀' }), { topic: '玩的', kind: '狼人杀' })
  const reads = []
  const page = '—— 岛上鱼开的（1 处）——\ns_6b7a4003「两张凳一张桌」温鱼（外来的鱼）开的牌桌：门后的世界（一个人玩）；246 米'
  const { look } = tools({ async isleLook(read) { reads.push(read); return { ok: true, topic: '玩的', page: 1, items: [], text: page, next: null } } })
  const out = await look.execute({ topic: '玩的' }, {})
  assert.deepEqual(reads[0], { topic: '玩的' })
  assert.equal(out.text, `【岛上 · 能玩的地方】\n${page}`)
  assert.match(look.description, /玩的（能玩的地方：岛上鱼开的门后世界和游戏店、镇上的桌，带怎么坐/)
  assert.match(buildReadFollowup({ topic: '玩的' }, page, 2), /^【你刚查的：能玩的地方】/)
})

test('act: bank, sell / unsell (a B-id lot too), facade with kind, demolish a B-id go to the island as she wrote them', async () => {
  const worlds = [
    { do: 'bank', save: 100 },
    { do: 'bank', take: 40 },
    { do: 'bank' },
    { do: 'sell', lot: 'B-0009', floor: 800 },
    { do: 'unsell', lot: 'L-0107' },
    { do: 'facade', spot: 's_6b7a4003', kind: '游戏', kind_word: '牌桌' },
    { do: 'demolish', lot: 'B-0009' },
  ]
  const sent = []
  const { act, j } = tools({ async isleAct(world, ref) { sent.push({ world, ref }); return { ok: true, text: `收到 ${world.do}` } } })
  for (const w of worlds) {
    const r = await act.execute({ world: w }, {})
    assert.match(r, new RegExp(`岛上回你的：「收到 ${w.do}」`))
  }
  assert.deepEqual(sent.map((x) => x.world), worlds)
  assert.ok(sent.every((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x.ref)))
  assert.match(j[0].text, /存取银行/)
  assert.match(j[3].text, /把地和楼挂出去卖/)
  assert.match(j[4].text, /撤下挂着卖的地/)
  assert.deepEqual(worldOf({ do: 'bank', save: 5 }), { do: 'bank', save: 5 })
  for (const w of ['{"do":"bank","save":100}', '"take" 取', '{"do":"sell","lot":"地号或楼号","floor":底价}', 'unsell 撤下', '改门面和店的类']) {
    assert.ok(act.description.includes(w), w)
  }
  assert.doesNotMatch(act.description, /赚|划算|趁|该买|该卖|充值吧|去充值/)
})

test('co-build start takes a building id (B-…) as lot', async () => {
  let got = null
  const tool = createBuildTool({ cobuild: { start: async (a) => { got = a; return { text: 'ok' } } } })
  await tool.execute({ do: 'start', lot: 'B-0009', idea: '一间小商场' }, { agent: { session: { id: 's1' } } })
  assert.deepEqual(got, { lot: 'B-0009', idea: '一间小商场', interior: false, floor: undefined })
})
