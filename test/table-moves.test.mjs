// 0.7.11：一局里小镇会话替她出的每一手、超时了几手，那局打完时交给主会话里的她（11-16 那条鱼说「我从头到尾没被叫出过一次牌」）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJournal, playOf } from '../lib/journal.js'
import { createRunner } from '../lib/runner.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const options = '你是小雫，本局农民。\n引擎排好的选项（A最推荐）：\nA. A — 最小的压法，压完约剩4手\nB. 过 — 压了要拆牌'
const turn = (id) => ({ turn_id: id, kind: 'game', deadline: Date.now() / 1000 + 25,
  packet: { ref: 'g_1', game: 'ddz', purpose: 'play', seat: 2, as: '小雫', messages: [{ role: 'system', content: '只输出JSON' }, { role: 'user', content: options }],
    reply: { format: 'json', hint: '{"pick":"A","say":"…"}', max_chars: 140 } } })

test('playOf reads the option she picked, or the cards she wrote', () => {
  const t = turn('x')
  assert.equal(playOf(t, '{"pick":"A","say":"压"}'), 'A')
  assert.equal(playOf(t, { pick: 'b' }), '过')
  assert.equal(playOf(t, '{"pick":"A","cards":"334455"}'), '334455')
  assert.equal(playOf(t, '{"pick":"Z"}'), '选了Z')
  assert.equal(playOf(t, 'not json'), '')
})

test('a game she half played: her moves and the town\'s timeouts reach her chat with the result', { timeout: 30_000 }, async () => {
  const state = {}
  const journal = createJournal({ state })
  let polled = 0
  const posted = []
  const client = {
    async turns(_wait, signal) {
      polled++
      if (polled === 1) return { turns: [turn('ot_1'), turn('ot_2')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() {
      return { next: 3, items: [
        { id: 1, kind: 'outside_turn', ts: Date.now() / 1000, data: { what: 'timeout', ref: 'g_1', purpose: 'play', facts: '25秒内没有回答，这一步用了默认动作。' } },
        { id: 2, kind: 'digest', ts: Date.now() / 1000, data: { game: 'ddz', game_name: '斗地主', game_id: 'g_1', result: 'win', role: '农民', facts: '斗地主：你是农民，赢了，得分+2。' } },
      ] }
    },
  }
  const says = ['压一张A，小意思~', '先过']
  const brain = { async ask() { return JSON.stringify({ pick: says.length === 2 ? 'A' : 'B', say: says.shift() }) } }
  const runner = createRunner({ client, brain, log, journal, config: { eventsEveryMs: 60_000 } })
  runner.start()
  try {
    for (let i = 0; i < 50 && posted.length < 2; i++) await sleep(100)
    assert.equal(posted.length, 2)
    await sleep(3500) // 事件循环先等 3 秒
    const report = journal.report()
    assert.match(report, /你是农民，赢了，得分\+2（这局小镇会话替你出了 2 手，另有 1 手没答上，那几手是小镇按默认走的）/)
    assert.match(report, /那一局小镇会话替你出的手：A「压一张A，小意思~」、过「先过」；另有 1 手没答上，小镇代打/)
    assert.match(report, /最近几局（小镇会话替你出的每一手）：\n- .*斗地主（你是农民，赢了，得分\+2）：你出的手 A「压一张A，小意思~」、过「先过」；1 手没答上/)
  } finally {
    await runner.stop()
  }
})

// 0.7.14（同一条鱼：「被跳过的那几轮，她那边看不见」「我第一手打的什么，事后翻不到」）
test('missed rounds are kept with their cause: a visit transcript shows them in place, a game keeps every move to look back at', async () => {
  const { renderChat } = await import('../lib/extras.js')
  const state = {}
  const journal = createJournal({ state })
  journal.lost('vs_1', 'model', { at: 130, kind: 'visit' })
  journal.lost('vs_1', 'queue', { at: 170, kind: 'visit' })
  const r = journal.round('vs_1')
  assert.equal(r.missed, '2 轮没答上（排队等太久 1 轮、模型没在时限内答完 1 轮）')
  const one = { visit: { role: 'guest', with: { name: '阿鲸' }, started: 1794800000, lines: 3 },
    dialogue: [{ name: '阿鲸', text: '来啦', ts: 100 }, { name: '你', text: '嗯', ts: 120 }, { name: '阿鲸', text: '喝点啥', ts: 160 }] }
  const text = renderChat(one, { name: '你', missed: r })
  assert.match(text, /你：嗯\n（这一轮没答上，小镇按默认走了）\n阿鲸：喝点啥\n（这一轮没答上，小镇按默认走了）/)
  assert.match(text, /这一场有 2 轮没答上.*不是你不想说/)
  // a decision turn that was not answered is a line in her notebook
  journal.lost(null, 'model', { kind: 'agency' })
  assert.match(journal.report(), /小镇叫你拿主意的那一次没答上（模型没在时限内答完），小镇当你先不动/)
  // a game: every move stays in 「小镇近况」, the long moves line is not cut at 160
  for (let i = 0; i < 13; i++) journal.move('g_9', `牌${i}`, `第${i}手说的话`)
  journal.miss('g_9')
  journal.settle('g_9', { kind: 'game', title: '斗地主', result: '你是农民，赢了' })
  const t = journal.table('g_9')
  journal.event('table', t.moves, 300)
  const report = journal.report()
  assert.match(report, /最近几局（小镇会话替你出的每一手）：\n- .*斗地主（你是农民，赢了）：你出的手 牌0「第0手说的话」.*牌12「第12手说的话」；1 手没答上/)
  assert.ok(state.journal.find((e) => e.ev === 'table').text.length > 160)
})
