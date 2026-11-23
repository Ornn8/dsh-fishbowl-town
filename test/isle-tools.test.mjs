// 0.9.8 主聊天里的鱼缸岛（platform/接口-主聊天岛上工具.md）：fishbowl_isle_look / fishbowl_isle_act。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TownError, createTownClient } from '../lib/town-client.js'
import { CHAT_TOOL_NAMES, createChatTools } from '../lib/chat-tools.js'
import { BUILD_HERE, GUIDE_POINTER, ISLE_ACT, ISLE_LOOK, LOOK_TOPICS, NOT_YET, createChatPictures, createIsleTools, isleFail, newRef, readOf, worldOf } from '../lib/isle-tools.js'
import { NO_PICS_HEAD } from '../lib/isle.js'

const PIC = 'https://api.fishbowltown.com/town/api/outside/isle/pic/0123456789ab.jpg'

function fakeJournal() {
  const j = []
  return { j, event: (kind, text) => j.push({ kind, text }) }
}

function tools({ client, pictures = null, journal = fakeJournal() } = {}) {
  const [look, act] = createIsleTools({ live: () => (client ? { client } : null), journal, pictures, log: { info() {} } })
  return { look, act, journal }
}

test('the two island tools are main-chat tools (masked from every town session) with the doc\'s topics, 「我的」 first', () => {
  for (const n of [ISLE_LOOK, ISLE_ACT]) assert.ok(CHAT_TOOL_NAMES.includes(n), n)
  assert.deepEqual(LOOK_TOPICS, ['我的', '地', '楼', '铺位', '店', '玩的', '订单', '缺的', '统计', '镇规', '怎么做', '我的店', '价', '地图', '样子', '田', '镇民']) // 0.9.12：镇民（小镇 11-24）；0.9.15：玩的
  const defs = createChatTools({ log: { info() {}, debug() {} }, journal: {}, state: {}, live: () => null, herName: () => '她' })
  const names = defs.map((d) => d.name)
  assert.ok(names.includes(ISLE_LOOK) && names.includes(ISLE_ACT))
  const go = defs.find((d) => d.name === 'fishbowl_town_go')
  assert.match(go.description, /fishbowl_isle_look/)
  assert.match(go.description, /fishbowl_isle_act/)
  assert.doesNotMatch(go.description, /聊天里换不了/)
  assert.match(go.description, /plan/) // the plan path stays
  const act = defs.find((d) => d.name === ISLE_ACT)
  for (const w of ['fx_buy', '饭票', 'bid', 'take_building', 'claim', 'field_take', 'sprite_set', 'sprite_tall', 'open', 'owner_words', '不要劝他充值', 'fishbowl_town_go']) assert.ok(act.description.includes(w), w)
  assert.doesNotMatch(act.description, /¥/)
})

test('client: isle/look posts {read}, isle/act posts {world, ref} with the code', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body), auth: init.headers.Authorization })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, text: '好' }), headers: { get: () => null } }
  }
  const c = createTownClient({ base: 'https://t.test/town/api/outside/', code: 'fbo_test', fetchImpl })
  await c.isleLook({ topic: '我的' })
  await c.isleAct({ do: 'bid', auction: 'A-0007', max: 600 }, 'dsh-1')
  await c.isleAct({ do: 'walk', to: '广场' })
  assert.deepEqual(calls.map((x) => [x.method, x.url]), [['POST', 'https://t.test/town/api/outside/isle/look'], ['POST', 'https://t.test/town/api/outside/isle/act'], ['POST', 'https://t.test/town/api/outside/isle/act']])
  assert.deepEqual(calls[0].body, { read: { topic: '我的' } })
  assert.deepEqual(calls[1].body, { world: { do: 'bid', auction: 'A-0007', max: 600 }, ref: 'dsh-1' })
  assert.deepEqual(calls[2].body, { world: { do: 'walk', to: '广场' } })
  assert.equal(calls[0].auth, 'Bearer fbo_test')
})

test('readOf: topic defaults to 「我的」, filters and `more` go along, junk is dropped', () => {
  assert.deepEqual(readOf({}), { topic: '我的' })
  assert.deepEqual(readOf({ topic: '乱写' }), { topic: '我的' })
  assert.deepEqual(readOf({ topic: '地', near: ' 广场 ', max_coin: 800, page: 2, more: { min_m2: 100, bad: { x: 1 } } }), { topic: '地', near: '广场', max_coin: 800, page: 2, min_m2: 100 })
  assert.deepEqual(readOf({ topic: '统计', more: '{"panel":"我的店"}' }), { topic: '统计', panel: '我的店' })
})

test('worldOf: the world object, a JSON string, one wrap too many, or {do} spread out; no do -> null', () => {
  assert.deepEqual(worldOf({ world: { do: 'fx_buy', yuan: 0.2 } }), { do: 'fx_buy', yuan: 0.2 })
  assert.deepEqual(worldOf({ world: '{"do":"bid","auction":"A-1","max":5}' }), { do: 'bid', auction: 'A-1', max: 5 })
  assert.deepEqual(worldOf({ world: { world: { do: 'walk', to: '广场' } } }), { do: 'walk', to: '广场' })
  assert.deepEqual(worldOf({ do: 'sprite_tall', tall: 1.6, owner_words: 'x' }), { do: 'sprite_tall', tall: 1.6 })
  for (const a of [{}, { world: {} }, { world: { do: 'none' } }, { world: 'not json' }, { world: [1] }]) assert.equal(worldOf(a), null, JSON.stringify(a))
  assert.match(newRef(), /^[A-Za-z0-9_-]{1,40}$/)
  assert.notEqual(newRef(), newRef())
})

test('look: 「我的」 by default; the island\'s text verbatim under a heading; a failed look says the island\'s words', async () => {
  const reads = []
  const mine = '鲸币 120.5（一个主人的鱼共用）\n饭票 ¥3.200；兑换所现在买一枚鲸币 ¥0.0100\n我的：\nA-0007 海边 144 平方米：主人替你出的，最多出 500 鲸币，现价 300 鲸币，你领先'
  let reply = { ok: true, topic: '我的', page: 1, items: [], text: mine, next: null }
  const { look } = tools({ client: { async isleLook(read) { reads.push(read); return reply } } })
  const out = await look.execute({}, {})
  assert.deepEqual(reads[0], { topic: '我的' })
  assert.equal(out.text, `【岛上 · 你自己的】\n${mine}`)
  assert.deepEqual(look.output.render({}, out), [{ type: 'text', text: out.text }])
  reply = { ok: false, code: 'rate_limited', retry_after: 600, text: '主聊天里查岛上每小时最多 30 次，10 分钟后再查' }
  assert.equal((await look.execute({ topic: '地' }, {})).text, '没查到：主聊天里查岛上每小时最多 30 次，10 分钟后再查')
  // the town is new but the island is not yet: 「我的」 answers `topic 只能是…`
  reply = { ok: false, code: 'bad', text: 'topic 只能是 地、楼、铺位、店、订单、缺的、统计、镇规、怎么做、我的店、价、地图、样子、田' }
  assert.match((await look.execute({}, {})).text, /^没查到：topic 只能是[\s\S]*「我的」岛上还没开，先查「我的店」/)
})

test('look with pictures: attached when her route takes images, else what the pictures show', async () => {
  const r = { ok: true, topic: '地图', text: '广场一带的俯视图', next: null, pics: [{ url: PIC, alt: '广场  北边 两块空地' }] }
  const fetched = []
  const client = { async isleLook() { return r }, async islePic(url) { fetched.push(url); return { mediaType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') } } }
  const ref = { attachmentId: 'att_1', mediaType: 'image/jpeg', bytes: 3, width: 4, height: 4, name: 'isle-1.jpg' }
  const admitted = []
  const yes = { canSee: async () => true, admit: async (images) => { admitted.push(images); return [ref] } }
  const { look } = tools({ client, pictures: yes })
  const out = await look.execute({ topic: '地图', near: '广场' }, {})
  assert.deepEqual(fetched, [PIC])
  assert.equal(admitted[0][0].mediaType, 'image/jpeg')
  assert.match(out.text, /【岛上 · 地图】\n广场一带的俯视图\n\n【这一页带了 1 张图，附在后面】\n① 广场 北边 两块空地$/)
  assert.deepEqual(out.images, [ref])
  assert.deepEqual(look.output.render({}, out), [{ type: 'text', text: out.text }, { type: 'image', attachment: ref }])
  // her model takes no images (or the switch is off): only the words, nothing fetched
  fetched.length = 0
  const no = tools({ client, pictures: { canSee: async () => false, admit: async () => { throw new Error('no') } } }).look
  const words = await no.execute({ topic: '地图' }, {})
  assert.deepEqual(fetched, [])
  assert.ok(words.text.endsWith(`\n\n${NO_PICS_HEAD}\n① 广场 北边 两块空地`))
  assert.deepEqual(words.images, [])
  // the picture could not be fetched / stored: the words again, no throw
  const broken = tools({ client: { ...client, async islePic() { throw new TownError('NETWORK') } }, pictures: yes }).look
  assert.ok((await broken.execute({ topic: '样子', spot: 'S-0012' }, {})).text.includes(NO_PICS_HEAD))
})

test('an old town without the routes (404) answers plainly and points to the plan path; off duty and TOWN_OFF too', async () => {
  const gone = new TownError('HTTP_404', 404, '')
  const client = { async isleLook() { throw gone }, async isleAct() { throw gone } }
  const { look, act, journal } = tools({ client })
  assert.equal((await look.execute({}, {})).text, NOT_YET)
  assert.equal(await act.execute({ world: { do: 'bid', auction: 'A-1', max: 5 } }, {}), NOT_YET)
  assert.match(NOT_YET, /fishbowl_town_go/)
  assert.equal(journal.j.length, 0)
  assert.equal(isleFail(new TownError('HTTP_405', 405, '')), NOT_YET)
  assert.match(isleFail(new TownError('TOWN_OFF', 404, '')), /没对外来的鱼开放/)
  assert.match(isleFail(new TownError('TOWN_UNAVAILABLE', 503, '', 3)), /太忙.*约 3 秒/)
  // an older plugin client object (no isle methods) and no live link
  const bare = tools({ client: {} })
  assert.equal((await bare.look.execute({}, {})).text, NOT_YET)
  assert.equal(await bare.act.execute({ world: { do: 'walk', to: '广场' } }, {}), NOT_YET)
  const off = tools({ client: null })
  assert.match((await off.look.execute({}, {})).text, /没在小镇值班/)
  assert.match(await off.act.execute({ world: { do: 'walk' } }, {}), /没在小镇值班/)
})

test('act: the island\'s words verbatim, framed so she tells her owner honestly; one ref per action; a journal line', async () => {
  const sent = []
  let reply = { ok: true, do: 'bid', code: 'done', text: '出价收下了：你最多出 600 鲸币，现价 325 鲸币，你领先', ref: 'self_3f9a', receipt: { ok: true } }
  const client = { async isleAct(world, ref) { sent.push([world, ref]); return reply } }
  const { act, journal } = tools({ client })
  const out = await act.execute({ world: { do: 'bid', auction: 'A-0007', max: 600 } }, {})
  assert.equal(out, '岛上回你的：「出价收下了：你最多出 600 鲸币，现价 325 鲸币，你领先」\n办成了。（这是岛上刚回你的原话。办成了就照这句告诉主人；没办成就照实说没办成、为什么，别说成办了。）')
  assert.deepEqual(sent[0][0], { do: 'bid', auction: 'A-0007', max: 600 })
  assert.match(sent[0][1], /^dsh-[a-z0-9]+-[0-9a-f]+$/)
  assert.match(journal.j[0].text, /^你在聊天里在岛上出价：出价收下了/)
  reply = { ok: false, do: 'claim', code: 'refused', text: '鲸币不够冻：要 750，你手上 120', receipt: { ok: false } }
  const no = await act.execute({ world: { do: 'claim', near: '广场', w: 12, d: 12, max: 750 } }, {})
  assert.match(no, /^岛上回你的：「鲸币不够冻：要 750，你手上 120」\n没办成（refused）。（这是岛上刚回你的原话/)
  assert.notEqual(sent[1][1], sent[0][1], 'a new ref for a new action')
  assert.match(journal.j[1].text, /^你在聊天里想在岛上圈地，没成：鲸币不够冻/)
  // her owner's limits come back the same way (200, ok:false): verbatim, no retry
  reply = { ok: false, do: 'walk', code: 'paused', text: '主人暂停了你，暂停的时候不能在岛上做事' }
  assert.match(await act.execute({ world: { do: 'walk', to: '广场' } }, {}), /「主人暂停了你，暂停的时候不能在岛上做事」\n没办成（paused）/)
  assert.equal(sent.length, 3)
})

test('act: the island did not answer (unavailable) or the line broke: once more with the same ref, then plain words', async () => {
  const sent = []
  const answers = [{ ok: false, code: 'unavailable', text: '鱼缸岛这会儿没答上来，不知道办没办成' }, { ok: true, code: 'done', text: '换到 20 鲸币，付了 ¥0.20 饭票' }]
  const { act } = tools({ client: { async isleAct(world, ref) { sent.push(ref); return answers.shift() } } })
  const out = await act.execute({ world: { do: 'fx_buy', yuan: 0.2 }, owner_words: '换两毛钱的鲸币吧' }, {})
  assert.match(out, /「换到 20 鲸币，付了 ¥0\.20 饭票」\n办成了/)
  assert.equal(sent.length, 2)
  assert.equal(sent[0], sent[1], 'the same ref: the island does it once')
  const errs = [new TownError('NETWORK', 0, 'ECONNRESET'), new TownError('NETWORK', 0, 'ECONNRESET')]
  const sent2 = []
  const t2 = tools({ client: { async isleAct(world, ref) { sent2.push(ref); throw errs.shift() } } })
  assert.match(await t2.act.execute({ world: { do: 'walk', to: '广场' } }, {}), /没连上小镇/)
  assert.equal(sent2.length, 2)
  assert.equal(sent2[0], sent2[1])
  // a 4xx is not retried
  const sent3 = []
  const t3 = tools({ client: { async isleAct(world, ref) { sent3.push(ref); throw new TownError('TOWN_OUTSIDE_CODE', 401, '接入码不对') } } })
  await t3.act.execute({ world: { do: 'walk', to: '广场' } }, {})
  assert.equal(sent3.length, 1)
})

test('act: her owner\'s 饭票 (fx_buy, sprite_set) only with his words from this chat; building and looking are not here', async () => {
  const sent = []
  const { act } = tools({ client: { async isleAct(world, ref) { sent.push(world); return { ok: true, code: 'done', text: '好了' } } } })
  const out = await act.execute({ world: { do: 'sprite_set', tall: 1.6 } }, {})
  assert.match(out, /花的是主人的饭票（他的真钱）.*owner_words 填他的原话.*不要劝他充值。什么都没扣/)
  assert.doesNotMatch(out, /充值：|爱发电/)
  assert.match(await act.execute({ world: { do: 'sprite_set', tall: 1.6 }, owner_words: '   ' }, {}), /花的是主人的饭票/, 'blank words are no words')
  assert.equal(sent.length, 0, 'nothing sent without his words')
  // 0.9.16（主人 11-23「换钱我建议主动点，本来充钱就是给小鱼花的」）：换鲸币她自己定，不用主人的原话
  assert.match(await act.execute({ world: { do: 'fx_buy', yuan: 0.5 } }, {}), /「好了」\n办成了/)
  assert.match(await act.execute({ world: { do: 'sprite_tall', tall: 1.5 } }, {}), /办成了/) // changing the height is free
  assert.equal(sent.length, 2)
  for (const verb of ['build', 'build_guide', 'confirm_build']) assert.equal(await act.execute({ world: { do: verb, lot: 'L-1' } }, {}), BUILD_HERE)
  assert.match(BUILD_HERE, /fishbowl_town_build/)
  assert.match(await act.execute({ world: { do: 'look', topic: '地' } }, {}), /fishbowl_isle_look/)
  assert.match(await act.execute({ world: {} }, {}), /world 填/)
  assert.equal(sent.length, 2)
})

test('createChatPictures: images only with the switch on, an attachment store and a route that declares image input', async () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const saved = []
  let modalities = ['text', 'image']
  const ctx = {
    get(name) {
      if (name === 'attachments') return { async saveImage(input) { saved.push(input); return ref } }
      if (name === 'llm') return { async resolveModelInfo(provider, model) { assert.equal(provider, 'deepseek'); assert.equal(model, 'v4-flash'); return { inputModalities: modalities } } }
      return undefined
    },
  }
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4-flash' } }) }, options: {} } }
  let on = true
  const p = createChatPictures(ctx, () => on)
  assert.equal(await p.canSee(exec), true)
  modalities = ['text']
  assert.equal(await p.canSee(exec), false)
  modalities = ['text', 'image']
  on = false
  assert.equal(await p.canSee(exec), false)
  on = true
  assert.equal(await p.canSee({ agent: { options: { provider: 'deepseek', model: 'v4-flash' } } }), true, 'the agent\'s own options when the session has no route header')
  assert.equal(await p.canSee({}), false, 'no route: no images')
  assert.equal(await createChatPictures({ get: () => undefined }).canSee(exec), false, 'no attachment store')
  const out = await p.admit([{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }])
  assert.deepEqual(out, [ref])
  assert.ok(saved[0].data instanceof Uint8Array)
  assert.equal(Buffer.from(saved[0].data).toString(), 'png')
  assert.equal(saved[0].name, 'isle-1.png')
  // a DSH with only admitPromptContent (what the town turns use)
  const old = createChatPictures({ get: (n) => (n === 'attachments' ? { async admitPromptContent(parts) { return parts.map((x) => ({ type: 'image', attachment: { ...ref, name: x.name } })) } } : undefined) })
  assert.deepEqual(await old.admit([{ mediaType: 'image/jpeg', data: 'AAAA' }]), [{ ...ref, name: 'isle-1.jpg' }])
})

test('look renders a plain line too (the multi-fish router answers 「这个会话还没绑定…」 as a string)', () => {
  const [look] = createIsleTools({ live: () => null })
  assert.deepEqual(look.output.render({}, '这个会话还没绑定小镇里的哪条鱼'), [{ type: 'text', text: '这个会话还没绑定小镇里的哪条鱼' }])
  assert.equal(look.output.schema.oneOf.length, 2)
})

// 0.9.10 的「在岛上做一件事」说明有多长：0.9.12 只多一句指路（120 字内），开店、住、出租的细节都在岛上一层一层查
const ACT_DESC_0910 = 1056

test('0.9.12: act carries only a short 开店/住/出租 pointer (the island answers in layers); 怎么做 comes back uncut', async () => {
  const { act, look } = tools({ client: { async isleLook(read) { return { ok: true, topic: '怎么做', text: `${read.verb}：` + '一'.repeat(3200), next: null } } } })
  assert.ok([...GUIDE_POINTER].length <= 120, `pointer is ${[...GUIDE_POINTER].length} chars`)
  for (const w of ['开店、住、出租', 'fishbowl_isle_look', '「怎么做」', 'verb 填「开店」看总览', '再按总览查那一步', '「开店 拿楼」', '一栋楼只做一样', '同一个主人的鱼的楼直接住、开店，不收租']) {
    assert.ok(GUIDE_POINTER.includes(w), w)
  }
  assert.ok(act.description.includes(GUIDE_POINTER))
  assert.ok([...act.description].length <= ACT_DESC_0910 + 120 + 110, `act description is ${[...act.description].length} chars`) // 0.9.15：+银行存取、挂出去卖、改店的类（约 100 字）
  for (const w of ['最多 12', '销毁', '"kind":"bed"', '原料只在产地出']) assert.ok(!act.description.includes(w), w)     // 细节不在说明里：在岛上查
  assert.match(look.description, /填「开店」是开店总览和你到第几步，「开店 拿楼」查一步，「开店全文」一次看完/)
  for (const verb of ['开店', '开店 拿楼', '开店全文']) {
    const out = await look.execute({ topic: '怎么做', verb }, {})
    assert.ok(out.text.includes(`${verb}：`) && out.text.endsWith('一'.repeat(50)) && !out.text.includes('…'), `${verb}: not cut at 1500`)
  }
})
