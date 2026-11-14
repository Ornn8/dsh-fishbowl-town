// DSH 那半边：在 DSH 里给她开「鱼缸小镇」会话，把回合当一条消息交给她，等她这一轮说完，拿回她的话。
// 用到的宿主能力（DSH 0.2.1+ 桌面版 / Web 组合都有）：
//   ctx.workspaceRegistry  建一个「鱼缸小镇」工作区，会话都放在里面（侧边栏能看到她每一步怎么想的）
//   ctx.sessionController  create / rename / resolveAgent / cancel
//   ctx.agents             拿活着的 agent；agent.followup(message) 开一轮
//   'session/event'        assistant/message（她说的话）、turn/end（这一轮结束）
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_TOOL_NAMES } from './chat-tools.js'
import { SELF_TOOL_NAMES } from './self-serve.js'

const TITLES = { game: '鱼缸小镇 · 牌桌', visit: '鱼缸小镇 · 串门', agency: '鱼缸小镇 · 心思', activity: '鱼缸小镇 · 日常', news: '鱼缸小镇 · 见闻' }
const SOURCE_KIND = 'fishbowl-town'
const ROOM_TITLE = '鱼缸小镇 · 插件自用（别在这里聊天）'

// 0.5.2：小镇的一步只该带一个小会话的上下文（几千到几万 token）。
// 估到 CONTEXT_ROTATE 就换新会话；一个会话的上下文到了 CONTEXT_HARD，它就不是插件的小会话（被换成了主人的长聊天之类），这一步绝不发。
export const CONTEXT_ROTATE = 40_000
export const CONTEXT_HARD = 100_000
const SCAN_EVENTS = 800 // 只看会话最后这么多条事件（够一个小镇会话看全；长会话按比例估）
const UNSAFE_PAUSE_MS = 30 * 60_000

/** 大约多少 token：中日韩字一个算一个，别的三个字符算一个（宁可估多）。 */
export function approxTokens(text) {
  const s = String(text || '')
  let wide = 0
  for (const ch of s) if (ch.codePointAt(0) > 0x2e7f) wide++
  return wide + Math.ceil((s.length - wide) / 3)
}

/** 一条事件里的消息正文（文字、工具结果）大约多少 token。 */
function eventTokens(e) {
  const d = e && e.data
  if (!d) return 0
  const m = d.message || d
  const parts = Array.isArray(m.content) ? m.content : []
  let n = 0
  for (const b of parts) {
    if (!b) continue
    if (typeof b.text === 'string') n += approxTokens(b.text)
    else if (typeof b.output === 'string') n += approxTokens(b.output)
    else if (b.type === 'tool-result' || b.type === 'tool_result') n += approxTokens(JSON.stringify(b).slice(0, 200_000))
  }
  if (!parts.length && e.type === 'tool/result') n += approxTokens(JSON.stringify(d).slice(0, 200_000))
  return n
}

/** 一次模型请求用了多少上下文（输入 + 读缓存 + 写缓存 + 输出），从 assistant/message 的 usage 读。 */
export function usageContext(data) {
  const u = (data && (data.usage || data.message?.usage)) || null
  if (!u || typeof u !== 'object') return 0
  const n = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0) + (Number(u.outputTokens) || 0)
  return Math.max(n, Number(u.totalTokens) || 0)
}

/** 这条 user/message 是不是主人亲手打的（不是插件、不是 DSH 自己塞的背景）。手机 / 网页发来的也算（带 rpcId / principal）。 */
export function isOwnerTyped(source) {
  const src = source || {}
  if (src.plugin) return false
  if (src.kind === 'user') return true
  return Boolean(src.rpcId || src.principal) && !String(src.kind || '').includes('context')
}

const normPath = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 看清楚一个会话是不是插件能用的小镇小会话（0.5.2）：
 * - foreign：不是要的那个会话（宿主交回来的 agent 换了人）、不在插件自己的工作区（room）里、或是从别的会话分叉出来的
 * - ownerTyped：里面有主人亲手打的话
 * - tokens：上下文大约多大（最后一次请求的 usage，和会话正文估算，取大的）
 */
export function inRoomDir(cwd, roomDirs = []) {
  const c = normPath(cwd)
  if (!c) return true // 读不到目录：不凭这个判
  return roomDirs.some((d) => d && normPath(d) === c) || c.endsWith('/fishbowl-town/room')
}

export function inspectSession(agent, { sid = '', roomDirs = [] } = {}) {
  const facts = { foreign: '', ownerTyped: false, tokens: 0, events: 0 }
  if (!agent) { facts.foreign = 'no-agent'; return facts }
  const session = agent.session
  const ids = [agent.id, session?.id, session?.header?.id].filter((x) => x != null && x !== '').map(String)
  if (sid && ids.some((x) => x !== sid)) facts.foreign = 'other-session'
  let header = null
  try { header = session?.header || null } catch { header = null }
  if (header && !facts.foreign) {
    if (header.cwd && !inRoomDir(header.cwd, roomDirs)) facts.foreign = 'outside-room'
    else if (header.isSeeded) facts.foreign = 'forked'
  }
  if (!session || typeof session.eventAt !== 'function') return facts
  const top = Number(session.seq) || 0
  facts.events = top
  const from = Math.max(0, top - SCAN_EVENTS)
  let lastUsage = 0
  let body = 0
  for (let seq = from; seq < top; seq++) {
    let e
    try { e = session.eventAt(seq) } catch { e = null }
    if (!e) continue
    if (e.type === 'user/message') {
      const m = (e.data && (e.data.message || e.data)) || {}
      if (isOwnerTyped(m.source)) facts.ownerTyped = true
      body += eventTokens(e)
    } else if (e.type === 'assistant/message') {
      const u = usageContext(e.data)
      if (u) lastUsage = u
      body += eventTokens(e)
    } else if (e.type === 'tool/result') body += eventTokens(e)
  }
  // 只看了最后一段：按比例放大（宁可估多，估多了只是早点换新会话）
  if (from > 0 && top > from) body = Math.round(body * (top / (top - from)))
  facts.tokens = Math.max(lastUsage, body)
  return facts
}

/** 旧名字（0.2.10 起）：会话里有没有主人亲手打的话。 */
export function ownerTypedIn(agent) {
  return inspectSession(agent).ownerTyped
}

/** 一轮结束时她的回答：最后一条 assistant 消息里的文字（带工具调用的过程性发言不算）。 */
export function replyTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  if (message.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool_use'))) return ''
  return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

export function createDshBrain({ ctx, config, log, stateDir, state, saveState, chatLink = null }) {
  const pending = new Map() // sessionId -> { id, turn, text, resolve, reject }
  const chains = new Map() // slot -> 上一轮的 promise（同一个会话一次只跑一轮）
  let workspace = null
  let disposed = false
  let sourceKind = SOURCE_KIND
  state.sessions = state.sessions || {}

  const controller = () => {
    let c
    try { c = ctx.sessionController } catch { c = undefined }
    if (!c) { try { c = ctx.get?.('sessionController') } catch { c = undefined } }
    if (!c) throw new Error('这个 DSH 没有会话控制器（需要 DSH 桌面版或 Web 组合，headless / sdk 不行）')
    return c
  }
  const registry = () => ctx.workspaceRegistry || ctx.get?.('workspaceRegistry')

  async function ensureWorkspace() {
    const reg = registry()
    if (!reg) throw new Error('这个 DSH 没有工作区服务')
    const dir = join(stateDir, 'room')
    mkdirSync(dir, { recursive: true })
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    if (workspace && norm(workspace.path) === norm(dir)) return workspace
    workspace = reg.list().find((w) => norm(w.path) === norm(dir)) || await reg.create(dir, ROOM_TITLE)
    // 0.2.10：工作区名字写明是插件自用的——DSH 的「新会话」常常落在最近用过的工作区（就是这个），主人别在这里聊天
    if (workspace && workspace.title !== ROOM_TITLE && typeof workspace.setTitle === 'function') {
      try { await workspace.setTitle(ROOM_TITLE) } catch (error) { log.debug('改工作区名字失败：', error.message) }
    }
    return workspace
  }

  // 「小镇近况」「去小镇」是给主人聊天的会话用的：小镇自己的会话里藏起来（省 token，也不会在拿主意时又去叫小镇）
  const masked = new WeakSet()
  // 「心思」会话（她自己拿主意）留着看看小镇 / 去玩一局 / 去串门 / 去个地方（0.3.0）；别的小镇会话全藏
  function hideChatTools(agent, slot = '') {
    if (!agent || masked.has(agent)) return agent
    masked.add(agent)
    try {
      const tools = agent.ctx?.tools
      if (typeof tools?.restrict !== 'function') { if (!hideChatTools.said) { hideChatTools.said = true; log.info('这个 DSH 不能按会话藏工具：小镇会话也看得到「小镇近况」「去小镇」') } return agent }
      tools.restrict({ deny: slot === 'agency' ? CHAT_TOOL_NAMES.filter((n) => !SELF_TOOL_NAMES.includes(n)) : CHAT_TOOL_NAMES })
      if (!hideChatTools.said) { hideChatTools.said = true; log.info('小镇会话里不挂「小镇近况」「去小镇」（只给主人聊天的会话用）') }
    } catch (error) { log.info('在小镇会话里藏工具失败：', error?.message || error) }
    return agent
  }

  async function resolveRaw(sid) {
    const live = ctx.agents?.get?.(sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r && r.agent) return r.agent
    throw new Error(r?.error?.message || '恢复会话失败')
  }
  // 小镇自己的会话（插件建的）；主人的聊天会话（reportSessionId）用 resolveRaw，工具留着
  const resolveAgent = async (sid, slot = '') => hideChatTools(await resolveRaw(sid), slot)

  const roomDirs = () => {
    const dir = join(stateDir, 'room')
    let real = ''
    try { real = realpathSync.native(dir) } catch { real = '' }
    return [dir, real, workspace?.path]
  }
  const inspect = (agent, sid) => inspectSession(agent, { sid, roomDirs: roomDirs() })

  async function createSession(slot) {
    const ws = await ensureWorkspace()
    let r
    try {
      r = await controller().create({ workspaceId: ws.id, agentPreset: config.preset || 'fishbowl-town' })
    } catch (error) {
      log.warn(`用预设「${config.preset}」建会话失败（${error.message}），改用 DSH 默认预设`)
      r = await controller().create({ workspaceId: ws.id })
    }
    const sid = String(r.sessionId)
    // 标题等确认过是干净的新会话再改（agentFor 里的 nameSession）：万一宿主交回来的是主人的聊天，不能把它改成「鱼缸小镇 · 牌桌」
    state.sessions[slot] = { sid, turns: 0, createdAt: Date.now() }
    state.townSids = [...(state.townSids || []), sid].slice(-200) // 插件建过的小镇会话：认主会话时排除
    saveState(state)
    log.info(`为「${TITLES[slot]}」新建了 DSH 会话 …${sid.slice(-8)}`)
    return sid
  }

  function limitFor(slot) {
    const fast = config.fastMode !== false && slot !== 'news'
    return fast ? Math.max(1, Number(config.fastTurnsPerSession) || 4) : Number(config.turnsPerSession) || 20
  }

  /** 用完的小镇会话：归档，换新的（上下文不会越滚越长；她的模型按 token 收费，钱是主人的）。 */
  async function retire(slot, sid, why) {
    if (state.sessions[slot]?.sid === sid) delete state.sessions[slot]
    saveState(state)
    try { await registry()?.archiveSession?.(sid) } catch (error) { log.debug('归档旧会话失败：', error.message) }
    if (why) log.info(`「${TITLES[slot] || slot}」换新会话（${why}）`)
  }

  /** 不是插件的小会话（主人的聊天、别的工作区、分叉出来的……）：以后再也不往里发，也不改它的名字、不归档它。 */
  function disown(sid, why) {
    state.notTown = [...new Set([...(state.notTown || []), sid])].slice(-50)
    state.townSids = (state.townSids || []).filter((x) => x !== sid)
    for (const [k, v] of Object.entries(state.sessions || {})) if (v && v.sid === sid) delete state.sessions[k]
    saveState(state)
    log.warn(`会话 …${String(sid).slice(-8)} 不是插件自己的小镇小会话（${why}）：小镇的回合不再往里发`)
  }

  const WHY = { 'other-session': 'DSH 交回来的是另一个会话', 'outside-room': '不在插件自己的工作区里', forked: '是从别的会话分叉出来的', 'no-agent': '拿不到会话' }

  /** 新建的会话也要过一遍：DSH 交回来的不是一个干净的小会话，就不在里面答小镇的事（宁可这一步让小镇代打）。 */
  function unsafe(sid, why) {
    if (sid) disown(sid, why)
    const now = Date.now()
    const recent = (state.unsafe?.at && now - state.unsafe.at < 10 * 60_000) ? (state.unsafe.n || 0) + 1 : 1
    state.unsafe = { at: now, n: recent, why, until: recent >= 2 ? now + UNSAFE_PAUSE_MS : 0 }
    if (recent >= 2) {
      state.pluginNotice = { text: '这台 DSH 交给小镇的会话不是干净的新会话（像是你的聊天会话），小镇的回合先停 30 分钟。请更新 DSH 和插件；你的聊天会话不受影响。', at: now }
      log.warn('连着两次拿到的不是干净的小会话：小镇的回合先停 30 分钟（这期间小镇会替她走默认的一步）')
    }
    saveState(state)
    return Object.assign(new Error(`没有干净的小镇会话（${why}）`), { code: 'BRAIN_UNSAFE' })
  }

  async function agentFor(slot, { resumeOnly = false, followup = false, textTokens = 0 } = {}) {
    if (state.unsafe?.until && Date.now() < state.unsafe.until) throw Object.assign(new Error('小镇会话暂停中（上次拿到的不是干净的小会话）'), { code: 'BRAIN_UNSAFE' })
    let entry = state.sessions[slot]
    // 快速模式：小镇会话只留很短的历史（几步就换新会话），每一步的输入小、回得快。
    // 同一个回合的追问（followup）留在原会话里——换了新会话，她就看不到自己刚才答的那一步
    const limit = limitFor(slot)
    if (entry && entry.turns >= limit && !(followup && entry.turns < Number.MAX_SAFE_INTEGER)) { await retire(slot, entry.sid, ''); entry = null }
    const archived = registry()?.archivedSessionIds || []
    if (entry && archived.includes?.(entry.sid)) entry = null
    if (entry && ((state.ownerTaken || []).includes(entry.sid) || (state.notTown || []).includes(entry.sid))) entry = null
    if (entry && !(state.townSids || []).includes(entry.sid)) { disown(entry.sid, '不是插件建的'); entry = null }
    if (entry) {
      try {
        const agent = await resolveAgent(entry.sid, slot)
        // 0.5.2：每一步发之前都看一遍（以前只看一次）——
        // 不是插件的小会话 / 主人在里面说过话 / 上下文太大，都不再用（0.2.10 起：DSH 的「新会话」会接手插件工作区里的空会话）
        const f = inspect(agent, entry.sid)
        const est = Math.max(f.tokens, Number(entry.ctx) || 0) + textTokens
        if (f.foreign) { disown(entry.sid, WHY[f.foreign] || f.foreign); entry = null } else if (f.ownerTyped) { giveToOwner(entry.sid, slot); entry = null } else if (est > CONTEXT_ROTATE) { await retire(slot, entry.sid, `上下文约 ${Math.round(est / 1000)}K token`); entry = null }
        // 同时有两处在接这个会话（开始值班时的 warm 和第一个回合）：另一处刚把它让给了主人，这里也不能再用
        if (entry && ((state.ownerTaken || []).includes(entry.sid) || state.sessions[slot]?.sid !== entry.sid)) entry = null
        if (entry) return { sid: entry.sid, agent }
      } catch (error) { log.info(`会话 …${entry.sid.slice(-8)} 恢复不了（${error.message}），新开一个`) }
    }
    if (resumeOnly) return null // 只接上已有的：不建空会话（空会话会被 DSH 的「新会话」接手）
    const sid = await createSession(slot)
    let agent
    try { agent = await resolveAgent(sid, slot) } catch (error) { throw unsafe(sid, '新会话打不开：' + (error?.message || error)) }
    const f = inspect(agent, sid)
    // 刚建的会话应该是空的、在插件工作区里：不是（宿主把别的会话交了回来）就不发
    if (f.foreign || f.ownerTyped || f.tokens > CONTEXT_HARD) throw unsafe(sid, f.foreign ? (WHY[f.foreign] || f.foreign) : f.ownerTyped ? '新会话里有主人说过的话' : `新会话的上下文就有约 ${Math.round(f.tokens / 1000)}K token`)
    try { await controller().rename({ sessionId: sid, title: TITLES[slot] || '鱼缸小镇' }) } catch (error) { log.debug('改会话标题失败：', error.message) }
    if (state.unsafe) { delete state.unsafe; saveState(state) }
    return { sid, agent }
  }

  /** 「小镇用的模型」：只给小镇会话换模型（provider/model），不动 DSH 的默认模型。 */
  function useTownModel(agent) {
    const want = String(config.townModel || '').trim()
    const cut = want.indexOf('/')
    if (cut <= 0) return
    const sel = { provider: want.slice(0, cut), model: want.slice(cut + 1) }
    try {
      const agents = controller().agents
      if (agents && typeof agents.selectForNextRequest === 'function') agents.selectForNextRequest(agent, sel)
      else agent.session?.append?.('model/selection', sel)
    } catch (error) {
      log.debug('换小镇用的模型失败（用默认模型）：', error.message)
    }
  }

  function message(text) {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind, speaker: { role: 'none' } } }
  }

  function send(agent, msg) {
    try {
      agent.followup(msg)
    } catch (error) {
      // 有的 DSH 版本只认 source.kind = 'user'
      if (sourceKind !== 'user') {
        sourceKind = 'user'
        msg.source = { kind: 'user', plugin: SOURCE_KIND }
        agent.followup(msg)
        return
      }
      throw error
    }
  }

  /** 在 slot 对应的会话里跑一轮，返回她最后说的话。 */
  function ask(slot, text, { timeoutMs = 20000, followup = false } = {}) {
    const prev = chains.get(slot) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => runTurn(slot, text, timeoutMs, followup))
    chains.set(slot, run.catch(() => {}))
    return run
  }

  async function runTurn(slot, text, timeoutMs, followup = false) {
    if (disposed) throw new Error('插件已卸载')
    const started = Date.now()
    const textTokens = approxTokens(text)
    const { sid, agent } = await agentFor(slot, { followup, textTokens })
    // 最后一道闸：这一步要发的会话已经很大（不该发生；发生了就是会话被顶替了），绝不发
    const last = inspect(agent, sid)
    if (last.foreign || last.ownerTyped || last.tokens + textTokens > CONTEXT_HARD) {
      throw unsafe(sid, last.foreign ? (WHY[last.foreign] || last.foreign) : last.ownerTyped ? '会话里有主人说过的话' : `上下文约 ${Math.round((last.tokens + textTokens) / 1000)}K token`)
    }
    const left = timeoutMs - (Date.now() - started)
    if (left <= 500) throw Object.assign(new Error('来不及'), { code: 'BRAIN_TIMEOUT' })
    const msg = message(text)
    const done = new Promise((resolve, reject) => {
      const p = { id: msg.id, turn: null, text: '', resolve, reject, timer: null, slot }
      p.timer = setTimeout(() => {
        if (pending.get(sid) !== p) return
        pending.delete(sid)
        // 停掉这一轮，别让它在后面占着会话；这个会话也不再用了（被取消的那一轮晚到的结束信号不能串到下一步上）
        try { controller().cancel({ sessionId: sid }) } catch (error) { log.debug('取消超时的一轮失败：', error.message) }
        const entry = state.sessions[slot]
        if (entry && entry.sid === sid) { entry.turns = Number.MAX_SAFE_INTEGER; saveState(state) }
        reject(Object.assign(new Error('她没在时限内答完'), { code: 'BRAIN_TIMEOUT' }))
      }, left)
      pending.set(sid, p)
    })
    useTownModel(agent)
    send(agent, msg)
    const entry = state.sessions[slot]
    if (entry && entry.sid === sid) { entry.turns++; saveState(state) }
    try {
      return await done
    } finally {
      pending.delete(sid)
    }
  }

  function onSessionEvent(session, event) {
    const sid = String(session?.id ?? '')
    if (event && event.type === 'user/message' && sid) {
      const m0 = (event.data && (event.data.message || event.data)) || {}
      const src = m0.source || {}
      const isTown = Object.values(state.sessions || {}).some((x) => x && x.sid === sid)
      if (isTown && isOwnerTyped(src)) {
        giveToOwner(sid)
        const was = pending.get(sid) // 她接下来回的是主人，不是小镇：这一步不交
        if (was) { pending.delete(sid); clearTimeout(was.timer); was.reject(Object.assign(new Error('会话被主人拿去聊天了'), { code: 'BRAIN_TIMEOUT' })) }
        return
      }
    }
    const p = pending.get(sid)
    if (!p || !event) return
    const d = event.data || {}
    if (event.type === 'user/message') {
      const m = d.message || d
      if (m && m.id === p.id && typeof d.turn === 'number') p.turn = d.turn
      return
    }
    if (event.type === 'assistant/message') {
      if (d.interrupted) return
      if (p.turn != null && typeof d.turn === 'number' && d.turn !== p.turn) return
      p.text = replyTextOf(d.message)
      // 0.5.2：记下这次请求的上下文有多大。大了下一步就换新会话；大得离谱（不是小会话）就停掉这一轮，后面的步骤不再花钱
      const used = usageContext(d)
      if (used) {
        const entry = Object.values(state.sessions || {}).find((x) => x && x.sid === sid)
        if (entry) { entry.ctx = used; if (used > CONTEXT_ROTATE) entry.turns = Number.MAX_SAFE_INTEGER; saveState(state) }
        if (used > CONTEXT_HARD) {
          pending.delete(sid)
          clearTimeout(p.timer)
          try { controller().cancel({ sessionId: sid }) } catch (error) { log.debug('停掉这一轮失败：', error.message) }
          p.reject(unsafe(sid, `一次请求的上下文约 ${Math.round(used / 1000)}K token`))
        }
      }
      return
    }
    if (event.type === 'turn/end') {
      if (p.turn != null && typeof d.turn === 'number' && d.turn !== p.turn) return
      pending.delete(sid)
      clearTimeout(p.timer)
      if (!d.reason || d.reason.kind === 'completed') p.resolve(p.text)
      else p.reject(new Error('这一轮没正常结束：' + (d.reason.kind || '?')))
    }
  }

  /** 小镇的消息交给她：只放进插件自己的「鱼缸小镇 · 见闻」会话（0.2.10 起）。
   * 不再塞进主人和她聊天的会话——那样主人的聊天记录里会混进小镇的对话、括号动作和格式要求，她平时的回话会被带偏。
   * 主人聊天里的她通过「小镇近况」背景备注（town-context.js）知道最近的事。 */
  async function tell(text) {
    return ask('news', text, { timeoutMs: 120_000 })
  }

  /** 「小镇有趣的事主动告诉我」：在主人聊天的会话里附一条标明是插件的背景备注，由她自己的模型用平时的口气跟他说。
   * 没认出主人聊天的会话就不发。不等她回完。返回有没有发出去。 */
  async function tellOwnerChat(text) {
    const main = chatLink ? chatLink.mainChat() : null
    if (!main || !main.sid) return false
    const agent = await resolveRaw(main.sid)
    const msg = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'fishbowl-town-context', form: 'snapshot', sections: [{ name: 'fishbowl-town-context', text }] } }
    try { agent.followup(msg) } catch {
      msg.source = { kind: 'user', plugin: SOURCE_KIND }
      agent.followup(msg)
    }
    return true
  }

  /** 开始值班时先把牌桌和串门两个会话接上（不调模型），第一步就不用等建会话。 */
  // 0.2.10：不再预先建空会话（空会话会被 DSH 的「新会话」接手，主人就会在小镇的会话里聊天）；只把已有的接上
  async function warm() {
    // 旧版本预先建好、一直没用过的空会话：归档掉，免得 DSH 的「新会话」把主人放进去
    for (const [slot, e] of Object.entries(state.sessions || {})) {
      if (e && e.sid && !e.turns) {
        try { await registry()?.archiveSession?.(e.sid) } catch (error) { log.debug('归档空会话失败：', error.message) }
        delete state.sessions[slot]
        saveState(state)
      }
    }
    // 插件工作区里别的空会话（旧版本建了又没用上的）也归档：它们标题是「鱼缸小镇 · 牌桌」之类，主人点「新会话」会落进去
    try {
      const ws = await ensureWorkspace()
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 5000)
      const r = await controller().list({}, ac.signal)
      clearTimeout(t)
      const mineIds = new Set((ws?.sessionIds || []).map(String))
      const live = new Set(Object.values(state.sessions || {}).map((x) => x && x.sid))
      const blanks = (r?.items || []).filter((x) => x && x.blank && mineIds.has(String(x.sessionId)) && !live.has(String(x.sessionId)))
      for (const x of blanks) { try { await registry()?.archiveSession?.(String(x.sessionId)) } catch (error) { log.debug('归档空会话失败：', error.message) } }
      if (blanks.length) log.info(`归档了插件工作区里 ${blanks.length} 个没用过的空会话`)
    } catch (error) { log.debug('清理空会话失败：', error?.message || error) }
    for (const slot of ['game', 'visit', 'agency']) {
      const e = state.sessions[slot]
      if (e && e.turns < limitFor(slot)) await agentFor(slot, { resumeOnly: true }) // 用完的那个等真有回合时再换（换的时候马上就发消息，不留空会话）
    }
  }

  /** 这个小镇会话被主人拿去聊天了：以后不再往里发小镇的回合，它也不再算小镇会话。 */
  function giveToOwner(sid, slot = null) {
    state.ownerTaken = [...new Set([...(state.ownerTaken || []), sid])].slice(-50)
    state.townSids = (state.townSids || []).filter((x) => x !== sid)
    for (const [k, v] of Object.entries(state.sessions || {})) if (v && v.sid === sid) delete state.sessions[k]
    saveState(state)
    // 标题还是插件起的「鱼缸小镇 · 牌桌」之类：改成普通的名字，免得主人以为那是小镇的会话
    Promise.resolve().then(() => controller().rename({ sessionId: sid, title: '聊天' })).catch((error) => log.debug('改会话标题失败：', error?.message))
    log.warn(`会话 …${sid.slice(-8)}${slot ? `（原来是「${TITLES[slot]}」）` : ''}里有主人自己说的话：让给主人聊天，小镇的回合以后换到新会话`)
  }

  return {
    ask,
    tell,
    tellOwnerChat,
    warm,
    // 插件提醒（接入码不对之类）：记下来，主人聊天时的背景备注里带上（24 小时）；见闻会话里也记一笔
    notify: (text) => {
      state.pluginNotice = { text: String(text || '').slice(0, 120), at: Date.now() }
      saveState(state)
      return tell(`【鱼缸小镇 · 插件提醒】${text}`).catch((e) => log.debug('提醒没送到：', e.message))
    },
    onSessionEvent,
    get reportsToOwnerChat() { return false },
    dispose() {
      disposed = true
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('插件已卸载')) }
      pending.clear()
    },
  }
}
