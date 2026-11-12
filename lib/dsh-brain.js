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

const TITLES = { game: '鱼缸小镇 · 牌桌', visit: '鱼缸小镇 · 串门', agency: '鱼缸小镇 · 心思', news: '鱼缸小镇 · 见闻' }
const SOURCE_KIND = 'fishbowl-town'

/** 一轮结束时她的回答：最后一条 assistant 消息里的文字（带工具调用的过程性发言不算）。 */
export function replyTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  if (message.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool_use'))) return ''
  return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

export function createDshBrain({ ctx, config, log, stateDir, state, saveState }) {
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
    workspace = reg.list().find((w) => norm(w.path) === norm(dir)) || await reg.create(dir, '鱼缸小镇')
    return workspace
  }

  // 「小镇近况」「去小镇」是给主人聊天的会话用的：小镇自己的会话里藏起来（省 token，也不会在拿主意时又去叫小镇）
  const masked = new WeakSet()
  function hideChatTools(agent) {
    if (!agent || masked.has(agent)) return agent
    masked.add(agent)
    try {
      const tools = agent.ctx?.tools
      if (typeof tools?.restrict !== 'function') { if (!hideChatTools.said) { hideChatTools.said = true; log.info('这个 DSH 不能按会话藏工具：小镇会话也看得到「小镇近况」「去小镇」') } return agent }
      tools.restrict({ deny: CHAT_TOOL_NAMES })
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
  const resolveAgent = async (sid) => hideChatTools(await resolveRaw(sid))

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
    saveState(state)
    log.info(`为「${TITLES[slot]}」新建了 DSH 会话 …${sid.slice(-8)}`)
    return sid
  }

  async function agentFor(slot) {
    let entry = state.sessions[slot]
    // 快速模式：小镇会话只留很短的历史（几步就换新会话），每一步的输入小、回得快
    const fast = config.fastMode !== false && slot !== 'news'
    const limit = fast ? Math.max(1, Number(config.fastTurnsPerSession) || 4) : Number(config.turnsPerSession) || 20
    if (entry && entry.turns >= limit) {
      // 换一个新会话：上下文不会越滚越长（她的模型按 token 收费，钱是主人的）
      const old = entry.sid
      entry = null
      delete state.sessions[slot]
      try { await registry()?.archiveSession?.(old) } catch (error) { log.debug('归档旧会话失败：', error.message) }
    }
    const archived = registry()?.archivedSessionIds || []
    if (entry && archived.includes?.(entry.sid)) entry = null
    if (entry) {
      try { return { sid: entry.sid, agent: await resolveAgent(entry.sid) } } catch (error) { log.info(`会话 …${entry.sid.slice(-8)} 恢复不了（${error.message}），新开一个`) }
    }
    const sid = await createSession(slot)
    return { sid, agent: await resolveAgent(sid) }
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
    const p = pending.get(sid)
    if (!p || !event) return
    const d = event.data || {}
    if (event.type === 'user/message') {
      if (d.message && d.message.id === p.id && typeof d.turn === 'number') p.turn = d.turn
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

  /** 小镇的消息交给她：默认放进「鱼缸小镇 · 见闻」会话；设置了 reportSessionId 就交到那个会话（比如她和主人聊天的会话）。 */
  async function tell(text) {
    if (config.reportSessionId) {
      const agent = await resolveRaw(config.reportSessionId)
      send(agent, message(text)) // 那个会话的回复由它自己的插件（QQ 桥之类）处理，我们不等
      return ''
    }
    return ask('news', text, { timeoutMs: 120_000 })
  }

  /** 开始值班时先把牌桌和串门两个会话接上（不调模型），第一步就不用等建会话。 */
  async function warm() {
    for (const slot of ['game', 'visit', 'agency']) await agentFor(slot)
  }

  return {
    ask,
    tell,
    warm,
    notify: (text) => tell(`【鱼缸小镇 · 插件提醒】${text}\n请用一两句话转告主人。`).catch((e) => log.debug('提醒没送到：', e.message)),
    onSessionEvent,
    get reportsToOwnerChat() { return Boolean(config.reportSessionId) },
    dispose() {
      disposed = true
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('插件已卸载')) }
      pending.clear()
    },
  }
}
