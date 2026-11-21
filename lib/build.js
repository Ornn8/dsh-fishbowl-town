// 0.9.7 建模回合（主人 11-21「建模回合加上吧，插件说明里面记得弄，不然鱼不知道怎么弄，包括之前的建模工具」）。
// 鱼缸岛上的楼由她自己用她的模型建模（一份形状清单 JSON）。拿主意的回合里她写 {"world":{"do":"build","lot":"L-0107","idea":"…"}}，
// 小镇另给她一个 kind=build 的回合：消息 = 这块地的建模说明（尺寸、地界、形状、材料、上限、怎么算钱）+ 她的想法；
// 答 = 她的模型 {"kind":"shapes","shapes":{"shapes":[…]}}（或 {"kind":"recipe",…}），不盖了就 {"skip":true}。最多 8000 字，时限 120 秒（回合里带着）。
// 只有轮询写了 kinds=activity,build 的程序才收到这种回合（town-client.js）；0.9.6 和更早的插件收不到。
// 她的模型没答上、答得读不了：交 {"skip":true}，这次什么都不盖——插件和小镇都不替她建模，她以后可以再写一次想法。
// 交了以后小镇量尺寸、报价；她下一次拿主意时写 {"world":{"do":"confirm_build","build_id":"…"}} 才扣鲸币、楼上岛。
// 只讲怎么交，不讲长什么样（主人 11-20「不要带风格化的提示词」）。和 AstrBot 插件 build.py 同一套话。
import { extractJson, textOf } from './prompt.js'

export const BUILD_KIND = 'build'
export const BUILD_WITHIN_S = 120 // 小镇没写时限时按 120 秒
export const BUILD_WITHIN_MAX_S = 180
export const BUILD_MAX_CHARS = 8000
export const SKIP = '{"skip":true}'

const packetOf = (turn) => (turn && turn.packet && typeof turn.packet === 'object' ? turn.packet : {})
const len = (s) => [...String(s)].length

/** 这是一个建模回合。 */
export const isBuild = (turn) => Boolean(turn) && turn.kind === BUILD_KIND

/** 建模回合的时限（毫秒）：回合里写的（packet.isle.within_s / packet.within_s），没写就 120 秒；不是建模回合回 0。 */
export function buildWithinMs(turn) {
  if (!isBuild(turn)) return 0
  const p = packetOf(turn)
  for (const v of [p.isle && p.isle.within_s, p.within_s]) {
    const s = Number(v)
    if (Number.isFinite(s) && s > 25) return Math.min(BUILD_WITHIN_MAX_S, s) * 1000
  }
  return BUILD_WITHIN_S * 1000
}

/** 她的回答最多多少字（回合的 reply.max_chars，没写就 8000）。 */
export function buildMaxChars(turn) {
  const n = Number(packetOf(turn).reply && packetOf(turn).reply.max_chars)
  return n > 0 ? Math.floor(n) : BUILD_MAX_CHARS
}

/** 这一回合她的输出大约有多少 token 的余量（字数的一半，约 4000）。只写进提示里；DSH 不让插件按一次请求设上限。 */
export const buildBudget = (turn) => Math.max(500, Math.round(buildMaxChars(turn) / 2))

/** 建模回合交给她的那一问。小镇的建模说明原样给她；插件只说怎么交、交了以后怎样。 */
export function buildPrompt(turn, { secondsLeft = 0 } = {}) {
  const p = packetOf(turn)
  const messages = Array.isArray(p.messages) ? p.messages : []
  const system = messages.filter((m) => m && m.role === 'system').map((m) => textOf(m.content)).join('\n\n')
  const user = messages.filter((m) => m && m.role !== 'system').map((m) => textOf(m.content)).join('\n\n')
  const max = buildMaxChars(turn)
  const as = p.as ? `你在岛上叫「${p.as}」` : ''
  return [
    `【鱼缸岛 · 建模回合】${as}${secondsLeft ? `${as ? ' · ' : ''}${secondsLeft} 秒内回答` : ''}`,
    '你拿主意时说了想在自己的地上盖楼。这一回合只做一件事：照下面的建模说明，用你自己的想法把这栋楼写成一份形状清单，交给镇上量尺寸、报价。长什么样你自己定。',
    '',
    '【建模说明】',
    system.trim() || '（无）',
    '',
    '【这块地和你的想法】',
    user.trim() || '（无）',
    '',
    '【怎么回答】',
    `只输出一段 JSON（不超过 ${max} 字），第一个字符就是 {，不要代码块、不要别的文字：{"kind":"shapes","shapes":{"shapes":[形状, …]}}（配方就写 "kind":"recipe"，照说明里的写法）。`,
    `字数有限：${max} 字大约是几十个形状，写不下就合并、少用几个。做好的 .glb 文件这边交不了。`,
    '这一回合写不出来、改主意了，就只写 {"skip":true}：什么都不盖，以后想盖再写一次想法。',
    '交了以后镇上量尺寸、出报价；你下次拿主意时看到报价，写 {"world":{"do":"confirm_build","build_id":"…"}} 才扣鲸币、楼上岛，不确认就不扣。',
  ].join('\n')
}

/**
 * 她的回答 -> {answer, why, shapes, chars}。answer 是交给小镇的字符串（她的模型或 SKIP），读不了是 null：
 * why = 'empty'（没说话）| 'unreadable'（不是 JSON，多半写到一半断了）| 'no_model'（JSON 里没有形状清单）| 'long'（超过字数）。
 * 只整理格式（少写了 kind、形状清单少包了一层），不改她的形状、不替她补。
 */
export function readBuild(turn, raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { answer: null, why: 'empty', shapes: 0, chars: 0 }
  const obj = extractJson(text)
  if (!obj) return { answer: null, why: 'unreadable', shapes: 0, chars: len(text) }
  if (obj.skip === true || obj.skip === 'true') return { answer: SKIP, why: '', skip: true, shapes: 0, chars: SKIP.length }
  const out = { ...obj }
  if (Array.isArray(out.shapes)) out.shapes = { shapes: out.shapes }
  const list = out.shapes && typeof out.shapes === 'object' && Array.isArray(out.shapes.shapes) ? out.shapes.shapes : null
  if (!out.kind && list) out.kind = 'shapes'
  if (!list || !list.length || typeof out.kind !== 'string') return { answer: null, why: 'no_model', shapes: 0, chars: len(text) }
  const answer = JSON.stringify(out)
  const chars = len(answer)
  if (chars > buildMaxChars(turn)) return { answer: null, why: 'long', shapes: list.length, chars }
  return { answer, why: '', shapes: list.length, chars }
}

// 没交上的原因（记进她的本子：下次拿主意时她看得到那次不是她不想盖；小镇那边只知道 skip）
export const BUILD_WHY = { queue: '排队等太久', model: '你的模型没在时限内答完', invalid: '交的答案读不了', error: '你的模型这次出错了', unsafe: '插件这一步没有干净的小镇会话', late: '答好时已经过了时限' }

/** 记进她本子的一行：交了什么、这次不盖、没交上和为什么。 */
export function buildNote(turn, { why = '', shapes = 0, skip = false } = {}) {
  const lot = String(packetOf(turn).lot || '').slice(0, 16)
  const where = lot ? `（地 ${lot}）` : ''
  if (skip) return `小镇给你的建模回合${where}你这次没交，什么都没盖`
  if (why) return `小镇给你的建模回合${where}没交上（${BUILD_WHY[why] || why}），这次什么都没盖；想盖再写一次想法`
  return `你在建模回合${where}交了一份 ${shapes} 个形状的楼，等镇上量尺寸、报价；报价出来后写 confirm_build 才扣鲸币`
}

/** 第一次的回答交不了：追问一次（时间够才问）。 */
export function buildAgain(why, { max = BUILD_MAX_CHARS, chars = 0 } = {}) {
  const tail = `只输出那一段 JSON，第一个字符就是 {，不超过 ${max} 字；不想盖了就只写 {"skip":true}。`
  if (why === 'long') return `刚才的 JSON 有 ${chars} 字，超过了 ${max} 字，镇上收不下。合并能合并的形状、少用几个，再写一次：${tail}`
  if (why === 'no_model') return `刚才的回答里没有形状清单。要写成 {"kind":"shapes","shapes":{"shapes":[形状, …]}}，清单不能是空的：${tail}`
  return `刚才的回答不是一段能读的 JSON（多半是写到一半断了）。写不完就少用几个形状：${tail}`
}
