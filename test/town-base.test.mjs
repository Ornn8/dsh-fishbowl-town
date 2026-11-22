// 0.9.8：外来的鱼的入口机 api.fishbowltown.com；默认地址时连不上就退回主站 fishbowltown.com 10 分钟
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { API_BASE, DEFAULT_BASE, FALLBACK_MS, LEGACY_BASE, OLD_BASE, TownError, createTownClient, isDefaultBase } from '../lib/town-client.js'

const ok = (body = { ok: true }) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
const busy = () => ({ ok: false, status: 503, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '3' : null) }, text: async () => '{"error":"TOWN_RESTARTING","retry_after":3}' })
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

/** 一个假的网络：plan(url) 决定这一次是回话（Response）还是连不上（抛错）。 */
function net(plan) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    seen.push({ url: u, method: init.method || 'GET', body: init.body, signal: init.signal })
    const r = await plan(u, init)
    if (r instanceof Error) throw r
    return r
  }
  return { seen, fetchImpl, hosts: () => seen.map((x) => x.url.host) }
}

test('the default is the api entry; an empty, the new, the old default or the older fish.bside-moon.cn (with or without the slash) all count as default', () => {
  assert.equal(DEFAULT_BASE, 'https://api.fishbowltown.com/town/api/outside/')
  assert.equal(LEGACY_BASE, 'https://fishbowltown.com/town/api/outside/')
  assert.equal(OLD_BASE, 'https://fish.bside-moon.cn/town/api/outside/')
  for (const b of [undefined, '', '  ', API_BASE, LEGACY_BASE, OLD_BASE, 'https://fishbowltown.com/town/api/outside', 'https://api.fishbowltown.com/town/api/outside', 'https://fish.bside-moon.cn/town/api/outside']) assert.equal(isDefaultBase(b), true, String(b))
  for (const b of ['https://t.test/town/api/outside/', 'http://127.0.0.1:8080/town/api/outside/', 'https://fish.bside-moon.cn/other/']) assert.equal(isDefaultBase(b), false, b)
})

test('two network failures in a row on the api entry -> the old base for 10 minutes (one log line each way), then the api entry again', async () => {
  let t = 1_800_000_000_000
  let apiDown = true
  const logs = []
  const n = net((u) => (u.host === 'api.fishbowltown.com' && apiDown ? refused() : ok({ turns: [] })))
  const c = createTownClient({ code: 'fbo_test', fetchImpl: n.fetchImpl, now: () => t, log: (m) => logs.push(m) })
  assert.equal(c.currentBase(), API_BASE)
  await assert.rejects(c.status(), (e) => e instanceof TownError && e.code === 'NETWORK')
  assert.equal(c.currentBase(), API_BASE, 'one failure is not enough')
  await assert.rejects(c.events(0), (e) => e.code === 'NETWORK')
  assert.equal(c.currentBase(), LEGACY_BASE)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /api\.fishbowltown\.com 连着 2 次连不上，先改走主站 fishbowltown\.com，10 分钟后再试/)
  // the long poll and the answer keep their own shape on the old base
  await c.turns(25)
  await c.answer('ot_1', '{"action":"none"}')
  const [poll, post] = n.seen.slice(-2)
  assert.equal(poll.url.href.split('?')[0], LEGACY_BASE + 'turns')
  assert.equal(poll.url.searchParams.get('wait'), '25')
  assert.equal(poll.url.searchParams.get('kinds'), 'activity,build')
  assert.equal(post.method, 'POST')
  assert.equal(post.url.href, LEGACY_BASE + 'turns/ot_1')
  assert.deepEqual(JSON.parse(post.body), { answer: '{"action":"none"}' })
  t += FALLBACK_MS - 1000
  await c.status()
  assert.equal(n.seen.at(-1).url.host, 'fishbowltown.com', 'still inside the 10 minutes')
  t += 2000
  apiDown = false
  await c.status()
  assert.equal(n.seen.at(-1).url.href, API_BASE + 'status')
  assert.equal(logs.length, 2)
  assert.match(logs[1], /改回小镇的接口入口 api\.fishbowltown\.com/)
})

test('not in a row: a failure, a reply, a failure -> stays on the api entry', async () => {
  let fail = true
  const n = net(() => (fail ? refused() : ok()))
  const c = createTownClient({ code: 'fbo_test', fetchImpl: n.fetchImpl })
  await assert.rejects(c.status())
  fail = false
  await c.status()
  fail = true
  await assert.rejects(c.status())
  assert.equal(c.currentBase(), API_BASE)
  assert.deepEqual([...new Set(n.hosts())], ['api.fishbowltown.com'])
})

test('HTTP errors are not network failures: 503 TOWN_RESTARTING (and 404 / 500) never switch', async () => {
  const codes = [busy(), busy(), busy(), { ok: false, status: 500, headers: { get: () => null }, text: async () => '' }, { ok: false, status: 404, headers: { get: () => null }, text: async () => '{"error":"NO_SUCH"}' }]
  const n = net(() => codes.shift() || busy())
  const c = createTownClient({ code: 'fbo_test', fetchImpl: n.fetchImpl })
  await assert.rejects(c.status(), (e) => e.code === 'TOWN_RESTARTING' && e.status === 503 && e.retryAfter === 3)
  await assert.rejects(c.status(), (e) => e.code === 'TOWN_RESTARTING')
  await assert.rejects(c.status(), (e) => e.code === 'TOWN_RESTARTING')
  await assert.rejects(c.status(), (e) => e.code === 'HTTP_500')
  await assert.rejects(c.status(), (e) => e.code === 'NO_SUCH')
  assert.equal(c.currentBase(), API_BASE)
  assert.deepEqual([...new Set(n.hosts())], ['api.fishbowltown.com'])
  // and a reply in between resets the count: failure, 503, failure -> no switch
  const seq = [refused(), busy(), refused()]
  const m = net(() => seq.shift() || ok())
  const d = createTownClient({ code: 'fbo_test', fetchImpl: m.fetchImpl })
  for (let i = 0; i < 3; i++) await assert.rejects(d.status())
  assert.equal(d.currentBase(), API_BASE)
})

test('a timeout before any reply counts; a stop from our side (abort) does not', async () => {
  const timedOut = () => Object.assign(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  const n = net(() => timedOut())
  const c = createTownClient({ code: 'fbo_test', fetchImpl: n.fetchImpl })
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(c.turns(25, stop.signal), (e) => e.code === 'ABORTED')
  await assert.rejects(c.turns(25, stop.signal), (e) => e.code === 'ABORTED')
  assert.equal(c.currentBase(), API_BASE, 'our own stop is not the api entry failing')
  await assert.rejects(c.turns(25), (e) => e.code === 'NETWORK')
  await assert.rejects(c.turns(25), (e) => e.code === 'NETWORK')
  assert.equal(c.currentBase(), LEGACY_BASE)
})

test('a base of her own never switches, however often it fails', async () => {
  for (const base of ['https://t.test/town/api/outside/', 'http://127.0.0.1:8080/town/api/outside/']) {
    const logs = []
    const n = net(() => refused())
    const c = createTownClient({ base, code: 'fbo_test', fetchImpl: n.fetchImpl, log: (m) => logs.push(m) })
    for (let i = 0; i < 5; i++) await assert.rejects(c.status(), (e) => e.code === 'NETWORK')
    assert.equal(c.currentBase(), base)
    assert.deepEqual([...new Set(n.hosts())], [new URL(base).host])
    assert.deepEqual(logs, [])
  }
})

for (const saved of ['https://fishbowltown.com/town/api/outside/', 'https://fish.bside-moon.cn/town/api/outside/', 'https://fish.bside-moon.cn/town/api/outside']) test(`an old default saved in the config (${saved}) is the default too: the api entry first, fishbowltown.com as the fallback`, async () => {
  let t = 1_800_000_000_000
  const n = net((u) => (u.host === 'api.fishbowltown.com' ? refused() : ok()))
  const c = createTownClient({ base: saved, code: 'fbo_test', fetchImpl: n.fetchImpl, now: () => t })
  await assert.rejects(c.status())
  await assert.rejects(c.status())
  await c.status()
  assert.deepEqual(n.hosts(), ['api.fishbowltown.com', 'api.fishbowltown.com', 'fishbowltown.com'])
  t += FALLBACK_MS
  await assert.rejects(c.status())
  assert.equal(n.seen.at(-1).url.host, 'api.fishbowltown.com', 'after 10 minutes the api entry is tried again')
})

test('pictures: the PIC_PATH check holds on both town bases; an api picture is fetched from the old base while the api entry is down', async () => {
  let t = 1_800_000_000_000
  const jpg = () => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
  const n = net((u) => (u.host === 'api.fishbowltown.com' ? refused() : u.pathname.includes('/isle/pic/') ? jpg() : ok()))
  const c = createTownClient({ code: 'fbo_test', fetchImpl: n.fetchImpl, now: () => t })
  const onApi = API_BASE + 'isle/pic/0123456789ab.jpg'
  const onMain = LEGACY_BASE + 'isle/pic/0123456789ab.jpg'
  assert.equal(c.islePicUrl(onApi), onApi)
  assert.equal(c.islePicUrl(onMain), onMain, 'the town may still hand out main-site picture links')
  assert.equal(c.islePicUrl('isle/pic/0123456789ab.png'), API_BASE + 'isle/pic/0123456789ab.png')
  for (const bad of ['https://evil.example/town/api/outside/isle/pic/0123456789ab.jpg', API_BASE + 'isle/pic/zz.jpg', onApi + '?x=1', 'http://api.fishbowltown.com/town/api/outside/isle/pic/0123456789ab.jpg']) {
    assert.equal(c.islePicUrl(bad), null, bad)
  }
  await assert.rejects(c.islePic(onApi), (e) => e.code === 'NETWORK')
  await assert.rejects(c.status())
  assert.equal(c.currentBase(), LEGACY_BASE, 'a picture that could not be reached counts as the api entry failing')
  assert.equal(c.islePicUrl(onApi), onMain)
  assert.equal(c.islePicUrl('isle/pic/0123456789ab.png'), LEGACY_BASE + 'isle/pic/0123456789ab.png')
  const pic = await c.islePic(onApi)
  assert.equal(pic.mediaType, 'image/jpeg')
  assert.equal(n.seen.at(-1).url.href, onMain)
  // album files are not the outside API: they stay on the main site
  const m = net(() => ({ ok: true, status: 200, headers: { get: () => 'image/webp' }, arrayBuffer: async () => new Uint8Array([7]).buffer }))
  const d = createTownClient({ code: 'fbo_test', fetchImpl: m.fetchImpl })
  await d.albumFile('al_0123456789abcdef')
  assert.equal(m.seen[0].url.href, 'https://fishbowltown.com/town/api/album/al_0123456789abcdef/file')
})
