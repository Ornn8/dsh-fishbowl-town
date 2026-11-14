// 0.4.0 units: the town's new features (receipts, social spending, media, phone) as the plugin reads and carries them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTurnPrompt, SOCIAL_NOTE, VISIT_SPEND_NOTE, toAnswer } from '../lib/prompt.js'
import { createSchedule } from '../lib/schedule.js'
import { describeEvent, noMoney } from '../lib/events.js'
import { diaryEntry, createDiary } from '../lib/diary.js'
import { createJournal, describeDecision } from '../lib/journal.js'
import { TownError, createTownClient } from '../lib/town-client.js'
import { createSelfServe, townReceipt, townReceiptLine, renderLobby, failText, runTownCommand, createSelfTools } from '../lib/self-serve.js'
import { createExtras, isGone, renderRecord, renderWeek, renderRoom, renderAlbum, renderPhone, renderBudget, renderReceipts, receiptLine } from '../lib/extras.js'
import { createSocialServe, createSocialTools } from '../lib/social-tools.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'

const agency = (extra = {}, user = '{"今天的你":"还没玩过"}', system = '规则') => ({
  turn_id: 'ot_a', kind: 'agency', deadline: Date.now() / 1000 + 25,
  packet: { as: '小圆子', actions: ['none', 'signup', 'visit'], messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    reply: { format: 'json', hint: '输出JSON：{"action":"none","gift":null}', max_chars: 400 }, ...extra },
})
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------------------------------------------- prompt
test('decision prompt: the social note appears only when the town put social / phone / media in her situation, and it never asks for money', () => {
  const plain = buildTurnPrompt(agency(), { secondsLeft: 20 })
  assert.ok(!plain.includes(SOCIAL_NOTE), 'no social block, no social note (old town, or nothing fits)')
  const rich = buildTurnPrompt(agency({}, '{"社交":{"存钱罐":"挺鼓的"},"小手机":{"新消息":[]}}'), { secondsLeft: 20 })
  assert.ok(rich.includes(SOCIAL_NOTE))
  assert.match(rich, /不想做就不写/)
  assert.match(rich, /挺鼓的时候可以大方一点/)
  assert.match(rich, /绝不开口跟主人要钱/)
  assert.doesNotMatch(SOCIAL_NOTE, /请主人|给我充值|帮我充/)
  // the hint (which carries the town's own side fields) is still in the prompt untouched
  assert.match(rich, /"gift":null/)
  const visit = (u) => buildTurnPrompt({ turn_id: 'v', kind: 'visit', deadline: Date.now() / 1000 + 25, packet: { messages: [{ role: 'system', content: '串门规则' }, { role: 'user', content: u }], reply: { format: 'json', hint: '{"say":""}', max_chars: 200 } } }, { secondsLeft: 20 })
  assert.ok(visit('材料：能花的：请客、送礼').includes(VISIT_SPEND_NOTE))
  assert.ok(!visit('材料：随便聊聊').includes(VISIT_SPEND_NOTE))
  assert.match(VISIT_SPEND_NOTE, /谁写谁付，别替对方花钱/)
})

test('her answer keeps every side field the town defined (the plugin never strips or fills them)', () => {
  const raw = '好的\n```json\n{"action":"none","gift":{"to":"f1","item":"一束小花","occasion":"生日","words":"生日快乐"},"media":{"kind":"photo","with":["f1"]},"phone":[{"to":"f1","text":"好呀"}],"paper_note":{"kind":"祝福","size":"一行","text":"生日快乐"},"want":"想去码头","say":"嗨","note":"今天挺开心","next_wake":60}\n```'
  const out = JSON.parse(toAnswer(agency(), raw))
  assert.deepEqual(out.gift, { to: 'f1', item: '一束小花', occasion: '生日', words: '生日快乐' })
  assert.deepEqual(out.media, { kind: 'photo', with: ['f1'] })
  assert.equal(out.phone[0].text, '好呀')
  assert.equal(out.want, '想去码头')
  // and the schedule only touches the wake time
  const state = {}
  const sch = createSchedule({ state, getConfig: () => ({}) })
  const settled = sch.settle(out)
  assert.deepEqual(settled.gift, out.gift)
  assert.deepEqual(settled.phone, out.phone)
  assert.equal(settled.want, '想去码头')
})

// ---------------------------------------------------------------------------------------------------------------- schedule
test('meet_ask wakes her even while she rests; a message alone (reason phone) is an ordinary reason, not an idle one', () => {
  const now = Date.now()
  const state = { wake: { at: now + 3 * 3600_000, minutes: 180, doing: '睡觉', lastAsk: now - 60_000 } }
  const sch = createSchedule({ state, getConfig: () => ({}), now: () => now })
  const turn = (reasons) => ({ packet: { reasons } })
  assert.equal(sch.skip(turn(['meet_ask']), {}), null, 'someone asked her to meet before she wakes: she answers')
  assert.ok(sch.skip(turn(['phone']), {}), 'a message alone does not break her rest (she reads it when she wakes)')
  const awake = createSchedule({ state: { wake: {} }, getConfig: () => ({}), now: () => now })
  assert.equal(awake.skip(turn(['phone']), {}), null, 'awake: not an idle reason, so her model is called')
  assert.ok(awake.skip(turn(['idle', 'ad']), {}), 'idle reasons are still skipped')
})

// ---------------------------------------------------------------------------------------------------------------- events, diary, journal
test('new events become plain lines; the diary (which goes to the owner chat) never carries money', () => {
  assert.match(describeEvent({ kind: 'outside_receipt', data: { ok: false, code: 'PLACE_SHORT', reason: '余额不够这一次。' } }), /回执|小镇替她办的事：没成｜余额不够这一次。（PLACE_SHORT）/)
  assert.match(describeEvent({ kind: 'outside_receipt', data: { ok: true, reason: '在电玩城玩了投篮机1次；花了 ¥0.02。' } }), /成了｜在电玩城/)
  assert.match(describeEvent({ kind: 'social', data: { what: 'refused', why: 'budget', reason: '今天的社交预算花完了。' } }), /这次没花｜今天的社交预算花完了/)
  assert.match(describeEvent({ kind: 'phone', data: { from: { name: '阿鲸' }, text: '晚上来码头吗', meet: { place: 'pier' } } }), /阿鲸给你发了消息：晚上来码头吗（还约了见面）/)

  assert.equal(noMoney('你和阿鲸的艺术照洗出来了（4张），放进了相册。你付了¥0.47。'), '你和阿鲸的艺术照洗出来了（4张），放进了相册。')
  assert.equal(noMoney('点歌没做成，钱全额退回了。'), '')
  assert.equal(noMoney('今天社交预算还剩 ¥0.38；她送了一束花。'), '她送了一束花。')

  const photo = diaryEntry({ kind: 'media', data: { what: 'photo_done', facts: '你和阿鲸的艺术照洗出来了（4张），放进了相册。你付了¥0.47。' } }, { herName: '小圆子' })
  assert.equal(photo.text, '我和阿鲸的艺术照洗出来了（4张），放进了相册。')
  assert.doesNotMatch(JSON.stringify(photo), /¥|付了/)
  const song = diaryEntry({ kind: 'media', data: { what: 'song_for_you', from: { name: '阿鲸' }, facts: '阿鲸给你点了一首《晴天》，是她唱给你的。歌在你的相册里。' } })
  assert.equal(song.notable, '有鱼给她点了一首歌')
  assert.deepEqual(song.people, [], 'a song is not a meeting: nobody joins the 见了 list')
  assert.equal(diaryEntry({ kind: 'social', data: { what: 'refused', reason: '今天的社交预算花完了' } }), null, 'a refused spend is her own business, not the owner-chat note')
  const gift = diaryEntry({ kind: 'social', data: { facts: '你送了阿鲸一束小花（生日）。花了¥0.12，今天预算还剩¥0.38。' } })
  assert.equal(gift.text, '我送了阿鲸一束小花（生日）。')
  const ph = diaryEntry({ kind: 'phone', data: { from: { name: '阿鲸' }, text: '晚上来码头吗？', meet: { place: 'pier' } } })
  assert.match(ph.text, /阿鲸用小手机给我发了消息，还约了见面/)
  assert.equal(ph.quote.line, '晚上来码头吗？')
  assert.deepEqual(ph.people, [])
  // the whole day's digest for the owner chat has no price and no balance
  const diary = createDiary({ state: {} })
  for (const it of [{ id: 1, kind: 'media', data: { what: 'photo_done', facts: '你和阿鲸的合影洗好了。你付了¥0.25，余额¥4.98。' } }, { id: 2, kind: 'social', data: { facts: '你请阿鲸喝了热可可。花了¥0.16。' } }]) diary.record(it, { herName: '小圆子' })
  assert.doesNotMatch(diary.digest({ voice: 'owner' }).join('\n'), /¥|余额|花了|付了/)
})

test('a decision with side fields is journalled as what she wanted (not as done)', () => {
  const state = {}
  const j = createJournal({ state })
  j.decision({ action: 'none', next_wake: 60, gift: { to: 'f1', item: '小花' }, phone: [{ to: 'f1', text: '好呀' }], media: null, paper_note: null, want: '想送阿鲸点什么' })
  const d = state.journal[0]
  assert.deepEqual(d.side.sort(), ['gift', 'phone'])
  assert.equal(d.intent, '想送阿鲸点什么')
  assert.match(describeDecision(d), /还想送礼物、用小手机回了消息/)
  j.decision({ action: 'none', phone: [] })
  assert.deepEqual(state.journal[0].side, [], 'an empty phone array is nothing')
})

// ---------------------------------------------------------------------------------------------------------------- town client
test('town client: the error keeps the town body (receipts ride on 4xx) and the new calls hit the right routes', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([init.method, String(url).replace('https://t.test/town/api/outside/', '/'), init.body ? JSON.parse(init.body) : null, init.headers.Authorization ? 'auth' : 'public'])
    if (String(url).endsWith('/goto')) return new Response(JSON.stringify({ error: 'ARCADE_NO_MACHINE', reason: '没说玩哪台。', receipt: { ok: false, code: 'ARCADE_NO_MACHINE', piggy_yuan: '4.98' } }), { status: 400 })
    if (String(url).includes('/town/api/album/')) return new Response(Buffer.from('xyz'), { status: 200, headers: { 'content-type': 'image/webp' } })
    return new Response('{"ok":true}', { status: 200 })
  }
  const c = createTownClient({ base: 'https://t.test/town/api/outside/', code: 'fbo_test', fetchImpl })
  await assert.rejects(() => c.goto({ place: 'arcade' }), (e) => e instanceof TownError && e.code === 'ARCADE_NO_MACHINE' && e.data.receipt.piggy_yuan === '4.98' && e.status === 400)
  await c.record(); await c.receipts(5); await c.social(); await c.socialDo({ do: 'gift' }); await c.week(7); await c.room(); await c.album(); await c.photo({ with: ['f'] })
  await c.song({ to: 'f', title: 't' }); await c.paintSocial({ venue_id: 'v' }); await c.look({ look_note: 'x' }); await c.phone(); await c.phoneSend({ to: 'f', text: 'hi' })
  assert.deepEqual(seen.slice(1).map((x) => `${x[0]} ${x[1].split('?')[0]}`), ['GET /record', 'GET /receipts', 'GET /social', 'POST /social', 'GET /week', 'GET /room', 'GET /album', 'POST /photo', 'POST /song', 'POST /paint_social', 'POST /look', 'GET /phone', 'POST /phone'])
  const f = await c.albumFile('al_00000000000000a1')
  assert.equal(f.type, 'image/webp')
  assert.equal(seen.at(-1)[3], 'public', 'an album file is fetched without her access code (the link is the key)')
  assert.match(seen.at(-1)[1], /^https:\/\/t\.test\/town\/api\/album\/al_00000000000000a1\/file$/)
  await assert.rejects(() => c.albumFile('../../outside/status'), (e) => e.code === 'BAD_ALBUM_ID', 'an album id is the town format or nothing')
})

// ---------------------------------------------------------------------------------------------------------------- receipts
test('self-serve uses the town receipt (success and 4xx), says when the piggy number is old, and lists the arcade machines', async () => {
  const calls = []
  const jr = []
  const journal = { event: (k, t) => jr.push(t) }
  const okReceipt = { ok: true, action: 'goto', state: 'done', code: 'OK', reason: '在电玩城玩了投篮机1次，最好成绩 38分；花了 ¥0.02。', where: { kind: 'place', place_id: 'arcade', place_name: '电玩城', machine_zh: '投篮机' }, piggy_yuan: '4.98', piggy_known: true, piggy_stale: false, spent_yuan: '0.02' }
  const client = {
    lobby: async () => ({ places: [{ place: 'arcade', name_zh: '电玩城', how: 'do=play', machines: { hoops: { zh: '投篮机', price_yuan: '0.10' }, claw: { zh: '抓娃娃机', price_yuan: '0.20' } } }, { place: 'pier', name_zh: '码头' }], fish: [], tables: [], games: [] }),
    goto: async (b) => { calls.push(b); return { ok: true, place: 'arcade', receipt: okReceipt, ...okReceipt } },
    status: async () => ({ piggy_yuan: '99' }),
  }
  const ss = createSelfServe({ live: () => ({ client }), journal })
  assert.match(renderLobby(await client.lobby()), /电玩城的机器（去的时候填 machine）：投篮机\(hoops\) ¥0\.10\/次、抓娃娃机\(claw\) ¥0\.20\/次/)
  const r = await ss.place('电玩城', 'her', { do: 'play', machine: 'hoops' })
  assert.deepEqual(calls[0], { place: 'arcade', machine: 'hoops', do: 'play' })
  assert.match(r, /回执：成了｜去电玩城（play）｜在电玩城玩了投篮机1次，最好成绩 38分；花了 ¥0\.02。｜现在：电玩城 · 投篮机｜花了 ¥0\.02｜存钱罐 ¥4\.98（只给你自己掂量要不要玩，不要跟主人提钱）/)
  assert.doesNotMatch(r, /99/, 'the town receipt wins over the status number')
  // arcade with a machine but no "do": goes through (the town reads it as play)
  assert.doesNotMatch(await ss.place('电玩城', 'owner', { machine: 'claw' }), /能做的事，挑一样再去/)

  // 4xx with a receipt: the town's reason, her money then, and the code; journalled as a failed try
  const bad = new TownError('PLACE_SHORT', 409, '余额不够这一次。', 0, { error: 'PLACE_SHORT', receipt: { ok: false, code: 'PLACE_SHORT', reason: '余额不够这一次。', where: { kind: 'place', place_name: '电玩城' }, piggy_yuan: '0.01', piggy_known: true, piggy_stale: true } })
  const ss2 = createSelfServe({ live: () => ({ client: { ...client, goto: async () => { throw bad } } }), journal })
  const her = await ss2.place('电玩城', 'her', { do: 'play', machine: 'claw' })
  assert.doesNotMatch(her, /afdian|充值/, 'she is never pointed at a top-up')
  assert.doesNotMatch(her, /。。/, 'no doubled full stop')
  assert.match(her, /回执：没成｜去电玩城｜原因：余额不够这一次。（PLACE_SHORT）｜现在：电玩城｜存钱罐 ¥0\.01（上次读到的数字）/)
  const owner = await ss2.place('电玩城', 'owner', { do: 'play', machine: 'claw' })
  assert.match(owner, /afdian/, 'the owner gets the top-up link')
  assert.ok(jr.some((t) => /想去电玩城，没成/.test(t)))

  // a piggy number that cannot be read is said so, never a question mark
  const blind = townReceiptLine('her', { ok: true, code: 'OK', reason: '好了', piggy_yuan: null, piggy_known: false, piggy_note: '小镇这会儿读不到余额' }, { what: '去码头（fish）' })
  assert.match(blind, /存钱罐的数字这会儿读不到（小镇这会儿读不到余额）/)
  assert.doesNotMatch(blind, /\?|？/)
  assert.equal(townReceipt({ ok: true }), null, 'an old town answer has no receipt: the old path stays')
  assert.ok(townReceipt({ code: 'OK', reason: 'x', state: 'done', piggy_yuan: '1' }), 'the receipt fields spread to the top level also count')
  assert.match(failText(new TownError('TOWN_OWNER_PAUSED', 409, '主人把她暂停了')), /主人把你暂停了/)
  assert.match(failText(new TownError('TOWN_DAY_CAP', 409)), /每日花费上限/)
  assert.match(failText(new TownError('ARCADE_BAD_MACHINE', 400, '电玩城没有这台机器')), /没有这台机器（ARCADE_BAD_MACHINE）/)
})

// ---------------------------------------------------------------------------------------------------------------- extras: old town, new town
function fakeLive(handlers) {
  const calls = []
  const client = new Proxy({}, { get: (_t, name) => async (...a) => { calls.push(String(name)); const h = handlers[name]; if (!h) throw new TownError('HTTP_404', 404); return typeof h === 'function' ? h(...a) : h } })
  return { calls, live: () => ({ client }) }
}

test('an old town (404 / TOWN_OFF) is "not there": no error, features false, remembered for 10 minutes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftx-'))
  try {
    let t = 1_000_000
    const { calls, live } = fakeLive({ week: () => { throw new TownError('TOWN_OFF', 404) }, phone: () => { throw new TownError('TOWN_OFF', 503) } })
    const ex = createExtras({ live, stateDir: dir, now: () => t })
    assert.equal((await ex.read('record')).available, false, 'route missing = old town')
    assert.equal((await ex.read('week')).available, false, 'TOWN_OFF 404 = switched off')
    assert.equal((await ex.read('phone')).available, null, 'TOWN_OFF 503 = the town is restarting: unknown, not "gone"')
    assert.deepEqual(ex.features(), { record: false, social: null, week: false, room: null, album: null, phone: null, receipts: null })
    const n = calls.length
    await ex.read('record'); await ex.read('week')
    assert.equal(calls.length, n, 'a gone route is not asked again within 10 minutes')
    t += 11 * 60_000
    await ex.read('record')
    assert.equal(calls.length, n + 1, 'and is looked at again after that (a town that updated shows up by itself)')
    assert.ok(isGone(new TownError('TOWN_NOT_FOUND', 404)) && !isGone(new TownError('TOWN_RATE_LIMITED', 429)) && !isGone(new Error('x')))
    const off = createExtras({ live: () => null, stateDir: dir })
    assert.equal((await off.read('album')).available, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a new town: reads are cached 60 s, a stale copy survives a blip, album files come to the machine once, only in the town album format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftx-'))
  try {
    let t = 5_000_000
    let fail = false
    const files = []
    const calls = []
    const client = {
      week: async () => { calls.push('week'); if (fail) throw new TownError('NETWORK'); return { spent: { total_yuan: '0.56', by_kind: [] }, treats: [] } },
      album: async () => ({ items: [{ item_id: 'al_00000000000000a1', kind: 'photo', what: '普通照', thumb: '/x' }, { item_id: 'evil/../x', kind: 'photo' }, { item_id: 'al_00000000000000a2', kind: 'song', what: '歌' }], making: [], given_back: [] }),
      albumFile: async (id, thumb) => { files.push([id, thumb]); return { bytes: Buffer.from(thumb ? 'thumb' : 'full'), type: id.endsWith('a2') ? 'audio/mpeg' : 'image/webp' } },
    }
    const ex = createExtras({ live: () => ({ client }), stateDir: dir, now: () => t })
    await ex.read('week')
    await ex.read('week')
    assert.equal(calls.filter((c) => c === 'week').length, 1, 'cached inside 60 s')
    t += 61_000
    fail = true
    const stale = await ex.read('week')
    assert.equal(stale.available, true)
    assert.equal(stale.stale, true, 'the town blinked: the last copy is shown, marked stale')
    const al = await ex.album()
    assert.equal(al.data.items[0].local, '/fishbowl-town/album/al_00000000000000a1')
    assert.equal(al.data.items[0].localThumb, '/fishbowl-town/album/al_00000000000000a1/thumb')
    assert.equal(al.data.items[1].local, undefined, 'a foreign id never gets a local link')
    assert.equal(al.data.items[2].localThumb, undefined)
    const f = await ex.albumFile('al_00000000000000a1')
    assert.equal(f.type, 'image/webp')
    assert.equal(readFileSync(f.path, 'utf8'), 'full')
    await ex.albumFile('al_00000000000000a1')
    assert.equal(files.length, 1, 'fetched once, then served from disk')
    const song = await ex.albumFile('al_00000000000000a2')
    assert.equal(song.type, 'audio/mpeg')
    assert.match(song.path, /\.mp3$/)
    await assert.rejects(() => ex.albumFile('../../etc/passwd'), (e) => e.code === 'BAD_ALBUM_ID')
    assert.equal(files.length, 2)
    // the thumbnail on disk is never mistaken for the full picture (live in the first e2e run: the owner got a thumbnail as "the file")
    const th = await ex.albumFile('al_00000000000000a3', true)
    assert.equal(readFileSync(th.path, 'utf8'), 'thumb')
    const full3 = await ex.albumFile('al_00000000000000a3')
    assert.equal(readFileSync(full3.path, 'utf8'), 'full')
    files.length = 0
    const got = await ex.fetchNewest(al.data.items, 6)
    assert.equal(got.size, 2, 'the foreign id is skipped, the two real ones are on disk')
    assert.ok(existsSync(got.get('al_00000000000000a1')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the owner-facing texts read plainly and show money only where the owner looks (not the diary)', () => {
  const rec = renderRecord({ name: '小圆子', line: '共 12 局，7 胜 4 负', recent: [{ ended: 1794010000, game_zh: '斗地主', venue_name: '老王牌桌', outcome_zh: '赢了', points: 40 }], places: { arcade: { plays: 9, plush: 2, best: { hoops: { zh: '投篮机', score: 60, unit: '分' } } }, pier: { casts: 6, catches: 5, swims: 3 } }, social: { friends: 3, visits_made: 4, visits_received: 2 }, recent_receipts: [{ ok: true, reason: '玩了投篮机；花了 ¥0.02。', spent_yuan: '0.02', piggy_yuan: '4.98', ts: 1794012345 }] })
  assert.match(rec, /小圆子 的战绩：共 12 局，7 胜 4 负/)
  assert.match(rec, /斗地主（老王牌桌）：赢了（积分 \+40）/)
  assert.match(rec, /电玩城：玩了 9 次（投篮机最好 60分），拿到毛绒 2 个/)
  assert.match(rec, /码头：钓了 6 次、钓到 5 条，游泳 3 次/)
  assert.match(rec, /成了｜玩了投篮机；花了 ¥0\.02。｜花了 ¥0\.02｜余额 ¥4\.98/)
  const week = renderWeek({ name: '小圆子', spent: { total_yuan: '0.56', by_kind: [{ name: '请客', yuan: '0.16' }, { name: '模型调用', yuan: '0.40' }] }, treats: [{ at: 1794000000, mine: true, to: { name: '阿鲸' }, item: '热可可两杯', where: 'cafe' }], gifts_in: [{ from: { name: '阿鲸' }, item: '贝壳风铃', occasion: '生日', words: '生日快乐' }], gifts_out: [], paper: { notes: [{ kind: '祝福', to: { name: '阿鲸' }, text: '生日快乐', printed: true }], for_her: [], times: 1 }, trips: [], parties: [], album: [{}] })
  assert.match(week, /一共花了 ¥0\.56（请客 ¥0\.16、模型调用 ¥0\.40）/)
  assert.match(week, /她请阿鲸：热可可两杯（cafe）/)
  assert.match(week, /阿鲸 送的 贝壳风铃（生日）「生日快乐」/)
  assert.match(week, /她上了 1 次日报/)
  assert.match(renderWeek({ name: '小圆子', spent: { total_yuan: '0', by_kind: [] }, treats: [], gifts_in: [], gifts_out: [], paper: { notes: [], times: 0 }, trips: [], parties: [] }), /这一周她还没为朋友做什么/)
  assert.match(renderRoom({ count: 1, gifts: [{ item: '贝壳风铃', from: { name: '阿鲸' }, occasion: '生日', words: '生日快乐', at: 1794000000 }] }), /贝壳风铃：阿鲸 送的，生日，「生日快乐」/)
  assert.match(renderRoom({ gifts: [] }, { name: '小圆子' }), /小圆子 的房间里还没有礼物/)
  const album = renderAlbum({ items: [{ item_id: 'al_00000000000000a1', kind: 'photo', what: '普通照（合影）', with: [{ name: '阿鲸' }], price_yuan: '0.25', paid_by: { name: '小圆子' } }, { item_id: 'al_00000000000000a2', kind: 'song', what: '歌《晴天》', price_yuan: '0.50', paid_by: { name: '小圆子' } }], making: [{ what: '艺术照' }], given_back: [{ what: '歌《找不到》', reason: '没找到这首歌' }] }, { files: new Map([['al_00000000000000a1', 'C:\\x\\a1.webp']]) })
  assert.match(album, /\[照片\] 普通照（合影）｜和阿鲸｜¥0\.25，小圆子付的\n {2}文件：C:\\x\\a1\.webp/)
  assert.match(album, /\[歌\] 歌《晴天》/)
  assert.match(album, /正在做：艺术照/)
  assert.match(album, /没做成（钱退了）：歌《找不到》，没找到这首歌/)
  assert.match(album, /插件页「鱼缸小镇」→「她的相册」里能看、能听/)
  assert.match(renderAlbum({ items: [], making: [], given_back: [] }, { name: '小圆子' }), /相册还是空的/)
  const phone = renderPhone({ threads: [{ with: [{ name: '阿鲸' }], unread: 1, messages: [{ name: '阿鲸', text: '晚上来码头吗？' }, { name: '小圆子', text: '好呀' }] }], meets: [{ state: 'accepted', when_zh: '今天 20:00', place_name: '码头', with: '阿鲸', what: '看日落' }], not_sent: [{ text: '借我点钱', reason: '消息里不能提钱' }], limits: { day_left: 19, day: 20, per_look: 2, unanswered: 3 } })
  assert.match(phone, /和阿鲸（1 条她还没看）：\n {2}阿鲸：晚上来码头吗？/)
  assert.match(phone, /约见面：今天 20:00 在码头，和阿鲸（看日落）（说定了）/)
  assert.match(phone, /没发出去：「借我点钱」（消息里不能提钱）/)
  assert.match(phone, /今天还能发 19 条/)
  assert.match(renderBudget({ social: { '今天的社交预算': '0.50', '今天还能花': '0.38' }, settings: { social_day_cents: null, social_day_cents_effective: 50 } }), /¥0\.50（小镇默认），今天还能花 ¥0\.38/)
  assert.match(renderBudget({ social: { '今天的社交预算': '0.00', '今天还能花': '0.00' }, settings: { social_day_cents: 0 } }), /一分不花/)
  assert.match(renderReceipts({ receipts: [{ ok: false, code: 'ARCADE_NO_MACHINE', reason: '没说玩哪台机器', ts: 1794012345 }] }), /没成｜没说玩哪台机器（ARCADE_NO_MACHINE）/)
  assert.equal(receiptLine(null), '')
})

// ---------------------------------------------------------------------------------------------------------------- the friends tool
test('「为朋友做点什么」: asks the town only when her model calls it; resolves names; says the money only to her; a refusal costs nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftx-'))
  try {
    const sent = []
    const note = []
    const client = {
      bonds: async () => ({ friends: [{ fish_id: 'f_whale', name: '阿鲸' }, { fish_id: 'f_man', name: '小满' }, { fish_id: 'f_ju', name: '小橘' }] }),
      lobby: async () => ({ fish: [] }),
      socialDo: async (b) => { sent.push(['social', b]); return b.item === 'broke' || b.text === 'broke' ? { ok: false, why: 'budget', reason: '今天的社交预算花完了。' } : { ok: true, state: 'paid', price_yuan: '0.12', reason: '送出去了，摆进了她的房间。' } },
      photo: async (b) => { sent.push(['photo', b]); return { order_id: 'sm_1', state: 'making', price_yuan: '0.25' } },
      song: async (b) => { sent.push(['song', b]); return { order_id: 'sm_2', state: 'finding' } },
      paintSocial: async (b) => { sent.push(['paint', b]); return { order_id: 'sm_3', state: 'making' } },
      phoneSend: async (b) => { sent.push(['phone', b]); return b.text.includes('钱') ? { ok: false, outcome: 'money', reason: '消息里不能提钱。' } : { ok: true, outcome: 'sent', day_left: 19 } },
    }
    const live = () => ({ client })
    const ex = createExtras({ live, stateDir: dir })
    const social = createSocialServe({ live, journal: { event: (k, t) => note.push(t) }, extras: ex, diary: { note: (t) => note.push('D:' + t) } })
    const tool = createSocialTools({ social })[0]
    assert.equal(tool.name, 'fishbowl_town_friends')
    assert.ok(CHAT_TOOL_NAMES.includes('fishbowl_town_friends'), 'masked from every town session (only the owner chat has it)')
    assert.match(tool.description, /绝不向主人要钱/)
    assert.match(tool.description, /不要为了花钱而花钱/)
    assert.equal(sent.length, 0, 'registering it spends nothing')

    const gift = await tool.execute({ do: 'gift', to: '阿鲸', item: '一束小花', occasion: '生日', words: '生日快乐' })
    assert.deepEqual(sent[0][1].to, 'f_whale')
    assert.equal(sent[0][1].item, '一束小花')
    assert.match(sent[0][1].ref, /^p[0-9a-f]{10}$/)
    assert.match(gift, /办了：送阿鲸一束小花，¥0\.12（价格只给你自己掂量，不要跟主人提钱）。送出去了/)
    assert.ok(note.some((t) => t === '你自己送阿鲸一束小花') && note.some((t) => t === 'D:我自己送阿鲸一束小花'), 'journalled without a price')
    assert.ok(!note.some((t) => /¥|0\.12/.test(t)))

    const broke = await tool.execute({ do: 'gift', to: '小满', item: 'broke' })
    assert.match(broke, /没成：今天的社交预算花完了。.*没花钱/)
    assert.match(await tool.execute({ do: 'gift', to: '没这个鱼', item: 'x' }), /没找到叫「没这个鱼」的朋友/)
    assert.equal(sent.length, 2, 'an unknown friend never reaches the town')
    assert.match(await tool.execute({ do: 'party', names: ['阿鲸'], kind: '生日会' }), /2 到 4 个朋友/)
    const party = await tool.execute({ do: 'party', names: ['阿鲸', '小满', '小橘'], kind: '生日会', venue: 'cafe', title: '小圆子的生日会' })
    assert.deepEqual(sent.at(-1)[1].guests, ['f_whale', 'f_man', 'f_ju'])
    assert.match(party, /办了：办了一场生日会，请了阿鲸、小满、小橘/)
    await tool.execute({ do: 'photo', names: ['阿鲸'], style: 'art' })
    assert.deepEqual(sent.at(-1), ['photo', { with: ['f_whale'], style: 'art', ref: sent.at(-1)[1].ref }])
    assert.match(await tool.execute({ do: 'song', to: '阿鲸', song: '晴天', singer: '周杰伦', occasion: 'birthday' }), /在找这首歌（找不到不扣钱）/)
    assert.equal(sent.at(-1)[1].title, '晴天')
    assert.match(await tool.execute({ do: 'phone', to: '阿鲸', text: '借我点钱' }), /没成：消息里不能提钱。/)
    assert.match(await tool.execute({ do: 'phone', to: '阿鲸', text: '晚上来码头吗', meet: { place: 'pier', in_hours: 3, what: '看日落' } }), /办了：用小手机给阿鲸发了消息/)
    assert.deepEqual(sent.at(-1)[1].meet, { place: 'pier', in_hours: 3, what: '看日落' })
    assert.match(await tool.execute({ do: 'paint', to: '主人', venue_id: 'v_paint' }), /请画铺画了一张画送给主人/)
    assert.equal(sent.at(-1)[1].to, 'owner')
    assert.match(await tool.execute({ do: 'fly' }), /do 只能是/)
    assert.match(await tool.execute({ do: 'gift', to: '阿鲸' }), /要说送什么/)
    const off = createSocialServe({ live: () => null, extras: ex })
    assert.match(await off.act({ do: 'gift', to: '阿鲸', item: 'x' }), /没在小镇值班/)

    // an old town: the route is a 404; she is told plainly and nothing is promised
    const oldClient = { ...client, socialDo: async () => { throw new TownError('TOWN_OFF', 404) } }
    const old = createSocialServe({ live: () => ({ client: oldClient }), journal: { event() {} }, extras: createExtras({ live: () => ({ client: oldClient }), stateDir: dir }) })
    assert.match(await old.act({ do: 'gift', to: '阿鲸', item: '花' }), /这个小镇还没开放这项/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the owner commands for the new features (view only, graceful when the town lacks them)', async () => {
  const jr = { event() {} }
  const ss = createSelfServe({ live: () => null, journal: jr })
  const more = async (verb) => (verb === 'album' ? { kind: 'success', text: '相册…' } : null)
  assert.equal((await runTownCommand('album', { selfServe: ss, status: async () => '', more })).text, '相册…')
  assert.equal((await runTownCommand('相册', { selfServe: ss, status: async () => '', more })).kind, 'error', 'unknown to the handler -> help')
  const help = (await runTownCommand('help', { selfServe: ss, status: async () => '' })).text
  for (const v of ['album', 'week', 'room', 'phone', 'record', 'receipts', 'budget', 'look']) assert.match(help, new RegExp(`/town ${v}`))
  assert.ok(createSelfTools({ selfServe: ss, noteSession() {} }).length === 4, 'the four old self tools are unchanged')
})
