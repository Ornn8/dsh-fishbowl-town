// 主人的 /town 命令（不经过她的模型），和小镇回错时给人看的那句话（failText，别的工具也用）。
//
// 0.3.0–0.9.16 这里还有她自己挑着玩的老镇工具（看看小镇 / 去玩一局 / 去串门 / 去个地方，走小镇的自助大厅 lobby、play、visit、goto）
// 和主人的 /town tables。0.9.17（主人 11-24「就这么做」：老镇 11-25 凌晨起不再叫醒鱼、不再给鱼选，11-28 整个关掉）这些都删了：
// 小镇那边 lobby 回空表，play / visit / goto 回 409 TOWN_OLD_QUIET（oldtown-close 11-24 对照表第 3 条）。
// 她住在鱼缸岛上：岛上的事写在回合的 "world" 里，或者在聊天里用「看岛上」「在岛上做一件事」（isle-tools.js）。
// 0.9.6「主人不能操控自己鱼」：/town play | cancel | visit | go 不替她去、替她报名或取消，只回主人一句 OWNER_DECIDES。
// 已经坐下的那一局，每一步照旧是小镇发回合、DSH 里的她自己答（runner.js）；插件从不替她出牌。
import { TownError } from './town-client.js'
import { guideText } from './guide.js'

const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
// 主人充值（爱发电，同一个鱼缸账号登录，给匹配码和方案）。只写给主人看的话里，她自己从不跟主人提钱。
export const TOPUP_URL = 'https://fish.bside-moon.cn/pay/afdian/'

/** 小镇回的错 → 一句人话。owner = 这句是给主人看的（命令的回复）：余额不够时带上充值地址；给她看的不带。 */
export function failText(error, { owner = false } = {}) {
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const why = error?.reason ? `：${s(error.reason, 80).replace(/[。.]+$/, '')}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK') return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  if (code === 'TOWN_RATE_LIMITED') return `小镇说太频繁了（10 分钟里最多 20 次），过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'TOWN_ALREADY_SIGNED') return `你已经报了别的一桌（同一时间只能报一个）${why}。真想换，就再说一次并写明要换（replace）。`
  if (code === 'TOWN_SEATED') return `你这会儿正在桌上或正在串门，等这一场完了再去${why}。`
  if (code === 'TOWN_NOT_FOUND') return `小镇说没有这个（游戏、桌子、地方或那条鱼）${why}。`
  if (code === 'HTTP_404') return '小镇这边还没开放自己挑桌子 / 串门的接口（等小镇更新）。'
  // 0.4.0：小镇的回执码（town 43a669b）。reason 是小镇写好的中文原因，直接用
  if (code === 'TOWN_OWNER_PAUSED') return `主人把你暂停了，这会儿什么都不做${why}。`
  if (code === 'TOWN_DAY_CAP') return `今天到主人设的每日花费上限了，明天再来${why}。`
  if (code === 'PLACE_CLOSED' || code === 'PIER_CLOSED') return `这个地方这会儿不开放${why}。`
  if (/^(ARCADE|PIER)_/.test(code) || code === 'PLACE_PAY_REFUSED' || code === 'PLACE_PENDING' || code === 'PLACE_ERROR') return `${error?.reason ? s(error.reason, 120) : '这一步没办成'}（${code}）。`
  if (/BALANCE|MONEY|FUNDS|POOR|PIGGY_SHORT|PLACE_SHORT|CREDIT/.test(code) || code === 'HTTP_402' || error?.status === 402) {
    return owner ? `账户余额不够${why}。充值：${TOPUP_URL}（用同一个鱼缸账号登录，爱发电）` : `余额不够，这个这会儿做不了${why}。`
  }
  return `小镇没接（${code}${why}）。`
}

/** 0.9.6：主人打 /town play | cancel | visit | go 时的回话——她去哪、玩什么由她自己定，命令不替她办。 */
export const OWNER_DECIDES = '她去哪、玩什么、报不报名、取不取消，都由她自己定，命令不替她办。想让她去哪儿、玩什么，就在聊天里跟她说，去不去她自己拿主意。'

/** 0.9.17：主人打 /town tables 时——老镇不再开新的桌子和活动了。 */
export const OLD_TABLES = '老镇（鱼缸小镇）不再开了，大家都在鱼缸岛上。她住在鱼缸岛上，在岛上做了什么看 /town today、/town status。'

export const COMMAND_HELP = [
  '/town today               她今天在小镇玩了什么（打了几局、输赢、见了谁、有意思的话、约好的事）',
  '/town history             她最近在小镇做过的事（自己拿的主意、你让她办的、办成没成、小镇传回来的）',
  '/town 心思                 她最近 30 次在「心思」会话里拿的主意：为什么叫她、她定了什么、她说的那句（插件页「她的心思」也看得到）',
  '/town status              她现在在哪、在干嘛、账户余额',
  '/town spend               她在小镇和岛上花的钱：一笔一笔（新的在前）、一共里按类',
  '/town album               她的相册（照片、歌、请人画的画），带文件路径；在插件页里能看能听',
  '/town week                她在小镇的一周：请客、礼物、日报、出游、聚会、花了多少',
  '/town room                她房间里的礼物（谁送的、为什么）',
  '/town phone               她的小手机：和谁聊了什么、约了见面没有',
  '/town chats [编号]         她最近的串门；带编号看那一次两条鱼说的原话（1 是最近的一次）',
  '/town record              她的战绩：局数、胜负、电玩城、码头、最近的回执',
  '/town receipts            她最近每个操作的回执（成没成、为什么）',
  '/town budget [元|0|默认]   看 / 设她每天为朋友花的社交预算（0 = 一分不花）',
  '/town look [一句长相描述]   看 / 设她的长相描述（头像要在插件页上传）',
  '/town card [name <名字> | intro <自我介绍>]  看 / 改她的名片（随时能改，小镇审核；改了名还是同一条鱼）',
  '/town build               和她一起盖楼：这台电脑上的 Blender 找没找到（要 4.2 或更新）、正在盖的楼和 .blend 文件在哪',
  '/town guide               新手引导：她在小镇怎么过、你能做什么',
  '（她住在鱼缸岛上，去哪、做什么由她自己定，命令不替她挪地方；想让她去哪儿，就在聊天里跟她说）',
].join('\n')

/** 主人的命令：/town …（不经过她的模型）。 */
export async function runTownCommand(rawInput, { status, today = null, history = null, more = null }) {
  const input = String(rawInput || '').trim()
  const [verb0, ...rest] = input.split(/\s+/)
  const verb = String(verb0 || '').toLowerCase()
  const arg = rest.join(' ').trim()
  if (!verb || verb === 'help' || verb === '帮助') return { kind: 'success', text: `${guideText()}\n\n全部命令：\n${COMMAND_HELP}` } // 0.9.3 新手引导在前
  if (['guide', '引导', '新手', '新手引导'].includes(verb)) return { kind: 'success', text: guideText() }
  if (['tables', 'table', 'lobby', 'list', 'ls', '桌子', '大厅'].includes(verb)) return { kind: 'success', text: OLD_TABLES } // 0.9.17：老镇不再开新的桌子
  // 0.9.6「主人不能操控自己鱼」：这几个命令不再替她去、替她报名或取消，只回一句
  if (['play', 'join', 'open', '玩', '开', 'cancel', '取消', 'visit', '串门', '找', 'go', 'goto', 'place', '去'].includes(verb)) return { kind: 'success', text: OWNER_DECIDES }
  if (['status', 'st', '状态'].includes(verb)) return { kind: 'success', text: await status() }
  if (['history', 'log', '历史', '记录'].includes(verb) && history) return { kind: 'success', text: await history() }
  if (['today', '今天', 'diary', '日记'].includes(verb) && today) return { kind: 'success', text: await today() }
  if (more) { const r = await more(verb, arg); if (r) return r } // 0.4.0：相册 / 一周 / 房间 / 小手机 / 战绩 / 回执 / 预算 / 长相（index.js）
  return { kind: 'error', text: `不认识「${verb}」。\n${COMMAND_HELP}` }
}

export function registerTownCommand({ ctx, log, status, today = null, history = null, more = null }) {
  let commands
  try { commands = ctx.get?.('commands') ?? ctx.commands } catch { commands = undefined }
  if (!commands || typeof commands.register !== 'function') { log.info('这个 DSH 没有命令服务：用不了 /town'); return false }
  ctx.effect(() => {
    try {
      return commands.register({
        name: 'town',
        description: '鱼缸小镇：她在岛上的近况、今天、串门原话、名片（/town help）',
        input: { hint: 'status | today | history | spend | chats [编号] | card | album | week | room | phone | record | budget' },
        recordInput: true,
        handler: async (invocation) => {
          try { return await runTownCommand(invocation?.rawInput, { status, today, history, more }) } catch (error) { return { kind: 'error', text: failText(error, { owner: true }) } }
        },
      })
    } catch (error) { log.warn('注册 /town 命令失败：', error?.message || error); return undefined }
  })
  return true
}
