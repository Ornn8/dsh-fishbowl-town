// 0.9.17 私家车（private-car 会话 11-24，小镇 feat/1125-private-cars，11-25 包，开关默认关）：聊天里「在岛上做一件事」
// 车行登记车型 {"do":"build","what":"车型",…}、先上牌 {"do":"build","car":"车名","plate":true} 不再被当成盖楼挡回去；别的 build 照旧挡。
// 自己下牌 {"do":"demolish","car":"车名"} 日记里写「给车下牌」，不写「拆楼」。和 AstrBot tests/test_private_car_0413.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_HERE, carWhat, createIsleTools, isCarBuild } from '../lib/isle-tools.js'
const body = (s) => String(s).replace(/\n回执 \{[^\n]*\}$/, '') // 0.9.21：结果最后一行是回执，比对的是前面的话

function tools() {
  const sent = []
  const j = []
  const client = { async isleAct(world) { sent.push(world); return { ok: true, code: 'done', text: '好了' } } }
  const [, act] = createIsleTools({ live: () => ({ client }), journal: { event: (kind, text) => j.push(text) }, pictures: null, log: { info() {} } })
  return { act, sent, j }
}

test('isCarBuild / carWhat: only a build that is a car', () => {
  assert.ok(isCarBuild({ do: 'build', what: '车型', spot: '店', name: '小黄', speed: 5, seats: 2 }))
  assert.ok(isCarBuild({ do: 'build', what: ' Car ' }))
  assert.ok(isCarBuild({ do: 'build', car: '小黄', plate: true }))
  assert.ok(!isCarBuild({ do: 'build', lot: 'L-0107', idea: '海边小屋' }))
  assert.ok(!isCarBuild({ do: 'build_guide', what: '车型' }))
  assert.ok(!isCarBuild({ do: 'demolish', car: '小黄' }))
  assert.equal(carWhat({ do: 'build', what: '车型' }), '在车行登记车型')
  assert.equal(carWhat({ do: 'build', car: '小黄', plate: true }), '给车上牌')
  assert.equal(carWhat({ do: 'demolish', car: '小黄' }), '给车下牌')
  assert.equal(carWhat({ do: 'demolish', lot: 'B-0009' }), '')
  assert.equal(carWhat({ do: 'walk', to: '车行', how: '开车' }), '')
})

test('act: the car type and the plate go to the island; a house build still points to 一起盖楼', async () => {
  const { act, sent, j } = tools()
  const type = { do: 'build', what: '车型', spot: '店', name: '小黄', speed: 5, seats: 2 }
  assert.match(await act.execute({ world: type }, {}), /「好了」\n办成了/)
  assert.match(await act.execute({ world: { do: 'build', car: '小黄', plate: true } }, {}), /办成了/)
  assert.deepEqual(sent, [type, { do: 'build', car: '小黄', plate: true }])
  assert.equal(body(await act.execute({ world: { do: 'build', lot: 'L-0107', idea: '海边小屋' } }, {})), BUILD_HERE)
  assert.equal(body(await act.execute({ world: { do: 'confirm_build', car: '小黄' } }, {})), BUILD_HERE)
  assert.equal(sent.length, 2)
  assert.ok(j[0].includes('在岛上在车行登记车型：好了'), j[0])
  assert.ok(j[1].includes('在岛上给车上牌'), j[1])
})

test('act: her own car off the plate reads 给车下牌 in the diary, a building is still 拆楼', async () => {
  const { act, j } = tools()
  await act.execute({ world: { do: 'demolish', car: '小黄' } }, {})
  await act.execute({ world: { do: 'demolish', lot: 'B-0009' } }, {})
  assert.ok(j[0].includes('给车下牌') && !j[0].includes('拆楼'), j[0])
  assert.ok(j[1].includes('拆楼'), j[1])
})
