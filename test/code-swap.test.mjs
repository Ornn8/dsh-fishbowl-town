// 0.9.3 (user 11-20: two fish shared one bag; the big fish's mushrooms were booked on the small fish): pasting ANOTHER fish's code
// into a fish's own code field swaps her out of town. The page now says whose code it is and asks; the same fish's new code, a code
// the town does not answer for, or a confirmed swap still saves as before.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'code-swap')
const OLD = 'fbo_' + 'd'.repeat(32)
const SAME = 'fbo_' + 'e'.repeat(32) // her own code, made again on the owner page
const OTHER = 'fbo_' + 'x'.repeat(32) // the second fish's code
const WHO = { [OLD]: { fish_id: 'f_deng', town_name: '灯' }, [SAME]: { fish_id: 'f_deng', town_name: '灯' }, [OTHER]: { fish_id: 'f_xi', town_name: '汐·雾' } }

const town = createServer((req, res) => {
  const who = WHO[String(req.headers.authorization || '').replace(/^Bearer /, '')]
  res.setHeader('content-type', 'application/json')
  if (!who) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'TOWN_OUTSIDE_CODE' })) }
  if (req.method === 'GET' && req.url.startsWith('/town/api/outside/status')) return res.end(JSON.stringify({ ...who, state: 'ready', outside_state: 'in_town' }))
  res.statusCode = 503 // everything else: "town restarting", so her runner stays quiet
  res.setHeader('retry-after', '60')
  res.end(JSON.stringify({ error: 'TOWN_RESTARTING', retry_after: 60 }))
})
after(() => { town.close(); rmSync(WORK, { recursive: true, force: true }) })

test('another fish\'s code in her field is asked about; her own new code, an unknown code and a confirmed swap save', { timeout: 60_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  await new Promise((r) => town.listen(0, '127.0.0.1', r))
  const api = `http://127.0.0.1:${town.address().port}/town/api/outside/`
  process.env.DSH_HOME = join(WORK, 'home')
  delete process.env.FISHBOWL_TOWN_CODE
  const dir = join(process.env.DSH_HOME, 'fishbowl-town')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fish: [{ id: '1', code: OLD, base: api }] }))
  // codeTag 对得上 OLD：不然她的值班一起来就当成换了一条鱼、把 herName 清掉，和下面的保存赛跑（机器忙的时候偶尔输）
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ herName: '灯', herFishId: 'f_deng', codeTag: createHash('sha256').update(OLD).digest('hex').slice(0, 12) }))
  const host = createFakeHost({ model: async () => '{}' })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { eventsEverySeconds: 600 })
  const code = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).fish[0].code
  const save = (body) => host.http('/fishbowl-town/save', { method: 'POST', body })
  try {
  const asked = await save({ code: OTHER })
  assert.equal(asked.status, 409)
  assert.deepEqual(asked.json.swap, { from: '灯', to: '汐·雾' })
  assert.match(asked.json.message, /再加一条鱼/)
  assert.equal(code(), OLD, 'nothing saved before he says yes')

  const same = await save({ code: SAME })
  assert.equal(same.status, 200, 'her own new code saves without a question')
  assert.equal(code(), SAME)

  const unknown = await save({ code: 'fbo_' + 'z'.repeat(32) })
  assert.equal(unknown.status, 200, 'a code the town does not answer for saves as before (her runner reports it)')
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fish: [{ id: '1', code: OLD, base: api }] }))

  const yes = await save({ code: OTHER, confirmSwap: true })
  assert.equal(yes.status, 200)
  assert.equal(code(), OTHER)
  } finally {
    await host.dispose()
  }
})
