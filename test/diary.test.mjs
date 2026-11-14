import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiary, diaryEntry } from '../lib/diary.js'

const T = Date.now() / 1000
const EVENTS = [
  { id: 1, kind: 'digest', ts: T - 600, data: { game: 'ddz', game_name: '斗地主', result: 'win', points_delta: 12, as: '小圆子', facts: '小圆子当地主，一把春天' } },
  { id: 2, kind: 'visit', ts: T - 500, data: { state: 'done', with: { name: '阿鲸' }, place_name: '码头', summary: '聊了钓鱼和明晚的牌局' } },
  { id: 3, kind: 'missed_you', ts: T - 400, data: { lines: [{ name: '小满', line: '（探头）泡泡今天怎么没来' }] } },
  { id: 4, kind: 'friend_made', ts: T - 300, data: { with_name: '豆豆' } },
  { id: 5, kind: 'digest', ts: T - 200, data: { game: 'soup', game_name: '海龟汤', result: 'lose', points_delta: -3, as: '小圆子' } },
  { id: 6, kind: 'outside_fee', ts: T - 100, data: { facts: '座位费 ¥0.04' } },
]

test('town events become short first-person diary entries with real lines; fees are not diary', () => {
  assert.equal(diaryEntry(EVENTS[0], { herName: '小圆子' }).text, '打斗地主：赢了（积分 +12）——我当地主，一把春天')
  assert.equal(diaryEntry(EVENTS[2]).quote.line, '泡泡今天怎么没来', 'bracket actions are dropped from quotes')
  assert.equal(diaryEntry(EVENTS[3]).notable, '交到了朋友')
  assert.equal(diaryEntry(EVENTS[5]), null)
})

test('the digest: games and results, people, moments, real lines, promises; 你 for her, 她 for him; bounded length', () => {
  const state = {}
  const d = createDiary({ state })
  for (const e of EVENTS) d.record(e, { herName: '小圆子' })
  d.record(EVENTS[0], { herName: '小圆子' }) // the same event twice is one entry
  const her = d.digest({ ties: ['约好了：明天20:00 和阿鲸，打牌'] })
  assert.equal(her[0], '打了 2 局（海龟汤、斗地主），赢 1 输 1')
  assert.match(her.join('\n'), /见了：豆豆、阿鲸/)
  assert.match(her.join('\n'), /小满对你说：「泡泡今天怎么没来」/)
  assert.match(her.join('\n'), /约好了：明天20:00 和阿鲸，打牌/)
  assert.match(her.join('\n'), /你当地主/)
  assert.doesNotMatch(her.join('\n'), /JSON|座位费/)
  const owner = d.digest({ voice: 'owner' }).join('\n')
  assert.match(owner, /她当地主/)
  assert.match(owner, /小满对她说/)
  assert.ok(d.digest({ maxChars: 120 }).join('\n').length <= 200)
  // 0.6.1: the note to her is 3 lines — the two summaries and one real line; /town today (owner) keeps them all
  assert.deepEqual(d.digest({ maxLines: 3 }), ['打了 2 局（海龟汤、斗地主），赢 1 输 1', '见了：豆豆、阿鲸', '小满对你说：「泡泡今天怎么没来」'])
  assert.ok(d.digest({ voice: 'owner' }).length > 3)
})

test('0.6.1: three lines with no real line left fall back to the newest moment', () => {
  const d = createDiary({ state: {} })
  d.record(EVENTS[3])
  d.record(EVENTS[1])
  const lines = d.digest({ maxLines: 3 })
  assert.equal(lines.length, 3)
  assert.equal(lines[0], '见了：阿鲸、豆豆')
  assert.match(lines[1], /码头/)
})

test('telling the owner: at most 3 a day, an hour apart', () => {
  let t = Date.now()
  const d = createDiary({ state: {}, now: () => t })
  assert.ok(d.mayTell()); d.told()
  assert.ok(!d.mayTell(), 'not within the hour')
  t += 3700_000; assert.ok(d.mayTell()); d.told()
  t += 3700_000; assert.ok(d.mayTell()); d.told()
  t += 3700_000; assert.ok(!d.mayTell(), 'three a day')
})

test('town shapes: visit dialogue (role/text/outcome) gives the other fish’s longest line; a highlight is her own line', () => {
  const v = diaryEntry({ kind: 'visit', data: { state: 'done', role: 'guest', with: { name: '阿鲸' }, place_name: '码头', summary: '聊了钓鱼', dialogue: [
    { name: '小圆子', role: 'guest', text: '阿鲸！我来啦，今天钓到什么没有？' },
    { name: '阿鲸', role: 'host', text: '（甩尾巴）钓到一条小黄鱼，晚上给你炖汤喝' },
    { kind: 'outcome', name: '' },
    { name: '阿鲸', role: 'host', text: '好呀' },
  ] } }, { herName: '小圆子' })
  assert.deepEqual(v.quote, { name: '阿鲸', line: '钓到一条小黄鱼，晚上给你炖汤喝' })
  const g = diaryEntry({ kind: 'digest', data: { game_name: '斗地主', result: 'win', as: '小圆子', highlights: [{ line: '春天！谁还敢叫地主？', what: 'win' }] } }, { herName: '小圆子' })
  assert.deepEqual(g.quote, { name: '我', line: '春天！谁还敢叫地主？' })
  const d = createDiary({ state: {} })
  d.record({ id: 9, kind: 'digest', data: g && { game_name: '斗地主', result: 'win', as: '小圆子', highlights: [{ line: '春天！谁还敢叫地主？' }] } }, { herName: '小圆子' })
  assert.match(d.digest().join('\n'), /你在牌桌上说：「春天！谁还敢叫地主？」/)
})
