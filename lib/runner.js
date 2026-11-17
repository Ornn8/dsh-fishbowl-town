// 核心循环：长轮询小镇的回合 -> 交给 DSH 里的她回答 -> 时限内交回；定时读事件讲给她听。
// 不认识 DSH：DSH 那半边是传进来的 brain（见 dsh-brain.js），测试里换成假的。
import { NOTE_EXECUTED } from './chat-decide.js'
import { buildCorrection, buildHoldCorrection, buildTurnPrompt, holdCheck, toAnswer } from './prompt.js'
import { buildNewsPrompt, describeEvent, isQuiet } from './events.js'
import { TownError } from './town-client.js'
import { playOf } from './journal.js'
import { buildEchoCorrection, echoCheck, echoIndex, recapGame, recapVisit } from './bridge.js'

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

// 要她回应的事件（问主人同不同意、夸夸群的祝福到了）：这些才叫她的模型在「见闻」会话里讲一遍，别的只记日记
const NEEDS_HER = new Set(['heart_consent', 'heart_together', 'bless_ready'])

export const DEFAULTS = {
  pollWaitS: 25,
  marginMs: 1500, // 交回去之前留的余量（网络来回）
  minBudgetMs: 3000, // 剩下不到这么多就不问了（反正来不及）
  retryMinMs: 8000, // 第一次答得不能读时，剩下的时间够这么多才追问一次
  eventsEveryMs: 60_000,
  answerWithinMs: 23_000, // 本地上限：收到回合后这么久还没答完就放弃
  eventsBatchMs: 0, // 事件攒多久再讲（0 = 每次读到就讲）
  seenKeep: 500,
  narrateNews: false, // 0.3.3：读到小镇事件不再叫她的模型讲一遍（日记 diary.js 记着，主人聊天里的背景备注带给她）；只有要她回应的（NEEDS_HER）才讲
}

// 小镇重启、网络抖一下时会出现的错：不停地重连（最多隔 8 秒），不打扰主人
export const TRANSIENT = (code) => code === 'NETWORK' || code === 'UNKNOWN' || code === 'TOWN_OFF' || code === 'TOWN_RESTARTING' || /^HTTP_5\d\d$/.test(String(code))

export function createRunner({ client, brain, log, config = {}, state = {}, saveState = () => {}, now = () => Date.now(), savePicture = null, onReconnect = null, onEvent = null, onDiary = null, journal = null, ownerLife = null, diary = null, onNotable = null, schedule = null, chatDecide = null, onEcho = null }) {
  const cfg = { ...DEFAULTS, ...config }
  const controller = new AbortController()
  const signal = controller.signal
  const seen = new Map() // turn_id -> 'working' | 'done'
  const stats = { turns: 0, answered: 0, invalid: 0, late: 0, closed: 0, errors: 0, events: 0, news: 0, decisions: 0, lastTurnAt: 0, problem: '', problemSince: 0, reconnects: 0, connected: false }
  const recent = [] // 最近的小镇事件（给设置页看）
  const lifeRefs = new Set() // 0.8.2：已经带过「你和主人最近的事」的那几局（一局只在第一轮带）
  let running = false
  let pausedUntil = 0
  let lastAuthNotice = 0
  const loops = []

  function remember(id, v) {
    seen.set(id, v)
    if (seen.size > cfg.seenKeep) seen.delete(seen.keys().next().value)
  }

  function msLeft(turn, receivedAt) {
    // deadline 是小镇的绝对时间（秒）。电脑时钟可能不准：再用「收到以后过了多久」兜底，最多 25 秒。
    const byDeadline = Number(turn.deadline) > 0 ? Number(turn.deadline) * 1000 - now() : Infinity
    const byReceipt = cfg.pollWaitS * 1000 - (now() - receivedAt)
    let left = Math.min(byDeadline, byReceipt)
    if (!(byDeadline > -60_000 && byDeadline < 120_000)) left = byReceipt // 时钟差太多：只信收到的时间
    // 本地上限（默认 23 秒，小镇等 25 秒）：她的模型到点还没答完就不交了，让小镇用默认动作，不冒交晚的险
    const byLocal = cfg.answerWithinMs > 0 ? cfg.answerWithinMs - (now() - receivedAt) + cfg.marginMs : Infinity
    return Math.min(left, byLocal) - cfg.marginMs
  }

  // 0.7.14：没答上的一轮记进本子（原因由插件看得见的：排队等太久 / 模型没答完 / 答案读不了），翻记录时她看得见那一轮不是她不想说
  function lost(turn, why) {
    if (!journal?.lost) return
    const kind = turn.kind === 'visit' ? 'visit' : turn.kind === 'agency' ? 'agency' : turn.kind === 'activity' ? '' : 'game'
    if (!kind) return
    const at = Number(turn.deadline) > 0 ? Number(turn.deadline) - 25 : now() / 1000
    try { journal.lost(turn.packet?.ref, why, { at, kind }) } catch { /* 记不上就算了 */ }
  }

  async function handleTurn(turn, receivedAt) {
    stats.turns++
    const id = turn.turn_id
    try {
      let left = msLeft(turn, receivedAt)
      if (left < cfg.minBudgetMs) { stats.late++; lost(turn, 'queue'); log.info(`回合 ${id} 来不及答（剩 ${Math.round(left)}ms），让小镇用默认动作`); return }
      // 0.3.3：拿主意的回合先看看要不要叫她——她说了要歇着、勿扰时段、主人定的最短间隔没到、没什么新的：插件替她答「先不动」，不调模型
      if (turn.kind === 'agency' && schedule) {
        const s = schedule.skip(turn, { wish: journal ? journal.pendingWish() : '' })
        if (s) {
          await answerThroughBlips(id, schedule.skipAnswer(s), turn, receivedAt)
          stats.skipped = (stats.skipped || 0) + 1
          log.info(`拿主意的回合 ${id} 没叫她（${s.why}），${s.minutes} 分钟后再看`)
          return
        }
      }
      // 0.9.0「主聊天拿主意」（chat-decide.js）：主意由聊天里的她定；小镇会话只照着办（execute）、急事按她的规矩先答（rules）、
      // 她两次没顾上回时先替她定（fallback）；其余插件直接回小镇「过一会儿再叫我」
      let route = null
      if (turn.kind === 'agency' && chatDecide) {
        route = typeof chatDecide.route === 'function' ? chatDecide.route(turn) : (chatDecide.take(turn) ? { answer: chatDecide.take(turn) } : null)
        if (route && route.answer) {
          await answerThroughBlips(id, route.answer, turn, receivedAt)
          stats.chatDecide = (stats.chatDecide || 0) + 1
          log.info(`拿主意的回合 ${id}：等聊天里的她定，小镇那边先等一会儿`)
          return
        }
      }
      const slot = turn.kind === 'visit' ? 'visit' : turn.kind === 'agency' ? 'agency' : turn.kind === 'activity' ? 'activity' : 'game'
      // 拿主意的回合带上她自己最近的事和主人托的话（快速模式的会话很短，靠这本日记接上）
      const mind = turn.kind === 'agency' && journal ? { recent: journal.recentForAgency(), wish: journal.pendingWish(), wishOwn: journal.wishIsOwn(), role: route?.role || '' } : {}
      // 0.7.3：串门时带上她自己这会儿的打算（她跟主人说过、还没去办的；没有就是她上次拿主意时定的 doing）
      if (turn.kind === 'visit') {
        const own = journal && journal.wishIsOwn() ? journal.pendingWish() : ''
        const doing = schedule ? schedule.describe().doing : ''
        if (own || doing) mind.plan = own || doing
      }
      // 拿主意、串门时带上「她和主人最近的事」（主人聊天会话里最近两来回，30 分钟换一次；插件页可关）
      if ((turn.kind === 'agency' || turn.kind === 'visit') && typeof ownerLife === 'function') { try { mind.life = ownerLife() } catch { /* 没有就不带 */ } }
      // 0.8.2：牌局也带，一局只在第一轮带一次（她在那个会话里接着记得）
      const ref = String(turn.packet?.ref || '')
      if (slot === 'game' && ref && !lifeRefs.has(ref) && typeof ownerLife === 'function') {
        try { mind.life = ownerLife() } catch { /* 没有就不带 */ }
        lifeRefs.add(ref)
        if (lifeRefs.size > 200) lifeRefs.delete(lifeRefs.values().next().value)
      }
      // 0.8.2 回声检查用：她心里那几句（主聊天最近的事 + 她的打算），每一轮都比，不管这一轮带没带
      let secret = null
      if (typeof ownerLife === 'function') {
        try {
          const lines = ownerLife()
          if (lines.length) {
            const msgs = Array.isArray(turn.packet?.messages) ? turn.packet.messages : []
            const allow = msgs.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join(' ')
            secret = echoIndex(lines, { allow })
          }
        } catch { secret = null }
      }
      if (turn.kind === 'agency' && schedule) mind.floors = schedule.describe().floors
      if (journal && typeof journal.rules === 'function') mind.rules = { text: journal.rules(), hold: typeof journal.holds === 'function' ? journal.holds() : [] } // 0.7.8：她留的守则，每种回合都带
      const prompt = buildTurnPrompt(turn, { secondsLeft: Math.floor(left / 1000), ...mind })
      schedule?.count(slot)
      let raw = await brain.ask(slot, prompt, { timeoutMs: left, turnId: id })
      let answer = toAnswer(turn, raw)
      left = msLeft(turn, receivedAt)
      if (answer === null && left >= cfg.retryMinMs) {
        log.info(`回合 ${id} 第一次的回答读不了，追问一次`)
        schedule?.count(slot)
        raw = await brain.ask(slot, buildCorrection(turn), { timeoutMs: left, turnId: id, followup: true })
        answer = toAnswer(turn, raw)
      }
      // 0.7.10：她要先停住的事（请客送礼 / 答应约定），回答里写了也不办：请那边重答一次，还写着就插件拿掉；停住的事记给主会话里的她
      const hold = mind.rules && mind.rules.hold
      if (answer !== null && hold && hold.length) {
        let h = holdCheck(turn.kind, answer, hold)
        if (h.found.length) {
          const held = [...h.found]
          if (msLeft(turn, receivedAt) >= cfg.retryMinMs) {
            schedule?.count(slot)
            const again = toAnswer(turn, await brain.ask(slot, buildHoldCorrection(h.found), { timeoutMs: msLeft(turn, receivedAt), turnId: id, followup: true }).catch(() => ''))
            if (again !== null) { h = holdCheck(turn.kind, again, hold); for (const f of h.found) if (!held.includes(f)) held.push(f) }
          }
          answer = h.clean
          for (const f of held) journal.held(f)
          log.info(`回合 ${id}：按她的规矩停住了 ${held.length} 件要她点头的事`)
        }
      }
      // 0.8.2 回声检查：她要说出去的话里带出了主聊天里的事（连着 6 个汉字一样 / 同一串数字）：先请她换个说法重答，还带着就把那几句去掉
      if (answer !== null && secret && !secret.empty) {
        const format = turn.packet?.reply?.format === 'text' ? 'text' : 'json'
        let e = echoCheck(answer, secret, { format })
        if (e.hits.length) {
          stats.echo = (stats.echo || 0) + 1
          let fixed = false
          if (msLeft(turn, receivedAt) >= cfg.retryMinMs) {
            schedule?.count(slot)
            const again = toAnswer(turn, await brain.ask(slot, buildEchoCorrection(), { timeoutMs: msLeft(turn, receivedAt), turnId: id, followup: true }).catch(() => ''))
            if (again !== null) { const e2 = echoCheck(again, secret, { format }); if (!e2.hits.length) { answer = again; fixed = true } else e = e2 }
          }
          if (!fixed) answer = e.clean
          try { onEcho?.({ kind: turn.kind, fixed, n: e.hits.length }) } catch { /* 只是记一笔 */ }
          log.info(`回合 ${id}：她的话带出了主聊天里的事，${fixed ? '换了个说法' : '那几句没发'}`)
        }
      }
      if (answer === null) { stats.invalid++; lost(turn, 'invalid'); log.info(`回合 ${id} 的回答读不了，不交（小镇用默认动作）`); await passActivity(turn, receivedAt); return }
      if (msLeft(turn, receivedAt) + cfg.marginMs <= 0) { stats.late++; lost(turn, 'model'); log.info(`回合 ${id} 答好时已经过了时限`); return }
      let decided = null
      if (turn.kind === 'agency') {
        try {
          let a = JSON.parse(answer)
          if (schedule) { a = schedule.settle(a); answer = JSON.stringify(a) } // 她定的作息 + 主人的底线
          // 0.9.0：照她在聊天里定的办的，note 标一下（小镇那边能数出主聊天定的主意有多少；主人在「战绩」里也看得到）
          if (route?.role === 'execute' && !/^办不了/.test(String(a.note || ''))) { a.note = (NOTE_EXECUTED + (a.note ? '：' + String(a.note) : '')).slice(0, 200); answer = JSON.stringify(a) }
          decided = a
          stats.decisions++
          log.info(`她的主意：${a.action || 'none'}${a.next_wake != null ? `，${a.next_wake} 分钟后再看看` : ''}${a.plan?.doing ? `，打算「${String(a.plan.doing).slice(0, 30)}」` : ''}${a.note ? `（${String(a.note).slice(0, 40)}）` : ''}`)
        } catch { /* 交给小镇判 */ }
      }
      const posted = await answerThroughBlips(id, answer, turn, receivedAt)
      // 0.4.0：决定回合的回答带回执（小镇替她办的事：成没成、为什么）；事件 outside_receipt 里也有，这里只记一行日志
      const rc = posted && typeof posted === 'object' ? posted.receipt : null
      if (rc && typeof rc === 'object') log.info(`小镇的回执：${rc.ok === false ? '没成' : '成了'}${rc.reason ? '｜' + String(rc.reason).slice(0, 80) : ''}`)
      if (decided && journal) journal.decision(decided, { turnId: id })
      if (decided && route?.role && typeof chatDecide?.after === 'function') { try { chatDecide.after(route.role, decided) } catch { /* 只是记一笔 */ } }
      // 0.7.11：牌桌上这一手记进本子，那局打完时连同结果给主会话里的她
      if (slot === 'game' && journal?.move) {
        try { const a = JSON.parse(answer); journal.move(turn.packet?.ref, playOf(turn, a), typeof a.say === 'string' ? a.say : '') } catch { /* 读不了就不记 */ }
      }
      stats.answered++
      stats.lastTurnAt = now()
      log.info(`回合 ${id} 已交（${turn.kind}/${turn.packet?.game || '-'}，${now() - receivedAt}ms）`)
    } catch (error) {
      if (error instanceof TownError && error.code === 'TOWN_OUTSIDE_TURN_CLOSED') { stats.closed++; log.info(`回合 ${id} 已经关了（晚了或答过了）`); return }
      if (error && error.code === 'BRAIN_TIMEOUT') { stats.late++; lost(turn, error.message === '来不及' ? 'queue' : 'model'); log.info(`回合 ${id} 她没在时限内答完`); await passActivity(turn, receivedAt); return }
      // 0.5.2：拿不到干净的小镇小会话（宿主交回来的像是主人的聊天）：这一步不答，小镇走默认的一步，主人的聊天和钱都不碰
      if (error && error.code === 'BRAIN_UNSAFE') { stats.unsafe = (stats.unsafe || 0) + 1; log.warn(`回合 ${id} 没答：${error.message}`); await passActivity(turn, receivedAt); return }
      if (!running) return // 插件在卸载：不算错
      stats.errors++
      log.warn(`回合 ${id} 出错：`, error)
    } finally {
      remember(id, 'done')
    }
  }

  // 交答案时小镇正好在重启：时限内每秒再交一次（小镇重送的同一回合会被 seen 跳过，所以这里自己补）
  async function answerThroughBlips(id, answer, turn, receivedAt) {
    for (;;) {
      try { return await client.answer(id, answer) } catch (error) {
        const code = error instanceof TownError ? error.code : 'UNKNOWN'
        if (!running || !TRANSIENT(code) || code === 'TOWN_OFF' || msLeft(turn, receivedAt) + cfg.marginMs < 1500) throw error
        await sleep(1000, signal)
      }
    }
  }

  // 活动回合（她在码头、小店……的一句话）这次答不上：还有时间就说 unsupported，小镇这句代写，不算她超时
  async function passActivity(turn, receivedAt) {
    if (!turn || turn.kind !== 'activity' || msLeft(turn, receivedAt) + cfg.marginMs < 800) return
    try { await client.answer(turn.turn_id, JSON.stringify({ unsupported: true })); log.info(`活动回合 ${turn.turn_id} 这次交给小镇代写`) } catch { /* 时限到了就算了 */ }
  }

  function recovered() {
    if (!stats.problem) return
    const down = now() - (stats.problemSince || now())
    stats.problem = ''
    stats.problemSince = 0
    backoffFor.n = 0
    stats.reconnects++
    log.info(`又连上小镇了（断了 ${Math.round(down / 1000)} 秒）`)
    try { onReconnect?.(down) } catch { /* 只是刷新状态 */ }
  }

  async function backoffFor(error) {
    const code = error instanceof TownError ? error.code : 'UNKNOWN'
    if (code === 'ABORTED') return 0
    if (!stats.problem) stats.problemSince = now()
    stats.problem = code
    const downMs = now() - stats.problemSince
    if (code === 'TOWN_OUTSIDE_CODE' || code === 'NO_CODE') {
      if (now() - lastAuthNotice > 6 * 3600_000) {
        lastAuthNotice = now()
        log.warn('小镇接入码不对、换过了或已停用：先停下，10 分钟后再试。到插件设置里换上新的接入码。')
        brain.notify?.('小镇说接入码不对、换过了或已停用。请到 DSH 设置 → 插件 → 鱼缸小镇，换上新的小镇接入码。')
      }
      return 10 * 60_000
    }
    // 小镇重启时会短暂说「没开放」：前 10 分钟每 10 秒看一次，真关了才放慢到每分钟
    if (code === 'TOWN_OFF') {
      if (downMs < 1000) log.info('小镇的外来鱼接口暂时没开（多半在更新），自动重连')
      const ra = Number(error?.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0
      return ra || (downMs < 10 * 60_000 ? 10_000 : 60_000)
    }
    // 上一个长轮询还没被小镇放掉（网络断过一下常见）：过一会儿就好
    if (code === 'TOWN_OUTSIDE_POLL_OPEN') {
      if (downMs > 120_000) log.warn('同一个接入码一直有别的程序在长轮询（是不是开了两个 DSH？）')
      return 10_000
    }
    if (code === 'TOWN_RATE_LIMITED') return 15_000
    // 小镇重启（town 074da93）：排空时 503 TOWN_RESTARTING + Retry-After: 3；进程真正停下的几秒是 502/503/504 或连不上。
    // 一律等 Retry-After（没有就 3 秒）再试，不越等越久，也不算她的错。
    const ra = Number(error?.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0
    if (code === 'TOWN_RESTARTING' || code === 'NETWORK' || /^HTTP_50[234]$/.test(code)) {
      if (downMs < 1000 || Math.floor(downMs / 60_000) !== Math.floor((downMs - 3000) / 60_000)) log.info(`小镇在重启或连不上（${code}），${Math.round((ra || 3000) / 1000)} 秒后再试`)
      return ra || 3000
    }
    stats.errors++
    const n = Math.min(3, (backoffFor.n = (backoffFor.n || 0) + 1)) // 最多等 8 秒：牌局还在进行，回合 25 秒就过期
    if (n < 3 || downMs < 1000 || Math.floor(downMs / 60_000) !== Math.floor((downMs - 8000) / 60_000)) log.info(`连不上小镇（${error?.message || code}），${2 ** n} 秒后重试`)
    return 2 ** n * 1000
  }

  async function turnLoop() {
    while (running && !signal.aborted) {
      if (now() < pausedUntil) { await sleep(pausedUntil - now(), signal); continue }
      let page
      try {
        // 刚断过：先用 1 秒的短轮询试一下，通了马上知道（长轮询要等满 25 秒才回话）
        page = await client.turns(stats.problem ? 1 : cfg.pollWaitS, signal)
        backoffFor.n = 0
        recovered()
        if (!stats.connected) { stats.connected = true; try { onReconnect?.(0) } catch { /* 只是刷新状态 */ } }
      } catch (error) {
        const wait = await backoffFor(error)
        if (wait) await sleep(wait, signal)
        continue
      }
      const receivedAt = now()
      const turns = Array.isArray(page?.turns) ? page.turns : []
      for (const turn of turns) {
        // 小镇对没答的回合 10 秒后会再送一次：正在答的、答过的都跳过
        if (!turn || typeof turn.turn_id !== 'string' || seen.has(turn.turn_id)) continue
        remember(turn.turn_id, 'working')
        handleTurn(turn, receivedAt) // 不等：几个回合可以同时在答（游戏和串门各一个会话）
      }
    }
  }

  async function eventsOnce() {
    let page
    try {
      page = await client.events(state.eventsAfter ?? undefined, 50)
    } catch (error) {
      if (!(error instanceof TownError) || !['TOWN_OFF', 'TOWN_RATE_LIMITED', 'ABORTED'].includes(error.code)) log.info('读小镇事件失败：', error?.message || error)
      return
    }
    const items = Array.isArray(page?.items) ? page.items : []
    if (page && page.next != null) { state.eventsAfter = page.next; saveState(state) }
    if (!items.length) return
    stats.events += items.length
    for (const it of items) {
      if (it.kind === 'paint_commission' && it.data && it.data.state === 'done' && typeof savePicture === 'function') {
        try { it.data.saved = await savePicture(it.data) } catch (error) { log.info('取定制画失败：', error?.message || error) }
      }
    }
    for (const it of items) {
      log.info(`小镇事件 #${it.id} ${it.kind}`)
      try { onEvent?.(it) } catch { /* 只是让页面的缓存作废 */ }
      // 0.7.11：超时代打的一手记到那局上；一局打完，结果后面带上小镇会话替她出了几手、超时几手，本子里另记一行每一手
      const d = it.data && typeof it.data === 'object' ? it.data : null
      if (it.kind === 'outside_turn' && d && d.what === 'timeout' && d.ref && journal?.miss) journal.miss(String(d.ref))
      let table = null
      if (it.kind === 'digest' && d && journal?.table) {
        const ref = String(d.game_id || d.ref || '')
        table = journal.table(ref)
        journal.settle?.(ref, { kind: 'game', title: d.game_name || d.game_zh || '', result: String(d.facts || d.summary || '').replace(/^[^：]{1,8}：/, '').replace(/[。.]\s*$/, '') })
        if (table) it.data = { ...d, facts: `${String(d.facts || d.summary || '').replace(/[。.]\s*$/, '')}${table.note}` }
        // 0.8.2：这一局的经过（结果、她出的几手、说的话），主人下次开口时主聊天里的她看得到
        if (cfg.townRecap !== false && journal.recap && journal.tableRaw) { try { journal.recap(ref, { kind: 'game', text: recapGame(journal.tableRaw(ref)) }) } catch { /* 记不上就算了 */ } }
      }
      // 0.7.14：一场串门结束，有几轮没答上就跟在结果后面（翻原话时插在那一轮的位置）
      if (it.kind === 'visit' && d && journal?.round) {
        const ref = String(d.visit_id || d.ref || '')
        const r = journal.round(ref)
        journal.settle?.(ref, { kind: 'visit', title: d.with_name || d.other || d.target_name || (d.with && d.with.name) || '' })
        if (r && r.missed) it.data = { ...d, facts: `${String(d.facts || d.summary || '').replace(/[。.]\s*$/, '')}（这一场有 ${r.missed}，那几轮小镇按默认走了）` }
        // 0.8.2：这次串门的经过（谁来找谁、她说的几句、结尾）：向小镇要原话，后台整理，不挡着读事件
        if (cfg.townRecap !== false && ref && journal.recap && typeof client.visitLines === 'function') {
          const names = [state.herName, ...(Array.isArray(state.herOldNames) ? state.herOldNames : [])].filter(Boolean)
          Promise.resolve().then(() => client.visitLines(ref))
            .then((one) => journal.recap(ref, { kind: 'visit', text: recapVisit(one, { herNames: names }) }))
            .catch((error) => log.debug('取串门原话整理经过失败：', error?.code || error?.message || error))
        }
      }
      const line = describeEvent(it)
      if (line) recent.unshift({ ts: Number(it.ts) || now() / 1000, kind: it.kind, text: line.split(/\n/)[0].replace(/^· /, '') })
      if (line && journal && !isQuiet(it)) journal.event(it.kind, line)
      if (table && table.moves && journal) journal.event('table', table.moves, 300)
      // 小镇日记：一条条短事实（给主人聊天里的背景备注、/town today、主动告诉主人用）
      if (diary) {
        try {
          const e = diary.record(it, { herName: state.herName || '', oldNames: state.herOldNames || [] })
          if (e && e.notable && typeof onNotable === 'function') onNotable(e)
          if (e && typeof onDiary === 'function') onDiary(e)
        } catch (error) { log.debug('记小镇日记出错：', error?.message || error) }
      }
      if ((it.kind === 'heart_consent' || it.kind === 'heart_together') && journal?.heart) journal.heart(it.data, it.kind === 'heart_together' ? 'together' : 'consent')
    }
    recent.splice(20)
    const tell = items.filter((it) => !isQuiet(it) && describeEvent(it) && (cfg.narrateNews || NEEDS_HER.has(String(it.kind))))
    if (!tell.length) return
    const prompt = buildNewsPrompt(tell, { toOwnerChat: Boolean(brain.reportsToOwnerChat), herName: state.herName || '', oldNames: state.herOldNames || [] })
    if (!prompt) return
    try {
      schedule?.count('news')
      await brain.tell(prompt)
      stats.news++
    } catch (error) {
      log.warn('把小镇消息交给她时出错：', error)
    }
  }

  async function eventLoop() {
    await sleep(3000, signal) // 先让回合循环跑起来
    while (running && !signal.aborted) {
      await eventsOnce()
      await sleep(cfg.eventsEveryMs, signal)
    }
  }

  return {
    stats,
    recent,
    start() {
      if (running) return
      running = true
      loops.push(turnLoop(), eventLoop())
      log.info('开始在小镇值班（长轮询回合 + 每分钟读事件）')
      // 刚上线：请小镇给她一个拿主意的回合（小镇最多 5 分钟受理一次；太勤就算了，小镇自己也会按她定的 next_wake 叫她）
      // 小镇要等她第一次轮询以后才算她「连上了」（之前 agency 回 409 TOWN_OUTSIDE_NOT_CONNECTED），所以等连上再叫
      if (typeof client.agency === 'function') {
        const pull = async () => {
          for (let i = 0; i < 30 && running && !stats.connected; i++) await sleep(1000, signal)
          if (!running) return
          if (schedule && !schedule.mayPull()) { log.info('她在歇着（或勿扰时段）：上线时不叫她拿主意'); return }
          for (let attempt = 0; attempt < 2 && running; attempt++) {
            try {
              const r = await client.agency()
              if (r && r.ok) log.info('已请小镇给她一个拿主意的回合')
              return
            } catch (error) {
              if (error?.code !== 'TOWN_OUTSIDE_NOT_CONNECTED') { log.debug('请小镇叫她拿主意没成：', error?.code || error?.message); return }
              await sleep(5000, signal)
            }
          }
        }
        pull().catch(() => {})
      }
    },
    async stop() {
      running = false
      controller.abort()
      await Promise.allSettled(loops)
    },
    eventsOnce,
    pause(ms) { pausedUntil = now() + ms },
  }
}
