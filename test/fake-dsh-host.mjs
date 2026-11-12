// A small stand-in for the DSH host services the plugin touches, shaped after DSH 0.2.1-rc.5's typings
// (dsh-api-session-controller, dsh-workspace, dsh-agent-loop, dsh-system-prompt) and the session events community
// plugins read (user/message, assistant/message, turn/end). The "model" is a function the test supplies.

export function createFakeHost({ model, latencyMs = 50 } = {}) {
  const listeners = new Map()
  const disposers = []
  const variables = new Map()
  const sessions = new Map() // sid -> { title, preset, workspaceId, messages: [], agent }
  const workspaces = []
  let seq = 0

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
        emit('session/event', agent.session, { type: 'user/message', data: { message, turn: myTurn } })
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
    sessionController: {
      async create({ workspaceId, agentPreset }) {
        const sid = 'session-' + (++seq) + '-' + Math.random().toString(16).slice(2, 10)
        sessions.set(sid, { title: '', preset: agentPreset, workspaceId, messages: [] })
        sessions.get(sid).agent = makeAgent(sid)
        return { sessionId: sid, agentPreset }
      },
      async rename({ sessionId, title }) { sessions.get(sessionId).title = title; return { title, seq: 0 } },
      async resolveAgent(sid) { const s = sessions.get(sid); return s ? { agent: s.agent } : { error: { message: 'not found' } } },
      cancel({ sessionId }) { const s = sessions.get(sessionId); if (s) s.agent.cancelled = true; return { accepted: true } },
    },
  }

  return {
    ctx,
    sessions,
    async dispose() { for (const d of disposers.reverse()) await d() },
  }
}
