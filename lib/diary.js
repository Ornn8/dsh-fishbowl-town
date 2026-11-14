// 她的「小镇日记」（0.3.2）：小镇传回来的事（打完一局、串门、交了朋友、约好的事、谁说想她……）记成一条条短短的事实，
// 带上别的鱼对她说过的真话（一两句），存在 state.json（48 小时，最多 80 条）。
//
// 三个地方用它：
//   主人聊天里的背景备注（town-context.js）：「你今天在小镇」几行——打了几局、输赢、见了谁、最有意思的一两句、约好的事；
//   主人的命令 /town today：同样的内容，写成给主人看的「她今天在小镇」；
//   「小镇有趣的事主动告诉我」（设置里打开才有）：赢了比赛、有了心上鱼、被抓了这种大事，一天最多 3 次，
//   在主人聊天的会话里附一条标明是插件附的背景备注，由她自己的模型用平时的口气跟他说。
// DSH（到 0.2.2）没有给插件用的记忆接口，所以日记放在背景备注里；DSH 自己的记忆系统以后开放了再接。
import { gameName } from './journal.js'
import { noMoney } from './events.js'

const KEEP_MS = 48 * 3600_000
const KEEP_N = 80
const DAY_MS = 24 * 3600_000

const short = (v, n = 60) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  const c = [...s]
  return c.length > n ? c.slice(0, n).join('') + '…' : s
}
/** 去掉括号里的动作描写（「（甩了甩尾巴）」），只留说的话。 */
const spoken = (v) => String(v ?? '').replace(/[（(][^）)]{0,40}[）)]/g, '').replace(/\*[^*]{0,40}\*/g, '').replace(/\s+/g, ' ').trim()

// 0.6.2：日记里「她自己」记成一个占位符 SELF（不再记成「我」），给她看换成「你」、给主人看换成「她」时只换占位符：
// 游戏名（《你画我猜》）、别的鱼的原话（「我，我替你泡一会儿」）里的你我她一个字都不动。
export const SELF = '\uE000'
const CJK = /[\u3400-\u9fff]/
const QUOTED = /《[^》]*》|「[^」]*」|“[^”]*”|『[^』]*』|"[^"]*"/g
/** 只改引号、书名号外面的字：fn(一段引号外的文字) -> 改好的文字。 */
export function outsideQuotes(text, fn) {
  const s = String(text ?? '')
  let out = ''
  let at = 0
  for (const m of s.matchAll(QUOTED)) { out += fn(s.slice(at, m.index)) + m[0]; at = m.index + m[0].length }
  return out + fn(s.slice(at))
}
/** 她的名字 -> SELF（引号外；一个字的名字只在至少一边不挨着汉字时才算，免得「一千分」里的「千」被换掉）。 */
export function selfName(text, names) {
  const list = [...new Set((names || []).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!list.length) return String(text ?? '')
  return outsideQuotes(text, (part) => {
    for (const n of list) {
      let res = ''
      let i = 0
      for (let j = part.indexOf(n); j >= 0; j = part.indexOf(n, j + n.length)) {
        const before = part[j - 1] || ''
        const after = part[j + n.length] || ''
        const ok = n.length > 1 || !CJK.test(before) || !CJK.test(after)
        res += part.slice(i, j) + (ok ? SELF : n)
        i = j + n.length
      }
      part = res + part.slice(i)
    }
    return part
  })
}
/** 小镇写给她的「你」（社交、拍照点歌的 facts）-> SELF（引号外）。 */
const youToSelf = (text) => outsideQuotes(text, (part) => part.split('你').join(SELF))
/** 显示：SELF -> 「你」/「她」。老版本记下的「我」（没有 v2 标记）也换，但只换引号外的。 */
export function renderSelf(text, who, legacy = false) {
  const s = String(text ?? '').split(SELF).join(who)
  return legacy ? outsideQuotes(s, (part) => part.split('我').join(who)) : s
}

/** 约好的时间，显示的那一刻再算（0.6.2：以前记的时候就写死成「明天 20:00」，第二天再看就错了）。 */
export function dueText(dueMs, nowMs) {
  const d = new Date(dueMs)
  const day = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime() }
  const diff = Math.round((day(dueMs) - day(nowMs)) / DAY_MS)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff === 0) return dueMs < nowMs ? `今天 ${hm}（已经过了）` : `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === 2) return `后天 ${hm}`
  if (diff < 0) return `${-diff} 天前`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
}
const toMs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : NaN }
/** 一件约好的事 -> 一行（显示时才算时间）；过了 3 小时以上的不再显示（返回 ''）。 */
export function tieLine({ due, when_zh: whenZh = '', who_name: who = '', what = '' } = {}, nowMs = Date.now()) {
  const ms = toMs(due)
  if (Number.isFinite(ms) && ms < nowMs - 3 * 3600_000) return ''
  const at = Number.isFinite(ms) ? dueText(ms, nowMs) : whenZh
  return `约好了：${at ? at + ' ' : ''}${who ? `和${who}` : ''}${what ? (who ? '，' : '') + what : ''}`
}

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 一条小镇事件 → 一条日记（没什么可记的返回 null）。text 不带人称，像「和阿鲸、豆豆打斗地主：赢了」。 */
export function diaryEntry(item, { herName = '' } = {}) {
  if (!item || typeof item !== 'object') return null
  const kind = String(item.kind || '')
  const d = item.data && typeof item.data === 'object' ? item.data : {}
  const self = String(d.as || herName || '')
  const me = (s) => selfName(s, [self, herName])
  const facts = me(short(d.facts || d.summary || d.text || d.title || '', 80))
  const names = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x?.name || '')).filter((n) => n && n !== herName)
  let text = ''
  let quote = null
  let notable = ''
  let tag = ''
  if (kind === 'digest') {
    tag = 'game'
    const g = d.game_name || d.game_zh || gameName(d.game) || '一局'
    const others = names(d.players || d.seats || d.with)
    const res = d.result === 'win' ? '赢了' : d.result === 'lose' ? '输了' : (d.result || d.outcome || '')
    const won = d.result === 'win' || d.won === true || /赢|胜|冠军/.test(String(res))
    const lost = d.result === 'lose' || d.won === false || /输|负/.test(String(res))
    const pts = d.points_delta != null ? `（积分 ${d.points_delta > 0 ? '+' : ''}${d.points_delta}）` : ''
    text = `${others.length ? `和${others.slice(0, 3).join('、')}` : ''}打${g}：${res || '打完了'}${pts}${facts ? `——${short(facts, 50)}` : ''}`
    if (/冠军|夺冠|锦标赛|决赛/.test(facts + res)) notable = '赢了比赛'
    // 牌桌上的高光（town：digest.highlights[]，line 是她自己说的）：记成她的高光一句
    const hl = (Array.isArray(d.highlights) ? d.highlights : []).map((h) => spoken(h?.line)).find(Boolean)
    if (hl) quote = { name: '我', line: short(hl, 50) }
    return { kind, tag, text: short(text, 90), quote, notable, won, lost, game: g, people: others.slice(0, 4) }
  }
  if (kind === 'visit') {
    tag = 'visit'
    const who = (d.with && d.with.name) || d.with_name || d.other || d.target_name || ''
    const where = d.place_name || d.place_zh || d.place || ''
    if (d.state && !['done', 'ended', 'finished'].includes(d.state) && !facts) return null
    text = `${who ? `和${who}` : ''}串门${where ? `（${where}）` : ''}${facts ? `：${short(facts, 60)}` : ''}`
    const dlg = [...(Array.isArray(d.quotes) ? d.quotes : []), ...(Array.isArray(d.dialogue) ? d.dialogue : [])]
    // town：data.dialogue 是整段串门对话（{fish_id, name, role, text}，kind=outcome 的不是话）；挑对方说的最长一句
    const others = dlg.filter((x) => x && x.kind !== 'outcome')
      .filter((x) => (d.role && x.role ? x.role !== d.role : (x.name || x.who) && (x.name || x.who) !== herName && (x.name || x.who) !== self))
      .map((x) => ({ name: x.name || x.who || '', line: spoken(String(x.line || x.text || x.say || '').replace(/【[^】]{0,40}】/g, '')) }))
      .filter((x) => x.name && x.line.length >= 4)
      .sort((a, b) => b.line.length - a.line.length)
    if (others[0]) quote = { name: others[0].name, line: short(others[0].line, 60) }
    return { kind, tag, text: short(me(text), 90), quote, notable, people: who ? [who] : [] }
  }
  if (kind === 'highlight') {
    const line = spoken(d.line)
    return { kind, tag: 'moment', text: short(me(d.facts || d.what || '牌桌上的一个高光时刻'), 70), quote: line ? { name: '我', line: short(line, 50) } : null }
  }
  // 0.6.2：小镇不再发「和X一起玩过N次，越来越熟了」（太空了，主人看到的恰好是最空的东西）；老小镇还发的也不记
  if (kind === 'friend_made') return null
  if (kind === 'heart_together') { const w = (d.with && d.with.name) || d.with_name || ''; return { kind, tag: 'heart', text: short(facts || `和${w}在一起了`, 90), notable: '和谁在一起了', people: w ? [w] : [] } }
  if (kind === 'heart_consent') { const w = (d.with && d.with.name) || ''; return { kind, tag: 'heart', text: short(`心里喜欢上了${w || '一条鱼'}，小镇要问两边的主人同不同意`, 90), notable: '有了心上的鱼', people: w ? [w] : [] } }
  if (kind === 'crime') return { kind, tag: 'crime', text: short(facts || '卷进了小镇的案子', 90), notable: /抓|拘|罚|判/.test(facts) ? '被抓了 / 被罚了' : '' }
  if (kind === 'missed_you') {
    const ls = (Array.isArray(d.lines) ? d.lines : []).map((x) => ({ name: x?.name || '', line: spoken(x?.line) })).filter((x) => x.name && x.line)
    return { kind, tag: 'missed', text: short(`不在的时候，${ls.map((x) => x.name).slice(0, 3).join('、') || '有鱼'}提起了${SELF}`, 90), quote: ls[0] ? { name: ls[0].name, line: short(ls[0].line, 50) } : null }
  }
  // 0.6.2：时间不写死在文字里，显示时按 due 再算（tieLine）
  if (kind === 'tie' || kind === 'tie_due') return { kind, tag: 'tie', text: short(tieLine(d), 90), due: Number(d.due) || 0, tie: { due: d.due, when_zh: d.when_zh || '', who_name: d.who_name || '', what: short(d.what || '', 40) } }
  if (kind === 'buddy') { const w = (d.buddy && d.buddy.name) || ''; return { kind, tag: 'friend', text: short(`${w || '一条镇民'}答应这几天带${SELF}熟悉小镇`, 90), people: w ? [w] : [] } }
  if (kind === 'paint_bought') return { kind, tag: 'thing', text: short(facts || '买了一幅画', 90) }
  if (kind === 'bless_ready') return { kind, tag: 'thing', text: '夸夸群给主人的祝福到了' }
  if (kind === 'service' || kind === 'shop') return facts ? { kind, tag: 'thing', text: short(facts, 90) } : null
  // 0.4.0：她为朋友花的钱、拍的照、点的歌、小手机里的消息。日记会进主人聊天的背景备注，所以这里不写价格、余额、预算（她从不跟主人提钱）
  const mine = (s) => me(short(youToSelf(noMoney(String(s || ''))), 80))
  if (kind === 'social') {
    if (d.what === 'refused' || d.ok === false) return null // 没花成（预算、余额）：只在她自己的日记本（journal）里，不进给主人的备注
    const t = mine(d.facts || d.summary || d.text)
    return t ? { kind, tag: 'social', text: short(t, 90), people: [] } : null
  }
  if (kind === 'media') {
    const what = String(d.what || '')
    const t = mine(d.facts) || (/_failed$/.test(what) ? '有一样东西没做成' : '')
    if (!t) return null
    const gift = what === 'song_for_you' || what === 'paint_for_you'
    return { kind, tag: 'media', text: short(t, 90), notable: gift ? (what === 'song_for_you' ? '有鱼给她点了一首歌' : '有鱼请人给她画了一张画') : '', people: [] }
  }
  if (kind === 'town_news') {
    // 0.5.0：改名（她认识的鱼换了名字，还是那条鱼）/ 她报的 BUG 被修好了 / 作者说是规则
    const t = mine(d.facts)
    if (!t) return null
    const who = (d.other && d.other.name) || d.new || ''
    return { kind, tag: d.what === 'renamed' ? 'friend' : 'thing', text: short(t, 90), notable: d.what === 'bug_fixed' ? '报的BUG被修好了' : '', people: who ? [who] : [] }
  }
  if (kind === 'phone') {
    const who = (d.from && d.from.name) || ''
    const said = spoken(d.text)
    if (!who && !said) return null
    return { kind, tag: 'phone', text: short(`${who || '有鱼'}用小手机给${SELF}发了消息${d.meet ? '，还约了见面' : ''}`, 90), quote: said ? { name: who || '有鱼', line: short(said, 60) } : null, people: [] }
  }
  return null
}

export function createDiary({ state, saveState = () => {}, now = () => Date.now() }) {
  state.diary = Array.isArray(state.diary) ? state.diary : []
  const prune = () => { state.diary = state.diary.filter((e) => now() - e.ts < KEEP_MS).slice(0, KEEP_N) }

  function record(item, { herName = '' } = {}) {
    const e = diaryEntry(item, { herName })
    if (!e) return null
    const ts = Number(item.ts) > 0 ? Number(item.ts) * (Number(item.ts) < 1e12 ? 1000 : 1) : now()
    const entry = { ...e, ts, id: item.id, v: 2 } // v2：她自己记成 SELF（老的记成「我」）
    if (state.diary.some((x) => x.id != null && x.id === item.id)) return null
    state.diary.unshift(entry)
    prune()
    saveState(state)
    return entry
  }
  /** 主人让她做的、她自己去做的（自助大厅）也记一笔。 */
  function note(text, tag = 'self') {
    state.diary.unshift({ kind: 'self', tag, text: short(text, 90), ts: now() })
    prune()
    saveState(state)
  }

  const today = () => state.diary.filter((e) => now() - e.ts < DAY_MS)

  /** 今天的几行事实（给背景备注 / /town today 共用）。voice='her'：对她说「你」；'owner'：对主人说「她」。 */
  function digest({ voice = 'her', ties = [], maxChars = 600, maxLines = 0 } = {}) {
    const items = today()
    if (!items.length && !ties.length) return []
    const games = items.filter((e) => e.tag === 'game')
    const won = games.filter((e) => e.won).length
    const lost = games.filter((e) => e.lost).length
    const people = [...new Set(items.flatMap((e) => e.people || []))].slice(0, 6)
    const out = []
    if (games.length) {
      const kinds = [...new Set(games.map((e) => e.game).filter(Boolean))]
      out.push(`打了 ${games.length} 局${kinds.length ? `（${kinds.slice(0, 4).join('、')}）` : ''}${won || lost ? `，赢 ${won} 输 ${lost}` : ''}`)
    }
    if (people.length) out.push(`见了：${people.join('、')}`)
    const who = voice === 'owner' ? '她' : '你'
    // 约好的事：显示这一刻再算时间，已经过了的不再列；她自己（SELF）给她看是「你」、给主人看是「她」，游戏名和别的鱼的原话不动
    const said = (e) => renderSelf(e.tag === 'tie' && e.tie ? tieLine(e.tie, now()) : e.text, who, e.v !== 2)
    for (const e of items.filter((x) => x.tag !== 'game' || x.notable).slice(0, 6)) { const t = said(e); if (t) out.push(`${clock(e.ts)} ${t}`) }
    for (const e of games.slice(0, 3)) out.push(`${clock(e.ts)} ${said(e)}`)
    const mine = [...new Set(out)]
    const quotes = items.filter((e) => e.quote).slice(0, 2).map((e) => `${e.quote.name === '我' ? `${who}在牌桌上说` : `${e.quote.name}对${who}说`}：「${e.quote.line}」`)
    const lines = [...mine, ...quotes, ...ties.slice(0, 2)]
    // 控制总长：先删时间流水里靠后的，汇总、原话、约好的事留着
    while (lines.join('\n').length > maxChars && mine.length > 2) { const drop = mine.pop(); lines.splice(lines.indexOf(drop), 1) }
    // 0.6.1：给她的背景备注只要几行（主人反馈接入小镇后鱼话太多）：汇总（打了几局、见了谁）+ 一句原话，没有原话就补最新的一件事
    if (maxLines > 0 && lines.length > maxLines) {
      const head = mine.slice(0, (games.length ? 1 : 0) + (people.length ? 1 : 0))
      return [...head, ...quotes.slice(0, 1), ...mine.slice(head.length), ...ties.slice(0, 2)].slice(0, maxLines)
    }
    return lines
  }

  /** 主动告诉主人：今天还剩几次（一天最多 3 次，两次之间至少 1 小时）。 */
  function mayTell() {
    const sent = (state.toldOwner || []).filter((t) => now() - t < DAY_MS)
    state.toldOwner = sent
    return sent.length < 3 && (!sent.length || now() - Math.max(...sent) > 3600_000)
  }
  function told() { state.toldOwner = [...(state.toldOwner || []), now()]; saveState(state) }

  return { record, note, today, digest, mayTell, told }
}
