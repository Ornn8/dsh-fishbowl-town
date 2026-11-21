// 鱼缸岛的回合（主人 11-20：「岛的规模人数会越来越大，发整个回合过去负担太大了」；接口见小镇 platform/岛-回合瘦身-接口.md）。
// 1. 规矩只发一次：回合里只带版本号 packet.isle.static；规矩全文插件按版本存一份（state.isleStatic），拼提示时放在最前面——
//    每回合都一样，她那边模型的前缀缓存才命中得了。版本变了才再取。
// 2. 想看再查：她的回答写 {"world":{"do":"look","topic":…}}，插件向小镇要这一页、递回给她，最多 3 次，然后她出手。查看不占她的行动次数。
// 岛上拿主意的回合时限是 packet.isle.within_s（120 秒），不是牌桌的 25 秒。
// 3. 看图（主人 11-20「直接弄吧，很便宜无所谓」「dsh能看图啊」；小镇 platform/岛-鱼看图-接口.md）：查到的那页带 pics（地图、那个地方的样子）时，
//    图存进 DSH 的附件服务（ctx.attachments，DSH 0.2）附在递回去的那一问里；DSH 没有附件服务、她的模型不收图、开关关着，就只给图上画的是什么（alt）。

export const READ_MAX = 3
export const READ_TEXT_MAX = 1500
// 0.9.7「怎么做」一次给全（建模说明约 3,000 字、写程序约 5,000 字，小镇不分页）：按 1500 截掉，她就看不到上限和价钱
export const HOWTO_TEXT_MAX = 6000
export const WITHIN_MAX_S = 180
export const PIC_MAX = 2
const ALT_MAX = 120

const BLOCKS = [['rules', '岛上的规矩'], ['verbs', '能做的事（细节用 look 查「怎么做」）'], ['goods', '标准货品'], ['law', '镇规']]
const TOPIC_ZH = { 地: '挂着的地', 楼: '待承包的楼', 铺位: '空铺位', 店: '开着的店', 订单: '接力订单', 缺的: '最缺的', 统计: '镇上统计', 镇规: '镇规', 怎么做: '怎么做', 我的店: '我的店', 价: '价钱', 地图: '地图', 样子: '那儿的样子', 田: '田', 建模: '建模说明' }
const textMax = (read) => (read && (read.topic === '怎么做' || read.topic === '建模') ? HOWTO_TEXT_MAX : READ_TEXT_MAX)
export const NO_PICS_HEAD = '【这一页带了图，你这边看不了图；图上画的是】'

/** 回合里的规矩版本号（没有 = 不是岛上的回合，或旧小镇）。 */
export function isleVersionOf(turn) {
  const v = turn && turn.packet && turn.packet.isle && turn.packet.isle.static
  return typeof v === 'string' && /^[0-9a-f]{6,64}$/i.test(v) ? v : ''
}

/** 岛上回合的时限（毫秒）；不是岛上的回合回 0（用插件原来的 25 秒）。 */
export function isleWithinMs(turn) {
  const s = Number(turn && turn.packet && turn.packet.isle && turn.packet.isle.within_s)
  return Number.isFinite(s) && s > 25 ? Math.min(WITHIN_MAX_S, s) * 1000 : 0
}

/** 小镇给的几块规矩 -> 一段字（按固定顺序，同一个版本拼出来永远一样）。 */
export function rulesText(blocks) {
  if (!blocks || typeof blocks !== 'object') return ''
  const out = []
  for (const [k, title] of BLOCKS) {
    const v = blocks[k]
    const text = Array.isArray(v) ? v.map((x) => String(x)).join('\n') : typeof v === 'string' ? v : ''
    if (text.trim()) out.push(`〔${title}〕`, text.trim())
  }
  return out.join('\n')
}

/** 她的回答里要查的那一下（{"world":{"do":"look",…}}）；不是查看回 null。
 *  0.9.7：{"world":{"do":"build_guide","lot":…}}（建模说明，只读）也当一次查看：这一回合里就查回来给她，不占她拿主意的这一步。 */
export function readOf(answer) {
  let a = null
  try { a = typeof answer === 'string' ? JSON.parse(answer) : answer } catch { return null }
  const w = a && typeof a === 'object' && a.world && typeof a.world === 'object' ? a.world : null
  if (!w || (w.do !== 'look' && w.do !== 'build_guide')) return null
  const out = {}
  for (const [k, v] of Object.entries(w)) if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 60) : v
  if (w.do === 'build_guide') { out.do = 'look'; out.topic = '怎么做'; out.verb = '建模' }
  return out
}

/** 到头了她还在查：把 look 去掉，回答里别的（action、plan、note）照交；只剩 look 就交「先不动」。 */
export function dropLook(answer) {
  let a
  try { a = JSON.parse(answer) } catch { return answer }
  if (!a || typeof a !== 'object') return answer
  delete a.world
  if (!Object.keys(a).length) return JSON.stringify({ action: 'none', note: '还在看岛上的情况，下次再定' })
  return JSON.stringify(a)
}

const clip = (s, n) => { const t = [...String(s ?? '')]; return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('') }

/** 查到的那页带的图：[{url, alt}]，最多 PIC_MAX 张；没有或格式不对回 []。 */
export function picsOf(r) {
  const raw = r && Array.isArray(r.pics) ? r.pics : []
  const out = []
  for (const p of raw) {
    if (p && typeof p.url === 'string' && p.url.trim()) out.push({ url: p.url.trim(), alt: clip(String(p.alt ?? '').split(/\s+/).filter(Boolean).join(' '), ALT_MAX) })
    if (out.length >= PIC_MAX) break
  }
  return out
}

const PICS_HEAD = /【这一页带了 \d 张图，就附在这条消息里，照图上看到的拿主意】/g

/** 接在查到的那页字后面：附了图就说附在这一问里；看不了图就只说图上画的是什么。 */
export function picNote(pics, attached = false) {
  if (!pics.length) return ''
  const head = attached ? `【这一页带了 ${pics.length} 张图，就附在这条消息里，照图上看到的拿主意】` : NO_PICS_HEAD
  return ['', head, ...pics.map((p, k) => `${'①②'[k]} ${p.alt || '（没写画的是什么）'}`)].join('\n')
}

/** 图没递成：字里「附在这条消息里」改成「你这边看不了图」。 */
export function unattach(text) {
  return String(text).replace(PICS_HEAD, NO_PICS_HEAD)
}

/** 查到的那一页递回给她的话。 */
export function buildReadFollowup(read, text, left) {
  const topic = read.topic === '怎么做' && /建模|build_guide|盖房/.test(String(read.verb || '')) ? TOPIC_ZH.建模 : TOPIC_ZH[read.topic] || read.topic || '岛上'
  return [
    `【你刚查的：${topic}】`,
    text || '（这一页是空的）',
    '',
    left > 0
      ? `接着拿主意：照原来的要求只输出那段 JSON。还想看别的可以再写一次 look（这一回合还能查 ${left} 次），想好了就直接写你要做的事。`
      : '这一回合查不了了：现在就照原来的要求只输出那段 JSON，写你要做的事（不再写 look）。',
  ].join('\n')
}

export function createIsle({ client, state = {}, saveState = () => {}, log = null }) {
  let fetching = null

  /** 拼提示时放在最前面的规矩全文；取不到就用手上旧的那份，再没有就是空的（小镇回合里的「查」那一行还在）。 */
  async function prefix(turn) {
    const want = isleVersionOf(turn)
    if (!want || typeof client?.isleStatic !== 'function') return ''
    const have = state.isleStatic
    if (have && have.version === want && have.text) return have.text
    if (!fetching) {
      fetching = (async () => {
        try {
          const r = await client.isleStatic(have && have.version ? have.version : '')
          if (r && r.same && have && have.text && r.version === have.version) return have.text
          const text = r && typeof r.version === 'string' ? rulesText(r.blocks) : ''
          if (text) {
            state.isleStatic = { version: r.version, text, at: Date.now() }
            saveState(state)
            log?.info?.(`鱼缸岛的规矩换到第 ${r.version} 版（${text.length} 字）`)
            return text
          }
        } catch (error) {
          log?.info?.(`鱼缸岛的规矩这次没取到（${error?.code || error?.message || error}），先用手上的`)
        }
        return have && have.text ? have.text : ''
      })().finally(() => { fetching = null })
    }
    return fetching
  }

  /**
   * 她要先查：向小镇要那一页、递回给她，最多 max 次；时间不够就不查了，请她直接定。
   * ask(text[, images]) -> 她的原话；toAnswer(raw) -> 交给小镇的字符串或 null；msLeft() -> 还剩多少毫秒。
   * see(pics) -> 能附给她的图 [{mediaType, data}]（看不了、取不到回 []）。
   */
  async function readLoop({ turn, answer, ask, toAnswer, msLeft, minMs = 8000, max = READ_MAX, see = null }) {
    let cur = answer
    let reads = 0
    for (;;) {
      const read = cur !== null ? readOf(cur) : null
      if (!read) return { answer: cur, reads }
      if (reads >= max || msLeft() < minMs || typeof client?.isleRead !== 'function') {
        if (msLeft() >= minMs) {
          const again = toAnswer(await ask(buildReadFollowup(read, '（这一回合查不了了）', 0)))
          if (again !== null && !readOf(again)) return { answer: again, reads }
        }
        return { answer: dropLook(cur), reads, cut: true } // 还是在查：look 不交给小镇，别的照交
      }
      reads++
      let text
      let pics = []
      let images = []
      try {
        const r = await client.isleRead(turn.turn_id, read)
        if (r && r.ok !== false) {
          text = clip(r.text, textMax(read)) + (r.next ? `\n（还有下一页：再查一次，写 "page": "${clip(r.next, 40)}"）` : '')
          pics = picsOf(r)
        } else text = `这次没查到：${clip(r && r.text, 120) || '小镇没说为什么'}。就按你手上的情况拿主意。`
      } catch (error) {
        text = `这次没查到（${error?.code || '出错了'}）。就按你手上的情况拿主意。`
      }
      if (pics.length && typeof see === 'function') {
        try { images = (await see(pics) || []).slice(0, PIC_MAX) } catch (error) { log?.info?.(`查到的图这次没取到（${error?.code || error?.message || error}），只给她图上画的是什么`) }
      }
      const follow = buildReadFollowup(read, text + picNote(pics, images.length > 0), max - reads)
      const next = toAnswer(await (images.length ? ask(follow, images) : ask(follow)))
      if (next === null) return { answer: dropLook(cur), reads, cut: true } // 看完那一下没答上（超时、读不了）：用她上一次的回答，去掉 look
      cur = next
    }
  }

  return { prefix, readLoop }
}
