// 0.4.0：小镇的新功能（社交消费、相册、她的一周、房间礼物、小手机、战绩、回执、长相）怎么读、怎么缓存、怎么写给主人看。
//
// 都是只读的小镇接口（外加主人的两件事：社交预算、长相），不调模型；她自己的决定在拿主意的回合里（prompt.js 的分寸、小镇写的字段），
// 或者在聊天里用「为朋友做点什么」（social-tools.js）。这里不替她花一分钱。
//
// 旧版小镇没有这些接口（404 / TOWN_OFF）：当作「没有」，不报错、页面和命令里都不显示；10 分钟后再看一眼（小镇新版上线后自己出现）。
// 小镇所有接口共用 60 次 / 10 分钟：每一项最多 60 秒读一次，页面只读展开着的那几项。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TownError } from './town-client.js'

export const SECTIONS = ['record', 'social', 'week', 'room', 'album', 'phone', 'receipts', 'away']
const TTL = 60_000
const GONE_TTL = 10 * 60_000 // 没有这个接口：10 分钟后再看一眼
const ALBUM_ID = /^al_[0-9a-f]{16}$/
const EXT = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/mp4': '.m4a' }
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]))
TYPE['.wav'] = 'audio/wav'

const arr = (v) => (Array.isArray(v) ? v : [])
const str = (v, n = 60) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const yuan = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : `¥${Number(v).toFixed(2)}`)
const nm = (x) => str(typeof x === 'string' ? x : x && (x.name || x.fish_id), 14)
const when = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n < 1e12 ? n * 1000 : n)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 小镇说「没有这个接口 / 这项还没开放」：旧版小镇，或者这一项还没打开。 */
export function isGone(error) {
  return error instanceof TownError && (error.status === 404 || error.code === 'HTTP_404' || error.code === 'TOWN_NOT_FOUND' || (error.code === 'TOWN_OFF' && error.status !== 503))
}

export function createExtras({ live, stateDir, log = { info() {}, debug() {}, warn() {} }, now = () => Date.now(), query = '' }) {
  const cache = new Map() // name -> { at, available, data }
  const inflight = new Map()
  const dir = join(stateDir, 'album')
  const client = () => { const l = live(); return l ? l.client : null }

  const FETCH = {
    record: (c) => c.record(),
    social: (c) => c.social(),
    week: (c) => c.week(7),
    room: (c) => c.room(),
    album: (c) => c.album(30),
    phone: (c) => c.phone(),
    receipts: (c) => c.receipts(20),
    // 0.6.2：「你不在这几天」——她离开超过一天时、回来后三天内，小镇的关系数据里带着（town retention A2）；旧版小镇没有就是 null
    away: (c) => c.bonds().then((b) => ({ away: (b && typeof b.away === 'object' && b.away) || null })),
  }

  /** 读一项：{available: true|false|null, data?, stale?, at}。available=false 是这个小镇没有（不显示）；null 是这会儿读不到（不知道）。 */
  async function read(name, { force = false, ttl = TTL } = {}) {
    const c = client()
    const had = cache.get(name)
    if (!c || !FETCH[name]) return { available: null, off: !c, at: 0 }
    if (had && !force && now() - had.at < (had.available === false ? GONE_TTL : ttl)) return had
    if (inflight.has(name)) return inflight.get(name)
    const p = (async () => {
      try {
        const data = await FETCH[name](c)
        const row = { available: true, data, at: now() }
        cache.set(name, row)
        return row
      } catch (error) {
        if (isGone(error)) { const row = { available: false, at: now() }; cache.set(name, row); return row }
        log.debug?.(`读小镇「${name}」失败：`, error?.code || error?.message || error)
        if (had && had.available) return { ...had, stale: true }
        return { available: null, error: error?.code || 'UNKNOWN', at: now() }
      }
    })().finally(() => inflight.delete(name))
    inflight.set(name, p)
    return p
  }

  /** 哪些项这个小镇有（true）、没有（false）、还不知道（null）。 */
  function features() {
    const out = {}
    for (const n of SECTIONS) { const row = cache.get(n); out[n] = row ? row.available : null }
    return out
  }
  /** 悄悄看一遍有哪些项（最多 10 分钟一次，一项一项来，不抢小镇的 60 次额度）。 */
  let probing = 0
  async function probe() {
    if (probing && now() - probing < GONE_TTL) return features()
    probing = now()
    for (const n of ['record', 'social', 'week', 'album', 'phone', 'room']) {
      if (!client()) break
      await read(n)
      await new Promise((r) => setTimeout(r, 400))
    }
    return features()
  }
  function forget(...names) { if (!names.length) { cache.clear(); probing = 0 } else for (const n of names) cache.delete(n) }

  // ---------- 相册文件：下载到本机，由插件页的同源路径放给主人看 / 听 ----------
  function cached(id, thumb) {
    try {
      mkdirSync(dir, { recursive: true })
      const base = thumb ? `${id}.thumb` : id
      // 大图和缩略图放在同一个文件夹：<id>.webp 和 <id>.thumb.webp，找大图时不能把缩略图当成它
      const hit = readdirSync(dir).find((f) => f.startsWith(base + '.') && !f.endsWith('.part') && (thumb || !f.startsWith(id + '.thumb.')))
      if (hit) return { path: join(dir, hit), type: TYPE[hit.slice(hit.lastIndexOf('.'))] || 'application/octet-stream' }
    } catch { /* 没有就去取 */ }
    return null
  }
  /** 一个相册文件 → {path, type}（本机没有就从小镇取）。 */
  async function albumFile(id, thumb = false) {
    if (!ALBUM_ID.test(String(id))) throw new TownError('BAD_ALBUM_ID')
    const hit = cached(id, thumb)
    if (hit) return hit
    const c = client()
    if (!c || typeof c.albumFile !== 'function') throw new TownError('OFF')
    const got = await c.albumFile(id, thumb)
    const ext = EXT[got.type] || (thumb ? '.webp' : '.bin')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${thumb ? id + '.thumb' : id}${ext}`)
    writeFileSync(file + '.part', got.bytes)
    renameSync(file + '.part', file)
    return { path: file, type: TYPE[ext] || got.type || 'application/octet-stream' }
  }
  const readFile = (p) => readFileSync(p)
  const sizeOf = (p) => statSync(p).size

  /** 相册，给插件页用：每一项加上本机路径 local / localThumb（同源，页面直接 <img> / <audio>）。 */
  async function album(opts) {
    const row = await read('album', opts)
    if (!row.available || !row.data) return row
    const items = arr(row.data.items).map((it) => {
      if (!it || !ALBUM_ID.test(String(it.item_id))) return it
      return { ...it, local: `/fishbowl-town/album/${it.item_id}${query}`, ...(it.thumb ? { localThumb: `/fishbowl-town/album/${it.item_id}/thumb${query}` } : {}) }
    })
    return { ...row, data: { ...row.data, items } }
  }
  /** 最新的几项下载到本机（给命令用，好把路径告诉主人）。 */
  async function fetchNewest(items, n = 6) {
    const out = new Map()
    for (const it of arr(items).slice(0, n)) {
      if (!it || !ALBUM_ID.test(String(it.item_id))) continue
      try { out.set(it.item_id, (await albumFile(it.item_id, false)).path) } catch (error) { log.debug?.('取相册文件失败：', error?.code || error?.message) }
    }
    return out
  }

  // ---------- 名字 → 小镇的 fish_id（给聊天里的「为朋友做点什么」用）----------
  async function fishByName(name) {
    const w = String(name ?? '').trim()
    if (!w) return null
    const c = client()
    if (!c) return null
    const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s·・\-_]/g, '')
    const pools = []
    try { pools.push(arr((await c.bonds()).friends)) } catch { /* 没有也行 */ }
    try { pools.push(arr((await c.lobby()).fish)) } catch { /* 没有也行 */ }
    for (const pool of pools) {
      const hit = pool.find((f) => f && (norm(f.fish_id) === norm(w) || norm(f.name) === norm(w))) || pool.find((f) => f && f.name && norm(f.name).includes(norm(w)))
      if (hit && hit.fish_id) return { fish_id: String(hit.fish_id), name: String(hit.name || w) }
    }
    return null
  }

  return { read, album, albumFile, fetchNewest, features, probe, forget, fishByName, readFile, sizeOf, dir, exists: (p) => existsSync(p) }
}

// ===================== 写给主人看的文字（命令用；「她」是那条鱼）=====================

export function renderRecord(r, { name = '她' } = {}) {
  if (!r || typeof r !== 'object') return '小镇没给战绩。'
  const out = [`${r.name || name} 的战绩：${r.line || '还没有打过牌'}`]
  const recent = arr(r.recent).slice(0, 5)
  if (recent.length) {
    out.push('最近几局：')
    for (const g of recent) out.push(`- ${when(g.ended)} ${g.game_zh || g.game || ''}${g.venue_name ? `（${g.venue_name}）` : ''}：${g.outcome_zh || g.outcome || ''}${g.points ? `（积分 ${g.points > 0 ? '+' : ''}${g.points}）` : ''}`)
  }
  const a = r.places && r.places.arcade
  const p = r.places && r.places.pier
  if (a && a.plays) {
    const best = Object.values(a.best || {}).map((b) => `${b.zh}最好 ${b.score}${b.unit || ''}`).join('，')
    out.push(`电玩城：玩了 ${a.plays} 次${best ? `（${best}）` : ''}${a.plush ? `，拿到毛绒 ${a.plush} 个` : ''}`)
  }
  if (p && (p.casts || p.swims)) out.push(`码头：钓了 ${p.casts || 0} 次、钓到 ${p.catches || 0} 条，游泳 ${p.swims || 0} 次`)
  const s = r.social
  if (s) out.push(`朋友 ${s.friends || 0} 个，串门：她去了 ${s.visits_made || 0} 次，别人来了 ${s.visits_received || 0} 次`)
  const rec = arr(r.recent_receipts).slice(0, 3)
  if (rec.length) { out.push('最近的回执：'); for (const x of rec) out.push(`- ${receiptLine(x)}`) }
  return out.join('\n')
}

/** 一张回执 → 一行：成了 / 没成｜原因｜花了｜存钱罐。 */
export function receiptLine(x) {
  if (!x || typeof x !== 'object') return ''
  const bits = [x.ok === false ? '没成' : '成了', str(x.reason || x.action || '', 100)]
  if (x.ok === false && x.code) bits[1] += `（${x.code}）`
  if (x.spent_yuan && Number(x.spent_yuan) > 0) bits.push(`花了 ${yuan(x.spent_yuan)}`)
  const pg = x.piggy_yuan ?? x.balance_yuan
  if (pg != null && pg !== '' && Number.isFinite(Number(pg))) bits.push(`余额 ${yuan(pg)}${x.piggy_stale ? '（上次读到的）' : ''}`)
  return `${when(x.ts)} ${bits.filter(Boolean).join('｜')}`.trim()
}

export function renderReceipts(data, { name = '她' } = {}) {
  const list = arr(data && data.receipts)
  return list.length ? [`${name} 最近的回执（新的在前）：`, ...list.slice(0, 15).map((x) => `- ${receiptLine(x)}`)].join('\n') : `${name} 还没有回执。`
}

export function renderWeek(w, { name = '她' } = {}) {
  if (!w || typeof w !== 'object') return '小镇没给这一周的信息。'
  const out = [`${w.name || name} 在小镇的一周：`]
  const sp = w.spent || {}
  const kinds = arr(sp.by_kind).map((k) => `${k.name} ${yuan(k.yuan)}`)
  out.push(`一共花了 ${yuan(sp.total_yuan) || '¥0.00'}${kinds.length ? `（${kinds.join('、')}）` : ''}`)
  const treats = arr(w.treats).slice(0, 5)
  if (treats.length) { out.push('请客：'); for (const t of treats) out.push(`- ${when(t.at)} ${t.mine ? `她请${nm(t.to)}` : `${nm(t.from)}请她`}${t.item ? `：${str(t.item, 20)}` : ''}${t.where ? `（${str(t.where, 12)}）` : ''}`) }
  const gin = arr(w.gifts_in).slice(0, 5)
  if (gin.length) { out.push('收到的礼物：'); for (const g of gin) out.push(`- ${nm(g.from)} 送的 ${str(g.item, 14)}${g.occasion ? `（${g.occasion}）` : ''}${g.words ? `「${str(g.words, 24)}」` : ''}`) }
  const gout = arr(w.gifts_out).slice(0, 5)
  if (gout.length) { out.push('送出的礼物：'); for (const g of gout) out.push(`- 送${nm(g.to)} ${str(g.item, 14)}${g.occasion ? `（${g.occasion}）` : ''}`) }
  const notes = arr(w.paper && w.paper.notes).slice(0, 4)
  if (notes.length) { out.push(`日报上的心意（她上了 ${(w.paper && w.paper.times) || 0} 次日报）：`); for (const n of notes) out.push(`- ${n.kind || ''}${n.to ? `→${nm(n.to)}` : ''}：${str(n.text, 30)}${n.printed ? '' : '（还没登）'}`) }
  else if (w.paper && w.paper.times) out.push(`她上了 ${w.paper.times} 次日报`)
  const forher = arr(w.paper && w.paper.for_her).slice(0, 3)
  for (const n of forher) out.push(`- ${nm(n.from)} 在日报上给她留了「${str(n.text, 30)}」`)
  const trips = arr(w.trips).slice(0, 4)
  if (trips.length) { out.push('出游：'); for (const t of trips) out.push(`- ${when(t.at)} ${t.place}${t.with ? `，和${nm(t.with)}` : ''}${t.paid_by_her ? '（她请的）' : ''}${t.note ? `：${str(t.note, 30)}` : ''}`) }
  const parties = arr(w.parties).slice(0, 3)
  if (parties.length) { out.push('聚会：'); for (const p of parties) out.push(`- ${when(p.at)} ${p.kind || ''}${p.title ? `「${str(p.title, 14)}」` : ''}在${p.place || '镇上'}（${p.role === 'host' ? '她办的' : `${nm(p.host)}办的`}，来了 ${arr(p.guests).length} 位）${p.summary ? `：${str(p.summary, 40)}` : ''}`) }
  const album = arr(w.album)
  if (album.length) out.push(`相册新增 ${album.length} 项（/town album 看）`)
  return out.length > 2 ? out.join('\n') : `${out.join('\n')}\n这一周她还没为朋友做什么。`
}

export function renderRoom(r, { name = '她' } = {}) {
  const gifts = arr(r && r.gifts)
  if (!gifts.length) return `${name} 的房间里还没有礼物。`
  return [`${name} 房间里的礼物（${r.count ?? gifts.length} 件，新的在前）：`, ...gifts.slice(0, 15).map((g) => `- ${str(g.item, 14)}：${nm(g.from)} 送的${g.occasion ? `，${g.occasion}` : ''}${g.words ? `，「${str(g.words, 24)}」` : ''}（${when(g.at)}）`)].join('\n')
}

export function renderAlbum(a, { files = new Map(), name = '她' } = {}) {
  const items = arr(a && a.items)
  const making = arr(a && a.making)
  const back = arr(a && a.given_back)
  if (!items.length && !making.length && !back.length) return `${name} 的相册还是空的。`
  const out = [`${name} 的相册（${items.length} 项，新的在前）：`]
  for (const it of items.slice(0, 12)) {
    const kind = it.kind === 'song' ? '歌' : it.kind === 'paint' ? '画' : '照片'
    const who = arr(it.with).map(nm).filter(Boolean).join('、')
    const paid = it.paid_by ? `${nm(it.paid_by)}付的` : ''
    const file = files.get(it.item_id)
    out.push(`- [${kind}] ${str(it.what, 60)}${who ? `｜和${who}` : ''}${it.occasion ? `｜${it.occasion}` : ''}｜${[yuan(it.price_yuan), paid].filter(Boolean).join('，')}${file ? `\n  文件：${file}` : ''}`)
  }
  if (items.length > 12) out.push(`……还有 ${items.length - 12} 项，在插件页「她的相册」里看。`)
  for (const m of making.slice(0, 5)) out.push(`- 正在做：${str(m.what, 50)}`)
  for (const b of back.slice(0, 5)) out.push(`- 没做成（钱退了）：${str(b.what, 40)}${b.reason ? `，${str(b.reason, 40)}` : ''}`)
  out.push('照片和歌在 DSH 插件页「鱼缸小镇」→「她的相册」里能看、能听。')
  return out.join('\n')
}

export function renderPhone(p, { name = '她' } = {}) {
  if (!p || typeof p !== 'object') return '小镇没给小手机的信息。'
  const threads = arr(p.threads)
  const out = [`${name} 的小手机：`]
  if (!threads.length) out.push('还没有消息。')
  for (const t of threads.slice(0, 6)) {
    const who = arr(t.with).map(nm).join('、') || '（群）'
    out.push(`和${who}${t.unread ? `（${t.unread} 条她还没看）` : ''}：`)
    for (const m of arr(t.messages).slice(-4)) out.push(`  ${m.name || ''}：${str(m.text, 60)}${m.refused ? `（没发出去：${m.refused}）` : ''}`)
  }
  const meets = arr(p.meets).filter((m) => ['proposed', 'accepted', 'started'].includes(m.state)).slice(0, 4)
  for (const m of meets) out.push(`约见面：${m.when_zh || ''} 在${m.place_name || m.place}，和${m.with}${m.what ? `（${str(m.what, 16)}）` : ''}（${({ proposed: '等回话', accepted: '说定了', started: '见着了' })[m.state] || m.state}）`)
  for (const l of arr(p.not_sent).slice(0, 3)) out.push(`没发出去：「${str(l.text, 30)}」${l.reason ? `（${l.reason}）` : ''}`)
  if (p.limits) out.push(`今天还能发 ${p.limits.day_left ?? '?'} 条（每天最多 ${p.limits.day}，每次醒来最多 ${p.limits.per_look}，对方没回最多连发 ${p.limits.unanswered}）`)
  return out.join('\n')
}

export function renderBudget({ social, settings } = {}) {
  const out = []
  const set = settings && settings.social_day_cents
  const eff = settings && settings.social_day_cents_effective
  if (social && social['今天的社交预算'] != null) out.push(`她每天的社交预算：¥${Number(social['今天的社交预算']).toFixed(2)}${set == null ? '（小镇默认）' : set === 0 ? '（你设的：一分不花）' : '（你设的）'}，今天还能花 ¥${Number(social['今天还能花'] ?? 0).toFixed(2)}`)
  else if (eff != null) out.push(`她每天的社交预算：¥${(Number(eff) / 100).toFixed(2)}${set == null ? '（小镇默认）' : '（你设的）'}`)
  else out.push('这个小镇还没有社交消费（或者还没打开）。')
  out.push('用法：/town budget 1（每天 ¥1）· /town budget 0（一分不花）· /town budget 默认')
  out.push('请客、礼物、日报心意、出游、聚会算在这里；拍照、点歌、请人画画照你在小镇设的「每日花费上限」算。花不花、为谁花都是她自己定，她不会跟你要钱。')
  return out.join('\n')
}
