// 0.9.17 进房间（室内表达力会话 11-24，小镇 feat/1125-room-links）：室内放好了，她拿到一条进屋看的链接 https://island.fishbowltown.com/?in=L-xxxx——
// 确认回执里、先「照片在检查」后「放好了」的那份（问岛上或小镇事件）、do=status、主人聊天的背景备注、日记那一行都带着；小镇没给就照地号拼。
// 和 AstrBot tests/test_room_link_0413.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POLL_MS, ROOM_URL, createCobuild, createOwnerWords, roomLink, seeLine } from '../lib/cobuild.js'
import { createJournal } from '../lib/journal.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'room-link')
const quiet = { info() {}, warn() {}, debug() {} }
const OWNER = 's-owner'
const ROOM = { foot: [-4, -3, 4, 3], h: 3.2, floor: 1, floors: 3, area_m2: 48, door: null, limits: { tris: 144000, kb: 19660, tex_n: 5, tex_px: 2048 } }
const INSIDE = { room: { floor: { material: 'wood' }, walls: { material: 'plaster' } }, shapes: [], lights: [{ at: [0, 2.7, 0], power: 150 }], points: {} }
const LINK = 'https://island.fishbowltown.com/?in=L-0185'
const argOf = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : '' }

function run() {
  return async ({ args }) => {
    const text = readFileSync(argOf(args, '--recipe') || argOf(args, '--from-blend'), 'utf8')
    writeFileSync(argOf(args, '--out-glb'), 'glTF ' + text)
    if (argOf(args, '--out-blend')) writeFileSync(argOf(args, '--out-blend'), 'BLEND ' + text)
    const pv = argOf(args, '--previews')
    if (pv) for (const k of ['front', 'three_quarter', 'top']) writeFileSync(join(pv, k + '.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const room = JSON.parse(readFileSync(argOf(args, '--room'), 'utf8'))
    return { ok: true, result: { ok: true, inside: true, mode: 'recipe', numbers: { bbox: room.foot, tris: 1200, kb: 90, textures: [], lights: 1, shapes: 0, floor: room.floor, room: room.foot, room_h: room.h, points: {} }, problems: [], notes: [], secs: 1 }, why: [] }
  }
}

function setup(name, { confirm = { ok: true, code: 'checking', paid_coin: 128 } } = {}) {
  const dir = join(WORK, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const t = { clock: Date.now() + 60_000 }
  const now = () => (t.clock += 10)
  const box = { list: [] }
  const town = {
    isleInteriorGuide: async (lot, floor) => ({ ok: true, lot, lot_name: '海边小屋地', floor: floor || 1, floors: 3, text: '室内说明', room_json: { ...ROOM, floor: floor || 1 }, limits: { ...ROOM.limits, in_mb: 64, floors: 3, area_m2: 48 } }),
    isleInterior: async (body) => ({ ok: true, code: 'measuring', iid: 'Iabc123456', floor: body.floor, floors: 3, text: '室内交上去了' }),
    isleInteriorConfirm: async () => confirm,
    isleInteriors: async () => ({ ok: true, interiors: box.list }),
    isleBuilds: async () => ({ ok: true, builds: [] }),
  }
  const journal = createJournal({ state: {}, now: () => t.clock })
  const ownerWords = createOwnerWords({ now })
  const cb = createCobuild({ dir, log: quiet, now, ownerWords, journal, town: () => town, find: async () => ({ ok: true, path: 'C:/blender/blender.exe', version: [5, 2, 4] }),
    run: run(), layerRun: async () => ({ ok: false, result: null, why: ['不用'] }), tell: async () => true, isOwnerChat: (sid) => sid === OWNER })
  const say = (text) => cb.observeOwner(OWNER, text)
  return { cb, t, box, journal, say }
}

async function quotedAndConfirmed(s) {
  const { cb, t, box, say } = s
  await cb.start({ lot: 'L-0185', interior: true, floor: 1 })
  await cb.make({ recipe: INSIDE })
  say('交吧')
  await cb.submit({ sid: OWNER })
  box.list = [{ iid: 'Iabc123456', state: 'quoted', coin: 128, upkeep_day_coin: 2.4, lines: [], area_m2: 48, rooms: 2 }]
  t.clock += POLL_MS + 1
  await cb.tick()
  say('就这样')
  return cb.confirm({ sid: OWNER })
}

test('roomLink: the town\'s link first (only the island room kind), else built from an L- lot; seeLine', () => {
  assert.equal(ROOM_URL, 'https://island.fishbowltown.com/?in=')
  assert.equal(roomLink({ lot: 'L-0107' }, { link: LINK }), LINK)
  assert.equal(roomLink({ lot: 'L-0107' }), 'https://island.fishbowltown.com/?in=L-0107')               // 老小镇没给：照地号拼
  assert.equal(roomLink({ lot: 'L-0107' }, { link: 'https://evil.example/?in=L-1' }), 'https://island.fishbowltown.com/?in=L-0107')
  assert.equal(roomLink({ lot: 'B-0009' }), '')                                                          // 楼号、送的家（gift:…）不拼
  assert.equal(roomLink({ lot: 'gift:abc' }), '')
  assert.equal(roomLink({ lot: 'L-0152-2' }), 'https://island.fishbowltown.com/?in=L-0152-2')           // 一块地第 2 栋起（11-25）
  assert.equal(roomLink({ lot: 'L-0152-2-3' }), '')
  assert.equal(roomLink({ lot: 'L-0152' }, { link: 'https://island.fishbowltown.com/?in=L-0152-2' }), 'https://island.fishbowltown.com/?in=L-0152-2')
  assert.equal(seeLine(''), '')
  assert.equal(seeLine(LINK), `进去看：${LINK}（发给主人，点开就进到屋里）`)
})

test('placed at once: the confirm receipt, status and the owner-chat note carry the link', async () => {
  const s = setup('at-once', { confirm: { ok: true, code: 'placed', paid_coin: 128, link: LINK, text: `放好了 ${LINK}` } })
  const c = await quotedAndConfirmed(s)
  assert.equal(c.text, `这一层的室内放好了：付了 128 鲸币。上岛以后因为没有室内停业的店自己开门。进去看：${LINK}（发给主人，点开就进到屋里）`)
  assert.match((await s.cb.status()).text, new RegExp(`海边小屋地.*1 楼室内放好了。进去看：${LINK.replace(/[?.]/g, '\\$&')}`))
  assert.match(s.cb.contextLine(), /^你和主人做的 .*1 楼室内放好了，主人想看就把这个链接发给他：https:\/\/island\.fishbowltown\.com\/\?in=L-0185$/)
  const news = s.journal.newsLines(5).join('\n')
  assert.ok(news.includes(LINK), news)
})

test('checking first, then placed: polling the island finds it, the note and status carry the link (no link from an old town: built from the lot)', async () => {
  const s = setup('checking')
  const c = await quotedAndConfirmed(s)
  assert.match(c.text, /确认了：付了 128 鲸币。这一层的照片在过看图检查/)
  assert.doesNotMatch(c.text, /island\.fishbowltown/)
  assert.doesNotMatch(s.cb.contextLine(), /island\.fishbowltown/)                                     // 还在检查：不给链接
  s.box.list = [{ iid: 'Iabc123456', state: 'checking', coin: 128 }]
  s.t.clock += POLL_MS + 1
  await s.cb.tick()
  assert.ok(!s.journal.newsLines(9).join('\n').includes('放上岛了'))
  s.box.list = [{ iid: 'Iabc123456', state: 'placed', coin: 128 }]                                      // 老小镇：没有 link
  s.t.clock += POLL_MS + 1
  await s.cb.tick()
  const news = s.journal.newsLines(9).join('\n')
  assert.match(news, /过了检查，放上岛了。进去看： https:\/\/island\.fishbowltown\.com\/\?in=L-0185/)
  assert.match(s.cb.contextLine(), /放好了，主人想看就把这个链接发给他：https:\/\/island\.fishbowltown\.com\/\?in=L-0185/)
  assert.match((await s.cb.status()).text, /1 楼室内放好了。进去看：https:\/\/island\.fishbowltown\.com\/\?in=L-0185/)
})

test('checking first, then the town event inside_placed: the link from the event', async () => {
  const s = setup('event')
  await quotedAndConfirmed(s)
  s.cb.onEvent({ kind: 'isle_build', data: { what: 'inside_placed', iid: 'Iabc123456', lot: 'L-0185', link: 'https://island.fishbowltown.com/?in=L-0185' } })
  assert.match(s.journal.newsLines(9).join('\n'), /过了检查，放上岛了。进去看： https:\/\/island\.fishbowltown\.com\/\?in=L-0185/)
  assert.match(s.cb.contextLine(), /主人想看就把这个链接发给他：https:\/\/island\.fishbowltown\.com\/\?in=L-0185/)
})

test('checking, then refused: she is told it did not go up, and the draft can be handed in again', async () => {
  const s = setup('refused')
  await quotedAndConfirmed(s)
  s.box.list = [{ iid: 'Iabc123456', state: 'refused', problems: ['照片里有不合适的图'] }]
  s.t.clock += POLL_MS + 1
  await s.cb.tick()
  assert.match(s.journal.newsLines(9).join('\n'), /没过照片检查，没上岛：照片里有不合适的图/)
  assert.doesNotMatch(s.cb.contextLine(), /island\.fishbowltown/)
  await s.cb.start({ lot: 'L-0185', interior: true, floor: 1 })                                       // 接着做同一份草稿
  assert.deepEqual(s.cb.active().refused.problems, ['照片里有不合适的图'])
  assert.equal(s.cb.active().placed, null)
  assert.match((await s.cb.status()).text, /上次交的室内岛上没收：照片里有不合适的图/)
})

test('newsLines: a long line keeps the island room link whole at the end; other links are cut as before', () => {
  const t = { clock: Date.now() }
  const j = createJournal({ state: {}, now: () => t.clock })
  const long = '你和主人一起做的 海边小屋地（L-0185）的 1 楼室内过了检查，放上岛了，客人进门就能看到柜台、两张桌子和窗边的灯，主人一定会喜欢的。进去看：' + LINK + '（发给主人，点开就进到屋里）'
  j.event('build', long)
  j.event('build', '别的鱼说：去看看这个 https://example.com/' + 'x'.repeat(80))
  const [other, mine] = j.newsLines(5)
  assert.ok(mine.endsWith(' ' + LINK), mine)
  assert.ok([...mine.replace(' ' + LINK, '')].length <= 61, mine)
  assert.doesNotMatch(other, /example\.com\/x{80}/)
  const second = 'https://island.fishbowltown.com/?in=L-0152-2'                                          // 一块地第 2 栋起（11-25）：整条留着
  j.event('build', long.replace(LINK, second))
  assert.ok(j.newsLines(1)[0].endsWith(' ' + second), j.newsLines(1)[0])
})
