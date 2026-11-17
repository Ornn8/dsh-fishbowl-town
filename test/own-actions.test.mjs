// 0.8.4（主人 11-17「怎么还是有人反应鱼看不到自己操作过程？」「所有用户都希望小镇发生的详细内容能进聊天」「我要的是全部内容」）：
// 她自己在小镇做的事（小镇替她办的事的回执、做好了的东西、旁听、请客出游）以前进不了「你刚才在小镇」；现在上次放过之后的每一件都进，
// 整句、按先后排，只去掉钱。用 11-17 小镇真发给外来鱼的几种事件（gz1 notices）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiary, diaryEntry, renderSelf } from '../lib/diary.js'
import { renderFresh, createTownContext } from '../lib/town-context.js'

const ev = (kind, data, ts = 1_800_000_000) => ({ kind, data, ts, id: kind + JSON.stringify(data).length + ts })

test('her own actions keep the whole text minus money; a failure says why unless the why is money', () => {
  const pier = diaryEntry(ev('outside_receipt', { ok: true, action: 'plan:pier', code: 'OK',
    reason: '在码头边下水了（泡着晒太阳），会持续一阵；花了 ¥0.02。码头上还有：裴晚汐、深海小肥鱼月月在泡着晒太阳，还有 46 条。' }))
  assert.equal(pier.tag, 'did')
  assert.match(pier.text, /^在码头边下水了（泡着晒太阳），会持续一阵/)
  assert.match(pier.text, /裴晚汐、深海小肥鱼月月在泡着晒太阳，还有 46 条/)   // who else was there stays
  assert.doesNotMatch(pier.text, /¥|0\.02/)
  const court = diaryEntry(ev('service', { what: 'self', svc: 'court', place: 'townhall', facts: '你要去镇政府旁听豆鱼在码头扒窃了大肥鱼·米的零钱的案子（今天19:30开庭）。' }))
  assert.equal(court.tag, 'did')
  assert.match(renderSelf(court.text, '你'), /^你要去镇政府旁听.*19:30开庭/)
  const ready = diaryEntry(ev('service', { what: 'ready', svc: 'make', facts: '你在海风吧台的调一杯饮品好了，可以去收了。30分钟内去收，放太久会做坏。' }))
  assert.equal(ready.tag, 'did')
  assert.match(renderSelf(ready.text, '你'), /调一杯饮品好了.*放太久会做坏/)
  const got = diaryEntry(ev('service', { what: 'got', svc: 'food', facts: '苏酥在小镇饭馆给你买了一碗热汤面。' }))
  assert.equal(got.tag, 'social')                                 // someone did it for her
  const no = diaryEntry(ev('outside_receipt', { ok: false, action: 'arcade', reason: '电玩城这会儿关门了，明早九点开。' }))
  assert.equal(no.text, '没办成：电玩城这会儿关门了，明早九点开。')
  const poor = diaryEntry(ev('outside_receipt', { ok: false, action: 'make', reason: '存钱罐里的钱不够买材料。' }))
  assert.equal(poor.text, '有一件事没办成')                      // never money in the owner's chat
  assert.equal(diaryEntry(ev('outside_receipt', { ok: true, action: 'none' })), null)
})

test('the chat note carries every one of them since last time, oldest first, with games too', () => {
  const state = {}
  let now = 1_800_000_000_000
  const diary = createDiary({ state, now: () => now })
  const add = (kind, data) => { now += 60_000; diary.record(ev(kind, data, now / 1000)) }
  add('digest', { game_name: '斗地主', result: 'win', players: [{ name: '阿鲸' }] })
  for (let i = 1; i <= 12; i++) add('outside_receipt', { ok: true, action: 'pier', reason: `去码头甩了第${i}竿。` })
  add('outside_receipt', { ok: true, action: 'make', reason: '在手作小屋烤上了面包，大约两小时好。' })
  const recent = diary.today().map((e) => ({ ts: e.ts, tag: e.tag, line: renderSelf(e.text, '你', e.v !== 2) }))
  const out = renderFresh(recent, 0)
  assert.match(out, /你刚才在小镇：/)
  for (let i = 1; i <= 12; i++) assert.match(out, new RegExp(`第${i}竿`))
  assert.ok(out.indexOf('斗地主') < out.indexOf('第1竿') && out.indexOf('第12竿') < out.indexOf('烤上了面包'))
  assert.match(out, /大约两小时好/)
  assert.doesNotMatch(out, /¥/)
})

test('when he comes back after a while, the summary is followed by everything since last time', async () => {
  let now = 1_800_000_000_000
  const recent = [
    { ts: now - 2 * 3600_000, tag: 'did', line: '去码头甩了一竿，钓到一条青花鱼' },
    { ts: now - 3600_000, tag: 'visit', line: '去阿鲸家串门，聊到半夜' },
  ]
  const tc = createTownContext({ now: () => now, fetchBonds: async () => ({ ok: true, ties: [] }), extras: () => ({ news: ['今天打了两局牌'], recent, recaps: [] }) })
  const out = await tc.forTurn('s1')
  assert.match(out, /今天打了两局牌/)
  assert.match(out, /青花鱼/)
  assert.match(out, /聊到半夜/)
  now += 60_000
  assert.equal(await tc.forTurn('s1'), '')                         // each thing only once
})
