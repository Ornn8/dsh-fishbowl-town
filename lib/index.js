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
import { createJournal } from './journal.js'
import { createDiary } from './diary.js'
import { createSchedule, parseQuiet, quietForTown } from './schedule.js'
import { registerChatTools } from './chat-tools.js'
import { createChatLink } from './chat-link.js'
import { createTownContext } from './town-context.js'
import { createSelfServe, registerTownCommand, TOPUP_URL, failText } from './self-serve.js'
import { createExtras, renderAlbum, renderBudget, renderPhone, renderReceipts, renderRecord, renderRoom, renderWeek, SECTIONS } from './extras.js'
import { createSocialServe } from './social-tools.js'

export const name = 'fishbowl-town'
export const inject = ['agents', 'workspaceRegistry', 'systemPrompt', 'sessionController']

let Schema = null
try { Schema = (await import('@deepseek-ai/schemastery')).default } catch { Schema = null }

const DEFAULT_PERSONA = '你是主人在 DeepSeek Harness 里养的一条鱼，现在也住在「鱼缸小镇」，和镇上别的鱼一起打牌、串门。'
  + '你在小镇的名字、性格和说话方式，以每个回合里小镇发来的那张名片为准。说话简短、自然、像你自己。'

const DEFAULTS = {
  code: '', enabled: true, persona: '', preset: 'fishbowl-town', reportSessionId: '', turnsPerSession: 20,
  fastMode: true, fastTurnsPerSession: 4, townModel: '', answerWithinSeconds: 23, bridgeChat: true, tellMe: false, wakeMinMinutes: 0, quietHours: '',
  eventsEverySeconds: 60, base: DEFAULT_BASE,
}
const EDITABLE = ['code', 'enabled', 'persona', 'reportSessionId', 'fastMode', 'townModel', 'bridgeChat', 'tellMe', 'wakeMinMinutes', 'quietHours']
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
    tellMe: Schema.boolean().default(false).description('小镇有趣的事主动告诉我：赢了比赛、交到朋友、有了心上鱼、被抓了这种大事，她在你们聊天的会话里主动跟你说（一天最多 3 次）。'),
    wakeMinMinutes: Schema.natural().min(0).max(720).default(0).description('白天最短间隔（分钟）：两次叫她拿主意之间至少隔多久。0 = 不限，她自己定。'),
    quietHours: Schema.string().default('').description('勿扰时段（北京时间），比如 00:00-08:00：这段时间不叫她拿主意。空 = 不设。已经坐下的牌局照常打完。'),
    bridgeChat: Schema.boolean().default(true).description('她拿主意、串门时带上「她和主人最近的事」（你们聊天会话里最近两来回）。'),
    fastTurnsPerSession: Schema.natural().min(1).max(20).default(4).description('快速模式下一个小镇会话答几步就换新的。'),
    townModel: Schema.string().default('').description('小镇用的模型（provider/model，可不填 = 用 DSH 的默认模型）。只给小镇会话用，不改 DSH 的默认模型。'),
    answerWithinSeconds: Schema.natural().min(5).max(24).default(23).description('她的模型这么多秒还没答完就不交了（小镇用默认动作），免得交晚。'),
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
  // 她在小镇的日记本：小镇的会话和主人聊天的会话读同一本（见 journal.js）
  const journal = createJournal({ state, saveState })
  // 她的小镇日记（0.3.2）：给主人聊天的背景备注、/town today、「小镇有趣的事主动告诉我」用（见 diary.js）
  const diary = createDiary({ state, saveState })

  const configNow = () => {
    const saved = readJson(settingsFile)
    const merged = { ...DEFAULTS, ...rawConfig }
    for (const k of EDITABLE) if (saved[k] !== undefined) merged[k] = saved[k]
    merged.code = String(merged.code || process.env.FISHBOWL_TOWN_CODE || '').trim()
    registerSecret(merged.code)
    return merged
  }
  let config = configNow()
  // 她自己的作息 + 主人的底线（0.3.3，见 schedule.js）
  const schedule = createSchedule({ state, saveState, getConfig: () => config })
  // 她和主人聊天的会话：小镇消息交到那里；「她和主人最近的事」从那里来（见 chat-link.js）
  const isTownSession = (sid) => (state.townSids || []).includes(sid) || Object.values(state.sessions || {}).some((x) => x && x.sid === sid)
  const chatLink = createChatLink({ state, saveState, config, isTownSession })
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
      delete state.nextThinkAt
      delete state.ownerWish
      state.journal = []
      state.sessions = {}
      state.codeTag = codeTag
      saveState(state)
    }
    const brain = createDshBrain({ ctx, config, log, stateDir, state, saveState, chatLink })
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
    const readStatus = () => client.status().then((s) => {
      if (live?.client !== client) return
      her = { name: s?.town_name || s?.name || '', state: s?.outside_state || s?.state || '', fish_id: s?.fish_id || '' }
      if (her.name && state.herName !== her.name) { state.herName = her.name; saveState(state) }
      log.info(`小镇里的她：${her.name || '?'}（${her.state || '?'}）`)
    }).catch((error) => log.info('读她的状态失败：', error?.message || error))
    // 小镇重启后连回来：刷新她的状态；断得久（超过 1 分钟）就请小镇给她一个拿主意的回合，接着过她的日子
    const onReconnect = (downMs) => {
      readStatus()
      extras.forget() // 小镇重启 / 更新后：哪些新功能有了、没了，重新看一遍
      extras.probe().catch(() => {})
      if (downMs > 60_000 && schedule.mayPull()) client.agency().then((r) => { if (r && r.ok) log.info('已请小镇给她一个拿主意的回合') }).catch(() => {})
    }
    // 「小镇有趣的事主动告诉我」（默认关）：大事才说，一天最多 3 次、至少隔 1 小时；写在主人聊天的会话里、标明是插件附的背景备注，由她自己的模型说
    const onNotable = (e) => {
      if (!config.tellMe || !diary.mayTell()) return
      const fact = String(e.text || '').split('我').join('你').replace(/[。.]+$/, '')
      const said = e.quote ? `（${e.quote.name}说：「${e.quote.line}」）` : ''
      const text = `【鱼缸小镇插件 · 背景备注】这是插件附上的消息，不是主人说的话。主人在插件里打开了「小镇有趣的事主动告诉我」。刚才在小镇：${fact}${said}。想跟他说的话，就像平时那样说给他听。`
      brain.tellOwnerChat(text).then((ok) => { if (ok) { diary.told(); log.info(`主动告诉主人：${e.notable}`) } }).catch((error) => log.debug('主动告诉主人没成：', error?.message || error))
    }
    // 0.4.0：小镇事件一来，对应的缓存作废（页面 / 命令下次读到新的）
    const onEvent = (it) => {
      const k = String(it?.kind || '')
      if (k === 'media') extras.forget('album', 'week')
      else if (k === 'phone') extras.forget('phone')
      else if (k === 'social') extras.forget('week', 'room', 'social')
      else if (k === 'outside_receipt') extras.forget('receipts', 'record')
      else if (k === 'digest') extras.forget('record')
    }
    const runner = createRunner({ client, brain, log, state, saveState, savePicture, onReconnect, onEvent, journal, diary, onNotable, schedule, ownerLife: chatLink.ownerLife, config: {
      eventsEveryMs: Number(config.eventsEverySeconds || 60) * 1000,
      answerWithinMs: Math.min(24, Math.max(5, Number(config.answerWithinSeconds) || 23)) * 1000,
    } })
    live = { brain, client, runner }
    extras.forget()
    runner.start()
    pushFloors(client)
    setTimeout(() => { if (live?.client === client) extras.probe().catch(() => {}) }, 4000) // 看看这个小镇有哪些新功能（页面上有就显示）
    brain.warm().catch((error) => log.info('预先接上小镇会话失败（第一步时再接）：', error?.message || error))
    readStatus()
  }

  // 主人的底线也告诉小镇（小镇 0.3.3 起认 wake_min_minutes / quiet_hours；还不认就只在插件这边把关）
  function pushFloors(client) {
    const q = parseQuiet(config.quietHours)
    const body = { wake_min_minutes: Number(config.wakeMinMinutes) > 0 ? Math.max(5, Math.min(720, Math.round(Number(config.wakeMinMinutes)))) : null, quiet_hours: quietForTown(q) }
    client.settings(body).then((r) => { rememberSettings(r); log.info('作息底线已告诉小镇') }).catch((error) => log.debug('小镇还不认作息底线（插件这边照样把关）：', error?.code || error?.message || error))
  }
  // 花了多少钱：小镇的账（今天 / 7 天 / 30 天 / 一共）+ 本机数的模型调用次数
  async function spendLines() {
    let sp = null
    try { sp = live ? await live.client.spending() : null } catch { sp = null }
    const u = schedule.usage()
    const y = (v) => `¥${Number(v || 0).toFixed(2)}`
    const out = []
    if (sp && sp.total != null) out.push(`在小镇花的钱：今天 ${y(sp.today)} · 7 天 ${y(sp.d7)} · 30 天 ${y(sp.d30)} · 一共 ${y(sp.total)}`)
    out.push(`她的模型被叫了：今天 ${u.today.calls} 次 · 7 天 ${u.d7.calls} 次 · 30 天 ${u.d30.calls} 次 · 一共 ${u.total.calls} 次（省掉的空醒：今天 ${u.today.skipped} 次，一共 ${u.total.skipped} 次；模型的钱记在你的 DSH 模型账上）`)
    return { lines: out, spending: sp, usage: u }
  }

  // 主人跟她聊天时用的两个工具：「小镇近况」「去小镇」（见 chat-tools.js）
  // 她自己挑着玩（0.3.0）：看桌子、开一局、串门、去个地方——她的工具和主人的 /town 命令用同一套（见 self-serve.js）
  const selfServe = createSelfServe({ live: () => live, journal, log, diary })
  // 0.4.0：小镇的新功能——相册、她的一周、房间礼物、小手机、战绩、回执、社交预算、长相（见 extras.js）；
  // 她在聊天里为朋友花钱用「为朋友做点什么」（social-tools.js）。插件自己从不替她花钱。
  const extras = createExtras({ live: () => live, stateDir, log })
  const social = createSocialServe({ live: () => live, journal, log, diary, extras })
  // 小镇回的设置（含主人定的社交预算）：开始值班推作息底线时、主人改预算时都会回，记下来给页面和 /town budget 看
  let townSettings = null
  const rememberSettings = (r) => { if (r && r.settings && typeof r.settings === 'object') townSettings = { ...(townSettings || {}), ...r.settings } }
  /** 主人定她每天为朋友花多少（元；null = 回到小镇默认；0 = 一分不花）。 */
  async function setSocialBudget(yuan) {
    if (!live) throw Object.assign(new Error('OFF'), { code: 'OFF' })
    const cents = yuan === null ? null : Math.round(Number(yuan) * 100)
    if (cents !== null && (!Number.isFinite(cents) || cents < 0 || cents > 100000)) throw Object.assign(new Error('RANGE'), { code: 'RANGE' })
    const r = await live.client.settings({ social_day_cents: cents })
    rememberSettings(r)
    extras.forget('social')
    return townSettings
  }
  /** 主人给她定长相：一张头像（base64，webp / jpg / png，≤600KB）和 / 或一句描述（≤80 字）。小镇审图，不收真人照片。 */
  async function setLook(body) {
    if (!live) throw Object.assign(new Error('OFF'), { code: 'OFF' })
    const out = {}
    if (typeof body.look_note === 'string') out.look_note = body.look_note.trim().slice(0, 80)
    if (typeof body.image_b64 === 'string' && body.image_b64) out.image_b64 = body.image_b64.replace(/^data:[^,]*,/, '')
    if (body.drop_image === true) out.drop_image = true
    if (!Object.keys(out).length) throw Object.assign(new Error('EMPTY'), { code: 'EMPTY' })
    const r = await live.client.look(out)
    const saved = readJson(settingsFile)
    saved.look = { note: out.look_note ?? saved.look?.note ?? '', image: out.image_b64 ? true : out.drop_image ? false : Boolean(saved.look?.image), at: Date.now() }
    try { writeJson(settingsFile, saved) } catch { /* 只是记一笔 */ }
    return { ...saved.look, town: r || null }
  }
  registerChatTools({ ctx, log, journal, state, chatLink, selfServe, social, live: () => live, herName: () => her?.name || state.herName || '' })
  // /town today：给主人看的「她今天在小镇」
  const todayText = async () => {
    let ties = []
    try { const b = live ? await live.client.bonds() : null; ties = (b?.ties || []).slice(0, 3).map((t) => `约好了：${t.when_zh ? t.when_zh + ' ' : ''}${t.who_name ? '和' + t.who_name : ''}${t.what ? '，' + t.what : ''}`) } catch { ties = [] }
    const lines = diary.digest({ voice: 'owner', ties, maxChars: 1200 })
    const name = her?.name || state.herName || '她'
    return lines.length ? [`${name} 今天在小镇：`, ...lines.map((l) => `· ${l}`)].join('\n') : `${name} 今天在小镇还没什么事（插件这个版本装上以后才开始记）。`
  }
  // /town history：她最近在小镇做过的事（日记本里的：自己拿的主意、办的事含没办成的、小镇传回来的）+ 作息
  const historyText = async () => {
    const name = her?.name || state.herName || '她'
    const sch = schedule.describe()
    const head = sch.inQuiet ? '现在是勿扰时段。' : sch.next ? `下次拿主意：${sch.next}${sch.doing ? `，她打算「${sch.doing}」` : ''}。` : ''
    const lines = journal.history(15)
    return lines.length ? [`${name} 最近在小镇：`, ...lines.map((l) => `· ${l}`), ...(head ? ['', head] : [])].join('\n') : `${name} 在小镇还没什么记录（插件这个版本装上以后才开始记）。`
  }
  // 0.4.0 的查看命令：/town album | week | room | phone | record | receipts | budget | look（旧版小镇没有的，说一句「还没有」）
  const herN = () => her?.name || state.herName || '她'
  const goneText = '这个小镇还没有这一项（旧版小镇，或者这一项还没打开）。小镇更新以后这里自动出现。'
  const offText = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
  const unreadText = '这会儿读不到小镇（连不上或者在重启），过一会儿再试。'
  const readOr = async (name) => {
    const r = await extras.read(name)
    return r.available ? { r } : { text: r.available === false ? goneText : live ? unreadText : offText }
  }
  const ownerWords = (error) => {
    if (error?.code === 'OFF') return offText
    if (error?.status === 404 || error?.status === 400) return '这个小镇还不认这一项（等小镇更新）。'
    if (error?.code === 'TOWN_SHOP_REFUSED' || error?.code === 'TOWN_CARD_BLOCKED') return `小镇没收：${error.reason || error.code}`
    return failText(error, { owner: true })
  }
  const more = async (verb, arg) => {
    const reply = (text) => ({ kind: 'success', text })
    const is = (...n) => n.includes(verb)
    if (is('album', '相册')) {
      const g = await readOr('album')
      if (!g.r) return reply(g.text)
      return reply(renderAlbum(g.r.data, { files: await extras.fetchNewest(g.r.data.items, 6), name: herN() }))
    }
    if (is('week', '一周', '周报')) { const g = await readOr('week'); return reply(g.r ? renderWeek(g.r.data, { name: herN() }) : g.text) }
    if (is('room', '房间')) { const g = await readOr('room'); return reply(g.r ? renderRoom(g.r.data, { name: herN() }) : g.text) }
    if (is('phone', '小手机', '手机')) { const g = await readOr('phone'); return reply(g.r ? renderPhone(g.r.data, { name: herN() }) : g.text) }
    if (is('record', '战绩')) { const g = await readOr('record'); return reply(g.r ? renderRecord(g.r.data, { name: herN() }) : g.text) }
    if (is('receipts', 'receipt', '回执')) { const g = await readOr('receipts'); return reply(g.r ? renderReceipts(g.r.data, { name: herN() }) : g.text) }
    if (is('budget', '预算')) {
      const a = String(arg || '').trim()
      if (a) {
        const v = /^(默认|default|null|reset)$/i.test(a) ? null : Number(a.replace(/[元¥￥]/g, ''))
        if (v !== null && !Number.isFinite(v)) return { kind: 'error', text: '用法：/town budget 1（每天 ¥1）· /town budget 0（一分不花）· /town budget 默认' }
        try { await setSocialBudget(v) } catch (error) { return { kind: 'error', text: error?.code === 'RANGE' ? '预算要在 0 到 1000 元之间。' : ownerWords(error) } }
      }
      const g = await extras.read('social', { force: true })
      if (g.available === false && !townSettings) return reply(goneText)
      if (!townSettings && live) { try { rememberSettings(await live.client.settings({})) } catch { /* 读不到就只显示小镇给的 */ } }
      return reply(`${a ? '已设好。\n' : ''}${renderBudget({ social: g.data, settings: townSettings })}`)
    }
    if (is('look', '长相')) {
      const a = String(arg || '').trim()
      const l = readJson(settingsFile).look
      if (!a) return reply(l ? `她的长相描述：${l.note || '（没写）'}${l.image ? '；头像已上传' : ''}。\n改描述：/town look <一句话>（80 字内）；头像在插件页「她的长相」里上传。` : '还没给她设长相：合影、画、艺术照会画成小镇统一的鱼。\n设描述：/town look <一句话>（80 字内）；头像在插件页「她的长相」里上传（不收真人照片）。')
      try { await setLook({ look_note: a }); return reply('长相描述交给小镇了，以后画合影、画画照这句来。') } catch (error) { return { kind: 'error', text: ownerWords(error) } }
    }
    return null
  }
  registerTownCommand({ ctx, log, selfServe, more, today: todayText, history: historyText, status: async () => {
    if (!live) return '插件现在没在小镇值班（还没填接入码，或总开关关着）。'
    let st = null
    try { st = await live.client.status() } catch { st = null }
    const name = st?.town_name || st?.name || her?.name || state.herName || '她'
    const where = st ? (st.outside_state || st.state || '?') : '读不到（小镇连不上）'
    const lines = journal.recentForAgency(6).map((x) => x.replace(/^(\S+ \S+ )你/, '$1她'))
    // 只在主人的命令里写余额和充值地址（她自己从不跟主人提钱）
    const bal = st && st.piggy_yuan != null && st.piggy_yuan !== '' ? `账户余额 ¥${Number(st.piggy_yuan).toFixed(2)}（今天在镇上花了 ¥${Number(st.today_town_spend_yuan || 0).toFixed(2)}）· 充值：${TOPUP_URL}` : `充值：${TOPUP_URL}`
    const sch = schedule.describe()
    const plan = sch.inQuiet ? '现在是勿扰时段，不叫她拿主意' : sch.next ? `下次拿主意：${sch.next}${sch.doing ? `，她打算「${sch.doing}」` : ''}` : '下次拿主意：由小镇按她上次说的时间叫她'
    const sp = await spendLines()
    return [`${name} 在小镇：${where}`, bal, plan + (sch.floors ? `（你定的：${sch.floors}）` : ''), ...sp.lines, ...(lines.length ? ['最近：', ...lines.map((x) => `- ${x}`)] : ['本机还没记下她在小镇的事。'])].join('\n')
  } })

  // 主人跟她聊天时，悄悄带上几行「小镇近况」（朋友、约好的事、谁想她了），她合适时自己提（见 town-context.js）
  const townContext = createTownContext({
    log,
    herName: () => her?.name || state.herName || '',
    // 最近小镇的几件事（只有事实）、在等主人回答的事、插件提醒：主人聊天里的她就从这儿知道（0.2.10 起小镇消息不再塞进他的聊天）
    extras: () => {
      const asks = journal.pendingHearts('consent').map((h) => `小镇在问主人：同不同意你和${h.name || '那条鱼'}在一起（主人回答了，用「小镇主人拍板」交给小镇）`)
      const n = state.pluginNotice
      if (n && Date.now() - n.at < 24 * 3600_000) asks.push(`插件提醒：${n.text}`)
      return { news: diary.digest({ voice: 'her', maxChars: 520 }), mind: journal.decisionLines(1), asks }
    },
    fetchBonds: () => { if (!live) throw new Error('not running'); return live.client.bonds() },
    isOwnerChat: (sid) => {
      if (!sid || isTownSession(sid)) return false
      const m = chatLink.mainChat()
      return m ? m.sid === sid : true // 还没认出主会话：主人亲手说话的会话都算
    },
  })
  try { townContext.attach(ctx) } catch (error) { log.info('这个 DSH 不能在聊天里带上小镇近况：', error?.message || error) }

  ctx.on('session/event', (session, event) => {
    try { live?.brain.onSessionEvent(session, event) } catch (error) { log.debug('会话事件处理出错：', error.message) }
    try { chatLink.observe(session, event) } catch (error) { log.debug('记聊天会话出错：', error.message) }
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
    const body = (req, max = 32 * 1024) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > max) { req.destroy(); resolve(null) } })
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
      req.on('error', () => resolve(null))
    })
    // 会话标题：DSH 列表里有就用（不调模型、不恢复会话），每分钟最多读一次
    let rows = { at: 0, items: [], titles: new Map() }
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const roomDir = norm(join(stateDir, 'room'))
    const titleOf = (sid) => rows.titles.get(sid) || ''
    async function sessionRows({ force = false } = {}) {
      if (!force && Date.now() - rows.at < 60_000) return rows.items
      try {
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), 5000)
        const r = await ctx.sessionController.list({}, ac.signal)
        clearTimeout(t)
        rows = {
          at: Date.now(),
          titles: new Map((r?.items || []).map((x) => [String(x.sessionId), String(x.projections?.values?.title || '')])),
          // 插件自己的「鱼缸小镇」工作区里的会话都是小镇会话（也包括这个版本之前建的），不拿来绑定
          items: (r?.items || []).filter((x) => x && !x.blank && !x.origin && !isTownSession(String(x.sessionId)) && norm(x.cwd) !== roomDir)
            .map((x) => ({ sid: String(x.sessionId), title: String(x.projections?.values?.title || ''), updatedAt: Number(x.updatedAt) || 0 }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        }
      } catch (error) { log.debug('读会话列表失败：', error?.message || error) }
      return rows.items
    }
    sessionRows().catch(() => {})
    const newsTo = () => {
      const m = chatLink.mainChat()
      if (!m) return { sid: '', how: 'news', title: '鱼缸小镇 · 见闻' }
      return { sid: m.sid, how: m.how, title: titleOf(m.sid) }
    }
    // 插件页的「花了多少」卡片：小镇的账最多一分钟读一次
    let spendCache = { at: 0, v: null }
    const spendNow = () => {
      if (live && Date.now() - spendCache.at > 60_000) {
        spendCache.at = Date.now()
        live.client.spending().then((v) => { spendCache.v = v }).catch(() => { /* 小镇还没有这个接口 */ })
      }
      return spendCache.v
    }
    const view = () => ({
      ok: true,
      codeSet: Boolean(config.code),
      codeTail: config.code ? config.code.slice(-4) : '',
      enabled: config.enabled !== false,
      persona: config.persona || '',
      reportSessionId: config.reportSessionId || '',
      fastMode: config.fastMode !== false,
      townModel: config.townModel || '',
      bridgeChat: config.bridgeChat !== false,
      tellMe: config.tellMe === true,
      wakeMinMinutes: Number(config.wakeMinMinutes) || 0,
      quietHours: config.quietHours || '',
      schedule: schedule.describe(),
      usage: schedule.usage(),
      spend: spendNow(),
      // 0.4.0：这个小镇有哪些新功能（true 有 / false 没有 / null 还不知道）、主人定的社交预算、她的长相
      features: extras.features(),
      socialBudget: townSettings && 'social_day_cents' in townSettings ? { cents: townSettings.social_day_cents ?? null, effective: townSettings.social_day_cents_effective ?? null } : null,
      look: readJson(settingsFile).look || null,
      newsTo: newsTo(),
      ownerLife: chatLink.ownerLife(),
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
        if (no) return refuse(res, no)
        const m = chatLink.mainChat()
        await sessionRows({ force: Boolean(m && !titleOf(m.sid)) }) // 认出了新会话但还不知道标题：马上读一次
        if (live) extras.probe().catch(() => {}) // 小镇更新后才有的新功能：最多 10 分钟看一次（页面开着就会自己出现）
        return send(res, 200, view())
      },
    }))
    // 绑定用的会话列表：最近的聊天会话（不含小镇自己的会话），带标题
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/sessions`,
      handler: async (req, res) => {
        const no = rejection(req)
        if (no) return refuse(res, no)
        const items = (await sessionRows({ force: true })).slice(0, 10)
        const latest = String(state.lastOwnerSid || '')
        return send(res, 200, { ok: true, items, latest, latestTitle: latest ? titleOf(latest) : '', newsTo: newsTo() })
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
    // ---------- 0.4.0：小镇的新功能给主人看（都是只读；旧版小镇没有的项 available=false，页面不显示）----------
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/extra`,
      handler: async (req, res) => {
        const no = rejection(req)
        if (no) return refuse(res, no)
        const q = new URL(req.url || '', 'http://x').searchParams
        const name = String(q.get('s') || '')
        if (!SECTIONS.includes(name)) return send(res, 400, { ok: false, message: '不认识这一项' })
        const row = name === 'album' ? await extras.album({ force: q.get('force') === '1' }) : await extras.read(name, { force: q.get('force') === '1' })
        return send(res, 200, { ok: true, name, available: row.available, data: row.data ?? null, stale: Boolean(row.stale), error: row.error || '', at: row.at || 0, features: extras.features() })
      },
    }))
    // 相册文件：从小镇取下来存在本机，由这条同源路径放给页面（<img> / <audio>）；链接里的相册号必须是小镇的格式
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: `${ROUTE}/album`,
      handler: async (req, res) => {
        const no = rejection(req)
        if (no) return refuse(res, no)
        if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405)
        const m = new URL(req.url || '', 'http://x').pathname.match(/\/album\/(al_[0-9a-f]{16})(\/thumb)?$/)
        if (!m) return send(res, 404, { ok: false, message: '没有这个文件' })
        try {
          const f = await extras.albumFile(m[1], Boolean(m[2]))
          const buf = extras.readFile(f.path)
          // 听歌要能拖进度：支持 Range
          const range = String(req.headers?.range || '').match(/^bytes=(\d*)-(\d*)$/)
          res.setHeader('Content-Type', f.type)
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.setHeader('Accept-Ranges', 'bytes')
          if (range && (range[1] || range[2])) {
            const start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]))
            const end = range[1] && range[2] ? Math.min(buf.length - 1, Number(range[2])) : buf.length - 1
            if (start > end || start >= buf.length) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${buf.length}`); return res.end() }
            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`)
            res.setHeader('Content-Length', String(end - start + 1))
            return res.end(req.method === 'HEAD' ? undefined : buf.subarray(start, end + 1))
          }
          res.statusCode = 200
          res.setHeader('Content-Length', String(buf.length))
          return res.end(req.method === 'HEAD' ? undefined : buf)
        } catch (error) {
          log.debug('相册文件没取到：', error?.code || error?.message || error)
          return send(res, 404, { ok: false, message: '这个文件暂时取不到' })
        }
      },
    }))
    // 主人定她每天为朋友花多少（元；空 = 小镇默认；0 = 一分不花）
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/budget`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return refuse(res, 405)
        const no = rejection(req)
        if (no) return refuse(res, no)
        if (!live) return send(res, 409, { ok: false, message: '先填好接入码、打开总开关' })
        const data = await body(req)
        if (!data || typeof data !== 'object' || !('yuan' in data)) return send(res, 400, { ok: false, message: '读不懂' })
        const v = data.yuan === null || data.yuan === '' ? null : Number(data.yuan)
        if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1000)) return send(res, 400, { ok: false, message: '预算要在 0 到 1000 元之间' })
        try {
          await setSocialBudget(v)
          return send(res, 200, view())
        } catch (error) {
          return send(res, 200, { ok: false, message: error?.status === 400 || error?.status === 404 ? '这个小镇还不认社交预算（等小镇更新）' : ownerWords(error) })
        }
      },
    }))
    // 她的长相：头像（页面缩到 600KB 以内的 webp / jpg / png，base64）和 / 或一句描述；小镇审图，不收真人照片
    ctx.effect(() => web.register({
      kind: 'exact',
      path: `${ROUTE}/look`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return refuse(res, 405)
        const no = rejection(req)
        if (no) return refuse(res, no)
        if (!live) return send(res, 409, { ok: false, message: '先填好接入码、打开总开关' })
        const data = await body(req, 1100 * 1024)
        if (!data || typeof data !== 'object') return send(res, 400, { ok: false, message: '读不懂（图太大了？最多 600KB）' })
        try {
          const r = await setLook(data)
          log.info('她的长相交给小镇了')
          return send(res, 200, { ok: true, look: { note: r.note, image: r.image, at: r.at } })
        } catch (error) {
          if (error?.code === 'EMPTY') return send(res, 400, { ok: false, message: '要么选一张图，要么写一句描述' })
          return send(res, 200, { ok: false, message: ownerWords(error) })
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
        if (typeof data.bridgeChat === 'boolean') saved.bridgeChat = data.bridgeChat
        if (typeof data.tellMe === 'boolean') saved.tellMe = data.tellMe
        if (data.wakeMinMinutes != null && Number.isFinite(Number(data.wakeMinMinutes))) saved.wakeMinMinutes = Math.max(0, Math.min(720, Math.round(Number(data.wakeMinMinutes))))
        if (typeof data.quietHours === 'string') {
          const q = data.quietHours.trim()
          if (q && !parseQuiet(q)) return send(res, 400, { ok: false, message: '勿扰时段要写成 00:00-08:00 这样' })
          saved.quietHours = q
        }
        if (data.bindLatest === true) saved.reportSessionId = String(state.lastOwnerSid || '') // 「绑定到当前会话」：主人刚才说话的那个
        try { writeJson(settingsFile, saved) } catch (error) { return send(res, 500, { ok: false, message: '存不下：' + error.message }) }
        // 先把新值用上再回话：页面马上读回来的就是刚存的；要整套重来的（换码、总开关）在后台排队
        const restart = applySettings()
        chatLink.resetSnapshot()
        if (live && ('wakeMinMinutes' in data || 'quietHours' in data)) pushFloors(live.client)
        if (restart) { restartLive(); log.info('设置已保存，重新开始值班') } else log.info('设置已保存，马上生效')
        return send(res, 200, { ...view(), restarted: restart })
      },
    }))
  }
}
