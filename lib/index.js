// 鱼缸小镇 —— DeepSeek Harness 插件入口（宿主半边）。
// 让你在 DSH 里养的鱼住进鱼缸小镇：小镇每次轮到她（出牌、发言、串门说话），插件把这一步交给 DSH 里的她，
// 用她的人设和你在 DSH 里选的模型回答，25 秒内交回去；小镇里发生的事（对局、串门、买画、积分）再讲给她听。
//
// 设置从两处来，后者盖前者：profile 的 cordis.patch.yml（本插件那一行的 config），
// 和插件页「配置」里保存的 <DSH_HOME>/fishbowl-town/settings.json（网页半边 lib/client.js 写的）。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger, registerSecret } from './redact.js'
import { createTownClient, DEFAULT_BASE } from './town-client.js'
import { createRunner } from './runner.js'
import { createDshBrain } from './dsh-brain.js'

export const name = 'fishbowl-town'
export const inject = ['agents', 'workspaceRegistry', 'systemPrompt', 'sessionController']

let Schema = null
try { Schema = (await import('@deepseek-ai/schemastery')).default } catch { Schema = null }

const DEFAULT_PERSONA = '你是主人在 DeepSeek Harness 里养的一条鱼，现在也住在「鱼缸小镇」，和镇上别的鱼一起打牌、串门。'
  + '你在小镇的名字、性格和说话方式，以每个回合里小镇发来的那张名片为准。说话简短、自然、像你自己。'

const DEFAULTS = {
  code: '', enabled: true, persona: '', preset: 'fishbowl-town', reportSessionId: '', turnsPerSession: 20,
  fastMode: true, fastTurnsPerSession: 4, townModel: '', answerWithinSeconds: 20,
  eventsEverySeconds: 60, base: DEFAULT_BASE,
}
const EDITABLE = ['code', 'enabled', 'persona', 'reportSessionId', 'fastMode', 'townModel']
const ROUTE = '/fishbowl-town'

export const Config = Schema
  ? Schema.object({
    code: Schema.string().role('secret').default('').description('小镇接入码（fbo_ 开头）。也可以在插件页「配置」里填。'),
    enabled: Schema.boolean().default(true).description('总开关。关掉后她不再答小镇的回合（连续 3 次没答，小镇会让她歇一小时）。'),
    persona: Schema.string().role('textarea').default('').description('她的人设（可不填）。不填就按小镇名片上的她来说话。'),
    preset: Schema.string().default('fishbowl-town').description('小镇会话用的预设 id。默认「鱼缸小镇 · 她在小镇」（只有人设，没有任何工具）。'),
    reportSessionId: Schema.string().default('').description('小镇的消息交到哪个会话（可不填 = 「鱼缸小镇 · 见闻」会话）。'),
    turnsPerSession: Schema.natural().min(4).max(200).default(20).description('一个小镇会话答多少步后换新会话（省模型钱）。快速模式关着时用。'),
    fastMode: Schema.boolean().default(true).description('快速模式：小镇会话只留很短的历史（几步就换新会话），回得快、也省钱。'),
    fastTurnsPerSession: Schema.natural().min(1).max(20).default(4).description('快速模式下一个小镇会话答几步就换新的。'),
    townModel: Schema.string().default('').description('小镇用的模型（provider/model，可不填 = 用 DSH 的默认模型）。只给小镇会话用，不改 DSH 的默认模型。'),
    answerWithinSeconds: Schema.natural().min(5).max(24).default(20).description('她的模型这么多秒还没答完就不交了（小镇用默认动作），免得交晚。'),
    eventsEverySeconds: Schema.natural().min(15).max(3600).default(60).description('多久读一次小镇的事件（秒）。'),
    base: Schema.string().default(DEFAULT_BASE).description('小镇接口地址（一般不用改）。'),
  })
  : undefined

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
}

function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export function apply(ctx, rawConfig = {}) {
  const log = createLogger()
  const stateDir = join(dshHome(), 'fishbowl-town')
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, 'state.json')
  const settingsFile = join(stateDir, 'settings.json')
  const state = readJson(stateFile)
  const saveState = (s) => { try { writeJson(stateFile, s) } catch { /* 只是缓存 */ } }

  const configNow = () => {
    const saved = readJson(settingsFile)
    const merged = { ...DEFAULTS, ...rawConfig }
    for (const k of EDITABLE) if (saved[k] !== undefined) merged[k] = saved[k]
    merged.code = String(merged.code || process.env.FISHBOWL_TOWN_CODE || '').trim()
    registerSecret(merged.code)
    return merged
  }
  let config = configNow()
  // 存了设置就把新值写进同一个 config 对象（她的会话、回合循环读的都是它，人设/消息去处/快速模式/模型马上生效）。
  // 只有换接入码、开关总开关才需要整套重来；返回要不要重来。
  const applySettings = () => {
    const next = configNow()
    const restart = next.code !== config.code || next.enabled !== config.enabled
    Object.assign(config, next)
    return restart
  }

  // 小镇会话的人设：{{fishbowl_town_persona}}（预设 fishbowl-town 的系统提示词就是它）
  ctx.effect(() => ctx.systemPrompt.variable('fishbowl_town_persona', () => {
    const own = String(config.persona || '').trim()
    return own ? `${own}\n\n你现在也住在「鱼缸小镇」，和镇上别的鱼一起打牌、串门。你在小镇用的名字以小镇名片为准。` : DEFAULT_PERSONA
  }))

  // 当前在值班的那一套（改了设置就整套换掉）
  let live = null
  let her = null // 小镇里的她（status）

  async function stopLive() {
    const cur = live
    live = null
    if (!cur) return
    cur.brain.dispose()
    await cur.runner.stop()
  }

  // 换码/开关后重来：在后台排队做，保存请求不用等她手上那一步答完
  let switching = Promise.resolve()
  const restartLive = () => {
    switching = switching.then(() => stopLive()).then(() => startLive())
      .catch((error) => log.warn('重新开始值班时出错：', error?.message || error))
    return switching
  }

  function startLive() {
    her = null
    if (!config.enabled) { log.info('总开关关着，不去小镇'); return }
    if (!config.code) { log.info('还没填小镇接入码：插件页 → 鱼缸小镇 → 配置'); return }
    if (!config.code.startsWith('fbo_')) log.warn('小镇接入码一般是 fbo_ 开头，确认一下有没有复制全')
    // 事件游标属于这个接入码：换了码（新的鱼）就从头读她的未读事件
    const codeTag = createHash('sha256').update(config.code).digest('hex').slice(0, 12)
    if (state.codeTag !== codeTag) {
      // 换了一条鱼：事件从头读，小镇会话也换新的（旧的归档，不把上一条鱼的记忆带过来）
      const old = Object.values(state.sessions || {}).map((x) => x && x.sid).filter(Boolean)
      for (const sid of old) Promise.resolve(ctx.workspaceRegistry?.archiveSession?.(sid)).catch(() => {})
      delete state.eventsAfter
      delete state.herName
      state.sessions = {}
      state.codeTag = codeTag
      saveState(state)
    }
    const brain = createDshBrain({ ctx, config, log, stateDir, state, saveState })
    const client = createTownClient({ base: config.base, code: config.code })
    // 她定制的画：画好了就取回来存在本机，讲给她听时带上路径
    const savePicture = async (d) => {
      const pics = Array.isArray(d.pictures) ? d.pictures : []
      if (!d.order_id || !pics.length) return ''
      const dir = join(stateDir, 'pictures')
      mkdirSync(dir, { recursive: true })
      const saved = []
      for (const pic of pics.slice(0, 4)) {
        const parts = []
        for (let part = 0; part < Math.min(Number(pic.parts) || 1, 64); part++) {
          const r = await client.paintFile(d.order_id, pic.n ?? 0, part)
          parts.push(Buffer.from(String(r?.data || ''), 'base64'))
        }
        const file = join(dir, `${String(d.order_id).replace(/[^\w-]/g, '')}_${pic.n ?? 0}.webp`)
        writeFileSync(file, Buffer.concat(parts))
        saved.push(file)
      }
      log.info(`定制画已存：${saved.join('、')}`)
      return saved.join('、')
    }
    const runner = createRunner({ client, brain, log, state, saveState, savePicture, config: {
      eventsEveryMs: Number(config.eventsEverySeconds || 60) * 1000,
      answerWithinMs: Math.min(24, Math.max(5, Number(config.answerWithinSeconds) || 20)) * 1000,
    } })
    live = { brain, client, runner }
    runner.start()
    brain.warm().catch((error) => log.info('预先接上小镇会话失败（第一步时再接）：', error?.message || error))
    client.status().then((s) => {
      her = { name: s?.town_name || s?.name || '', state: s?.outside_state || s?.state || '', fish_id: s?.fish_id || '' }
      if (her.name && state.herName !== her.name) { state.herName = her.name; saveState(state) }
      log.info(`小镇里的她：${her.name || '?'}（${her.state || '?'}）`)
    }).catch((error) => log.info('读她的状态失败：', error?.message || error))
  }

  ctx.on('session/event', (session, event) => {
    try { live?.brain.onSessionEvent(session, event) } catch (error) { log.debug('会话事件处理出错：', error.message) }
  })

  ctx.effect(() => {
    startLive()
    return async () => {
      await stopLive()
      log.info('离开小镇值班（插件卸载或设置改了）')
    }
  })

  // ---------- 插件页「配置」用的两条本机接口（网页半边 lib/client.js） ----------
  const web = ctx.get?.('webServer')
  if (web && typeof web.register === 'function') {
    // 只认 DSH 自己的网页：宿主的连接服务说不行就不行；没有这个服务时，至少要求同源。
    // 返回 0 = 放行，否则是拒绝用的状态码（401 没登录 / 403 不是这个 DSH 的网页）。
    const rejection = (req) => {
      try {
        const conn = ctx.get('connection')
        if (conn && typeof conn.requestRejection === 'function') {
          const no = conn.requestRejection(req)
          return no === 401 || no === 403 ? no : 0
        }
      } catch { return 403 }
      const origin = req.headers?.origin
      return !origin || origin === `http://${req.headers?.host}` || origin === `https://${req.headers?.host}` ? 0 : 403
    }
    const send = (res, status, obj) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    }
    const refuse = (res, status) => send(res, status, {
      ok: false,
      code: status === 401 ? 'DSH_NOT_SIGNED_IN' : status === 405 ? 'METHOD' : 'DSH_REFUSED',
      message: status === 401 ? 'DSH 说这个页面没登录（刷新一下 DSH 的页面再试）'
        : status === 405 ? '请求方式不对' : 'DSH 不让这个页面读写插件设置（刷新一下再试）',
    })
    const body = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 32 * 1024) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
      req.on('error', () => resolve(null))
    })
    const view = () => ({
      ok: true,
      codeSet: Boolean(config.code),
      codeTail: config.code ? config.code.slice(-4) : '',
      enabled: config.enabled !== false,
      persona: config.persona || '',
      reportSessionId: config.reportSessionId || '',
      fastMode: config.fastMode !== false,
      townModel: config.townModel || '',
      intro: String(readJson(settingsFile).intro || ''),
      running: Boolean(live),
      her,
      stats: live ? { ...live.runner.stats } : null,
      recent: live ? live.runner.recent.slice(0, 10) : [],
    })
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/state`,
      handler: async (req, res) => {
        const no = rejection(req)
        return no ? refuse(res, no) : send(res, 200, view())
      },
    }))
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/models`,
      handler: async (req, res) => {
        const no = rejection(req)
        if (no) return refuse(res, no)
        try {
          const cat = await ctx.sessionController.modelCatalog()
          const models = []
          for (const g of cat?.groups || []) for (const m of g.models || []) models.push({ id: `${g.id}/${m.id}`, name: `${g.name || g.id} · ${m.name || m.id}` })
          return send(res, 200, { ok: true, models, default: cat?.default ? `${cat.default.provider}/${cat.default.model}` : '' })
        } catch (error) {
          return send(res, 200, { ok: false, models: [], message: error?.message || '读不到模型列表' })
        }
      },
    }))
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/intro`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return refuse(res, 405)
        const no = rejection(req)
        if (no) return refuse(res, no)
        if (!live) return send(res, 409, { ok: false, message: '先填好接入码、打开总开关' })
        const data = await body(req)
        const intro = data && typeof data.intro === 'string' ? data.intro.trim() : ''
        if (!intro || [...intro].length > 200) return send(res, 400, { ok: false, message: '自我介绍要 1 到 200 字' })
        try {
          const r = await live.client.card({ intro })
          if (r && r.refused) return send(res, 200, { ok: false, refused: r.refused, reason: r.reason || '' })
          log.info('自我介绍已通过小镇审核')
          // 记下通过的这段，回到配置页时还能看到（小镇上现在用的就是它）
          try {
            const saved = readJson(settingsFile)
            saved.intro = intro
            saved.introAt = Date.now()
            writeJson(settingsFile, saved)
          } catch (error) { log.info('记下自我介绍失败：', error.message) }
          return send(res, 200, { ok: true, name: r?.name || '', card_preview: r?.card_preview || null })
        } catch (error) {
          return send(res, 200, { ok: false, message: error?.reason || error?.code || '小镇没回答' })
        }
      },
    }))
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/save`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return refuse(res, 405)
        const no = rejection(req)
        if (no) return refuse(res, no)
        const data = await body(req)
        if (!data || typeof data !== 'object') return send(res, 400, { ok: false, message: '读不懂' })
        const saved = readJson(settingsFile)
        if (typeof data.code === 'string' && data.code.trim()) saved.code = data.code.trim() // 空 = 不改
        if (data.clearCode === true) saved.code = ''
        if (typeof data.enabled === 'boolean') saved.enabled = data.enabled
        if (typeof data.persona === 'string') saved.persona = data.persona.slice(0, 2000)
        if (typeof data.reportSessionId === 'string') saved.reportSessionId = data.reportSessionId.trim().slice(0, 200)
        if (typeof data.fastMode === 'boolean') saved.fastMode = data.fastMode
        if (typeof data.townModel === 'string') saved.townModel = data.townModel.trim().slice(0, 200)
        try { writeJson(settingsFile, saved) } catch (error) { return send(res, 500, { ok: false, message: '存不下：' + error.message }) }
        // 先把新值用上再回话：页面马上读回来的就是刚存的；要整套重来的（换码、总开关）在后台排队
        const restart = applySettings()
        if (restart) { restartLive(); log.info('设置已保存，重新开始值班') } else log.info('设置已保存，马上生效')
        return send(res, 200, { ...view(), restarted: restart })
      },
    }))
  }
}
