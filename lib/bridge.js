// 0.8.2「两边是同一个她」（主人 11-17：用户说小镇里的是分身；方案 docs/MEMORY-BRIDGE-0.8.2.md）：
//   主聊天 → 小镇：她和主人最近的几句先过滤（scrubLife），只给她自己心里知道；
//   回声检查（echoHits）：她在小镇说出去的话，和带进去的主聊天内容比字，连着 6 个汉字一样、或同一串 4 位以上数字，就算说漏了；
//   小镇 → 主聊天：一次串门、一局牌的经过（recapVisit / recapGame），由代码整理，不调模型。
// 这里只有纯函数，测试见 test/bridge.test.js。

export const ECHO_RUN = 6 // 连着几个汉字一样算说漏
export const DIGITS_RUN = 4 // 几位以上的数字一样算说漏
export const LIFE_MAX = 400 // 带进小镇的主聊天内容一共多少字
export const VISIT_RECAP_MAX = 300
export const GAME_RECAP_MAX = 150

const CJK = /[㐀-鿿豈-﫿]/
const str = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n - 1).join('') + '…' : t }

/** 一段话去掉网址、邮箱、@谁、4 位以上的数字串（scrubLife 每行用的同一套；0.9.18 起「小镇打算」也过一遍）。 */
export function scrubText(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/gi, '（链接）')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '（邮箱）')
    .replace(/[@＠][^\s，。！？、,.!?]{1,20}/g, '（某人）')
    .replace(/\d[\d\s-]{2,}\d/g, (m) => (m.replace(/\D/g, '').length >= DIGITS_RUN ? '（一串数字）' : m))
    .trim()
}

/** 进小镇之前：去掉网址、邮箱、@谁、4 位以上的数字串（QQ 号、手机号、门牌、金额……），再控制总长。行的样子不变（「主人（5 分钟前）：……」）。 */
export function scrubLife(lines, { max = LIFE_MAX } = {}) {
  const out = []
  let used = 0
  for (const raw of Array.isArray(lines) ? lines : []) {
    let s = String(raw ?? '')
    const head = s.match(/^[^：:]{1,16}[：:]/)
    const prefix = head ? head[0] : ''
    const body = scrubText(s.slice(prefix.length))
    if (!body) continue
    s = prefix + body
    const n = [...s].length
    if (used + n > max) { if (!out.length) out.push(str(s, max)); break }
    out.push(s)
    used += n
  }
  return out
}

/** 只留汉字（标点、空格、字母都去掉），比字用。 */
function hanzi(text) {
  return [...String(text ?? '')].filter((ch) => CJK.test(ch)).join('')
}

/** 私密内容里所有连着 ECHO_RUN 个汉字的片段 + 4 位以上的数字串。allow：这一轮小镇材料里本来就有的字（别的鱼说过、游戏用语），不算说漏。 */
export function echoIndex(privateLines, { allow = '' } = {}) {
  const runs = new Set()
  const digits = new Set()
  const allowed = hanzi(allow)
  for (const line of Array.isArray(privateLines) ? privateLines : []) {
    const raw = String(line ?? '')
    const body = raw.replace(/^[^：:]{1,16}[：:]/, '') // 「主人（5 分钟前）：」这一截不算
    const h = hanzi(body)
    for (let i = 0; i + ECHO_RUN <= h.length; i++) {
      const w = h.slice(i, i + ECHO_RUN)
      if (!allowed.includes(w)) runs.add(w)
    }
    for (const m of body.match(/\d{4,}/g) || []) if (!String(allow).includes(m)) digits.add(m)
  }
  return { runs, digits, empty: !runs.size && !digits.size }
}

/** 一段话里撞上的片段（空数组 = 没说漏）。 */
export function textHits(text, index) {
  if (!index || index.empty) return []
  const found = new Set()
  const h = hanzi(text)
  for (let i = 0; i + ECHO_RUN <= h.length; i++) {
    const w = h.slice(i, i + ECHO_RUN)
    if (index.runs.has(w)) found.add(w)
  }
  for (const m of String(text ?? '').match(/\d{4,}/g) || []) if (index.digits.has(m)) found.add(m)
  return [...found]
}

/** 她这一轮的回答（一句话，或一段 JSON 字符串）里撞上的片段 + 去掉那几句以后的回答。
 * format = 'text'：撞上就整句不说（''）；JSON：撞上的那几个字符串字段换成 ''，别的（出的牌、投的票）照旧。 */
export function echoCheck(answer, index, { format = 'json' } = {}) {
  if (answer == null || !index || index.empty) return { hits: [], clean: answer }
  if (format === 'text') {
    const hits = textHits(answer, index)
    return { hits, clean: hits.length ? '' : answer }
  }
  let obj
  try { obj = JSON.parse(answer) } catch { const hits = textHits(answer, index); return { hits, clean: answer } }
  const hits = new Set()
  const walk = (v) => {
    if (typeof v === 'string') {
      const h = textHits(v, index)
      if (h.length) { for (const x of h) hits.add(x); return '' }
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o }
    return v
  }
  const cleaned = walk(obj)
  return hits.size ? { hits: [...hits], clean: JSON.stringify(cleaned) } : { hits: [], clean: answer }
}

/** 撞上了：请那边换个说法重答一次（不把撞上的字再写一遍）。 */
export function buildEchoCorrection() {
  return '刚才的回答里带出了你和主人之间的事（他在忙的事、他说过的话、你们的私事），镇上别的鱼都看得见。重答：那些事一件都不提，换个说法、打比方也不行；别人问起主人就说「他挺好的」，换个话题；别的照旧，只输出和刚才同样格式的回答。'
}

const who = (r) => str(r && (r.name || r.fish_name || r.speaker || r.fish_id) || '', 14)

/** 一次串门的经过（主聊天里的她看）：谁来找谁、在哪、她说的话优先，再补别人的话，加上结尾，不超过 VISIT_RECAP_MAX 字。
 * one = 小镇 visits/<id> 的回答 {visit, dialogue}；herNames = 她在小镇用过的名字（认哪几句是她说的）。 */
export function recapVisit(one, { herNames = [], max = VISIT_RECAP_MAX } = {}) {
  const v = (one && one.visit) || {}
  const rows = (Array.isArray(one && one.dialogue) ? one.dialogue : []).filter((r) => r && typeof r.text === 'string' && r.text.trim())
  const names = new Set((Array.isArray(herNames) ? herNames : []).map(String).filter(Boolean))
  // 小镇每一句带 role（guest / host），visit.role 是她自己的那一边；旧小镇没有 role 就按名字认
  const mine = (r) => (v.role && r.role ? r.role === v.role : names.has(String(r.name || r.fish_name || '')))
  const other = str(typeof v.with === 'string' ? v.with : v.with && (v.with.name || v.with.fish_id) || '', 14) || '那条鱼'
  // 0.9.14 岛上路上碰到聊的（小镇 isle_meet.py，place 'isle'）：不是谁去找谁，是走着碰到了
  const meet = v.place === 'isle'
  const where = meet ? String(v.place_name || '').replace(/[（(]\s*约\s*[\d.]+\s*米\s*[）)]/g, '').trim() : ''
  const place = v.place === 'home' ? (v.role === 'host' ? '在你家' : `在${other}家`) : `在${v.place_name || v.place || '镇上'}`
  const head = meet ? `你在${where || '岛上'}碰到${other}，站着${rows.length ? `聊了 ${rows.length} 句` : '打了个招呼'}`
    : `${v.role === 'host' ? `${other}来找你` : `你去找${other}`}，${place}${rows.length ? `，聊了 ${rows.length} 句` : ''}`
  if (!rows.length) return str(`${head}${v.summary ? `（${v.summary}）` : meet ? '' : '，没聊上'}`, max)
  // 留哪几句：开头一句、她说的、最后两句；按原来的顺序
  const keep = new Set([0, rows.length - 1, rows.length - 2].filter((i) => i >= 0))
  rows.forEach((r, i) => { if (mine(r)) keep.add(i) })
  const picked = [...keep].sort((a, b) => a - b)
  const said = (r) => `${mine(r) ? '你' : who(r) || '对方'}：「${str(r.text, 40)}」`
  const tail = v.ending ? `；结尾：${str(v.ending, 40)}` : ''
  let lines = picked.map((i) => said(rows[i]))
  const build = () => `${head}。${lines.join(' ')}${tail}`
  // 太长：先去掉别人说的（开头最后那几句以外），再去掉她自己较早的几句
  while ([...build()].length > max && lines.length > 2) {
    const drop = picked.findIndex((i, k) => k > 0 && k < picked.length - 2 && !mine(rows[i]))
    const at = drop >= 0 ? drop : 1
    picked.splice(at, 1)
    lines = picked.map((i) => said(rows[i]))
  }
  return str(build(), max)
}

/** 一局牌的经过：哪一局、结果、她出的几手和说的话（本子里的那局），不超过 GAME_RECAP_MAX 字。 */
export function recapGame(g, { max = GAME_RECAP_MAX } = {}) {
  if (!g || typeof g !== 'object') return ''
  const moves = Array.isArray(g.moves) ? g.moves : []
  const says = moves.map((m) => m && m.say).filter(Boolean)
  const plays = moves.map((m) => m && m.play).filter(Boolean)
  const parts = [`${g.title || '一局'}${g.result ? `：${g.result}` : ''}`]
  if (plays.length) parts.push(`你出了 ${plays.length} 手（${plays.slice(-3).join('、')}${plays.length > 3 ? '……' : ''}）`)
  if (says.length) parts.push(`你说过：${says.slice(-2).map((s) => `「${s}」`).join('')}`)
  return str(parts.join('；'), max)
}
