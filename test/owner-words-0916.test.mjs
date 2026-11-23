// 0.9.16：主人的话里别的插件、平台加的时间行不算他的话（11-23 一位主人叫鱼交二楼，鱼说「插件看到的最后一行是 QQ 私聊里的系统时间戳」，
// 「交吧」没被认出来）；换鲸币她自己定（主人 11-23「换钱我建议主动点，本来充钱就是给小鱼花的」，isle-tools 的测试里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerWords, isYes, ownerText } from '../lib/cobuild.js'

test('time and system lines are not his words', () => {
  const cases = [['交吧', '交吧'], ['[2026-11-23 18:05:22]', ''], ['2026-11-23 18:05:22\n交吧', '交吧'], ['交吧\r\n[2026/11/23 18:05]', '交吧'],
    ['<system_time>2026-11-23 18:05</system_time>\n交吧', '交吧'], ['当前时间：2026年11月23日 18:05 星期一', ''], ['【18:05】交吧', '交吧'],
    ['(发送时间 18:05:22) 好', '好'], ['2026-11-23T18:05:22+08:00', ''], ['现在是 2026-11-23 18:05 (CST)', ''], ['时间到了，交吧', '时间到了，交吧'],
    ['今天 18:00 前交吧', '今天 18:00 前交吧'], ['二楼两间卧室，等下再交', '二楼两间卧室，等下再交'], ['[图片]', '[图片]'], ['3', '3'], ['ok', 'ok']]
  for (const [raw, mine] of cases) assert.equal(ownerText(raw), mine, raw)
  assert.ok(isYes(ownerText('[2026-11-23 18:05:22]\n交吧')))
  assert.ok(!isYes(ownerText('18:06 等等，先别交')))
})

test('a time line after his 交吧 does not hide it', () => {
  const w = createOwnerWords({ now: () => 100 })
  w.observe('s', '交吧')
  w.observe('s', '[2026-11-23 18:05:22]') // 只有时间的一条：不记
  w.observe('s', '当前时间：2026年11月23日 18:05 星期一')
  assert.equal(w.latest('s').text, '交吧')
  w.observe('s', '2026-11-23 18:06:00\n好看') // 带着时间的一条：认他自己打的那句
  assert.equal(w.latest('s').text, '好看')
})
