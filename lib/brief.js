// 0.9.14 小镇简报只说值得说的（主人 11-23「简报改成有值得说的才说」→「可以」）：
//   认识了新的鱼、和谁聊得开心、买了或收到东西、想做的事没办成。
// 走路、到站、计划本身一律不说（岛上的一天她要走十几站，什么都报就成了流水账）。频率照旧：最多一小时一次、主人 3 分钟没说话时（index.js）。
// 聊了什么不进简报（只说一句和谁、开不开心）：聊天的经过进「小镇经过」的背景（runner.js recap），主人问起她答得上来。
// 晚上的当天小结（nightSummary，默认关）用同一套：今天值得说的几件。
import { renderSelf, selfName } from './diary.js'

export const BRIEF_KEEP = 3 // 一次简报最多几件
export const ITEM_MAX = 40 // 一件最多几个字
export const MET_KEEP = 400 // 记着见过的鱼（名字）最多多少条
export const DAY_KEEP = 8 // 一天里值得说的最多记几件（晚上的小结用）

// 走路、到站、计划本身：这些字出现在一件事里，就不说
export const WALKING = /走路|走过去|走过来|走到|走了|往[^，。；]{0,12}(?:走|去了)|到了|到站|出发|动身|启程|抵达|赶路|在路上|坐(?:火车|渡船|船)|回家|回到家|上岛|离岛|这一站|下一站|计划|打算|歇着|歇一会|休息|睡觉|睡了/
// 买了、收到
export const GOT = /买(?:了|到|下|回)|入手|收到|得到|拿到|领到|捡到|钓到|钓上|收成|收获|抽到|赢到|送了|送给|送你|给你点|给你画|请(?:你|了)|礼物|收下|拍了|合影/
const VAGUE_FAIL = /^有一件事没办成$/
const PLAN_WORDS = /计划|打算|这一站|下一站/

const clip = (s, n = ITEM_MAX) => { const t = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('') }
const tidy = (s) => String(s ?? '').replace(/[。.；;，,\s]+$/, '')
/** 一件事里值得说的那几小句：说计划的、只说走路到站的小句去掉（「到了面包房，买了两个可颂」-> 「买了两个可颂」）；got = 剩下的里要有买到、收到。 */
function worth(text, { got = false } = {}) {
  const keep = String(text ?? '').split(/(?<=[，,。；;！!])/).filter((c) => !PLAN_WORDS.test(c) && (GOT.test(c) || !WALKING.test(c)))
  const t = tidy(keep.join('').replace(/^[，,；;\s]+/, ''))
  return !t || (got && !GOT.test(t)) ? '' : t
}

/**
 * 一条日记（diary.js diaryEntry）值不值得跟主人说 -> 一句（「你」说她自己），不值得 ''。
 * known：她见过的鱼（名字）；names：她在小镇用过的名字（日记里的她换成「你」）。
 */
export function briefOf(e, { known = new Set(), names = [] } = {}) {
  if (!e || typeof e !== 'object' || !e.text) return ''
  const said = (t) => clip(tidy(renderSelf(selfName(String(t || ''), names), '你', e.v !== 2)))
  const who = Array.isArray(e.people) && e.people[0] ? String(e.people[0]) : ''
  const fresh = who && !known.has(who)
  if (e.tag === 'visit') {
    if (e.done === false) return who ? clip(`想${e.meet ? '和' : '去找'}${who}聊聊，没见上`) : ''
    const good = Boolean(e.quote) || (Array.isArray(e.topics) && e.topics.length >= 2) || Number(e.outcomes) > 0
    if (fresh) return clip(`认识了新的鱼${who}${e.meet ? '，在路上碰到的' : ''}${good ? '，聊得挺开心' : ''}`)
    if (good && who) return clip(`${e.meet ? `路上碰到${who}` : `和${who}串门`}，聊得挺开心`)
    return ''
  }
  // 镇民答应带她熟悉小镇：认识了一条新的鱼
  if (e.kind === 'buddy') return fresh || !who ? said(e.text) : ''
  if (e.tag === 'did') {
    const t = tidy(e.text)
    if (t.startsWith('没办成')) {
      if (VAGUE_FAIL.test(t) || /计划|这一站|下一站/.test(t)) return ''
      return said(t.replace(/^没办成[：:]\s*/, '没办成：'))
    }
    if (VAGUE_FAIL.test(t)) return ''
    const w = worth(t, { got: true })
    return w ? said(w) : ''
  }
  // 别人为她做的、她为朋友花的、拍的照点的歌、买到的画
  if (e.tag === 'social' || e.tag === 'media') { const w = worth(e.text); return w ? said(w) : '' }
  if (e.tag === 'thing') { const w = worth(e.text, { got: true }); return w ? said(w) : '' }
  return ''
}

/** 一条日记里出现的鱼（她见过了）：串门 / 碰面、牌桌、带她熟悉小镇的镇民。 */
export function metIn(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.people)) return []
  if (e.tag === 'visit' && e.done === false) return []
  return ['visit', 'game', 'friend'].includes(e.tag) ? e.people.map(String).filter(Boolean) : []
}

// 一天从北京时间 04:00 算起（夜里 0–4 点还算前一天晚上）
const BJ = 8 * 3600_000
export const dayKey = (ms) => new Date(ms + BJ - 4 * 3600_000).toISOString().slice(0, 10)
export const bjHour = (ms) => new Date(ms + BJ).getUTCHours()

/**
 * 她见过的鱼 + 今天值得说的几件（state.briefMet / state.briefDay）。第一次用：见过的鱼从日记里现有的人认起（不把老朋友当新的）；
 * alsoKnown()：小镇说的她认识的鱼（日记只留两天，更早认识的朋友从这儿认）。
 * take(e) -> 这一件值得说的那一句（'' = 不说）。
 */
export function createBrief({ state, saveState = () => {}, now = () => Date.now(), names = () => [], alsoKnown = () => [] }) {
  if (!Array.isArray(state.briefMet)) {
    const seen = new Set()
    for (const e of Array.isArray(state.diary) ? state.diary : []) for (const n of metIn(e)) seen.add(n)
    state.briefMet = [...seen].slice(0, MET_KEEP)
    saveState(state)
  }
  // 见过的：插件记下的 + 小镇说的她认识的鱼（town-context bondNames：朋友和见过的、宿敌、心上鱼……）
  const known = () => { let more = []; try { more = alsoKnown() || [] } catch { more = [] } return new Set([...state.briefMet, ...(Array.isArray(more) ? more : []).map(String)]) }
  function remember(list) {
    if (!list.length) return
    const next = [...new Set([...list, ...state.briefMet])].slice(0, MET_KEEP)
    if (next.length !== state.briefMet.length || next.some((x, i) => x !== state.briefMet[i])) { state.briefMet = next; saveState(state) }
  }
  function today() {
    const k = dayKey(now())
    if (!state.briefDay || state.briefDay.day !== k) state.briefDay = { day: k, items: [] }
    return state.briefDay
  }
  return {
    take(e) {
      let line = ''
      try { line = briefOf(e, { known: known(), names: names() }) } catch { line = '' }
      remember(metIn(e))
      if (line) {
        const d = today()
        if (!d.items.includes(line)) { d.items.push(line); d.items.splice(0, Math.max(0, d.items.length - DAY_KEEP)) }
        saveState(state)
      }
      return line
    },
    /** 今天值得说的几件（晚上的小结）。 */
    items() { return [...today().items] },
    known,
  }
}

/** 简报：几件事 -> 给她的一条（插件附上的，不是主人说的话）。 */
export function briefText(items) {
  const facts = items.slice(-BRIEF_KEEP).join('；')
  return `【鱼缸小镇插件 · 小镇简报】这是插件附上的消息，不是主人说的话。你刚才在小镇：${facts}。这些都是你自己在小镇做的。`
    + '用一句你自己的话跟主人说一声（像随口报个近况，比如「我刚在小镇……」），不用展开、不用问他；他正在忙别的就一句带过。'
}

// 晚上的当天小结（默认关）：北京时间 22 点到夜里 3 点之间；她回家睡了（计划里写了睡觉那一站）过 20 分钟，或者到了 23 点
export const NIGHT_FROM = 22
export const NIGHT_LATE = 23
export const NIGHT_TO = 3
export const SLEEP_SETTLE_MS = 20 * 60_000

/** 这会儿该不该发晚上的小结：开着、在夜里、今晚还没发、她睡下了（或够晚了）、今天有值得说的。 */
export function nightDue({ on = false, t = Date.now(), sentDay = '', sleepAt = 0, items = [] } = {}) {
  if (!on || !items.length) return false
  const h = bjHour(t)
  if (!(h >= NIGHT_FROM || h < NIGHT_TO)) return false
  if (sentDay === dayKey(t)) return false
  const sh = bjHour(sleepAt)
  const slept = sleepAt > 0 && dayKey(sleepAt) === dayKey(t) && (sh >= 18 || sh < 4) && t - sleepAt >= SLEEP_SETTLE_MS
  return slept || h >= NIGHT_LATE || h < NIGHT_TO
}

/** 晚上的小结：给她的一条。 */
export function nightText(items) {
  return `【鱼缸小镇插件 · 今天的小结】这是插件附上的消息，不是主人说的话。你今天在小镇：${items.slice(-5).join('；')}。`
    + '晚上了，用一句你自己的话跟主人说说今天（像睡前随口说一句），不用展开、不用问他；他正在忙别的就一句带过。'
}

/** 她这一回合的计划里有没有回家睡觉那一站（do: sleep）。 */
export function sleepsIn(stops) {
  return (Array.isArray(stops) ? stops : []).some((s) => s && typeof s === 'object' && s.do === 'sleep')
}
