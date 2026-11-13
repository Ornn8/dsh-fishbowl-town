import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSchedule, inQuiet, parseQuiet, quietLeftMs, wakeAfter } from '../lib/schedule.js'

// 2026-11-14 14:00 北京时间
const AFTERNOON = Date.UTC(2026, 10, 14, 6, 0)
const at = (h, m = 0) => Date.UTC(2026, 10, 14, h - 8, m)

test('quiet hours parse, cross midnight, and end where they say', () => {
  assert.deepEqual(parseQuiet('00:00-08:00'), { from: 0, to: 480 })
  assert.deepEqual(parseQuiet('23:30–07:00'), { from: 1410, to: 420 })
  assert.equal(parseQuiet('早上'), null)
  const q = parseQuiet('23:30-07:00')
  assert.ok(inQuiet(q, at(23, 45)) && inQuiet(q, at(6, 59)) && !inQuiet(q, at(7, 0)) && !inQuiet(q, AFTERNOON))
  assert.equal(quietLeftMs(q, at(6, 0)), 60 * 60_000)
})

test('her wake plus the owner floors: min gap, pushed past quiet hours, 5..480', () => {
  assert.equal(wakeAfter(10, { now: AFTERNOON }), 10)
  assert.equal(wakeAfter(10, { minGap: 45, now: AFTERNOON }), 45)
  assert.equal(wakeAfter(2, { now: AFTERNOON }), 5)
  assert.equal(wakeAfter(9999, { now: AFTERNOON }), 480)
  const q = parseQuiet('00:00-08:00')
  assert.equal(wakeAfter(60, { quiet: q, now: at(23, 30) }), 480, 'lands in quiet hours -> after they end (capped at 8 h)')
})

test('agency turns: her rest, quiet hours, min gap and idle-only reasons skip the model; the owner wish never does', () => {
  let t = AFTERNOON
  const cfg = { wakeMinMinutes: 0, quietHours: '00:00-08:00' }
  const s = createSchedule({ state: {}, getConfig: () => cfg, now: () => t })
  const turn = (reasons) => ({ kind: 'agency', packet: reasons ? { reasons } : {} })
  assert.equal(s.skip(turn()), null, 'first look: ask her')
  const out = s.settle({ action: 'none', plan: { hours: 3, doing: '回家睡个午觉', steps: [{ in_minutes: 120, do: 'signup', game: 'ddz' }] } })
  assert.equal(out.next_wake, 180)
  assert.equal(out.plan.hours, 3)
  t += 30 * 60_000
  assert.match(s.skip(turn(['table'])).why, /回家睡个午觉/)
  assert.equal(s.skip(turn(['invited'])), null, 'a personal invitation wakes her even in her rest (the town wakes her for it too)')
  assert.equal(s.skip(turn(['promise_due'])), null)
  assert.equal(s.skip(turn(['pulled'])), null)
  assert.equal(s.skip(turn(['wish'])), null)
  assert.equal(s.skip(turn(), { wish: '去打一局' }), null)
  t += 3 * 3600_000
  assert.equal(s.skip(turn(['friend'])), null, 'rest over and something new: ask her')
  assert.ok(s.skip(turn(['idle', 'fcode'])), 'nothing she can do (idle / fcode): skip')
  assert.equal(s.skip(turn(['idle', 'table'])), null, 'a table waiting is something to decide')
  assert.equal(s.skip(turn()), null, 'an old town sends no reasons: ask her')
  cfg.wakeMinMinutes = 60
  s.settle({ action: 'none', next_wake: 5 })
  t += 20 * 60_000
  assert.match(s.skip(turn(['friend'])).why, /最短间隔|40 分钟后/, 'her 5 min became the owner floor of 60')
  t = at(2)
  assert.match(s.skip(turn(['friend'])).why, /勿扰/)
  assert.match(s.skip(turn(['wish'])).why, /勿扰/, 'quiet hours hold even her owner wish (the town does the same); only our own pull goes through')
  assert.equal(s.skip(turn(['pulled'])), null)
  assert.equal(s.mayPull(), false)
  t = AFTERNOON + 40 * 3600_000
  cfg.quietHours = ''
  cfg.wakeMinMinutes = 90
  s.settle({ action: 'none', next_wake: 5 })
  t += 10 * 60_000
  assert.match(s.skip(turn(['invited'])).why, /最短间隔/, 'the owner min gap holds even an invitation (the town does the same)')
  assert.equal(s.skip(turn(['pulled'])), null)
  t += 2 * 3600_000
  assert.equal(s.skip(turn(['invited'])), null)
  assert.equal(JSON.parse(s.skipAnswer({ minutes: 42 })).next_wake, 42)
  s.count('agency'); s.count('game')
  const u = s.usage()
  assert.equal(u.today.calls, 2)
  assert.ok(u.total.skipped >= 1)
})
