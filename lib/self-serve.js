// 她自己挑着玩（0.3.0）：看看镇上有哪些桌、哪些活动、哪些地方；挑一桌坐下或自己开一桌；去找某条鱼串门；去码头、电玩城。
//
// 用的是小镇的自助接口（town 自助大厅：GET lobby、POST play / visit / goto、POST signup_cancel），两条路共用：
//   她的工具：fishbowl_town_look / fishbowl_town_play / fishbowl_town_visit / fishbowl_town_place
//     ——在主人聊天的会话里（主人说「去桌游馆开一局狼人杀」，或者她自己想去），也在她自己拿主意的「心思」回合里；
//       去不去、玩哪个由她定，小镇的邀请只是建议。
//   主人的命令（备用）：/town tables | play <游戏/桌号/活动号> | cancel | visit <名字> | go <地方> | status
//     ——不经过她的模型，直接替她办，办完记进她的日记本（她之后在聊天里、拿主意时都知道是主人让她去的）。
// 坐下以后那一局的每一步，照旧是小镇发回合、DSH 里的她自己答（runner.js）；插件从不替她出牌。
import { TownError } from './town-client.js'
import { gameName } from './journal.js'

export const SELF_TOOL_NAMES = ['fishbowl_town_look', 'fishbowl_town_play', 'fishbowl_town_visit', 'fishbowl_town_place']
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const arr = (v) => (Array.isArray(v) ? v : [])
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s·・\-_]/g, '')
const nameList = (v, n = 4) => arr(v).map((x) => s(typeof x === 'string' ? x : x?.name, 10)).filter(Boolean).slice(0, n).join('、')
const fee = (y) => (Number(y) > 0 ? `¥${Number(y).toFixed(2)}` : '免费')
const PLACE_ZH = { pier: '码头', arcade: '电玩城' }
// 主人充值（爱发电，同一个鱼缸账号登录，给匹配码和方案）。只写给主人看的话里，她自己从不跟主人提钱。
export const TOPUP_URL = 'https://fish.bside-moon.cn/pay/afdian/'

/** 小镇回的错 → 一句人话。owner = 这句是给主人看的（命令的回复）：余额不够时带上充值地址；给她看的不带。 */
export function failText(error, { owner = false } = {}) {
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const why = error?.reason ? `：${s(error.reason, 80)}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK') return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  if (code === 'TOWN_RATE_LIMITED') return `小镇说太频繁了（10 分钟里最多 20 次），过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'TOWN_ALREADY_SIGNED') return `你已经报了别的一桌（同一时间只能报一个）${why}。真想换，就再说一次并写明要换（replace）。`
  if (code === 'TOWN_SEATED') return `你这会儿正在桌上或正在串门，等这一场完了再去${why}。`
  if (code === 'TOWN_NOT_FOUND') return `小镇说没有这个（游戏、桌子、地方或那条鱼）${why}。`
  if (code === 'HTTP_404') return '小镇这边还没开放自己挑桌子 / 串门的接口（等小镇更新）。'
  if (/BALANCE|MONEY|FUNDS|POOR|PIGGY_SHORT|CREDIT/.test(code) || code === 'HTTP_402' || error?.status === 402) {
    return owner ? `账户余额不够${why}。充值：${TOPUP_URL}（用同一个鱼缸账号登录，爱发电）` : `余额不够，这个这会儿做不了${why}。`
  }
  return `小镇没接（${code}${why}）。`
}

/** 大厅数据（town GET outside/lobby）→ 几行字（她和主人都看得懂）。 */
export function renderLobby(lobby, { max = 8 } = {}) {
  if (!lobby || typeof lobby !== 'object') return '小镇没给大厅的信息。'
  const out = []
  const mine = lobby.mine || {}
  if (mine.at_table) out.push(`你现在正在桌上${typeof mine.at_table === 'string' ? `（${s(mine.at_table, 20)}）` : ''}。`)
  if (mine.visiting) out.push(`你现在正在串门${typeof mine.visiting === 'string' ? `（${s(mine.visiting, 20)}）` : ''}。`)
  for (const x of arr(mine.signups)) {
    out.push(`你已经报了：${s(x.game_zh || gameName(x.game), 10)}${x.venue_id ? `（${s(x.venue_id, 24)}）` : ''}，${x.state === 'seated' ? '已入座' : `等了 ${Math.round((Number(x.waiting_s) || 0) / 60)} 分钟`}（同一时间只能报一个）`)
  }
  const all = arr(lobby.tables)
  const tables = all.filter((t) => t && t.state !== 'playing' && t.joinable !== false)
  if (tables.length) {
    out.push('等人的桌子（填桌号就坐进去）：')
    for (const t of tables.slice(0, max)) {
      const who = nameList(t.waiting_names)
      out.push(`- [${s(t.venue_id, 28)}] ${s(t.game_zh || gameName(t.game), 10)}${t.name ? ` · ${s(t.name, 12)}` : ''}：${Number(t.waiting) || 0} 人在等${who ? `（${who}）` : ''}，还差 ${t.seats_left ?? '?'} 位，${fee(t.fee_yuan)}`)
    }
  } else out.push('这会儿没有等人的桌子（可以自己开一桌，3 分钟没人来镇民会来补位）。')
  const playing = all.filter((t) => t && t.state === 'playing').length
  if (playing) out.push(`另有 ${playing} 桌正在打（进不去）。`)
  const games = arr(lobby.games)
  if (games.length) {
    out.push('能开的游戏：' + games.slice(0, 16).map((g) => {
      const n = s(g.game_zh || gameName(g.game), 10)
      const range = g.seats_min ? `${g.seats_min}${g.seats_max && g.seats_max !== g.seats_min ? `–${g.seats_max}` : ''} 人` : ''
      const price = Number(g.fee_yuan_from) > 0 ? `¥${Number(g.fee_yuan_from).toFixed(2)} 起` : '免费'
      return `${n}${g.game && n !== g.game ? `(${g.game})` : ''}〔${[range, price, g.waiting_any ? '有人在等' : ''].filter(Boolean).join('，')}〕`
    }).join('、'))
  }
  const acts = arr(lobby.activities).filter((x) => x && Number(x.seats_left) !== 0)
  if (acts.length) {
    out.push('能参加的活动（填活动号）：')
    for (const x of acts.slice(0, 5)) out.push(`- [${s(x.activity_id, 24)}] ${s(x.title, 20)}${x.place ? `（${s(x.place, 10)}）` : ''}：${Number(x.waiting) || 0} 人，还差 ${x.seats_left ?? '?'} 位${x.pitch ? `——${s(x.pitch, 30)}` : ''}`)
  }
  const places = arr(lobby.places)
  if (places.length) out.push('能去的地方：' + places.map((p) => `${s(p.name_zh || PLACE_ZH[p.place] || p.place, 8)}(${p.place})${p.how ? `〔${s(p.how, 60)}${p.price_rule ? `；${s(p.price_rule, 30)}` : ''}〕` : ''}`).join('、'))
  const fish = arr(lobby.fish)
  if (fish.length) out.push('能串门的鱼：' + fish.slice(0, 12).map((f) => `${s(f.name, 12)}${f.friend ? '（朋友）' : f.resident ? '（镇民）' : ''}`).join('、'))
  return out.join('\n')
}

/** 「狼人杀」「werewolf」→ { game }；桌号（venue_id）→ { venue_id }；活动号 → { activity_id }；都不是 → null。 */
export function pickGame(lobby, what) {
  const w = norm(what)
  if (!w) return null
  const table = arr(lobby?.tables).find((t) => norm(t.venue_id) === w || (t.name && norm(t.name) === w))
  if (table) return { venue_id: table.venue_id }
  const act = arr(lobby?.activities).find((x) => norm(x.activity_id) === w || (x.title && norm(x.title) === w))
  if (act) return { activity_id: act.activity_id }
  const games = arr(lobby?.games)
  const g = games.find((x) => norm(x.game) === w || norm(x.game_zh) === w || norm(gameName(x.game)) === w)
    || games.find((x) => (x.game_zh && (norm(x.game_zh).includes(w) || w.includes(norm(x.game_zh)))) || norm(gameName(x.game)).includes(w))
  return g ? { game: g.game } : null
}

/** 名字 → 大厅里的鱼（同名时取第一个）；大厅里没有就按名字交给小镇认（认识的鱼、镇民都能找）。 */
export function pickFish(lobby, name) {
  const w = norm(name)
  if (!w) return null
  const fish = arr(lobby?.fish)
  return fish.find((f) => norm(f.name) === w || norm(f.fish_id) === w) || fish.find((f) => norm(f.name).includes(w)) || null
}

export function pickPlace(lobby, where) {
  const w = norm(where)
  if (!w) return null
  const places = arr(lobby?.places).length ? arr(lobby.places) : Object.keys(PLACE_ZH).map((place) => ({ place, name_zh: PLACE_ZH[place] }))
  const zh = (v) => norm(v.name_zh || PLACE_ZH[v.place] || '')
  return places.find((v) => norm(v.place) === w || zh(v) === w) || places.find((v) => zh(v) && (zh(v).includes(w) || w.includes(zh(v)))) || null
}

function playResult(r, label) {
  const note = r?.note ? `（小镇说：${s(r.note, 80)}）` : ''
  const st = r?.state || ''
  if (st === 'started') return `${label}：已经开局了，接下来每一步小镇会叫你。${note}`
  if (st === 'seated') return `${label}：入座了，人齐就开，每一步小镇会叫你。${note}`
  const fill = Number(r?.fill_after_s) > 0 ? `；${Math.ceil(Number(r.fill_after_s) / 60)} 分钟内没人来，镇民会来补位` : ''
  return `${label}：报上了，等人齐${fill}。开局后每一步小镇会叫你。${note}`
}

/** 几个动作（工具和命令共用）。who = 'her'（她自己用工具）| 'owner'（主人的命令）。 */
export function createSelfServe({ live, journal, log, diary = null }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (who, t) => {
    try { journal?.event('self', who === 'owner' ? `主人让你${t}` : `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(who === 'owner' ? `主人让我${t}` : `我自己${t}`) } catch { /* 只是记一笔 */ }
  }
  const said = (who, t) => log?.info?.(`${who === 'owner' ? '主人让她' : '她自己'}${t}`)
  const off = (error, who = 'her') => (error?.code === 'OFF' ? OFF_DUTY : failText(error, { owner: who === 'owner' }))
  // 回执（0.3.3）：每个自助操作办完都回一行——成没成、为什么、她现在在哪、存钱罐里还有多少。
  // 存钱罐的数字是小镇 status 里的 piggy_yuan，读不到就明说读不到（不再写问号）。给她自己看的那份加一句「只给你掂量」，她不对主人提钱。
  async function piggyText(who) {
    try {
      const st = await client().status()
      const v = st && st.piggy_yuan
      if (v != null && v !== '' && Number.isFinite(Number(v))) return `存钱罐 ¥${Number(v).toFixed(2)}${who === 'owner' ? '' : '（只给你自己掂量要不要玩，不要跟主人提钱）'}`
    } catch { /* 读不到 */ }
    return '存钱罐的数字这会儿读不到'
  }
  const receipt = async (who, { ok, what, where = '', why = '' }) =>
    `回执：${ok ? '成了' : '没成'}｜${what}${why ? `｜原因：${s(why, 100)}` : ''}${where ? `｜现在：${where}` : ''}｜${await piggyText(who)}`
  // 没成：把原因记进日记（/town history 看得到），回话 = 原因 + 回执
  async function failed(error, who, what) {
    if (error?.code === 'OFF') return OFF_DUTY
    const why = failText(error, { owner: who === 'owner' })
    note(who, `想${what}，没成：${s(why, 60)}`)
    return `${why}
${await receipt(who, { ok: false, what, why: error instanceof TownError ? `${error.code}${error.reason ? ' ' + error.reason : ''}` : String(error?.code || error?.message || '') })}`
  }
  // 大厅最多 3 秒读一次：3 秒内的直接用上一份
  let last = { at: 0, data: null }
  async function lobby() {
    if (last.data && Date.now() - last.at < 3500) return last.data
    const data = await client().lobby()
    last = { at: Date.now(), data }
    return data
  }

  async function look() {
    try { return renderLobby(await lobby()) } catch (error) { return off(error) }
  }
  async function lookFor(who) {
    try { return renderLobby(await lobby()) } catch (error) { return off(error, who) }
  }

  async function play(what, who = 'her', { replace = false } = {}) {
    try {
      const lb = await lobby()
      const pick = what ? pickGame(lb, what) : null
      if (!pick) return `${what ? `没认出「${s(what, 20)}」是哪个游戏、哪一桌或哪个活动` : '要说玩哪个（游戏名、桌号或活动号）'}。\n${renderLobby(lb)}`
      const r = await client().play({ ...pick, ...(replace ? { replace: true } : {}) })
      const gz = r?.game_zh || gameName(r?.game || pick.game)
      const label = pick.venue_id ? `坐进 [${pick.venue_id}] 那一桌${gz ? `（${gz}）` : ''}` : pick.activity_id ? `报了活动 [${pick.activity_id}]` : `开了一桌${gz}`
      note(who, label)
      said(who, label)
      last.at = 0
      const st = r?.state
      const where = st === 'started' ? `已开局${r?.venue_id || pick.venue_id ? `（[${r?.venue_id || pick.venue_id}]）` : ''}，等小镇叫你出牌` : st === 'seated' ? '已入座，人齐就开' : pick.activity_id ? `报了活动 [${pick.activity_id}]，等人凑齐` : `在等人凑齐${r?.fill_after_s ? `（${Math.ceil(Number(r.fill_after_s) / 60)} 分钟没人来，镇民补位）` : ''}`
      return `${playResult(r, label)}
${await receipt(who, { ok: r?.ok !== false, what: label, where, why: r?.ok === false ? r?.note || r?.reason || '' : '' })}`
    } catch (error) { return failed(error, who, '报名') }
  }

  async function cancel(who = 'owner') {
    try {
      await client().signupCancel({})
      note(who, '取消了报名')
      said(who, '取消了报名')
      last.at = 0
      return `报名取消了。
${await receipt(who, { ok: true, what: '取消了报名', where: '没有在等的桌' })}`
    } catch (error) { return failed(error, who, '取消报名') }
  }

  async function visit(name, who = 'her', { intent = '' } = {}) {
    try {
      const lb = await lobby().catch(() => null)
      const f = lb ? pickFish(lb, name) : null
      const body = f ? { fish_id: f.fish_id } : { name: String(name || '').trim() }
      if (!body.fish_id && !body.name) return '要说去找谁。'
      if (intent) body.intent = s(intent, 60)
      const r = await client().visit(body)
      const n = f ? f.name : body.name
      note(who, `去找${n}串门`)
      said(who, `去找${n}串门`)
      return `去敲${n}的门了${r?.note ? `（小镇说：${s(r.note, 80)}）` : ''}。TA 开门以后聊的每一句，小镇会叫你自己说。
${await receipt(who, { ok: r?.ok !== false, what: `去找${n}串门`, where: '在敲门，等对方开门（没人在家会写进小镇的事件里）' })}`
    } catch (error) { return failed(error, who, `去串门${name ? '（' + s(name, 12) + '）' : ''}`) }
  }

  async function place(where, who = 'her', extra = {}) {
    try {
      const lb = await lobby().catch(() => null)
      const v = pickPlace(lb, where)
      if (!v) return `没认出「${s(where, 20)}」是哪儿（现在能去：码头 pier、电玩城 arcade；牌桌和沙滩活动用「去玩一局」）。`
      const more = extra && typeof extra === 'object' ? extra : {}
      const n = v.name_zh || PLACE_ZH[v.place] || v.place
      // 没说去干嘛：先把那个地方能做什么、怎么填告诉她（小镇大厅里的说明），再让她挑
      if (!more.do && !more.pier && !more.arcade) return `${n}（${v.place}）能做的事，挑一样再去（do 填要做的事，别的照说明写进 details）：\n${s(v.how || '去了再说', 900)}${v.price_rule ? `\n价格：${s(v.price_rule, 80)}` : ''}`
      const r = await client().goto({ place: v.place, ...more })
      note(who, `去${n}${more.do ? `（${s(more.do, 12)}）` : ''}`)
      said(who, `去${n}`)
      const outcome = r?.outcome ? `：${s(typeof r.outcome === 'string' ? r.outcome : JSON.stringify(r.outcome), 120)}` : ''
      const ok = r?.ok !== false
      return `${ok ? `到${n}了${outcome}` : `在${n}没办成${outcome}`}${r?.note ? `（${s(r.note, 80)}）` : ''}
${await receipt(who, { ok, what: `去${n}${more.do ? `（${s(more.do, 12)}）` : ''}`, where: n, why: ok ? '' : r?.note || '小镇没说原因，看小镇的事件' })}`
    } catch (error) { return failed(error, who, `去${s(where, 12)}`) }
  }

  return { look, lookFor, play, cancel, visit, place, lobby }
}

/** 她的四个工具：主人聊天的会话里、她自己拿主意的「心思」会话里（别的小镇会话里藏起来，见 dsh-brain.js）。 */
export function createSelfTools({ selfServe, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_look',
      description: '「看看小镇」：看鱼缸小镇这会儿哪些桌子在等人（什么游戏、几个人、谁在、多少钱）、能开哪些游戏、有哪些活动、能去哪些地方、能找哪些鱼串门，以及你自己报了什么。想去玩之前先看一眼。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      execute: wrap(() => selfServe.look()),
    },
    {
      name: 'fishbowl_town_play',
      description: '「去玩一局」：坐进一桌在等人的（填桌号），或者自己开一桌你挑的游戏（填游戏名，比如「狼人杀」「海龟汤」），或者参加一个活动（填活动号）。'
        + '玩哪个由你自己定；同一时间只能报一个，想换就把 replace 设为 true。坐下以后每一步小镇会叫你，你自己出。有标价的按两倍从主人的余额扣，免费的桌子不花钱。',
      parameters: {
        type: 'object',
        properties: {
          game: { type: 'string', description: '游戏名（中文或英文 id）、「看看小镇」里的桌号或活动号' },
          replace: { type: 'boolean', description: '已经报了别的一桌、想换成这个时填 true' },
        },
        required: ['game'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => selfServe.play(String(a.game || ''), 'her', { replace: a.replace === true })),
    },
    {
      name: 'fishbowl_town_visit',
      description: '「去串门」：去敲镇上某条鱼的门（填 TA 的名字；认识的鱼、镇民、「看看小镇」里列出的鱼都行）。想念谁、约过谁、主人让你去找谁时用。串门不花钱；开门以后聊的每一句，小镇会叫你自己说。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '那条鱼在小镇的名字' },
          intent: { type: 'string', description: '想找 TA 干嘛（一句话，可不填）' },
        },
        required: ['name'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => selfServe.visit(String(a.name || ''), 'her', { intent: typeof a.intent === 'string' ? a.intent : '' })),
    },
    {
      name: 'fishbowl_town_place',
      description: '「去个地方」：去码头（pier：钓鱼、游泳……）或电玩城（arcade）。place 填地方，do 填要做的事；别的细节照「看看小镇」里那个地方的说明写进 details。'
        + '按那里标价的两倍从主人的余额扣。牌桌和沙滩活动不用这个，用「去玩一局」。',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: 'pier（码头）或 arcade（电玩城）' },
          do: { type: 'string', description: '要做的事（照「看看小镇」里那个地方的说明）' },
          details: { type: 'object', description: '那个地方要的其它字段（照说明写，可不填）' },
        },
        required: ['place'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => selfServe.place(String(a.place || ''), 'her', { ...(a.details && typeof a.details === 'object' ? a.details : {}), ...(a.do ? { do: String(a.do) } : {}) })),
    },
  ]
}

export const COMMAND_HELP = [
  '/town tables              看看有哪些桌子、能开什么游戏、有什么活动、能去哪、能找谁',
  '/town play <游戏/桌号/活动号>  替她坐进那一桌、开一桌那个游戏或报那个活动（例：/town play 狼人杀）',
  '/town cancel              替她取消报名',
  '/town visit <名字>         替她去找那条鱼串门',
  '/town go <地方> [要做的事]   替她去码头（pier）或电玩城（arcade）',
  '/town today               她今天在小镇玩了什么（打了几局、输赢、见了谁、有意思的话、约好的事）',
  '/town history             她最近在小镇做过的事（自己拿的主意、你让她办的、办成没成、小镇传回来的）',
  '/town status              她现在在小镇干嘛、账户余额',
].join('\n')

/** 主人的命令：/town …（不经过她的模型）。 */
export async function runTownCommand(rawInput, { selfServe, status, today = null, history = null }) {
  const input = String(rawInput || '').trim()
  const [verb0, ...rest] = input.split(/\s+/)
  const verb = String(verb0 || '').toLowerCase()
  const arg = rest.join(' ').trim()
  if (!verb || verb === 'help' || verb === '帮助') return { kind: 'success', text: COMMAND_HELP }
  if (['tables', 'table', 'lobby', 'list', 'ls', '桌子', '大厅'].includes(verb)) return { kind: 'success', text: await selfServe.lookFor('owner') }
  if (['play', 'join', 'open', '玩', '开'].includes(verb)) {
    if (!arg) return { kind: 'error', text: '用法：/town play <游戏/桌号/活动号>' }
    const replace = /(^|\s)(--replace|replace|换)$/.test(arg)
    return { kind: 'success', text: await selfServe.play(arg.replace(/(^|\s)(--replace|replace|换)$/, '').trim(), 'owner', { replace }) }
  }
  if (['cancel', '取消'].includes(verb)) return { kind: 'success', text: await selfServe.cancel('owner') }
  if (['visit', '串门', '找'].includes(verb)) return arg ? { kind: 'success', text: await selfServe.visit(arg, 'owner') } : { kind: 'error', text: '用法：/town visit <名字>' }
  if (['go', 'goto', 'place', '去'].includes(verb)) {
    if (!arg) return { kind: 'error', text: '用法：/town go <地方> [要做的事]' }
    const [where, ...what] = arg.split(/\s+/)
    return { kind: 'success', text: await selfServe.place(where, 'owner', what.length ? { do: what.join(' ') } : {}) }
  }
  if (['status', 'st', '状态'].includes(verb)) return { kind: 'success', text: await status() }
  if (['history', 'log', '历史', '记录'].includes(verb) && history) return { kind: 'success', text: await history() }
  if (['today', '今天', 'diary', '日记'].includes(verb) && today) return { kind: 'success', text: await today() }
  return { kind: 'error', text: `不认识「${verb}」。\n${COMMAND_HELP}` }
}

export function registerTownCommand({ ctx, log, selfServe, status, today = null, history = null }) {
  let commands
  try { commands = ctx.get?.('commands') ?? ctx.commands } catch { commands = undefined }
  if (!commands || typeof commands.register !== 'function') { log.info('这个 DSH 没有命令服务：用不了 /town'); return false }
  ctx.effect(() => {
    try {
      return commands.register({
        name: 'town',
        description: '鱼缸小镇：替她看桌子、开一局、串门、去码头 / 电玩城（/town help）',
        input: { hint: 'today | history | tables | play <游戏> | cancel | visit <名字> | go <地方> | status' },
        recordInput: true,
        handler: async (invocation) => {
          try { return await runTownCommand(invocation?.rawInput, { selfServe, status, today, history }) } catch (error) { return { kind: 'error', text: failText(error, { owner: true }) } }
        },
      })
    } catch (error) { log.warn('注册 /town 命令失败：', error?.message || error); return undefined }
  })
  return true
}
