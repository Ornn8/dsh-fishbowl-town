import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBlock, createTownContext, CONTEXT_KIND } from '../lib/town-context.js'

const NOW = new Date(2026, 10, 13, 15, 0).getTime()
const BONDS = {
  friends: [{ fish_id: 'f1', name: '阿鲸', friend: true, warmth: 9, met: 12, last_seen: NOW / 1000 }, { fish_id: 'f2', name: '小满', friend: true, warmth: 5 }, { fish_id: 'f3', name: '路人', friend: false }],
  rivals: [{ fish_id: 'f4', name: '小刺', relation: 'rival', game: 'ddz' }],
  couple: null, crush: { fish_id: 'f2', name: '小满' },
  ties: [{ kind: 'promise', who: 'f1', who_name: '阿鲸', what: '打牌', due: new Date(2026, 10, 14, 20, 0).getTime() / 1000, when_zh: '明天20:00' }],
  missed: [{ fish_id: 'f2', name: '小满', line: '好久没见泡泡了，有点想她', ts: NOW / 1000 - 3600 }],
  buddy: { fish_id: 'f1', name: '阿鲸', since: NOW / 1000 }, guiding: [],
}

test('block is a few lines with the real line, the appointment time and the guidance', () => {
  const b = renderBlock(BONDS, { nowMs: NOW, herName: '泡泡·萝' })
  assert.match(b, /明天20:00 和阿鲸，打牌/)
  assert.doesNotMatch(b, /路人/)
  assert.match(b, /小满说：「好久没见泡泡了，有点想她」/)
  assert.match(b, /喜欢小满/)
  assert.match(b, /愧疚/)
  assert.match(b, /花钱/)
  assert.ok(b.split('\n').length <= 7)
})

test('empty or failed bonds give no block', () => {
  assert.equal(renderBlock(null), '')
  assert.equal(renderBlock({ ok: false }), '')
  assert.equal(renderBlock({ ok: true, friends: [], missed: [] }), '')
})

function hostWith(ctxOpts) {
  let handler = null
  const ctx = { on: (name, fn) => { if (name === 'agent/pre-step') handler = fn } }
  const tc = createTownContext({ log: null, ...ctxOpts })
  tc.attach(ctx)
  const run = (sid, step = 1, kind = 'user') => handler(
    { agent: { session: { id: sid } }, step, turn: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind } }] }),
  )
  return { run, tc }
}

test('owner chat gets the block once; unchanged content is not repeated; other sessions never', async () => {
  let t = NOW
  let calls = 0
  const { run } = hostWith({ now: () => t, fetchBonds: async () => { calls++; return BONDS }, isOwnerChat: (sid) => sid === 'main' })
  const d1 = await run('main')
  assert.equal(d1.messages.length, 2)
  assert.equal(d1.messages[1].source.kind, CONTEXT_KIND)
  assert.equal((await run('main')).messages.length, 1) // same content
  assert.equal((await run('other')).messages.length, 1) // not her owner chat
  assert.equal((await run('main', 2)).messages.length, 1) // later step
  assert.equal((await run('main', 1, 'fishbowl-town')).messages.length, 1) // plugin message, not owner
  t += 30 * 60_000
  assert.equal((await run('main')).messages.length, 1) // TTL refresh, same content
  assert.equal(calls, 2)
})

test('town unreachable: no block, no throw', async () => {
  const { run } = hostWith({ now: () => NOW, fetchBonds: async () => { throw new Error('NETWORK') }, isOwnerChat: () => true })
  const d = await run('main')
  assert.equal(d.messages.length, 1)
})

test('slow town does not hold the chat longer than the cold wait', async () => {
  const { run } = hostWith({ fetchBonds: () => new Promise(() => {}), isOwnerChat: () => true })
  const t0 = Date.now()
  const d = await run('main')
  assert.equal(d.messages.length, 1)
  assert.ok(Date.now() - t0 < 2500)
})
