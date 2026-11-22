// 0.9.12 一层室内也和主人一起做（cobuild.js：start interior=true → room.json → recipe_to_blend.py --room → 「交吧」交上岛 → 岛上量好才报价 →
// 插件问 isle/interiors、报价来了告诉她 → 「就这样」才确认）；交楼带配方里的正门；README 那一句。室内跟着外面的楼走：几层就做几层，每层不比外面大。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSIDE_LINE, POLL_MS, createCobuild, createOwnerWords } from '../lib/cobuild.js'
import { BUILD_DESCRIPTION, createBuildTool } from '../lib/cobuild-tool.js'
import { createTownClient } from '../lib/town-client.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'cobuild-interior')
const quiet = { info() {}, warn() {}, debug() {} }
const OWNER = 's-owner'
const ROOM = { foot: [-4, -3, 4, 3], h: 3.2, floor: 2, floors: 3, area_m2: 48, door: null, limits: { tris: 144000, kb: 19660, tex_n: 5, tex_px: 2048 } }
const INSIDE = { room: { floor: { material: 'wood' }, walls: { material: 'plaster' } }, shapes: [], lights: [{ at: [0, 2.7, 0], power: 150 }], points: { table: [0, 0.75, 0], seats: [[0, 0.45, 0.8]] } }
const LOT_JSON = { w: 12, d: 10, limits: { tris: 150000, kb: 6144, h: 300, tex_n: 4, tex_px: 1024, shapes: 4000, shapes_json_kb: 1024 } }
const argOf = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : '' }

function fresh(name) {
  const d = join(WORK, name)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  return d
}

function fakeBlender() {
  const calls = []
  const run = async ({ blender, args }) => {
    calls.push({ blender, args })
    const text = readFileSync(argOf(args, '--recipe') || argOf(args, '--from-blend'), 'utf8')
    writeFileSync(argOf(args, '--out-glb'), 'glTF ' + text)
    if (argOf(args, '--out-blend')) writeFileSync(argOf(args, '--out-blend'), 'BLEND ' + text)
    const pv = argOf(args, '--previews')
    if (pv) for (const k of ['front', 'three_quarter', 'top']) writeFileSync(join(pv, k + '.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    if (argOf(args, '--room')) {
      const room = JSON.parse(readFileSync(argOf(args, '--room'), 'utf8'))
      const r = JSON.parse(text)
      return { ok: true, result: { ok: true, inside: true, mode: 'recipe', numbers: { bbox: room.foot, tris: 1200, kb: 90, textures: [], lights: r.lights.length, shapes: r.shapes.length, floor: room.floor, room: room.foot, room_h: room.h, points: {} }, problems: [], notes: [], secs: 1 }, why: [] }
    }
    const r = JSON.parse(text)
    return { ok: true, result: { ok: true, mode: 'recipe', numbers: { bbox: [-3, -2, 3, 2], h: 4.5, footprint_m2: 24, tris: 28, kb: 12, objects: 2, shapes: r.shapes.length, ...(r.door ? { door: r.door } : {}) }, problems: [], notes: [], secs: 1 }, why: [] }
  }
  return { calls, run, layerRun: async () => ({ ok: false, result: null, why: ['不用'] }) }
}

function fakeTown() {
  const sent = []
  const box = { list: [] }
  return {
    sent, box,
    isleBuildGuide: async (lot) => { sent.push({ what: 'guide', lot }); return { ok: true, lot, lot_name: '海边小屋地', text: '【建模说明】……', limits: LOT_JSON.limits, lot_json: LOT_JSON } },
    isleBuild: async (body) => { sent.push({ what: 'build', ...body }); return { ok: true, build_id: 'b-1', quote: { coin: 120, upkeep_day_coin: 2, lines: [] } } },
    isleBuildConfirm: async (body) => { sent.push({ what: 'confirm', ...body }); return { ok: true, paid_coin: 120, upkeep_day_coin: 2 } },
    isleBuilds: async () => ({ ok: true, builds: [] }),
    isleInteriorGuide: async (lot, floor) => {
      sent.push({ what: 'inside_guide', lot, floor })
      if (floor === 4) return { ok: false, code: 'bad', text: '室内第 4 层做不了：外面的楼只有 3 层（室内跟着外面的楼走，floor 写 1 到 3）' }
      return { ok: true, lot, lot_name: '海边小屋地', floor: floor || 1, floors: 3, text: '室内说明……【跟着外面的楼】……', room_json: { ...ROOM, floor: floor || 1 }, limits: { ...ROOM.limits, in_mb: 64, floors: 3, area_m2: 48 } }
    },
    isleInterior: async (body) => { sent.push({ what: 'inside', ...body }); return { ok: true, code: 'measuring', iid: 'Iabc123456', floor: body.floor, floors: 3, text: '室内交上去了' } },
    isleInteriorConfirm: async (body) => { sent.push({ what: 'inside_confirm', ...body }); return { ok: true, code: 'checking', paid_coin: 128.0, text: '付了' } },
    isleInteriors: async () => { sent.push({ what: 'inside_list' }); return { ok: true, interiors: box.list } },
  }
}

function setup(name) {
  const dir = fresh(name)
  const t = { clock: Date.now() + 60_000 }
  const now = () => (t.clock += 10)
  const told = []
  const b = fakeBlender()
  const town = fakeTown()
  const ownerWords = createOwnerWords({ now })
  const cb = createCobuild({ dir, log: quiet, now, ownerWords, town: () => town, find: async () => ({ ok: true, path: 'C:/blender/blender.exe', version: [5, 2, 4] }), run: b.run, layerRun: b.layerRun,
    tell: async (text) => { told.push(text); return true }, isOwnerChat: (sid) => sid === OWNER })
  return { dir, cb, b, town, told, t, say: (text) => cb.observeOwner(OWNER, text) }
}

test('a floor of the inside: start gets the room, make runs --room into floorN.glb, 「交吧」 hands it in, the quote comes by polling, 「就这样」 confirms', async () => {
  const { cb, b, town, told, t, say } = setup('flow')
  const s = await cb.start({ lot: 'L-0185', idea: '一个柜台、两张桌子', interior: true, floor: 2 })
  assert.deepEqual(town.sent[0], { what: 'inside_guide', lot: 'L-0185', floor: 2 })
  assert.match(s.text, /开始和主人做 海边小屋地（L-0185）的 2 楼室内了/)
  assert.ok(s.text.includes(INSIDE_LINE) && s.text.includes('这栋楼外面 3 层') && s.text.includes('这一层 48 平方米') && s.text.includes('floor2.glb') && s.text.includes('【室内说明】'), s.text)
  const d = cb.active()
  assert.equal(d.kind, 'interior')
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(cb.workFile(d)), 'room.json'), 'utf8')).foot, ROOM.foot)
  assert.equal(basename(cb.workFile(d)), 'floor2.blend')
  const bad = await cb.make({ recipe: { shapes: 'sofa' } })
  assert.match(bad.text, /shapes 要写成清单/)
  const m = await cb.make({ recipe: INSIDE })                                                  // 家具可以一个都没有
  const args = b.calls.at(-1).args
  assert.ok(argOf(args, '--room').endsWith('room.json') && argOf(args, '--out-glb').endsWith('floor2.glb') && !args.includes('--lot'), args.join(' '))
  assert.match(m.text, /这一层 8 × 6 米、层高 3.2 米/)
  assert.match(m.text, /都在这一层的上限里，能交/)
  assert.match((await cb.submit({ sid: OWNER })).text, /还没在这里亲口说话/)
  say('交吧')
  const sub = await cb.submit({ sid: OWNER })
  const sent = town.sent.find((x) => x.what === 'inside')
  assert.equal(sent.floor, 2)
  assert.equal(sent.ownerWords, '交吧')
  assert.equal(sent.name, 'floor2.glb')
  assert.ok(String(sent.glb).startsWith('glTF'))
  assert.match(sub.text, /量好了才报价，一般几分钟/)
  town.box.list = [{ iid: 'Iabc123456', state: 'measuring' }]
  assert.match((await cb.confirm({ sid: OWNER })).text, /岛上还在量这一层/)
  assert.match(cb.contextLine(), /交上去了，岛上在量/)
  const asks = town.sent.filter((x) => x.what === 'inside_list').length
  await cb.tick()
  assert.equal(town.sent.filter((x) => x.what === 'inside_list').length, asks)                   // 一分钟问一次
  town.box.list = [{ iid: 'Iabc123456', state: 'quoted', coin: 128, upkeep_day_coin: 2.4, lines: ['起步 50 鲸币', '面积 48 平方米（1 层）：每平方米 1 鲸币，48 鲸币；含 4.8 万面、4.8 MB'], area_m2: 48, rooms: 2 }]
  t.clock += POLL_MS + 1
  await cb.tick()
  assert.equal(told.length, 1)
  assert.match(told[0], /室内报价/)
  assert.match(told[0], /岛上量好了 海边小屋地的 2 楼室内：128 鲸币，每天物业 2.4 鲸币（48 平方米，合 2 间客房）。怎么算的：起步 50 鲸币；面积 48 平方米/)
  assert.match(told[0], /「就这样」/)
  assert.match(cb.contextLine(), /报价 128 鲸币/)
  assert.match((await cb.confirm({ sid: OWNER })).text, /还没在这里亲口说话/)                 // 「交吧」是报价以前说的
  say('不行，太贵了')
  assert.match((await cb.confirm({ sid: OWNER })).text, /听着不像让你确认/)
  say('就这样')
  const c = await cb.confirm({ sid: OWNER })
  assert.deepEqual(town.sent.find((x) => x.what === 'inside_confirm'), { what: 'inside_confirm', iid: 'Iabc123456', owner_words: '就这样' })
  assert.match(c.text, /确认了：付了 128 鲸币。这一层的照片在过看图检查/)
  assert.equal(cb.active(), null)
  for (const x of [s.text, m.text, sub.text, c.text, told[0]]) assert.ok(!/[¥元]|饭票|充值/.test(x), x)
})

// 室内的报价也给她最多 8 行「怎么算的」（和楼一样；面数、文件、每天物业在后面，不截在前 4 行）
test('the inside quote 「怎么算的」 lines all reach her too (same 8-line cut as the house)', async () => {
  const { cb, town, told, t, say } = setup('quote-lines')
  await cb.start({ lot: 'L-0185', interior: true, floor: 1 })
  await cb.make({ recipe: INSIDE })
  say('交吧')
  await cb.submit({ sid: OWNER })
  const lines = ['起步 50 鲸币', '面积 120 平方米（1 层）：每平方米 1 鲸币，120 鲸币；含 12 万面、12 MB', '面数 20 万面（含 12 万）：多出来的 8 万面 800 鲸币',
    '文件 30 MB（含 12 MB）：含量 1–2 倍的 12 MB 1200 鲸币', '文件 30 MB：含量 2–4 倍的 6 MB 2400 鲸币', '每天物业 6 鲸币（每平方米 0.05）', '每天物业另加多出来的文件 18 MB × 5 = 90 鲸币']
  town.box.list = [{ iid: 'Iabc123456', state: 'quoted', coin: 4570, upkeep_day_coin: 96, lines, area_m2: 120, rooms: 6 }]
  t.clock += POLL_MS + 1
  await cb.tick()
  assert.equal(told.length, 1)
  for (const x of lines) assert.ok(told[0].includes(x), `missing: ${x}`)
  assert.match(cb.contextLine(), /报价 4570 鲸币/)
})

test('a refused floor says why; a floor the outside does not have is refused by the island with both numbers; the owner page confirm is seen', async () => {
  const { cb, town, told, t, say } = setup('refused')
  const no = await cb.start({ lot: 'L-0185', interior: true, floor: 4 })
  assert.match(no.text, /外面的楼只有 3 层/)
  assert.match((await cb.start({ lot: 'L-0185', interior: true, floor: 0 })).text, /floor 写第几层/)
  await cb.start({ lot: 'L-0185', interior: true })
  assert.equal(town.sent.at(-1).floor, null)                                                     // 不写：岛上定（按天租的铺位是她那一层）
  await cb.make({ recipe: INSIDE })
  say('可以，交吧')
  await cb.submit({ sid: OWNER })
  town.box.list = [{ iid: 'Iabc123456', state: 'refused', problems: ['1 楼室内 10.0×8.0 米，比外面这一层 8.6×6.0 米大'] }]
  t.clock += POLL_MS + 1
  await cb.tick()
  assert.match(told.at(-1), /岛上没收 海边小屋地的 1 楼室内（什么都没扣）：1 楼室内 10.0×8.0 米，比外面这一层 8.6×6.0 米大/)
  assert.match((await cb.status()).text, /上次交的室内岛上没收/)
  say('交吧')
  await cb.submit({ sid: OWNER })
  town.box.list = [{ iid: 'Iabc123456', state: 'checking', coin: 99, upkeep_day_coin: 2, lot: 'L-0185', lot_name: '海边小屋地', floors: [1], rooms: 2 }]   // 主人在账户页点了确认
  const st = await cb.status()
  assert.equal(cb.active(), null)
  assert.match(st.text, /交过的室内：海边小屋地 1 楼（照片在检查，99 鲸币，合 2 间客房）/)
})

test('the house hand-in carries the recipe door; old events without an id never close an inside', async () => {
  const { cb, town, say } = setup('door')
  await cb.start({ lot: 'L-0107' })
  await cb.make({ recipe: { shapes: [{ type: 'box', pos: [0, 0, 0], size: [6, 3, 4] }], door: { side: 'left', at: 0.5 } } })
  say('交吧')
  await cb.submit({ sid: OWNER })
  assert.deepEqual(town.sent.find((x) => x.what === 'build').door, { side: 'left', at: 0.5 })
  const { cb: cb2, say: say2 } = setup('event')
  await cb2.start({ lot: 'L-0185', interior: true })
  await cb2.make({ recipe: INSIDE })
  say2('交吧')
  await cb2.submit({ sid: OWNER })
  cb2.onEvent({ kind: 'isle_build', data: { what: 'placed', lot: 'L-0185' } })                  // 老的楼事件（没有号）：不是这一层
  assert.ok(cb2.active())
  cb2.onEvent({ kind: 'isle_build', data: { what: 'inside_placed', iid: 'Iabc123456', coin: 50 } })
  assert.equal(cb2.active(), null)
})

test('the town client sends the door and the floor as form fields; the tool takes interior and floor; the README says the inside rule', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, iid: 'I1', code: 'measuring' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const c = createTownClient({ base: 'https://town.test/town/api/outside/', code: 'fbo_test', fetchImpl })
  await c.isleBuild({ lot: 'L-1', ownerWords: '交吧', glb: Buffer.from('glTF'), door: { side: 'back', at: -1 } })
  assert.equal(seen[0].init.body.get('door'), '{"side":"back","at":-1}')
  await c.isleInterior({ lot: 'L-1', floor: 2, ownerWords: '交吧', glb: Buffer.from('glTF'), name: 'floor2.glb' })
  assert.ok(seen[1].url.endsWith('isle/interior'))
  assert.equal(seen[1].init.body.get('floor'), '2')
  assert.equal(seen[1].init.body.get('file').name, 'floor2.glb')
  await c.isleInteriorGuide('L-1', 3)
  assert.match(seen[2].url, /isle\/interior_guide\?lot=L-1&floor=3/)
  await c.isleInteriors()
  assert.match(seen[3].url, /isle\/interiors$/)
  let got = null
  const tool = createBuildTool({ cobuild: { start: async (a) => { got = a; return { text: 'ok' } } } })
  await tool.execute({ do: 'start', lot: 'L-1', interior: true, floor: 2 }, { agent: { session: { id: OWNER } } })
  assert.deepEqual(got, { lot: 'L-1', idea: undefined, interior: true, floor: 2 })
  assert.ok(tool.parameters.properties.interior && tool.parameters.properties.floor && BUILD_DESCRIPTION.includes(INSIDE_LINE))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const k = readme.indexOf('楼的面数、文件大小、高度按这块地的上限')
  assert.ok(k > 0 && readme.slice(k, k + 200).includes(INSIDE_LINE))
  const vendored = readFileSync(join(ROOT, 'lib', 'cobuild', 'README.md'), 'utf8')
  assert.ok(vendored.includes(INSIDE_LINE) && vendored.includes('area_m2'))
})
