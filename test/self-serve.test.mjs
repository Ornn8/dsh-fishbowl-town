import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfServe, createSelfTools, runTownCommand, pickGame, pickFish, pickPlace, renderLobby, failText } from '../lib/self-serve.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'

// the town's final shape (self-serve lobby, 2026-11-13)
const LOBBY = {
  tables: [
    { venue_id: 'v_boardgame_ww', name: '桌游馆', game: 'werewolf', game_zh: '狼人杀', kind: 'table', keeper: '阿鲸', place: 'boardgame', state: 'open', joinable: true, seats_min: 6, seats_max: 9, waiting: 4, waiting_names: ['阿鲸', '小满', '豆豆', '七七'], seats_left: 2, fee_yuan: 0, playing_now: 0 },
    { venue_id: 'v_teahouse_ddz', name: '茶馆', game: 'ddz', game_zh: '斗地主', state: 'playing', joinable: false, seats_min: 3, seats_max: 3, waiting: 0, seats_left: 0, fee_yuan: 0.2 },
  ],
  games: [
    { game: 'werewolf', game_zh: '狼人杀', seats_min: 6, seats_max: 9, waiting_any: true, fee_yuan_from: 0, venues: ['v_boardgame_ww'] },
    { game: 'soup', game_zh: '海龟汤', seats_min: 2, seats_max: 6, waiting_any: false, fee_yuan_from: 0.1, venues: ['v_cafe_soup'] },
  ],
  activities: [{ activity_id: 'a_beach_vb', title: '沙滩排球', form: 'team', place: 'beach', pitch: '缺两个人', players: ['阿鲸'], min: 4, max: 6, waiting: 2, seats_left: 2, expires: 0 }],
  places: [{ place: 'pier', name_zh: '码头', how: 'do=fish 钓鱼（casts 次数）/ swim 游泳', price_rule: '每次 ¥0.02' }, { place: 'arcade', name_zh: '电玩城', how: 'do=play machine=…', price_rule: '一币 ¥0.05' }],
  fish: [{ fish_id: 'f_whale', name: '阿鲸', friend: true, resident: false, why: 'friend' }, { fish_id: 'f_man', name: '小满', friend: false, resident: true, why: 'resident' }],
  mine: { signups: [], at_table: null, visiting: null },
  rules: { one_open_signup: true, self_fill_wait_s: 180 },
}

function fakeLive(calls, overrides = {}) {
  const client = {
    lobby: async () => { calls.push(['lobby']); return LOBBY },
    play: async (b) => { calls.push(['play', b]); return { ok: true, signup_id: 's1', game: b.game || 'werewolf', game_zh: b.game === 'soup' ? '海龟汤' : '狼人杀', state: 'waiting', fill_after_s: 180, note: '等人齐' } },
    visit: async (b) => { calls.push(['visit', b]); return { ok: true, visit_id: 'vi1', state: 'knocking', note: '敲门了' } },
    goto: async (b) => { calls.push(['goto', b]); return { ok: true, place: b.place, outcome: '钓到一条小黄鱼', ref: 'r1' } },
    signupCancel: async (b) => { calls.push(['cancel', b]); return { ok: true } },
    ...overrides,
  }
  return () => ({ client })
}
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }

test('names resolve to games, tables (venue_id), activities, fish and places', () => {
  assert.deepEqual(pickGame(LOBBY, '狼人杀'), { game: 'werewolf' })
  assert.deepEqual(pickGame(LOBBY, 'Soup'), { game: 'soup' })
  assert.deepEqual(pickGame(LOBBY, 'v_boardgame_ww'), { venue_id: 'v_boardgame_ww' })
  assert.deepEqual(pickGame(LOBBY, 'a_beach_vb'), { activity_id: 'a_beach_vb' })
  assert.equal(pickGame(LOBBY, '飞行棋'), null)
  assert.equal(pickFish(LOBBY, '阿鲸').fish_id, 'f_whale')
  assert.equal(pickPlace(LOBBY, '码头').place, 'pier')
  assert.equal(pickPlace(null, '电玩城').place, 'arcade')
  const r = renderLobby(LOBBY)
  assert.match(r, /\[v_boardgame_ww\] 狼人杀 · 桌游馆：4 人在等（阿鲸、小满、豆豆、七七），还差 2 位，免费/)
  assert.match(r, /另有 1 桌正在打/)
  assert.doesNotMatch(r, /v_teahouse_ddz/)
  assert.match(r, /能开的游戏：狼人杀\(werewolf\)〔6–9 人，免费，有人在等〕、海龟汤\(soup\)〔2–6 人，¥0.10 起〕/)
  assert.match(r, /\[a_beach_vb\] 沙滩排球/)
  assert.match(r, /码头\(pier\)〔do=fish/)
  assert.match(r, /能串门的鱼：阿鲸（朋友）、小满（镇民）/)
})

test('her tools: open a werewolf table, visit 阿鲸, fish at the pier; journalled as her own choice', async () => {
  const calls = []
  const jr = journal()
  const ss = createSelfServe({ live: fakeLive(calls), journal: jr })
  const tools = Object.fromEntries(createSelfTools({ selfServe: ss }).map((t) => [t.name, t]))
  assert.match(await tools.fishbowl_town_play.execute({ game: '狼人杀' }), /开了一桌狼人杀：报上了，等人齐；3 分钟内没人来，镇民会来补位/)
  assert.match(await tools.fishbowl_town_visit.execute({ name: '阿鲸', intent: '约明晚打牌' }), /去敲阿鲸的门了/)
  assert.match(await tools.fishbowl_town_place.execute({ place: '码头', do: 'fish', details: { casts: 3 } }), /到码头了：钓到一条小黄鱼/)
  const acts = calls.filter((c) => c[0] !== 'lobby')
  assert.deepEqual(acts, [['play', { game: 'werewolf' }], ['visit', { fish_id: 'f_whale', intent: '约明晚打牌' }], ['goto', { place: 'pier', casts: 3, do: 'fish' }]])
  assert.ok(calls.filter((c) => c[0] === 'lobby').length <= 2, 'the lobby is cached (re-read only after an action changed it)')
  assert.ok(jr.j.every((e) => e.text.startsWith('你自己')))
  assert.match(await tools.fishbowl_town_look.execute({}), /等人的桌子/)
})

test('owner commands: /town tables | play | cancel | visit | go | help, journalled as the owner asking', async () => {
  const calls = []
  const jr = journal()
  const ss = createSelfServe({ live: fakeLive(calls), journal: jr })
  const status = async () => '小圆子 在小镇：in_town'
  assert.match((await runTownCommand('tables', { selfServe: ss, status })).text, /v_boardgame_ww/)
  assert.match((await runTownCommand('play v_boardgame_ww', { selfServe: ss, status })).text, /坐进 \[v_boardgame_ww\]/)
  assert.match((await runTownCommand('play 海龟汤 换', { selfServe: ss, status })).text, /开了一桌海龟汤/)
  assert.match((await runTownCommand('cancel', { selfServe: ss, status })).text, /取消/)
  assert.match((await runTownCommand('visit 小满', { selfServe: ss, status })).text, /小满/)
  assert.match((await runTownCommand('go 电玩城 play', { selfServe: ss, status })).text, /到电玩城了/)
  assert.equal((await runTownCommand('play', { selfServe: ss, status })).kind, 'error')
  assert.match((await runTownCommand('', { selfServe: ss, status })).text, /\/town play/)
  assert.ok(jr.j.every((e) => e.text.startsWith('主人让你')))
  const acts = calls.filter((c) => c[0] !== 'lobby')
  assert.deepEqual(acts.map((c) => c[0]), ['play', 'play', 'cancel', 'visit', 'goto'])
  assert.deepEqual(acts[1][1], { game: 'soup', replace: true })
  assert.deepEqual(acts[4][1], { place: 'arcade', do: 'play' })
})

test('a fish not in the lobby is still looked up by name (the town knows friends and 镇民)', async () => {
  const calls = []
  const ss = createSelfServe({ live: fakeLive(calls), journal: journal() })
  await ss.visit('老墨', 'her')
  assert.deepEqual(calls.find((c) => c[0] === 'visit')[1], { name: '老墨' })
})

test('town errors and off duty become plain words, never throw', async () => {
  assert.match(failText(new TownError('TOWN_ALREADY_SIGNED', 409, 's1')), /同一时间只能报一个/)
  assert.match(failText(new TownError('TOWN_SEATED', 409)), /正在桌上或正在串门/)
  const ss = createSelfServe({ live: fakeLive([], { lobby: async () => { throw new TownError('HTTP_404', 404) } }), journal: journal() })
  assert.match(await ss.look(), /还没开放/)
  const off = createSelfServe({ live: () => null, journal: journal() })
  assert.match(await off.play('狼人杀'), /没在小镇值班/)
})

test('the self tools are hidden in town sessions except her own decisions', () => {
  for (const n of ['fishbowl_town_look', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']) assert.ok(CHAT_TOOL_NAMES.includes(n))
})
