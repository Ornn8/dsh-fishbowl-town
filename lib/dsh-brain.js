// DSH 那半边：在 DSH 里给她开「鱼缸小镇」会话，把回合当一条消息交给她，等她这一轮说完，拿回她的话。
// 用到的宿主能力（DSH 0.2.1+ 桌面版 / Web 组合都有）：
//   ctx.workspaceRegistry  建一个「鱼缸小镇」工作区，会话都放在里面（侧边栏能看到她每一步怎么想的）
//   ctx.sessionController  create / rename / resolveAgent / cancel
//   ctx.agents             拿活着的 agent；agent.followup(message) 开一轮
//   'session/event'        assistant/message（她说的话）、turn/end（这一轮结束）
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_TOOL_NAMES } from './chat-tools.js'
import { SELF_TOOL_NAMES } from './self-serve.js'

const TITLES = { game: '鱼缸小镇 · 牌桌', visit: '鱼缸小镇 · 串门', agency: '鱼缸小镇 · 心思', activity: '鱼缸小镇 · 日常', news: '鱼缸小镇 · 见闻' }
const SOURCE_KIND = 'fishbowl-town'
const ROOM_TITLE = '鱼缸小镇 · 插件自用（别在这里聊天）'

/** 会话里有没有主人亲手打的话（不是插件塞的）：有就说明这个会话被主人拿去聊天了。 */
export function ownerTypedIn(agent) {
  const session = agent?.session
  if (!session || typeof session.eventAt !== 'function') return false
  const top = Number(session.seq) || 0
  for (let seq = Math.max(0, top - 400); seq < top; seq++) {
    let e
    try { e = session.eventAt(seq) } catch { e = null }
    if (e && e.type === 'user/message') {
      const src = (e.data && (e.data.message || e.data).source) || {}
      if (src.kind === 'user' && !src.plugin) return true
    }
  }
  return false
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
    try { await controller().rename({ sessionId: sid, title: TITLES[slot] || '鱼缸小镇' }) } catch (error) { log.debug('改会话标题失败：', error.message) }
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

  async function agentFor(slot, { resumeOnly = false } = {}) {
    let entry = state.sessions[slot]
    // 快速模式：小镇会话只留很短的历史（几步就换新会话），每一步的输入小、回得快
    const limit = limitFor(slot)
    if (entry && entry.turns >= limit) {
      // 换一个新会话：上下文不会越滚越长（她的模型按 token 收费，钱是主人的）
      const old = entry.sid
      entry = null
      delete state.sessions[slot]
      try { await registry()?.archiveSession?.(old) } catch (error) { log.debug('归档旧会话失败：', error.message) }
    }
    const archived = registry()?.archivedSessionIds || []
    if (entry && archived.includes?.(entry.sid)) entry = null
    if (entry && (state.ownerTaken || []).includes(entry.sid)) entry = null
    if (entry) {
      try {
        const agent = await resolveAgent(entry.sid, slot)
        // 0.2.10：DSH 的「新会话」会接手工作区里还空着的会话——以前插件预先建好的小镇会话就这样被主人拿去聊天了，
        // 之后小镇的回合（只输出 JSON、括号动作）就落进他的聊天里。会话里有主人亲手打的话：让给他，小镇另开一个。
        if (!entry.checked) {
          entry.checked = true
          if (ownerTypedIn(agent)) { giveToOwner(entry.sid, slot); entry = null } else saveState(state)
        }
        // 同时有两处在接这个会话（开始值班时的 warm 和第一个回合）：另一处刚把它让给了主人，这里也不能再用
        if (entry && ((state.ownerTaken || []).includes(entry.sid) || state.sessions[slot]?.sid !== entry.sid)) entry = null
        if (entry) return { sid: entry.sid, agent }
      } catch (error) { log.info(`会话 …${entry.sid.slice(-8)} 恢复不了（${error.message}），新开一个`) }
    }
    if (resumeOnly) return null // 只接上已有的：不建空会话（空会话会被 DSH 的「新会话」接手）
    const sid = await createSession(slot)
    return { sid, agent: await resolveAgent(sid, slot) }
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
  function ask(slot, text, { timeoutMs = 20000 } = {}) {
    const prev = chains.get(slot) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => runTurn(slot, text, timeoutMs))
    chains.set(slot, run.catch(() => {}))
    return run
  }

  async function runTurn(slot, text, timeoutMs) {
    if (disposed) throw new Error('插件已卸载')
    const started = Date.now()
    const { sid, agent } = await agentFor(slot)
    const left = timeoutMs - (Date.now() - started)
    if (left <= 500) throw Object.assign(new Error('来不及'), { code: 'BRAIN_TIMEOUT' })
    const msg = message(text)
    const done = new Promise((resolve, reject) => {
      const p = { id: msg.id, turn: null, text: '', resolve, reject, timer: null }
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
      if (isTown && src.kind === 'user' && !src.plugin) {
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
