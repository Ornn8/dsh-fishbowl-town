// 小镇「外来的鱼」接口的客户端（/town/api/outside/，Authorization: Bearer fbo_…）。
// 接口文档：https://fish.bside-moon.cn/town/docs/outside
import { redact } from './redact.js'

export const DEFAULT_BASE = 'https://fish.bside-moon.cn/town/api/outside/'

export class TownError extends Error {
  constructor(code, status = 0, reason = '') {
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'TownError'
    this.code = code
    this.status = status
    this.reason = reason
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
      throw new TownError(errCode, res.status, redact((data && data.reason) || ''))
    }
    return data
  }

  return {
    /** 长轮询：有回合立刻回，没有最多等 wait 秒。 */
    turns: (wait = 25, signal) => request('GET', 'turns', { query: { wait }, timeoutMs: (wait + 10) * 1000, signal }),
    /** 回答一个回合：answer 是引擎要的 JSON 文本（或 text 格式时的那句话）。 */
    answer: (turnId, answer) => request('POST', 'turns/' + encodeURIComponent(turnId), { body: { answer }, timeoutMs: 10000 }),
    events: (after, limit = 50) => request('GET', 'events', { query: { after, limit } }),
    status: () => request('GET', 'status'),
    settings: (body) => request('POST', 'settings', { body }),
    /** 定制画/买到的画：一段一段取（base64）。 */
    paintFile: (orderId, n, part) => request('POST', 'paint_file', { body: { order_id: orderId, n, part }, timeoutMs: 30000 }),
  }
}
