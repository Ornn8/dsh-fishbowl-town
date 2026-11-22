// 0.9.8 主聊天里的鱼缸岛（11-22 林蓝的主人：「我的鱼获取不到 他现在调用不了岛上的工具 只能用镇上的」；小镇 platform/接口-主聊天岛上工具.md）。
// 岛上的事原来只能在小镇派来的回合里写 {"world":{…}}，查看也要开着的回合号：主聊天里的她什么都看不到、做不了。
// 小镇开了两个不等回合的口子，插件在主聊天里给她两个工具：
//   fishbowl_isle_look  看岛上（POST isle/look {read}）：和回合里查的一样，默认「我的」（她自己的全部，一页）；带图的页照回合里的办法取图
//   fishbowl_isle_act   在岛上做一件事（POST isle/act {world, ref}）：和回合里写的 world 一模一样；岛上回的那句话原样给她
// 两个口子除了接入码不对、小镇没开外来的鱼、小镇太忙，都回 200 {ok, code, text}：text 原样给她。
// 旧小镇没有这两个口子（404）：照实说还没开，指回「去小镇」（把打算带进回合里办），不报错。
// 花主人饭票（真钱）的两件事（fx_buy 换鲸币、sprite_set 画整套立绘）：要主人在这段聊天里叫她做或点了头，owner_words 填他的原话，没有就不发。
// 盖楼不在这里（小镇回 cobuild）：插件先接住，指回「去小镇」的回合里盖（0.9.7 的建模回合）。
import { TownError } from './town-client.js'
import { NO_PICS_HEAD, picsOf } from './isle.js'
import { failText } from './self-serve.js'

export const ISLE_LOOK = 'fishbowl_isle_look'
export const ISLE_ACT = 'fishbowl_isle_act'
export const ISLE_TOOL_NAMES = [ISLE_LOOK, ISLE_ACT]
export const LOOK_TOPICS = ['我的', '地', '楼', '铺位', '店', '订单', '缺的', '统计', '镇规', '怎么做', '我的店', '价', '地图', '样子', '田']
/** 花主人饭票（真钱）的：要他在聊天里叫她做或点了头。 */
export const OWNER_MONEY = ['fx_buy', 'sprite_set']
const COBUILD = ['build', 'build_guide', 'confirm_build']
const TOPIC_ZH = { 我的: '你自己的', 地: '挂着的地', 楼: '待承包的楼', 铺位: '空铺位', 店: '开着的店', 订单: '接力订单', 缺的: '最缺的', 统计: '镇上统计', 镇规: '镇规', 怎么做: '怎么做', 我的店: '我的店', 价: '价钱', 地图: '地图', 样子: '那儿的样子', 田: '田' }
const VERB_ZH = {
  fx_buy: '换鲸币', fx_sell: '卖鲸币', fx_cancel: '撤卖鲸币的单', bid: '出价', withdraw: '撤回出价', claim: '圈地', confirm_claim: '递圈地申请',
  take_building: '承包楼', field_take: '包田', field_quote: '问田的价', plant: '种地', harvest: '收庄稼', field_release: '退田', lease_building: '租铺位',
  rent_unit: '租楼', offer_unit: '把楼租出去', live: '搬进自己的楼', open: '开店', shop: '经营店', fund: '往店里放鲸币', facade: '改门面',
  sprite_set: '画整套立绘', sprite_tall: '改身高', walk: '走过去', sign_up: '报名活动', borrow: '借鲸币', repay: '还鲸币', demolish: '拆楼',
}
const TEXT_MAX = 1500
const WORDS_MAX = 200
const RETRY_MS = 2000
const clip = (v, n) => { const t = [...String(v ?? '').trim()]; return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('') }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。要用，请主人到 DSH「插件」→ 鱼缸小镇 →「配置」里打开。'
export const NOT_YET = '小镇那边还没开这个（主聊天里看岛上、在岛上做事，要等小镇更新）。现在想在岛上看什么、做什么，用 fishbowl_town_go 把打算写下，小镇给你的回合里去办。'
export const BUILD_HERE = '盖楼不在这里做：用 fishbowl_town_go 写下打算（在哪块地、想盖什么），小镇给你的回合里写 {"world":{"do":"build","lot":"地号","idea":"想盖的"}}，会另给你一个建模回合；量好报价、你点头（confirm_build）才扣鲸币。'
const HONEST = '（这是岛上刚回你的原话。办成了就照这句告诉主人；没办成就照实说没办成、为什么，别说成办了。）'

/** 小镇没接（不是 200）→ 一句白话；旧小镇没有这个口子（404 / 405，不是 TOWN_OFF）→ NOT_YET。 */
export function isleFail(error) {
  if (error instanceof TownError) {
    if (error.code === 'TOWN_OFF') return '小镇这会儿没对外来的鱼开放，岛上的事看不了也做不了。'
    if (error.status === 404 || error.status === 405) return NOT_YET
    if (error.status === 503) return `小镇这会儿太忙，过一会儿再试${error.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  }
  return failText(error)
}

/** 工具参数 -> 小镇的 read：topic（默认「我的」）+ 筛选 + page；more 里的别的筛选也带上。 */
export function readOf(args = {}) {
  const a = args && typeof args === 'object' ? args : {}
  const topic = LOOK_TOPICS.includes(String(a.topic || '').trim()) ? String(a.topic).trim() : '我的'
  const read = { topic }
  let more = a.more
  if (typeof more === 'string') { try { more = JSON.parse(more) } catch { more = null } }
  for (const src of [more && typeof more === 'object' && !Array.isArray(more) ? more : {}, a]) {
    for (const [k, v] of Object.entries(src)) {
      if (k === 'topic' || k === 'more') continue
      if (typeof v === 'string' && v.trim()) read[k] = v.trim().slice(0, 60)
      else if (typeof v === 'number' && Number.isFinite(v)) read[k] = v
      else if (typeof v === 'boolean') read[k] = v
    }
  }
  return read
}

/** 工具参数 -> 小镇的 world：world 对象（也收 JSON 字符串、也收摊在外面的 {do, …}）；没写 do 回 null。 */
export function worldOf(args = {}) {
  const a = args && typeof args === 'object' ? args : {}
  let w = a.world
  if (typeof w === 'string') { try { w = JSON.parse(w) } catch { w = null } }
  if (w && typeof w === 'object' && !Array.isArray(w) && w.world && typeof w.world === 'object') w = w.world // 多包了一层 {"world":{…}}
  if (!(w && typeof w === 'object' && !Array.isArray(w)) && a.do) w = Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'owner_words' && k !== 'world'))
  if (!(w && typeof w === 'object' && !Array.isArray(w))) return null
  const verb = typeof w.do === 'string' ? w.do.trim() : ''
  if (!verb || verb === 'none') return null
  return { ...w, do: verb }
}

/** 插件自己起的单号（小镇：同一条鱼同一个 ref 只办一次；1–40 位 A-Za-z0-9_-）。 */
export function newRef(now = Date.now()) {
  return `dsh-${now.toString(36)}-${Math.random().toString(16).slice(2, 8)}`
}

const retryable = (error) => error instanceof TownError && (error.code === 'NETWORK' || error.status >= 500)

/** 主聊天里能不能给她看图：开关开着、DSH 有附件服务、她这一路的模型收图（和 DSH 的 read_image 一样的检查）。 */
export function createChatPictures(ctx, allowed = () => true) {
  const service = (name) => { try { return ctx?.get?.(name) ?? ctx?.[name] } catch { return undefined } }
  async function canSee(exec) {
    if (!allowed()) return false
    const store = service('attachments')
    if (!store || (typeof store.saveImage !== 'function' && typeof store.admitPromptContent !== 'function')) return false
    try {
      const agent = exec?.agent
      const routed = agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? agent?.options?.provider
      const model = routed?.model ?? agent?.options?.model
      const llm = service('llm')
      if (provider === undefined || model === undefined || typeof llm?.resolveModelInfo !== 'function') return false
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    } catch { return false }
  }
  /** images = [{mediaType, data（base64）}] -> 附件引用（工具结果里的 {type:'image', attachment}）。 */
  async function admit(images) {
    const store = service('attachments')
    if (typeof store?.saveImage === 'function') {
      const out = []
      for (const [k, im] of images.entries()) out.push(await store.saveImage({ data: new Uint8Array(Buffer.from(im.data, 'base64')), mediaType: im.mediaType, name: `isle-${k + 1}.${im.mediaType === 'image/png' ? 'png' : 'jpg'}` }))
      return out
    }
    const parts = await store.admitPromptContent(images.map((im, k) => ({ type: 'image', mediaType: im.mediaType, data: im.data, name: `isle-${k + 1}.${im.mediaType === 'image/png' ? 'png' : 'jpg'}` })))
    return parts.filter((p) => p && p.type === 'image' && p.attachment).map((p) => p.attachment)
  }
  return { canSee, admit }
}

// 值是 {text, images} 或一句话（index.js 里这个会话还没绑定哪条鱼时回的就是一句话）
const lookRender = (_args, value) => (typeof value === 'string' ? [{ type: 'text', text: value }]
  : [{ type: 'text', text: String(value?.text ?? '') }, ...(Array.isArray(value?.images) ? value.images : []).map((attachment) => ({ type: 'image', attachment }))])
const textRender = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

export function createIsleTools({ live, journal = null, log = null, pictures = null, noteSession = () => {} }) {
  const note = (t) => { try { journal?.event?.('self', t) } catch { /* 只是记一笔 */ } }

  async function picsFor(l, r, exec) {
    const pics = picsOf(r)
    if (!pics.length) return { note: '', images: [] }
    const alts = pics.map((p, k) => `${'①②'[k]} ${p.alt || '（没写画的是什么）'}`)
    if (pictures && typeof l.client.islePic === 'function' && await pictures.canSee(exec)) {
      try {
        const got = []
        for (const p of pics) got.push(await l.client.islePic(p.url))
        const images = await pictures.admit(got)
        if (images.length === pics.length) return { note: ['', '', `【这一页带了 ${pics.length} 张图，附在后面】`, ...alts].join('\n'), images }
      } catch (error) {
        log?.info?.(`主聊天里岛上的图没附上（${String(error?.code || error?.message || error).slice(0, 80)}），只给她图上画的是什么`)
      }
    }
    return { note: ['', '', NO_PICS_HEAD, ...alts].join('\n'), images: [] }
  }

  const look = {
    name: ISLE_LOOK,
    description: '「看岛上」：查鱼缸岛上的事，不用等小镇的回合，不花钱、不算做事。topic 默认「我的」：你自己的全部——鲸币、饭票和兑换所的价、在哪住哪、整套立绘、'
      + '名下的地和楼、你的店、你所有还挂着的出价（主人替你出的也在）、欠的、冻住的。别的 topic：地（挂着的地，可填 near、max_coin、min_m2）、楼（待承包的楼）、铺位、店（kind、near）、'
      + '订单、缺的、统计（panel）、镇规、怎么做（verb 填动作名，比如 bid、open、sprite_set）、我的店（spot）、价（good）、地图（near，回一张俯视图）、样子（spot，回一张照片）、田。'
      + '每页 8 条，还有下一页时照它写的填 page。主人问你有多少鲸币、你的地、你的出价、岛上哪儿有什么，先用它查，照查到的讲，不要凭印象编。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: LOOK_TOPICS, description: '查什么；不填就是「我的」' },
        near: { type: 'string', description: '在哪附近：地号、店号、楼号或地名（地、楼、铺位、店、地图、田用）' },
        spot: { type: 'string', description: '店号、地号、楼号或地名（我的店、样子用）' },
        verb: { type: 'string', description: '查「怎么做」时填动作名' },
        good: { type: 'string', description: '查「价」时填货号；不填列出登记的原料' },
        kind: { type: 'string', description: '店或铺位的类' },
        max_coin: { type: 'number', description: '最多多少鲸币（地、楼）' },
        page: { type: 'integer', description: '第几页' },
        more: { type: 'object', additionalProperties: true, description: '别的筛选，照「怎么做」写，比如 {"min_m2":100} 或 {"panel":"我的店"}' },
      },
    },
    output: {
      schema: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, images: { type: 'array', description: 'DSH 附件服务给的图（附在结果后面）' } } }] },
      render: lookRender,
    },
    timeoutMs: 40_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return { text: OFF_DUTY }
      if (typeof l.client.isleLook !== 'function') return { text: NOT_YET }
      const read = readOf(args)
      let r
      try { r = await l.client.isleLook(read) } catch (error) { return { text: isleFail(error) } }
      if (!r || typeof r !== 'object') return { text: '岛上没回话，过一会儿再查。' }
      if (r.ok === false) {
        const old = read.topic === '我的' && /topic 只能是/.test(String(r.text || '')) ? '\n（「我的」岛上还没开，先查「我的店」，或者「地」「楼」「田」。）' : ''
        return { text: `没查到：${clip(r.text || r.code || '岛上没说为什么', TEXT_MAX)}${old}` }
      }
      const pics = await picsFor(l, r, exec)
      const head = `【岛上 · ${TOPIC_ZH[read.topic] || read.topic}】`
      return { text: `${head}\n${clip(r.text || '（这一页是空的）', TEXT_MAX)}${pics.note}`, images: pics.images }
    },
  }

  const act = {
    name: ISLE_ACT,
    description: '「在岛上做一件事」：你住在鱼缸岛上。这里不用等小镇的回合，现在就替你在岛上办一件事，和小镇回合里写的 {"world":{…}} 一模一样、同样的规矩（在哪、钱够不够、竞拍怎么算）。world 填那个对象，比如：'
      + '换鲸币 {"do":"fx_buy","yuan":0.2}（yuan 是花多少元饭票），卖回饭票 {"do":"fx_sell","coin":50}；'
      + '出价抢挂着的地、楼、田 {"do":"bid","auction":"A-0007","max":600}，撤回 {"do":"withdraw","auction":"A-0007"}；'
      + '承包挂牌的楼 {"do":"take_building","building":"B-0493","max":900}；圈地 {"do":"claim","near":"广场","w":12,"d":12,"max":750}；包田 {"do":"field_take","field":"田号"}，种 {"do":"plant","field":"田号","crop":"wheat"}，收 {"do":"harvest","field":"田号"}；'
      + '空楼整栋租出去 {"do":"offer_unit","lot":"地号","kind":"stall","rent":4}；'
      + '画整套立绘（岛上的你：转身、走路、坐、睡觉、干活）{"do":"sprite_set","tall":1.6}，只改身高 {"do":"sprite_tall","tall":1.6}（不收钱）；'
      + '开店 {"do":"open",…}、经营 {"do":"shop",…}、往店里放鲸币 {"do":"fund",…}、改门面 {"do":"facade",…}、走过去 {"do":"walk","to":"地名"}。'
      + '别的动作照岛上的动作表写；不会写先用 fishbowl_isle_look 查「怎么做」（verb 填动作名）。'
      + '换鲸币、画立绘花的是主人的饭票（他的真钱）：只有主人在这段聊天里叫你做、或者你问了他点了头才办，owner_words 填他的原话；他没提就别花，饭票不够就照实说，不要劝他充值。鲸币（你在岛上的钱）怎么花你自己定。'
      + '盖楼不在这里：用 fishbowl_town_go 写打算，小镇的回合里盖。门后的小游戏也在回合里玩。'
      + '回来的是岛上的原话：办成了照实告诉主人，没办成就说没办成和原因，别说成办了。',
    parameters: {
      type: 'object',
      properties: {
        world: { type: 'object', additionalProperties: true, description: '要做的那件事，和回合里 {"world":{…}} 里的那个对象一样，比如 {"do":"bid","auction":"A-0007","max":600}' },
        owner_words: { type: 'string', description: '花主人饭票的事（fx_buy 换鲸币、sprite_set 画立绘）必填：主人在这段聊天里叫你做或点头的原话' },
      },
      required: ['world'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    timeoutMs: 75_000,
    async execute(args, exec) {
      noteSession(exec)
      const l = live()
      if (!l) return OFF_DUTY
      const world = worldOf(args)
      if (!world) return '写一件要做的事：world 填 {"do":"…", …}（和小镇回合里写的 world 一样）。不会写先用 fishbowl_isle_look 查「怎么做」。'
      const verb = world.do
      if (COBUILD.includes(verb)) return BUILD_HERE
      if (verb === 'look') return '查看用 fishbowl_isle_look，不算做事。'
      const words = typeof args?.owner_words === 'string' ? clip(args.owner_words, WORDS_MAX) : ''
      const what = VERB_ZH[verb] || `do=${clip(verb, 24)}`
      if (OWNER_MONEY.includes(verb) && !words) {
        return `${what}花的是主人的饭票（他的真钱）：要主人在这段聊天里叫你做、或者你问了他点了头才办，owner_words 填他的原话。他没提就先别办，也不要劝他充值。什么都没扣。`
      }
      if (typeof l.client.isleAct !== 'function') return NOT_YET
      const ref = newRef()
      let r = null
      for (let k = 0; k < 2; k++) {
        try {
          r = await l.client.isleAct(world, ref)
        } catch (error) {
          // 连不上 / 小镇 5xx：不知道岛上收没收到，同一个 ref 再发一次（岛上只办一次）
          if (k === 0 && retryable(error)) { await sleep(Math.min(5, Number(error.retryAfter) || 0) * 1000 || RETRY_MS); continue }
          const why = isleFail(error)
          if (why !== NOT_YET) note(`你在聊天里想在岛上${what}，没办成：${clip(why, 60)}`)
          return why
        }
        if (k === 0 && r && r.ok === false && r.code === 'unavailable') { await sleep(RETRY_MS); continue } // 岛没答上来：同一个 ref 再问一次
        break
      }
      if (!r || typeof r !== 'object') return `岛上没回话，不知道办没办成：先用 fishbowl_isle_look 查「我的」看一眼。${HONEST}`
      const ok = r.ok !== false
      const said = clip(r.text || (ok ? '办了' : '没办成'), TEXT_MAX)
      note(`你在聊天里${ok ? '' : '想'}在岛上${what}${ok ? '' : '，没成'}：${clip(said, 80)}${words ? `（主人说：「${clip(words, 40)}」）` : ''}`)
      log?.info?.(`她在主聊天里在岛上${what}：${ok ? '成了' : `没成（${r.code || '?'}）`}`)
      return `岛上回你的：「${said}」\n${ok ? '办成了' : `没办成（${clip(r.code || '没说', 24)}）`}。${HONEST}`
    },
  }

  return [look, act]
}
