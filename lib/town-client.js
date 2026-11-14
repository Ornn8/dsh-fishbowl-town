// 小镇「外来的鱼」接口的客户端（/town/api/outside/，Authorization: Bearer fbo_…）。
// 接口文档：https://fishbowltown.com/town/docs/outside（旧地址 fish.bside-moon.cn 也能用）
import { redact } from './redact.js'

// 0.5.0：默认用小镇自己的域名；配置里写着旧地址 https://fish.bside-moon.cn/town/api/outside/ 的照常能用，不强改
export const DEFAULT_BASE = 'https://fishbowltown.com/town/api/outside/'

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

export function createTownClient({ base = DEFAULT_BASE, code, fetchImpl = globalThis.fetch, userAgent = 'dsh-fishbowl-town' } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new TownError('NO_CODE', 0, '还没填小镇接入码')
  const root = base.endsWith('/') ? base : base + '/'
  const auth = 'Bearer ' + code.trim()

  async function request(method, path, { query, body, timeoutMs = 15000, signal } = {}) {
    const url = new URL(path, root)
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    const timeout = AbortSignal.timeout(timeoutMs)
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: auth, 'User-Agent': userAgent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: sig,
      })
    } catch (error) {
      if (signal?.aborted) throw new TownError('ABORTED', 0)
      throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error)))
    }
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
    // kinds=activity：她在码头、电玩城、小店、法庭、夸夸群说的话也交给她自己写（不带的话小镇「代写」，从余额收钱）
    turns: (wait = 25, signal) => request('GET', 'turns', { query: { wait, kinds: 'activity' }, timeoutMs: (wait + 10) * 1000, signal }),
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
    /** 小手机发一条：{to, text, meet?, answer?, cancel_meet?}。 */
    phoneSend: (body) => request('POST', 'phone', { body, timeoutMs: 15000 }),
    /** 相册里的一个文件（链接本身就是钥匙，不带接入码）：→ {bytes, type}。id 必须是小镇的相册号（al_ 加 16 位十六进制）。 */
    albumFile: async (id, thumb = false, maxBytes = 25 * 1024 * 1024) => {
      if (!/^al_[0-9a-f]{16}$/.test(String(id))) throw new TownError('BAD_ALBUM_ID')
      const url = new URL(`/town/api/album/${id}/${thumb ? 'thumb' : 'file'}`, root)
      let res
      try { res = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) }) } catch (error) { throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error))) }
      if (!res.ok) throw new TownError(`HTTP_${res.status}`, res.status)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > maxBytes) throw new TownError('TOO_BIG')
      return { bytes, type: String(res.headers?.get?.('content-type') || '').split(';')[0].trim() }
    },
    /** 定制画/买到的画：一段一段取（base64）。 */
    paintFile: (orderId, n, part) => request('POST', 'paint_file', { body: { order_id: orderId, n, part }, timeoutMs: 30000 }),
  }
}
