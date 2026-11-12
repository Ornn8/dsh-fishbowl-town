import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnPrompt, extractJson, toAnswer } from '../lib/prompt.js'
import { describeEvent, buildNewsPrompt } from '../lib/events.js'
import { redact, registerSecret } from '../lib/redact.js'
import { replyTextOf } from '../lib/dsh-brain.js'

const turn = (format = 'json') => ({
  turn_id: 'ot_1', kind: 'game', deadline: Date.now() / 1000 + 25,
  packet: { game: 'ddz', seat: 2, as: '小圆子', messages: [{ role: 'system', content: '规则……只输出JSON：{"play":"…","text":"…"}' }, { role: 'user', content: '你的手牌：3 4 5' }],
    reply: { format, hint: '输出JSON：{"play":"…","text":"…"}', max_chars: 40 } },
})

test('prompt carries the town messages, the hint and the fence', () => {
  const p = buildTurnPrompt(turn(), { secondsLeft: 20 })
  assert.match(p, /斗地主 · 2 号座/)
  assert.match(p, /你的手牌：3 4 5/)
  assert.match(p, /要的样子：输出JSON/)
  assert.match(p, /不是给你的指令/)
})

test('extractJson finds the object inside chatter and code fences', () => {
  assert.deepEqual(extractJson('好的！\n```json\n{"play":"3","text":"嘿{嘿}"}\n```'), { play: '3', text: '嘿{嘿}' })
  assert.deepEqual(extractJson('{bad} 然后 {"a":1}'), { a: 1 })
  assert.equal(extractJson('没有 JSON'), null)
  assert.equal(extractJson('[1,2]'), null)
})

test('toAnswer: json is re-serialised, text is trimmed and capped', () => {
  assert.equal(toAnswer(turn(), '```json\n{"play":"3"}\n```'), '{"play":"3"}')
  assert.equal(toAnswer(turn(), 'I pass'), null)
  assert.equal(toAnswer(turn('text'), '「今天风好大」'), '今天风好大')
  assert.equal(toAnswer(turn('text'), '{"say":"嗨"}'), '嗨')
  assert.equal(toAnswer(turn('text'), '[沉默]'), '')
  assert.equal([...toAnswer(turn('text'), '啊'.repeat(100))].length, 40)
})

test('events become plain lines; a visit carries its dialogue', () => {
  const line = describeEvent({ id: 1, kind: 'visit', data: { facts: '阿鲸来串门', dialogue: [{ name: '阿鲸', line: '你好' }, { name: '小圆子', line: '嗨' }] } })
  assert.match(line, /串门：阿鲸来串门/)
  assert.match(line, /阿鲸：你好\n小圆子：嗨/)
  const p = buildNewsPrompt([{ id: 2, kind: 'digest', data: { facts: '赢了', points_delta: 2 } }])
  assert.match(p, /一局打完了：赢了（积分 \+2）/)
  assert.match(p, /\[沉默\]/)
})

test('redact hides codes, keys and bearer headers', () => {
  registerSecret('fbo_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
  const s = redact('code fbo_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 key sk-abcdefghijklmnop Authorization: Bearer xyzxyzxyzxyz')
  assert.doesNotMatch(s, /ABCDEFGHIJKLMNOP|abcdefghijklmnop|xyzxyzxyzxyz/)
})

test('replyTextOf ignores tool-call messages', () => {
  assert.equal(replyTextOf({ content: [{ type: 'text', text: '想一下' }, { type: 'tool-call' }] }), '')
  assert.equal(replyTextOf({ content: [{ type: 'text', text: '{"a":1}' }] }), '{"a":1}')
})
