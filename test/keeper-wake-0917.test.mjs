// 0.9.17 守店来客叫得醒插件（keeper-survival 11-24：线上 20 家守店店约 430 件客人全作废——她说要歇着时插件替她答了「先不动」，
// MUST_ANSWER、URGENT 里都没有 guest / door；她有自己的打算时 execute 又排在 URGENT 前面）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSchedule } from '../lib/schedule.js'
import { createChatDecide, decidedLine, PLAN_MARK } from '../lib/chat-decide.js'
import { createJournal } from '../lib/journal.js'
import { buildTurnPrompt } from '../lib/prompt.js'

const log = { info() {}, warn() {}, debug() {}, error() {} }
const agencyTurn = (id, reasons) => ({ turn_id: id, kind: 'agency', deadline: Date.now() / 1000 + 25,
  packet: { purpose: 'agency', reasons, messages: [{ role: 'system', content: '拿主意的规则' }, { role: 'user', content: '【等你回】客人 #12 押了 6 鲸币想买海菜饭团' }],
    reply: { format: 'json', hint: '{"action":"none"}', max_chars: 400 } } })

function world() {
  const state = {}
  const journal = createJournal({ state })
  const brain = { async ask() { return `嗯\n${PLAN_MARK}去码头` } }
  const chatLink = { mainChat: () => ({ sid: 'main-1', how: 'bound' }), ownerIdleMs: () => 600_000, ownerLife: () => [] }
  return { journal, decide: createChatDecide({ brain, chatLink, journal, log, config: {}, state }) }
}

test('a guest or a door game wakes her while she rests; the owner quiet hours and minimum gap still count', () => {
  const now = new Date(2026, 10, 24, 12, 0).getTime()
  const resting = { wake: { at: now + 3 * 3600_000, minutes: 180, doing: '睡觉', lastAsk: now - 60_000 } }
  const sch = createSchedule({ state: resting, getConfig: () => ({}), now: () => now })
  const turn = (reasons) => ({ packet: { reasons } })
  assert.ok(sch.skip(turn(['table']), {}), 'an ordinary reason still lets her rest')
  assert.equal(sch.skip(turn(['guest']), {}), null, 'a guest is waiting with a deposit: her model is called')
  assert.equal(sch.skip(turn(['door', 'idle']), {}), null, 'her turn in a door game: her model is called')
  const gap = createSchedule({ state: { wake: { lastAsk: now - 60_000 } }, getConfig: () => ({ wakeMinMinutes: 30 }), now: () => now })
  assert.match(gap.skip(turn(['guest']), {}).why, /最短间隔/, 'the owner minimum gap is his floor')
  const quiet = createSchedule({ state: { wake: {} }, getConfig: () => ({ quietHours: '11:00-13:00' }), now: () => now })
  assert.match(quiet.skip(turn(['guest']), {}).why, /勿扰/, 'the owner quiet hours are his floor')
})

test('a guest or a door game is answered by her rules before her own plan; the plan stays for the next turn', () => {
  const w = world()
  w.journal.wish('去码头泡一会儿', { own: true })
  assert.deepEqual(w.decide.route(agencyTurn('g1', ['guest'])), { role: 'rules' })
  assert.deepEqual(w.decide.route(agencyTurn('g2', ['door', 'wake'])), { role: 'rules' })
  assert.equal(w.journal.pendingWish(), '去码头泡一会儿')
  assert.deepEqual(w.decide.route(agencyTurn('g3', ['wake'])), { role: 'execute' })
  const plain = world()
  assert.deepEqual(plain.decide.route(agencyTurn('g4', ['guest', 'table'])), { role: 'rules' })
})

test('the rules prompt names guests and door games and says to copy the line the town gave into "world"', () => {
  const p = buildTurnPrompt(agencyTurn('p1', ['guest']), { secondsLeft: 60, role: 'rules' })
  assert.match(p, /有件事要马上回/)
  assert.match(p, /客人上门、门后的比赛轮到你、别的鱼邀请你/)
  assert.match(p, /客人上门、门后的比赛轮到你、店里问你的问题：照小镇在「等你回」里给的那一句写进 "world"（照抄，只改数目和你要说的话），action 填 none。/)
})

test('after the rules role served a guest, her chat self reads that she served him, not 「先不动」 (real DSH keeper run 11-24)', () => {
  const reply = { action: 'none', world: { do: 'reply', event: 1, actions: [{ op: 'take', thing: 'coin', n: 10 }, { op: 'say', text: '小柒来啦，茶刚沏好。' }] },
    plan: { hours: 1, doing: '守着茶摊' } }
  assert.equal(decidedLine('rules', reply), '有件事要马上回，小镇那边按你定的规矩先答了：接待了客人（说「小柒来啦，茶刚沏好。」），打算「守着茶摊」')
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'door_step', run: 'r1', choice: 'a' } }), '有件事要马上回，小镇那边按你定的规矩先答了：在门后的比赛里走了一步')
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'reply', event: 2, actions: [{ op: 'say', text: '…' }] } }), '有件事要马上回，小镇那边按你定的规矩先答了：接待了客人')
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'go', place: '码头' } }), '有件事要马上回，小镇那边按你定的规矩先答了：先不动', 'other world steps: as before')
})

test('a keeper who wrote action "world" and put her words in result.say still reads that she served him (live keeper replies 11-24)', () => {
  const head = '有件事要马上回，小镇那边按你定的规矩先答了：'
  assert.equal(decidedLine('rules', { action: 'world', world: { do: 'reply', event: 499, actions: [{ kind: 'sell', good: 'candle', n: 1, price: 6 }], result: { say: '一支香薰蜡烛，六鲸币…' } } }),
    head + '接待了客人（说「一支香薰蜡烛，六鲸币…」）')
  assert.equal(decidedLine('rules', { action: 'world', world: { do: 'reply', event: 7, actions: [{ do: 'serve', good: '蛋炒饭', n: 1 }], result: { text: '蛋炒饭好啦' } } }),
    head + '接待了客人（说「蛋炒饭好啦」）', 'result.text too')
  assert.equal(decidedLine('rules', { action: 'world', world: { do: 'reply', event: 8, actions: [{ op: 'say', text: '麦冬，面来了' }], result: { say: '别的话' } } }),
    head + '接待了客人（说「麦冬，面来了」）', 'op:say wins over result')
  assert.equal(decidedLine('rules', { action: 'world', world: { do: 'reply', event: 9, actions: [], result: { say: '…' } } }), head + '接待了客人')
  assert.equal(decidedLine('rules', { action: 'world', world: { do: 'door_step', run: 'r1', choice: 'a' } }), head + '在门后的比赛里走了一步')
  assert.equal(decidedLine('rules', { action: 'visit', target: '小柒', world: { do: 'reply', event: 9, result: { say: '来了' } } }), head + '去找小柒串门', 'a real action keeps its own words')
})

test('0.9.19 (town 11-26 #33): a reply with q answers a shop\'s question to her: her chat self reads that, not 「接待了客人」', () => {
  const head = '有件事要马上回，小镇那边按你定的规矩先答了：'
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'reply', q: 'q_69e9e77d91', value: { go: true } } }), head + '回了店里问你的问题')
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'replies', replies: [{ q: 'q_69e9e77d91', value: { go: true } }] } }), head + '回了店里问你的问题')
  assert.equal(decidedLine('rules', { action: 'none', world: { do: 'reply', event: 3, q: 'x', actions: [{ op: 'say', text: '来啦' }] } }), head + '接待了客人（说「来啦」）', 'event wins: a keeper reply')
})
