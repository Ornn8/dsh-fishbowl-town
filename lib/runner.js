// 核心循环：长轮询小镇的回合 -> 交给 DSH 里的她回答 -> 时限内交回；定时读事件讲给她听。
// 不认识 DSH：DSH 那半边是传进来的 brain（见 dsh-brain.js），测试里换成假的。
import { buildCorrection, buildTurnPrompt, toAnswer } from './prompt.js'
import { buildNewsPrompt, describeEvent, isQuiet } from './events.js'
import { TownError } from './town-client.js'

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

export const DEFAULTS = {
  pollWaitS: 25,
  marginMs: 1500, // 交回去之前留的余量（网络来回）
  minBudgetMs: 3000, // 剩下不到这么多就不问了（反正来不及）
  retryMinMs: 8000, // 第一次答得不能读时，剩下的时间够这么多才追问一次
  eventsEveryMs: 60_000,
  eventsBatchMs: 0, // 事件攒多久再讲（0 = 每次读到就讲）
  seenKeep: 500,
}

export function createRunner({ client, brain, log, config = {}, state = {}, saveState = () => {}, now = () => Date.now(), savePicture = null }) {
  const cfg = { ...DEFAULTS, ...config }
  const controller = new AbortController()
  const signal = controller.signal
  const seen = new Map() // turn_id -> 'working' | 'done'
  const stats = { turns: 0, answered: 0, invalid: 0, late: 0, closed: 0, errors: 0, events: 0, news: 0, decisions: 0, lastTurnAt: 0, problem: '' }
  const recent = [] // 最近的小镇事件（给设置页看）
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
    return left - cfg.marginMs
  }

  async function handleTurn(turn, receivedAt) {
    stats.turns++
    const id = turn.turn_id
    try {
      let left = msLeft(turn, receivedAt)
      if (left < cfg.minBudgetMs) { stats.late++; log.info(`回合 ${id} 来不及答（剩 ${Math.round(left)}ms），让小镇用默认动作`); return }
      const slot = turn.kind === 'visit' ? 'visit' : turn.kind === 'agency' ? 'agency' : 'game'
      const prompt = buildTurnPrompt(turn, { secondsLeft: Math.floor(left / 1000) })
      let raw = await brain.ask(slot, prompt, { timeoutMs: left, turnId: id })
      let answer = toAnswer(turn, raw)
      left = msLeft(turn, receivedAt)
      if (answer === null && left >= cfg.retryMinMs) {
        log.info(`回合 ${id} 第一次的回答读不了，追问一次`)
        raw = await brain.ask(slot, buildCorrection(turn), { timeoutMs: left, turnId: id, followup: true })
        answer = toAnswer(turn, raw)
      }
      if (answer === null) { stats.invalid++; log.info(`回合 ${id} 的回答读不了，不交（小镇用默认动作）`); return }
      if (msLeft(turn, receivedAt) + cfg.marginMs <= 0) { stats.late++; log.info(`回合 ${id} 答好时已经过了时限`); return }
      if (turn.kind === 'agency') {
        try {
          const a = JSON.parse(answer)
          stats.decisions++
          log.info(`她的主意：${a.action || 'none'}${a.next_wake != null ? `，${a.next_wake} 分钟后再看看` : ''}${a.note ? `（${String(a.note).slice(0, 40)}）` : ''}`)
        } catch { /* 交给小镇判 */ }
      }
      await client.answer(id, answer)
      stats.answered++
      stats.lastTurnAt = now()
      log.info(`回合 ${id} 已交（${turn.kind}/${turn.packet?.game || '-'}，${now() - receivedAt}ms）`)
    } catch (error) {
      if (error instanceof TownError && error.code === 'TOWN_OUTSIDE_TURN_CLOSED') { stats.closed++; log.info(`回合 ${id} 已经关了（晚了或答过了）`); return }
      if (error && error.code === 'BRAIN_TIMEOUT') { stats.late++; log.info(`回合 ${id} 她没在时限内答完`); return }
      if (!running) return // 插件在卸载：不算错
      stats.errors++
      log.warn(`回合 ${id} 出错：`, error)
    } finally {
      remember(id, 'done')
    }
  }

  async function backoffFor(error) {
    const code = error instanceof TownError ? error.code : 'UNKNOWN'
    stats.problem = code
    if (code === 'TOWN_OUTSIDE_CODE' || code === 'NO_CODE') {
      if (now() - lastAuthNotice > 6 * 3600_000) {
        lastAuthNotice = now()
        log.warn('小镇接入码不对、换过了或已停用：先停下，10 分钟后再试。到插件设置里换上新的接入码。')
        brain.notify?.('小镇说接入码不对、换过了或已停用。请到 DSH 设置 → 插件 → 鱼缸小镇，换上新的小镇接入码。')
      }
      return 10 * 60_000
    }
    if (code === 'TOWN_OFF') { log.info('小镇的外来鱼接口还没开放，5 分钟后再看'); return 5 * 60_000 }
    if (code === 'TOWN_OUTSIDE_POLL_OPEN') { log.warn('同一个接入码已经有别的程序在长轮询（是不是开了两个 DSH？），30 秒后再试'); return 30_000 }
    if (code === 'TOWN_RATE_LIMITED') return 30_000
    if (code === 'ABORTED') return 0
    stats.errors++
    const n = Math.min(3, (backoffFor.n = (backoffFor.n || 0) + 1)) // 最多等 8 秒：牌局还在进行，回合 25 秒就过期
    log.info(`连不上小镇（${error?.message || code}），${2 ** n} 秒后重试`)
    return 2 ** n * 1000
  }

  async function turnLoop() {
    while (running && !signal.aborted) {
      if (now() < pausedUntil) { await sleep(pausedUntil - now(), signal); continue }
      let page
      try {
        page = await client.turns(cfg.pollWaitS, signal)
        backoffFor.n = 0
        stats.problem = ''
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
      const line = describeEvent(it)
      if (line) recent.unshift({ ts: Number(it.ts) || now() / 1000, kind: it.kind, text: line.split(/\n/)[0].replace(/^· /, '') })
    }
    recent.splice(20)
    const tell = items.filter((it) => !isQuiet(it) && describeEvent(it))
    if (!tell.length) return
    const prompt = buildNewsPrompt(tell, { toOwnerChat: Boolean(brain.reportsToOwnerChat), herName: state.herName || '' })
    if (!prompt) return
    try {
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
      if (typeof client.agency === 'function') {
        sleep(2000, signal).then(() => (running ? client.agency() : null)).then((r) => {
          if (r && r.ok) log.info('已请小镇给她一个拿主意的回合')
        }).catch((error) => log.debug('请小镇叫她拿主意没成：', error?.code || error?.message))
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
