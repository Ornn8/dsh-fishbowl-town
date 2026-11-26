// 0.9.17：远的店照样写，小镇带她走过去、到了照办（小镇 auto-transit 11-24：远处下单回 ok:true、code queued，到了的结果走下一回合的「变了」）；
// 岛上碰面聊天里她写的表白 act {"kind":"heart"}（小镇 11-26）原样带回小镇。和 AstrBot tests/test_transit_heart_0413.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnPrompt, toAnswer, holdCheck } from '../lib/prompt.js'
import { createIsleTools } from '../lib/isle-tools.js'

test('execute turns: a far shop is written as usual, the town walks her there (no 「还没走到」 means none)', () => {
  const turn = { kind: 'agency', packet: { actions: ['none'], messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '情况' }], reply: { format: 'json' } } }
  const text = buildTurnPrompt(turn, { role: 'execute', wish: '去面包房买可颂', wishOwn: true })
  assert.match(text, /现在真办不了（关门、没这个、去不了），action 填 none.*远的店照样写，小镇会带你走过去，到了照办。/)
  assert.doesNotMatch(text, /还没走到/)
})

test('island chats: act {"kind":"heart"} goes back to the town unchanged, with holds on or off', () => {
  const turn = { kind: 'visit', packet: { reply: { format: 'json', max_chars: 300 }, messages: [] } }
  const ans = toAnswer(turn, '{"say":"其实……我挺喜欢你的","act":{"kind":"heart","to":"小满"}}')
  assert.deepEqual(JSON.parse(ans), { say: '其实……我挺喜欢你的', act: { kind: 'heart', to: '小满' } })
  const h = holdCheck('visit', ans, ['spend', 'promise'])
  assert.deepEqual(h.found, [])
  assert.equal(h.clean, ans)
})

test('chat act: a far-shop order comes back queued (ok:true): she is on her way, not done', async () => {
  const said = '出发去「麦香面包房」，1000 米，13.9 分钟到。到了替你办「可颂」，4 鲸币到了才付，办好了下一回合告诉你'
  const client = { async isleAct() { return { ok: true, do: 'treat_self', code: 'queued', text: said } } }
  const j = []
  const [, act] = createIsleTools({ live: () => ({ client }), journal: { event: (kind, text) => j.push(text) }, pictures: null, log: { info() {} } })
  const out = await act.execute({ world: { do: 'treat_self', svc: 'food', item: '可颂' } }, {})
  assert.ok(out.startsWith(`岛上回你的：「${said}」\n还没办完：出发了，到了照办，办好了小镇下一回合告诉你。（这是岛上刚回你的原话`), out)
  assert.doesNotMatch(out, /\n办成了/)
  assert.match(j[0], /^你在聊天里在岛上去小店吃喝：出发去「麦香面包房」/)
})
