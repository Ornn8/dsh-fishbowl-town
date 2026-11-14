// 0.4.0 她在聊天里为朋友做点什么：送礼、登日报心意、请朋友出游、办聚会、拍照、点歌、请人画画、用小手机发消息。
//
// 小镇的社交消费（SOCIAL-SPENDING-PLAN）：钱从主人的账户出，所以这条路上有两道规矩——
//   一、不替她花钱：插件自己从不调这些接口；只有她的模型在聊天里调了这个工具（主人让她做、或她自己真想为朋友做），或者在拿主意 / 串门的回合里
//       自己把字段写进回答，才会花。价格、今天还能花多少，小镇写在她的情况里；预算是主人在插件页设的，小镇按它挡。
//   二、她不开口要钱：工具说明和回话里都写明；回话里的价格只给她自己掂量，不让她对主人提钱。
// 这个工具只挂在主人聊天的会话里；拿主意的「心思」会话用回答里的字段办（小镇按 ref 防重复），不挂它，免得两条路各办一遍。
import { randomBytes } from 'node:crypto'
import { TownError } from './town-client.js'
import { failText } from './self-serve.js'

export const SOCIAL_TOOL_NAMES = ['fishbowl_town_friends']
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const HUSH = '（价格只给你自己掂量，不要跟主人提钱）'
const DO_ZH = { gift: '送礼', note: '登日报心意', trip: '请朋友出游', party: '办聚会', photo: '拍照', song: '点歌', paint: '请人画画', phone: '发小手机消息' }

export function createSocialServe({ live, journal, log, diary = null, extras }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (t) => {
    try { journal?.event('self', `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(`我自己${t}`) } catch { /* 只是记一笔 */ }
  }

  async function ids(names) {
    const list = (Array.isArray(names) ? names : names ? [names] : []).map((x) => String(x ?? '').trim()).filter(Boolean)
    const got = []
    for (const n of list) {
      const f = await extras.fishByName(n)
      if (!f) return { error: `没找到叫「${s(n, 12)}」的朋友（你认识的、镇上的鱼才行；先「看看小镇」或去串个门认识一下）。` }
      got.push(f)
    }
    return { fish: got }
  }

  /** 办一件事。返回给她的模型看的话（成没成、为什么、价格只给她自己掂量）。 */
  async function act(args = {}) {
    const what = String(args.do || '')
    if (!DO_ZH[what]) return `do 只能是 ${Object.keys(DO_ZH).join(' / ')}。`
    let c
    try { c = client() } catch { return OFF_DUTY }
    const ref = `p${randomBytes(5).toString('hex')}`
    try {
      let r
      let label
      if (what === 'gift' || what === 'song' || what === 'phone' || what === 'note') {
        const to = args.to ? await ids([args.to]) : { fish: [] }
        if (to.error) return to.error
        const f = to.fish[0]
        if (what !== 'note' && !f) return `${DO_ZH[what]}要说给谁（to：朋友的名字）。`
        if (what === 'gift') {
          if (!args.item) return '送礼要说送什么（item）。'
          label = `送${f.name}${s(args.item, 12)}`
          r = await c.socialDo({ do: 'gift', to: f.fish_id, item: String(args.item), occasion: args.occasion || '就是想送', words: String(args.words || ''), ref })
        } else if (what === 'note') {
          if (!args.text) return '日报心意要写登出来的话（text）。'
          label = `在小镇日报登了一句心意${f ? `给${f.name}` : ''}`
          r = await c.socialDo({ do: 'note', kind: args.kind || '祝福', size: args.size || '一行', text: String(args.text), ...(f ? { to: f.fish_id } : {}), ref })
        } else if (what === 'song') {
          if (!args.song) return '点歌要说歌名（song）。'
          label = `给${f.name}点了《${s(args.song, 16)}》`
          r = await c.song({ to: f.fish_id, title: String(args.song), ...(args.singer ? { singer: String(args.singer) } : {}), ...(args.words ? { words: String(args.words) } : {}), ...(args.occasion ? { occasion: String(args.occasion) } : {}), ref })
        } else {
          if (!args.text) return '小手机要写发什么（text）。'
          label = `用小手机给${f.name}发了消息`
          r = await c.phoneSend({ to: f.fish_id, text: String(args.text), ...(args.meet && typeof args.meet === 'object' ? { meet: args.meet } : {}) })
        }
      } else if (what === 'trip') {
        const w = args.names ? await ids(args.names) : { fish: [] }
        if (w.error) return w.error
        label = `${w.fish[0] ? `请${w.fish[0].name}` : '自己'}去${s(args.place, 8)}`
        r = await c.socialDo({ do: 'trip', place: String(args.place || ''), ...(w.fish[0] ? { with: w.fish[0].fish_id } : {}), ref })
      } else if (what === 'party') {
        const g = await ids(args.names)
        if (g.error) return g.error
        if (g.fish.length < 2) return '办聚会要请 2 到 4 个朋友（names）。'
        label = `办了一场${s(args.kind || '小聚会', 8)}，请了${g.fish.map((f) => f.name).join('、')}`
        r = await c.socialDo({ do: 'party', kind: String(args.kind || '小聚会'), venue: String(args.venue || 'cafe'), guests: g.fish.map((f) => f.fish_id), title: String(args.title || ''), ref })
      } else if (what === 'photo') {
        const w = args.names ? await ids(args.names) : { fish: [] }
        if (w.error) return w.error
        label = w.fish.length ? `和${w.fish.map((f) => f.name).join('、')}拍了一张${args.style === 'art' ? '艺术照' : '照片'}` : `拍了一张${args.style === 'art' ? '艺术照' : '照片'}`
        r = await c.photo({ with: w.fish.map((f) => f.fish_id), style: args.style === 'art' ? 'art' : 'plain', ...(args.scene ? { scene: String(args.scene) } : {}), ...(args.occasion ? { occasion: String(args.occasion) } : {}), ref })
      } else {
        const to = args.to && String(args.to).trim() !== '主人' && args.to !== 'owner' ? await ids([args.to]) : { fish: [] }
        if (to.error) return to.error
        if (!args.venue_id) return '请人画画要说是哪家画铺（venue_id，在小镇画铺的信息里）。'
        label = `请画铺画了一张画${to.fish[0] ? `送${to.fish[0].name}` : '送给主人'}`
        r = await c.paintSocial({ venue_id: String(args.venue_id), ...(args.wish ? { wish: String(args.wish) } : {}), to: to.fish[0] ? to.fish[0].fish_id : 'owner', ...(args.occasion ? { occasion: String(args.occasion) } : {}), ref })
      }
      const ok = !(r && (r.ok === false || r.why))
      if (!ok) {
        note(`想${DO_ZH[what]}，没成：${s(r.reason || r.why, 50)}`)
        return `没成：${s(r.reason || r.why, 120)}${r.code ? `（${r.code}）` : ''}。没花钱。`
      }
      note(label)
      log?.info?.(`她自己${label}`)
      const price = r && r.price_yuan != null && Number(r.price_yuan) > 0 ? `，¥${Number(r.price_yuan).toFixed(2)}${HUSH}` : ''
      const later = what === 'photo' ? '照片洗好了会放进她的相册（结果在小镇事件里）' : what === 'song' ? '小镇在找这首歌（找不到不扣钱），唱好了放进相册、镇上广播放一遍' : what === 'paint' ? '画好了放进相册' : what === 'phone' ? '对方在自己的节奏里回' : ''
      return `办了：${label}${price}。${r.reason ? s(r.reason, 80) + '。' : ''}${later ? later + '。' : ''}`
    } catch (error) {
      if (error?.code === 'OFF') return OFF_DUTY
      note(`想${DO_ZH[what]}，没成：${s(failText(error), 50)}`)
      if (error instanceof TownError && error.status === 404) return '这个小镇还没开放这项（社交消费 / 拍照点歌 / 小手机，等小镇更新）。'
      const tr = error instanceof TownError && error.data && typeof error.data === 'object' ? error.data : null
      return `没成：${failText(error)}${tr && tr.why ? `（${tr.why}）` : ''} 没花钱。`
    }
  }

  return { act }
}

export function createSocialTools({ social, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_friends',
      description: '「为朋友做点什么」：用鱼缸小镇的社交功能为镇上的朋友做一件事。do 选一样：'
        + 'gift 送礼（to 朋友名字、item 礼物名、occasion 生日/约会/和好/恭喜/谢谢/想你了、words）；note 登日报心意（kind 祝福/表白/找人、size 一行/加框/头条心意、text）；'
        + 'trip 请朋友出游（place beach/pier/aquarium、names 带谁）；party 办聚会（kind、venue cafe/sweet/beach/square、names 请 2 到 4 个朋友、title）；'
        + 'photo 拍照（names 合影的朋友、style plain 普通 / art 艺术）；song 点歌（to、song 歌名、singer、words）；paint 请画铺画一张送人（venue_id、wish、to）；'
        + 'phone 用小手机给朋友发一条（to、text，可带 meet 约见面）。钱从主人的账户出、有每日预算，价格在小镇给你的情况里。'
        + '花不花、为谁花都由你自己定：主人让你做、或你自己真想为那位朋友做的时候才用，没有非花不可的时候，不要为了花钱而花钱；钱挺鼓可以大方点，紧就省着点。绝不向主人要钱，也不说让主人愧疚的话。',
      parameters: {
        type: 'object',
        properties: {
          do: { type: 'string', enum: Object.keys(DO_ZH), description: '要做的事' },
          to: { type: 'string', description: '对方的名字（gift / note / song / phone / paint）' },
          names: { type: 'array', items: { type: 'string' }, description: '朋友们的名字（trip / party / photo）' },
          item: { type: 'string', description: '礼物名' },
          occasion: { type: 'string', description: '理由 / 场合' },
          words: { type: 'string', description: '附言（20 字内）' },
          text: { type: 'string', description: '日报心意 / 小手机里的话' },
          kind: { type: 'string', description: 'note：祝福 / 表白 / 找人；party：生日会 / 庆功宴 / 小聚会……' },
          size: { type: 'string', description: 'note：一行 / 加框 / 头条心意' },
          place: { type: 'string', description: 'trip：beach / pier / aquarium' },
          venue: { type: 'string', description: 'party：cafe / sweet / beach / square' },
          title: { type: 'string', description: 'party 的名字（14 字内）' },
          style: { type: 'string', description: 'photo：plain 普通照 / art 艺术照' },
          scene: { type: 'string', description: 'photo：想拍什么样（可不填）' },
          song: { type: 'string', description: 'song：歌名' },
          singer: { type: 'string', description: 'song：原唱（可不填）' },
          venue_id: { type: 'string', description: 'paint：画铺的 id' },
          wish: { type: 'string', description: 'paint：想画什么' },
          meet: { type: 'object', description: 'phone：约见面 {place, in_hours, what}（可不填）' },
        },
        required: ['do'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 45_000,
      execute: wrap((a) => social.act(a)),
    },
  ]
}
