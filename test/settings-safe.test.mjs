// 0.8.3 (11-17, a DSH owner: after the 0.8.1 upgrade settings.json kept one fish, her 364-char persona empty, the second fish gone):
// an unreadable settings.json was read as {} and the next save wrote that back. A BOM is read now; anything else unreadable is never
// written over (a copy is kept, the page says so); every write keeps the previous version as settings.json.bak.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'
import { readSettingsFile, writeSettingsFile } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'settings-safe')
const P1 = '我是金鱼'.repeat(91)
const TWO = (a, b) => ({ fish: [{ id: '1', code: 'fbo_aaaaaaaaaaaaaaaaaaaa', chatSid: a, persona: P1 }, { id: '2', code: 'fbo_bbbbbbbbbbbbbbbbbbbb', chatSid: b, persona: '我是小小金鱼' }], tellMe: true })

test('read and write: BOM is fine, an unreadable file is kept and never written over, the last version is kept as .bak', () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const f = join(WORK, 'settings.json')
  assert.deepEqual(readSettingsFile(f), { value: {}, broken: '' })
  writeFileSync(f, '﻿' + JSON.stringify({ tellMe: true }))
  assert.deepEqual(readSettingsFile(f), { value: { tellMe: true }, broken: '' })
  writeSettingsFile(f, { tellMe: false })
  assert.equal(JSON.parse(readFileSync(f + '.bak', 'utf8').replace(/^﻿/, '')).tellMe, true)
  const bad = '{ "fish": [ { "id": "1", "persona": "x" }, ], }'
  writeFileSync(f, bad)
  assert.ok(readSettingsFile(f).broken)
  assert.throws(() => writeSettingsFile(f, { fish: [] }), (e) => e.code === 'SETTINGS_UNREADABLE' && /没有保存/.test(e.message))
  assert.equal(readFileSync(f, 'utf8'), bad)
  assert.equal(readdirSync(WORK).filter((x) => x.startsWith('settings.json.unreadable-')).length, 1)
  assert.throws(() => writeSettingsFile(f, {}))
  assert.equal(readdirSync(WORK).filter((x) => x.startsWith('settings.json.unreadable-')).length, 1, 'one copy per broken file')
  rmSync(WORK, { recursive: true, force: true })
})

for (const [label, prefix, broken] of [['bom', '﻿', false], ['hand-broken', '', true]]) {
  test(`restart with two fish (${label}) and a page toggle: nothing is lost`, { timeout: 60_000 }, async () => {
    const home = join(WORK, 'home-' + label)
    rmSync(home, { recursive: true, force: true })
    process.env.DSH_HOME = home
    delete process.env.FISHBOWL_TOWN_CODE
    const host = createFakeHost({ model: async () => '好呀' })
    const a = await host.ownerChat('聊天 · 金鱼')
    const b = await host.ownerChat('聊天 · 小小金鱼')
    mkdirSync(join(home, 'fishbowl-town'), { recursive: true })
    const file = join(home, 'fishbowl-town', 'settings.json')
    const text = prefix + JSON.stringify(TWO(a.sid, b.sid), null, 2).replace(/true\n}$/, broken ? 'true,\n}' : 'true\n}')
    writeFileSync(file, text)
    const plugin = await import('../lib/index.js?' + label)
    plugin.apply(host.ctx, { eventsEverySeconds: 600, checkLatest: false })
    try {
      const st = (await host.http('/fishbowl-town/state')).json
      const saved = await host.http('/fishbowl-town/save', { method: 'POST', body: { townBrief: false } })
      if (broken) {
        assert.match(st.settingsBroken, /读不出来/)
        assert.equal(saved.status, 500)
        assert.match(saved.json.message, /没有保存/)
        assert.equal(readFileSync(file, 'utf8'), text, 'the file is untouched')
      } else {
        assert.equal(st.fish.length, 2)
        assert.equal(st.persona.length, 364)
        assert.equal(st.settingsBroken, '')
        assert.equal(saved.status, 200)
        const s = JSON.parse(readFileSync(file, 'utf8'))
        assert.deepEqual(s.fish.map((x) => [x.id, x.persona.length, Boolean(x.code)]), [['1', 364, true], ['2', 6, true]])
        assert.equal(s.tellMe, true)
        assert.equal(s.townBrief, false)
      }
    } finally {
      host.dispose?.()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
