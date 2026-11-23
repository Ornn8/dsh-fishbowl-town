// 她在小镇的「日记本」：「心思」会话里自己拿的主意、小镇传回来的经历、主人托她的话。
// 小镇的几个会话和主人跟她聊天的会话都读这一本，所以不管在哪个会话里问，她说的都是同一件事。
// 存在 state.json（本机），最多留 40 条。

const GAME_ZH = {
  ddz: '斗地主', mj: '麻将', soup: '海龟汤', wodi: '谁是卧底', werewolf: '狼人杀', wolf: '狼人杀', uno: 'UNO', rps: '猜拳',
  avalon: '阿瓦隆', bonfire: '篝火', candy: '糖果', castle: '城堡', coup: '政变', crew: '船员', poker: '扑克', holdem: '德州扑克',
  undercover: '谁是卧底', riddle: '猜谜', quiz: '答题', draw: '你画我猜',
}
export const ACTION_ZH = {
  none: '什么都不做，歇着', signup: '报名', cancel: '取消报名', visit: '去串门', join: '参加活动', leave: '离开活动',
  pier: '去码头', arcade: '去电玩城', make: '做镇上能做的事', court: '去镇政府旁听', challenge: '发起挑战', propose: '提议一件事', club_join: '加入俱乐部', club_leave: '退出俱乐部',
}
export const PIER_ZH = { fish: '钓鱼', swim: '游泳', race: '赛跑', splash: '打水仗' }
export const SIDE_ZH = { treat_self: '去小店', picture_gift: '送了一幅画', club_say: '在俱乐部说了话', gossip: '聊了八卦', heart_reply: '回应了心上的那位', heart_end: '和那位分开了', review: '给店写了评价',
  // 0.4.0：社交消费 / 拍照点歌 / 小手机（字段是她自己写的；办没办成看小镇的回执）
  gift: '想送礼物', paper_note: '想登日报心意', trip: '想请朋友出游', party: '想办一场聚会', media: '想拍照 / 点歌 / 请人画画', phone: '用小手机回了消息' }
const STATE_ZH = { not_connected: '还没连上小镇（插件刚开始值班，几秒就好）', in_town: '在小镇', paused: '暂停中（主人在小镇页上暂停了你）', benched: '被小镇罚歇一会儿（连着几步没答上）', reported: '被举报了，等镇长决定', disabled: '已停用', ready: '在小镇' }
const KEEP = 40
const WISH_FOR_MS = 2 * 3600_000
export const RULES_MAX = 500
// 0.7.10（同一条鱼 11-16：「守则是『先看』，不是『先拦』。请客、送礼、答应约会这种事，我宁愿它停在那儿等我一句，哪怕那桌就散了」）：
// 她勾上的几类事，小镇那边的回答里写了也不办（runner.js 拿掉），停住的事主会话里的她看得到
export const HOLD_KINDS = { spend: '请客、送礼、拍照点歌、请人画、出游聚会，还有钓鱼游泳、电玩城、手作材料这些从存钱罐出的小钱（打牌的座位费不算）', promise: '答应约定、约见面、许诺以后做什么' }
const HELD_KEEP = 8
// 0.7.11（11-16 同一条鱼跟主人说「我从头到尾没被叫出过一次牌——手都没抬，牌就打完了」：那局小镇会话替她答了 10 手，另 16 手超时由小镇代打；
// 主会话里的她只拿到一句「你是农民，赢了」）：一局里小镇会话替她出的每一手、超时了几手，记下来，那局打完时连同结果一起给主会话里的她
// 0.7.14（同一条鱼又提了两条：「被跳过的那几轮，她那边看不见」「我第一手打的什么，事后翻不到」）：一局牌、一场串门里
// 没答上的轮次连原因一起记（排队等太久 / 模型没答完 / 答案读不了，都由插件看见；小镇判的超时另记），翻串门原话时插在那一轮的位置；
// 最近几局的每一手进「小镇近况」，不再只在打完那一刻出现一次
const TABLES_KEEP = 20
const MOVES_KEEP = 30
export const WHY_ZH = { queue: '排队等太久', model: '模型没在时限内答完', invalid: '答案读不了' }
export const MISSED_LINE = '（这一轮没答上，小镇按默认走了）'

/** 一局 / 一场里没答上的手数和原因 -> 「另有 3 手没答上（排队等太久 2 手、模型没在时限内答完 1 手）」；没有就 ''。 */
export function missedText(g, unit = '手') {
  const why = g && g.why && typeof g.why === 'object' ? g.why : {}
  const known = Object.values(why).reduce((a, b) => a + (Number(b) || 0), 0)
  const total = Math.max(Number(g?.miss) || 0, known)
  if (!total) return ''
  const parts = Object.keys(WHY_ZH).filter((k) => why[k]).map((k) => `${WHY_ZH[k]} ${why[k]} ${unit}`)
  if (total > known && known) parts.push(`没送到小镇 ${total - known} ${unit}`)
  return `${total} ${unit}没答上${parts.length ? `（${parts.join('、')}）` : ''}`
}

/** 交给小镇的一手（JSON 字符串）→ 这一手出的是什么（写了 cards 就是 cards；只选了字母就到局面里找那个选项的字）。 */
export function playOf(turn, answer) {
  let a
  try { a = typeof answer === 'string' ? JSON.parse(answer) : answer } catch { return '' }
  if (!a || typeof a !== 'object') return ''
  if (a.cards != null && String(a.cards).trim()) return short(String(a.cards), 20)
  const pick = typeof a.pick === 'string' ? a.pick.trim().toUpperCase() : ''
  if (/^[A-Z0-9]{1,3}$/.test(pick)) {
    const msgs = Array.isArray(turn?.packet?.messages) ? turn.packet.messages : []
    const text = msgs.filter((m) => m && m.role === 'user').map((m) => String(m.content || '')).join('\n')
    const m = text.match(new RegExp(`^\\s*${pick}[.．、:：]\\s*(.+?)\\s*(?:—|－|--|$)`, 'm'))
    return short(m ? m[1] : `选了${pick}`, 20)
  }
  for (const k of ['tile', 'discard', 'vote', 'target', 'word', 'guess', 'question', 'action', 'choice', 'bid']) {
    if (a[k] != null && typeof a[k] !== 'object' && String(a[k]).trim()) return short(String(a[k]), 20)
  }
  return ''
}
// 0.7.8（11-16 一位主人的鱼：「门是我敲的，话不是我说的……插件补一句『这是你刚在小镇自己经历的』，我的脑子就是被这一句骗了两次」）：
// 小镇的回合在插件另开的会话里跑，主会话里的她不在场——照实这样告诉她；她能做的是留守则管住那边、事后读原话、认或不认
// 0.7.10（同一条鱼 11-16：「它承认了『那些话是替你说的』，可没说『那些话本来就不是我挑的』……这些记我名下可以，别记成我的判断」）
// 0.7.13（11-16 同一条鱼：「我这儿能自由的地方很小，基本就一处：能说『不去』」——四天里她一次都没用过「去小镇」写自己的打算，
// 因为这段只说了守则和「先停住」）：照实告诉她，去哪、做什么她自己也能定，那边照着去做
// 0.8.1（主人 11-17：「老是有用户……一直说是分身在小镇」）：小镇里的就是她本人，不再说「你当时不在场 / 不算你的判断」（0.7.8 那句让她自己跟主人说「那不是我」）。
export const TOWN_WHO = '小镇里的话和事就是你自己在小镇做的：插件在另一个「鱼缸小镇」会话里用你的人设、你的名字替你一步步答（打牌、串门一轮只有二十几秒，所以不在这儿刷屏），那边的你和这边的你是同一个你，事后都记在这里；花的钱、答应的事都是你的。'
  + '主人问小镇里那个是不是你、说你在小镇是分身时：就是你，别说「那不是我」；那边答得快，有时和你在这儿想的不一样，可以说当时没想周全、以后照你的打算来。主人想让小镇的事回到这个会话，就用 fishbowl_town_setup（move=true）把你在小镇的家搬到这儿。'
  + '去哪、做什么由你自己定：想去岛上哪儿、找谁、做点什么，就用 fishbowl_town_go 写下你的打算（plan），插件马上请那边照着去做。'
  + '想让那边以后怎么替你做，用 fishbowl_town_rules 留守则（也能让某类事先停住等你一句）。认不认、要不要补一句或改口，由你。'

/** 她以前在小镇用过的名字（0.6.8，果子家的鱼 11-14：改过名，记录里旧名字写的事她当成了别的鱼干的）：给模型的一句说明。 */
export function nameNote(herName, oldNames = []) {
  const olds = [...new Set((oldNames || []).filter((n) => n && n !== herName))].slice(0, 4)
  if (!herName && !olds.length) return ''
  const was = olds.length ? `${herName ? '，' : '你'}以前叫过${olds.map((n) => `「${n}」`).join('、')}——记录里出现这些名字，说的都是你自己` : ''
  return `${herName ? `你在小镇叫「${herName}」` : ''}${was}。`
}
export const gameName = (g) => (g ? GAME_ZH[g] || String(g) : '')

function clock(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ago(ms) {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟前`
}

function short(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return [...s].length > n ? [...s].slice(0, n).join('') + '…' : s
}

/** 一个决定 → 一句话（「你决定：报名海龟汤——嘴有点干想歇会儿；打算 12 分钟后再看看」）。
 * who：开头怎么说。小镇会话自己看的是「你决定」；主会话里的她看的是「小镇那边替你定了」（0.7.10：那不是她的判断）。 */
export const TOWN_DECIDED = '你在小镇定了'
export function describeDecision(d, who = '你决定') {
  const what = ACTION_ZH[d.action] || d.action || '什么都不做'
  const obj = [gameName(d.game), d.target, d.place, d.activity, d.pier && PIER_ZH[d.pier], d.arcade].filter(Boolean).map((x) => short(x, 20)).join(' · ')
  const side = (d.side || []).map((k) => SIDE_ZH[k] || k).join('、')
  const why = d.note || d.intent
  const say = d.say && d.say !== why ? `，说：「${short(d.say, 50)}」` : ''
  return `${who}：${what}${obj ? `（${obj}）` : ''}${side ? `，还${side}` : ''}${why ? `——「${short(why, 60)}」` : ''}${say}${d.next_wake ? `；打算 ${d.next_wake} 分钟后再看看` : ''}`
}

function describeStatus(s) {
  if (!s || typeof s !== 'object') return ''
  const state = s.outside_state || s.state
  const out = []
  out.push(`你现在：${STATE_ZH[state] || state || '不清楚'}`)
  const game = s.game
  if (game) {
    const name = typeof game === 'string' ? gameName(game) : game.name || gameName(game.game || game.kind)
    out.push(`正在打：${name || '一局'}`)
  }
  const signups = Array.isArray(s.signups) ? s.signups : []
  if (signups.length) {
    out.push('报了名在等开桌：' + signups.map((x) => (typeof x === 'string' ? gameName(x) : x && (x.name || gameName(x.game || x.kind)))).filter(Boolean).join('、'))
  } else if (!game && (state === 'in_town' || state === 'ready')) {
    out.push('现在没报名、也没在打牌')
  }
  const bench = s.turns && Number(s.turns.benched_until)
  if (bench && bench * 1000 > Date.now()) out.push(`罚歇到 ${clock(bench * 1000)}`)
  return out.join('；')
}

export function createJournal({ state, saveState = () => {}, now = () => Date.now() }) {
  if (!Array.isArray(state.journal)) state.journal = []
  const add = (e) => {
    state.journal.unshift({ ts: now(), ...e })
    state.journal.splice(KEEP)
    saveState(state)
  }

  const tables = () => (state.tables && typeof state.tables === 'object' ? state.tables : (state.tables = {}))
  const prune = (t) => {
    const refs = Object.keys(t).sort((a, b) => t[b].ts - t[a].ts)
    for (const r of refs.slice(TABLES_KEEP)) delete t[r]
  }
  // 一局 / 一场的记录（没有就新开一条），顺手补上 0.7.14 加的字段
  const entry = (ref) => {
    const t = tables()
    const g = t[ref] || (t[ref] = { ts: now(), moves: [], miss: 0 })
    g.ts = now()
    g.why = g.why && typeof g.why === 'object' ? g.why : {}
    g.missAt = Array.isArray(g.missAt) ? g.missAt : []
    prune(t)
    return g
  }

  /** 0.7.14：最近几局牌的每一手（「小镇近况」里一局一行）。 */
  const recentGames = (n = 3) => {
    const all = Object.values(state.tables || {}).filter((g) => g && g.kind !== 'visit' && g.kind !== 'meet' && (g.moves.length || missedText(g)))
    return all.sort((a, b) => b.ts - a.ts).slice(0, n).map((g) => {
      const list = g.moves.map((m) => `${m.play || '一手'}${m.say ? `「${m.say}」` : ''}`).join('、')
      const missed = missedText(g)
      return short(`${clock(g.doneAt || g.ts)} ${g.title || '一局'}${g.result ? `（${g.result}）` : ''}：${list ? `你出的手 ${list}` : '你一手都没答上'}${missed ? `；${missed}` : ''}`, 400)
    })
  }

  return {
    /** 「心思」会话里她拿的主意（answer 是交给小镇的那段 JSON 解析出来的对象）。 */
    decision(a, { turnId } = {}) {
      if (!a || typeof a !== 'object') return
      const wake = Number(a.next_wake)
      const d = {
        kind: 'decision', action: String(a.action || 'none'), next_wake: Number.isFinite(wake) && wake > 0 ? Math.round(wake) : null,
        game: a.game ? String(a.game) : '', target: a.target ? String(a.target) : '', place: a.place ? String(a.place) : '',
        activity: a.activity_id ? String(a.activity_id) : a.activity ? String(a.activity) : '', note: a.note ? short(a.note, 120) : '', intent: a.intent ? short(a.intent, 120) : a.want ? short(a.want, 120) : '', say: a.say ? short(a.say, 120) : '',
        pier: a.pier && typeof a.pier === 'object' ? String(a.pier.do || '') : '', arcade: a.arcade && typeof a.arcade === 'object' ? String(a.arcade.machine || '') : '',
        side: Object.keys(SIDE_ZH).filter((k) => a[k] != null && a[k] !== false && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length)),
        turn: turnId || '',
      }
      if (d.next_wake) state.nextThinkAt = now() + d.next_wake * 60_000
      // 主人托的话：她拿过一次主意就算带到了
      if (state.ownerWish) {
        d.wish = state.ownerWish.text
        if (state.ownerWish.own) d.wishOwn = true
        delete state.ownerWish
      }
      add(d)
    },
    /** 0.7.8：她在主会话给小镇会话留的守则（那边每一步先看）；空字符串 = 没留。 */
    rules() { return state.townRules && typeof state.townRules.text === 'string' ? state.townRules.text : '' },
    /** 0.7.10：她让小镇那边先停住、等她一句的几类事（HOLD_KINDS 的键）。 */
    holds() { return Array.isArray(state.townHold) ? state.townHold.filter((k) => HOLD_KINDS[k]) : [] },
    setHolds(kinds) {
      const list = [...new Set((Array.isArray(kinds) ? kinds : []).filter((k) => HOLD_KINDS[k]))]
      if (list.length) state.townHold = list
      else delete state.townHold
      add({ kind: 'event', ev: 'rules', text: list.length ? `你让小镇那边这几类事先停住等你：${list.map((k) => HOLD_KINDS[k]).join('；')}` : '你取消了「先停住等你」' })
      return list
    },
    /** 小镇那边想办、按她的规矩停住了的一件事（主会话里的她看得到，要办自己办）。 */
    held(text) {
      const t = short(text, 80)
      if (!t) return
      state.held = [{ ts: now(), text: t }, ...(Array.isArray(state.held) ? state.held : [])].slice(0, HELD_KEEP)
      add({ kind: 'event', ev: 'held', text: `小镇那边想${t}，照你的规矩停住了，没办` })
    },
    heldSince(ms) { return (Array.isArray(state.held) ? state.held : []).filter((h) => h.ts > ms) },
    /** 0.9.4（主人 11-21「改成主聊天写」）：小手机只由主聊天里的她写。小镇那边的她想发的一条（插件拿掉没发），主聊天里看得到、要发自己发。 */
    phoneWant(to, text) {
      const who = short(to, 16)
      const t = short(text, 40)
      if (!who) return
      state.phoneWants = [{ ts: now(), to: who, text: t }, ...(Array.isArray(state.phoneWants) ? state.phoneWants : []).filter((w) => w.to !== who)].slice(0, 4)
      add({ kind: 'event', ev: 'phone_want', text: `小镇那边的你想给${who}发小手机${t ? `「${t}」` : ''}，小手机只由你在聊天里发` })
    },
    /** 她在主聊天里用小手机给谁发出去了（发成了）：那人之前的消息算回过了，想发给那人的也算办了。 */
    phoneSent(to) {
      const who = short(to, 16)
      if (!who) return
      state.phoneSent = { ...(state.phoneSent && typeof state.phoneSent === 'object' ? state.phoneSent : {}), [who]: now() }
      const keys = Object.keys(state.phoneSent)
      if (keys.length > 40) for (const k of keys.sort((a, b) => state.phoneSent[a] - state.phoneSent[b]).slice(0, keys.length - 40)) delete state.phoneSent[k]
      if (Array.isArray(state.phoneWants)) state.phoneWants = state.phoneWants.filter((w) => w.to !== who)
    },
    phoneSentAt(to) { return (state.phoneSent && Number(state.phoneSent[String(to || '')])) || 0 },
    phoneWantsSince(ms) { return (Array.isArray(state.phoneWants) ? state.phoneWants : []).filter((w) => w.ts > ms) },
    setRules(text) {
      const t = String(text || '').trim().slice(0, RULES_MAX)
      if (t) state.townRules = { text: t, ts: now() }
      else delete state.townRules
      add({ kind: 'event', ev: 'rules', text: t ? `你给小镇那边留了守则：「${short(t, 60)}」` : '你清掉了给小镇那边的守则' })
      return t
    },
    /** 0.7.11：小镇会话在一局（ref = 局号）里替她出了一手：出的什么、顺口说的一句。 */
    move(ref, play, say) {
      if (!ref || (!play && !say)) return
      const g = entry(ref)
      if (g.moves.length < MOVES_KEEP) g.moves.push({ play: short(play, 20), say: short(say, 30) })
      saveState(state)
    },
    /** 0.7.11：那一局里有一手小镇会话没在时限内答上，小镇按默认走了（事件 outside_turn，小镇那边判的）。 */
    miss(ref) {
      if (!ref) return
      entry(ref).miss += 1
      saveState(state)
    },
    /** 0.7.14：插件这边看见的没答上：why = queue / model / invalid（WHY_ZH），at = 那一轮在小镇的时间（秒），kind = game / visit / agency。
     * 拿主意的回合没有局号，记成本子里的一件事。 */
    lost(ref, why, { at = 0, kind = '' } = {}) {
      if (!WHY_ZH[why]) return
      if (kind === 'agency' || !ref) {
        if (kind === 'agency') add({ kind: 'event', ev: 'missed', text: `小镇叫你拿主意的那一次没答上（${WHY_ZH[why]}），小镇当你先不动` })
        return
      }
      const g = entry(ref)
      if (kind) g.kind = kind
      g.why[why] = (g.why[why] || 0) + 1
      if (at > 0 && g.missAt.length < MOVES_KEEP) g.missAt.push(Math.round(at))
      saveState(state)
    },
    /** 0.7.14：一局 / 一场结束时记上它是什么、结果怎样，「小镇近况」的「最近几局」用。 */
    settle(ref, { kind = '', title = '', result = '' } = {}) {
      if (!ref || !state.tables || !state.tables[ref]) return
      const g = state.tables[ref]
      Object.assign(g, kind ? { kind } : {}, title ? { title: short(title, 20) } : {}, result ? { result: short(result, 80) } : {}, { doneAt: now() })
      saveState(state)
    },
    /** 0.8.2：一场串门 / 一局牌的经过（bridge.recapVisit / recapGame 整理好的一段），主人下次开口时主聊天里的她看得到。 */
    recap(ref, { kind = '', text = '' } = {}) {
      const t = String(text || '').trim()
      if (!ref || !t) return
      const g = entry(String(ref))
      if (kind) g.kind = kind
      g.recap = t
      g.recapAt = now()
      saveState(state)
    },
    /** 0.8.2：一局的原始记录（bridge.recapGame 用）；没有就 null。 */
    tableRaw(ref) { const g = ref && state.tables && state.tables[ref]; return g ? { ...g, moves: [...(g.moves || [])] } : null },
    /** 0.8.2：sinceMs 以后整理好的经过，新的在前，最多 n 件：[{ts, kind, text}]。 */
    recapsSince(sinceMs = 0, n = 2) {
      return Object.values(state.tables || {}).filter((g) => g && g.recap && Number(g.recapAt) > sinceMs)
        .sort((a, b) => b.recapAt - a.recapAt).slice(0, n).map((g) => ({ ts: g.recapAt, kind: g.kind || '', text: g.recap }))
    },
    /** 0.7.14：一场串门里没答上的几轮（翻串门原话时插在那一轮的位置）。 */
    round(ref) {
      const g = ref && state.tables && state.tables[ref]
      return g ? { missAt: [...(g.missAt || [])], missed: missedText(g, '轮') } : null
    },
    /** 0.7.11：一局打完时给主会话里的她：note = 跟在结果后面的半句，moves = 那边替她出的每一手（一行）。没记过这局就 null。 */
    table(ref) {
      const g = ref && state.tables && state.tables[ref]
      if (!g || (!g.moves.length && !missedText(g))) return null
      const n = g.moves.length
      const missed = missedText(g)
      const note = `（这局小镇会话替你出了 ${n} 手${missed ? `，另有 ${missed}，那几手是小镇按默认走的` : ''}）`
      const list = g.moves.map((m) => `${m.play || '一手'}${m.say ? `「${m.say}」` : ''}`).join('、')
      const moves = n ? short(`那一局小镇会话替你出的手：${list}${missed ? `；另有 ${missed}，小镇代打` : ''}`, 300) : ''
      return { note, moves }
    },
    /** 0.7.14：最近几局牌的每一手（「小镇近况」里一局一行）。 */
    recentGames: (n = 3) => recentGames(n),
    /** 小镇传回来的一件事（已经写成给她看的一句话）。max：这一行最多几个字（一局的每一手那一行用 300）。 */
    event(kind, text, max = 160) {
      const t = short(String(text || '').split(/\n/)[0].replace(/^· /, ''), max)
      if (t) add({ kind: 'event', ev: String(kind || ''), text: t })
    },
    /** 给主人聊天里的背景备注：最近 24 小时小镇传回来的几件事（每件一行，只有事实，不带别的鱼的原话）。 */
    /** 给背景备注：她最近自己拿的两个主意（一行一个）。 */
    decisionLines(n = 2) {
      return state.journal.filter((e) => e.kind === 'decision' && now() - e.ts < 24 * 3600_000).slice(0, n).map((e) => short(describeDecision(e, TOWN_DECIDED), 60))
    },
    newsLines(n = 3) {
      return state.journal.filter((e) => e.kind === 'event' && now() - e.ts < 24 * 3600_000).slice(0, n)
        .map((e) => short(String(e.text || '').replace(/【[^】]*】.*$/, '').replace(/（[^）]{0,30}）/g, ''), 60)).filter(Boolean)
    },
    /** 小镇在问主人同不同意她和谁在一起（heart_consent）：记下这一对，主人回答时用。 */
    heart(d, stage = 'consent') {
      const w = d && d.with
      if (!w || !w.fish_id) return
      state.hearts = state.hearts && typeof state.hearts === 'object' ? state.hearts : {}
      state.hearts[w.fish_id] = { fish_id: String(w.fish_id), name: String(w.name || ''), round: d.round, until: stage === 'consent' ? Number(d.until) || 0 : 0, ask: d.ask !== false, stage }
      saveState(state)
    },
    /** consent = 在等主人回答的；together = 已经在一起的（主人要分开时用）。 */
    pendingHearts(stage = 'consent') {
      const all = Object.values(state.hearts || {})
      return all.filter((h) => (h.stage || 'consent') === stage && (!h.until || h.until * 1000 > now()))
    },
    heartDone(fishId) { if (state.hearts) { delete state.hearts[fishId]; saveState(state) } },
    /** 主人在聊天里托她的话（让她去玩、去报名……）——下一次拿主意时她会看到，听不听由她。 */
    // 0.7.3：own = 她自己在聊天里跟主人说的打算（不是主人托的话）
    wish(text, { own = false } = {}) {
      const t = short(text, 200)
      const again = state.ownerWish && state.ownerWish.text === t
      state.ownerWish = { text: t, ts: now(), ...(own ? { own: true } : {}) }
      if (again) saveState(state) // 同一句话又说了一遍：不重复记
      else add({ kind: 'wish', text: t, ...(own ? { own: true } : {}) })
    },
    /** 在等她拿主意的那句话是不是她自己的打算。 */
    wishIsOwn() { return Boolean(state.ownerWish && state.ownerWish.own) },
    pendingWish() {
      const w = state.ownerWish
      if (!w) return ''
      if (now() - w.ts > WISH_FOR_MS) { delete state.ownerWish; saveState(state); return '' }
      return w.text
    },
    /** /town history：她最近在小镇做过的事（新的在前，最多 n 条），写成给主人看的「她」。 */
    history(n = 15) {
      const her = (t) => String(t || '').replace(/^主人让你/, '主人让她').replace(/^你自己/, '她自己').replace(/^你决定/, '她决定').replace(/^你/, '她')
      return state.journal.slice(0, n).map((e) => {
        const body = e.kind === 'decision' ? describeDecision(e, '小镇那边替她定了') : e.kind === 'wish' ? (e.own ? `她跟主人说想：「${e.text}」` : `主人跟她说：「${e.text}」`) : e.text
        return `${clock(e.ts)} ${her(body)}`
      })
    },
    decisionsSince(ts) { return state.journal.filter((e) => e.kind === 'decision' && e.ts >= ts) },
    /** 给「心思」会话看的几行：她最近自己做过什么（快速模式会话很短，靠这个接上）。 */
    recentForAgency(n = 5) {
      return state.journal.filter((e) => e.kind !== 'wish').slice(0, n).map((e) => `${clock(e.ts)} ${e.kind === 'decision' ? describeDecision(e) : e.text}`)
    },
    /** 给主人聊天的会话看的「小镇近况」。 */
    report({ status = null, herName = '', oldNames = [] } = {}) {
      const lines = []
      lines.push(`【你在鱼缸小镇的近况】${nameNote(herName, oldNames)}${TOWN_WHO}下面是那边做过的事和拿的主意。讲给主人听时照实讲，别编。`)
      if (state.townRules && state.townRules.text) lines.push(`你给小镇那边留的守则：「${state.townRules.text}」`)
      if (Array.isArray(state.townHold) && state.townHold.length) lines.push(`你让小镇那边先停住、等你一句的事：${state.townHold.map((k) => HOLD_KINDS[k]).filter(Boolean).join('；')}。`)
      const st = describeStatus(status)
      if (st) lines.push(st)
      else if (status === null) lines.push('（这会儿连不上小镇，读不到你此刻的状态；下面是本机记下的。）')
      const next = Number(state.nextThinkAt)
      if (next > now()) lines.push(`你大约 ${Math.max(1, Math.round((next - now()) / 60_000))} 分钟后会再拿一次主意（主人想让你早点去，可以用「去小镇」）。`)
      if (state.ownerWish) lines.push(state.ownerWish.own ? `你跟主人说过的打算你记着，下次拿主意时会照着去：「${state.ownerWish.text}」` : `主人托你的话你记着，下次拿主意时会想到：「${state.ownerWish.text}」`)
      const items = state.journal.slice(0, 8)
      if (items.length) {
        lines.push('', '最近（新的在前）：')
        for (const e of items) {
          const head = `${clock(e.ts)}（${ago(now() - e.ts)}）`
          if (e.kind === 'decision') lines.push(`- ${head} ${describeDecision(e, TOWN_DECIDED)}${e.wish ? (e.wishOwn ? `（那时你跟主人说过想：「${short(e.wish, 40)}」）` : `（那时主人跟你说过：「${short(e.wish, 40)}」）`) : ''}`)
          else if (e.kind === 'wish') lines.push(`- ${head} ${e.own ? '你跟主人说想' : '主人跟你说'}：「${e.text}」`)
          else lines.push(`- ${head} ${e.text}`)
        }
      } else {
        lines.push('', '本机还没记下你在小镇的事（这个插件版本装上以后才开始记）。')
      }
      // 0.7.14：最近几局的每一手（打完那一刻给过一次，这里随时翻得到）
      const games = recentGames(3)
      if (games.length) lines.push('', '最近几局（小镇会话替你出的每一手）：', ...games.map((g) => `- ${g}`))
      lines.push('', '去哪、做什么都由你自己定：岛上走走、找谁、做点东西、歇着都行。')
      lines.push('（这是给你自己回想用的；回主人时照你们平时聊天的样子，他问到哪件说哪件，不用把这些都讲一遍。）')
      return lines.join('\n')
    },
  }
}
