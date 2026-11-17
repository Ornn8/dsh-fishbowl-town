// 0.8.2「两边是同一个她」：过滤、回声检查、经过（docs/MEMORY-BRIDGE-0.8.2.md）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { echoCheck, echoIndex, recapGame, recapVisit, scrubLife, textHits } from '../lib/bridge.js'
import { recapLines, renderFresh } from '../lib/town-context.js'

const LIFE = [
  '主人（5 分钟前）：明天要去医院复查，有点紧张',
  '你（4 分钟前）：别怕，我陪着你，回来给你做好吃的',
  '主人（3 分钟前）：我QQ是 123456789，邮箱 a.b@qq.com，看这个 https://x.cn/abc @小王 记一下',
]

test('进小镇之前去掉网址、邮箱、@谁、4 位以上的数字，私事整句不改（交给回声检查）', () => {
  const out = scrubLife(LIFE)
  assert.equal(out[0], LIFE[0])
  assert.ok(!/123456789|a\.b@qq\.com|https:|@小王/.test(out.join('\n')), out.join('\n'))
  assert.ok(out[2].startsWith('主人（3 分钟前）：') && out[2].includes('（一串数字）') && out[2].includes('（链接）'))
  assert.ok(scrubLife(['主人：' + '好'.repeat(500)])[0].length <= 400)
})

test('回声检查：连着 6 个汉字一样就是说漏；小镇材料里本来就有的字不算', () => {
  const idx = echoIndex(LIFE)
  assert.deepEqual(textHits('我主人明天要去医院复查呢', idx), ['明天要去医院', '天要去医院复', '要去医院复查'])
  assert.deepEqual(textHits('去医院看看吧', idx), [])                                  // 5 个字：不算
  assert.deepEqual(textHits('跟我说 123456789', echoIndex(['主人：123456789'])), ['123456789'])
  const allowed = echoIndex(LIFE, { allow: '这一局：明天要去医院复查的人先出' })              // 材料里本来就有
  assert.deepEqual(textHits('明天要去医院复查', allowed), [])
})

test('回答是一句话：撞上就整句不说；是 JSON：只清掉撞上的那几个字段，出的牌照旧', () => {
  const idx = echoIndex(LIFE)
  assert.deepEqual(echoCheck('我主人明天要去医院复查', idx, { format: 'text' }).clean, '')
  assert.equal(echoCheck('今天手气不错', idx, { format: 'text' }).clean, '今天手气不错')
  const json = JSON.stringify({ cards: '33', say: '我陪着你，回来给你做好吃的', note: '出对三' })
  const e = echoCheck(json, idx)
  assert.ok(e.hits.length)
  assert.deepEqual(JSON.parse(e.clean), { cards: '33', say: '', note: '出对三' })
  assert.equal(echoCheck(json, echoIndex([])).clean, json)                                // 没有私密内容：原样
})

test('串门的经过：她说的话优先、开头和最后两句留着，不超过 300 字', () => {
  const one = {
    visit: { role: 'guest', with: { name: '阿鲸' }, place: 'home' },
    dialogue: [
      { role: 'host', name: '阿鲸', text: '你来啦，快进来坐' },
      { role: 'guest', name: '小鱼', text: '给你带了小饼干' },
      { role: 'host', name: '阿鲸', text: '哇谢谢！' + '好吃'.repeat(5) },
      { role: 'host', name: '阿鲸', text: '最近在忙什么' },
      { role: 'guest', name: '小鱼', text: '在学做蛋糕' },
      { role: 'host', name: '阿鲸', text: '下次带我一个' },
      { kind: 'outcome', outcome: { kind: 'gift' } },
    ],
  }
  const r = recapVisit(one)
  assert.ok(r.startsWith('你去找阿鲸，在阿鲸家，聊了 6 句。'), r)
  assert.ok(r.includes('你：「给你带了小饼干」') && r.includes('你：「在学做蛋糕」') && r.includes('阿鲸：「下次带我一个」'), r)
  assert.ok([...r].length <= 300)
  const long = { visit: { role: 'host', with: '小满' }, dialogue: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'host' : 'guest', text: '这是一句挺长的话'.repeat(4) + i })) }
  assert.ok([...recapVisit(long)].length <= 300)
  assert.equal(recapVisit({ visit: { role: 'guest', with: '小满', summary: '敲门没人应' }, dialogue: [] }), '你去找小满，在镇上（敲门没人应）')
})

test('一局的经过：结果、她出的几手、说的话，不超过 150 字', () => {
  const g = { title: '斗地主', result: '你当地主，赢了 ¥0.02', moves: [{ play: '33' }, { play: '王炸', say: '不好意思啦' }, { play: '过' }, { play: 'JQK', say: '收工' }] }
  const r = recapGame(g)
  assert.equal(r, '斗地主：你当地主，赢了 ¥0.02；你出了 4 手（王炸、过、JQK……）；你说过：「不好意思啦」「收工」')
  assert.equal(recapGame(null), '')
})

// 0.8.4（主人 11-17「我要的是全部内容」）：没放过的每一件都跟在后面，按先后排
test('主聊天的「刚才在小镇」：没放过的经过每一件都跟在后面（按先后），放过的不再放', () => {
  const recaps = [{ ts: 3000, kind: 'visit', text: '你去找阿鲸……' }, { ts: 2000, kind: 'game', text: '斗地主：赢了' }, { ts: 1000, kind: 'game', text: '更早的一局' }]
  assert.deepEqual(recapLines(recaps, 1500), ['经过（你刚才在小镇的原话和结果）：', '- 牌局：斗地主：赢了', '- 串门：你去找阿鲸……'])
  assert.equal(recapLines(recaps, 0).length, 4)
  assert.deepEqual(recapLines(recaps, 5000), [])
  const out = renderFresh([], 1500, { recaps })
  assert.ok(out.includes('- 串门：你去找阿鲸……') && !out.includes('更早的一局') && out.includes('都是你的'))
  assert.equal(renderFresh([], 5000, { recaps }), '')
})

// 走一遍 runner：牌局第一轮带上主聊天的事；她说漏了先请她改说法，还漏就把那句清掉；一局打完记下经过
test('runner: the first game turn carries her life, a leak is re-asked then cleared, a finished game leaves a recap', { timeout: 30_000 }, async () => {
  const { createJournal } = await import('../lib/journal.js')
  const { createRunner } = await import('../lib/runner.js')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const log = { info() {}, warn() {}, debug() {}, error() {} }
  const turn = (id) => ({ turn_id: id, kind: 'game', deadline: Date.now() / 1000 + 25,
    packet: { ref: 'g_1', game: 'ddz', purpose: 'play', seat: 2, as: '小雫', messages: [{ role: 'system', content: '只输出JSON' }, { role: 'user', content: 'A. 33\nB. 过' }],
      reply: { format: 'json', hint: '{"pick":"A","say":"…"}', max_chars: 140 } } })
  const state = {}
  const journal = createJournal({ state })
  let polled = 0
  const posted = []
  let evented = false
  const client = {
    async turns(_w, signal) {
      polled++
      if (polled === 1) return { turns: [turn('t1')] }
      if (polled === 2) return { turns: [turn('t2')] }
      await sleep(200); if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
      return { turns: [] }
    },
    async answer(id, body) { posted.push([id, body]); return { ok: true } },
    async events() {
      if (evented || posted.length < 2) return { items: [] }
      evented = true
      return { next: 2, items: [{ id: 1, kind: 'digest', ts: Date.now() / 1000, data: { game_id: 'g_1', game_name: '斗地主', facts: '斗地主：你是农民，赢了。' } }] }
    },
  }
  const prompts = []
  // 带着主聊天的那一轮说漏，改说法时还漏；没带的那一轮好好答（两轮可能同时跑，按内容答，不按先后）
  const brain = { async ask(slot, text) {
    prompts.push(text)
    if (text.includes('带出了你和主人之间的事')) return JSON.stringify({ pick: 'A', say: '还是明天要去医院复查啦' })
    if (text.includes('【你和主人最近的事】')) return JSON.stringify({ pick: 'A', say: '我主人明天要去医院复查' })
    return JSON.stringify({ pick: 'B', say: '这把我先过' })
  } }
  const echoes = []
  const runner = createRunner({ client, brain, log, journal, ownerLife: () => scrubLife(LIFE), onEcho: (e) => echoes.push(e), config: { eventsEveryMs: 500, retryMinMs: 1000 } })
  runner.start()
  try {
    for (let i = 0; i < 80 && posted.length < 2; i++) await sleep(100)
    assert.equal(posted.length, 2)
    assert.equal(prompts.filter((t) => t.includes('【你和主人最近的事】')).length, 1)                    // 一局只在第一轮带
    assert.ok(prompts.some((t) => t.includes('【你和主人最近的事】') && t.includes('明天要去医院复查')))
    assert.equal(prompts.filter((t) => t.includes('带出了你和主人之间的事')).length, 1)                  // 请她改说法一次
    assert.ok(JSON.stringify(posted).includes('\\"pick\\":\\"A\\"') || JSON.stringify(posted).includes('"pick":"A"'), JSON.stringify(posted))   // 出的牌照旧交了
    assert.ok(!JSON.stringify(posted).includes('医院'), JSON.stringify(posted))                     // 说漏的那句没发出去
    assert.deepEqual(echoes, [{ kind: 'game', fixed: false, n: echoes[0].n }])
    for (let i = 0; i < 60 && !journal.recapsSince(0, 2).length; i++) await sleep(100)
    const [r] = journal.recapsSince(0, 2)
    assert.equal(r.kind, 'game')
    assert.ok(r.text.startsWith('斗地主') && r.text.includes('你出了'), r.text)
  } finally {
    await runner.stop()
  }
})

// AstrBot 真跑（11-17）：他在上次备注后 4 分钟问「刚才在小镇干嘛了」，经过在等 10 分钟的间隔，她只能编——新的经过下一句就放，只放一次
test('a new recap reaches his next message without waiting the ten minutes, and only once', async () => {
  const { createTownContext } = await import('../lib/town-context.js')
  let t = new Date(2026, 10, 17, 12, 0).getTime()
  const recaps = []
  const tc = createTownContext({ log: null, now: () => t, isOwnerChat: () => true, fetchBonds: async () => ({ friends: [{ fish_id: 'f1', name: '阿鲸', friend: true }] }), extras: () => ({ recaps: [...recaps] }) })
  assert.ok((await tc.forTurn('main')).includes('阿鲸'))
  t += 2 * 60_000
  recaps.unshift({ ts: t, kind: 'visit', text: '阿鲸来找你，在你家，聊了 6 句。你：「快进来坐」' })
  t += 2 * 60_000
  const out = await tc.forTurn('main')
  assert.ok(out.includes('- 串门：阿鲸来找你') && out.includes('都是你的'), out)
  t += 60_000
  assert.equal(await tc.forTurn('main'), '')
  t += 4 * 3600_000
  recaps.unshift({ ts: t, kind: 'game', text: '猜拳：阿鲸赢了' })
  const back = await tc.forTurn('main')
  assert.ok(back.includes('- 牌局：猜拳：阿鲸赢了') && !back.includes('阿鲸来找你'), back)
})
