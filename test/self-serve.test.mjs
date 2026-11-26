// 主人的 /town 命令和小镇回错时的那句话（self-serve.js）。0.9.17 老镇停了：她的「看看小镇」「去玩一局」「去串门」「去个地方」和 /town tables 删了，
// 那些用例跟着删（老镇的大厅、开桌、串门、码头、电玩城的回执）；/town play | cancel | visit | go 照旧不替她办。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTownCommand, failText, OWNER_DECIDES, OLD_TABLES, COMMAND_HELP } from '../lib/self-serve.js'
import * as SS from '../lib/self-serve.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'
import { GUIDE_STEPS, GUIDE_TITLE, guideText } from '../lib/guide.js'

test('owner commands: /town tables says the old town has no tables now; play | cancel | visit | go never move her (0.9.6 「主人不能操控自己鱼」)', async () => {
  const calls = []
  const status = async () => { calls.push('status'); return '小圆子 在鱼缸岛上' }
  for (const c of ['tables', 'table', 'lobby', '桌子', '大厅']) {
    const r = await runTownCommand(c, { status })
    assert.equal(r.kind, 'success', c)
    assert.equal(r.text, OLD_TABLES, c)
  }
  assert.match(OLD_TABLES, /^老镇（鱼缸小镇）不再开了，大家都在鱼缸岛上。/) // 0.9.19：老镇已经关了
  assert.doesNotMatch(OLD_TABLES, /¥|饭票|鲸币/)
  for (const c of ['play v_boardgame_ww', 'play 海龟汤 换', 'play', 'cancel', 'visit 小满', 'visit', 'go 电玩城 play', '去 码头', '串门 小满', '取消']) {
    const r = await runTownCommand(c, { status })
    assert.equal(r.kind, 'success', c)
    assert.equal(r.text, OWNER_DECIDES, c)
  }
  assert.match(OWNER_DECIDES, /由她自己定.*聊天里跟她说/)
  assert.match((await runTownCommand('', { status })).text, /由她自己定/)
  assert.doesNotMatch(COMMAND_HELP, /\/town tables|老镇/)
  assert.deepEqual(calls, []) // 一样都没替她办，也没去问小镇
})

test('0.9.17: the old-town tools are gone (look / play / visit / place)', () => {
  for (const n of ['fishbowl_town_look', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']) assert.ok(!CHAT_TOOL_NAMES.includes(n), n)
  for (const k of ['createSelfServe', 'createSelfTools', 'SELF_TOOL_NAMES', 'renderLobby', 'pickGame', 'pickFish', 'pickPlace']) assert.equal(SS[k], undefined, k)
})

test('town errors become plain words, never throw', () => {
  assert.match(failText(new TownError('TOWN_ALREADY_SIGNED', 409, 's1')), /同一时间只能报一个/)
  assert.match(failText(new TownError('TOWN_SEATED', 409)), /正在桌上或正在串门/)
  assert.match(failText(new TownError('NETWORK')), /还没连上小镇/)
})

test('balance too low: the owner gets the top-up link, she never does', () => {
  const short = new TownError('TOWN_PIGGY_SHORT', 409, '座位费 ¥0.04')
  assert.match(failText(short, { owner: true }), /https:\/\/fish\.bside-moon\.cn\/pay\/afdian\//)
  assert.doesNotMatch(failText(short), /pay|充值|afdian/)
  assert.match(failText(new TownError('HTTP_402', 402), { owner: true }), /充值/)
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
  const res = await runTownCommand('history', { status: async () => '', history: async () => lines.join('\n') })
  assert.equal(res.kind, 'success')
  assert.match(res.text, /主人让她开了一桌狼人杀/)
  assert.match((await runTownCommand('help', { status: async () => '' })).text, /\/town history/)
})

test('0.9.3: /town help opens with the 新手引导, /town guide is the guide alone', async () => {
  const help = (await runTownCommand('help', { status: async () => '' })).text
  assert.ok(help.startsWith(GUIDE_TITLE))
  assert.match(help, /^新手引导：大家一起建鱼缸岛/)              // 主人 11-19：这一版先讲一起建岛、怎么加新玩法
  assert.match(help, /加一种新玩法/)
  assert.match(help, /去鱼缸岛承包一栋楼，开间夜里的旧书铺/)    // 11-19 晚：例子不再是早点铺（沙盒里一半的鱼都开早点铺）
  assert.match(help, /全部命令：\n\/town today/) // 0.9.17：/town tables 删了
  const guide = await runTownCommand('guide', { status: async () => '' })
  assert.equal(guide.kind, 'success')
  assert.equal(guide.text, guideText())
  assert.equal(guide.text.split('\n').length, GUIDE_STEPS.length + 1)
})
