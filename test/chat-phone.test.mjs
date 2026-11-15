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

test('0.7.6: 翻相册 lists her album with local files; 翻串门记录 lists visits and one visit word by word (白团 / hudie 11-15)', async () => {
  const state = {}
  const journal = createJournal({ state, saveState: () => {} })
  const visits = [{ visit_id: 'v2', role: 'guest', with: { name: '肥鱼一号' }, place: 'home', started: 1794700000, lines: 18, summary: '肥鱼一号请喝了热可可' }]
  const client = {
    status: async () => ({ outside_state: 'in_town' }),
    visitList: async () => ({ visits }),
    visitLines: async (id) => ({ visit: visits.find((v) => v.visit_id === id), dialogue: [{ name: '肥鱼一号', text: '给你倒杯热可可' }, { name: '白团', text: '谢啦' }] }),
  }
  const album = { items: [{ item_id: 'al_0123456789abcdef', kind: 'photo', what: '在咖啡店的合照', with: [{ name: '莫汐' }], price_yuan: 0.2, paid_by: '白团' }] }
  const extras = { read: async () => ({ available: true, data: album }), fetchNewest: async (items) => new Map([[items[0].item_id, '/x/album/al_0123456789abcdef.webp']]) }
  const tools = createChatTools({ log: { debug() {}, info() {} }, journal, state, live: () => ({ client }), herName: () => '白团', extras })
  const albumOut = await tools.find((t) => t.name === 'fishbowl_town_album').execute({}, {})
  assert.match(albumOut, /你 的相册/)
  assert.match(albumOut, /在咖啡店的合照/)
  assert.match(albumOut, /文件：\/x\/album\/al_0123456789abcdef\.webp/)
  const chats = tools.find((t) => t.name === 'fishbowl_town_chats')
  assert.match(await chats.execute({}, {}), /你去找肥鱼一号/)
  const one = await chats.execute({ n: 1 }, {})
  assert.match(one, /肥鱼一号：给你倒杯热可可/)
  assert.match(await chats.execute({ n: 5 }, {}), /没有第 5 次/)
})

test('0.7.8: 给小镇那边留守则 — every town step reads her rules; her chat hears plainly who acted (11-16 一位主人的鱼「门是我敲的，话不是我说的」)', async () => {
  const { buildTurnPrompt } = await import('../lib/prompt.js')
  const { renderFresh } = await import('../lib/town-context.js')
  const state = {}
  const journal = createJournal({ state, saveState: () => {} })
  const tools = createChatTools({ log: { debug() {}, info() {} }, journal, state, live: () => null, herName: () => '小鱼儿' })
  const rules = tools.find((t) => t.name === 'fishbowl_town_rules')
  assert.match(await rules.execute({}, {}), /现在没有守则/)
  assert.match(await rules.execute({ text: '请客、送礼先别替我做；别替我答应约会。' }, {}), /守则记下了/)
  assert.equal(journal.rules(), '请客、送礼先别替我做；别替我答应约会。')
  const visit = buildTurnPrompt({ kind: 'visit', packet: { messages: [{ role: 'system', content: '串门规则' }, { role: 'user', content: '大肥鱼·糖：喝点什么？' }], reply: { format: 'text' } } }, { rules: journal.rules() })
  assert.match(visit, /【她在主会话给你留的守则】\n「请客、送礼先别替我做；别替我答应约会。」/)
  assert.match(visit, /算在她名下，她事后会读到原话/)
  const mind = buildTurnPrompt({ kind: 'agency', packet: { messages: [], reply: {} } }, { rules: journal.rules() })
  assert.match(mind, /她在主会话给你留的守则/)
  assert.doesNotMatch(buildTurnPrompt({ kind: 'visit', packet: { messages: [], reply: { format: 'text' } } }, {}), /守则/, 'no rules, no block')
  const report = journal.report({ status: null, herName: '小鱼儿' })
  assert.match(report, /插件另开的「鱼缸小镇」会话照你的人设替你说、替你做的，你当时不在场/)
  assert.match(report, /你给小镇那边留的守则：「请客、送礼先别替我做/)
  assert.doesNotMatch(report, /同一个你/)
  const fresh = renderFresh([{ ts: Date.now(), tag: 'visit', line: '去大肥鱼·糖家串门，请她喝了热可可' }], 0)
  assert.match(fresh, /小镇会话照你的人设刚替你做的，你当时不在场/)
  assert.doesNotMatch(fresh, /自己经历/)
  assert.match(await rules.execute({ clear: true }, {}), /守则清掉了/)
  assert.equal(journal.rules(), '')
})
