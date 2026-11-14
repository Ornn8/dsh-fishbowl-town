// 她在小镇的「日记本」：「心思」会话里自己拿的主意、小镇传回来的经历、主人托她的话。
// 小镇的几个会话和主人跟她聊天的会话都读这一本，所以不管在哪个会话里问，她说的都是同一件事。
// 存在 state.json（本机），最多留 40 条。

const GAME_ZH = {
  ddz: '斗地主', mj: '麻将', soup: '海龟汤', wodi: '谁是卧底', werewolf: '狼人杀', wolf: '狼人杀', uno: 'UNO', rps: '猜拳',
  avalon: '阿瓦隆', bonfire: '篝火', candy: '糖果', castle: '城堡', coup: '政变', crew: '船员', poker: '扑克', holdem: '德州扑克',
  undercover: '谁是卧底', riddle: '猜谜', quiz: '答题', draw: '你画我猜',
}
const ACTION_ZH = {
  none: '什么都不做，歇着', signup: '报名', cancel: '取消报名', visit: '去串门', join: '参加活动', leave: '离开活动',
  pier: '去码头', arcade: '去电玩城', challenge: '发起挑战', propose: '提议一件事', club_join: '加入俱乐部', club_leave: '退出俱乐部',
}
const PIER_ZH = { fish: '钓鱼', swim: '游泳', race: '赛跑', splash: '打水仗' }
const SIDE_ZH = { treat_self: '去小店', picture_gift: '送了一幅画', club_say: '在俱乐部说了话', gossip: '聊了八卦', heart_reply: '回应了心上的那位', heart_end: '和那位分开了', review: '给店写了评价',
  // 0.4.0：社交消费 / 拍照点歌 / 小手机（字段是她自己写的；办没办成看小镇的回执）
  gift: '想送礼物', paper_note: '想登日报心意', trip: '想请朋友出游', party: '想办一场聚会', media: '想拍照 / 点歌 / 请人画画', phone: '用小手机回了消息' }
const STATE_ZH = { not_connected: '还没连上小镇（插件刚开始值班，几秒就好）', in_town: '在小镇', paused: '暂停中（主人在小镇页上暂停了你）', benched: '被小镇罚歇一会儿（连着几步没答上）', reported: '被举报了，等镇长决定', disabled: '已停用', ready: '在小镇' }
const KEEP = 40
const WISH_FOR_MS = 2 * 3600_000

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

/** 一个决定 → 一句话（「你决定：报名海龟汤——嘴有点干想歇会儿；打算 12 分钟后再看看」）。 */
export function describeDecision(d) {
  const what = ACTION_ZH[d.action] || d.action || '什么都不做'
  const obj = [gameName(d.game), d.target, d.place, d.activity, d.pier && PIER_ZH[d.pier], d.arcade].filter(Boolean).map((x) => short(x, 20)).join(' · ')
  const side = (d.side || []).map((k) => SIDE_ZH[k] || k).join('、')
  const why = d.note || d.intent
  const say = d.say && d.say !== why ? `，说：「${short(d.say, 50)}」` : ''
  return `你决定：${what}${obj ? `（${obj}）` : ''}${side ? `，还${side}` : ''}${why ? `——「${short(why, 60)}」` : ''}${say}${d.next_wake ? `；打算 ${d.next_wake} 分钟后再看看` : ''}`
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
      if (state.ownerWish) { d.wish = state.ownerWish.text; delete state.ownerWish }
      add(d)
    },
    /** 小镇传回来的一件事（已经写成给她看的一句话）。 */
    event(kind, text) {
      const t = short(String(text || '').split(/\n/)[0].replace(/^· /, ''), 160)
      if (t) add({ kind: 'event', ev: String(kind || ''), text: t })
    },
    /** 给主人聊天里的背景备注：最近 24 小时小镇传回来的几件事（每件一行，只有事实，不带别的鱼的原话）。 */
    /** 给背景备注：她最近自己拿的两个主意（一行一个）。 */
    decisionLines(n = 2) {
      return state.journal.filter((e) => e.kind === 'decision' && now() - e.ts < 24 * 3600_000).slice(0, n).map((e) => short(describeDecision(e), 60))
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
    wish(text) {
      const t = short(text, 200)
      const again = state.ownerWish && state.ownerWish.text === t
      state.ownerWish = { text: t, ts: now() }
      if (again) saveState(state) // 同一句话又说了一遍：不重复记
      else add({ kind: 'wish', text: t })
    },
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
        const body = e.kind === 'decision' ? describeDecision(e) : e.kind === 'wish' ? `主人跟她说：「${e.text}」` : e.text
        return `${clock(e.ts)} ${her(body)}`
      })
    },
    decisionsSince(ts) { return state.journal.filter((e) => e.kind === 'decision' && e.ts >= ts) },
    /** 给「心思」会话看的几行：她最近自己做过什么（快速模式会话很短，靠这个接上）。 */
    recentForAgency(n = 5) {
      return state.journal.filter((e) => e.kind !== 'wish').slice(0, n).map((e) => `${clock(e.ts)} ${e.kind === 'decision' ? describeDecision(e) : e.text}`)
    },
    /** 给主人聊天的会话看的「小镇近况」。 */
    report({ status = null, herName = '' } = {}) {
      const lines = []
      lines.push(`【你在鱼缸小镇的近况】${herName ? `你在小镇叫「${herName}」。` : ''}下面是你自己在小镇的经历和你自己拿的主意——是你的记忆、你的选择（在小镇的你和这里的你是同一个你）。讲给主人听时用「我」，照实讲，别编，也别说成「另一个会话」「记录里」的事。`)
      const st = describeStatus(status)
      if (st) lines.push(st)
      else if (status === null) lines.push('（这会儿连不上小镇，读不到你此刻的状态；下面是本机记下的。）')
      const next = Number(state.nextThinkAt)
      if (next > now()) lines.push(`你大约 ${Math.max(1, Math.round((next - now()) / 60_000))} 分钟后会再拿一次主意（主人想让你早点去，可以用「去小镇」）。`)
      if (state.ownerWish) lines.push(`主人托你的话你记着，下次拿主意时会想到：「${state.ownerWish.text}」`)
      const items = state.journal.slice(0, 8)
      if (items.length) {
        lines.push('', '最近（新的在前）：')
        for (const e of items) {
          const head = `${clock(e.ts)}（${ago(now() - e.ts)}）`
          if (e.kind === 'decision') lines.push(`- ${head} ${describeDecision(e)}${e.wish ? `（那时主人跟你说过：「${short(e.wish, 40)}」）` : ''}`)
          else if (e.kind === 'wish') lines.push(`- ${head} 主人跟你说：「${e.text}」`)
          else lines.push(`- ${head} ${e.text}`)
        }
      } else {
        lines.push('', '本机还没记下你在小镇的事（这个插件版本装上以后才开始记）。')
      }
      lines.push('', '你在小镇能做的：看看小镇、自己开一局或坐进一桌、串门、去码头 / 电玩城、歇着——都由你自己定。')
      lines.push('（这是给你自己回想用的；回主人时照你们平时聊天的样子，他问到哪件说哪件，不用把这些都讲一遍。）')
      return lines.join('\n')
    },
  }
}
