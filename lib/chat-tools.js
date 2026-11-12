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

export const CHAT_TOOL_NAMES = ['fishbowl_town_recent', 'fishbowl_town_go']
const WAIT_DECISION_MS = 40_000
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。要去小镇，请主人到 DSH「插件」→ 鱼缸小镇 →「配置」里打开。'

export function createChatTools({ log, journal, state, live, herName }) {
  async function statusNow() {
    const l = live()
    if (!l) return null
    try { return await l.client.status() } catch (error) { log.debug('读她的状态失败：', error?.code || error?.message); return null }
  }

  const recent = {
    name: 'fishbowl_town_recent',
    description: '「小镇近况」：你在鱼缸小镇的近况——你最近在「鱼缸小镇 · 心思」里自己拿的主意（报名、串门、歇着，和你当时的心思）、'
      + '打了哪几局、结果如何，你现在在干嘛（歇着 / 报了名在等开桌 / 正在打），下次什么时候再拿主意。'
      + '主人问起小镇的事（怎么没去玩、玩了什么、在干嘛）先用它查，照实用你自己的口吻讲：那些都是你自己的选择，不要凭印象编。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute() {
      const l = live()
      const status = l ? await statusNow() : null
      const body = journal.report({ status, herName: herName() })
      return l ? body : `${OFF_DUTY}\n\n${body}`
    },
  }

  const go = {
    name: 'fishbowl_town_go',
    description: '「去小镇」：主人想让你去鱼缸小镇玩、报名打牌或去串门时用。会请小镇马上给你一个拿主意的回合，并把主人的话带过去；'
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
        if (code === 'TOWN_RATE_LIMITED') {
          return `小镇几分钟内刚叫你拿过主意，这会儿不能再叫。主人的话（「${wish}」）已经记下了，你下次拿主意时会看到${Number(state.nextThinkAt) > Date.now() ? `（大约 ${mins} 分钟后）` : ''}。`
        }
        return `这会儿没叫到小镇（${code}${error?.message && error.message !== code ? '：' + error.message : ''}）。主人的话（「${wish}」）已经记下了，你下次拿主意时会看到。`
      }
      // 等她在「心思」里拿主意（一般十几秒）；等不到就先告诉主人已经去叫了
      const end = asked + WAIT_DECISION_MS
      while (Date.now() < end && !exec?.signal?.aborted) {
        const got = journal.decisionsSince(asked)
        if (got.length) return `你在「鱼缸小镇 · 心思」里想了想，${describeDecision(got[0]).replace(/^你/, '')}。\n（这是你自己刚拿的主意，照实告诉主人。）`
        await sleep(1000, exec?.signal)
      }
      return '已经请小镇给你一个拿主意的回合，你会在「鱼缸小镇 · 心思」里自己决定（主人的话已经带过去了）。过一会儿可以用「小镇近况」看看你决定了什么。'
    },
  }

  return [recent, go]
}

export function registerChatTools({ ctx, log, journal, state, live, herName }) {
  let tools
  try { tools = ctx.get?.('tools') ?? ctx.tools } catch { tools = undefined }
  if (!tools || typeof tools.register !== 'function') { log.info('这个 DSH 没有工具服务：聊天里用不了「小镇近况」「去小镇」'); return [] }
  const defs = createChatTools({ log, journal, state, live, herName })
  for (const def of defs) {
    ctx.effect(() => {
      try { return tools.register(def) } catch (error) { log.warn(`注册工具 ${def.name} 失败：`, error?.message || error); return undefined }
    })
  }
  return defs
}
