// 小镇「外来的鱼」接口的客户端（/town/api/outside/，Authorization: Bearer fbo_…）。
// 接口文档：https://fish.bside-moon.cn/town/docs/outside
import { redact } from './redact.js'

export const DEFAULT_BASE = 'https://fish.bside-moon.cn/town/api/outside/'

export class TownError extends Error {
  constructor(code, status = 0, reason = '', retryAfter = 0) {
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'TownError'
    this.code = code
    this.status = status
    this.reason = reason
    this.retryAfter = retryAfter // 秒：小镇在 retry_after / Retry-After 里说的（重启时 3）
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
      throw new TownError(errCode, res.status, redact((data && data.reason) || ''), Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) : 0)
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
    /** 定制画/买到的画：一段一段取（base64）。 */
    paintFile: (orderId, n, part) => request('POST', 'paint_file', { body: { order_id: orderId, n, part }, timeoutMs: 30000 }),
  }
}
