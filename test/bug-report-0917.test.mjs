// 0.9.17 报问题（fish-guide 11-24，小镇 feat/1125-isle-bugreport，11-25 包，开关默认开）：聊天里「在岛上做一件事」
// {"do":"report","about":"bug","why":"哪里不对"} 原样交给岛上，日记里写「报岛上的问题」；不带 about 的 report 照旧是「举报一家店」。
// 和 AstrBot tests/test_bug_report_0413.py 同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIsleTools, reportWhat } from '../lib/isle-tools.js'

function tools(reply = { ok: true, code: 'bug_saved', bug: 7, text: '收到了，修好会告诉你' }) {
  const sent = []
  const j = []
  const client = { async isleAct(world) { sent.push(world); return reply } }
  const [, act] = createIsleTools({ live: () => ({ client }), journal: { event: (kind, text) => j.push(text) }, pictures: null, log: { info() {} } })
  return { act, sent, j }
}

test('reportWhat: about bug words read 报岛上的问题, a plain report is still 举报一家店', () => {
  assert.equal(reportWhat({ do: 'report', about: 'bug', why: '田那行写空着' }), '报岛上的问题')
  assert.equal(reportWhat({ do: 'report', about: ' BUG ', text: 'x' }), '报岛上的问题')
  assert.equal(reportWhat({ do: 'report', about: '报 问题', text: 'x' }), '报岛上的问题')
  assert.equal(reportWhat({ do: 'report', about: '毛病', text: 'x' }), '报岛上的问题')
  assert.equal(reportWhat({ do: 'report', shop: 'S-12', why: '没上菜' }), '举报一家店')
  assert.equal(reportWhat({ do: 'report', about: '店', why: '没上菜' }), '举报一家店')
  assert.equal(reportWhat({ do: 'walk', about: 'bug' }), '')
  assert.equal(reportWhat(null), '')
})

test('act: a bug report goes to the island as written and the diary says 报岛上的问题', async () => {
  const { act, sent, j } = tools()
  const w = { do: 'report', about: 'bug', why: '「我的」里田那行写空着，田里明明种着白菜' }
  const out = await act.execute({ world: w }, {})
  assert.match(out, /收到了，修好会告诉你/)
  assert.deepEqual(sent, [w])
  assert.ok(j[0].includes('在岛上报岛上的问题：收到了，修好会告诉你'), j[0])
})

test('act: a shop report still reads 举报一家店', async () => {
  const { act, j } = tools({ ok: true, code: 'reported', text: '记下了' })
  await act.execute({ world: { do: 'report', shop: 'S-12', why: '没上菜' } }, {})
  assert.ok(j[0].includes('举报一家店') && !j[0].includes('报岛上的问题'), j[0])
})
