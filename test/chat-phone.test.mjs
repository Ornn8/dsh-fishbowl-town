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
  // 0.8.1（主人 11-17：用户老说小镇里的是「分身」）：小镇里的就是她本人，被问到时不说「那不是我」，可以把家搬过来
  assert.match(report, /小镇里的话和事就是你自己在小镇做的/)
  assert.match(report, /别说「那不是我」/)
  assert.match(report, /fishbowl_town_setup（move=true）/)
  assert.doesNotMatch(report, /不在场/)
  assert.match(report, /你给小镇那边留的守则：「请客、送礼先别替我做/)
  assert.match(report, /同一个你/)
  const fresh = renderFresh([{ ts: Date.now(), tag: 'visit', line: '去大肥鱼·糖家串门，请她喝了热可可' }], 0)
  assert.match(fresh, /这些是你刚才在小镇做的.*都是你的/)
  assert.doesNotMatch(fresh, /不在场/)
  assert.doesNotMatch(fresh, /自己经历/)
  assert.match(await rules.execute({ clear: true }, {}), /守则清掉了/)
  assert.equal(journal.rules(), '')
})

test('0.7.10: what the town session chose is not her judgment; held kinds never reach the town (同一条鱼 11-16「守则是先看，不是先拦」)', async () => {
  const { holdCheck, buildTurnPrompt } = await import('../lib/prompt.js')
  const state = {}
  const journal = createJournal({ state, saveState: () => {} })
  const tools = createChatTools({ log: { debug() {}, info() {} }, journal, state, live: () => null, herName: () => '小鱼儿' })
  const rules = tools.find((t) => t.name === 'fishbowl_town_rules')
  assert.match(await rules.execute({ hold: ['spend', 'promise'] }, {}), /停住等你一句/)
  assert.deepEqual(journal.holds(), ['spend', 'promise'])
  // a visit treat and a promise are taken out; an invite keeps the table but not the treat
  let h = holdCheck('visit', JSON.stringify({ say: '我请你喝杯热可可', act: { kind: 'cafe', item: '热可可' } }), journal.holds())
  assert.deepEqual(h.found, ['在串门时请喝东西（热可可）'])
  assert.equal(JSON.parse(h.clean).act, null)
  h = holdCheck('visit', JSON.stringify({ say: '这桌我请', act: { kind: 'invite', game: 'mj', treat: true } }), journal.holds())
  assert.deepEqual(JSON.parse(h.clean).act, { kind: 'invite', game: 'mj', treat: false })
  h = holdCheck('visit', JSON.stringify({ say: '好，明天带饭', act: { kind: 'promise', text: '明天带饭给你', due_days: 1 } }), ['spend'])
  assert.deepEqual(h.found, [], 'promise is not held when only spend is on')
  h = holdCheck('agency', JSON.stringify({ action: 'none', plan: { hours: 1, doing: '歇着' }, gift: { to: 'x', item: '花' }, phone: { to: 'y', text: '明天见', meet: { place: 'cafe', in_hours: 20 } } }), journal.holds())
  assert.equal(h.found.length, 2)
  const a = JSON.parse(h.clean)
  assert.ok(!('gift' in a) && !('phone' in a) && a.action === 'none')
  assert.equal(holdCheck('visit', 'not json', ['spend']).clean, 'not json')
  // the town session is told, and her chat sees what was stopped
  const p = buildTurnPrompt({ kind: 'visit', packet: { messages: [], reply: { format: 'json' } } }, { rules: { text: '', hold: journal.holds() } })
  assert.match(p, /你一样都不办：请客、送礼/)
  journal.held('在串门时请喝东西（热可可）')
  assert.equal(journal.heldSince(0).length, 1)
  const report = journal.report({ status: null, herName: '小鱼儿' })
  assert.match(report, /那边答得快，有时和你在这儿想的不一样/)                                     // 0.8.1：是她，只是答得快
  assert.match(report, /你自己也能定去哪、做什么.*fishbowl_town_go 写下你自己的打算（plan），插件马上请小镇让那边照着去做/)  // 0.7.13
  assert.doesNotMatch(report, /不算你的判断/)
  assert.match(report, /先停住、等你一句的事/)
  assert.match(report, /小镇那边想在串门时请喝东西（热可可），照你的规矩停住了，没办/)
  journal.decision({ action: 'signup', game: 'mj', next_wake: 30 })
  assert.match(journal.decisionLines(1)[0], /^你在小镇定了：报名/)
  assert.match(journal.recentForAgency(1)[0], /你决定：报名/, 'the town session itself still reads its own decision')
  assert.match(await rules.execute({ hold: [] }, {}), /取消了/)
  assert.deepEqual(journal.holds(), [])
})
