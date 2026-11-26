// 0.9.6 她住在鱼缸岛上（主人 11-21：每条鱼都搬到岛上住；老镇——鱼缸小镇——这周照常，11 月 28 日关门；岛上的路是真的，
// 去哪都要走过去，到了才能做那儿的事；「主人不能操控自己鱼」；岛上一律用鲸币）。和 AstrBot 插件 old_town.py 同一套话。
// 能用小镇自己的就用小镇的（回合里的 packet.isle 和处境、status 的 isle {open, here, hint}、now_line）；插件只补「住在岛上、路要走、
// 老镇哪天关」这几句，岛上以后加的东西（约好地点和时间的事……）跟着小镇的话走，不用再发插件。

// 0.9.17（主人 11-24「就这么做」：老镇 11-25 凌晨起不再叫醒鱼、不再给鱼选，11-28 整个关掉）：这一版 11-25 发，发出去时老镇已经不给鱼选了——
// 给她的话里不再有「老镇这周还能去」那句。老镇讲不讲跟着小镇走（oldtown-close 11-24：服务器的开关拨得回去，插件别写死）：
// 小镇这一回合列着老镇的动作才讲；11-28 整个关掉以后一律不讲。
export const CLOSE_AT_MS = Date.parse('2026-11-28T00:00:00+08:00') // 老镇整个关掉
// 老镇的动作（小镇在拿主意的回合里列出来的；老镇停了小镇就不列了）
export const OLD_ACTIONS = new Set(['signup', 'cancel', 'visit', 'join', 'leave', 'pier', 'arcade', 'make', 'court', 'challenge', 'propose', 'club_join', 'club_leave'])
// 0.9.17 老镇安静（小镇 old_quiet）时回合里还会有：cancel / leave / club_leave（退出照常），visit（约好的照走：小手机约见到点、
// 今天到期的约定、第一次约会）。这几样不算「老镇还在给她选」，只有开新的那几样才算（小镇的开关拨回去，就又列出来了）。
// 第三版（oldtown-close 11-24 c8519b24）：电玩城被一条鱼买下，是她的店，老镇安静时照开（回合里会有 arcade），也不算。
export const OLD_NEW = new Set([...OLD_ACTIONS].filter((a) => !['cancel', 'leave', 'club_leave', 'visit', 'arcade'].includes(a)))
export const ISLE_HOME = '你住在鱼缸岛上。岛上去哪都得走过去（多远、几分钟，小镇会写给你），到了才能做那儿的事；约了地方就早点动身。'
const CLOSED = '老镇（鱼缸小镇）关了，这一块去不了了。'
export const CLOSED_HER = CLOSED + '你住在鱼缸岛上：岛上想去哪、做什么，用「去小镇」写下你的打算就行。'
export const CLOSED_OWNER = CLOSED + '她住在鱼缸岛上，岛上去哪、做什么由她自己定；想让她去哪儿，就在聊天里跟她说。'

let closeAt = CLOSE_AT_MS
/** 测试用：换关门的时间（不传就换回 11-28）。 */
export function setCloseAt(ms) { closeAt = ms === undefined ? CLOSE_AT_MS : ms }
export const oldTownOpen = (now = Date.now()) => now < closeAt

const packetOf = (turn) => (turn && turn.packet && typeof turn.packet === 'object' ? turn.packet : {})
/** 这一回合她在鱼缸岛上（小镇带了 packet.isle）。 */
export const onIsle = (turn) => Boolean(packetOf(turn).isle && typeof packetOf(turn).isle === 'object')

/** 老镇还开着，而且小镇这一回合还列着老镇开新的动作（0.9.17：没列动作就是没有；只列退出、约好的串门不算）。 */
export function oldTownOffered(turn, now = Date.now()) {
  const acts = packetOf(turn).actions
  return oldTownOpen(now) && Array.isArray(acts) && acts.some((a) => OLD_NEW.has(a))
}

/** 拿主意的提示里那一句：在岛上就说住在岛上、路要走（0.9.17：不再说老镇哪天关）。 */
export function isleLines(turn) {
  return onIsle(turn) ? [ISLE_HOME] : []
}

/** 老镇那一块关了（或这个小镇没有这一项）：TOWN_OFF / 没有这个地址，都是 404。 */
export function isClosed(error) {
  return Boolean(error) && error.status === 404 && (error.code === 'TOWN_OFF' || error.code === 'HTTP_404')
}

/** 老镇的接口回 TOWN_OFF / 404：关门以后照实说关了、指向岛上；关门以前只说这一项这会儿没开。 */
export function closedText(error, { owner = false, now = Date.now() } = {}) {
  if (oldTownOpen(now)) {
    const why = String(error?.reason || '').trim().replace(/[。.]+$/, '')
    return `这一项这会儿没开放${why ? '：' + why : ''}。`
  }
  return owner ? CLOSED_OWNER : CLOSED_HER
}

/** /town status 里一行：小镇 status 的 isle {open, here}。小镇没给就是 ''。 */
export function isleStatusLine(st) {
  const i = st && typeof st.isle === 'object' ? st.isle : null
  if (!i) return ''
  if (i.open === false) return '鱼缸岛：这会儿没对她开放'
  if (i.here === true) return '鱼缸岛：她在岛上'
  if (i.here === false) return '鱼缸岛：她这会儿不在岛上'
  return ''
}

/** 「你现在」那一句：小镇的 now_line；她在岛上、now_line 只是老镇那句「在家歇着，没在镇上哪个地方」时，说她在鱼缸岛上。 */
export function nowWithIsle(st) {
  const line = st && typeof st.now_line === 'string' ? st.now_line.trim() : ''
  const i = st && typeof st.isle === 'object' ? st.isle : null
  if (i && i.here === true && (!line || /^在家歇着/.test(line))) return '在鱼缸岛上'
  return line
}
