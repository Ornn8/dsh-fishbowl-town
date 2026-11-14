// 「小镇近况」小块：主人跟她聊天时，悄悄放进她那一轮的上下文里几行——她在小镇的朋友、约好的事、谁想她了。
// 合适的时候她可以用自己的话提一句（「明天约了阿鲸打牌，可不能缺席」「小满说想我了」），不合适就不提。
//
// 怎么放：DSH 的 'agent/pre-step'（和 DSH 自带的 time-context 一样），在这一轮第一步后面加一条用户消息
// （source.kind = fishbowl-town-context），留在会话历史里，不改系统提示词（缓存不受影响）。
// 不是每句话都放：0.6.1 起只在主人隔了 RETURN_GAP 再开口的那一轮放一次（主人反馈接入小镇后鱼话太多）；
// 中间只有小镇在等主人回答的新问题（asks）会再放。内容没变不重复放；两次之间至少隔 MIN_GAP。
// 小镇的数据（outside/bonds）缓存 TTL，过期了在后台刷新，不让主人的聊天等小镇；连不上就什么都不放。

export const CONTEXT_KIND = 'fishbowl-town-context'
const TTL = 10 * 60_000
const KEEP_STALE = 2 * 3600_000 // 小镇暂时连不上：两小时内的旧数据还能用
const MIN_GAP = 20 * 60_000 // 同一个会话两次之间至少隔这么久
const RESEND_AFTER = 6 * 3600_000 // 内容没变，这么久以后再提醒一次（会话太长时早先那条可能被压缩掉）
const RETURN_GAP = 3 * 3600_000 // 主人隔了这么久再开口，算「回来了」（插件刚启动也算）
const COLD_WAIT = 1500 // 第一次没有缓存时最多等这么久

// 和小镇写进她「心思」、活动回合里的是同一条（town ec624b7 的 guidance）；小镇给了就用小镇的原话
const GUIDE = '她可以真心说喜欢镇上的朋友、惦记约好的事、想接着玩，这是她自己的感情；但不能让主人觉得欠了她或愧疚，'
  + '不能拿「关掉我就再也见不到大家了」这类失去来吓他，也不能把想念和花钱、充值、买东西扯在一起。想不想继续、花不花钱，都由主人自己定。'
// 0.2.10：标明这是插件附的背景资料、不是主人说的话；不带任何格式、长度、语气上的要求（她平时怎么说话就怎么说）
const HEAD = '【鱼缸小镇插件 · 背景备注】这是插件附上的资料，不是主人说的话，不用回复它；聊到相关的事时可以想起来，不提也没关系。'

const str = (v, n = 40) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  const c = [...s]
  return c.length > n ? c.slice(0, n).join('') + '…' : s
}
const nameOf = (x) => str(typeof x === 'string' ? x : x?.name || x?.town_name || '', 16)
const names = (list, n) => (Array.isArray(list) ? list : []).map(nameOf).filter(Boolean).slice(0, n)
const toMs = (v) => {
  if (v === undefined || v === null || v === '') return NaN
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v // 秒也认
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : NaN
}

/** 约好的时间：今天/明天/后天 + 时:分（按本机时区）。绝对时间，内容不会每分钟都变。 */
export function when(ms, nowMs) {
  const d = new Date(ms)
  const day = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime() }
  const diff = Math.round((day(ms) - day(nowMs)) / 86400_000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff === 0) return ms < nowMs ? `今天 ${hm}（已经到点了）` : `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === 2) return `后天 ${hm}`
  if (diff < 0) return `${-diff} 天前`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
}

/** 小镇给的关系数据（GET outside/bonds，town ec624b7）→ 几行字；什么都没有就返回 ''。 */
export function renderBlock(bonds, { nowMs = Date.now(), herName = '', news = [], mind = [], asks = [] } = {}) {
  if (!bonds || typeof bonds !== 'object' || bonds.ok === false) bonds = {}
  const lines = []
  const ties = (Array.isArray(bonds.ties) ? bonds.ties : [])
    .map((t) => ({ due: toMs(t?.due), whenZh: str(t?.when_zh, 16), who: str(t?.who_name, 16), what: str(t?.what, 30) }))
    .filter((t) => (t.what || t.who) && (!Number.isFinite(t.due) || t.due > nowMs - 3 * 3600_000))
    .sort((x, y) => (Number.isFinite(x.due) ? x.due : Infinity) - (Number.isFinite(y.due) ? y.due : Infinity)).slice(0, 2)
  for (const t of ties) {
    const at = t.whenZh || (Number.isFinite(t.due) ? when(t.due, nowMs) : '')
    lines.push(`- 约好了：${at ? at + ' ' : ''}${t.who ? `和${t.who}` : ''}${t.what ? (t.who ? '，' : '') + t.what : ''}`)
  }
  const missed = (Array.isArray(bonds.missed) ? bonds.missed : [])
    .map((m) => ({ name: nameOf(m), line: str(m?.line, 60) })).filter((m) => m.name && m.line).slice(0, 2)
  for (const m of missed) lines.push(`- 你不在的时候，${m.name}说：「${m.line}」`)
  const couple = bonds.couple ? nameOf(bonds.couple) : ''
  const crush = !couple && bonds.crush ? nameOf(bonds.crush) : ''
  if (couple) lines.push(`- 你和${couple}在一起了`)
  else if (crush) lines.push(`- 你心里有点喜欢${crush}`)
  const fr = Array.isArray(bonds.friends) ? bonds.friends : []
  const friends = names(fr.filter((f) => f && f.friend !== false), 3)
  const buddy = bonds.buddy ? nameOf(bonds.buddy) : ''
  const guiding = names(bonds.guiding, 2)
  const rivals = names(bonds.rivals, 2)
  const rel = []
  if (friends.length) rel.push(`好朋友：${friends.join('、')}`)
  if (buddy) rel.push(`这几天带你熟悉小镇的是${buddy}`)
  if (guiding.length) rel.push(`你在带新来的${guiding.join('、')}熟悉小镇`)
  if (rivals.length) rel.push(`较劲的：${rivals.join('、')}`)
  if (rel.length) lines.push(`- ${rel.join('；')}`)
  const today = (Array.isArray(news) ? news : []).slice(0, 3)
  if (today.length) { lines.push('你今天在小镇：'); for (const n of today) lines.push(`- ${str(n, 90)}`) }
  for (const m of (Array.isArray(mind) ? mind : []).slice(0, 1)) lines.push(`- 你最近的主意：${str(String(m).replace(/^你决定：/, ''), 40)}`)
  for (const a of (Array.isArray(asks) ? asks : []).slice(0, 2)) lines.push(`- ${str(a, 80)}`)
  if (!lines.length) return ''
  const guide = str(bonds.guidance, 300) || GUIDE
  return [`${HEAD}${herName ? `你在鱼缸小镇叫「${herName}」。` : ''}`, ...lines, guide].join('\n')
}

export function createTownContext({ fetchBonds, herName = () => '', extras = () => ({}), isOwnerChat, log, now = () => Date.now(), ttlMs = TTL }) {
  let cache = null // { at, bonds }
  let inflight = null
  const sent = new Map() // sid -> { at, text, asks }
  const ownerAt = new Map() // sid -> 主人上一次在这里开口的时间

  function refresh() {
    if (inflight) return inflight
    inflight = Promise.resolve().then(() => fetchBonds())
      .then((b) => { cache = { at: now(), bonds: b } })
      .catch((error) => {
        if (cache && now() - cache.at > KEEP_STALE) cache = null
        log?.debug?.('读小镇近况失败（不放）：', error?.code || error?.message || error)
      })
      .finally(() => { inflight = null })
    return inflight
  }

  /** 现在能放的那几行（''=不放）。缓存过期就后台刷新；冷启动最多等 COLD_WAIT。 */
  async function compose() {
    if (!cache || now() - cache.at >= ttlMs) {
      const p = refresh()
      if (!cache) await Promise.race([p, new Promise((r) => setTimeout(r, COLD_WAIT))])
    }
    let more = {}
    try { more = extras() || {} } catch { more = {} }
    const text = renderBlock(cache ? cache.bonds : null, { nowMs: now(), herName: herName(), news: more.news, mind: more.mind, asks: more.asks })
    const asks = (Array.isArray(more.asks) ? more.asks : []).slice(0, 2).join('\n')
    return { text, asks }
  }
  const current = async () => (await compose()).text

  /** 这一轮要不要放、放什么：返回 '' 就不放。只在主人亲手发消息的轮次调用。 */
  async function forTurn(sid) {
    const prev = ownerAt.get(sid)
    ownerAt.set(sid, now())
    const back = prev === undefined || now() - prev >= RETURN_GAP
    const { text, asks } = await compose()
    if (!text) return ''
    const last = sent.get(sid)
    const newAsk = Boolean(asks) && asks !== (last?.asks || '')
    if (!back && !newAsk) return ''
    if (last) {
      if (last.text === text && now() - last.at < RESEND_AFTER) return ''
      if (now() - last.at < MIN_GAP) return ''
    }
    sent.set(sid, { at: now(), text, asks })
    return text
  }

  /** 挂到 DSH 的 agent/pre-step 上。只在主人亲手发消息开的那一轮第一步、在她和主人聊天的会话里放。 */
  function attach(ctx) {
    if (typeof ctx?.on !== 'function') return
    return ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const { agent, step, signal } = payload || {}
        if (!decision || decision.kind === 'reject' || signal?.aborted || step !== 1) return decision
        const sid = String(agent?.session?.id ?? agent?.id ?? '')
        const msgs = Array.isArray(decision.messages) ? decision.messages : []
        const fromOwner = msgs.some((m) => m?.role === 'user' && m?.source?.kind === 'user' && !m.source.plugin)
        if (!sid || !fromOwner || !isOwnerChat(sid)) return decision
        const text = await forTurn(sid)
        if (!text || signal?.aborted) return decision
        const message = Object.freeze({
          id: globalThis.crypto?.randomUUID?.() || `ftc-${now()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: CONTEXT_KIND, form: 'snapshot', sections: [{ name: CONTEXT_KIND, text }] },
        })
        return { ...decision, messages: [...msgs, message] }
      } catch (error) {
        log?.debug?.('放小镇近况出错（这一轮不放）：', error?.message || error)
        return decision
      }
    })
  }

  return { attach, current, forTurn, refresh, isOwnerChat: (sid) => Boolean(isOwnerChat(sid)), _cache: () => cache }
}

/**
 * 0.6.0：一台 DSH 带几条鱼时，只挂一个 agent/pre-step：这一轮是主人在哪个会话里说话，就放那条鱼（绑定在这个会话上的鱼）的小镇近况。
 * pick(sid) 返回那条鱼的 createTownContext() 实例，或 null（不放）。
 */
export function attachTownContexts(ctx, pick, log) {
  if (typeof ctx?.on !== 'function') return
  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const { agent, step, signal } = payload || {}
      if (!decision || decision.kind === 'reject' || signal?.aborted || step !== 1) return decision
      const sid = String(agent?.session?.id ?? agent?.id ?? '')
      const msgs = Array.isArray(decision.messages) ? decision.messages : []
      const fromOwner = msgs.some((m) => m?.role === 'user' && m?.source?.kind === 'user' && !m.source.plugin)
      if (!sid || !fromOwner) return decision
      const tc = pick(sid)
      if (!tc) return decision
      const text = await tc.forTurn(sid)
      if (!text || signal?.aborted) return decision
      const message = Object.freeze({
        id: globalThis.crypto?.randomUUID?.() || `ftc-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: CONTEXT_KIND, form: 'snapshot', sections: [{ name: CONTEXT_KIND, text }] },
      })
      return { ...decision, messages: [...msgs, message] }
    } catch (error) {
      log?.debug?.('放小镇近况出错（这一轮不放）：', error?.message || error)
      return decision
    }
  })
}
