// 她和主人聊天的那个会话：认出来是哪个（小镇消息交到那里），再从那里带几句「她和主人最近的事」给小镇这边拿主意用。
//
// DSH 没有「这条鱼的主会话」这种东西，插件只能看它在运行时经过的会话事件（'session/event'）：
//   - 主人亲手打的字（source.kind = 'user'，不是插件塞进去的）记在哪个会话、什么时候；
//   - 她回的话（不带工具调用的那种，像聊天，不像写代码）。
// 选主会话的顺序：主人在插件页绑定的 > 她最近用过「小镇近况 / 去小镇」的会话（说明是在跟她聊小镇）>
// 最近 7 天主人说话最多、而且她回话基本不调工具的会话（像聊天，不是写代码）。都没有就交到「鱼缸小镇 · 见闻」。
//
// 记在 state.json 里的只有：会话 id、主人说话的时间、每个会话最近 8 句的前 80 个字（给「她和主人最近的事」用）。

const WEEK = 7 * 24 * 3600_000
const KEEP_LINES = 8
const SNAP_EVERY = 30 * 60_000
const MIN_OWNER_MSGS = 3

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
      if (!c.owner.length && now() - (c.lastAt || 0) > WEEK) delete state.chats[id]
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
      if (src.kind !== 'user' || src.plugin) { // 插件（我们自己、QQ 桥……）塞的消息不算主人说的
        if (src.kind === 'fishbowl-town' || src.kind === 'fishbowl-town-context' || src.plugin === 'fishbowl-town') fromPlugin.add(sid)
        return
      }
      const line = clip(textOf(m))
      if (!line) return
      const c = entry(sid)
      c.owner.push(now())
      c.lastAt = now()
      c.lines.push({ who: 'owner', at: now(), text: line })
      c.lines.splice(0, Math.max(0, c.lines.length - KEEP_LINES))
      state.lastOwnerSid = sid
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
      const n = (c.owner || []).filter((x) => now() - x < WEEK).length
      if (n < MIN_OWNER_MSGS) continue
      if ((c.tools || 0) > (c.plain || 0)) continue // 她在那儿一直调工具：多半是在写代码，不是聊天
      if (!best || n > best.n) best = { sid, n }
    }
    return best ? { sid: best.sid, how: 'active' } : null
  }

  /** 「她和主人最近的事」：主会话里最近两来回（最多 4 行），30 分钟才换一次；关掉或没有就空。 */
  function ownerLife() {
    if (config.bridgeChat === false) return []
    const main = mainChat()
    if (!main) return []
    if (snap && snap.sid === main.sid && now() - snap.at < SNAP_EVERY) return snap.lines
    const c = state.chats[main.sid]
    const lines = (c && c.lines ? c.lines : []).filter((l) => now() - l.at < 3 * 24 * 3600_000).slice(-4)
      .map((l) => `${l.who === 'owner' ? '主人' : '你'}（${ago(now() - l.at)}）：${l.text}`)
    snap = { at: now(), sid: main.sid, lines }
    return lines
  }

  return { observe, usedTownTool, mainChat, ownerLife, resetSnapshot: () => { snap = null } }
}
