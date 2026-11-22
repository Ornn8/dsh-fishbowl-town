// 0.9.10 主人和鱼一起盖楼（cobuild.js / cobuild-tool.js）：找 Blender、只跑插件自带的两个固定脚本、主人亲手打的「交吧」「盖吧」、
// 主人在 Blender 里改了能看出来、她再改配方时他改的那一层留着、本机先查、鲸币不够照实说。最后一段用这台电脑上真的 Blender 跑一遍（没有就跳过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BLENDER_URL, LAYER_FILE, NEED_BLENDER, SCRIPT_FILE, SCRIPT_SHA256, blenderCandidates, blenderText, changesLine, createCobuild, createOwnerWords,
  emptyLotsIn, findBlender, isYes, lowPriority, mdPath, messageText, numbersLine, parseBlenderVersion, parseResult, runBlender, versionOk,
} from '../lib/cobuild.js'
import { BUILD_DESCRIPTION, BUILD_TOOL, createBuildTool } from '../lib/cobuild-tool.js'
import { BUILD_STEP } from '../lib/guide.js'
import { ISLE_BUILD_NOTE } from '../lib/prompt.js'
import { CHAT_TOOL_NAMES, createChatTools } from '../lib/chat-tools.js'
import { BUILD_HERE } from '../lib/isle-tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'cobuild')
const quiet = { info() {}, warn() {}, debug() {} }
const OWNER = 's-owner'
const LOT_JSON = { w: 12, d: 10, limits: { tris: 150000, kb: 6144, h: 300, tex_n: 4, tex_px: 1024, shapes: 4000, shapes_json_kb: 1024 } }
const RECIPE = { shapes: [{ type: 'box', pos: [0, 0, 0], size: [6, 3, 4], material: 'plaster', color: '#f2e2c4' }, { type: 'gable', pos: [0, 3, 0], size: [6, 1.5, 4], material: 'tile' }] }

function fresh(name) {
  const d = join(WORK, name)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  return d
}
const argOf = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : '' }

// ---- 假的 Blender：照参数写文件、回脚本那一行 JSON 的样子 ----
function fakeBlender() {
  const calls = []
  const numbersFor = (text) => {
    let h = 4.5
    try { const r = JSON.parse(text); h = Math.max(...r.shapes.map((s) => (s.pos?.[1] || 0) + (s.size?.[1] || s.h || 0))) } catch { if (text.includes('taller')) h = 7.5 }
    if (text.includes('taller')) h = 7.5
    return { bbox: [-3, -2, 3, 2], h, below: 0, footprint_m2: 24, tris: text.includes('taller') ? 40 : 28, kb: 12, objects: text.includes('taller') ? 3 : 2 }
  }
  const previews = (dir) => { if (dir) for (const k of ['front', 'three_quarter', 'top']) writeFileSync(join(dir, k + '.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) }
  const run = async ({ blender, args }) => {
    calls.push({ script: 'recipe', blender, args })
    if (args[0] === '--recipe') {
      const text = readFileSync(args[1], 'utf8')
      const r = JSON.parse(text)
      writeFileSync(argOf(args, '--out-blend'), 'BLEND ' + text)
      writeFileSync(argOf(args, '--out-glb'), 'GLB ' + text)
      previews(argOf(args, '--previews'))
      const numbers = { ...numbersFor(text), shapes: r.shapes.length }
      const problems = numbers.h > 300 ? [`高 ${numbers.h} 米，这块地最多 300 米`] : []
      return { ok: true, result: { cobuild: 1, ok: true, mode: 'recipe', numbers, problems, notes: [], secs: 1.2 }, why: [] }
    }
    if (args[0] === '--from-blend') {
      const text = readFileSync(args[1], 'utf8')
      if (text.includes('broken')) return { ok: false, result: null, why: ['这个 .blend 打不开'] }
      writeFileSync(argOf(args, '--out-glb'), 'GLB ' + text)
      previews(argOf(args, '--previews'))
      return { ok: true, result: { cobuild: 1, ok: true, mode: 'blend', numbers: numbersFor(text), problems: [], notes: [], secs: 0.8 }, why: [] }
    }
    return { ok: false, result: null, why: ['不认识的参数'] }
  }
  const layerRun = async ({ blender, args }) => {
    calls.push({ script: 'layer', blender, args })
    if (args[0] === 'diff') {
      writeFileSync(argOf(args, '--out-layer'), 'LAYER ' + readFileSync(argOf(args, '--owner'), 'utf8'))
      return { ok: true, result: { owner_layer: 1, ok: true, stale: false, layer: ['Chimney', '001 box plaster'], added: ['Chimney'], changed: ['001 box plaster'], kept: [], deleted: [], materials: [] }, why: [] }
    }
    if (args[0] === 'apply') {
      writeFileSync(argOf(args, '--out'), readFileSync(argOf(args, '--base'), 'utf8') + '\n' + readFileSync(argOf(args, '--layer'), 'utf8'))
      return { ok: true, result: { owner_layer: 1, ok: true, removed: ['001 box plaster'], added: ['Chimney', '001 box plaster'], materials: [] }, why: [] }
    }
    return { ok: false, result: null, why: ['不认识的参数'] }
  }
  return { calls, run, layerRun }
}

function fakeTown({ confirm = [{ ok: true, paid_coin: 120, upkeep_day_coin: 2, text: '楼上岛了' }] } = {}) {
  const sent = []
  const answers = confirm.slice()
  return {
    sent,
    isleBuildGuide: async (lot) => { sent.push({ what: 'guide', lot }); return { ok: true, lot, lot_name: '海边小屋地', text: '【建模说明】形状清单……', limits: LOT_JSON.limits, lot_json: LOT_JSON } },
    isleBuild: async (body) => { sent.push({ what: 'build', ...body }); return { ok: true, build_id: 'b-1', quote: { coin: 120, upkeep_day_coin: 2, lines: ['占地 24 平方米'] } } },
    isleBuildConfirm: async (body) => { sent.push({ what: 'confirm', ...body }); return answers.length > 1 ? answers.shift() : answers[0] },
    isleBuilds: async () => ({ ok: true, builds: [] }),
  }
}

function setup(name, { found = { ok: true, path: 'C:/blender/blender.exe', version: [5, 2, 4], configured: true, confMissing: false, why: '' }, town = fakeTown(), owner = OWNER } = {}) {
  const dir = fresh(name)
  let clock = Date.now() + 60_000
  const now = () => (clock += 10)
  const told = []
  const b = fakeBlender()
  const ownerWords = createOwnerWords({ now })
  const journal = { j: [], event(kind, text) { this.j.push({ kind, text }) } }
  const cb = createCobuild({
    dir, log: quiet, now, ownerWords, journal, town: () => town, find: async () => found, run: b.run, layerRun: b.layerRun,
    tell: async (text) => { told.push(text); return true }, isOwnerChat: (sid) => sid === owner,
  })
  return { dir, cb, b, town, told, ownerWords, journal, say: (text, sid = owner) => cb.observeOwner(sid, text) }
}

test('the vendored recipe_to_blend.py is the island\'s file byte for byte; owner_layer.py is there', () => {
  const sha = createHash('sha256').update(readFileSync(SCRIPT_FILE)).digest('hex')
  assert.equal(sha, SCRIPT_SHA256)
  // 0.9.12 和小镇 feat/1124-door-interior（室内跟着外面的楼走）那一份一样；那个工作区不在就不比
  const server = join(ROOT, '..', 'wt-1124-door', 'ops', 'revenue-20261022', 'fishbowl-town', 'tools', 'cobuild', 'recipe_to_blend.py')
  if (existsSync(server)) assert.equal(createHash('sha256').update(readFileSync(server)).digest('hex'), SCRIPT_SHA256, 'same as the server copy')
  const layer = readFileSync(LAYER_FILE, 'utf8')
  assert.match(layer, /use_scripts=False/)
  assert.doesNotMatch(layer, /\beval\(|\bexec\(/)
})

test('Blender version: 4.2 or newer; where it looks; missing or old says 「盖楼要先装 Blender（4.2 或更新）」 with blender.org', async () => {
  assert.deepEqual(parseBlenderVersion('Blender 5.2.4\n\tbuild date: …'), [5, 2, 4])
  assert.deepEqual(parseBlenderVersion('Blender 4.2'), [4, 2, 0])
  assert.equal(parseBlenderVersion('nope'), null)
  assert.ok(versionOk([4, 2, 0]) && versionOk([5, 0, 1]) && !versionOk([4, 1, 9]) && !versionOk([3, 6, 5]))
  const win = blenderCandidates({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', BLENDER: 'D:\\B\\blender.exe', PATH: 'C:\\x' }, home: 'C:\\Users\\u', list: (d) => (d.endsWith('Blender Foundation') ? ['Blender 4.2', 'Blender 5.2', 'readme.txt'] : []) })
  assert.equal(win[0], 'D:\\B\\blender.exe')
  assert.ok(win.indexOf('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe') < win.indexOf('C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe'))
  assert.ok(win.includes('C:\\x\\blender.exe'))
  const mac = blenderCandidates({ platform: 'darwin', env: {}, home: '/Users/u', list: (d) => (d === '/Applications' ? ['Blender.app'] : []) })
  assert.ok(mac.includes('/Applications/Blender.app/Contents/MacOS/Blender'))
  assert.ok(blenderCandidates({ platform: 'linux', env: {}, home: '/home/u', list: () => [] }).includes('/usr/bin/blender'))

  const versions = { '/a/blender': [4, 1, 0], '/b/blender': [5, 2, 4], '/c/blender': [4, 2, 3] }
  const exists = (p) => p in versions
  const version = async (p) => versions[p] || null
  const env = { PATH: '/a:/c:/b' }
  const best = await findBlender({ platform: 'linux', env, home: '', list: () => [], exists, version })
  assert.equal(best.ok, true)
  assert.equal(best.path, '/b/blender', 'the newest one')
  const conf = await findBlender({ configured: '/c/blender', platform: 'linux', env, home: '', list: () => [], exists, version })
  assert.equal(conf.path, '/c/blender')
  assert.equal(conf.configured, true)
  const old = await findBlender({ platform: 'linux', env: { PATH: '/a' }, home: '', list: () => [], exists, version })
  assert.equal(old.ok, false)
  assert.equal(old.why, 'old')
  assert.ok(blenderText(old).includes(NEED_BLENDER) && blenderText(old).includes(BLENDER_URL) && blenderText(old).includes('4.1.0'))
  const none = await findBlender({ configured: '/nowhere/blender', platform: 'linux', env: {}, home: '', list: () => [], exists, version })
  assert.equal(none.why, 'none')
  assert.equal(none.confMissing, true)
  const t = blenderText(none, { configured: '/nowhere/blender' })
  for (const w of [NEED_BLENDER, BLENDER_URL, '/nowhere/blender', '别的照常']) assert.ok(t.includes(w), w)
  assert.match(blenderText(best), /找到了 Blender 5\.2\.4/)
})

test('runBlender: background, factory settings, no auto-run scripts, low priority, time limit; her text never on the command line', async () => {
  const seen = []
  const child = () => {
    const c = new EventEmitter()
    c.pid = 4242
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)) }
    return c
  }
  const okSpawn = (file, argv, opts) => {
    seen.push({ file, argv, opts })
    const c = child()
    setImmediate(() => { c.stdout.emit('data', Buffer.from('Blender says hi\n{"cobuild": 1, "ok": true, "numbers": {"h": 4.5}}\n')); c.emit('close', 0) })
    return c
  }
  const prio = []
  const r = await runBlender({ blender: 'B', args: ['--recipe', 'r.json', '--out-blend', 'b.blend', '--out-glb', 'b.glb'], spawnImpl: okSpawn, threads: 3, priority: (pid) => prio.push(pid) })
  assert.equal(r.ok, true)
  assert.equal(r.result.numbers.h, 4.5)
  const { argv, opts } = seen[0]
  assert.deepEqual(argv.slice(0, 8), ['-b', '-t', '3', '--factory-startup', '--disable-autoexec', '--python-exit-code', '3', '--python'])
  assert.equal(argv[8], SCRIPT_FILE)
  assert.deepEqual(argv.slice(9), ['--', '--recipe', 'r.json', '--out-blend', 'b.blend', '--out-glb', 'b.glb'])
  assert.ok(!argv.includes('--python-expr') && !argv.includes('--python-text'))
  assert.equal(opts.windowsHide, true)
  assert.deepEqual(prio, [4242])
  // 到点杀掉
  const hang = (file, argv) => { seen.push({ file, argv }); return child() }
  const slow = await runBlender({ blender: 'B', args: ['--from-blend', 'x.blend'], spawnImpl: hang, timeoutMs: 30, priority: () => {} })
  assert.equal(slow.ok, false)
  assert.equal(slow.killed, true)
  assert.match(slow.why[0], /超过 0 秒还没做完|超过 \d+ 秒还没做完/)
  // 脚本说做不出来：它的话原样带回来
  const failSpawn = () => { const c = child(); setImmediate(() => { c.stdout.emit('data', Buffer.from('{"cobuild": 1, "ok": false, "why": ["第 1 个形状（box）的 size 要写成 3 个数"]}\n')); c.emit('close', 2) }); return c }
  const bad = await runBlender({ blender: 'B', args: [], spawnImpl: failSpawn, priority: () => {} })
  assert.deepEqual(bad.why, ['第 1 个形状（box）的 size 要写成 3 个数'])
  const boom = await runBlender({ blender: 'B', args: [], spawnImpl: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
  assert.match(boom.why[0], /Blender 没跑起来：ENOENT/)
  assert.equal(parseResult('{"owner_layer": 1, "ok": true}\n', '{"owner_layer":').ok, true)
  assert.equal(lowPriority(0), false)
  assert.equal(lowPriority(7, () => { throw new Error('denied') }), false)
})

test('isYes: 「交吧」「盖吧」「好」count; questions, 不/别/等等/再改/但是 and 「好看」 do not', () => {
  for (const t of ['交吧', '盖吧', '好', '好的', '可以', '可以，盖吧！', '行，交了吧', 'ok', '就这样吧', '没问题，交', '交上去吧', '确认', '嗯', '价格可以'])
    assert.equal(isYes(t), true, t)
  for (const t of ['好看', '交吗？', '要不要交', '先别交', '不交', '等等', '再改改屋顶', '可以，但是窗户大一点', '不行', '这个可以吗', '我们盖个房子吧', '太贵了', '', '   ', 'no', 'wait'])
    assert.equal(isYes(t), false, t)
  assert.equal(messageText({ content: [{ type: 'text', text: '交' }, { type: 'image' }, { type: 'text', text: '吧' }] }), '交\n吧')
  assert.equal(messageText({ content: '盖吧' }), '盖吧')
})

test('lines: numbers, what changed, markdown image paths, empty lots in a turn packet', () => {
  assert.match(numbersLine({ bbox: [-3, -2, 3, 2], h: 4.5, footprint_m2: 24, tris: 28, kb: 12 }), /占地 6 × 4 米（24 平方米），高 4\.5 米，28 个面，模型 12 KB/)
  assert.match(changesLine({ bbox: [-3, -2, 3, 2], h: 4.5, tris: 28, objects: 2 }, { bbox: [-3, -2, 3, 2.5], h: 6.5, tris: 40, objects: 3 }), /占地从 6 × 4 米变成 6 × 4\.5 米；高从 4\.5 米变成 6\.5 米；面数从 28 变成 40；物体从 2 个变成 3 个/)
  assert.match(changesLine({ h: 4.5, tris: 28 }, { h: 4.5, tris: 28 }), /都没变/)
  assert.equal(mdPath('F:\\鱼 (1)\\v1\\front.png'), 'F:/%E9%B1%BC%20%281%29/v1/front.png')
  const packet = { isle: { mine: [{ lot: 'L-0107', built: false }, { lot: 'L-0108', built: true }], text: '你承包的 L-0300（海边）还没盖楼。L-0400 有楼了。' } }
  assert.deepEqual(emptyLotsIn(packet).sort(), ['L-0107', 'L-0300'])
})

test('no Blender: start says so plainly with blender.org and asks the town nothing; status still works', async () => {
  const town = fakeTown()
  const { cb } = setup('none', { found: { ok: false, path: '', version: null, configured: false, confMissing: false, why: 'none' }, town })
  const r = await cb.start({ lot: 'L-0107', idea: '小木屋' })
  assert.ok(r.text.includes(NEED_BLENDER) && r.text.includes(BLENDER_URL))
  assert.equal(town.sent.length, 0)
  assert.ok((await cb.status()).text.includes(NEED_BLENDER))
  assert.match((await cb.make({ recipe: RECIPE })).text, /还没开始盖/)
  assert.match((await cb.start({ lot: '../../etc' })).text, /lot 要填地号/)
})

test('co-build: start → make (previews, numbers, local check) → submit only on his own 「交吧」 after he saw it → quote → confirm only on 「盖吧」', async () => {
  const town = fakeTown({ confirm: [{ ok: false, code: 'short', text: '鲸币不够：要 120，有 30' }, { ok: true, paid_coin: 120, upkeep_day_coin: 2, text: '楼盖好了：付了 120 鲸币，每天物业 2 鲸币' }] })
  const { cb, b, say, journal, dir } = setup('flow', { town })
  say('我们盖个房子吧')
  const s = await cb.start({ lot: 'l-0107', idea: '海边的小木屋，两层' })
  assert.match(s.text, /开始和主人在 海边小屋地（L-0107）上一起盖楼了/)
  assert.match(s.text, /【建模说明】/)
  assert.deepEqual(town.sent[0], { what: 'guide', lot: 'L-0107' })
  const d = cb.active()
  assert.deepEqual(JSON.parse(readFileSync(join(dir, d.id, 'lot.json'), 'utf8')), LOT_JSON)

  assert.match((await cb.make({ recipe: '这不是 JSON' })).text, /不是一段能读的 JSON/)
  assert.match((await cb.make({ recipe: { shapes: [] } })).text, /没有形状/)
  assert.equal(b.calls.length, 0, 'bad recipes never reach Blender')

  // 太高：本机查出来，交不了
  const tall = await cb.make({ recipe: { shapes: [{ type: 'box', pos: [0, 0, 0], size: [6, 400, 4] }] } })
  assert.match(tall.text, /不合这块地的规矩，现在交不了/)
  assert.match(tall.text, /高 400 米，这块地最多 300 米/)
  say('交吧')
  assert.match((await cb.submit({ sid: OWNER })).text, /还有不合规矩的地方/)
  assert.equal(town.sent.filter((x) => x.what === 'build').length, 0)

  // 合规矩的一版
  const m = await cb.make({ recipe: JSON.stringify(RECIPE) })
  assert.match(m.text, /第 2 版做好了（照你的配方做的，Blender 用了 1\.2 秒）/)
  assert.match(m.text, /都合这块地的规矩，能交/)
  assert.equal(m.previews.length, 3)
  assert.match(m.text, /!\[正面\]\(.*\/v2\/front\.png\)/)
  assert.match(m.text, /!\[斜 45°\]\(.*three_quarter\.png\)/)
  assert.ok(m.text.includes(cb.workFile()))
  assert.ok(existsSync(cb.workFile()))
  const recipeCall = b.calls.at(-1)
  assert.equal(recipeCall.args[0], '--recipe')
  assert.ok(recipeCall.args.includes('--lot'), 'checked against the lot')
  assert.ok(!recipeCall.args.some((a) => a.includes('plaster')), 'her recipe goes in a file, never on the command line')

  // 他还没在看到这一版以后说话
  let r = await cb.submit({ sid: OWNER })
  assert.match(r.text, /主人看到以后还没在这里亲口说话/)
  say('好看')
  assert.match((await cb.submit({ sid: OWNER })).text, /听着不像让你交/)
  say('交吧', 's-town')
  assert.match((await cb.submit({ sid: 's-town' })).text, /这个会话不算/)
  say('交吧')
  r = await cb.submit({ sid: OWNER })
  assert.match(r.text, /交上去了（主人的原话「交吧」一起存在楼上），岛上量好了：120 鲸币，每天物业 2 鲸币/)
  const sent = town.sent.find((x) => x.what === 'build')
  assert.equal(sent.lot, 'L-0107')
  assert.equal(sent.ownerWords, '交吧')
  assert.equal(sent.idea, '海边的小木屋，两层')
  assert.ok(Buffer.isBuffer(sent.glb))

  // 确认：要他在看到报价以后再说「盖吧」
  assert.match((await cb.confirm({ sid: OWNER })).text, /还没在这里亲口说话/)
  say('盖吧')
  r = await cb.confirm({ sid: OWNER })
  assert.match(r.text, /鲸币不够，没确认/)
  assert.match(r.text, /不要劝他换鲸币或者充值/)
  assert.doesNotMatch(r.text, /¥|元|爱发电/)
  assert.ok(!cb.data().drafts[d.id].placed)
  say('够了，盖吧')
  r = await cb.confirm({ sid: OWNER })
  assert.match(r.text, /楼盖好了：付了 120 鲸币，之后每天物业 2 鲸币/)
  assert.equal(r.text.split('楼盖好了').length, 2, r.text) // 岛上那句同样的话不重复
  const confirms = town.sent.filter((x) => x.what === 'confirm')
  assert.deepEqual(confirms.map((x) => x.owner_words), ['盖吧', '够了，盖吧'])
  assert.equal(confirms[0].build_id, 'b-1')
  assert.ok(cb.data().drafts[d.id].placed)
  assert.equal(cb.active(), null)
  assert.deepEqual(cb.data().drafts[d.id].requests.map((x) => [x.what, x.owner_words]), [['submit', '交吧'], ['confirm', '够了，盖吧']])
  assert.ok(journal.j.some((x) => x.text.includes('盖好了')))
})

test('he edits house.blend in Blender: the plugin notices, makes a new version, tells her what changed; her next recipe keeps his layer', async () => {
  const { cb, b, told, say } = setup('owner-edit')
  await cb.start({ lot: 'L-0200', idea: '小塔' })
  await cb.make({ recipe: RECIPE })
  const work = cb.workFile()
  await cb.tick()
  assert.equal(told.length, 0, 'nothing changed yet')
  writeFileSync(work, 'BLEND owner made it taller')
  await cb.tick()
  assert.equal(told.length, 1)
  assert.match(told[0], /这是插件附上的消息，不是主人说的话/)
  assert.match(told[0], /主人刚在 Blender 里亲手改了楼，插件出了第 2 版：.*高从 4\.5 米变成 7\.5 米/)
  assert.match(told[0], /他加的：Chimney；他改过的：001 box plaster/)
  assert.match(told[0], /!\[正面\]\(.*\/v2\/front\.png\)/)
  const diff = b.calls.find((c) => c.script === 'layer' && c.args[0] === 'diff')
  assert.ok(diff.args.includes('--base') && diff.args.includes('--owner') && diff.args.includes('--keep'))
  const fromBlend = b.calls.filter((c) => c.args[0] === '--from-blend')
  assert.equal(fromBlend.length, 1)
  let v = cb.data().drafts[cb.active().id].versions.at(-1)
  assert.equal(v.by, 'owner')
  assert.deepEqual(v.layer.added, ['Chimney'])
  await cb.tick()
  assert.equal(told.length, 1, 'the same save is seen once')

  // 她改配方：他那一层叠上去
  const m = await cb.make({ recipe: { shapes: [{ type: 'box', pos: [0, 0, 0], size: [8, 3, 5], material: 'wood' }] } })
  assert.match(m.text, /照你的配方做的，叠上了主人亲手改的那一层/)
  assert.match(m.text, /主人亲手改的部分留着，叠在你的新配方上：他加的：Chimney/)
  assert.match(m.text, /你配方里同名的 001 box plaster 用的是他那一份/)
  const apply = b.calls.find((c) => c.script === 'layer' && c.args[0] === 'apply')
  assert.ok(argOf(apply.args, '--layer').endsWith(join('v2', 'layer.blend')))
  assert.ok(readFileSync(work, 'utf8').includes('owner made it taller'), 'his layer is in the new house.blend')
  v = cb.data().drafts[cb.active().id].versions.at(-1)
  assert.equal(v.n, 3)
  assert.equal(v.by, 'her')
  assert.ok(v.layer)

  // 他说不要他改的了：over_owner
  const o = await cb.make({ recipe: RECIPE, over_owner: true })
  assert.match(o.text, /照主人的意思，这一版没叠他亲手改的那一层/)
  assert.match(o.text, /do="use"、version=2/)
  assert.ok(!readFileSync(work, 'utf8').includes('owner made it taller'))
  // 换回他那一版
  const u = await cb.use({ version: 2 })
  assert.match(u.text, /换回第 2 版了（主人亲手改的）/)
  assert.ok(readFileSync(work, 'utf8').includes('owner made it taller'))
  assert.match((await cb.use({ version: 99 })).text, /没有第 99 版/)

  // 他存了一个读不出来的文件：照实说，文件留着
  writeFileSync(work, 'BLEND broken')
  await cb.tick()
  assert.match(told.at(-1), /主人改过的 \.blend 插件读不出来：这个 \.blend 打不开/)
})

test('a save he makes right before 「交吧」 is shown first, not submitted unseen', async () => {
  const { cb, town, say } = setup('save-then-submit')
  await cb.start({ lot: 'L-0300' })
  await cb.make({ recipe: RECIPE })
  say('交吧')
  const st = statSync(cb.workFile())
  writeFileSync(cb.workFile(), 'BLEND owner made it taller, then said submit')
  assert.notEqual(statSync(cb.workFile()).size, st.size)
  const r = await cb.submit({ sid: OWNER })
  assert.match(r.text, /主人刚在 Blender 里亲手改了楼/)
  assert.match(r.text, /先给他看看这一版，他说交再交/)
  assert.equal(r.previews.length, 3)
  assert.equal(town.sent.filter((x) => x.what === 'build').length, 0)
  say('交吧')
  assert.match((await cb.submit({ sid: OWNER })).text, /交上去了/)
})

test('island events and turns: placed by build_id when the event has one, by lot when it does not (old towns); empty lots offered once, never pushed', async () => {
  const { cb, say } = setup('events')
  cb.seeTurn({ packet: { isle: { mine: [{ lot: 'L-0500', built: false }] } } })
  const first = cb.contextLine()
  assert.match(first, /L-0500/)
  assert.match(first, /只提这一次，他不接就算了/)
  assert.doesNotMatch(first, /充值|¥/)
  assert.equal(cb.contextLine(), '', 'once per lot')
  await cb.start({ lot: 'L-0500' })
  await cb.make({ recipe: RECIPE })
  assert.match(cb.contextLine(), /第 1 版能交/)
  say('交吧')
  await cb.submit({ sid: OWNER })
  assert.match(cb.contextLine(), /报价 120 鲸币，等主人点头/)
  cb.onEvent({ kind: 'isle_build', data: { what: 'quoted', lot: 'L-0500', coin: 120 } })
  assert.ok(cb.active(), 'a quote is not a building')
  cb.onEvent({ kind: 'isle_build', data: { what: 'placed', lot: 'L-0999', coin: 120 } })
  assert.ok(cb.active(), 'another lot')
  cb.onEvent({ kind: 'isle_build', data: { what: 'placed', build_id: 'b-other', lot: 'L-0500', coin: 120 } })
  assert.ok(cb.active(), 'same lot but another build (11-23 events name the build)')
  cb.onEvent({ kind: 'isle_build', data: { what: 'placed', lot: 'L-0500', coin: 120, by: 'owner_page' } })
  assert.equal(cb.active(), null)
  const d = Object.values(cb.data().drafts)[0]
  assert.equal(d.placed.by, 'owner_page')
  // 带 build_id 的事件按它对上（地号写的是什么都不看）
  const m = setup('events-bid')
  await m.cb.start({ lot: 'L-0501' })
  await m.cb.make({ recipe: RECIPE })
  m.say('交吧')
  assert.match((await m.cb.submit({ sid: OWNER })).text, /交上去了/)
  m.cb.onEvent({ kind: 'isle_build', data: { what: 'placed', build_id: 'b-1', lot: 'L-9999', coin: 120, by: 'plugin' } })
  assert.equal(m.cb.active(), null)
  // 新装的插件：没有空地记录时，只提一次「新添了一起盖楼」
  const n = setup('intro')
  assert.match(n.cb.contextLine(), /新添了「一起盖楼」/)
  assert.equal(n.cb.contextLine(), '')
})

test('the tool: main-chat only (masked from town sessions), session id passed for consent, previews attached when she can see images', async () => {
  assert.ok(CHAT_TOOL_NAMES.includes(BUILD_TOOL))
  const calls = []
  const fake = {
    status: async () => ({ text: 'S', previews: [] }),
    make: async (a) => { calls.push(['make', a]); return { text: 'M', previews: [join(WORK, 'p.png')] } },
    submit: async (a) => { calls.push(['submit', a]); return { text: 'SUB', previews: [] } },
    confirm: async (a) => { calls.push(['confirm', a]); return { text: 'C', previews: [] } },
  }
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, 'p.png'), Buffer.from([1, 2, 3]))
  const admitted = []
  const pictures = { canSee: async () => true, admit: async (l) => { admitted.push(...l); return l.map((_, i) => ({ id: 'a' + i })) } }
  const tool = createBuildTool({ cobuild: fake, pictures })
  const exec = { agent: { session: { id: 'sess-1' } } }
  const r = await tool.execute({ do: 'make', recipe: RECIPE }, exec)
  assert.equal(r.text, 'M')
  assert.deepEqual(r.images, [{ id: 'a0' }])
  assert.equal(admitted[0].mediaType, 'image/png')
  assert.deepEqual(tool.output.render({}, r), [{ type: 'text', text: 'M' }, { type: 'image', attachment: { id: 'a0' } }])
  await tool.execute({ do: 'submit' }, exec)
  await tool.execute({ do: 'confirm' }, exec)
  assert.deepEqual(calls.slice(1), [['submit', { sid: 'sess-1' }], ['confirm', { sid: 'sess-1' }]])
  assert.deepEqual((await tool.execute({ do: 'submit', owner_words: '交吧' }, exec)), { text: 'SUB', images: [] }, 'she cannot hand in his words herself')
  assert.ok(!('owner_words' in tool.parameters.properties))
  assert.match((await tool.execute({ do: 'rm -rf' }, exec)).text, /do 只能是/)
  const blind = createBuildTool({ cobuild: fake, pictures: { canSee: async () => false, admit: async () => { throw new Error('no') } } })
  assert.deepEqual((await blind.execute({ do: 'make', recipe: RECIPE }, exec)).images, [])
  assert.match((await createBuildTool({}).execute({ do: 'status' }, exec)).text, /还不能一起盖楼/)
  for (const w of ['交吧', '盖吧', 'Blender', '鲸币', '不劝他花钱', 'over_owner']) assert.ok(tool.description.includes(w), w)
  assert.doesNotMatch(tool.description, /¥|充值/)
  const defs = createChatTools({ log: { info() {}, debug() {} }, journal: {}, state: {}, live: () => null, herName: () => '她', cobuild: fake })
  assert.ok(defs.some((d) => d.name === BUILD_TOOL))
  assert.match(defs.find((d) => d.name === 'fishbowl_town_go').description, /fishbowl_town_build/)
  assert.match(BUILD_HERE, /fishbowl_town_build/)
})

// 0.9.12（小镇 11-24 面多、文件大的楼另收、每天物业也多）：报价的「怎么算的」一项一项都给她，面数、文件、每天物业在后面，不能截在前 4 行
test('the quote 「怎么算的」 lines all reach her (faces, file size and the daily upkeep come last)', async () => {
  const lines = ['起步 62.5 鲸币（12 米、1000 立方米、20000 面、512 KB 以内）', '高度 14 米（起步含 12）：多出来的 2 米 25.0 鲸币', '体积 1200 立方米（起步含 1000）：多出来的 200 立方米 50.0 鲸币',
    '面数 80000 面（起步含 20000）：多出来的 60000 面 1500.0 鲸币', '文件 3072 KB（起步含 512）：多出来的 2560 KB 2250.0 鲸币', '每天物业 72.5 鲸币（起步 2.5；文件超出起步的每 MB 每天 20、面数超出起步的每一万面每天 10）']
  const town = fakeTown()
  town.isleBuild = async (body) => { town.sent.push({ what: 'build', ...body }); return { ok: true, build_id: 'b-9', quote: { coin: 3887.5, upkeep_day_coin: 72.5, lines } } }
  const { cb, say } = setup('quote-lines', { town })
  say('我们盖个房子吧')
  await cb.start({ lot: 'L-0107', idea: '高一点的楼' })
  await cb.make({ recipe: RECIPE })
  say('交吧')
  const out = (await cb.submit({ sid: OWNER })).text
  assert.match(out, /3887\.5 鲸币，每天物业 72\.5 鲸币/)
  for (const x of lines) assert.ok(out.includes(x), `missing: ${x}`)
})

test('no style advice in what the plugin says about co-building (主人 11-20「不要带风格化的提示词」); island money is 鲸币, no push to spend', async () => {
  const STYLE = ['风格', '低多边形', '低模', 'low-poly', 'lowpoly', '可爱', '温馨', '好看', '漂亮', '精致', '美观', '配色', '色调', '氛围', '童话', '卡通', '治愈', '柔和', '暖色', '冷色', '复古', '简约', '写实', '梦幻', 'cute', 'cozy', 'style', 'aesthetic']
  const { cb, say } = setup('wording', { town: fakeTown({ confirm: [{ ok: false, code: 'short', text: '鲸币不够' }] }) })
  const texts = [BUILD_DESCRIPTION, BUILD_HERE, BUILD_STEP, ISLE_BUILD_NOTE, cb.contextLine(), (await cb.start({ lot: 'L-0107' })).text.split('【建模说明】')[0], (await cb.make({ recipe: RECIPE })).text]
  say('交吧')
  texts.push((await cb.submit({ sid: OWNER })).text)
  say('盖吧')
  texts.push((await cb.confirm({ sid: OWNER })).text, cb.contextLine(), (await cb.status()).text)
  for (const t of texts) {
    for (const w of STYLE) assert.ok(!t.toLowerCase().includes(w), `「${w}」 in: ${t.slice(0, 80)}`)
    assert.doesNotMatch(t, /¥|元|充值吧|去充值|爱发电/)
  }
  for (const t of [BUILD_DESCRIPTION, BUILD_STEP]) assert.match(t, /鲸币/)
})

// ---- 真的 Blender（这台电脑上有才跑）：配方 → 三张预览图 → 主人在 Blender 里加了烟囱 → 她改配方 → 烟囱还在 ----
const REAL = [process.env.BLENDER, 'F:\\Tools\\blender-5.2.4-windows-x64\\blender.exe', 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'].filter(Boolean).find((p) => existsSync(p))
test('real Blender: recipe → previews → he adds a chimney in Blender → her new recipe keeps it', { skip: REAL ? false : '这台电脑上没有 Blender', timeout: 600_000 }, async () => {
  const dir = fresh('real')
  let last = 0
  const now = () => (last = Math.max(last + 1, Date.now() + 5000))
  const ownerWords = createOwnerWords({ now })
  const told = []
  const town = fakeTown()
  const cb = createCobuild({ dir, log: quiet, now, ownerWords, blenderPath: () => REAL, town: () => town, tell: async (t) => { told.push(t); return true }, isOwnerChat: () => true })
  const s = await cb.start({ lot: 'L-0107', idea: '小木屋' })
  assert.match(s.text, /一起盖楼了/)
  const m = await cb.make({ recipe: RECIPE })
  assert.match(m.text, /第 1 版做好了/, m.text)
  assert.match(m.text, /能交/, m.text)
  assert.equal(m.previews.length, 3)
  for (const f of m.previews) assert.ok(statSync(f).size > 1000, f)
  const v1 = cb.data().drafts[cb.active().id].versions[0]
  assert.ok(Math.abs(v1.numbers.h - 4.5) < 0.05, `h ${v1.numbers.h}`)

  // 主人在 Blender 里改：加一根烟囱、把墙拉高
  const edit = await new Promise((resolve) => {
    const c = spawn(REAL, ['-b', '--factory-startup', '--disable-autoexec', '--python', join(ROOT, 'test', 'cobuild-owner-edit.py'), '--', cb.workFile()], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    c.stdout.on('data', (b) => { o += b })
    c.on('close', (code) => resolve({ code, o }))
  })
  assert.match(edit.o, /"owner_edit": 1/)
  await cb.tick()
  assert.equal(told.length, 1, told.join('\n'))
  assert.match(told[0], /他加的：Chimney/)
  assert.match(told[0], /高从 4\.5 米变成 6\.5 米/)
  const v2 = cb.data().drafts[cb.active().id].versions.at(-1)
  assert.equal(v2.by, 'owner')

  // 她改配方（屋子宽一点）：烟囱留着
  const m3 = await cb.make({ recipe: { shapes: [{ type: 'box', pos: [0, 0, 0], size: [8, 3, 5], material: 'wood' }, { type: 'gable', pos: [0, 3, 0], size: [8, 1.5, 5], material: 'tile' }] } })
  assert.match(m3.text, /主人亲手改的部分留着/, m3.text)
  const v3 = cb.data().drafts[cb.active().id].versions.at(-1)
  assert.ok(v3.numbers.h > 6.4, `chimney kept: h ${v3.numbers.h}`)
  assert.ok(v3.numbers.bbox[2] - v3.numbers.bbox[0] > 7.9, 'her wider walls')
  assert.equal(v3.problems.length, 0, v3.problems.join('；'))
  // 交
  ownerWords.observe('x', '交吧')
  const sub = await cb.submit({ sid: 'x' })
  assert.match(sub.text, /交上去了/)
  const glb = town.sent.find((x) => x.what === 'build').glb
  assert.equal(glb.subarray(0, 4).toString('latin1'), 'glTF')
})
