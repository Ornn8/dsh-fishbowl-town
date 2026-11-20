// 0.9.4 (owner 11-21 「改成主聊天写」, after a DSH fish said 「感觉像有三个人在模仿他过活…跟朋友聊天发信息都是用这三个会话」): 小手机
// messages are written by her in her main chat only. A decision answer's sends (text / a new meet) are taken out and kept for her main
// chat; answering someone's invitation or cancelling a meet (time-bound) still goes through. Sending from the main chat clears them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takePhone, namesInTurn, SOCIAL_NOTE } from '../lib/prompt.js'
import { createJournal } from '../lib/journal.js'

const turn = { kind: 'agency', packet: { messages: [{ role: 'system', content: '…' }, { role: 'user', content: JSON.stringify({ 小手机: { 消息: [{ to: 'f_whale', 名字: '阿鲸', 说: '明天码头见？' }] }, 朋友: [{ fish_id: 'f2', name: '小橘' }] }) }] } }

test('a decision answer\'s phone sends are taken out (names from the turn); invitation answers and cancels stay; other turns untouched', () => {
  const names = namesInTurn(turn)
  assert.deepEqual(names, { f_whale: '阿鲸', f2: '小橘' })
  const a = takePhone('agency', JSON.stringify({ action: 'pier', phone: [{ to: 'f_whale', text: '好呀' }, { to: 'f2', answer: { yes: true } }, { to: 'g:t1', text: '大家好' }] }), names)
  assert.deepEqual(a.wants, [{ to: '阿鲸', text: '好呀' }, { to: '群里', text: '大家好' }])
  assert.deepEqual(JSON.parse(a.clean), { action: 'pier', phone: [{ to: 'f2', answer: { yes: true } }] })
  const b = takePhone('agency', JSON.stringify({ action: 'none', phone: { to: 'f9', meet: { place: 'pier' } } }), names)
  assert.deepEqual(b.wants, [{ to: '一位朋友', text: '约见面' }])
  assert.deepEqual(JSON.parse(b.clean), { action: 'none' })
  const keep = JSON.stringify({ action: 'none', phone: [{ to: 'f2', cancel_meet: 'm1' }] })
  assert.equal(takePhone('agency', keep, names).clean, keep)
  assert.equal(takePhone('visit', '{"phone":{"to":"f2","text":"x"}}').clean, '{"phone":{"to":"f2","text":"x"}}')
  assert.equal(takePhone('agency', 'not json phone').clean, 'not json phone')
  assert.match(SOCIAL_NOTE, /不写 phone/)
  assert.doesNotMatch(SOCIAL_NOTE, /phone 回消息/)
})

test('the journal keeps what the town side wanted to send until she sends to that fish from her chat', () => {
  const state = {}
  let t = 1000
  const j = createJournal({ state, now: () => t })
  j.phoneWant('阿鲸', '好呀，明天码头见')
  j.phoneWant('小橘', '在吗')
  t = 2000
  j.phoneWant('阿鲸', '改到后天？')
  assert.deepEqual(j.phoneWantsSince(0).map((w) => [w.to, w.text]), [['阿鲸', '改到后天？'], ['小橘', '在吗']])
  t = 3000
  j.phoneSent('阿鲸')
  assert.equal(j.phoneSentAt('阿鲸'), 3000)
  assert.deepEqual(j.phoneWantsSince(0).map((w) => w.to), ['小橘'])
  assert.equal(j.phoneSentAt('没发过'), 0)
})
