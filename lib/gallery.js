// 0.9.19 画廊上岛（协调 11-25；接口见共享笔记「画廊上岛-接口说明-1126.md」第四节、第七节 7.2 / 7.3）：
//   - 试画先报价（岛上回 code: "quoted"，带报价号 G-…），插件记下报价号和时间；她写 {"do":"gallery_confirm"} 时插件核对主人在聊天里、
//     报价以后亲口点头（和交楼、确认一样，只认他自己打的字），过了才调 isle/gallery/confirm，那时才扣鲸币。
//   - 主人发的图当参考图：插件记下他最近发的图（只记 DSH 附件的引用，不存图）；她写 "ref":"主人的图" 时插件传上去，换成 u_ 号再交岛上。
//   - 主人打分：照片洗好了（media 事件 photo_done）30 分钟内，主人一句「4 星」「⭐⭐⭐⭐」，插件替他打给小镇（photo/rate）。
// 小镇没开（404、画廊还没开）时不出声：她看到的只是「画廊还没开」，打分的话插件什么都不说。
// 这里只有记账和认字，没有网络；网络在 isle-tools.js（确认、上传）和 index.js（打分）。

export const QUOTE_RE = /^G-[0-9a-f]{10}$/i
export const QUOTE_FOR_MS = 2 * 3600_000 // 小镇：报价过了 2 小时作废（old）
export const PIC_FOR_MS = 30 * 60_000 // 主人发的图：30 分钟里能拿来当参考图
export const RATE_FOR_MS = 30 * 60_000 // 照片洗好后 30 分钟里他说的「4 星」才算打分（和托管鱼的机器人同一个规矩）
export const UPLOAD_MAX = 8 * 1024 * 1024
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const KEEP = 5

/** 她写的 ref 是不是「主人发的那张图」（u_ / r_ / al_ 开头的号不是）。 */
export function isOwnerPicRef(ref) {
  const t = String(ref ?? '').trim()
  if (!t || /^(u|r|al)_/i.test(t)) return false
  return /^(主人|owner)/i.test(t) || /^(他|你)(发|给)的?(那张)?(图|照片|图片)/.test(t)
}

// 试画的点头话：交楼那套（cobuild.isYes）之外再认「画吧」「就画」「试一次」；「不画」「别画」不算（岛上会再用同一套规矩过一遍）
export const GALLERY_YES = /画吧|画了吧|就画|可以画|去画|开画|画一(张|幅|下)|那就画|试(一下|一次|吧)|试试|就试/
export const GALLERY_NO = /[不别]画|不用画|[不别]试|先别/

const ZH_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
const STAR_RE = /^(?:给你?|打)?\s*([1-5一二两三四五])\s*颗?\s*(?:星|分)\s*(?:吧|啦|了|哦|呀|[!！。.~～])*$/
const STAR_EMOJI_RE = /^[⭐★🌟]{1,5}$/u

/** 主人这句话是不是给照片打分：「4 星」「4分」「四星」「给你 5 星」「⭐⭐⭐⭐」 -> 1–5；别的（「4 分钟到」「我给 4 星好评吗？」）-> 0。 */
export function starsOf(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t || [...t].length > 12) return 0
  if (STAR_EMOJI_RE.test(t.replace(/\s/g, ''))) return [...t.replace(/\s/g, '')].length
  const m = STAR_RE.exec(t)
  if (!m) return 0
  const n = ZH_NUM[m[1]] || Number(m[1])
  return n >= 1 && n <= 5 ? n : 0
}

/** user/message 里主人发的图：DSH 附件服务的引用（{type:'image', attachment}），最多 4 张。 */
export function imageRefsOf(message) {
  const c = message && message.content
  if (!Array.isArray(c)) return []
  return c.filter((b) => b && b.type === 'image' && b.attachment && typeof b.attachment === 'object').map((b) => b.attachment).slice(0, 4)
}

/** 一条鱼的画廊账本（存在她的 state.gallery 里：报价、主人最近发的图的引用、最近洗好的照片）。 */
export function createGallery({ state, saveState = () => {}, now = () => Date.now() }) {
  const g = () => {
    const x = state.gallery && typeof state.gallery === 'object' ? state.gallery : (state.gallery = {})
    if (!Array.isArray(x.quotes)) x.quotes = []
    if (!x.pics || typeof x.pics !== 'object') x.pics = {}
    if (!Array.isArray(x.photos)) x.photos = []
    return x
  }
  const save = () => { try { saveState(state) } catch { /* 下次再存 */ } }
  return {
    /** 岛上回了报价（code: "quoted"）：记下报价号、价、时间。别的回执不管。 */
    quoted(r) {
      if (!r || r.code !== 'quoted' || !QUOTE_RE.test(String(r.quote || ''))) return null
      const x = g()
      const q = { quote: String(r.quote), coin: Number(r.coin) || 0, at: now() }
      x.quotes = [...x.quotes.filter((o) => o.quote !== q.quote), q].slice(-KEEP)
      save()
      return q
    },
    /** 要确认的那个报价：写了号就找那个号，没写就是最近一个；过了 2 小时的不算。 */
    quote(id = '') {
      const want = String(id || '').trim()
      const live = g().quotes.filter((o) => now() - o.at < QUOTE_FOR_MS)
      return (want ? live.find((o) => o.quote.toLowerCase() === want.toLowerCase()) : live[live.length - 1]) || null
    },
    /** 确认成了：这个报价不再等。 */
    confirmed(id) {
      const x = g()
      x.quotes = x.quotes.filter((o) => o.quote !== id)
      save()
    },
    /** 主人在这个会话里发了图（他亲手发的那条）：记下引用。 */
    ownerPics(sid, refs) {
      const s = String(sid || '')
      if (!s || !Array.isArray(refs) || !refs.length) return
      const x = g()
      x.pics[s] = { at: now(), refs: refs.slice(0, 4) }
      for (const k of Object.keys(x.pics)) if (now() - (x.pics[k]?.at || 0) > PIC_FOR_MS) delete x.pics[k]
      save()
    },
    /** 这个会话里主人 30 分钟内发的最后一张图的引用，没有就 null。 */
    latestPic(sid) {
      const p = g().pics[String(sid || '')]
      if (!p || now() - p.at > PIC_FOR_MS || !p.refs?.length) return null
      return p.refs[p.refs.length - 1]
    },
    /** 一张照片洗好了（media 事件 photo_done）。 */
    photoDone(orderId) {
      const id = String(orderId || '')
      if (!id) return
      const x = g()
      x.photos = [...x.photos.filter((p) => p.order_id !== id), { order_id: id, at: now() }].slice(-KEEP)
      save()
    },
    /** 主人现在说「4 星」打的是哪一张：30 分钟内洗好的最近一张，没有就 ''。 */
    rateTarget() {
      const p = g().photos.filter((o) => now() - o.at < RATE_FOR_MS)
      return p.length ? p[p.length - 1].order_id : ''
    },
    /** 主人这句话要不要替他打分：是「4 星」这类、30 分钟内有洗好的照片 -> {orderId, score}；不是 -> null。 */
    ratingFor(text) {
      const score = starsOf(text)
      const orderId = score ? this.rateTarget() : ''
      return orderId ? { orderId, score } : null
    },
    /** 打上了：记下几星（同一张再打就是改，小镇 24 小时内认）。 */
    rated(orderId, score) {
      const x = g()
      const p = x.photos.find((o) => o.order_id === orderId)
      if (p) { p.stars = score; p.ratedAt = now(); save() }
    },
  }
}

/** index.js 会话事件里主人在你们聊天的会话亲手发的这一条交进来：记下他发的图（引用）；照片洗好 30 分钟里一句「4 星」替他打给小镇。
 * client() = 现在的小镇客户端（没在值班是 null）；textOf(m) = 他自己打的字。小镇还没开打分（404 之类）：不出声。回 Promise（测试用）或 null。 */
export function createOwnerSaid({ gallery, isOwnerChat, client, textOf, log = null }) {
  return (sid, m) => {
    if (!isOwnerChat(sid)) return null
    const refs = imageRefsOf(m)
    if (refs.length) gallery.ownerPics(sid, refs)
    const rate = gallery.ratingFor(textOf(m))
    const c = client()
    if (!rate || !c || typeof c.photoRate !== 'function') return null
    return c.photoRate(rate).then((r) => {
      if (r && r.ok !== false) { gallery.rated(rate.orderId, rate.score); log?.info?.(`主人给照片打了 ${rate.score} 星`) }
      return r
    }).catch((error) => { log?.debug?.('照片打分没交上（小镇还没开打分就不管）：', error?.message || error); return null })
  }
}
