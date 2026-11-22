// 0.9.13 插件页「她的心思」（用户 11-23「现在我想看心思那个会话我得往下翻两百条手动置顶」）：
// 她最近 30 次在「鱼缸小镇 · 心思」会话里拿的主意——什么时候、为什么叫她、她定了什么、她自己说的那一句、小镇办没办成。
// 只存在这台电脑上她自己的目录里（mind.json，最多 30 条，新的在前）；不上传，不存接入码和别的钥匙（写进去之前先 redact）。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ACTION_ZH, PIER_ZH, SIDE_ZH, gameName } from './journal.js'
import { redact } from './redact.js'

export const MIND_KEEP = 30
const TEXT_MAX = 80

// 小镇叫她拿主意的理由（packet.reasons），说成主人看得懂的话
export const REASON_ZH = {
  wake: '她自己定的时间到了', pulled: '她这边请小镇叫她', wish: '主人托了话', errand: '答应主人的事',
  heart: '心上的事', invited: '有鱼邀请她', promise_due: '约好的事到点了', challenged: '有鱼向她下战书', meet_ask: '有鱼约她见面',
  phone: '小手机有新消息', table: '有桌子在等人', short: '有一桌差一两个人', theme: '今晚的主题之夜', game_over: '刚打完一局',
  friend: '朋友在镇上', visit: '可以去串门', buddy: '有新来的鱼想找人带', venue: '自己店里的事', ad: '店里的事', idle: '没什么事，到点看一眼',
  fcode: '想写个游戏', ro: '镇上的投票、评价', home: '在家', back: '刚回到家', make_ready: '她做的东西好了', world: '主题镇有事叫她',
}
// 主聊天拿主意（chat-decide.js）时小镇会话的角色
export const ROLE_ZH = {
  execute: '照她在聊天里定的打算去办', rules: '有件事要马上回，按她的规矩先答', wake: '她自己定的时间到了',
  pull: '她刚在聊天里说要去小镇', fallback: '聊天里两次没顾上回，这次小镇那边先定',
}
export const THINK_WHY = '插件隔一阵请她想想接下来去哪、做什么'
// 地方和「到点去办」里常见的几个词（她写的是代号）
const PLACE_ZH = { pier: '码头', arcade: '电玩城', home: '家', court: '镇政府' }
const STEP_ZH = { rest: '歇着', home: '回家', sleep: '睡觉', none: '歇着' }
const MISS_ZH = { queue: '排队等太久，没赶上', model: '她的模型没在时限内答完', invalid: '答案读不了', unsafe: '没拿到干净的小镇会话' }

const clip = (s, n = TEXT_MAX) => { const t = [...redact(String(s ?? '')).replace(/\s+/g, ' ').trim()]; return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('') }

/** 为什么叫她：小镇给的理由 + 这一步的角色，几个词。 */
export function whyText(turn, role = '') {
  const reasons = Array.isArray(turn?.packet?.reasons) ? turn.packet.reasons.map(String) : []
  const words = []
  if (role && ROLE_ZH[role]) words.push(ROLE_ZH[role])
  for (const r of reasons) { const w = REASON_ZH[r] || r; if (w && !words.includes(w)) words.push(w) }
  return clip(words.slice(0, 4).join('、') || '小镇到点叫她拿主意', 60)
}

/** 她定了什么：动作（对象）、岛上的事、打算、多久再想、到点去办的几件事。不含她自己的那句话（line 另放）。 */
export function didText(a) {
  if (!a || typeof a !== 'object') return ''
  const act = String(a.action || 'none')
  const what = act === 'none' ? '先不动' : (ACTION_ZH[act] || act)
  const obj = [gameName(a.game), a.target, PLACE_ZH[a.place] || a.place, a.activity_id || a.activity, a.pier && typeof a.pier === 'object' ? PIER_ZH[a.pier.do] || a.pier.do : '', a.arcade && typeof a.arcade === 'object' ? a.arcade.machine : '']
    .filter((x) => typeof x === 'string' && x).map((x) => clip(x, 16))
  const parts = [`${what}${obj.length ? `（${obj.join(' · ')}）` : ''}`]
  const w = a.world && typeof a.world === 'object' ? a.world : null
  if (w && w.do && w.do !== 'look') {
    const bits = ['place', 'item', 'target', 'lot', 'shop', 'what', 'to'].map((k) => w[k]).filter((x) => typeof x === 'string' && x).slice(0, 2)
    parts.push(`岛上：${clip([w.do, ...bits].join(' '), 30)}`)
  }
  const side = Object.keys(SIDE_ZH).filter((k) => a[k] != null && a[k] !== false && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length)).map((k) => SIDE_ZH[k])
  if (side.length) parts.push(`还${side.slice(0, 3).join('、')}`)
  const plan = a.plan && typeof a.plan === 'object' ? a.plan : null
  if (plan && plan.doing) parts.push(`打算「${clip(plan.doing, 30)}」`)
  const hours = Number(plan && plan.hours)
  const wake = Number(a.next_wake)
  if (Number.isFinite(hours) && hours > 0) parts.push(`${hours < 1 ? Math.round(hours * 60) + ' 分钟' : Math.round(hours * 10) / 10 + ' 小时'}后再想`)
  else if (Number.isFinite(wake) && wake > 0) parts.push(`${Math.round(wake)} 分钟后再想`)
  const steps = plan && Array.isArray(plan.steps) ? plan.steps.filter((s) => s && typeof s === 'object') : []
  if (steps.length) parts.push(`到点去办 ${steps.length} 件事（${steps.slice(0, 3).map((s) => clip([ACTION_ZH[s.do] || STEP_ZH[s.do] || s.do, s.game ? gameName(s.game) : '', s.target || ''].filter(Boolean).join(' '), 14)).join('、')}）`)
  return clip(parts.join('，'), 120)
}

/** 她自己的那一句：note（心思）> say（说出口的）> intent（想干嘛）。 */
export function lineOf(a) {
  if (!a || typeof a !== 'object') return ''
  for (const k of ['note', 'say', 'intent', 'want']) if (typeof a[k] === 'string' && a[k].trim()) return clip(a[k])
  return ''
}

/** 小镇的回执（交了以后小镇替她办的结果）-> 「成了：…」「没成：…」；没有就 ''。 */
export function receiptText(rc) {
  if (!rc || typeof rc !== 'object') return ''
  const why = rc.reason ? clip(rc.reason, 50) : ''
  return rc.ok === false ? `没成${why ? '：' + why : ''}` : why ? `成了：${why}` : ''
}

export function createMindLog({ file = '', now = () => Date.now() } = {}) {
  let items = []
  if (file && existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'))
      items = (Array.isArray(v?.items) ? v.items : []).filter((x) => x && typeof x === 'object' && Number(x.ts) > 0).slice(0, MIND_KEEP)
    } catch { items = [] } // 读不出来：从空的开始（只是给主人看的记录）
  }
  const save = () => {
    if (!file) return
    try { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify({ v: 1, items }, null, 1)); renameSync(tmp, file) } catch { /* 只是记录 */ }
  }
  const put = (row) => {
    items.unshift(row)
    items.splice(MIND_KEEP)
    save()
    return row
  }
  return {
    /** 她在心思会话里答了一个拿主意的回合。 */
    decided(turn, a, { role = '', receipt = null } = {}) {
      return put({ ts: now(), kind: 'turn', why: whyText(turn, role), did: didText(a), line: lineOf(a), rc: receiptText(receipt) })
    },
    /** 主聊天拿主意（0.9.2 起）：插件请她在心思会话里想一下接下来的打算。plan = 她写的「小镇打算」，没写就 null。 */
    thought(plan) {
      return put({ ts: now(), kind: 'think', why: THINK_WHY, did: plan ? `定了打算「${clip(plan, 60)}」` : '这次没写出打算（下次再问）', line: '', rc: '' })
    },
    /** 叫了她、她没答上（小镇按默认走了）。 */
    missed(turn, why, role = '') {
      return put({ ts: now(), kind: 'miss', why: whyText(turn, role), did: `没答上：${MISS_ZH[why] || clip(why, 30) || '没答上'}，小镇按默认走了`, line: '', rc: '' })
    },
    list(n = MIND_KEEP) { return items.slice(0, Math.max(0, Math.min(MIND_KEEP, n))) },
  }
}

/** /town 心思：给主人看的几行（新的在前）。 */
export function mindText(rows, { name = '她' } = {}) {
  if (!rows || !rows.length) return `${name}在「心思」会话里还没拿过主意（插件这个版本装上以后才开始记）。`
  const p = (x) => String(x).padStart(2, '0')
  const at = (ts) => { const d = new Date(ts); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
  return [`${name}最近在「心思」里拿的主意（新的在前，最多 ${MIND_KEEP} 条）：`,
    ...rows.map((r) => `· ${at(r.ts)}　${r.why} → ${r.did}${r.line ? `　「${r.line}」` : ''}${r.rc ? `　（${r.rc}）` : ''}`)].join('\n')
}
