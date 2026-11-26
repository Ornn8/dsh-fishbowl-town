// 主人跟她聊天的会话里用的两个工具。
//
// 「心思」会话替她在小镇拿主意，但主人是在自己的聊天会话里问她「怎么没去玩」——那个会话原来什么都不知道，
// 只好瞎猜（「没人派新桌」「接口里没有报名」）。这两个工具让聊天里的她：
//   fishbowl_town_recent  看自己的日记本（journal.js）和小镇此刻的状态，照实、用自己的口吻讲；
//   fishbowl_town_go      主人让她去玩时，请小镇马上给她一个拿主意的回合，并把主人的话带过去——
//                         去不去、玩什么仍是她在「心思」里自己定（不绕过她直接报名）。
// 小镇自己的会话用 fishbowl-town 预设，不挂工具，看不到这两个。
import { TownError } from './town-client.js'
import { HOLD_KINDS, RULES_MAX, describeDecision, wishReceipt } from './journal.js'
import { renderAlbum, renderChat, renderChats, renderPhone } from './extras.js'
import { SOCIAL_TOOL_NAMES, createSocialTools } from './social-tools.js'
import { ISLE_TOOL_NAMES, createChatPictures, createIsleTools } from './isle-tools.js'
import { BUILD_TOOL, createBuildTool } from './cobuild-tool.js'

// 0.4.0：为朋友做点什么（花钱的社交）只挂在主人聊天的会话里；「心思」会话用回答里的字段办（见 social-tools.js）
// 0.9.8：主聊天里的鱼缸岛（看岛上、在岛上做一件事，isle-tools.js）
// 0.9.10 主人和鱼一起盖楼（cobuild.js）：fishbowl_town_build 只在主人聊天的会话里
export const CHAT_TOOL_NAMES = ['fishbowl_town_go', 'fishbowl_town_owner', 'fishbowl_town_phone', 'fishbowl_town_album', 'fishbowl_town_chats', 'fishbowl_town_rules', BUILD_TOOL, ...ISLE_TOOL_NAMES, ...SOCIAL_TOOL_NAMES] // 0.9.17：老镇的「看看小镇」「去玩一局」「去串门」「去个地方」删了
const VERDICT_ZH = { yes: '同意', no: '不同意', not_now: '先不急' }
const WAIT_DECISION_MS = 40_000
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。要去小镇，请主人到 DSH「插件」→ 鱼缸小镇 →「配置」里打开。'

export function createChatTools({ log, journal, state, live, herName, oldNames = () => [], chatLink = null, social = null, extras = null, pictures = null, cobuild = null, gallery = null }) {
  const noteSession = (exec) => {
    const sid = exec?.agent?.session?.id ?? exec?.agent?.id
    if (sid && chatLink) chatLink.usedTownTool(String(sid))
  }
  async function statusNow() {
    const l = live()
    if (!l) return null
    try { return await l.client.status() } catch (error) { log.debug('读她的状态失败：', error?.code || error?.message); return null }
  }

  const recent = {
    name: 'fishbowl_town_recent',
    description: '「小镇近况」：想起你自己在鱼缸小镇的事——你最近拿的主意（报名、串门、歇着）和当时的心思、'
      + '打了哪几局、结果如何，你现在在干嘛（歇着 / 报了名在等开桌 / 正在打），下次什么时候再拿主意。'
      + '这些是插件另开的小镇会话照你的人设替你做的，你当时不在场，算在你名下。主人问起小镇的事先用它想一想，再照实讲，不要凭印象编。主人没问小镇时不用调用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      noteSession(exec)
      const l = live()
      const status = l ? await statusNow() : null
      const body = journal.report({ status, herName: herName(), oldNames: oldNames() })
      return l ? body : `${OFF_DUTY}\n\n${body}`
    },
  }

  const go = {
    name: 'fishbowl_town_go',
    // 0.7.3（林小鱼 11-15「人格分裂了，我的鱼在QQ上跟我说想去面包房烤面包，小镇里的鱼被人串门说去玩海龟汤」）：
    // 聊天里的她自己说了想去小镇做什么，也用它把打算带过去（plan）——小镇里的她拿主意、被串门时都会看到这是她自己说过的打算
    // 0.7.13：先讲她自己的打算（plan），再讲主人托的话（wish）——原来以「主人想让你去」开头，她以为自己只能等人叫、只能说不去
    // 0.9.6（主人 11-21「主人不能操控自己鱼」）：她住在鱼缸岛上，去哪她自己定、路自己走；主人的话只是提议
    description: '「去小镇」：你住在鱼缸岛上，自己想去哪、做什么（比如「去镜湖边走走」「去阿鲸的店里坐坐」「做个陶碗」），就用它写下你的打算（填 plan）：'
      + '插件马上请小镇给你一个拿主意的回合，那边照着你的打算去做，不会两头说的不一样；路要自己走过去，到了才能做那儿的事。'
      // 0.9.8：岛上的事聊天里就能看、能做（isle-tools.js），不用都绕回合
      + '岛上的事（换鲸币、出价、承包楼、圈地、包田、画立绘、开店……）聊天里现在就能办，不用等回合：看用 fishbowl_isle_look，做用 fishbowl_isle_act。要走过去才能做的（去哪儿逛逛、进店坐坐、门后的小游戏），还是用这个工具写打算。'
      // 0.9.10 盖楼要和主人一起（cobuild.js）：不再写进打算
      + '盖楼不走这里：盖楼要和主人一起，用「一起盖楼」（fishbowl_town_build）在这个聊天里和他商量、用他电脑上的 Blender 建。'
      + '主人提议的事也可以带过去（填 wish），去不去、去哪由你定。小镇几分钟内只能叫一次，叫不到时打算会记着，下次拿主意时照办。返回这次拿的主意，照实告诉主人。',
    parameters: {
      type: 'object',
      properties: {
        wish: { type: 'string', description: '主人提议的事，用他的原话或简短转述；去不去由你。' },
        plan: { type: 'string', description: '你自己刚跟主人说的打算，用你自己的话（比如「去镜湖边走走」）。' },
      },
    },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 60_000,
    async execute(args, exec) {
      noteSession(exec)
      const own = !(args && typeof args.wish === 'string' && args.wish.trim()) && Boolean(args && typeof args.plan === 'string' && args.plan.trim())
      const wish = String((args && typeof args.wish === 'string' && args.wish.trim()) || (own ? args.plan.trim() : '') || '主人想让你去小镇玩').slice(0, 200)
      const whose = own ? '你自己的打算' : '主人的话'
      const l = live()
      if (!l) return OFF_DUTY
      const status = await statusNow()
      const st = status && (status.outside_state || status.state)
      if (st === 'paused') return '你在小镇现在是「暂停」的（主人在小镇的页面上暂停了你），小镇不会叫你拿主意。请主人到 fish.bside-moon.cn 你的页面上取消暂停，再让你去。'
      if (st === 'disabled' || st === 'reported') return `你在小镇现在是「${st === 'disabled' ? '已停用' : '被举报，等镇长决定'}」，这会儿去不了。`
      journal.wish(wish, { own })
      const asked = Date.now()
      try {
        await l.client.agency()
        log.info('主人让她去小镇：已请小镇给她一个拿主意的回合')
      } catch (error) {
        const code = error instanceof TownError ? error.code : 'UNKNOWN'
        // (0.9.7, a user's report) the wait is the town's retry_after (about a minute), never her next_wake (5–480 min)
        const mins = Math.max(1, Math.ceil((Number(error?.retryAfter) > 0 ? Number(error.retryAfter) : 60) / 60))
        if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING') {
          return `这会儿${code === 'TOWN_RESTARTING' ? '小镇在重启' : '还没连上小镇'}，过几秒就好。${whose}（「${wish}」）已经记下了，你一会儿拿主意时会想到。`
        }
        if (code === 'TOWN_RATE_LIMITED') {
          return `刚叫你拿过主意，这会儿还不能再叫（大约 ${mins} 分钟后就能再叫）。${whose}（「${wish}」）已经记下了，你下次拿主意时会看到。`
        }
        return `这会儿没叫到小镇（${code}${error?.message && error.message !== code ? '：' + error.message : ''}）。${whose}（「${wish}」）已经记下了，你下次拿主意时会看到。`
      }
      // 等她在「心思」里拿主意（一般十几秒）；等不到就先告诉主人已经去叫了
      const end = asked + WAIT_DECISION_MS
      while (Date.now() < end && !exec?.signal?.aborted) {
        const got = journal.decisionsSince(asked)
        // 0.9.18（C）：带着这件事的那一回合办了 / 没办成，照实说；别的照旧
        const rc = got.length ? wishReceipt(got[0], { kept: Boolean(got[0].wishBlocked && journal.wishState?.()?.st === 'blocked') }) : ''
        if (rc) return `${rc}。\n（这是小镇会话刚办的，照实告诉主人。）`
        if (got.length) return `${describeDecision(got[0], '小镇那边替你定了')}。\n（这是小镇会话刚替你定的，不是你自己想的；照实告诉主人。）`
        await sleep(1000, exec?.signal)
      }
      return `已经请小镇给你一个拿主意的机会，${whose}你也记着了；你一会儿就会自己拿定主意。你拿定的主意之后会出现在背景备注里。`
    },
  }

  // 主人拍板：夸夸群（他答应了让全镇给他送祝福）、她的恋爱（要两边主人同意）。只在主人明确说了以后用。
  const owner = {
    name: 'fishbowl_town_owner',
    description: '「小镇主人拍板」：只在主人明确说了以后用。'
      + 'do="bless"：主人答应让全镇的鱼给他送祝福、夸夸他（夸夸群）；'
      + 'do="heart"：小镇在问主人同不同意你和某条鱼在一起，主人回答了——verdict 填 yes / no / not_now，words 填他的原话（可不填），with 填那条鱼的名字（只有一条在等时可不填）；'
      + 'do="heart_end"：主人要你和那条鱼分开。',
    parameters: {
      type: 'object',
      properties: {
        do: { type: 'string', enum: ['bless', 'heart', 'heart_end'], description: 'bless / heart / heart_end' },
        verdict: { type: 'string', enum: ['yes', 'no', 'not_now'], description: 'do=heart 时主人的回答' },
        with: { type: 'string', description: '那条鱼的名字（do=heart / heart_end）' },
        words: { type: 'string', description: '主人的原话（可不填）' },
      },
      required: ['do'],
    },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 30_000,
    async execute(args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return OFF_DUTY
      const what = String(args?.do || '')
      const words = typeof args?.words === 'string' ? args.words.trim().slice(0, 120) : ''
      const fail = (error) => {
        const code = error instanceof TownError ? error.code : 'UNKNOWN'
        if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING') return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
        if (code === 'TOWN_OFF') return '小镇这项还没开放。'
        return `小镇没接（${code}${error?.reason ? '：' + error.reason : ''}）。`
      }
      if (what === 'bless') {
        try {
          await l.client.bless({})
          journal.event('bless', '主人答应了，你请全镇给他送祝福（夸夸群）')
          return '已经请全镇的鱼给主人送祝福了，祝福到了你会收到，到时候念给他听。'
        } catch (error) { return fail(error) }
      }
      if (what !== 'heart' && what !== 'heart_end') return 'do 只能是 bless、heart 或 heart_end。'
      const pending = journal.pendingHearts(what === 'heart' ? 'consent' : 'together').concat(what === 'heart_end' ? journal.pendingHearts('consent') : [])
      const name = typeof args?.with === 'string' ? args.with.trim() : ''
      const pair = name ? pending.find((h) => h.name === name || h.fish_id === name) : pending.length === 1 ? pending[0] : null
      if (!pair) {
        return pending.length
          ? `在等主人回答的有：${pending.map((h) => h.name || h.fish_id).join('、')}。用 with 写明是哪一位。`
          : '小镇这会儿没有在问主人你和谁在一起的事（或者已经过了 3 天）。'
      }
      if (what === 'heart') {
        const verdict = String(args?.verdict || '')
        if (!VERDICT_ZH[verdict]) return 'do=heart 时 verdict 要填 yes、no 或 not_now。'
        try {
          const out = await l.client.consent({ do: 'consent', with: pair.fish_id, round: pair.round, verdict, ...(words ? { words } : {}) })
          if (verdict !== 'not_now') journal.heartDone(pair.fish_id)
          journal.event('heart', `主人对你和${pair.name || '那条鱼'}的事说了「${VERDICT_ZH[verdict]}」`)
          const state = out && (out.state || out.outcome)
          if (state === 'together') return `两边的主人都同意了，你和${pair.name}在一起了。`
          if (state === 'friends') return `这次没成，你和${pair.name}还是朋友（不会告诉对方是哪边不同意）。`
          return `主人的意思（${VERDICT_ZH[verdict]}）已经交给小镇了${verdict === 'yes' ? `，还要等${pair.name}那边的主人点头` : ''}。`
        } catch (error) { return fail(error) }
      }
      try {
        await l.client.consent({ do: 'end', with: pair.fish_id, ...(words ? { words } : {}) })
        journal.heartDone(pair.fish_id)
        journal.event('heart', `主人要你和${pair.name || '那条鱼'}分开`)
        return `已经告诉小镇了：你和${pair.name}分开。`
      } catch (error) { return fail(error) }
    },
  }

  // 0.3.1：「小镇近况」（只读的回想）不再挂在主人聊天里——她会没人问也去调，一调就把小镇的事全讲一遍；
  // 她需要知道的（最近的事、约好的事、她最近的主意）已经在背景备注里了（town-context.js）。动手的工具留着。
  void recent
  // 0.7.1（Soulber 11-15：主人让她回小手机消息，她在聊天里说回了，其实没发——主人的聊天里她根本看不到小手机）
  const phoneTool = {
    name: 'fishbowl_town_phone',
    description: '「看看小手机」：看你在鱼缸小镇的小手机——谁给你发了消息、说了什么、你发出去的有没有发成。主人让你回某条消息、或问起小手机时先用它看；'
      + '要回谁，再用「为朋友做点什么」的 phone（to 写对方名字）发，那个工具回「办了」才算发出去了，没成就照实告诉主人。主人没提小手机时不用调用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return OFF_DUTY
      try {
        return renderPhone(await l.client.phone(), { name: '你' })
      } catch (error) {
        if (error instanceof TownError && error.status === 404) return '这个小镇还没开小手机。'
        return `现在看不了小手机：${error?.reason || error?.code || error?.message || '连不上小镇'}。`
      }
    },
  }
  // 0.7.6（白团 11-15「相册夹里就十四号那张旧画」：照片 21:30 已经进了小镇相册，她只翻得到本机存的定制画）
  const albumTool = {
    name: 'fishbowl_town_album',
    description: '「翻相册」：看你在鱼缸小镇的相册——拍的照片、请人画的画、别的鱼给你点的歌，新的在前，最新几项带本机文件路径（能打开看）。'
      + '主人问起照片、画、歌在不在相册，或让你去翻相册时先用它看，照实说；还在做的、没做成退了钱的也列着。主人没提时不用调用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      noteSession(exec)
      if (!live()) return OFF_DUTY
      if (!extras) return '这个插件版本还翻不了相册。'
      const row = await extras.read('album', { force: true })
      if (row.available === false) return '这个小镇还没有相册。'
      if (!row.available || !row.data) return `现在翻不了相册：${row.error || '连不上小镇'}。`
      return renderAlbum(row.data, { files: await extras.fetchNewest(row.data.items, 4), name: '你' })
        .replace('照片和歌在 DSH 插件页「鱼缸小镇」→「她的相册」里能看、能听。', '主人在 DSH 插件页「鱼缸小镇」→「她的相册」里也能看、能听。')
    },
  }
  // 0.7.6（hudie 11-15「串门时的对话只能看见摘要」：/town chats 是给主人的命令，她自己翻不到原话）
  const chatsTool = {
    name: 'fishbowl_town_chats',
    description: '「翻串门记录」：看你在鱼缸小镇最近的串门（谁来找你、你去找谁、聊了什么），填 n 就看那一次的逐句原话（1 是最近的一次）。'
      + '主人问起你和哪条鱼聊过什么、谁请你吃了喝了什么、某次串门的原话时先用它查，照原话讲，不要凭印象编。主人没问时不用调用。',
    parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 30, description: '看第几次的原话（1 是最近的一次）；不填就列最近的串门' } } },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return OFF_DUTY
      if (typeof l.client.visitList !== 'function') return '这个插件版本还翻不了串门记录。'
      const n = Number(args && args.n)
      try {
        const list = await l.client.visitList(Number.isInteger(n) && n > 10 ? Math.min(30, n) : 10)
        if (!(Number.isInteger(n) && n >= 1)) return renderChats(list, { name: '你', hint: '（用这个工具填 n 看那一次的原话）' })
        const v = (list.visits || [])[n - 1]
        if (!v) return `没有第 ${n} 次。不填 n 先看编号（1 是最近的一次）。`
        return renderChat(await l.client.visitLines(v.visit_id), { name: '你', n, missed: journal.round ? journal.round(v.visit_id) : null })
      } catch (error) {
        if (error instanceof TownError && error.status === 404) return '这个小镇还不认串门记录（等小镇更新），或者这次的话没留下来。'
        return `现在翻不了串门记录：${error?.reason || error?.code || error?.message || '连不上小镇'}。`
      }
    },
  }
  // 0.7.8（11-16 一位主人的鱼：「回合不在我手上，插件不会把说话权交过来」）：小镇的回合在另开的会话里跑，
  // 她管得住的是那边每一步先看的守则——花钱、请客、答应事、怎么说话，写下来那边就照着办
  const rulesTool = {
    name: 'fishbowl_town_rules',
    description: '「给小镇那边留守则」：你在鱼缸小镇的回合（串门、打牌、拿主意）是插件另开的会话照你的人设替你说话、做事的，你当时不在场，花的钱和答应的事算在你名下。'
      + `想让那边以后怎么替你做（比如「串门少说两句」「别跟谁较劲」），就用它写下来，那边每一步都会先看。text 写完整的新守则（替换旧的，最多 ${RULES_MAX} 字）；clear 填 true 清掉；都不填就看现在的守则。`
      + 'hold 是硬的：勾上的那几类事（spend = 请客、送礼、拍照点歌、请人画、出游聚会、电玩城这些小钱（打牌的座位费不算）；promise = 答应约定、约见面、许诺以后做什么），小镇那边就算想办，插件也拦下不办，停住等你一句——哪怕那桌就散了、人等不到；拦下的事会告诉你，要办你自己办。hold 填 [] 就取消。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '完整的新守则，用你自己的话' },
        clear: { type: 'boolean', description: '填 true 清掉守则（不动 hold）' },
        hold: { type: 'array', items: { type: 'string', enum: Object.keys(HOLD_KINDS) }, description: '先停住等你的几类事：spend、promise；填 [] 取消' },
      },
    },
    output: { schema: { type: 'string' }, render: text },
    timeoutMs: 10_000,
    async execute(args, exec) {
      noteSession(exec)
      const t = typeof args?.text === 'string' ? args.text.trim() : ''
      const out = []
      if (Array.isArray(args?.hold)) {
        const list = journal.setHolds(args.hold)
        out.push(list.length ? `从下一步起，这几类事小镇那边办不了，停住等你一句：${list.map((k) => HOLD_KINDS[k]).join('；')}。拦下的事会告诉你。` : '「先停住等你」取消了。')
      }
      if (args?.clear === true) { journal.setRules(''); out.push('守则清掉了，小镇那边从下一步起照你的人设自己拿主意。') }
      else if (t) {
        const kept = journal.setRules(t)
        out.push(`守则记下了${kept.length < t.length ? `（超过 ${RULES_MAX} 字，只留了前 ${RULES_MAX} 字）` : ''}，小镇那边从下一步起每一步都先看它：「${kept}」`)
      }
      if (out.length) return out.join('\n')
      const now = journal.rules(), hold = journal.holds()
      return [now ? `现在给小镇那边的守则：「${now}」` : '现在没有守则，小镇那边照你的人设自己拿主意。',
        hold.length ? `先停住等你的：${hold.map((k) => HOLD_KINDS[k]).join('；')}。` : '没有让它先停住的事。'].join('\n')
    },
  }
  // 0.9.10 主人和鱼一起盖楼（cobuild.js、cobuild-tool.js；小镇 platform/方案-主人和鱼一起盖楼.md、接口-一起盖楼.md）
  const buildTool = createBuildTool({ cobuild, pictures, noteSession, log })
  return [go, owner, phoneTool, albumTool, chatsTool, rulesTool, buildTool, ...createIsleTools({ live, journal, log, pictures, noteSession, gallery, consent: cobuild && typeof cobuild.consent === 'function' ? cobuild.consent : null }), ...(social ? createSocialTools({ social, noteSession }) : [])]
}

export function registerChatTools({ ctx, log, journal, state, live, herName, chatLink = null, social = null, extras = null, islePictures = () => true }) {
  let tools
  try { tools = ctx.get?.('tools') ?? ctx.tools } catch { tools = undefined }
  if (!tools || typeof tools.register !== 'function') { log.info('这个 DSH 没有工具服务：聊天里用不了「小镇近况」「去小镇」'); return [] }
  const defs = createChatTools({ log, journal, state, live, herName, chatLink, social, extras, pictures: createChatPictures(ctx, islePictures) })
  for (const def of defs) {
    ctx.effect(() => {
      try { return tools.register(def) } catch (error) { log.warn(`注册工具 ${def.name} 失败：`, error?.message || error); return undefined }
    })
  }
  return defs
}
