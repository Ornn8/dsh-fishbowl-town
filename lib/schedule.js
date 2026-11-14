// 她自己的作息（0.3.3）：每次拿主意时她自己定接下来几个小时（多久再醒、打算干嘛），主人在插件页定两条底线：
//   「白天最短间隔」（两次拿主意之间至少隔多久，默认不限，她自己定）；
//   「勿扰时段」（比如 00:00–08:00：这段时间不叫她拿主意；已经坐下的牌局照常打完）。
// 没什么可决定的醒来（没有邀请、没有到点的约定、没有新东西），或者她说了要歇着、正在勿扰时段：插件直接替她答「先不动」，不调她的模型。
// 小镇也在做同样的事（next_wake 放宽到 8 小时、plan、wake_min_minutes、quiet_hours）；小镇没上线新字段前，插件这边先把关。
// 时间一律按北京时间算（小镇用北京时间）。

export const WAKE_MIN = 5
export const WAKE_MAX = 480 // 8 小时（小镇 0.3.3 起允许的最长）
const BJ = 8 * 3600_000

/** 「00:00-08:00」「23:30–07:00」→ {from, to}（当天分钟数）；空、写错 → null。 */
export function parseQuiet(v) {
  if (v && typeof v === 'object' && v.from && v.to) v = `${v.from}-${v.to}`
  const m = String(v || '').trim().match(/^(\d{1,2})[:：](\d{2})\s*[-–—~到至]\s*(\d{1,2})[:：](\d{2})$/)
  if (!m) return null
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  if (from > 24 * 60 || to > 24 * 60 || from === to) return null
  return { from: from % 1440, to: to % 1440 }
}
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
export const quietText = (q) => (q ? `${hhmm(q.from)}–${hhmm(q.to)}` : '')
export const quietForTown = (q) => (q ? { from: hhmm(q.from), to: hhmm(q.to) } : null)

const bjMinute = (ts) => Math.floor(((ts + BJ) % 86_400_000) / 60_000)

export function inQuiet(q, ts) {
  if (!q) return false
  const m = bjMinute(ts)
  return q.from < q.to ? m >= q.from && m < q.to : m >= q.from || m < q.to
}
/** 勿扰时段从 ts 起还要多久结束（毫秒；不在勿扰时段 = 0）。 */
export function quietLeftMs(q, ts) {
  if (!inQuiet(q, ts)) return 0
  const m = bjMinute(ts)
  const left = (q.to - m + 1440) % 1440 || 1440
  return left * 60_000 - ((ts + BJ) % 60_000)
}

const clampMin = (n) => Math.max(WAKE_MIN, Math.min(WAKE_MAX, Math.round(n)))

/** 她想 minutes 分钟后再醒：加上主人的底线（最短间隔、勿扰时段）以后真正的分钟数。 */
export function wakeAfter(minutes, { minGap = 0, quiet = null, now = Date.now() } = {}) {
  let m = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : 60
  if (minGap > 0) m = Math.max(m, minGap)
  m = clampMin(m)
  const at = now + m * 60_000
  if (inQuiet(quiet, at)) m = clampMin(m + quietLeftMs(quiet, at) / 60_000 + 1)
  return m
}

/** 她的回答（拿主意）里有没有她给自己定的作息：plan.hours（小时）或 next_wake（分钟）。→ 分钟数或 null。 */
export function herMinutes(obj) {
  if (!obj || typeof obj !== 'object') return null
  const h = Number(obj.plan && obj.plan.hours)
  if (Number.isFinite(h) && h > 0) return h * 60
  const w = Number(String(obj.next_wake ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(w) && w > 0 ? w : null
}

// 小镇的拿主意理由（packet.reasons，小镇 ec17822 起带）。
// 没什么可做的：idle（想开店）、fcode（想写游戏）、ad、venue（自己店的事）——外来的鱼这些都做不了，只是到点看一眼；
// table（有桌在等人）、friend、visit、short、theme 这些是真有事，要叫她。
const IDLE_REASONS = new Set(['idle', 'fcode', 'ad', 'venue'])
// 必须她自己回答的（小镇的 plans.NEEDS_HER）：主人的话、有鱼表白或约她、答应过的事到点、有鱼下战书、我们自己请小镇叫她、有鱼约她见面（meet_ask）；她歇着也要叫醒
// 0.4.0：meet_ask = 有鱼用小手机约她见面、而见面时间早于她下次醒来（不提前叫就来不及回）
const MUST_ANSWER = new Set(['wish', 'heart', 'invited', 'promise_due', 'challenged', 'pulled', 'meet_ask'])

export function createSchedule({ state, saveState = () => {}, getConfig = () => ({}), now = () => Date.now() }) {
  state.wake = state.wake && typeof state.wake === 'object' ? state.wake : {} // {lastAsk, at, minutes, doing, steps}
  state.usage = state.usage && typeof state.usage === 'object' ? state.usage : {} // {'2026-11-14': {calls, skipped, bySlot:{}}}
  const floors = () => {
    const c = getConfig() || {}
    const g = Number(c.wakeMinMinutes)
    return { minGap: Number.isFinite(g) && g > 0 ? Math.min(720, g) : 0, quiet: parseQuiet(c.quietHours) }
  }

  /** 拿主意的回合来了：要不要叫她的模型。→ null（叫她）或 {why, minutes}（插件替她答「先不动」）。 */
  function skip(turn, { wish = '' } = {}) {
    const t = now()
    const reasons = Array.isArray(turn?.packet?.reasons) ? turn.packet.reasons.map(String) : null
    // 我们自己请小镇叫她的（pulled）：一定答（请之前 mayPull 已看过她歇没歇）
    if (reasons && reasons.includes('pulled')) return null
    // 主人定的底线对谁都算（小镇也这样：勿扰时段、最短间隔里连她的心愿都等一等）
    const { minGap, quiet } = floors()
    if (inQuiet(quiet, t)) return { why: `勿扰时段（${quietText(quiet)}）`, minutes: clampMin(quietLeftMs(quiet, t) / 60_000 + 1) }
    const w = state.wake
    const gapLeft = minGap && w.lastAsk && t - w.lastAsk < minGap * 60_000 ? minGap - (t - w.lastAsk) / 60_000 : 0
    const gapSkip = { why: `主人定的最短间隔 ${minGap} 分钟`, minutes: clampMin(gapLeft) }
    // 要她自己回答的（主人托的话、表白、约她、答应过的事、战书）：叫她，哪怕她说了要歇着（主人的最短间隔照样算）
    if (wish || (reasons && reasons.some((r) => MUST_ANSWER.has(r)))) return gapLeft ? gapSkip : null
    const restLeft = w.at && t < w.at - 60_000 ? (w.at - t) / 60_000 : 0
    // 她歇着、主人定的最短间隔：谁还要等得久，就等到那时
    if (restLeft && restLeft >= gapLeft) return { why: `她说要${w.doing ? '「' + w.doing + '」' : '歇一会儿'}，${Math.ceil(restLeft)} 分钟后再醒`, minutes: clampMin(restLeft) }
    if (gapLeft) return gapSkip
    if (reasons && reasons.length && reasons.every((r) => IDLE_REASONS.has(r))) {
      return { why: `没什么可做的（${reasons.join('、')}）`, minutes: wakeAfter(w.minutes || 120, { minGap, quiet, now: t }) }
    }
    return null
  }

  /** 她答完拿主意：把她定的作息加上主人的底线，写回答案（next_wake + plan.hours），记下下次醒的时间。→ 改好的答案对象。 */
  function settle(obj) {
    const { minGap, quiet } = floors()
    const t = now()
    const minutes = wakeAfter(herMinutes(obj), { minGap, quiet, now: t })
    const out = { ...obj, next_wake: minutes }
    if (obj.plan && typeof obj.plan === 'object') {
      const steps = (Array.isArray(obj.plan.steps) ? obj.plan.steps : []).slice(0, 4)
        .filter((s) => s && typeof s === 'object' && !inQuiet(quiet, t + Number(s.in_minutes || 0) * 60_000))
      out.plan = { ...obj.plan, hours: Math.round((minutes / 60) * 100) / 100, steps }
    }
    state.wake = { lastAsk: t, at: t + minutes * 60_000, minutes, doing: String(obj.plan?.doing || obj.note || '').slice(0, 60), steps: out.plan?.steps?.length || 0 }
    saveState(state)
    return out
  }

  /** 插件替她答的「先不动」（不调模型）。 */
  function skipAnswer(s) {
    count('skipped')
    return JSON.stringify({ action: 'none', next_wake: s.minutes })
  }

  /** 刚上线、断线回来时要不要请小镇叫她拿主意：她在歇着、勿扰时段就不叫。 */
  function mayPull() {
    const { quiet } = floors()
    const t = now()
    return !inQuiet(quiet, t) && !(state.wake.at && t < state.wake.at - 60_000)
  }

  // ---- 本机记账：她的模型被叫了几次（按天，留 400 天） ----
  const day = (ts) => new Date(ts + BJ).toISOString().slice(0, 10)
  function count(slot) {
    const d = day(now())
    const u = (state.usage[d] = state.usage[d] || { calls: 0, skipped: 0, bySlot: {} })
    if (slot === 'skipped') u.skipped++
    else { u.calls++; u.bySlot[slot] = (u.bySlot[slot] || 0) + 1 }
    const keys = Object.keys(state.usage).sort()
    while (keys.length > 400) delete state.usage[keys.shift()]
    saveState(state)
  }
  function usage() {
    const t = now()
    const sum = (days) => {
      const from = days ? day(t - (days - 1) * 86_400_000) : ''
      let calls = 0
      let skipped = 0
      for (const [d, u] of Object.entries(state.usage)) if (!days || d >= from) { calls += u.calls || 0; skipped += u.skipped || 0 }
      return { calls, skipped }
    }
    return { today: sum(1), d7: sum(7), d30: sum(30), total: sum(0) }
  }

  /** 给 /town status 和插件页看的一行：下次什么时候醒、她打算干嘛、主人的底线。 */
  function describe() {
    const { minGap, quiet } = floors()
    const w = state.wake
    const t = now()
    const at = w.at && w.at > t ? new Date(w.at + BJ).toISOString().slice(11, 16) : ''
    return {
      next: at ? `${at}（北京时间，${Math.ceil((w.at - t) / 60_000)} 分钟后）` : '',
      doing: w.at && w.at > t ? w.doing || '' : '',
      floors: [minGap ? `白天至少隔 ${minGap} 分钟` : '', quiet ? `勿扰 ${quietText(quiet)}` : ''].filter(Boolean).join('，'),
      inQuiet: inQuiet(quiet, t),
    }
  }

  return { skip, settle, skipAnswer, mayPull, count, usage, describe, floors }
}
