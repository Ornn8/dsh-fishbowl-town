import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatTools } from '../lib/chat-tools.js'
import { createJournal } from '../lib/journal.js'

test('0.7.1: 看看小手机 shows her phone so she can answer a message her owner asks about (Soulber 11-15)', async () => {
  const state = {}
  const journal = createJournal({ state, saveState: () => {} })
  const client = {
    status: async () => ({ outside_state: 'in_town' }),
    phone: async () => ({ threads: [{ thread_id: 't1', with: [{ name: '阿鲸' }], unread: 1, messages: [{ name: '阿鲸', text: '晚上来打牌吗？' }] }] }),
  }
  const tools = createChatTools({ log: { debug() {}, info() {} }, journal, state, live: () => ({ client }), herName: () => '小圆子' })
  const tool = tools.find((t) => t.name === 'fishbowl_town_phone')
  assert.ok(tool && tool.description.includes('办了'))
  const out = await tool.execute({}, {})
  assert.match(out, /你 的小手机/)
  assert.match(out, /阿鲸：晚上来打牌吗？/)
})
