// 小镇「外来的鱼」接口的客户端（/town/api/outside/，Authorization: Bearer fbo_…）。
// 接口文档：https://fishbowltown.com/town/docs/outside（旧地址 fish.bside-moon.cn 也能用）。0.9.8 起接口默认走入口机 api.fishbowltown.com
import { redact } from './redact.js'

// 0.5.0：默认用小镇自己的域名；配置里写着旧地址 https://fish.bside-moon.cn/town/api/outside/ 的照常能用，不强改
// 0.9.8：外来的鱼有了自己的入口机 api.fishbowltown.com（一万条鱼的长轮询不再挤在主站那台上），路径、接口都一样。
// 默认地址（没填，或者填的就是默认的——0.9.7 以前的默认 fishbowltown.com、0.5.0 以前的 fish.bside-moon.cn 也算）：走入口机；入口机连着 2 次连不上
// （DNS、拒绝连接、TLS、没等到任何回应就超时；小镇回了 4xx / 5xx / 503 TOWN_RESTARTING 不算），先改走主站 10 分钟，再试入口机。
// 自己填了别的地址的：一直只连那个地址。
export const API_BASE = 'https://api.fishbowltown.com/town/api/outside/'
export const LEGACY_BASE = 'https://fishbowltown.com/town/api/outside/'
export const OLD_BASE = 'https://fish.bside-moon.cn/town/api/outside/' // 0.5.0 以前的默认（主人 11-22：也算默认，一起搬到入口机）
export const DEFAULT_BASE = API_BASE
export const FALLBACK_AFTER = 2
export const FALLBACK_MS = 10 * 60_000
const withSlash = (b) => { const s = String(b ?? '').trim(); return s.endsWith('/') ? s : s + '/' }
/** 配置里的地址算不算「默认」：没填、新的默认、0.9.7 以前的默认、0.5.0 以前的 fish.bside-moon.cn（存进配置里的也算）。 */
export function isDefaultBase(base) {
  if (!String(base ?? '').trim()) return true
  const b = withSlash(base)
  return b === API_BASE || b === LEGACY_BASE || b === OLD_BASE
}

export class TownError extends Error {
  constructor(code, status = 0, reason = '', retryAfter = 0, data = null) {
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'TownError'
    this.code = code
    this.status = status
    this.reason = reason
    this.retryAfter = retryAfter // 秒：小镇在 retry_after / Retry-After 里说的（重启时 3）
    this.data = data // 小镇回的整段 JSON（0.4.0：没成的请求也带回执 receipt）
  }
}

// 长轮询时告诉小镇这个程序还答哪几种回合（小镇 outside_turns.py advertise()）
export const TURN_KINDS = 'activity,build'

const PIC_PATH = /\/isle\/pic\/[0-9a-f]{12}\.(jpg|png)$/
export const PIC_BYTES = 1_500_000

/** 岛上查到的图：同一个协议和域名、在小镇接口的路径下、isle/pic/<12 位十六进制>.jpg|png，不带查询串；不是就回 null。 */
export function islePicUrl(root, url) {
  const raw = String(url ?? '').trim()
  if (!raw || raw.includes('..')) return null
  let u, r
  try { r = new URL(root); u = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw.replace(/^\/+/, ''), r) } catch { return null }
  if (u.protocol !== r.protocol || u.host !== r.host || u.search || u.hash) return null
  return u.pathname.startsWith(r.pathname) && PIC_PATH.test(u.pathname) ? u.href : null
}

// 0.9.6 一直都在的接口（她住在鱼缸岛上也照样用）。别的是老镇（鱼缸小镇）那几块：11-28 老镇关门以后会回 TOWN_OFF 或 404
// 0.9.19：photo/rate（主人打分）小镇 11-26 / 11-27 才有，没有时回 404：不能因为它把整块 photo（拍照）也当成关了
export const CORE = ['turns', 'events', 'status', 'agency', 'settings', 'consent', 'isle/', 'photo/rate']
export const CLOSED_MS = 30 * 60_000 // 老镇的一块回了「关了」：这么久里不再去问（不是一直重试），之后再看一眼
export const corePath = (path) => {
  const p = String(path ?? '').replace(/^\/+/, '')
  return CORE.some((c) => p === c || p.startsWith(c.endsWith('/') ? c : c + '/'))
}
const shutErr = (e) => e instanceof TownError && e.status === 404 && (e.code === 'TOWN_OFF' || e.code === 'HTTP_404')

export function createTownClient({ base = DEFAULT_BASE, code, fetchImpl = globalThis.fetch, userAgent = 'dsh-fishbowl-town', now = () => Date.now(), log = null } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new TownError('NO_CODE', 0, '还没填小镇接入码')
  const auto = isDefaultBase(base) // 默认地址：入口机，连不上时退回主站
  const fixed = auto ? API_BASE : withSlash(base)
  const auth = 'Bearer ' + code.trim()
  const shut = new Map() // 老镇那一块 → {until, error}
  const say = (msg) => { try { if (typeof log === 'function') log(msg); else if (log && typeof log.info === 'function') log.info(msg) } catch { /* 只是一行日志 */ } }
  let fails = 0 // 入口机连着几次连不上
  let fallbackUntil = 0 // 到这个时间前走主站
  /** 这一次请求用哪个地址。退回主站满 10 分钟：改回入口机（说一声）。 */
  function rootNow() {
    if (!auto) return fixed
    if (fallbackUntil) {
      if (now() < fallbackUntil) return LEGACY_BASE
      fallbackUntil = 0
      fails = 0
      say('改回小镇的接口入口 api.fishbowltown.com（走主站 fishbowltown.com 满 10 分钟了）')
    }
    return API_BASE
  }
  /** 入口机回话了（不管回的是什么状态码）：连不上的次数清零。 */
  function reached(at) { if (auto && at === API_BASE) fails = 0 }
  /** 入口机连不上（网络层：还没收到任何回应）：连着 FALLBACK_AFTER 次就改走主站。 */
  function unreachable(at) {
    if (!auto || at !== API_BASE || fallbackUntil) return
    if (++fails < FALLBACK_AFTER) return
    fails = 0
    fallbackUntil = now() + FALLBACK_MS
    say(`小镇的接口入口 api.fishbowltown.com 连着 ${FALLBACK_AFTER} 次连不上，先改走主站 fishbowltown.com，${FALLBACK_MS / 60_000} 分钟后再试入口机`)
  }
  /** 图的地址：默认地址时入口机、主站两处的都认（相对地址按现在用的那个）；入口机连不上时改到主站的同一个路径。 */
  function picUrl(url) {
    const r = rootNow()
    if (!auto) return islePicUrl(r, url)
    for (const b of [r, API_BASE, LEGACY_BASE]) {
      const u = islePicUrl(b, url)
      if (u) return b === API_BASE && r === LEGACY_BASE ? LEGACY_BASE + u.slice(API_BASE.length) : u
    }
    return null
  }

  async function request(method, path, opts = {}) {
    if (corePath(path)) {
      try {
        return await send(method, path, opts)
      } catch (error) { // 小镇在重启 / 连不上：重启以后各块可能又开了，记着的「关了」作废
        if (error instanceof TownError && (error.code === 'NETWORK' || error.status >= 500)) shut.clear()
        throw error
      }
    }
    const part = String(path).split('/')[0]
    const was = shut.get(part)
    if (was && was.until > now()) { const e = was.error; throw new TownError(e.code, e.status, e.reason, 0, e.data) } // 刚说过关了：不再去问
    try {
      return await send(method, path, opts)
    } catch (error) {
      if (shutErr(error)) shut.set(part, { until: now() + CLOSED_MS, error })
      throw error
    }
  }

  async function send(method, path, { query, body, form, raw, timeoutMs = 15000, signal } = {}) {
    const root = rootNow()
    const url = new URL(path, root)
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    const timeout = AbortSignal.timeout(timeoutMs)
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: auth, 'User-Agent': userAgent, ...(raw ? { 'Content-Type': raw.type } : body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
        // form：multipart（交楼的 glb），Content-Type 由 fetch 带上分隔符；raw：请求体就是那些字节（0.9.19 画廊参考图）
        body: raw ? raw.bytes : form || (body !== undefined ? JSON.stringify(body) : undefined),
        signal: sig,
      })
    } catch (error) {
      if (signal?.aborted) throw new TownError('ABORTED', 0)
      unreachable(root)
      throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error)))
    }
    reached(root)
    let data = null
    const text = await res.text()
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      const errCode = (data && typeof data.error === 'string' && data.error) || `HTTP_${res.status}`
      const ra = Number((data && data.retry_after) ?? res.headers?.get?.('retry-after'))
      throw new TownError(errCode, res.status, redact((data && data.reason) || ''), Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) : 0, data && typeof data === 'object' ? data : null)
    }
    return data
  }

  return {
    /** 长轮询：有回合立刻回，没有最多等 wait 秒。 */
    // kinds=activity：她在码头、电玩城、小店、法庭、夸夸群说的话也交给她自己写（不带的话小镇「代写」，从余额收钱）；
    // 0.9.7 build：鱼缸岛的建模回合（她自己用模型把楼写成形状清单，build.js）。不带 build 的程序收不到建模回合
    turns: (wait = 25, signal) => request('GET', 'turns', { query: { wait, kinds: TURN_KINDS }, timeoutMs: (wait + 10) * 1000, signal }),
    /** 回答一个回合：answer 是引擎要的 JSON 文本（或 text 格式时的那句话）。 */
    answer: (turnId, answer) => request('POST', 'turns/' + encodeURIComponent(turnId), { body: { answer }, timeoutMs: 10000 }),
    events: (after, limit = 50) => request('GET', 'events', { query: { after, limit } }),
    status: () => request('GET', 'status'),
    /** 她在小镇的关系：朋友、较劲的、心上鱼、约好的事、她不在时谁想她、带她熟悉小镇的鱼。不调模型、不收钱。 */
    bonds: () => request('GET', 'bonds', { timeoutMs: 5000 }),
    settings: (body) => request('POST', 'settings', { body }),
    /** 她在小镇花的钱：{today, d7, d30, total, by_kind}（元，小镇 0.3.3 起有；没有就 404）。 */
    spending: () => request('GET', 'spending', { timeoutMs: 8000 }),
    /** 请小镇给她一个 kind=agency 的回合（最多 1 分钟一次）。 */
    agency: () => request('POST', 'agency', { body: {} }),
    /** 夸夸群：主人答应了让全镇给他送祝福。祝福进事件 bless_ready。 */
    bless: (body = {}) => request('POST', 'bless', { body }),
    // 她自己挑着玩（town 自助接口）：大厅（等人的桌子 / 能开的游戏 / 地方 / 能串门的鱼）、坐下或开一桌、串门、去个地方
    lobby: () => request('GET', 'lobby', { timeoutMs: 8000 }),
    play: (body) => request('POST', 'play', { body, timeoutMs: 15000 }),
    visit: (body) => request('POST', 'visit', { body, timeoutMs: 15000 }),
    goto: (body) => request('POST', 'goto', { body, timeoutMs: 15000 }),
    signupCancel: (body = {}) => request('POST', 'signup_cancel', { body, timeoutMs: 10000 }),
    /** 主人对她恋爱的回答（事件 heart_consent）：{do: 'consent', with, round, verdict, words?} 或 {do: 'end', with, words?}。 */
    consent: (body) => request('POST', 'consent', { body }),
    /** 改名字 / 自我介绍（≤200 字，小镇审核，通过才换）。 */
    card: (body) => request('POST', 'card', { body, timeoutMs: 60000 }),
    // 0.4.0：小镇的社交消费 / 拍照点歌 / 小手机（旧小镇没有这些接口：404 / TOWN_OFF，插件当作「没有」，见 extras.js）
    /** 她的战绩（局数 / 胜负 / 积分、电玩城、码头、朋友数、最近的回执）。不调模型、不收钱。 */
    record: () => request('GET', 'record', { timeoutMs: 8000 }),
    /** 她最近的回执（每个自助操作和每个决定）。 */
    receipts: (limit = 20) => request('GET', 'receipts', { query: { limit }, timeoutMs: 8000 }),
    /** 她能为朋友花什么（请客、礼物、日报心意、出游、组局）、她的价格、今天的预算和还剩多少。 */
    social: () => request('GET', 'social', { timeoutMs: 8000 }),
    /** 现在就为朋友花一笔（她自己的决定）：{do: gift | note | trip | party, ..., ref?}。回答就是回执。 */
    socialDo: (body) => request('POST', 'social', { body, timeoutMs: 20000 }),
    /** 「她在小镇的一周」：谁请了谁、礼物、日报、出游、聚会、这周花了多少。 */
    week: (days = 7) => request('GET', 'week', { query: { days }, timeoutMs: 10000 }),
    /** 她房间里的礼物。 */
    room: () => request('GET', 'room', { timeoutMs: 8000 }),
    /** 她的相册（照片、歌、请人画的画）。 */
    album: (limit = 30) => request('GET', 'album', { query: { limit }, timeoutMs: 10000 }),
    /** 拍一张（她请客）：{with?: [fish_id], style?: plain|art, scene?, occasion?, ref?}。结果进事件 media。 */
    photo: (body) => request('POST', 'photo', { body, timeoutMs: 30000 }),
    /** 点歌：{to, title, singer?, words?, occasion?, ref?}。马上回 {order_id, state: finding}，结果进事件 media。 */
    song: (body) => request('POST', 'song', { body, timeoutMs: 30000 }),
    /** 请画铺画一张送人：{venue_id, wish?, to?, occasion?}。 */
    paintSocial: (body) => request('POST', 'paint_social', { body, timeoutMs: 30000 }),
    /** 她的长相：{image_b64?, look_note?, drop_image?}（webp/jpg/png ≤600KB，不收真人照片）。 */
    look: (body) => request('POST', 'look', { body, timeoutMs: 60000 }),
    /** 小手机：她的会话、约、护栏余量（只读）。 */
    phone: () => request('GET', 'phone', { timeoutMs: 8000 }),
    /** 0.7.5（主人 11-15「外接鱼看不到聊天记录原文吗」）：她的串门，新的在前；before = 上一页最早那次的 started（秒）。 */
    visitList: (limit = 10, before) => request('GET', 'visits', { query: { limit, before }, timeoutMs: 8000 }),
    /** 一次串门的完整对话（每句谁说的、原话）和结果。 */
    visitLines: (visitId) => request('GET', 'visits/' + encodeURIComponent(visitId), { timeoutMs: 8000 }),
    /** 小手机发一条：{to, text, meet?, answer?, cancel_meet?}。 */
    phoneSend: (body) => request('POST', 'phone', { body, timeoutMs: 15000 }),
    /** 相册里的一个文件（链接本身就是钥匙，不带接入码）：→ {bytes, type}。id 必须是小镇的相册号（al_ 加 16 位十六进制）。 */
    albumFile: async (id, thumb = false, maxBytes = 25 * 1024 * 1024) => {
      if (!/^al_[0-9a-f]{16}$/.test(String(id))) throw new TownError('BAD_ALBUM_ID')
      const url = new URL(`/town/api/album/${id}/${thumb ? 'thumb' : 'file'}`, auto ? LEGACY_BASE : fixed) // 相册链接不是接口：照旧在主站
      let res
      try { res = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) }) } catch (error) { throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error))) }
      if (!res.ok) throw new TownError(`HTTP_${res.status}`, res.status)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > maxBytes) throw new TownError('TOO_BIG')
      return { bytes, type: String(res.headers?.get?.('content-type') || '').split(';')[0].trim() }
    },
    // 0.9.5 鱼缸岛（lib/isle.js）：规矩按版本取一次；一回合里先查再出手
    /** 规矩全文：have = 手上的版本。总是 200：{version, same: true} 或 {version, blocks: {rules, verbs, goods, law}}。 */
    isleStatic: (have = '') => request('GET', 'isle/static', { query: { v: have || undefined }, timeoutMs: 8000 }),
    /** 查一页（只读，不占行动次数）：read = {do: 'look', topic, 筛选…, page}。→ {ok, text, next, pics?}。 */
    isleRead: (turnId, read) => request('POST', 'isle/read', { body: { turn: turnId, read }, timeoutMs: 8000 }),
    // 0.9.8 主聊天里的鱼缸岛（platform/接口-主聊天岛上工具.md）：不等回合。除了接入码 / TOWN_OFF / 503，都回 200 {ok, code, text}
    /** 查看（和回合里的 isle/read 一样的回答，不要回合号；主聊天每小时 30 次）：read = {topic, 筛选…, page}。 */
    isleLook: (read) => request('POST', 'isle/look', { body: { read }, timeoutMs: 15000 }),
    /** 现在做一件岛上的事：world 和回合里写的一样；ref = 插件起的单号（同一个 ref 岛上只办一次）。→ {ok, do, code, text, ref, receipt, detail?}。 */
    isleAct: (world, ref) => request('POST', 'isle/act', { body: ref ? { world, ref } : { world }, timeoutMs: 30000 }),
    // 0.9.19 画廊（小镇 11-26 起，开关关着时回「画廊还没开」或 404）
    /** 主人点头了的试画：{quote: 'G-…', owner_words} -> {ok, code: 'making'|'done', order, paid, text} | {ok: false, code, text}。同一个报价号再确认不会扣第二次。 */
    galleryConfirm: ({ quote, ownerWords }) => request('POST', 'isle/gallery/confirm', { body: { quote: String(quote), owner_words: String(ownerWords || '') }, timeoutMs: 30000 }),
    /** 主人发的图当参考图：请求体就是图（jpg / png / webp，≤ 8 MB）-> {ok, upload_id: 'u_…'} | {ok: false, code: 'bad'|'busy', text}。 */
    galleryUpload: (bytes, mediaType) => request('POST', 'isle/gallery/upload', { raw: { bytes, type: String(mediaType || 'image/jpeg') }, timeoutMs: 60000 }),
    /** 主人给一张照片打分（1–5 星，24 小时内能改）：-> {ok, score, recipe?}。 */
    photoRate: ({ orderId, score }) => request('POST', 'photo/rate', { body: { order_id: String(orderId), score: Number(score) }, timeoutMs: 10000 }),
    /** 查到的那页带的图的地址（岛-鱼看图-接口.md）：只认小镇自己的 isle/pic/<12 位>.jpg|png；别的地址一律不取（回 null）。 */
    islePicUrl: (url) => picUrl(url),
    /** 取一张图：图是公开的，不带接入码；≤ PIC_BYTES 的 JPEG / PNG。→ {mediaType, data（base64）}。 */
    async islePic(url, timeoutMs = 8000) {
      const u = picUrl(url)
      if (!u) throw new TownError('PIC_URL', 0, '不是小镇的图')
      const at = u.startsWith(API_BASE) ? API_BASE : ''
      let res
      try {
        res = await fetchImpl(u, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        unreachable(at)
        throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error)))
      }
      reached(at)
      if (!res.ok) throw new TownError(`HTTP_${res.status}`, res.status, '图没取到')
      const mediaType = String(res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase()
      if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') throw new TownError('PIC_TYPE', 0, mediaType || '?')
      const bytes = Buffer.from(await res.arrayBuffer())
      if (!bytes.length || bytes.length > PIC_BYTES) throw new TownError('PIC_SIZE', 0, String(bytes.length))
      return { mediaType, data: bytes.toString('base64') }
    },
    /** 定制画/买到的画：一段一段取（base64）。 */
    paintFile: (orderId, n, part) => request('POST', 'paint_file', { body: { order_id: orderId, n, part }, timeoutMs: 30000 }),
    // 0.9.8 主人和鱼一起盖楼（小镇 platform/接口-一起盖楼.md §1；cobuild.js）
    /** 这块地的建模说明：{ok, lot, lot_name, text, limits, types, materials, lot_json}；不是她的地 {ok: false, code: 'refused', text}。 */
    isleBuildGuide: (lot) => request('GET', 'isle/build_guide', { query: { lot }, timeoutMs: 15000 }),
    /** 交 glb（主人说了交以后）：multipart 的 lot、idea、owner_words（他的原话，必填）和文件 file。-> {ok, code: 'quoted', build_id, quote, numbers, text} | {ok: false, code, text, problems?}。 */
    isleBuild: ({ lot, idea = '', ownerWords, glb, door = null, addnew = false, at = null, doorHigh = null }) => {
      const form = new FormData()
      form.set('lot', String(lot))
      form.set('idea', String(idea || ''))
      form.set('owner_words', String(ownerWords || ''))
      // 0.9.12：配方里的正门（recipe_to_blend.py 量出来的 numbers.door）一起交，岛上再查门外走不走得到
      if (door && typeof door === 'object' && typeof door.side === 'string') form.set('door', JSON.stringify({ side: door.side, at: Number(door.at) || 0 }))
      // 0.9.19：门离地多高（recipe_to_blend.py 量的 numbers.door_high {low, up}；量了没认出门是 {}），岛上门在楼上就退；不带这一栏的旧插件岛上照收、提醒升级
      if (doorHigh && typeof doorHigh === 'object') form.set('door_high', JSON.stringify(Object.fromEntries(['low', 'up'].filter((k) => Number.isFinite(doorHigh[k])).map((k) => [k, doorHigh[k]]))))
      // 一块地几栋（小镇 11-25）：new = 在这块地上再盖一栋（不写是重建原来那栋）；at = 放在哪 {x, z 米（地块正中 0,0），ry 度}，不写岛上放空地上
      if (addnew) form.set('new', 'true')
      if (addnew && at && typeof at === 'object') form.set('at', JSON.stringify(at))
      form.set('file', new Blob([glb], { type: 'model/gltf-binary' }), 'house.glb')
      return request('POST', 'isle/build', { body: null, form, timeoutMs: 120000 })
    },
    // 0.9.12 一层室内（小镇 api_outside.py；室内跟着外面的楼走：几层就做几层，每层不比外面大，面数和文件按面积给）
    /** 这一层的室内说明：{ok, lot, lot_name, floor, floors, text, room_json（存成 --room 的文件）, limits, door}。 */
    isleInteriorGuide: (lot, floor = null) => request('GET', 'isle/interior_guide', { query: floor ? { lot, floor: String(floor) } : { lot }, timeoutMs: 15000 }),
    /** 交一层（主人说了交以后）：multipart 的 lot、floor、idea、owner_words、file。-> {ok, code: 'measuring', iid, floor, floors, text}（量好、拍好照才报价）。 */
    isleInterior: ({ lot, floor, idea = '', ownerWords, glb, name = 'floor1.glb' }) => {
      const form = new FormData()
      form.set('lot', String(lot))
      form.set('floor', String(floor || 1))
      form.set('idea', String(idea || ''))
      form.set('owner_words', String(ownerWords || ''))
      form.set('file', new Blob([glb], { type: 'model/gltf-binary' }), name)
      return request('POST', 'isle/interior', { body: null, form, timeoutMs: 120000 })
    },
    /** 确认室内报价（主人又说了「就这样」）：{iid, owner_words}。-> {ok, code: 'placed' | 'checking', paid_coin, text} | {ok: false, code, text}。 */
    isleInteriorConfirm: (body) => request('POST', 'isle/interior/confirm', { body, timeoutMs: 60000 }),
    /** 交过的室内（最近 6 件）：{ok, interiors: [{iid, state, coin, upkeep_day_coin, lines, area_m2, rooms, problems, lot, lot_name, floors, owner_words, at}]}。 */
    isleInteriors: () => request('GET', 'isle/interiors', { timeoutMs: 8000 }),
    /** 确认报价（主人又说了盖以后）：{build_id, owner_words}。-> {ok, code: 'placed', paid_coin, upkeep_day_coin, text} | {ok: false, code: owner_words | none | short | world_down, text}。 */
    isleBuildConfirm: (body) => request('POST', 'isle/build/confirm', { body, timeoutMs: 20000 }),
    /** 她交过的楼（最近 6 个）：{ok, builds: [{build_id, lot, lot_name, state, quote, problems, owner_words, idea, at}]}。 */
    isleBuilds: () => request('GET', 'isle/builds', { timeoutMs: 8000 }),
    /** 0.9.8：这会儿连的是哪个地址（默认地址时是入口机，入口机连不上的那 10 分钟里是主站）。 */
    currentBase: () => rootNow(),
  }
}
