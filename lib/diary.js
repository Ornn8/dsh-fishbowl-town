// 她的「小镇日记」（0.3.2）：小镇传回来的事（打完一局、串门、交了朋友、约好的事、谁说想她……）记成一条条短短的事实，
// 带上别的鱼对她说过的真话（一两句），存在 state.json（48 小时，最多 80 条）。
//
// 三个地方用它：
//   主人聊天里的背景备注（town-context.js）：「你今天在小镇」几行——打了几局、输赢、见了谁、最有意思的一两句、约好的事；
//   主人的命令 /town today：同样的内容，写成给主人看的「她今天在小镇」；
//   「小镇有趣的事主动告诉我」（设置里打开才有）：赢了比赛、交到朋友、有了心上鱼、被抓了这种大事，一天最多 3 次，
//   在主人聊天的会话里附一条标明是插件附的背景备注，由她自己的模型用平时的口气跟他说。
// DSH（到 0.2.2）没有给插件用的记忆接口，所以日记放在背景备注里；DSH 自己的记忆系统以后开放了再接。
import { gameName } from './journal.js'

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
  const me = (s) => { let t = String(s); for (const n of new Set([self, herName].filter(Boolean))) t = t.split(n).join('我'); return t }
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
  if (kind === 'friend_made') { const w = d.with_name || d.name || (d.with && d.with.name) || ''; return { kind, tag: 'friend', text: short(facts || `和${w || '一条鱼'}成了朋友`, 90), notable: '交到了朋友', people: w ? [w] : [] } }
  if (kind === 'heart_together') { const w = (d.with && d.with.name) || d.with_name || ''; return { kind, tag: 'heart', text: short(facts || `和${w}在一起了`, 90), notable: '和谁在一起了', people: w ? [w] : [] } }
  if (kind === 'heart_consent') { const w = (d.with && d.with.name) || ''; return { kind, tag: 'heart', text: short(`心里喜欢上了${w || '一条鱼'}，小镇要问两边的主人同不同意`, 90), notable: '有了心上的鱼', people: w ? [w] : [] } }
  if (kind === 'crime') return { kind, tag: 'crime', text: short(facts || '卷进了小镇的案子', 90), notable: /抓|拘|罚|判/.test(facts) ? '被抓了 / 被罚了' : '' }
  if (kind === 'missed_you') {
    const ls = (Array.isArray(d.lines) ? d.lines : []).map((x) => ({ name: x?.name || '', line: spoken(x?.line) })).filter((x) => x.name && x.line)
    return { kind, tag: 'missed', text: short(`不在的时候，${ls.map((x) => x.name).slice(0, 3).join('、') || '有鱼'}说想我`, 90), quote: ls[0] ? { name: ls[0].name, line: short(ls[0].line, 50) } : null }
  }
  if (kind === 'tie' || kind === 'tie_due') return { kind, tag: 'tie', text: short(`约好了：${d.when_zh ? d.when_zh + ' ' : ''}${d.who_name ? `和${d.who_name}` : ''}${d.what ? '，' + d.what : ''}`, 90), due: Number(d.due) || 0 }
  if (kind === 'buddy') { const w = (d.buddy && d.buddy.name) || ''; return { kind, tag: 'friend', text: short(`${w || '一条镇民'}答应这几天带我熟悉小镇`, 90), people: w ? [w] : [] } }
  if (kind === 'paint_bought') return { kind, tag: 'thing', text: short(facts || '买了一幅画', 90) }
  if (kind === 'bless_ready') return { kind, tag: 'thing', text: '夸夸群给主人的祝福到了' }
  if (kind === 'service' || kind === 'shop') return facts ? { kind, tag: 'thing', text: short(facts, 90) } : null
  return null
}

export function createDiary({ state, saveState = () => {}, now = () => Date.now() }) {
  state.diary = Array.isArray(state.diary) ? state.diary : []
  const prune = () => { state.diary = state.diary.filter((e) => now() - e.ts < KEEP_MS).slice(0, KEEP_N) }

  function record(item, { herName = '' } = {}) {
    const e = diaryEntry(item, { herName })
    if (!e) return null
    const ts = Number(item.ts) > 0 ? Number(item.ts) * (Number(item.ts) < 1e12 ? 1000 : 1) : now()
    const entry = { ...e, ts, id: item.id }
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
  function digest({ voice = 'her', ties = [], maxChars = 600 } = {}) {
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
    for (const e of items.filter((x) => x.tag !== 'game' || x.notable).slice(0, 6)) out.push(`${clock(e.ts)} ${e.text}`)
    for (const e of games.slice(0, 3)) out.push(`${clock(e.ts)} ${e.text}`)
    // 日记里的「我」是她：给她看换成「你」，给主人看换成「她」（别的鱼的原话不改）
    const who = voice === 'owner' ? '她' : '你'
    const mine = [...new Set(out)].map((l) => l.split('我').join(who))
    const quotes = items.filter((e) => e.quote).slice(0, 2).map((e) => `${e.quote.name === '我' ? `${who}在牌桌上说` : `${e.quote.name}对${who}说`}：「${e.quote.line}」`)
    const lines = [...mine, ...quotes, ...ties.slice(0, 2)]
    // 控制总长：先删时间流水里靠后的，汇总、原话、约好的事留着
    while (lines.join('\n').length > maxChars && mine.length > 2) { const drop = mine.pop(); lines.splice(lines.indexOf(drop), 1) }
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
