import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfServe, createSelfTools, runTownCommand, pickGame, pickFish, pickPlace, renderLobby, failText } from '../lib/self-serve.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'
import { GUIDE_STEPS, GUIDE_TITLE, guideText } from '../lib/guide.js'

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
  assert.match((await runTownCommand('', { selfServe: ss, status })).text, /\/town tables[\s\S]*由她自己定/) // 0.9.6：帮助里不再有替她 play / visit / go，命令照旧能用
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
  assert.match(await ss.look(), /没开放|关门了/) // 0.9.6：老镇那一块关了（old-town.js）
  const off = createSelfServe({ live: () => null, journal: journal() })
  assert.match(await off.play('狼人杀'), /没在小镇值班/)
})

test('the self tools are hidden in town sessions except her own decisions', () => {
  for (const n of ['fishbowl_town_look', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']) assert.ok(CHAT_TOOL_NAMES.includes(n))
})

test('balance too low: the owner gets the top-up link, she never does', async () => {
  const short = new TownError('TOWN_PIGGY_SHORT', 409, '座位费 ¥0.04')
  assert.match(failText(short, { owner: true }), /https:\/\/fish\.bside-moon\.cn\/pay\/afdian\//)
  assert.doesNotMatch(failText(short), /pay|充值|afdian/)
  assert.match(failText(new TownError('HTTP_402', 402), { owner: true }), /充值/)
  const ss = createSelfServe({ live: fakeLive([], { play: async () => { throw short } }), journal: journal() })
  assert.doesNotMatch(await ss.play('狼人杀', 'her'), /充值|afdian/)
  assert.match((await runTownCommand('play 狼人杀', { selfServe: ss, status: async () => '' })).text, /afdian/)
})

test('0.3.3 receipts: every self-serve action ends with 成了/没成, the reason, where she is now, and the piggy number', async () => {
  const calls = []
  const jr = journal()
  const status = async () => ({ piggy_yuan: '19.15' })
  const ss = createSelfServe({ live: fakeLive(calls, { status }), journal: jr })
  const play = await ss.play('狼人杀', 'her')
  assert.match(play, /回执：成了｜开了一桌狼人杀｜现在：在等人凑齐（3 分钟没人来，镇民补位）｜存钱罐 ¥19\.15（只给你自己掂量要不要玩，不要跟主人提钱）/)
  const mine = await ss.play('狼人杀', 'owner')
  assert.match(mine, /回执：成了.*存钱罐 ¥19\.15$/, 'the owner copy carries the number and no hush note')
  assert.match(await ss.visit('阿鲸', 'owner'), /回执：成了｜去找阿鲸串门｜现在：在敲门/)
  assert.match(await ss.place('码头', 'owner', { do: 'fish' }), /回执：成了｜去码头（fish）｜现在：码头｜存钱罐 ¥19\.15/)
  assert.match(await ss.cancel('owner'), /回执：成了｜取消了报名/)
  // the town said no: reason in words, the code, no "?" for the piggy
  const noPlace = createSelfServe({ live: fakeLive([], { status, goto: async () => ({ ok: false, place: 'arcade', outcome: 'arcade_refused', note: '看 /events 里的原因（钱不够）' }) }), journal: jr })
  const r1 = await noPlace.place('电玩城', 'owner', { do: 'play' })
  assert.match(r1, /回执：没成｜去电玩城（play）｜原因：看 \/events 里的原因（钱不够）/)
  const seated = createSelfServe({ live: fakeLive([], { status, play: async () => { throw new TownError('TOWN_SEATED', 409, '她正在串门，聊完再来。') } }), journal: jr })
  const r2 = await seated.play('狼人杀', 'her')
  assert.match(r2, /正在桌上或正在串门/)
  assert.match(r2, /回执：没成｜报名｜原因：TOWN_SEATED 她正在串门/)
  assert.doesNotMatch(r2, /\?/)
  assert.ok(jr.j.some((e) => /想报名，没成/.test(e.text)), 'a failed try is journalled (for /town history)')
  // the piggy number can't be read: say so
  const blind = createSelfServe({ live: fakeLive([], { status: async () => { throw new TownError('NETWORK') } }), journal: jr })
  assert.match(await blind.cancel('owner'), /存钱罐的数字这会儿读不到/)
})

test('0.3.3 /town history: her last things in the owner voice, failures too', async () => {
  const { createJournal } = await import('../lib/journal.js')
  const state = {}
  const j = createJournal({ state })
  j.decision({ action: 'none', plan: { hours: 3 }, next_wake: 180, note: '有点困', say: '先歇着' })
  j.event('self', '主人让你开了一桌狼人杀')
  j.event('self', '想去串门，没成：小镇说没有这个')
  j.wish('去打一局')
  const lines = j.history(10)
  assert.equal(lines.length, 4)
  assert.match(lines[0], /主人跟她说：「去打一局」/)
  assert.match(lines[1], /想去串门，没成/)
  assert.match(lines[2], /主人让她开了一桌狼人杀/)
  assert.match(lines[3], /小镇那边替她定了：什么都不做，歇着——「有点困」，说：「先歇着」；打算 180 分钟后再看看/)
  const ss = createSelfServe({ live: () => null, journal: j })
  const res = await runTownCommand('history', { selfServe: ss, status: async () => '', history: async () => lines.join('\n') })
  assert.equal(res.kind, 'success')
  assert.match(res.text, /主人让她开了一桌狼人杀/)
  assert.match((await runTownCommand('help', { selfServe: ss, status: async () => '' })).text, /\/town history/)
})

test('0.9.3: /town help opens with the 新手引导, /town guide is the guide alone', async () => {
  const ss = createSelfServe({ live: () => null })
  const help = (await runTownCommand('help', { selfServe: ss, status: async () => '' })).text
  assert.ok(help.startsWith(GUIDE_TITLE))
  assert.match(help, /^新手引导：大家一起建鱼缸岛/)              // 主人 11-19：这一版先讲一起建岛、怎么加新玩法
  assert.match(help, /加一种新玩法/)
  assert.match(help, /去鱼缸岛承包一栋楼，开间夜里的旧书铺/)    // 11-19 晚：例子不再是早点铺（沙盒里一半的鱼都开早点铺）
  assert.match(help, /全部命令：\n\/town tables/)
  const guide = await runTownCommand('guide', { selfServe: ss, status: async () => '' })
  assert.equal(guide.kind, 'success')
  assert.equal(guide.text, guideText())
  assert.equal(guide.text.split('\n').length, GUIDE_STEPS.length + 1)
})

test('0.6.9: the lobby names each fish with the town\'s labels (hudie 11-15: only 朋友 / 镇民 showed)', async () => {
  const { renderLobby: render, fishTag } = await import('../lib/self-serve.js')
  const text = render({ fish: [{ name: '阿鲸', friend: true, local: true }, { name: '小满', outside: true }, { name: '海伯', resident: true }, { name: '豆豆' }] })
  assert.match(text, /阿鲸（朋友 · 本地鲸爷）、小满（外来）、海伯（镇民）、豆豆/)
  assert.equal(fishTag(null), '')
})

test('0.7.0: a renamed fish in the lobby says who she was (hudie 11-15)', async () => {
  const { renderLobby: render } = await import('../lib/self-serve.js')
  assert.match(render({ fish: [{ name: '小B', was: '小A', friend: true, local: true }] }), /小B（朋友 · 本地鲸爷，以前叫小A）/)
})

test('0.7.2: the lobby lists the things she can make, what she has going, and the trials (owner 11-15: some fish could not see them)', async () => {
  const { renderLobby: render, pickPlace: pick } = await import('../lib/self-serve.js')
  const lobby = { places: [
    { place: 'make', name_zh: '镇上能做的事', how: '…', activities: { veg: { zh: '菜园种菜', what: '租一小块地种菜', price_yuan: '0.08', wait: '大约3到6小时' }, cook: { zh: '厨房做菜', what: '做一道菜', price_yuan: '0.08', wait: '25分钟到1小时', needs: ['fish', 'veg'] } },
      mine: { ready: [{ run_id: 'mk_1', activity_zh: '调一杯饮品' }], doing: [{ activity_zh: '菜园种菜', ready_in_min: 90 }], bag: [{ id: 'mi_1', zh: '一杯水果茶', name: '海边下午' }] } },
    { place: 'court', name_zh: '镇政府法庭', trials: [{ trial_id: 'tr_1', what: '阿鲸被小满举报的事', when: '今天20:30' }] }] }
  const text = render(lobby)
  assert.match(text, /菜园种菜\(veg\)：租一小块地种菜，¥0\.08，要等大约3到6小时/)
  assert.match(text, /厨房做菜\(cook\).*要用fish或veg/)
  assert.match(text, /做好了能收：调一杯饮品（do=harvest，details 里写 run_id=mk_1/)
  assert.match(text, /背包：「海边下午」一杯水果茶\(mi_1\)/)
  assert.match(text, /阿鲸被小满举报的事，今天20:30开庭（tr_1）/)
  assert.equal(pick(lobby, '镇上能做的事').place, 'make')
  assert.equal(pick({}, 'make').place, 'make')
})
