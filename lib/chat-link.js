// 她和主人聊天的那个会话：认出来是哪个（小镇消息交到那里），再从那里带几句「她和主人最近的事」给小镇这边拿主意用。
//
// DSH 没有「这条鱼的主会话」这种东西，插件只能看它在运行时经过的会话事件（'session/event'）：
//   - 主人亲手打的字（source.kind = 'user'，不是插件塞进去的）记在哪个会话、什么时候；
//   - 她回的话（不带工具调用的那种，像聊天，不像写代码）。
// 选主会话的顺序：主人在插件页绑定的 > 她最近用过「小镇近况 / 去小镇」的会话（说明是在跟她聊小镇）>
// 最近 7 天主人说话最多、而且她回话基本不调工具的会话（像聊天，不是写代码）。都没有就交到「鱼缸小镇 · 见闻」。
//
// 记在 state.json 里的只有：会话 id、主人说话的时间、每个会话最近 8 句的前 80 个字（给「她和主人最近的事」用）。
//
// 0.7.4（主人反馈：Web 和 QQ 两边都要看到小镇近况）：主人可以再绑几个会话（alsoSessionIds，比如 QQ 私聊那间），只放背景备注、
// 也算「她和主人最近的事」。QQ 插件转进来的话各自打的标记不一样（11-15 看过的：腾讯官方、zaofan、qq-bridge 打 'user'，
// 跟主人在 DSH 里亲手打的一样；dsh-qq-link 打 'qq'；napcat、大肥鱼桥打 'plugin' / 'plugin:…'），而且多数插件一个群一个会话：
//   - 绑定的会话：这些标记都算主人的话（主人亲口说了那是他和她的私聊）；
//   - 没绑定的会话：照旧只认 'user'，而且自动认「聊得最多的会话」只数在 DSH 客户端里亲手打的（带 rpcId），免得认到热闹的 QQ 群。

const WEEK = 7 * 24 * 3600_000
const KEEP_LINES = 8
const SNAP_EVERY = 30 * 60_000
const MIN_OWNER_MSGS = 3
const MAX_ALSO = 4
const OURS = new Set(['fishbowl-town', 'fishbowl-town-context'])
const NOT_CHAT_FORMS = new Set(['instructions', 'snapshot', 'notice'])

/** 这条消息是不是从 QQ 这类插件转进来的聊天（不是主人在 DSH 里亲手打的，也不是插件塞的说明）。 */
export function forwardedChat(src) {
  if (!src || typeof src !== 'object' || OURS.has(src.kind) || NOT_CHAT_FORMS.has(src.form)) return false
  const k = String(src.kind || '')
  return k === 'qq' || k === 'plugin' || k.startsWith('plugin:') || (k === 'user' && (Boolean(src.plugin) || !(src.rpcId || src.principal)))
}
/** 在 DSH 客户端里亲手打的（DSH 的 user-rpc：kind user、带 rpcId）。 */
export const typedInDsh = (src) => Boolean(src && src.kind === 'user' && !src.plugin && (src.rpcId || src.principal)) // (手机远程的带 principal：dsh-brain isOwnerTyped 也这么认)

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

function hasToolCall(message) {
  return Boolean(message && Array.isArray(message.content) && message.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool_use')))
}

/** 聊天里的一句 → 80 字以内的一行（去掉代码块、链接、多余空白）。 */
export function clip(text, n = 80) {
  let s = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const chars = [...s]
  if (chars.length > n) s = chars.slice(0, n).join('') + '…'
  return s
}

function ago(ms) {
  const m = Math.round(ms / 60_000)
  if (m < 2) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`
}

export function createChatLink({ state, saveState = () => {}, config, isTownSession = () => false, now = () => Date.now() }) {
  state.chats = state.chats && typeof state.chats === 'object' ? state.chats : {}
  const alsoSids = () => (Array.isArray(config.alsoSessionIds) ? config.alsoSessionIds : []).map(String).filter(Boolean).slice(0, MAX_ALSO)
  /** 主人绑定的会话（主会话 + 也放备注的那几个）。 */
  const isBound = (sid) => Boolean(sid) && (String(config.reportSessionId || '') === String(sid) || alsoSids().includes(String(sid)))
  /** 这条消息算不算主人在这个会话里说的话。 */
  function ownerSource(sid, src) {
    if (!src || typeof src !== 'object' || OURS.has(src.kind) || isTownSession(sid)) return false
    if (isBound(sid)) return (src.kind === 'user' && !src.plugin) || forwardedChat(src)
    return src.kind === 'user' && !src.plugin
  }
  const fromPlugin = new Set() // 刚被插件塞过小镇消息的会话：她接下来那句回话是在讲小镇，不算「她和主人的事」
  let snap = null // { at, sid, lines }

  const entry = (sid) => {
    let c = state.chats[sid]
    if (!c) c = state.chats[sid] = { owner: [], plain: 0, tools: 0, lines: [] }
    return c
  }
  const prune = () => {
    const ids = Object.keys(state.chats)
    for (const id of ids) {
      const c = state.chats[id]
      c.owner = (c.owner || []).filter((t) => now() - t < WEEK).slice(-50)
      c.web = (c.web || []).filter((t) => now() - t < WEEK).slice(-50)
      if (!c.owner.length && now() - (c.lastAt || 0) > WEEK && !isBound(id)) delete state.chats[id]
    }
    const left = Object.keys(state.chats)
    if (left.length > 12) {
      left.sort((a, b) => (state.chats[a].lastAt || 0) - (state.chats[b].lastAt || 0))
      for (const id of left.slice(0, left.length - 12)) delete state.chats[id]
    }
  }

  function observe(session, event) {
    const sid = String(session?.id ?? '')
    if (!sid || !event || isTownSession(sid)) return
    const d = event.data || {}
    if (event.type === 'user/message') {
      const m = d.message || d // DSH 0.2.1：事件的 data 就是那条消息；也认 { message } 的写法
      const src = m && m.source
      if (!src) return
      if (OURS.has(src.kind) || src.plugin === 'fishbowl-town') { fromPlugin.add(sid); return }
      // 0.7.4：QQ 这类插件转进来的话：记下最近一个这样的会话（插件页「加上 QQ 那边的会话」用）
      if (forwardedChat(src)) { state.lastForwardSid = sid; state.lastForwardAt = now() }
      if (!ownerSource(sid, src)) return // 没绑定的会话里，插件塞的消息不算主人说的
      const line = clip(textOf(m))
      if (!line) return
      const c = entry(sid)
      c.owner.push(now())
      if (typedInDsh(src)) c.web = [...(c.web || []), now()].slice(-50)
      c.lastAt = now()
      c.lines.push({ who: 'owner', at: now(), text: line })
      c.lines.splice(0, Math.max(0, c.lines.length - KEEP_LINES))
      if (typedInDsh(src)) state.lastOwnerSid = sid // 「绑定到当前会话」：只认在 DSH 里亲手打的（QQ 群的会话不会被当成「当前」）
      fromPlugin.delete(sid)
      prune()
      saveState(state)
      return
    }
    if (event.type === 'assistant/message') {
      if (d.interrupted) return
      const c = state.chats[sid]
      if (!c) return // 主人在这个会话里还没说过话
      const m = d.message || d
      if (hasToolCall(m)) { c.tools++; return }
      if (fromPlugin.has(sid)) return
      const line = clip(textOf(m))
      if (!line) return
      c.plain++
      c.lines.push({ who: 'her', at: now(), text: line })
      c.lines.splice(0, Math.max(0, c.lines.length - KEEP_LINES))
      saveState(state)
    }
  }

  /** 她在这个会话里用了「小镇近况 / 去小镇」：这里就是她和主人聊天的地方。 */
  function usedTownTool(sid) {
    if (!sid || isTownSession(sid)) return
    // 0.7.4：主人在这里亲手打过字（或绑定了它）才算：QQ 群里有人叫她看小镇，不能让那个群成了她和主人的聊天
    const c = state.chats[String(sid)]
    if (!isBound(sid) && !(c && (c.web || []).some((t) => now() - t < WEEK))) return
    state.toolSession = { sid: String(sid), at: now() }
    saveState(state)
  }

  /** 小镇消息该交到哪：{ sid, how }，how = bound | tools | active；都没有返回 null（交到「见闻」）。 */
  function mainChat() {
    const bound = String(config.reportSessionId || '').trim()
    if (bound) return { sid: bound, how: 'bound' }
    if (config.autoChat === false) return null // 0.6.0：一台 DSH 带几条鱼时不自动认（几条鱼会认到同一个会话），只认主人绑定的
    const t = state.toolSession
    if (t && t.sid && now() - t.at < WEEK && !isTownSession(t.sid)) return { sid: t.sid, how: 'tools' }
    let best = null
    for (const [sid, c] of Object.entries(state.chats)) {
      if (isTownSession(sid)) continue
      // 0.7.4：只数主人在 DSH 客户端里亲手打的（QQ 插件一个群一个会话，群里谁说话都跟主人打字一样）
      const n = (c.web || []).filter((x) => now() - x < WEEK).length
      if (n < MIN_OWNER_MSGS) continue
      if ((c.tools || 0) > (c.plain || 0)) continue // 她在那儿一直调工具：多半是在写代码，不是聊天
      if (!best || n > best.n) best = { sid, n }
    }
    return best ? { sid: best.sid, how: 'active' } : null
  }

  /** 「她和主人最近的事」：主会话和主人另外绑定的会话里最近两来回（合起来最多 4 行），30 分钟才换一次；关掉或没有就空。 */
  function ownerLife() {
    if (config.bridgeChat === false) return []
    const main = mainChat()
    const sids = [...new Set([main && main.sid, ...alsoSids()].filter(Boolean))]
    if (!sids.length) return []
    const key = sids.join('|')
    if (snap && snap.sid === key && now() - snap.at < SNAP_EVERY) return snap.lines
    const lines = sids.flatMap((sid) => (state.chats[sid] && state.chats[sid].lines) || [])
      .filter((l) => now() - l.at < 3 * 24 * 3600_000).sort((a, b) => a.at - b.at).slice(-4)
      .map((l) => `${l.who === 'owner' ? '主人' : '你'}（${ago(now() - l.at)}）：${l.text}`)
    snap = { at: now(), sid: key, lines }
    return lines
  }

  return { observe, usedTownTool, mainChat, ownerLife, isBound, ownerSource, alsoSids, resetSnapshot: () => { snap = null } }
}
