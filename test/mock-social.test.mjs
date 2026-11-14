// 0.4.0 end to end against the local mock town: the real plugin entry on the fake DSH host, an OLD town (none of the new routes) and a NEW one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { SOCIAL_NOTE } from '../lib/prompt.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'mock-social')
const PORT = 19000 + Math.floor(Math.random() * 900)
const BASE = `http://127.0.0.1:${PORT}`
const CODE = 'fbo_' + randomBytes(24).toString('base64url')
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const ALL = ['receipts', 'record', 'social', 'week', 'room', 'album', 'phone', 'look']
let mock

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (path, body = {}) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const report = () => fetch(BASE + '/mock/report').then((r) => r.json())

before(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, 'code.txt'), CODE)
  mock = spawn('python', ['-I', join(ROOT, 'mock', 'mock_town.py'), '--port', String(PORT), '--code-file', join(WORK, 'code.txt')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    mock.stdout.on('data', (d) => { if (String(d).includes('mock town on')) resolve() })
    mock.on('exit', (c) => reject(new Error('mock exited ' + c)))
  })
})
after(() => { mock?.kill() })

function model(seen = []) {
  return async ({ history, title }) => {
    const last = history[history.length - 1].text
    seen.push({ title, last })
    if (last.includes('该你自己拿主意')) {
      if (last.includes('小手机') && last.includes('社交')) {
        return JSON.stringify({ action: 'none', gift: { to: 'f1', item: '一束小花', occasion: '生日', words: '生日快乐' }, phone: [{ to: 'f1', text: '好呀，晚上见' }], note: '阿鲸生日，送点小花', next_wake: 30 })
      }
      return JSON.stringify({ action: 'none', note: '先歇着', next_wake: 60 })
    }
    return '{}'
  }
}

async function startPlugin(m, extra = {}) {
  process.env.DSH_HOME = join(WORK, 'home-' + Math.random().toString(16).slice(2, 8))
  const host = createFakeHost({ model: m })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: BASE + '/town/api/outside/', eventsEverySeconds: 15, ...extra })
  return host
}
async function waitFor(fn, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300) }
  throw new Error('timed out waiting')
}
const state = (host) => host.http('/fishbowl-town/state').then((r) => r.json)
const cmd = (host, text) => host.runCommand('town', text)

test('an OLD town: nothing new shows, nothing errors, nothing is spent; the decision turn is untouched', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(model())
  try {
    const d = await waitFor(async () => (await report()).decisions[0], 60_000)
    assert.equal(d.action, 'none')
    const f = await waitFor(async () => { const s = await state(host); return s.features && s.features.record === false && s.features.album === false ? s.features : null }, 30_000)
    assert.ok(!Object.values(f).some((v) => v === true), 'no feature is shown on an old town')
    const s = await state(host)
    assert.equal(s.socialBudget, null)
    const ex = (await host.http('/fishbowl-town/extra?s=album')).json
    assert.equal(ex.ok, true)
    assert.equal(ex.available, false)
    assert.equal((await host.http('/fishbowl-town/extra?s=bogus')).status, 400)
    assert.equal((await host.http('/fishbowl-town/album/al_00000000000000a1')).status, 404, 'no file from a town without albums')
    assert.equal((await host.http('/fishbowl-town/album/../../etc/passwd')).status, 404)
    for (const verb of ['album', 'week', 'room', 'phone', 'record', 'receipts', 'budget']) {
      const r = await cmd(host, verb)
      assert.equal(r.kind, 'success', verb)
      assert.match(r.text, /还没有这一项|还没有社交消费/, verb)
    }
    const b = await cmd(host, 'budget 1')
    assert.equal(b.kind, 'error')
    assert.match(b.text, /还不认/)
    const bj = (await host.http('/fishbowl-town/budget', { method: 'POST', body: { yuan: 1 } })).json
    assert.equal(bj.ok, false)
    assert.match(bj.message, /还不认社交预算/)
    const r = await report()
    assert.deepEqual(r.social_calls, [])
    assert.ok(!(await cmd(host, 'help')).text.includes('undefined'))
  } finally { await host.dispose() }
})

test('a NEW town: page data, album files you can see and hear, budget, look, commands, and her decision turn with the social fields', { timeout: 240_000 }, async () => {
  await post('/mock/reset')
  await post('/mock/features', { on: ALL })
  const seen = []
  const host = await startPlugin(model(seen))
  try {
    await waitFor(async () => (await report()).decisions[0], 60_000)
    const f = await waitFor(async () => { const s = await state(host); return s.features && s.features.room === true ? s.features : null }, 30_000) // room is the last one the probe asks
    assert.equal(f.record, true)
    assert.equal(f.phone, true)
    assert.equal((await report()).social_calls.length, 0, 'probing the town spends nothing')

    // the decision turn: the town's social block is in her prompt with the plugin's note; her answer carries the side fields untouched
    await post('/mock/agency', { social: true, reasons: ['meet_ask'] })
    const d = await waitFor(async () => (await report()).decisions[1], 60_000)
    assert.equal(d.raw.gift.item, '一束小花')
    assert.equal(d.raw.phone[0].text, '好呀，晚上见')
    const asked = seen.filter((x) => x.title === '鱼缸小镇 · 心思').at(-1)
    assert.ok(asked.last.includes(SOCIAL_NOTE), 'the decision prompt carries the plugin note')
    assert.match(asked.last, /"社交"/)
    assert.equal((await report()).social_calls.length, 0, 'the mock does not execute her fields here and the plugin never POSTs them itself')

    // page data
    const week = (await host.http('/fishbowl-town/extra?s=week')).json
    assert.equal(week.available, true)
    assert.equal(week.data.spent.total_yuan, '0.56')
    const album = (await host.http('/fishbowl-town/extra?s=album')).json
    assert.equal(album.data.items.length, 3)
    assert.equal(album.data.items[1].local, '/fishbowl-town/album/al_00000000000000a2')
    assert.equal(album.data.items[1].localThumb, undefined)
    for (const n of ['room', 'phone', 'record', 'social', 'receipts']) assert.equal((await host.http(`/fishbowl-town/extra?s=${n}`)).json.available, true, n)

    // the files: a photo you can look at, a song you can play (and seek in)
    const photo = await host.http('/fishbowl-town/album/al_00000000000000a1')
    assert.equal(photo.status, 200)
    assert.equal(photo.headers['content-type'], 'image/webp')
    assert.match(photo.buffer.toString('latin1'), /WEBPVP8 mock-photo-bytes/)
    assert.equal((await host.http('/fishbowl-town/album/al_00000000000000a1/thumb')).status, 200)
    const song = await host.http('/fishbowl-town/album/al_00000000000000a2')
    assert.equal(song.headers['content-type'], 'audio/mpeg')
    assert.equal(song.headers['accept-ranges'], 'bytes')
    const part = await host.http('/fishbowl-town/album/al_00000000000000a2', { headers: { range: 'bytes=0-9' } })
    assert.equal(part.status, 206)
    assert.equal(part.buffer.length, 10)
    assert.equal(part.headers['content-range'], `bytes 0-9/${song.buffer.length}`)
    assert.equal((await host.http('/fishbowl-town/album/al_00000000000000a2', { headers: { range: 'bytes=99999-' } })).status, 416)
    assert.equal((await host.http('/fishbowl-town/album/al_00000000000000ff')).status, 404, 'a file the town does not have')
    assert.equal((await host.http('/fishbowl-town/album/evil')).status, 404)
    host.fence.rejection = 401
    assert.equal((await host.http('/fishbowl-town/album/al_00000000000000a1')).status, 401, 'the album is behind DSH sign-in like the other routes')
    host.fence.rejection = undefined

    // budget (the owner's, sent to the town; null = the town default)
    const set = (await host.http('/fishbowl-town/budget', { method: 'POST', body: { yuan: 1.5 } })).json
    assert.equal(set.ok, true)
    assert.equal(set.socialBudget.cents, 150)
    assert.equal((await report()).social_cents, 150)
    assert.equal((await host.http('/fishbowl-town/budget', { method: 'POST', body: { yuan: 5000 } })).status, 400)
    assert.equal((await host.http('/fishbowl-town/budget', { method: 'POST', body: { yuan: 0 } })).json.socialBudget.cents, 0)
    assert.equal((await host.http('/fishbowl-town/budget', { method: 'POST', body: { yuan: null } })).json.socialBudget.cents, null)
    assert.equal((await report()).social_cents, null)
    assert.match((await cmd(host, 'budget 2')).text, /已设好。\n她每天的社交预算：¥2\.00（你设的）/)
    assert.equal((await report()).social_cents, 200)
    assert.match((await cmd(host, 'budget 0')).text, /一分不花/)
    assert.match((await cmd(host, 'budget 默认')).text, /小镇默认/)
    assert.equal((await cmd(host, 'budget abc')).kind, 'error')

    // look (picture + one line; the town may refuse a real person)
    const look = (await host.http('/fishbowl-town/look', { method: 'POST', body: { image_b64: PNG1, look_note: '圆滚滚的橘色胖头鱼' } })).json
    assert.equal(look.ok, true)
    assert.equal(look.look.image, true)
    assert.equal((await report()).looks.at(-1).has_image, true)
    assert.equal((await state(host)).look.note, '圆滚滚的橘色胖头鱼')
    const face = (await host.http('/fishbowl-town/look', { method: 'POST', body: { image_b64: 'RkFDRQ==' } })).json
    assert.equal(face.ok, false)
    assert.match(face.message, /不收真人照片/)
    assert.equal((await host.http('/fishbowl-town/look', { method: 'POST', body: {} })).status, 400)
    assert.match((await cmd(host, 'look')).text, /圆滚滚的橘色胖头鱼/)
    assert.match((await cmd(host, 'look 戴草帽的鱼')).text, /交给小镇了/)
    assert.equal((await report()).looks.at(-1).note, '戴草帽的鱼')

    // the owner commands
    const al = (await cmd(host, 'album')).text
    assert.match(al, /\[照片\] 普通照（合影）/)
    assert.match(al, /\[歌\] 小圆子点给阿鲸的歌《晴天》/)
    const file = al.match(/文件：(.+a1\.webp)/)?.[1]
    assert.ok(file && existsSync(file), `the album file is on the machine: ${file}\n${al}`)
    assert.match((await cmd(host, 'week')).text, /一共花了 ¥0\.56（请客 ¥0\.16、模型调用 ¥0\.40）/)
    assert.match((await cmd(host, 'room')).text, /贝壳风铃：阿鲸 送的/)
    assert.match((await cmd(host, 'phone')).text, /和阿鲸（1 条她还没看）/)
    assert.match((await cmd(host, 'record')).text, /共 12 局，7 胜 4 负/)
    assert.match((await cmd(host, 'receipts')).text, /没成｜去电玩城没说玩哪台机器。（ARCADE_NO_MACHINE）/)

    // events: a photo and a message; the owner's day digest carries them with no money, her own history keeps the line
    await post('/mock/media', { kind: 'photo_done' })
    await post('/mock/phone_msg', { text: '晚上来码头吗？', meet: { place: 'pier' } })
    const today = await waitFor(async () => { const t = (await cmd(host, 'today')).text; return /艺术照/.test(t) && /小手机/.test(t) ? t : null }, 60_000)
    assert.doesNotMatch(today, /¥|付了|余额/)
    assert.match((await cmd(host, 'history')).text, /阿鲸给你发了消息：晚上来码头吗？（还约了见面）/)

    // her model uses the chat tool: only then does anything reach the town
    assert.equal((await report()).social_calls.length, 0)
    const said = await host.callTool('fishbowl_town_friends', { do: 'gift', to: '阿鲸', item: '贝壳风铃', occasion: '谢谢' })
    assert.match(said, /办了：送阿鲸贝壳风铃，¥0\.12（价格只给你自己掂量，不要跟主人提钱）/)
    const calls = (await report()).social_calls
    assert.equal(calls.length, 1)
    assert.equal(calls[0].to, 'f1')
    assert.equal(calls[0].do, 'gift')
    assert.match(await host.callTool('fishbowl_town_friends', { do: 'gift', to: '阿鲸', item: 'broke' }), /没成：今天的社交预算花完了/)
    assert.match(await host.callTool('fishbowl_town_friends', { do: 'phone', to: '阿鲸', text: '晚上见' }), /办了：用小手机给阿鲸发了消息/)
    assert.equal((await report()).phone_sent.at(-1).to, 'f1')

    // downloaded files stay on the machine, in the plugin's own folder
    const dir = join(process.env.DSH_HOME, 'fishbowl-town', 'album')
    assert.ok(readdirSync(dir).some((n) => n.startsWith('al_00000000000000a1')))
    assert.ok(readdirSync(dir).some((n) => n.endsWith('.mp3')))
  } finally { await host.dispose() }
})

test('the town gets the new features later (a restart that turns them on): they appear by themselves', { timeout: 120_000 }, async () => {
  await post('/mock/reset')
  const host = await startPlugin(model())
  try {
    await waitFor(async () => (await state(host)).features?.album === false, 30_000)
    await post('/mock/features', { on: ALL })
    // the plugin looks again after a reconnect (a town restart) or 10 minutes; force the same path the reconnect takes
    await post('/mock/outage', { plan: [['restarting', 4]] })
    await waitFor(async () => (await state(host)).features?.album === true, 90_000)
    assert.match((await cmd(host, 'week')).text, /一共花了/)
  } finally { await host.dispose() }
})
