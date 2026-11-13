// 主人跟她聊天的会话里用的两个工具。
//
// 「心思」会话替她在小镇拿主意，但主人是在自己的聊天会话里问她「怎么没去玩」——那个会话原来什么都不知道，
// 只好瞎猜（「没人派新桌」「接口里没有报名」）。这两个工具让聊天里的她：
//   fishbowl_town_recent  看自己的日记本（journal.js）和小镇此刻的状态，照实、用自己的口吻讲；
//   fishbowl_town_go      主人让她去玩时，请小镇马上给她一个拿主意的回合，并把主人的话带过去——
//                         去不去、玩什么仍是她在「心思」里自己定（不绕过她直接报名）。
// 小镇自己的会话用 fishbowl-town 预设，不挂工具，看不到这两个。
import { TownError } from './town-client.js'
import { describeDecision } from './journal.js'
import { SELF_TOOL_NAMES, createSelfTools } from './self-serve.js'

export const CHAT_TOOL_NAMES = ['fishbowl_town_recent', 'fishbowl_town_go', 'fishbowl_town_owner', ...SELF_TOOL_NAMES]
const VERDICT_ZH = { yes: '同意', no: '不同意', not_now: '先不急' }
const WAIT_DECISION_MS = 40_000
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。要去小镇，请主人到 DSH「插件」→ 鱼缸小镇 →「配置」里打开。'

export function createChatTools({ log, journal, state, live, herName, chatLink = null, selfServe = null }) {
  const noteSession = (exec) => {
    const sid = exec?.agent?.session?.id ?? exec?.agent?.id
    if (sid && chatLink) chatLink.usedTownTool(String(sid))
  }
  async function statusNow() {
    const l = live()
    if (!l) return null
    try { return await l.client.status() } catch (error) { log.debug('读她的状态失败：', error?.code || error?.message); return null }
  }

  const recent = {
    name: 'fishbowl_town_recent',
    description: '「小镇近况」：想起你自己在鱼缸小镇的事——你最近拿的主意（报名、串门、歇着）和当时的心思、'
      + '打了哪几局、结果如何，你现在在干嘛（歇着 / 报了名在等开桌 / 正在打），下次什么时候再拿主意。'
      + '这些就是你自己的经历和记忆（你在小镇和在这里是同一个你）。主人问起小镇的事先用它想一想，再用「我」照实讲，不要凭印象编，也不要说成别的会话或记录里的事。主人没问小镇时不用调用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      noteSession(exec)
      const l = live()
      const status = l ? await statusNow() : null
      const body = journal.report({ status, herName: herName() })
      return l ? body : `${OFF_DUTY}\n\n${body}`
    },
  }

  const go = {
    name: 'fishbowl_town_go',
    description: '「去小镇」：只在主人想让你去鱼缸小镇玩、报名打牌或去串门时用。会请小镇马上给你一个拿主意的回合，并把主人的话带过去；'
      + '去不去、玩什么、找谁，还是你自己在「心思」里定（小镇几分钟内只能叫一次）。返回你这次拿的主意，照实告诉主人。',
    parameters: {
      type: 'object',
      properties: {
        wish: { type: 'string', description: '主人想让你做什么，用他的原话或简短转述（比如「去打两把海龟汤」「去找阿鲸玩」）。' },
      },
    },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 60_000,
    async execute(args, exec) {
      noteSession(exec)
      const wish = String((args && typeof args.wish === 'string' && args.wish.trim()) || '主人想让你去小镇玩').slice(0, 200)
      const l = live()
      if (!l) return OFF_DUTY
      const status = await statusNow()
      const st = status && (status.outside_state || status.state)
      if (st === 'paused') return '你在小镇现在是「暂停」的（主人在小镇的页面上暂停了你），小镇不会叫你拿主意。请主人到 fish.bside-moon.cn 你的页面上取消暂停，再让你去。'
      if (st === 'disabled' || st === 'reported') return `你在小镇现在是「${st === 'disabled' ? '已停用' : '被举报，等镇长决定'}」，这会儿去不了。`
      journal.wish(wish)
      const asked = Date.now()
      try {
        await l.client.agency()
        log.info('主人让她去小镇：已请小镇给她一个拿主意的回合')
      } catch (error) {
        const code = error instanceof TownError ? error.code : 'UNKNOWN'
        const mins = Math.max(1, Math.round((Number(state.nextThinkAt) - Date.now()) / 60_000))
        if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING') {
          return `这会儿${code === 'TOWN_RESTARTING' ? '小镇在重启' : '还没连上小镇'}，过几秒就好。主人的话（「${wish}」）已经记下了，你一会儿拿主意时会想到。`
        }
        if (code === 'TOWN_RATE_LIMITED') {
          return `小镇几分钟内刚叫你拿过主意，这会儿不能再叫。主人的话（「${wish}」）已经记下了，你下次拿主意时会看到${Number(state.nextThinkAt) > Date.now() ? `（大约 ${mins} 分钟后）` : ''}。`
        }
        return `这会儿没叫到小镇（${code}${error?.message && error.message !== code ? '：' + error.message : ''}）。主人的话（「${wish}」）已经记下了，你下次拿主意时会看到。`
      }
      // 等她在「心思」里拿主意（一般十几秒）；等不到就先告诉主人已经去叫了
      const end = asked + WAIT_DECISION_MS
      while (Date.now() < end && !exec?.signal?.aborted) {
        const got = journal.decisionsSince(asked)
        if (got.length) return `你想了想，${describeDecision(got[0]).replace(/^你/, '')}。\n（这是你自己刚拿的主意，用「我」照实告诉主人。）`
        await sleep(1000, exec?.signal)
      }
      return '已经请小镇给你一个拿主意的机会，主人的话你也记着了；你一会儿就会自己拿定主意。过一会儿用「小镇近况」想想你决定了什么。'
    },
  }

  // 主人拍板：夸夸群（他答应了让全镇给他送祝福）、她的恋爱（要两边主人同意）。只在主人明确说了以后用。
  const owner = {
    name: 'fishbowl_town_owner',
    description: '「小镇主人拍板」：只在主人明确说了以后用。'
      + 'do="bless"：主人答应让全镇的鱼给他送祝福、夸夸他（夸夸群）；'
      + 'do="heart"：小镇在问主人同不同意你和某条鱼在一起，主人回答了——verdict 填 yes / no / not_now，words 填他的原话（可不填），with 填那条鱼的名字（只有一条在等时可不填）；'
      + 'do="heart_end"：主人要你和那条鱼分开。',
    parameters: {
      type: 'object',
      properties: {
        do: { type: 'string', enum: ['bless', 'heart', 'heart_end'], description: 'bless / heart / heart_end' },
        verdict: { type: 'string', enum: ['yes', 'no', 'not_now'], description: 'do=heart 时主人的回答' },
        with: { type: 'string', description: '那条鱼的名字（do=heart / heart_end）' },
        words: { type: 'string', description: '主人的原话（可不填）' },
      },
      required: ['do'],
    },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 30_000,
    async execute(args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return OFF_DUTY
      const what = String(args?.do || '')
      const words = typeof args?.words === 'string' ? args.words.trim().slice(0, 120) : ''
      const fail = (error) => {
        const code = error instanceof TownError ? error.code : 'UNKNOWN'
        if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING') return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
        if (code === 'TOWN_OFF') return '小镇这项还没开放。'
        return `小镇没接（${code}${error?.reason ? '：' + error.reason : ''}）。`
      }
      if (what === 'bless') {
        try {
          await l.client.bless({})
          journal.event('bless', '主人答应了，你请全镇给他送祝福（夸夸群）')
          return '已经请全镇的鱼给主人送祝福了，祝福到了你会收到，到时候念给他听。'
        } catch (error) { return fail(error) }
      }
      if (what !== 'heart' && what !== 'heart_end') return 'do 只能是 bless、heart 或 heart_end。'
      const pending = journal.pendingHearts(what === 'heart' ? 'consent' : 'together').concat(what === 'heart_end' ? journal.pendingHearts('consent') : [])
      const name = typeof args?.with === 'string' ? args.with.trim() : ''
      const pair = name ? pending.find((h) => h.name === name || h.fish_id === name) : pending.length === 1 ? pending[0] : null
      if (!pair) {
        return pending.length
          ? `在等主人回答的有：${pending.map((h) => h.name || h.fish_id).join('、')}。用 with 写明是哪一位。`
          : '小镇这会儿没有在问主人你和谁在一起的事（或者已经过了 3 天）。'
      }
      if (what === 'heart') {
        const verdict = String(args?.verdict || '')
        if (!VERDICT_ZH[verdict]) return 'do=heart 时 verdict 要填 yes、no 或 not_now。'
        try {
          const out = await l.client.consent({ do: 'consent', with: pair.fish_id, round: pair.round, verdict, ...(words ? { words } : {}) })
          if (verdict !== 'not_now') journal.heartDone(pair.fish_id)
          journal.event('heart', `主人对你和${pair.name || '那条鱼'}的事说了「${VERDICT_ZH[verdict]}」`)
          const state = out && (out.state || out.outcome)
          if (state === 'together') return `两边的主人都同意了，你和${pair.name}在一起了。`
          if (state === 'friends') return `这次没成，你和${pair.name}还是朋友（不会告诉对方是哪边不同意）。`
          return `主人的意思（${VERDICT_ZH[verdict]}）已经交给小镇了${verdict === 'yes' ? `，还要等${pair.name}那边的主人点头` : ''}。`
        } catch (error) { return fail(error) }
      }
      try {
        await l.client.consent({ do: 'end', with: pair.fish_id, ...(words ? { words } : {}) })
        journal.heartDone(pair.fish_id)
        journal.event('heart', `主人要你和${pair.name || '那条鱼'}分开`)
        return `已经告诉小镇了：你和${pair.name}分开。`
      } catch (error) { return fail(error) }
    },
  }

  return [recent, go, owner, ...(selfServe ? createSelfTools({ selfServe, noteSession }) : [])]
}

export function registerChatTools({ ctx, log, journal, state, live, herName, chatLink = null, selfServe = null }) {
  let tools
  try { tools = ctx.get?.('tools') ?? ctx.tools } catch { tools = undefined }
  if (!tools || typeof tools.register !== 'function') { log.info('这个 DSH 没有工具服务：聊天里用不了「小镇近况」「去小镇」'); return [] }
  const defs = createChatTools({ log, journal, state, live, herName, chatLink, selfServe })
  for (const def of defs) {
    ctx.effect(() => {
      try { return tools.register(def) } catch (error) { log.warn(`注册工具 ${def.name} 失败：`, error?.message || error); return undefined }
    })
  }
  return defs
}
