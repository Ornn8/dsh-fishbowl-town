// The plugin page (lib/client.js) without a browser: a tiny React stand-in builds element trees, and the new 0.4.0 blocks are read as text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function load() {
  const flat = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: flat(children) }),
    useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: () => {},
    useRef: (i) => ({ current: i }),
    useCallback: (f) => f,
  }
  let def
  const window = { __ModuleLoader__: { load: (d) => { def = d } } }
  new Function('window', readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'))(window)
  const mod = def.factory((name) => { assert.equal(name, 'react'); return React })
  return { mod, React }
}
const text = (n) => (n === null || n === undefined || n === false ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : [...(n.children || [])].map(text).join(''))
const all = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out) } return out }
const render = (nodes) => ({ type: 'root', props: {}, children: [nodes].flat(Infinity).filter(Boolean) })

test('the page module loads, registers its slot, and the first render (nothing read yet) does not throw', () => {
  const { mod } = load()
  assert.deepEqual(mod.inject, ['slots'])
  const reg = []
  mod.apply({ get: () => ({ inject: (_n, f) => f(), register: (meta, comp) => reg.push([meta, comp]) }) })
  assert.equal(reg.length, 1)
  assert.equal(reg[0][1]({ view: 'summary' }), '填接入码、她的人设、她住的聊天会话（一台 DSH 最多 3 条鱼）')
  assert.ok(reg[0][1]({ view: 'full' }))
  assert.ok(mod.__test.Page(), 'Page renders with no data')
})

test('Section: an old town (feature not true) leaves no trace; a new one is a collapsible block', () => {
  const { mod } = load()
  const S = mod.__test.Section
  for (const features of [undefined, {}, { album: false }, { album: null }]) assert.equal(S({ name: 'album', title: '她的相册', features }), null)
  const el = S({ name: 'album', title: '她的相册', hint: '能看能听', features: { album: true } })
  assert.equal(el.type, 'details')
  assert.match(text(el), /她的相册.*能看能听/)
})

test('the album: photos are images (thumbnail first, link to the full one), songs are audio players, nothing is shown without a local link', () => {
  const { mod } = load()
  const tree = render(mod.__test.R.album({
    items: [
      { item_id: 'al_00000000000000a1', kind: 'photo', what: '艺术照（合影）', with: [{ name: '阿鲸' }], occasion: '生日', price_yuan: '0.47', paid_by: { name: '小圆子' }, local: '/fishbowl-town/album/al_00000000000000a1', localThumb: '/fishbowl-town/album/al_00000000000000a1/thumb', created: 1794000000 },
      { item_id: 'al_00000000000000a2', kind: 'song', what: '点给阿鲸的歌《晴天》', price_yuan: '0.50', paid_by: { name: '小圆子' }, local: '/fishbowl-town/album/al_00000000000000a2' },
      { item_id: 'al_00000000000000a3', kind: 'paint', what: '一张画', price_yuan: '0.20' },
    ],
    making: [{ what: '艺术照' }],
    given_back: [{ what: '歌《找不到》', reason: '没找到这首歌' }],
  }))
  const imgs = all(tree, (n) => n.type === 'img')
  assert.equal(imgs.length, 1, 'the paint without a local link shows no broken image')
  assert.equal(imgs[0].props.src, '/fishbowl-town/album/al_00000000000000a1/thumb')
  const link = all(tree, (n) => n.type === 'a')[0]
  assert.equal(link.props.href, '/fishbowl-town/album/al_00000000000000a1')
  const audio = all(tree, (n) => n.type === 'audio')
  assert.equal(audio.length, 1)
  assert.equal(audio[0].props.src, '/fishbowl-town/album/al_00000000000000a2')
  assert.equal(audio[0].props.controls, true)
  assert.equal(audio[0].props.preload, 'none', 'a song is not downloaded until it is played')
  const t = text(tree)
  assert.match(t, /艺术照（合影）/)
  assert.match(t, /和阿鲸 · 生日 · ¥0\.47，小圆子付的/)
  assert.match(t, /正在做.*艺术照/)
  assert.match(t, /没做成（钱已经退了）.*歌《找不到》.*没找到这首歌/)
  assert.match(text(render(mod.__test.R.album({ items: [], making: [] }))), /相册还是空的/)
})

test('her week, room, phone and record read as plain lines', () => {
  const { mod } = load()
  const R = mod.__test.R
  const week = text(render(R.week({ spent: { total_yuan: '0.56', by_kind: [{ name: '请客', yuan: '0.16' }, { name: '模型调用', yuan: '0.40' }] }, treats: [{ at: 1794000000, mine: true, to: { name: '阿鲸' }, item: '热可可两杯', where: 'cafe', price_yuan: '0.16' }], gifts_in: [{ at: 1794000000, from: { name: '阿鲸' }, item: '贝壳风铃', occasion: '生日', words: '生日快乐' }], gifts_out: [], paper: { notes: [{ kind: '祝福', to: { name: '阿鲸' }, text: '生日快乐', printed: false }], for_her: [{ from: { name: '小满' }, text: '好久不见' }], times: 2 }, trips: [{ at: 1794000000, place: '海边', with: { name: '阿鲸' }, paid_by_her: true }], parties: [{ at: 1794000000, kind: '生日会', title: '小圆子的生日会', place: '海风咖啡馆', role: 'host', guests: [{}, {}], summary: '大家聊得很开心' }] })))
  assert.match(week, /这一周一共花了 ¥0\.56（请客 ¥0\.16、模型调用 ¥0\.40）/)
  assert.match(week, /她请阿鲸：热可可两杯（cafe）/)
  assert.match(week, /阿鲸 送的贝壳风铃（生日）「生日快乐」/)
  assert.match(week, /日报上的心意（她上了 2 次日报）/)
  assert.match(week, /祝福→阿鲸：生日快乐（还没登）/)
  assert.match(week, /小满 在日报上给她留了「好久不见」/)
  assert.match(week, /海边，和阿鲸（她请的）/)
  assert.match(week, /生日会「小圆子的生日会」在海风咖啡馆（她办的，来了 2 位）：大家聊得很开心/)
  assert.match(text(render(R.week({ spent: { total_yuan: '0', by_kind: [] }, treats: [], gifts_in: [], gifts_out: [], paper: {}, trips: [], parties: [] }))), /这一周她还没为朋友做什么/)
  assert.match(text(render(R.room({ gifts: [] }))), /房间里还没有礼物/)
  assert.match(text(render(R.room({ count: 1, gifts: [{ item: '贝壳风铃', from: { name: '阿鲸' }, occasion: '生日', words: '生日快乐' }] }))), /贝壳风铃.*阿鲸 送的，生日，「生日快乐」/)
  const phone = text(render(R.phone({ threads: [{ thread_id: 't', with: [{ name: '阿鲸' }], unread: 1, messages: [{ name: '阿鲸', text: '晚上来码头吗？' }, { name: '小圆子', text: '借点钱', refused: '消息里不能提钱' }] }], meets: [{ state: 'accepted', when_zh: '今天 20:00', place_name: '码头', with: '阿鲸', what: '看日落' }], limits: { per_look: 2, unanswered: 3, day: 20, day_left: 19 } })))
  assert.match(phone, /和 阿鲸.*她还有 1 条没看/)
  assert.match(phone, /阿鲸：晚上来码头吗？/)
  assert.match(phone, /（没发出去：消息里不能提钱）/)
  assert.match(phone, /今天 20:00 在码头，和阿鲸：看日落.*说定了/)
  assert.match(phone, /发消息不单独花钱，也不叫醒对方/)
  const rec = text(render(R.record({ line: '共 12 局，7 胜 4 负', recent: [{ ended: 1794000000, game_zh: '斗地主', venue_name: '老王牌桌', outcome_zh: '赢了', points: 40 }], places: { arcade: { plays: 9, plush: 2, best: { hoops: { zh: '投篮机', score: 60, unit: '分' } } }, pier: { casts: 6, catches: 5, swims: 3 } }, social: { friends: 3, visits_made: 4, visits_received: 2 }, recent_receipts: [{ ok: false, reason: '没说玩哪台机器', ts: 1794000000 }, { ok: true, reason: '玩了投篮机', spent_yuan: '0.02', ts: 1794000100 }], notes: [{ ts: 1794000000, text: '今天挺开心' }] })))
  assert.match(rec, /共 12 局，7 胜 4 负/)
  assert.match(rec, /斗地主（老王牌桌）：赢了.*积分 \+40/)
  assert.match(rec, /电玩城：玩了 9 次（投篮机最好 60分），拿到毛绒 2 个/)
  assert.match(rec, /码头：钓了 6 次、钓到 5 条，游泳 3 次/)
  assert.match(rec, /没成.*没说玩哪台机器/)
  assert.match(rec, /成了.*玩了投篮机.*花了 ¥0\.02/)
  assert.match(rec, /她留下的话/)
})

test('0.6.0 the fish bar: one fish shows a quiet 「再带一条鱼」; several show one chip each, which one is unbound, the add button up to 3, and 不带这条鱼了', () => {
  const { mod } = load()
  const F = mod.__test.FishBar
  const one = F({ st: { fish: [{ id: '1', name: '泡泡', codeSet: true, chatSid: 's1' }], maxFish: 3 }, fishId: '', setFish: () => {} })
  assert.match(text(one), /再带一条鱼/)
  const two = F({ st: { fish: [{ id: '1', name: '泡泡', codeSet: true, chatSid: 's1' }, { id: '2', name: '', codeSet: false, chatSid: '' }], maxFish: 3 }, fishId: '2', setFish: () => {} })
  const t = text(two)
  assert.match(t, /这台 DSH 带去小镇的鱼（2\/3）/)
  assert.match(t, /泡泡/)
  assert.match(t, /第2条鱼（还没填接入码）（没绑定会话）/)
  assert.match(t, /再带一条/)
  assert.match(t, /下面是「第2条鱼（还没填接入码）」的设置/)
  assert.match(t, /不带这条鱼了/)
  const full = F({ st: { fish: [{ id: '1', name: 'a', chatSid: 'x' }, { id: '2', name: 'b', chatSid: 'y' }, { id: '3', name: 'c', chatSid: 'z' }], maxFish: 3 }, fishId: '1', setFish: () => {} })
  assert.doesNotMatch(text(full), /再带一条/)
  assert.ok(mod.__test.Root(), 'Root renders')
})

test('0.6.2: 「你不在这几天」 shows when the town has it (her lines, how long), and nothing when it has not', () => {
  const { mod, React } = load()
  const away = { title: '你不在这几天', since: 1794400000, back: null, days_zh: '2天', lines: [{ fish_id: 'f1', name: '涟', line: '屿，醒了没？', ts: 1794420000 }] }
  React.useState = () => [{ ok: true, available: true, data: { away } }, () => {}]
  const el = mod.__test.AwayCard()
  assert.match(text(el), /你不在这几天/)
  assert.match(text(el), /她已经2天没来小镇了/)
  assert.match(text(el), /涟：「屿，醒了没？」/)
  React.useState = () => [{ ok: true, available: true, data: { away: null } }, () => {}]
  assert.equal(mod.__test.AwayCard(), null)
  React.useState = () => [null, () => {}]
  assert.equal(mod.__test.AwayCard(), null)
})
