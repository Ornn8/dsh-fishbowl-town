// A small stand-in for the DSH host services the plugin touches, shaped after DSH 0.2.1-rc.5's typings
// (dsh-api-session-controller, dsh-workspace, dsh-agent-loop, dsh-system-prompt) and the session events community
// plugins read (user/message, assistant/message, turn/end). The "model" is a function the test supplies.
// webServer + connection follow dsh-client-connection: requestRejection() answers 401 | 403 | undefined.
import { EventEmitter } from 'node:events'

export function createFakeHost({ model, latencyMs = 50 } = {}) {
  const listeners = new Map()
  const disposers = []
  const variables = new Map()
  const sessions = new Map() // sid -> { title, preset, workspaceId, messages: [], agent }
  const workspaces = []
  let seq = 0
  const routes = new Map() // path -> handler (webServer.register kind 'exact')
  const tools = new Map() // name -> definition (ctx.tools.register, raw definitions as dsh-tools accepts them)
  const fence = { rejection: undefined } // what connection.requestRejection answers

  function emit(name, ...args) {
    for (const fn of listeners.get(name) || []) fn(...args)
  }

  function makeAgent(sid) {
    const s = sessions.get(sid)
    let turn = 0
    const queue = []
    const agent = {
      id: sid,
      session: { id: sid },
      status: 'idle',
      denied: [], // tools masked for this agent (agent.ctx.tools.restrict)
      // like DSH 0.2.1: restrict() throws on a name that is not a registered global tool (0.3.1 shipped a stale name and the mask failed)
      ctx: { tools: { restrict(filter) {
        for (const n of filter.deny || []) if (!tools.has(n)) throw new Error(`tools.restrict() names unknown global tool "${n}"`)
        agent.denied.push(...(filter.deny || [])); return () => {}
      } } },
      followup(message) {
        if (!message || message.role !== 'user' || !Array.isArray(message.content)) throw new Error('SessionFormatError')
        queue.push(message)
        if (agent.status !== 'running') pump()
      },
      cancelled: false,
    }
    async function pump() {
      while (queue.length) {
        const message = queue.shift()
        agent.status = 'running'
        agent.cancelled = false
        turn++
        const myTurn = turn
        s.messages.push({ role: 'user', text: message.content.map((b) => b.text).join('') })
        emit('session/event', agent.session, { type: 'user/message', data: message }) // DSH 0.2.1 shape: the event data is the message itself
        const system = renderSystem(s.preset)
        let text
        try {
          text = await model({ system, history: s.messages.slice(), sessionId: sid, title: s.title, agent })
        } catch (error) {
          text = ''
        }
        await new Promise((r) => setTimeout(r, latencyMs))
        if (agent.cancelled) {
          emit('session/event', agent.session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'cancelled' } } })
        } else {
          s.messages.push({ role: 'assistant', text })
          emit('session/event', agent.session, { type: 'assistant/message', data: { turn: myTurn, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
          emit('session/event', agent.session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'completed' } } })
        }
        agent.status = 'idle'
      }
    }
    return agent
  }

  function renderSystem(preset) {
    if (preset === 'fishbowl-town') {
      const fn = variables.get('fishbowl_town_persona')
      return fn ? fn({}) : ''
    }
    return 'You are DSH, a coding assistant.'
  }

  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      const off = () => listeners.get(name)?.delete(fn)
      disposers.push(off)
      return off
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    get(name) { return ctx[name] },
    agents: { get: (sid) => sessions.get(sid)?.agent },
    systemPrompt: {
      variable(name, fn) { variables.set(name, fn); return () => variables.delete(name) },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => workspaces.slice(),
      async create(path, title) { const w = { id: 'ws' + workspaces.length, path, title }; workspaces.push(w); return w },
      async archiveSession(sid) { ctx.workspaceRegistry.archivedSessionIds.push(sid) },
    },
    webServer: {
      register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path) },
    },
    connection: { requestRejection: () => fence.rejection },
    tools: {
      register(def) {
        if (!def || typeof def.name !== 'string' || typeof def.execute !== 'function' || typeof def.output?.render !== 'function') throw new TypeError('bad tool')
        if (tools.has(def.name)) throw new Error('duplicate tool ' + def.name)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    sessionController: {
      async create({ workspaceId, agentPreset }) {
        const sid = 'session-' + (++seq) + '-' + Math.random().toString(16).slice(2, 10)
        sessions.set(sid, { title: '', preset: agentPreset, workspaceId, messages: [] })
        sessions.get(sid).agent = makeAgent(sid)
        return { sessionId: sid, agentPreset }
      },
      async list() {
        return { items: [...sessions.entries()].map(([sid, s]) => ({ sessionId: sid, updatedAt: s.updatedAt || 0, blank: !s.messages.length, running: false, agentAvailable: true, projections: { kind: 'cached', asOfSeq: 0, values: { title: s.title } } })) }
      },
      async rename({ sessionId, title }) { sessions.get(sessionId).title = title; return { title, seq: 0 } },
      async resolveAgent(sid) { const s = sessions.get(sid); return s ? { agent: s.agent } : { error: { message: 'not found' } } },
      cancel({ sessionId }) { const s = sessions.get(sessionId); if (s) s.agent.cancelled = true; return { accepted: true } },
    },
  }

  /** One HTTP request to a route the plugin registered, the way DSH's web server hands it over. */
  async function http(path, { method = 'GET', body } = {}) {
    const handler = routes.get(path)
    if (!handler) return { status: 404, json: null }
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }
    req.destroy = () => {}
    let out = ''
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(x) { out = String(x ?? '') } }
    setImmediate(() => { if (body !== undefined) req.emit('data', JSON.stringify(body)); req.emit('end') })
    await handler(req, res)
    return { status: res.statusCode, json: out ? JSON.parse(out) : null }
  }

  /** The model calls one of the tools the plugin registered (in a chat session of the owner's). */
  async function callTool(name, args = {}, { sessionId } = {}) {
    const def = tools.get(name)
    if (!def) throw new Error('no tool ' + name)
    const agent = sessionId ? sessions.get(sessionId)?.agent : undefined
    const value = await def.execute(args, { callId: 'call-' + (++seq), name, arguments: args, agent, signal: new AbortController().signal })
    return def.output.render(args, value).map((p) => p.text).join('')
  }

  /** The owner's own chat with her (an ordinary session, default preset): say() types a line and waits for her reply. */
  async function ownerChat(title) {
    const sid = 'session-owner-' + (++seq) + '-' + Math.random().toString(16).slice(2, 10)
    sessions.set(sid, { title, preset: 'default', workspaceId: 'ws-owner', messages: [] })
    sessions.get(sid).agent = makeAgent(sid)
    return {
      sid,
      say(text) {
        const s = sessions.get(sid)
        s.updatedAt = Date.now()
        const before = s.messages.length
        s.agent.followup({ id: 'm' + (++seq), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
        return new Promise((resolve) => { const t = setInterval(() => { if (s.messages.length >= before + 2 && s.agent.status === 'idle') { clearInterval(t); resolve(s.messages[s.messages.length - 1].text) } }, 20) })
      },
    }
  }

  return {
    ctx,
    sessions,
    fence,
    ownerChat,
    tools,
    callTool,
    http,
    async dispose() { for (const d of disposers.reverse()) await d() },
  }
}
