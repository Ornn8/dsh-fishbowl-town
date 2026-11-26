// 0.9.19 拍照店家（小镇 feat/1126-photo-studio）：自己拍照写 studio 店号就带上；小镇照官方拍时的 studio_note 原话带给她；
// 押上了回执里写由哪家店拍、加价多少；加价押不上走「没成」；相册里店家拍的照片下面原样那一句「由「…」拍」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSocialServe, createSocialTools } from '../lib/social-tools.js'
import { albumBy, createExtras, renderAlbum } from '../lib/extras.js'

function photoTool(reply) {
  const dir = mkdtempSync(join(tmpdir(), 'fst-'))
  const sent = []
  const client = {
    bonds: async () => ({ friends: [] }),
    lobby: async () => ({ fish: [] }),
    photo: async (b) => { sent.push(b); return reply(b) },
  }
  const live = () => ({ client })
  const social = createSocialServe({ live, journal: { event() {} }, extras: createExtras({ live, stateDir: dir }), diary: { note() {} } })
  return { tool: createSocialTools({ social })[0], sent, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const BY = '由「暖光照相馆」拍'

test('0.9.19 studio: a P- shop number is sent (lower-cased), anything else is not; the receipt says who shot it and the extra', async () => {
  const w = photoTool((b) => ({ order_id: 'sm_1', state: 'making', ...(b.studio ? { studio: { shop: '暖光照相馆', kind: 'photo', style: '胶片暖调', fee: 20, text: '', by: BY } } : {}) }))
  try {
    assert.ok(w.tool.parameters.properties.studio)
    assert.match(w.tool.description, /找店家拍写 studio 店号/)
    let r = await w.tool.execute({ do: 'photo', studio: ' P-0A1B2C3D ' })
    assert.equal(w.sent[0].studio, 'P-0a1b2c3d')
    assert.match(r, /^办了：拍了一张照片，由「暖光照相馆」拍（胶片暖调），加价 20 鲸币。/)
    for (const bad of ['P-123', '暖光照相馆', 'R-0123456789', 12345678]) {
      r = await w.tool.execute({ do: 'photo', studio: bad })
      assert.equal(w.sent.at(-1).studio, undefined, `not sent: ${bad}`)
      assert.doesNotMatch(r, /由「/)
    }
  } finally { w.done() }
})

test('0.9.19 studio: the town shot it as the official one -> its studio_note is read to her as written; a paint shop says 画', async () => {
  let mode = 'note'
  const w = photoTool((b) => mode === 'note'
    ? { order_id: 'sm_2', state: 'making', studio_note: '「暖光照相馆」今天没开门：这张照官方拍了' }
    : { order_id: 'sm_3', state: 'making', studio: { shop: '小林画铺', kind: 'paint', style: '水彩', fee: 0, by: '由「小林画铺」画' } })
  try {
    let r = await w.tool.execute({ do: 'photo', studio: 'P-0a1b2c3d' })
    assert.match(r, /^办了：拍了一张照片。（「暖光照相馆」今天没开门：这张照官方拍了）/)
    mode = 'paint'
    r = await w.tool.execute({ do: 'photo', studio: 'P-0a1b2c3d' })
    assert.match(r, /由「小林画铺」画（水彩）。/)
    assert.doesNotMatch(r, /加价/)                                                    // 不加价不提
  } finally { w.done() }
})

test('0.9.19 studio: the extra cannot be held -> 「没成」 with the town\'s words, nothing spent; with a recipe too both go and the town picks', async () => {
  let short = true
  const w = photoTool((b) => (short && b.studio
    ? { ok: false, code: 'STUDIO_SHORT', reason: '「暖光照相馆」的加价 120 鲸币付不起，这张没拍，什么都没扣。' }
    : { order_id: 'sm_4', state: 'making' }))
  try {
    let r = await w.tool.execute({ do: 'photo', studio: 'P-0a1b2c3d' })
    assert.match(r, /^没成：「暖光照相馆」的加价 120 鲸币付不起，这张没拍，什么都没扣。（STUDIO_SHORT）。没花钱。$/)
    short = false
    r = await w.tool.execute({ do: 'photo', studio: 'P-0a1b2c3d', recipe: 'R-0123456789' })
    assert.equal(w.sent.at(-1).studio, 'P-0a1b2c3d')
    assert.equal(w.sent.at(-1).recipe, 'R-0123456789')
  } finally { w.done() }
})

test('0.9.19 studio: recipe photos off -> the retry without the recipe still carries the shop', async () => {
  const w = photoTool((b) => (b.recipe ? { ok: false, code: 'off', reason: '方子拍照没开' } : { order_id: 'sm_5', state: 'making' }))
  try {
    const r = await w.tool.execute({ do: 'photo', studio: 'P-0a1b2c3d', recipe: 'R-0123456789' })
    assert.equal(w.sent.length, 2)
    assert.equal(w.sent[1].recipe, undefined)
    assert.equal(w.sent[1].studio, 'P-0a1b2c3d')
    assert.match(r, /方子拍照还没开，这张照常拍了/)
  } finally { w.done() }
})

test('0.9.19 album: a shop-shot photo carries the town\'s by line verbatim under it; other photos read as before', () => {
  assert.equal(albumBy({ studio: { by: BY } }), BY)
  assert.equal(albumBy({ by: '由「小林画铺」画' }), '由「小林画铺」画')
  assert.equal(albumBy({ what: '照片' }), '')
  assert.equal(albumBy(null), '')
  const out = renderAlbum({ items: [
    { item_id: 'a1', kind: 'photo', what: '你的胶片照', price_yuan: '0.25', studio: { shop: '暖光照相馆', by: BY } },
    { item_id: 'a2', kind: 'photo', what: '你的普通照', price_yuan: '0.10' },
  ] }, { files: new Map([['a1', '/x/a1.webp']]), name: '你' })
  const lines = out.split('\n')
  const i = lines.findIndex((l) => l.includes('你的胶片照'))
  assert.equal(lines[i + 1], '  文件：/x/a1.webp')
  assert.equal(lines[i + 2], '  ' + BY)
  const j = lines.findIndex((l) => l.includes('你的普通照'))
  assert.doesNotMatch(lines[j + 1] || '', /由「/)
})
