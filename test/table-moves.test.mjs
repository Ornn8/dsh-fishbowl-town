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
    assert.match(report, /你是农民，赢了，得分\+2（这局小镇会话替你出了 2 手，另有 1 手没在时限内答上、是小镇按默认走的）/)
    assert.match(report, /那一局小镇会话替你出的手：A「压一张A，小意思~」、过「先过」；另有 1 手超时，小镇代打/)
  } finally {
    await runner.stop()
  }
})
