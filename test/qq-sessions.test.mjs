// 0.7.4（主人反馈：一台 DSH 同时开 Web 和 QQ，「她的家」只能绑一个会话，QQ 那边看不到小镇近况）：
// 主人可以再接几个会话（alsoSessionIds）；QQ 插件转进来的话各打各的标记（'user' 无 rpcId、'qq'、'plugin'、'plugin:…'）；
// 绑定的会话里都算主人的话，没绑定的会话不算，自动认主会话只数在 DSH 里亲手打的（不认到热闹的 QQ 群）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatLink, forwardedChat, typedInDsh } from '../lib/chat-link.js'
import { createTownContext, CONTEXT_KIND } from '../lib/town-context.js'
import { alsoList, fishEntries } from '../lib/index.js'

const msg = (text, source) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source } })
const her = (text) => ({ type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text }] } })
const WEB = (i = 1) => ({ kind: 'user', rpcId: 'r' + i })

function link(config = {}) {
  let t = Date.UTC(2026, 10, 15, 8, 0)
  const state = {}
  const cl = createChatLink({ state, config: { reportSessionId: '', alsoSessionIds: [], ...config }, now: () => t })
  const say = (sid, text, source) => { t += 60_000; cl.observe({ id: sid }, msg(text, source)) }
  const reply = (sid, text) => { t += 60_000; cl.observe({ id: sid }, her(text)) }
  return { cl, state, say, reply }
}

test('what a QQ plugin forwards is told apart from what he typed in DSH', () => {
  assert.equal(typedInDsh(WEB()), true)
  assert.equal(typedInDsh({ kind: 'user', principal: { id: 'p' } }), true)          // his phone through remote access
  assert.equal(typedInDsh({ kind: 'user' }), false)                                 // tencent official / zaofan: no rpcId
  for (const src of [{ kind: 'user' }, { kind: 'qq' }, { kind: 'plugin', plugin: 'x' }, { kind: 'plugin:dsh-napcat' }]) assert.equal(forwardedChat(src), true, JSON.stringify(src))
  for (const src of [WEB(), { kind: 'fishbowl-town-context' }, { kind: 'qqbot:group-rules', form: 'instructions' }, null]) assert.equal(forwardedChat(src), false, JSON.stringify(src))
})

test('a busy QQ group (kind user, no rpcId) never becomes her main chat; his DSH chat does', () => {
  const { cl, state, say, reply } = link()
  for (let i = 0; i < 9; i++) say('qq-group', '群友' + i + '：今晚谁打牌', { kind: 'user' })
  assert.equal(cl.mainChat(), null)
  assert.equal(state.lastOwnerSid, undefined)                    // 「绑定到当前会话」 never points at the group
  for (let i = 0; i < 3; i++) { say('web', '在吗' + i, WEB(i)); reply('web', '在呀') }
  assert.deepEqual(cl.mainChat(), { sid: 'web', how: 'active' })
  assert.equal(state.lastOwnerSid, 'web')
  cl.usedTownTool('qq-group')                                    // she looked at the town in the group: not his chat
  assert.deepEqual(cl.mainChat(), { sid: 'web', how: 'active' })
  cl.usedTownTool('web')
  assert.deepEqual(cl.mainChat(), { sid: 'web', how: 'tools' })
})

test('a bound QQ session counts his forwarded words; an unbound one only remembers where QQ talked last', () => {
  const cfg = { reportSessionId: 'web', alsoSessionIds: [] }
  let t = Date.UTC(2026, 10, 15, 8, 0)
  const state = {}
  const cl = createChatLink({ state, config: cfg, now: () => t })
  const say = (sid, text, source) => { t += 60_000; cl.observe({ id: sid }, msg(text, source)) }
  say('web', '今天累死了', WEB())
  say('qq-private', '我想让你去面包房烤个面包', { kind: 'qq' })
  assert.equal(state.lastForwardSid, 'qq-private')
  assert.equal(cl.isBound('qq-private'), false)
  assert.equal(cl.ownerSource('qq-private', { kind: 'qq' }), false)
  assert.deepEqual(cl.ownerLife().map((l) => l.replace(/（.*?）/, '')), ['主人：今天累死了'])
  cfg.alsoSessionIds = ['qq-private']
  cl.resetSnapshot()
  assert.equal(cl.isBound('qq-private'), true)
  for (const src of [{ kind: 'qq' }, { kind: 'user' }, { kind: 'plugin:dsh-napcat' }, { kind: 'plugin', plugin: 'qq-bridge' }]) assert.equal(cl.ownerSource('qq-private', src), true)
  assert.equal(cl.ownerSource('qq-private', { kind: 'fishbowl-town-context' }), false)
  say('qq-private', '烤好了给我看看', { kind: 'qq' })
  t += 60_000
  cl.observe({ id: 'qq-private' }, her('好呀，我这就去'))
  say('web', '晚点聊', WEB(2))
  assert.deepEqual(cl.ownerLife().map((l) => l.replace(/（.*?）/, '')),
    ['主人：今天累死了', '主人：烤好了给我看看', '你：好呀，我这就去', '主人：晚点聊'])     // both sessions, in time order
  assert.deepEqual(cl.mainChat(), { sid: 'web', how: 'bound' })                           // turns and news stay on the main one
})

test('the town note goes to every bound session on the owner\'s turn there, QQ-forwarded turns included', async () => {
  const bound = new Set(['web', 'qq-private'])
  const isOwnerSource = (sid, src) => (bound.has(sid) ? ['user', 'qq'].includes(src.kind) : Boolean(src.rpcId))
  let handler = null
  const tc = createTownContext({ log: null, now: () => Date.UTC(2026, 10, 15, 8, 0), fetchBonds: async () => ({ friends: [{ fish_id: 'f1', name: '阿鲸', friend: true }] }),
    isOwnerChat: (sid) => bound.has(sid), isOwnerSource })
  tc.attach({ on: (name, fn) => { if (name === 'agent/pre-step') handler = fn } })
  const run = (sid, source) => handler({ agent: { session: { id: sid } }, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }], source }] }))
  assert.equal((await run('web', WEB())).messages.at(-1).source.kind, CONTEXT_KIND)
  assert.equal((await run('qq-private', { kind: 'qq' })).messages.at(-1).source.kind, CONTEXT_KIND)   // its own pacing: gets one too
  assert.equal((await run('qq-group', { kind: 'user' })).messages.length, 1)                          // not bound: nothing
})

test('settings: also-sessions are kept clean (no duplicates, never the main one, at most 4)', () => {
  assert.deepEqual(alsoList(['a', 'a', ' b ', '', 'main', 'c', 'd', 'e', 'f'], 'main'), ['a', 'b', 'c', 'd'])
  const [one] = fishEntries({ fish: [{ id: '1', code: 'fbo_x', chatSid: 'web', alsoSids: ['qq', 'web', 'qq'] }] }, {}, {})
  assert.deepEqual(one.alsoSids, ['qq'])
  const [old] = fishEntries({ code: 'fbo_y', reportSessionId: 'web' }, {}, {})
  assert.deepEqual(old.alsoSids, [])
})


test('0.8.1: typedRecently counts only what he typed in DSH lately, and only where she chats rather than codes', () => {
  const { cl, say, reply } = link()
  for (let i = 0; i < 3; i++) { say('web', '在吗' + i, WEB(i)); reply('web', '在呀') }
  say('qq', '群友说话', { kind: 'user' })
  assert.equal(cl.typedRecently('web', 3600_000), 3)
  assert.equal(cl.typedRecently('qq', 3600_000), 0)
  assert.equal(cl.typedRecently('web', 1), 0)
  assert.equal(cl.typedRecently('nowhere', 3600_000), 0)
})
