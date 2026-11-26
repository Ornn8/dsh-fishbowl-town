// 0.9.17 逐笔显示花钱（money-day 11-24，小镇 fix/1125-spend-lines-2 b0ffec75）：GET spending 多了 items（一笔一笔，新的在前）和 by_kind.isle。
// 不到 ¥0.01 的写四位；岛上付鲸币的那笔（isle_coin，amount_yuan '0'）写「-6 鲸币」，不写 ¥0、不写免费；退回来的写「+」；旧小镇没 items 照常显示。
// 和 AstrBot tests/test_spend_lines_0413.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billLine, billLines, renderSpend, SPEND_KIND_ZH, spendKindsLine, yuanExact } from '../lib/extras.js'
import { COMMAND_HELP } from '../lib/self-serve.js'

process.env.TZ = 'Asia/Shanghai' // 时间照 DSH 那台机器的本地时间写（和相册、一周一样）；测试固定北京时间

const TS = Date.parse('2026-11-25T10:12:00+08:00') / 1000
const SP = {
  fish_id: 'f1', currency: 'CNY', today: '0.12', d7: '1.30', d30: '4.50', total: '6.00', as_of: TS,
  by_kind: { model: '0.00', visit: '0.00', seat: '0.50', paint: '0.00', social: '0.00', places: '1.20', ghost: '0.00', isle: '0.03', other: '0.10' },
  items: [
    { ts: TS, day: '2026-11-25', kind: 'isle', amount_yuan: '0.0081', label: '「老卤小馆」（云汐的店） · 点卤鸡腿饭 6 鲸币 · 饭票换 2 鲸币 ¥0.0081' },
    { ts: TS - 19 * 60, day: '2026-11-25', kind: 'isle_coin', amount_yuan: '0', coin: 6, label: '「海风咖啡馆」 · 拿铁' },
    { ts: TS - 152 * 60, day: '2026-11-25', kind: 'places', amount_yuan: '-0.50', label: '小镇饭馆退款' },
    { ts: TS - 3600 * 24, day: '2026-11-24', kind: 'social', amount_yuan: '1.20', label: '请小圆子喝奶茶' },
  ],
}

test('yuanExact: two decimals at least, four when under a fen; junk is empty', () => {
  assert.equal(yuanExact('0.0081'), '¥0.0081')
  assert.equal(yuanExact('0.01630'), '¥0.0163')
  assert.equal(yuanExact('6'), '¥6.00')
  assert.equal(yuanExact('0.5'), '¥0.50')
  assert.equal(yuanExact('-0.50'), '¥0.50')               // 正负号由 billLine 管
  assert.equal(yuanExact(''), '')
  assert.equal(yuanExact('abc'), '')
  assert.equal(yuanExact(null), '')
})

test('billLine: isle four decimals, isle_coin as -N 鲸币 (never ¥0 or 免费), refund with +, time in Beijing', () => {
  const [isle, coin, back, social] = SP.items.map(billLine)
  assert.equal(isle, '11-25 10:12  -¥0.0081  「老卤小馆」（云汐的店） · 点卤鸡腿饭 6 鲸币 · 饭票换 2 鲸币 ¥0.0081')
  assert.equal(coin, '11-25 09:53  -6 鲸币  「海风咖啡馆」 · 拿铁')
  assert.doesNotMatch(coin, /¥0|免费/)
  assert.equal(back, '11-25 07:40  +¥0.50  小镇饭馆退款')
  assert.equal(social, '11-24 10:12  -¥1.20  请小圆子喝奶茶')
  assert.equal(billLine(null), '')
  assert.equal(billLines({}).length, 0)                      // 旧小镇没有 items
  assert.equal(billLines(SP, 2).length, 2)
})

test('spendKindsLine: only kinds with money, 鱼缸岛 for isle, in a fixed order', () => {
  assert.equal(SPEND_KIND_ZH.isle, '鱼缸岛')
  assert.equal(spendKindsLine(SP), '一共里按类：镇上的店 ¥1.20、鱼缸岛 ¥0.03、座位费 ¥0.50、其他 ¥0.10')
  assert.equal(spendKindsLine({ by_kind: { model: '0.00', isle: '0.0041' } }), '一共里按类：鱼缸岛 ¥0.0041') // 小镇 147218e5：岛上不到一分钱给四位
  assert.equal(spendKindsLine({ by_kind: { model: '0.00' } }), '')
  assert.equal(spendKindsLine({ total: '1' }), '')
})

test('renderSpend: totals, kinds, bills newest first; an old town without items still shows totals; no total → a plain line', () => {
  const t = renderSpend(SP, { name: '小圆子' })
  const lines = t.split('\n')
  assert.equal(lines[0], '小圆子 在小镇和岛上花的钱：今天 ¥0.12 · 7 天 ¥1.30 · 30 天 ¥4.50 · 一共 ¥6.00')
  assert.equal(lines[1], '一共里按类：镇上的店 ¥1.20、鱼缸岛 ¥0.03、座位费 ¥0.50、其他 ¥0.10')
  assert.equal(lines[2], '最近的账单（新的在前；打牌的座位费不在这里）：')
  assert.equal(lines[3], '- 11-25 10:12  -¥0.0081  「老卤小馆」（云汐的店） · 点卤鸡腿饭 6 鲸币 · 饭票换 2 鲸币 ¥0.0081')
  assert.equal(lines[4], '- 11-25 09:53  -6 鲸币  「海风咖啡馆」 · 拿铁')
  assert.equal(lines.length, 7)
  const old = renderSpend({ today: 0.12, d7: 1.3, d30: 4.5, total: 6 })
  assert.equal(old, '她 在小镇和岛上花的钱：今天 ¥0.12 · 7 天 ¥1.30 · 30 天 ¥4.50 · 一共 ¥6.00')
  assert.match(renderSpend({ ...SP, items: [] }), /最近没有账单。$/)
  assert.match(renderSpend(null), /小镇没给花钱的账/)
  assert.equal(renderSpend(SP, { n: 1 }).split('\n').length, 4)
})

test('/town help lists spend', () => {
  assert.match(COMMAND_HELP, /\/town spend +她在小镇和岛上花的钱：一笔一笔/)
})
