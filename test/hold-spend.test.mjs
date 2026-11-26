// 0.8.3 (11-17, a DSH owner: 「hold 拦不住顺带的钱……它替我去钓鱼时花的鱼饵 ¥0.04 照扣」): with spend held, the small piggy spends of a
// decision are taken out too — the pier / arcade / make place fields, a bare top-level do, a want that names them, plan steps that go
// there — while seat fees (signup) and harvesting what she already made stay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdCheck } from '../lib/prompt.js'
import { HOLD_KINDS } from '../lib/journal.js'

test('spend hold: pier, arcade, make, bare do, a paid want and paid plan steps are held; signup and harvest are not', () => {
  // her real answer on 11-17 10:23 (the town then read the want as fishing; the town no longer does that either)
  const real = { action: 'none', want: '去码头边坐着看水，不游泳不钓鱼，就待着', say: '', note: '下水要花两分，先记着，等她自己来。', plan: { hours: 2, doing: '在码头坐着看水，什么也不干', steps: [] }, next_wake: 120 }
  let h = holdCheck('agency', JSON.stringify(real), ['spend'])
  assert.equal(JSON.parse(h.clean).want, undefined)
  assert.match(h.found.join(), /想做的事要花钱/)
  h = holdCheck('agency', JSON.stringify({ action: 'pier', pier: { do: 'fish', casts: 2 } }), ['spend'])
  assert.deepEqual(JSON.parse(h.clean), { action: 'none' })
  assert.deepEqual(h.found, ['去码头钓鱼'])
  h = holdCheck('agency', JSON.stringify({ action: 'arcade', arcade: { do: 'play', machine: 'claw', tries: 1 } }), ['spend'])
  assert.equal(JSON.parse(h.clean).action, 'none')
  h = holdCheck('agency', JSON.stringify({ do: 'fish', casts: 1 }), ['spend'])
  assert.deepEqual(JSON.parse(h.clean), {})
  h = holdCheck('agency', JSON.stringify({ action: 'make', make: { do: 'start', activity: 'bake' } }), ['spend'])
  assert.equal(JSON.parse(h.clean).action, 'none')
  h = holdCheck('agency', JSON.stringify({ action: 'none', plan: { hours: 3, steps: [{ in_minutes: 10, do: 'pier' }, { in_minutes: 40, do: 'signup', game: 'ddz' }, { in_minutes: 90, do: 'arcade' }] } }), ['spend'])
  assert.deepEqual(JSON.parse(h.clean).plan.steps, [{ in_minutes: 40, do: 'signup', game: 'ddz' }])
  assert.deepEqual(h.found, ['计划里到点去码头', '计划里到点去电玩城'])
  for (const free of [{ action: 'signup', game: 'ddz' }, { action: 'make', make: { do: 'harvest', run_id: 'r1' } }, { action: 'pier', pier: { do: 'bottle', text: '你好' } }, { action: 'none', want: '去广场转转' }]) {
    assert.deepEqual(holdCheck('agency', JSON.stringify(free), ['spend']).found, [], JSON.stringify(free))
  }
  // without the hold nothing changes
  assert.deepEqual(holdCheck('agency', JSON.stringify({ action: 'pier', pier: { do: 'fish', casts: 2 } }), ['promise']).found, [])
  assert.match(HOLD_KINDS.spend, /电玩城/) // 0.9.17 第三版：电玩城是一条鱼的店，照开，说明里列着
  assert.doesNotMatch(HOLD_KINDS.spend, /钓鱼|手作/) // 0.9.17：老镇停了，说明里不再列码头、手作（拦的代码照旧，小镇还发就照拦）
  assert.match(HOLD_KINDS.spend, /座位费不算/)
})

test('0.9.17: spend hold also stops the arcade written in world (the fish-owned arcade, reached from the island)', () => {
  const h = holdCheck('agency', JSON.stringify({ action: 'none', world: { do: 'arcade', machine: '投篮机' }, note: '想玩' }), ['spend'])
  assert.deepEqual(h.found, ['去电玩城玩机器（投篮机）'])
  assert.deepEqual(JSON.parse(h.clean), { action: 'none', note: '想玩' })
  assert.deepEqual(holdCheck('agency', JSON.stringify({ action: 'none', world: { do: 'walk', to: '镜湖' } }), ['spend']).found, [])
  assert.deepEqual(holdCheck('agency', JSON.stringify({ action: 'none', world: { do: 'arcade', machine: '投篮机' } }), ['promise']).found, [])
})
