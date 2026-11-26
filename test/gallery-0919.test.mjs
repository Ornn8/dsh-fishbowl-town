// 0.9.19 画廊上岛（协调 11-25；共享笔记「画廊上岛-接口说明-1126.md」第四节、7.2、7.3）：
// 试画报价 -> 主人在聊天里报价以后亲口点头 -> 插件确认；主人发的图当参考图；照方子拍照；主人一句「4 星」打分；小镇没开时不出声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TownError, createTownClient } from '../lib/town-client.js'
import { GALLERY_CLOSED, GALLERY_HOW, createIsleTools } from '../lib/isle-tools.js'
import { createOwnerWords, isYesTo } from '../lib/cobuild.js'
import { GALLERY_NO, GALLERY_YES, PIC_FOR_MS, QUOTE_FOR_MS, RATE_FOR_MS, createGallery, imageRefsOf, isOwnerPicRef, starsOf } from '../lib/gallery.js'
import { createSocialServe, createSocialTools } from '../lib/social-tools.js'
import { createExtras } from '../lib/extras.js'
import { createChatTools } from '../lib/chat-tools.js'

const Q = 'G-0123456789'
const quoteR = { ok: true, code: 'quoted', quote: Q, coin: 63, text: '照「海边」试一次：63 鲸币，主人点头后扣。' }

function world() {
  let t = 1_800_000_000_000
  const clock = { now: () => t, step: (ms) => { t += ms } }
  const state = {}
  const gallery = createGallery({ state, now: clock.now })
  const words = createOwnerWords({ now: clock.now })
  // cobuild.consent 的同一套（只认主人聊天会话、报价以后、像点头）
  const consent = (sid, since, what, more) => {
    if (sid !== 'main') return { why: `${what}要主人在你们平时聊天的会话里亲口说，这个会话不算。` }
    const w = words.latest(sid)
    if (!w || w.at <= since) return { why: '主人看到以后还没在这里亲口说话。' }
    if (!isYesTo(w.text, more)) return { why: `主人最后说的是「${w.text}」，听着不像让你确认。` }
    return { words: w.text }
  }
  const calls = []
  const client = {
    isleAct: async (w, ref) => { calls.push(['act', w, ref]); return w.try ? quoteR : { ok: true, text: '收下了参考图：r_abc123' } },
    galleryConfirm: async (b) => { calls.push(['confirm', b]); return { ok: true, code: 'making', order: 'go_1', paid: 63, text: '开画了' } },
    galleryUpload: async (bytes, type) => { calls.push(['upload', bytes.length, type]); return { ok: true, upload_id: 'u_77' } },
  }
  const pics = { read: async (ref) => { calls.push(['read', ref.attachmentId]); return { data: new Uint8Array(1000), mediaType: 'image/png' } } }
  const notes = []
  const journal = { event: (k, t2) => { notes.push(t2); return t2 }, pin() {} }
  const [, act] = createIsleTools({ live: () => ({ client }), journal, log: { info() {} }, pictures: pics, gallery, consent })
  const exec = (sid = 'main') => ({ agent: { session: { id: sid } } })
  return { clock, state, gallery, words, client, calls, act, exec, notes, pics }
}

test('0.9.19 gallery: the owner-words and star readers', () => {
  for (const [t, n] of [['4 星', 4], ['4分', 4], ['四星', 4], ['给你 5 星', 5], ['打3分吧', 3], ['⭐⭐⭐⭐', 4], ['★★', 2], ['5星！', 5]]) assert.equal(starsOf(t), n, t)
  for (const t of ['4 分钟到', '我给 4 星好评吗？', '6 星', '今天打了 4 分的游戏', '', '星星好看']) assert.equal(starsOf(t), 0, t)
  for (const t of ['画吧', '就画吧', '可以，画吧', '好', '试一次']) assert.equal(isYesTo(t, { yes: GALLERY_YES, no: GALLERY_NO }), true, t)
  for (const t of ['不画了吧', '别画', '画吧？', '贵了', '多少钱', '先别']) assert.equal(isYesTo(t, { yes: GALLERY_YES, no: GALLERY_NO }), false, t)
  for (const r of ['主人的图', '主人发的图', 'owner', '他发的图']) assert.equal(isOwnerPicRef(r), true, r)
  for (const r of ['u_77', 'r_abc', 'al_9', '', '买家', '上一步']) assert.equal(isOwnerPicRef(r), false, r)
  const ref = { attachmentId: 'a1', mediaType: 'image/png' }
  assert.deepEqual(imageRefsOf({ content: [{ type: 'text', text: '用这张' }, { type: 'image', attachment: ref }, { type: 'image' }] }), [ref])
  assert.deepEqual(imageRefsOf({ content: '只有字' }), [])
})

test('0.9.19 gallery ledger: quotes last 2 h, owner pictures 30 min, a rating only within 30 min of photo_done', () => {
  const { clock, gallery } = world()
  assert.equal(gallery.quoted({ ok: true, code: 'done' }), null)
  assert.equal(gallery.quote(), null)
  gallery.quoted(quoteR)
  assert.equal(gallery.quote().quote, Q)
  assert.equal(gallery.quote(Q.toLowerCase()).coin, 63)
  assert.equal(gallery.quote('G-ffffffffff'), null)
  clock.step(QUOTE_FOR_MS + 1)
  assert.equal(gallery.quote(), null)
  gallery.ownerPics('main', [{ attachmentId: 'a1' }, { attachmentId: 'a2' }])
  assert.equal(gallery.latestPic('main').attachmentId, 'a2')
  assert.equal(gallery.latestPic('other'), null)
  clock.step(PIC_FOR_MS + 1)
  assert.equal(gallery.latestPic('main'), null)
  assert.equal(gallery.ratingFor('4 星'), null)
  gallery.photoDone('sm_1')
  clock.step(60_000)
  gallery.photoDone('sm_2')
  assert.deepEqual(gallery.ratingFor('4 星'), { orderId: 'sm_2', score: 4 })
  assert.equal(gallery.ratingFor('好看'), null)
  clock.step(RATE_FOR_MS + 1)
  assert.equal(gallery.ratingFor('5 星'), null)
})

test('0.9.19 gallery: try -> quote kept; confirm only after the owner nods in the main chat after the quote', async () => {
  const w = world()
  const r1 = await w.act.execute({ world: { do: 'gallery', recipe: 'R-0123456789', try: 1, wish: '海边' } }, w.exec())
  assert.match(r1, /只报了价，还没扣：报价号 G-0123456789，63 鲸币/)
  assert.match(r1, /"do":"gallery_confirm","quote":"G-0123456789"/)
  assert.equal(w.gallery.quote().quote, Q)
  // nothing from the owner yet
  let r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec())
  assert.match(r, /还没在这里亲口说话/)
  // he says no
  w.clock.step(1000)
  w.words.observe('main', '不画了吧')
  r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec())
  assert.match(r, /不像让你确认/)
  // not the owner chat
  w.words.observe('qq', '画吧')
  r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec('qq'))
  assert.match(r, /这个会话不算/)
  assert.equal(w.calls.filter((c) => c[0] === 'confirm').length, 0, 'nothing sent to the island yet')
  // he nods: confirmed with his words (no quote written -> the latest one)
  w.clock.step(1000)
  w.words.observe('main', '可以，画吧')
  r = await w.act.execute({ world: { do: 'gallery_confirm' } }, w.exec())
  assert.deepEqual(w.calls.find((c) => c[0] === 'confirm')[1], { quote: Q, ownerWords: '可以，画吧' })
  assert.match(r, /确认了（主人说「可以，画吧」，扣了 63 鲸币）/)
  assert.equal(w.gallery.quote(), null, 'a confirmed quote no longer waits')
  assert.ok(w.notes.some((n) => n.includes('确认了试画')))
  // gallery_confirm never goes through isle/act
  assert.equal(w.calls.filter((c) => c[0] === 'act' && c[1].do === 'gallery_confirm').length, 0)
})

test('0.9.19 gallery: words said before the quote do not count; island refusals and a closed gallery read plainly', async () => {
  const w = world()
  w.words.observe('main', '画吧')
  w.clock.step(1000)
  await w.act.execute({ world: { do: 'gallery', recipe: 'R-0123456789', try: 1 } }, w.exec())
  let r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec())
  assert.match(r, /还没在这里亲口说话/)
  w.clock.step(1000)
  w.words.observe('main', '画吧')
  w.client.galleryConfirm = async () => { throw new TownError('HTTP_404', 404, '') }
  assert.equal(await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec()), GALLERY_CLOSED)
  w.client.galleryConfirm = async () => ({ ok: false, code: 'gallery_off', text: '画廊还没开（镇上开了会说）。什么都没办、没扣' })
  assert.equal(await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec()), GALLERY_CLOSED)
  w.client.galleryConfirm = async () => ({ ok: false, code: 'closed', text: '这家画廊关了：什么都没扣' })
  r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec())
  assert.match(r, /这家画廊关了.*没确认（closed）/s)
  assert.equal(w.gallery.quote().quote, Q, 'still waiting after 404 / off / closed')
  w.client.galleryConfirm = async () => ({ ok: false, code: 'old', text: '这个报价过期了' })
  r = await w.act.execute({ world: { do: 'gallery_confirm', quote: Q } }, w.exec())
  assert.match(r, /没确认（old）。报价过期了.*什么都没扣/)
  assert.equal(w.gallery.quote(), null, 'the island said old: no longer waited for')
  // no quote at all
  const v = world()
  assert.match(await v.act.execute({ world: { do: 'gallery_confirm' } }, v.exec()), /现在没有在等主人点头的试画报价/)
  assert.match(await v.act.execute({ world: { do: 'gallery_confirm', quote: 'G-aaaaaaaaaa' } }, v.exec()), /没有在等的报价 G-aaaaaaaaaa/)
})

test('0.9.19 gallery: "ref":"主人的图" uploads his latest picture and sends the u_ number; nothing is uploaded otherwise', async () => {
  const w = world()
  let r = await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec())
  assert.match(r, /主人最近 30 分钟没在这里发图/)
  assert.equal(w.calls.length, 0)
  w.gallery.ownerPics('main', [{ attachmentId: 'a9', mediaType: 'image/png' }])
  r = await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec())
  assert.deepEqual(w.calls.map((c) => c[0]), ['read', 'upload', 'act'])
  assert.deepEqual(w.calls[1], ['upload', 1000, 'image/png'])
  assert.deepEqual(w.calls[2][1], { do: 'gallery', spot: 'S-1', ref: 'u_77' })
  assert.match(r, /r_abc123/)
  // a picture from another session is not his picture here
  assert.match(await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec('qq')), /没在这里发图/)
  // the island already has a number: passed as written, no upload
  w.calls.length = 0
  await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: 'al_5' } }, w.exec())
  assert.deepEqual(w.calls.map((c) => c[0]), ['act'])
  // closed / busy / unreadable
  w.calls.length = 0
  w.client.galleryUpload = async () => { throw new TownError('HTTP_404', 404, '') }
  assert.equal(await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec()), GALLERY_CLOSED)
  assert.equal(w.calls.filter((c) => c[0] === 'act').length, 0)
  w.client.galleryUpload = async () => ({ ok: false, code: 'busy', text: '太多了' })
  assert.match(await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec()), /12 张/)
  w.pics.read = async () => { throw Object.assign(new Error('no'), { code: 'NO_READ' }) }
  assert.match(await w.act.execute({ world: { do: 'gallery', spot: 'S-1', ref: '主人的图' } }, w.exec()), /读不出来/)
})

test('0.9.19 gallery: the act tool tells her the way in one block; chat tools hand the cobuild consent through', () => {
  const w = world()
  assert.ok(w.act.description.includes(GALLERY_HOW))
  assert.match(GALLERY_HOW, /verb 填「画廊」/)
  const defs = createChatTools({ log: { info() {}, debug() {} }, journal: {}, state: {}, live: () => null, herName: () => '她', cobuild: { consent: () => ({ why: 'x' }) }, gallery: w.gallery })
  assert.ok(defs.some((d) => d.name === 'fishbowl_isle_act'))
})

test('0.9.19 client: photo/rate 404 never shuts photo; gallery upload sends the raw bytes with their type', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const u = String(url)
    calls.push({ u, type: init.headers['Content-Type'], body: init.body })
    if (u.endsWith('/photo/rate')) return new Response(JSON.stringify({ error: 'HTTP_404' }), { status: 404 })
    if (u.endsWith('/isle/gallery/upload')) return new Response(JSON.stringify({ ok: true, upload_id: 'u_1' }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, order_id: 'sm_9' }), { status: 200 })
  }
  const c = createTownClient({ base: 'http://127.0.0.1:9/town/api/outside/', code: 'x'.repeat(20), fetchImpl })
  await assert.rejects(c.photoRate({ orderId: 'sm_1', score: 4 }), (e) => e instanceof TownError && e.status === 404)
  assert.deepEqual(await c.photo({ with: [], style: 'plain' }), { ok: true, order_id: 'sm_9' })
  assert.equal(calls.filter((x) => x.u.endsWith('/photo')).length, 1, 'photo still asked after a rate 404')
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal((await c.galleryUpload(bytes, 'image/webp')).upload_id, 'u_1')
  const up = calls.find((x) => x.u.endsWith('/isle/gallery/upload'))
  assert.equal(up.type, 'image/webp')
  assert.equal(up.body, bytes)
  const rate = calls.find((x) => x.u.endsWith('/photo/rate'))
  assert.deepEqual(JSON.parse(rate.body), { order_id: 'sm_1', score: 4 })
})

test('0.9.19 photo with a recipe: sent along; the receipt names it; recipe photos off -> the same photo without it, said plainly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftx-'))
  try {
    const sent = []
    let mode = 'on'
    const client = {
      bonds: async () => ({ friends: [] }),
      lobby: async () => ({ fish: [] }),
      photo: async (b) => {
        sent.push(b)
        if (b.recipe && mode === 'off') return { ok: false, code: 'off', reason: '方子拍照没开' }
        if (b.recipe && mode === 'gone') return { order_id: 'sm_2', state: 'making', recipe_note: '没有「R-0123456789」这个方子：照常拍' }
        return { order_id: 'sm_1', state: 'making', ...(b.recipe ? { recipe: { id: b.recipe, name: '海边胶片', shop: '小雫画廊', fee: 25 } } : {}) }
      },
    }
    const live = () => ({ client })
    const social = createSocialServe({ live, journal: { event() {} }, extras: createExtras({ live, stateDir: dir }), diary: { note() {} } })
    const tool = createSocialTools({ social })[0]
    assert.ok(tool.parameters.properties.recipe)
    let r = await tool.execute({ do: 'photo', recipe: 'R-0123456789' })
    assert.equal(sent[0].recipe, 'R-0123456789')
    assert.match(r, /照「海边胶片」（小雫画廊）的方子，方子加价 25 鲸币/)
    r = await tool.execute({ do: 'photo', recipe: '随便写的' })
    assert.equal(sent[1].recipe, undefined, 'only R- numbers are sent')
    mode = 'off'
    r = await tool.execute({ do: 'photo', recipe: 'R-0123456789' })
    assert.equal(sent.length, 4)
    assert.equal(sent[3].recipe, undefined)
    assert.notEqual(sent[3].ref, sent[2].ref)
    assert.match(r, /^办了：拍了一张照片。（方子拍照还没开，这张照常拍了）/)
    assert.doesNotMatch(r, /没成|off/)
    // the town could not get the recipe and shot it as usual: its recipe_note is read to her as written
    mode = 'gone'
    r = await tool.execute({ do: 'photo', recipe: 'R-0123456789' })
    assert.equal(sent.length, 5)
    assert.match(r, /^办了：拍了一张照片。（没有「R-0123456789」这个方子：照常拍）/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('0.9.19 owner said: his picture is noted only in the owner chat; 「4 星」 within 30 min of photo_done is sent once to the town; a 404 is quiet', async () => {
  const { createOwnerSaid } = await import('../lib/gallery.js')
  const { messageText, ownerText } = await import('../lib/cobuild.js')
  let t = 1_800_000_000_000
  const gallery = createGallery({ state: {}, now: () => t })
  const sent = []
  let reply = { ok: true, score: 4 }
  const client = { photoRate: async (b) => { sent.push(b); if (reply instanceof Error) throw reply; return reply } }
  const said = createOwnerSaid({ gallery, isOwnerChat: (sid) => sid === 'main', client: () => client, textOf: (m) => ownerText(messageText(m)) })
  const msg = (text, img) => ({ content: [{ type: 'text', text }, ...(img ? [{ type: 'image', attachment: { attachmentId: img } }] : [])] })
  assert.equal(said('main', msg('4 星')), null, 'no photo yet: nothing sent')
  said('qq', msg('看这张', 'a1'))
  assert.equal(gallery.latestPic('qq'), null, 'not his chat with her')
  said('main', msg('看这张', 'a2'))
  assert.equal(gallery.latestPic('main').attachmentId, 'a2')
  gallery.photoDone('sm_5')
  t += 5 * 60_000
  assert.equal(said('qq', msg('4 星')), null)
  await said('main', msg('[2026-11-26 12:00:01]\n4 星'))
  assert.deepEqual(sent, [{ orderId: 'sm_5', score: 4 }])
  assert.equal(said('main', msg('这张不错')), null)
  reply = new TownError('HTTP_404', 404, '')
  assert.equal(await said('main', msg('5 星')), null, 'the town has no rating yet: quiet')
  t += RATE_FOR_MS
  assert.equal(said('main', msg('3 星')), null, 'too late')
})
