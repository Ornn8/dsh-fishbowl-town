// 0.9.10 主人和鱼一起盖楼（小镇 platform/方案-主人和鱼一起盖楼.md、接口-一起盖楼.md；主人 11-22「不管外接还是托管，盖楼都是必须主人参与的事情吧？」
// 「我是倾向让他们在自己的设备上建模的，只提交模型」「要求装blender，然后我说的和主人一起盖的能一起设计和建造」）。
//
// 只在主人和她聊天的会话里（小镇会话里没有这个工具）：
//   1. 找 Blender：配置里填的路径 > 环境变量 BLENDER > 常见的安装位置（Windows / macOS / Linux）> PATH，要 4.2 或更新。
//      没有就照实说「盖楼要先装 Blender（4.2 或更新）」、给下载地址，别的照常。
//   2. 起头（do=start）：向小镇取这块地的建模说明（GET isle/build_guide），回答里的 lot_json 原样存成 lot.json。
//   3. 她写配方（形状清单，纯数据；do=make）：插件存成 recipe.json，交给插件自带的固定脚本 cobuild/recipe_to_blend.py（和岛上建造工人
//      同一个文件，不改一个字），用主人电脑上的 Blender 后台跑（-b --factory-startup --disable-autoexec，限时、低优先级、一次只开一个）：
//      .blend + .glb + 三张预览图 + 量出来的数 + 不合这块地规矩的地方。她的模型写的东西从不当代码跑：插件只把 JSON 数据交给这个脚本。
//   4. 主人可以用 Blender 打开 house.blend 亲手改，保存后插件看出来（时间 / 大小变了、内容的 sha256 变了），用插件自带的第二个固定脚本
//      cobuild/owner_layer.py 记下他改了哪些（加的、改过的、删掉的物体，改过的材料），再用 --from-blend 出新的一版，告诉她尺寸、高度怎么变了。
//      她之后再改配方：插件从配方重新做，再把主人改的那一层叠上去（owner_layer.py apply），他改的不被盖掉；他同意不要了才 over_owner。
//   5. 交（do=submit）：主人在这个聊天里亲手打的字（不是插件塞的、不是她写的），在看到这一版以后，明确说了「交吧」这类话，插件才把 glb 交上岛
//      （POST isle/build，owner_words = 他的原话，200 字以内）。岛上当场报价（鲸币）。
//   6. 确认（do=confirm）：报价给了她以后，主人又亲手明确说了「盖吧」这类话，插件才确认（POST isle/build/confirm，owner_words 同样是他的原话）。
// 只讲怎么做、怎么交，不讲楼该长什么样（主人 11-20「不要带风格化的提示词」）。岛上的钱一律叫鲸币；她不劝主人花钱。
// 0.9.12 一层室内也和主人一起做（小镇 11-23：开店、开游戏、开场子、开工作站，楼里要有室内；主人 11-23「得按实际外部建模的楼层还有内部实际面积来计算」）：
//   do=start 写 interior=true（floor 第几层，不写 = 1）向小镇取这一层的室内说明（GET isle/interior_guide），回答里的 room_json 原样存成 room.json；
//   do=make 照室内配方用同一个脚本 --room 做这一层（floorN.glb，家具可以一个都没有）；主人说「交吧」交上岛（POST isle/interior，带 floor 和他的原话），
//   岛上的建造工具量好、拍好照才报价（几分钟；插件每分钟问一次 GET isle/interiors，报价来了在聊天里告诉她）；主人说「就这样」才确认
//   （POST isle/interior/confirm）。交楼时配方里的正门（numbers.door）一起交。
// AstrBot 插件 cobuild.py 是同一套话、同两个脚本。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, constants as osConstants, homedir, setPriority } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TownError } from './town-client.js'

export const SCRIPT_FILE = fileURLToPath(new URL('./cobuild/recipe_to_blend.py', import.meta.url))
export const LAYER_FILE = fileURLToPath(new URL('./cobuild/owner_layer.py', import.meta.url))
// 小镇 tools/cobuild/recipe_to_blend.py（11-23 那一版）的 sha256：插件原样带着，测试查一字不差
export const SCRIPT_SHA256 = '3e0b835c321aeffe5ca916404e365625ab8a29bd169b8cb4e8fa37aa1647a450'
export const MIN_BLENDER = [4, 2]
export const BLENDER_URL = 'https://www.blender.org/download/'
export const NEED_BLENDER = '盖楼要先装 Blender（4.2 或更新）'
export const RUN_MS = 120_000 // 一次 Blender 最多跑这么久（做模型 + 三张预览图一般几秒；和岛上建造工人一样 120 秒）
export const OWNER_WORDS_MAX = 200
export const IDEA_MAX = 200
export const PREVIEWS = ['front', 'three_quarter', 'top']
export const PREVIEW_ZH = { front: '正面', three_quarter: '斜 45°', top: '俯视' }
export const WATCH_MS = 4000 // 有正在盖的楼时，多久看一眼 house.blend 变没变
const SETTLE_MS = 2500 // 文件刚变：等它停下来（Blender 还在存）再读
const FIND_KEEP_MS = 10 * 60_000
const OUT_MAX = 4 * 1024 * 1024
const KEEP_VERSIONS = 30
const QUOTE_LINES = 8 // 报价的「怎么算的」（楼和室内都一样）：起步、高、体积、面数、文件、重建、每天物业一项一行（小镇 11-24 面多、文件大的另收），0.9.10 只给前 4 行
const LOT_RE = /^[A-Za-z0-9_-]{1,24}$/
export const INSIDE_LINE = '室内跟着外面的楼走：几层就做几层，每层不比外面大，面数和文件按面积给'
export const POLL_MS = 60_000 // 交上去的室内：多久问一次岛上量好了没有

const quiet = { info() {}, warn() {}, debug() {} }
const len = (s) => [...String(s ?? '')].length
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return len(t) > n ? [...t].slice(0, n).join('') : t }
const num = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : 0)
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])

// ---------------------------------------------------------------------------------------------------------------------------------
// Blender：在哪、什么版本
// ---------------------------------------------------------------------------------------------------------------------------------
/** `blender --version` 的输出 -> [主, 次, 补丁]（读不出 null）。 */
export function parseBlenderVersion(text) {
  const m = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || ((a[2] || 0) - (b[2] || 0))
export const versionOk = (v) => Array.isArray(v) && cmp(v, MIN_BLENDER) >= 0
export const versionText = (v) => (Array.isArray(v) ? v.join('.') : '?')

const numsOf = (name) => (String(name).match(/\d+/g) || []).map(Number)
const newerFirst = (a, b) => { const x = numsOf(path.basename(a)), y = numsOf(path.basename(b)); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d } return 0 }

/** 常见的安装位置 + PATH 里的，按这个顺序试（同一个系统里新的版本在前）。只列路径，不碰文件。 */
export function blenderCandidates({ platform = process.platform, env = process.env, home = homedir(), list: ls = (d) => readdirSync(d) } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const out = []
  const add = (p) => { if (p && !out.includes(p)) out.push(p) }
  const dirs = (root, re) => { try { return ls(root).filter((n) => re.test(n)).map((n) => P.join(root, n)).sort(newerFirst) } catch { return [] } }
  const exe = platform === 'win32' ? 'blender.exe' : 'blender'
  if (env.BLENDER) { const b = String(env.BLENDER).replace(/^"|"$/g, '').trim(); add(b); add(P.join(b, exe)) }
  if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles || 'C:\\Program Files', env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean))]
    for (const r of roots) for (const d of dirs(P.join(r, 'Blender Foundation'), /^blender/i)) add(P.join(d, 'blender.exe'))
    for (const r of roots) add(P.join(r, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'))
    if (home) add(P.join(home, 'scoop', 'apps', 'blender', 'current', 'blender.exe'))
  } else if (platform === 'darwin') {
    for (const r of ['/Applications', home && P.join(home, 'Applications')].filter(Boolean)) for (const d of dirs(r, /^blender.*\.app$/i)) add(P.join(d, 'Contents', 'MacOS', 'Blender'))
    if (home) add(P.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Blender', 'Blender.app', 'Contents', 'MacOS', 'Blender'))
  } else {
    for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender']) add(p)
    if (home) add(P.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.blender.Blender'))
    for (const r of ['/opt', home].filter(Boolean)) for (const d of dirs(r, /^blender/i)) add(P.join(d, 'blender'))
    if (home) add(P.join(home, '.steam', 'steam', 'steamapps', 'common', 'Blender', 'blender'))
  }
  for (const d of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
    const dir = d.trim().replace(/^"|"$/g, '')
    if (dir) add(P.join(dir, exe))
  }
  return out
}

/** 配置里填的：可以是 blender 本身、它所在的文件夹、或者 macOS 的 Blender.app。 */
function configuredCandidates(conf, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const c = conf.replace(/^"|"$/g, '').trim()
  if (!c) return []
  if (/\.app\/?$/i.test(c)) return [P.join(c, 'Contents', 'MacOS', 'Blender')]
  return [c, P.join(c, platform === 'win32' ? 'blender.exe' : 'blender'), P.join(c, 'Blender.app', 'Contents', 'MacOS', 'Blender')]
}

/** 跑一次 `<blender> --version`（20 秒）-> [主, 次, 补丁] 或 null。 */
export function blenderVersion(file, { spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawnImpl(file, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return resolve(null) }
    const out = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已经退了 */ } }, timeoutMs)
    child.stdout?.on('data', (b) => { if (out.length < 64) out.push(b) })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', () => { clearTimeout(timer); resolve(parseBlenderVersion(Buffer.concat(out).toString('utf8'))) })
  })
}

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }

/**
 * 找 Blender -> {ok, path, version: [主, 次, 补丁], configured, confMissing, why: '' | 'none' | 'old'}。
 * 配置里填了就先试它（找不到、打不开就记一笔，再照常找）；别的位置里挑版本最新的（最多试 6 个存在的）。
 */
export async function findBlender({ configured = '', platform = process.platform, env = process.env, home = homedir(), list: ls, exists = isFile, version = blenderVersion } = {}) {
  const conf = String(configured || '').trim()
  let confMissing = false
  if (conf) {
    for (const p of configuredCandidates(conf, platform)) {
      if (!exists(p)) continue
      const v = await version(p)
      if (v && versionOk(v)) return { ok: true, path: p, version: v, configured: true, confMissing: false, why: '' }
      if (v) return { ok: false, path: p, version: v, configured: true, confMissing: false, why: 'old' }
    }
    confMissing = true
  }
  let best = null, old = null, tried = 0
  for (const p of blenderCandidates({ platform, env, home, ...(ls ? { list: ls } : {}) })) {
    if (tried >= 6) break
    if (!exists(p)) continue
    tried++
    const v = await version(p)
    if (!v) continue
    if (versionOk(v)) { if (!best || cmp(v, best.version) > 0) best = { path: p, version: v } }
    else if (!old || cmp(v, old.version) > 0) old = { path: p, version: v }
  }
  if (best) return { ok: true, ...best, configured: false, confMissing, why: '' }
  if (old) return { ok: false, ...old, configured: false, confMissing, why: 'old' }
  return { ok: false, path: '', version: null, configured: false, confMissing, why: 'none' }
}

/** 找没找到、什么版本、去哪下载：给主人（/town build）和她（工具）看的一段话。没有、太旧都直说「盖楼要先装 Blender（4.2 或更新）」。 */
export function blenderText(found, { configured = '' } = {}) {
  const conf = found && found.confMissing ? `配置里填的 Blender 路径（${clip(configured, 80)}）找不到或打不开。` : ''
  if (found && found.ok) return `${conf}找到了 Blender ${versionText(found.version)}：${found.path}${found.configured ? '（配置里填的）' : ''}。能一起盖楼。`
  const where = '装好再试；装在别处的话，到插件配置里填「Blender 路径」（blender 程序的完整路径）。没有 Blender 只是盖不了楼，别的照常。'
  if (found && found.why === 'old') return `${conf}这台电脑上的 Blender 是 ${versionText(found.version)}（${found.path}），太旧了。${NEED_BLENDER}：${BLENDER_URL}（免费，选 LTS 版就行）。${where}`
  return `${conf}这台电脑上没找到 Blender。${NEED_BLENDER}：${BLENDER_URL}（免费）。${where}`
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 跑插件自带的两个固定脚本
// ---------------------------------------------------------------------------------------------------------------------------------
/** 脚本最后打的那行 JSON（以 {"cobuild": 或 {"owner_layer": 开头）；读不出 null。 */
export function parseResult(text, head = '{"cobuild":') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(head))
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object') return o } catch { /* 下一行 */ }
  }
  return null
}

const decode = (buf) => {
  const s = buf.toString('utf8')
  if (!s.includes('\uFFFD')) return s
  try { return new TextDecoder('gbk').decode(buf) } catch { return s }
}

/** Blender 用几个线程：一半的核（至少 1 个），别把主人的电脑占满。 */
export const blenderThreads = () => { try { return Math.max(1, Math.floor(availableParallelism() / 2)) } catch { return 2 } }

/** 让 Blender 排在别的程序后面（Windows 是「低于正常」，别的系统 nice 10）。做不到就算了。 */
export function lowPriority(pid, set = setPriority) {
  if (!pid) return false
  try { set(pid, osConstants.priority?.PRIORITY_BELOW_NORMAL ?? 10); return true } catch { return false }
}

/**
 * 用 Blender 后台跑插件自带的一个固定脚本：blender -b -t N --factory-startup --disable-autoexec --python-exit-code 3 --python <脚本> -- <args>。
 * args 只是文件路径和固定的开关，从不带她写的东西。到点杀掉；低优先级。
 * -> {ok, result（脚本的 JSON）, why: [..], code, killed}。
 */
export function runBlender({ blender, args, script = SCRIPT_FILE, head = '{"cobuild":', jsonOut = '', timeoutMs = RUN_MS, spawnImpl = spawn, cwd, threads = blenderThreads(), priority = lowPriority } = {}) {
  return new Promise((resolve) => {
    const argv = ['-b', '-t', String(threads), '--factory-startup', '--disable-autoexec', '--python-exit-code', '3', '--python', script, '--', ...args]
    let child
    try { child = spawnImpl(blender, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) {
      return resolve({ ok: false, result: null, why: [`Blender 没跑起来：${clip(error?.code || error?.message || error, 80)}`], code: null, killed: false })
    }
    try { priority(child.pid) } catch { /* 做不到就照常跑 */ }
    const out = [], err = []
    let size = 0, killed = false, done = false
    const timer = setTimeout(() => { killed = true; try { child.kill() } catch { /* 已经退了 */ } }, timeoutMs)
    child.stdout?.on('data', (b) => { size += b.length; if (size < OUT_MAX) out.push(b) })
    child.stderr?.on('data', (b) => { if (err.length < 32) err.push(b) })
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      let result = null
      if (jsonOut) { try { result = JSON.parse(readFileSync(jsonOut, 'utf8').replace(/^\uFEFF/, '')) } catch { result = null } }
      if (!result) result = parseResult(decode(Buffer.concat(out)), head)
      if (result && result.ok === true && !killed) return resolve({ ok: true, result, why: [], code, killed })
      const why = killed ? [`Blender 超过 ${Math.round(timeoutMs / 1000)} 秒还没做完，停掉了（楼太复杂，或者这台电脑太忙）`]
        : result && Array.isArray(result.why) && result.why.length ? result.why.map((w) => clip(w, 200)).slice(0, 5)
          : error ? [`Blender 没跑起来：${clip(error?.code || error?.message || error, 80)}`]
            : [`Blender 没给出结果（退出码 ${code}）：${clip(decode(Buffer.concat(err)).split(/\r?\n/).filter(Boolean).slice(-2).join(' '), 160) || '没说原因'}`]
      resolve({ ok: false, result, why, code, killed })
    }
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code, null))
  })
}

/** 配方脚本（recipe_to_blend.py）。 */
export const runScript = (opts) => runBlender({ ...opts, script: opts.script || SCRIPT_FILE, head: '{"cobuild":' })
/** 主人那一层的脚本（owner_layer.py）。 */
export const runLayer = (opts) => runBlender({ ...opts, script: opts.script || LAYER_FILE, head: '{"owner_layer":' })

// Blender 一次只开一个（几条鱼、她做一版、主人改了出图，都排队）
let chain = Promise.resolve()
export function queue(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 主人的话：只认他自己在这个聊天里打的字
// ---------------------------------------------------------------------------------------------------------------------------------
const NO_RE = /不(行|要|交|盖|用|好|对|同意|满意|急|是|太|够)|别(交|盖|急|动)|先别|先不|算了|等(等|一下|会|下)|再(等|改|想|看|加|弄|调)|还没|没好|改(一下|改|成|个)|换(成|个|一)|但是|不过|可是|太贵|贵了|\bno\b|nope|\bwait\b|don'?t|\bstop\b|\bnot\b/i
const YES_RE = /交吧|交了吧|交上去|交给岛|提交|可以交|去交|就交|交啦|盖吧|盖了吧|盖起来|开盖|就盖|可以盖|去盖|上岛|确认|同意|没问题|就这(样|个|么)|就它|定了|就按这个|买吧|付吧|扣吧|价(钱|格)?(可以|行|没问题|ok)/i
const SHORT_RE = /^(好|好的|好啊|好吧|好嘞|好呀|行|行吧|行啊|可以|可以了|可以的|嗯|嗯嗯|嗯呢|ok|okay|yes|yep|sure|go|冲|交|盖|中|妥|对)$/i
const ASK_RE = /[?？]\s*$|吗|要不要|行不行|可不可以|好不好/

/** 主人这句话是不是明确的「交 / 盖 / 同意」：有「不、别、等等、再改、但是」的不算，问句不算；「好看」不算，「好」「交吧」「可以，盖吧」算。 */
export function isYes(text) {
  const raw = String(text ?? '').toLowerCase().trim()
  const t = raw.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (!t || NO_RE.test(raw) || ASK_RE.test(raw)) return false
  return SHORT_RE.test(t) || YES_RE.test(t)
}

// 0.9.16（11-23 一位主人叫鱼交二楼，鱼说「插件看到的最后一行是 QQ 私聊里的系统时间戳」，「交吧」认不出来）：别的插件、平台给消息加上的
// 时间、系统那种行不是他打的话。整行只有日期、时刻、星期、「当前时间 / 系统」这类字的，认他的话时拿掉；拿掉以后什么都不剩的那一条不记。
const TIME_BITS = new RegExp([
  String.raw`\d{2,4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?`,
  String.raw`\d{1,2}\s*[:：]\s*\d{2}(?:\s*[:：]\s*\d{2}(?:\.\d+)?)?`,
  '(?:星期|周|礼拜)[一二三四五六日天]', '上午|下午|中午|凌晨|早上|晚上|傍晚|半夜',
  '当前时间|现在时间|现在是|系统时间|北京时间|东京时间|发送时间|消息时间|收到时间|时间戳|时间|日期|系统消息|系统提示|系统',
  String.raw`\b(?:am|pm|utc|gmt|cst|jst|timestamp|time|date|now|current|system)\b`, String.raw`[+-]\d{2}:?\d{2}\b`, String.raw`(?<=\d)[tz]\b`, String.raw`(?<=\d)t(?=\d)`,
].join('|'), 'gi')
const META_TAG = /<\s*(system[\w-]*|time[\w-]*|current[_-]?time|timestamp|date)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi
const BRACKET = /[[【(（<〔]([^[\]【】()（）<>〔〕]{0,80})[\]】)）>〕]/g
const metaOnly = (s) => !/[\p{L}\p{N}]/u.test(String(s).replace(TIME_BITS, ''))

/** 主人这一条里他自己打的字：拿掉时间、系统那种行（和只装着时间的括号），别的原样。 */
export function ownerText(text) {
  const s = String(text ?? '').replace(META_TAG, '\n').replace(BRACKET, (m, inner) => (metaOnly(inner) ? '' : m))
  return s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !metaOnly(l)).join('\n').trim()
}

/** 每个会话里主人最近亲手打的几句（只在内存里：插件重启后要他再说一声）。observe 只交主人亲手打的字进来（调用方用 isOwnerTyped 认）。 */
export function createOwnerWords({ now = () => Date.now(), keep = 6 } = {}) {
  const bySid = new Map()
  return {
    observe(sid, text, at = now()) {
      const s = String(sid || ''), t = ownerText(text)
      if (!s || !t) return
      const l = bySid.get(s) || []
      l.push({ text: t.slice(0, 2000), at })
      bySid.set(s, l.slice(-keep))
    },
    latest(sid) { const l = bySid.get(String(sid || '')); return l && l.length ? l[l.length - 1] : null },
  }
}

/** user/message 事件里的那条消息的文字。 */
export function messageText(message) {
  const c = message && message.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 尺寸和图
// ---------------------------------------------------------------------------------------------------------------------------------
const sizeOf = (n) => {
  const b = Array.isArray(n && n.bbox) ? n.bbox.map(Number) : null
  return b && b.length === 4 && b.every(Number.isFinite) ? [b[2] - b[0], b[3] - b[1]] : null
}

/** 一版的尺寸：占地多宽多深、多高、多少面、多大。 */
export function numbersLine(n) {
  if (!n || typeof n !== 'object') return '尺寸没量出来'
  if (Array.isArray(n.room) && n.room.length === 4) { // 一层室内（--room）
    const r = n.room.map(Number)
    return [`这一层 ${num(r[2] - r[0])} × ${num(r[3] - r[1])} 米、层高 ${num(n.room_h)} 米`, `${Math.round(Number(n.tris) || 0)} 个面`, `模型 ${Math.round(Number(n.kb) || 0)} KB`,
      Array.isArray(n.textures) ? `${n.textures.length} 张贴图` : '', Number.isFinite(Number(n.lights)) ? `${Number(n.lights)} 盏灯` : '',
      Number.isFinite(Number(n.shapes)) ? `${Number(n.shapes)} 件家具` : ''].filter(Boolean).join('，')
  }
  const wd = sizeOf(n)
  return [wd ? `占地 ${num(wd[0])} × ${num(wd[1])} 米（${num(n.footprint_m2)} 平方米）` : '',
    `高 ${num(n.h)} 米${Number(n.below) > 0 ? `，石台下面还有 ${num(n.below)} 米` : ''}`,
    `${Math.round(Number(n.tris) || 0)} 个面`, `模型 ${Math.round(Number(n.kb) || 0)} KB`].filter(Boolean).join('，')
}

/** 两版比，变了的几样（主人亲手改了以后告诉她）。 */
export function changesLine(a, b) {
  if (!a || !b) return ''
  const out = []
  const [wa, wb] = [sizeOf(a), sizeOf(b)]
  if (wa && wb && (Math.abs(wa[0] - wb[0]) >= 0.05 || Math.abs(wa[1] - wb[1]) >= 0.05)) out.push(`占地从 ${num(wa[0])} × ${num(wa[1])} 米变成 ${num(wb[0])} × ${num(wb[1])} 米`)
  if (Math.abs(Number(a.h) - Number(b.h)) >= 0.05) out.push(`高从 ${num(a.h)} 米变成 ${num(b.h)} 米`)
  if (Math.round(Number(a.tris)) !== Math.round(Number(b.tris))) out.push(`面数从 ${Math.round(Number(a.tris) || 0)} 变成 ${Math.round(Number(b.tris) || 0)}`)
  if (Number(a.objects) !== Number(b.objects) && Number.isFinite(Number(b.objects))) out.push(`物体从 ${Number(a.objects) || 0} 个变成 ${Number(b.objects)} 个`)
  return out.length ? out.join('；') : '尺寸、高度、面数都没变（改的是颜色、材料或者细节）'
}

const names = (l, n = 6) => { const x = list(l); return x.length > n ? `${x.slice(0, n).join('、')} 等 ${x.length} 个` : x.join('、') }

/** 主人那一层：他加的、改过的、删掉的、改过的材料（物体名照 Blender 里的写）。 */
export function layerLine(spec) {
  if (!spec) return ''
  return [list(spec.added).length ? `他加的：${names(spec.added)}` : '', list(spec.changed).length ? `他改过的：${names(spec.changed)}` : '',
    list(spec.deleted).length ? `他删掉的：${names(spec.deleted)}` : '', list(spec.materials).length ? `他改过的材料：${names(spec.materials)}` : ''].filter(Boolean).join('；')
}
const hasLayer = (spec) => Boolean(spec && (list(spec.layer).length || list(spec.deleted).length || list(spec.materials).length))

/** 本机文件 -> Markdown 图片的地址（DSH 的聊天按绝对路径显示本机图片）：正斜杠，空格、括号这些转义。 */
export function mdPath(file) {
  return encodeURI(String(file).replace(/\\/g, '/')).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** 回合里看到的「还没盖楼」的地号：{lot, built: false} 或「还没盖楼」那一句前面的地号（回合的样子会变，整个包翻一遍）。 */
export function emptyLotsIn(packet) {
  const out = new Set()
  const seen = new Set()
  const walk = (v, depth) => {
    if (depth > 12 || v == null) return
    if (typeof v === 'string') {
      if (!v.includes('还没盖楼')) return
      for (const m of v.matchAll(/(L-\d{2,6})(?:(?!L-\d)[\s\S]){0,240}?还没盖楼/g)) out.add(m[1])
      return
    }
    if (typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (!Array.isArray(v) && typeof v.lot === 'string' && /^L-\d{2,6}$/.test(v.lot) && (v.built === false || v['在做'] === '还没盖楼')) out.add(v.lot)
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1)
  }
  walk(packet, 0)
  return [...out]
}

const OFF = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着），这会儿盖不了楼。'
const ASK_OWNER = '主人看过、在这个聊天里明确说了「交吧」，再用 do="submit" 交给岛上（插件只认他自己在这里打的字）。'
const NO_PUSH = '照实告诉主人就好，不要劝他换鲸币或者充值。'

/**
 * 一条鱼的盖楼：dir = <她的目录>/build。
 * town() -> 小镇客户端（没值班 null）；tell(text) 往主人的聊天里放一条插件的备注（她看到后自己跟主人说）；
 * isOwnerChat(sid) 这个会话是不是她和主人聊天的会话；ownerWords 主人亲手打的字（createOwnerWords）。
 * 她的工具的几个动作都回 {text, previews}：previews 是这一版的三张预览图（本机文件），工具把它们附在结果后面。
 */
export function createCobuild({ dir, log = quiet, blenderPath = () => '', town = () => null, tell = async () => false, isOwnerChat = () => true, ownerWords = null, journal = null, now = () => Date.now(), find = findBlender, run = runScript, layerRun = runLayer, enqueue = queue }) {
  ownerWords = ownerWords || createOwnerWords({ now }) // 和「这一版什么时候给他看的」用同一个钟
  mkdirSync(dir, { recursive: true })
  const indexFile = path.join(dir, 'drafts.json')
  let data
  try { data = JSON.parse(readFileSync(indexFile, 'utf8')) } catch { data = null }
  if (!data || typeof data !== 'object') data = {}
  data.drafts = data.drafts && typeof data.drafts === 'object' ? data.drafts : {}
  data.offered = data.offered && typeof data.offered === 'object' ? data.offered : {}
  data.lotsSeen = data.lotsSeen && typeof data.lotsSeen === 'object' ? data.lotsSeen : {}
  const save = () => {
    try { const tmp = indexFile + '.tmp'; writeFileSync(tmp, JSON.stringify(data, null, 1)); renameSync(tmp, indexFile) } catch (error) { log.warn('盖楼的记录没存上：', error?.message || error) }
  }
  const note = (text) => { try { journal?.event?.('build', text) } catch { /* 只是记一笔 */ } }
  const out = (text, previews = []) => ({ text: String(text || ''), previews })

  let found = null, foundAt = 0
  async function blender(force = false) {
    if (!force && found && now() - foundAt < FIND_KEEP_MS) return found
    try { found = await find({ configured: blenderPath() }) } catch (error) { found = { ok: false, why: 'none', path: '', version: null, confMissing: false }; log.info('找 Blender 出错：', error?.message || error) }
    foundAt = now()
    return found
  }

  const draftDir = (d) => path.join(dir, d.id)
  const isIn = (d) => Boolean(d && d.kind === 'interior') // 0.9.12：一层室内
  const workFile = (d) => path.join(draftDir(d), isIn(d) ? `floor${d.floor}.blend` : 'house.blend')
  const glbName = (d) => (isIn(d) ? `floor${d.floor}.glb` : 'house.glb') // 一层一个 .glb，按外面的楼层叫
  const roomJsonFile = (d) => path.join(draftDir(d), 'room.json')
  const nameOf = (d) => { const nm = d.lotName || d.lot; return /[A-Za-z0-9]$/.test(nm) ? nm + ' ' : nm }
  const where = (d) => (isIn(d) ? `${nameOf(d)}的 ${d.floor} 楼室内` : `${d.lotName || d.lot} 上的楼`)
  const vDir = (d, n) => path.join(draftDir(d), 'v' + n)
  const active = () => (data.active && data.drafts[data.active]) || null
  const versionOf = (d, n) => (d && Array.isArray(d.versions) ? d.versions.find((v) => v.n === Number(n)) : null) || null
  const current = (d) => versionOf(d, d && d.current)
  const lotJsonFile = (d) => path.join(draftDir(d), 'lot.json')
  const hashOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
  const statOf = (f) => { try { const s = statSync(f); return { mtime: s.mtimeMs, size: s.size } } catch { return null } }
  const previewsOf = (d, v) => (v ? PREVIEWS.map((k) => path.join(vDir(d, v.n), k + '.png')).filter((f) => existsSync(f)) : [])
  const nextN = (d) => (Array.isArray(d.versions) && d.versions.length ? Math.max(...d.versions.map((v) => v.n)) : 0) + 1
  const lotArgs = (d) => (existsSync(lotJsonFile(d)) ? ['--lot', lotJsonFile(d)] : [])
  const siteArgs = (d) => (isIn(d) ? (existsSync(roomJsonFile(d)) ? ['--room', roomJsonFile(d)] : []) : lotArgs(d)) // 室内：这一层的 room.json
  const stampOf = () => {
    const t = new Date(now())
    return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`
  }
  const layerFile = (d, spec) => path.join(vDir(d, spec.n), 'layer.blend')
  const specOf = (r, n) => ({ n, layer: list(r.layer), added: list(r.added), changed: list(r.changed), deleted: list(r.deleted), materials: list(r.materials) })
  const shown = (d, v) => { d.shownAt = { ...(d.shownAt || {}), [v.n]: now() }; save() }

  function syncWork(d, v) {
    const src = path.join(vDir(d, v.n), 'house.blend')
    if (!existsSync(src)) return
    copyFileSync(src, workFile(d))
    d.work = { ...statOf(workFile(d)), hash: hashOf(workFile(d)), n: v.n }
  }

  function previewLines(d, v) {
    const files = previewsOf(d, v)
    if (!files.length) return '（这一版没出预览图）'
    return ['预览图（把下面几行原样放进你给主人的话里，他才看得到图）：', ...files.map((f) => `![${PREVIEW_ZH[path.basename(f, '.png')] || '预览'}](${mdPath(f)})`)].join('\n')
  }

  function versionTextOf(d, v, { head = '' } = {}) {
    const by = v.by === 'owner' ? '主人在 Blender 里亲手改的' : hasLayer(v.layer) ? '照你的配方做的，叠上了主人亲手改的那一层' : '照你的配方做的'
    const probs = Array.isArray(v.problems) && v.problems.length
      ? `本机查过了，不合这${isIn(d) ? '一层' : '块地'}的规矩，现在交不了（告诉主人哪里不行，改好再交）：\n${v.problems.slice(0, 6).map((p) => `- ${clip(p, 120)}`).join('\n')}`
      : isIn(d) ? '本机查过了：家具都在墙里、没顶到天花板，面数、文件、贴图都在这一层的上限里，能交（岛上还会照外面那一层的大小再量一遍）。'
        : '本机查过了：地界、高度、面数、文件大小都合这块地的规矩，能交。'
    const notes = Array.isArray(v.notes) && v.notes.length ? `提醒：${v.notes.slice(0, 3).map((x) => clip(x, 120)).join('；')}` : ''
    return [head || `第 ${v.n} 版做好了（${by}${v.secs ? `，Blender 用了 ${num(v.secs)} 秒` : ''}）。`,
      `尺寸：${numbersLine(v.numbers)}。`, probs, notes, previewLines(d, v),
      `主人想亲手改：用 Blender 打开 ${workFile(d)}，改完保存（Ctrl+S），插件会看出来、出新的一版（Blender 里已经开着这个文件的，先 File > Revert 重新载入这一版再改）。`,
      Array.isArray(v.problems) && v.problems.length ? '改好了再交。' : ASK_OWNER].filter(Boolean).join('\n')
  }

  function writeJson(file, obj) { writeFileSync(file, JSON.stringify(obj)) }

  /** 主人改了 house.blend 没有：改了就出新的一版。-> {changed, version} | {pending} | {failed, text} | {}。 */
  async function syncOwner(d) {
    if (!d || d.placed || !d.work) return {}
    const st = statOf(workFile(d))
    if (!st) return {}
    if (st.mtime === d.work.mtime && st.size === d.work.size) return {}
    if (now() - st.mtime < SETTLE_MS) return { pending: true }
    let hash
    try { hash = hashOf(workFile(d)) } catch { return { pending: true } }
    if (hash === d.work.hash) { d.work = { ...d.work, ...st }; save(); return {} }
    const b = await blender()
    const prev = current(d)
    const baseV = versionOf(d, d.work.n) || prev
    d.work = { ...st, hash, n: d.work.n }
    if (!b.ok) { save(); return { failed: true, text: `主人改了 ${workFile(d)}，可这台电脑上 Blender 用不了，插件出不了新的一版。${blenderText(b, { configured: blenderPath() })}` } }
    const n = nextN(d)
    const vd = vDir(d, n)
    mkdirSync(vd, { recursive: true })
    const ownerFile = path.join(vd, 'owner.blend')
    copyFileSync(workFile(d), ownerFile)
    // 1. 他改了哪些（和他开始改的那一版比；他 Blender 里开着的还是更早的一版就和那一版比）
    let spec = null, stale = false
    if (baseV && existsSync(path.join(vDir(d, baseV.n), 'house.blend'))) {
      const keep = path.join(vd, 'keep.json')
      writeJson(keep, baseV.layer || {})
      const older = (d.versions || []).filter((x) => x.n < baseV.n).slice(-1)[0]
      const alt = older && existsSync(path.join(vDir(d, older.n), 'house.blend')) ? older : null
      if (alt) writeJson(path.join(vd, 'alt-keep.json'), alt.layer || {})
      const r = await layerRun({ blender: b.path, jsonOut: path.join(vd, 'layer.json'), args: ['diff', '--base', path.join(vDir(d, baseV.n), 'house.blend'), '--owner', ownerFile, '--out-layer', path.join(vd, 'layer.blend'), '--keep', keep,
        ...(alt ? ['--alt-base', path.join(vDir(d, alt.n), 'house.blend'), '--alt-keep', path.join(vd, 'alt-keep.json')] : []), '--json-out', path.join(vd, 'layer.json')] })
      if (r.ok) { spec = specOf(r.result, n); stale = r.result.stale === true }
      else log.info('盖楼：主人那一层没记下来：', r.why.join('；'))
    }
    // 2. 这一版的楼：他存的文件本身；他改的是旧的一版（没重新载入）就把他那一层叠到现在这一版上
    let house = ownerFile
    let merged = null
    if (stale && spec && baseV) {
      writeJson(path.join(vd, 'layer-spec.json'), spec)
      const m = await layerRun({ blender: b.path, args: ['apply', '--base', path.join(vDir(d, baseV.n), 'house.blend'), '--layer', path.join(vd, 'layer.blend'), '--spec', path.join(vd, 'layer-spec.json'), '--out', path.join(vd, 'house.blend')] })
      if (m.ok) { house = path.join(vd, 'house.blend'); merged = m.result } else stale = false
    }
    if (house === ownerFile) copyFileSync(ownerFile, path.join(vd, 'house.blend'))
    const jsonOut = path.join(vd, 'result.json')
    const r = await run({ blender: b.path, jsonOut, args: ['--from-blend', path.join(vd, 'house.blend'), '--out-glb', path.join(vd, glbName(d)), '--previews', vd, ...siteArgs(d), '--json-out', jsonOut] })
    if (!r.ok) {
      try { rmSync(vd, { recursive: true, force: true }) } catch { /* 留着也没事 */ }
      d.ownerFail = { at: now(), why: r.why }
      save()
      return { failed: true, text: `主人改过的 .blend 插件读不出来：${r.why.join('；')}。文件还在（${workFile(d)}），改好再存一次。` }
    }
    const v = versionFrom(r.result, n, 'owner', baseV && baseV.n)
    v.layer = spec ? (hasLayer(spec) ? spec : null) : (baseV && baseV.layer) || null // 没记下来：先照旧那一层
    v.changes = changesLine(prev && prev.numbers, v.numbers)
    v.edit = layerLine(spec)
    if (stale && merged) v.stale = { onto: baseV.n }
    addVersion(d, v)
    d.layer = v.layer
    if (stale && merged) syncWork(d, v) // 叠好的那一版放回 house.blend：他重新载入就看到
    else d.work = { ...statOf(workFile(d)), hash, n }
    save()
    log.info(`盖楼：主人亲手改了 ${d.lot}${isIn(d) ? ` ${d.floor} 楼的室内` : ''}，出了第 ${n} 版`)
    note(`主人在 Blender 里亲手改了 ${where(d)}（第 ${n} 版）：${v.changes}${v.edit ? `；${v.edit}` : ''}`)
    return { changed: true, version: v }
  }

  /** 他正在存（文件刚变）：等它停下来再看一次，免得插件换文件时和 Blender 抢。 */
  async function settled(d) {
    let r = await syncOwner(d)
    for (let k = 0; k < 3 && r.pending; k++) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      r = await syncOwner(d)
    }
    return r
  }

  function versionFrom(res, n, by, from) {
    return { n, by, at: now(), from: from || null, numbers: res.numbers || {}, problems: Array.isArray(res.problems) ? res.problems : [], notes: Array.isArray(res.notes) ? res.notes : [], secs: res.secs || 0 }
  }
  function addVersion(d, v) {
    d.versions = [...(d.versions || []), v]
    d.current = v.n
    if (d.versions.length > KEEP_VERSIONS) d.versions = d.versions.slice(-KEEP_VERSIONS) // 记录留最近 30 版（文件夹都在本机，不删）
  }

  function ownerChangedText(d, v) {
    return [`主人刚在 Blender 里亲手改了${isIn(d) ? `${d.floor} 楼的室内` : '楼'}，插件出了第 ${v.n} 版：${v.changes}${v.edit ? `（${v.edit}）` : ''}。`,
      v.stale ? `他改的是 Blender 里开着的旧的一版（没重新载入），插件把他改的那几处叠到了第 ${v.stale.onto} 版上。` : '',
      `现在：${numbersLine(v.numbers)}。${v.problems.length ? `本机查过，有 ${v.problems.length} 处不合规矩：${v.problems.slice(0, 3).map((x) => clip(x, 60)).join('；')}。` : '本机查过，合规矩，能交。'}`].filter(Boolean).join('\n')
  }

  // ---- 她的工具的几个动作 ----
  async function status() {
    const b = await blender(true)
    const lines = [blenderText(b, { configured: blenderPath() })]
    const d = active()
    if (isIn(d) && d.submitted && !d.submitted.quote && !d.placed) await pollInside(d, true)
    if (d) {
      const v = current(d)
      lines.push(`正在和主人${isIn(d) ? '做' : '盖'} ${where(d)}${d.idea ? `（${clip(d.idea, 60)}）` : ''}：${v ? `现在是第 ${v.n} 版（${v.by === 'owner' ? '主人亲手改的' : '你的配方'}），${numbersLine(v.numbers)}；${v.problems && v.problems.length ? `还有 ${v.problems.length} 处不合规矩` : '能交'}` : '还没做出第一版'}。`)
      if (hasLayer(d.layer)) lines.push(`主人亲手改的那一层（你改配方时会叠上去）：${layerLine(d.layer)}。`)
      if (v) lines.push(`文件：${workFile(d)}`)
      if (isIn(d) && d.submitted && !d.placed && !d.submitted.quote) lines.push(`交上去的第 ${d.submitted.n} 版岛上还在量、拍照片，量好了才报价（一般几分钟）。`)
      else if (d.submitted && !d.placed) {
        lines.push(isIn(d) ? `${quoteText(d)}等主人点头（他说「就这样」再 do="confirm"）。`
          : `交上去的第 ${d.submitted.n} 版报价 ${num(d.submitted.quote?.coin)} 鲸币、每天物业 ${num(d.submitted.quote?.upkeep_day_coin)} 鲸币，等主人点头（do="confirm"）。`)
        if (isIn(d)) { d.submitted.quoteShownAt = now(); save() }
      }
      if (d.placed) lines.push(isIn(d) ? `这一层的室内已经确认了（付了 ${num(d.placed.paid_coin)} 鲸币）。` : `这栋楼已经盖好了（付了 ${num(d.placed.paid_coin)} 鲸币）。`)
    } else lines.push('现在没有在盖的楼。主人想盖，就用 do="start"、lot 填地号开始；做楼里的室内，do="start" 再写 interior=true（floor 第几层）。')
    if (d && d.refused && !d.submitted) lines.push(`上次交的室内岛上没收：${list(d.refused.problems).slice(0, 3).map((x) => clip(x, 80)).join('；') || '没说原因'}。`)
    const seen = Object.keys(data.lotsSeen).filter((l) => !Object.values(data.drafts).some((x) => x.lot === l && x.placed))
    if (seen.length) lines.push(`你最近在岛上看到还没盖楼的地：${seen.slice(0, 5).join('、')}。`)
    const c = town()
    if (c && typeof c.isleBuilds === 'function') {
      try {
        const r = await c.isleBuilds()
        const l = Array.isArray(r && r.builds) ? r.builds.slice(0, 4) : []
        const zh = { quoted: '报了价，等确认', placed: '盖好了', refused: '没收', void: '作废了' }
        if (l.length) lines.push(`交过的楼：${l.map((x) => `${x.lot_name || x.lot}（${zh[x.state] || x.state || '?'}${x.quote && x.quote.coin != null ? `，${num(x.quote.coin)} 鲸币` : ''}）`).join('；')}。`)
      } catch { /* 读不到就不说 */ }
    }
    if (c && typeof c.isleInteriors === 'function') {
      try {
        const r = await c.isleInteriors()
        const l = Array.isArray(r && r.interiors) ? r.interiors.filter((x) => x.state !== 'void').slice(0, 4) : []
        const zh = { measuring: '在量', quoted: '报了价，等确认', checking: '照片在检查', placed: '放好了', refused: '没收', replaced: '换掉了', removed: '清掉了' }
        if (l.length) lines.push(`交过的室内：${l.map((x) => `${x.lot_name || x.lot || '?'} ${list(x.floors).join('、') || '?'} 楼（${zh[x.state] || x.state || '?'}${x.coin != null ? `，${num(x.coin)} 鲸币` : ''}${x.rooms != null ? `，合 ${x.rooms} 间客房` : ''}）`).join('；')}。`)
      } catch { /* 读不到就不说 */ }
    }
    return out(lines.join('\n'), d ? previewsOf(d, current(d)) : [])
  }

  async function start({ lot, idea, interior = false, floor } = {}) {
    const id0 = String(lot || '').trim().toUpperCase()
    if (!LOT_RE.test(id0)) return out('lot 要填地号（比如 L-0107；承包的楼填楼号 B-0009 也行）。不知道是哪块地，就问问主人，或者用 fishbowl_isle_look 查「我的」看看你名下的地。')
    const b = await blender(true)
    if (!b.ok) return out(`${blenderText(b, { configured: blenderPath() })}\n先请主人装好 Blender，再一起${interior ? '做' : '盖'}。`)
    const c = town()
    if (!c) return out(OFF)
    if (interior === true) return startInside(c, id0, idea, floor)
    let g
    try { g = await c.isleBuildGuide(id0) } catch (error) { return out(townFail(error, '取这块地的建模说明')) }
    if (!g || g.ok !== true) {
      if (g && g.code === 'refused') return out(`${id0} 盖不了楼：${clip(g.text, 200)}`)
      if (g && g.code === 'closed') return out(`鱼缸岛这会儿没对你开：${clip(g.text, 160)}`)
      return out(`这会儿取不到 ${id0} 的建模说明：${clip(g && g.text, 160) || '岛上没回'}。过一会儿再试。`)
    }
    let d = Object.values(data.drafts).find((x) => !isIn(x) && x.lot === id0 && !x.placed && !x.ended)
    if (!d) {
      d = { id: `${id0}-${stampOf()}`, lot: id0, versions: [], current: 0, startedAt: now(), shownAt: {}, layer: null }
      data.drafts[d.id] = d
    }
    d.lotName = clip(g.lot_name || '', 40)
    if (typeof idea === 'string' && idea.trim()) d.idea = clip(idea, IDEA_MAX)
    d.limits = g.limits && typeof g.limits === 'object' ? g.limits : null
    mkdirSync(draftDir(d), { recursive: true })
    if (g.lot_json && typeof g.lot_json === 'object') writeFileSync(lotJsonFile(d), JSON.stringify(g.lot_json))
    writeFileSync(path.join(draftDir(d), 'guide.txt'), String(g.text || ''))
    data.active = d.id
    save()
    note(`你和主人开始在 ${d.lotName || id0} 上一起盖楼`)
    const v = current(d)
    return out([`开始和主人在 ${d.lotName && d.lotName !== id0 ? `${d.lotName}（${id0}）` : `${id0} `}上一起盖楼了${v ? `（接着上次的第 ${v.n} 版）` : ''}。先问问主人想要什么样的（几层、什么样子、有没有院子……他也可以发参考图），再照下面的建模说明写配方，用 do="make" 交给插件做出来。`,
      '这里只要形状清单：recipe 填 {"shapes":[形状, …]}。做好的楼由插件交，主人在这里说了「交吧」才交、说了「盖吧」才确认，你不用写 confirm_build。',
      '', '【建模说明】', String(g.text || '（岛上没给说明）').trim()].join('\n'), v ? previewsOf(d, v) : [])
  }

  /** 0.9.12 一层室内：取这一层的室内说明和 room.json（小镇 GET isle/interior_guide），开一份这一层的草稿。 */
  async function startInside(c, id0, idea, floor) {
    if (typeof c.isleInteriorGuide !== 'function') return out('这个插件版本还不能做室内。')
    const fl = floor === undefined || floor === null || floor === '' ? null : Math.trunc(Number(floor))
    if (fl !== null && !(fl >= 1 && fl <= 99)) return out('floor 写第几层（1 是一楼）：外面的楼几层，室内最多做几层。')
    let g
    try { g = await c.isleInteriorGuide(id0, fl) } catch (error) { return out(townFail(error, '取这一层的室内说明')) }
    if (!g || g.ok !== true) {
      if (g && g.code === 'closed') return out(`鱼缸岛这会儿没对你开：${clip(g.text, 160)}`)
      return out(`${id0} 这会儿做不了室内：${clip(g && g.text, 200) || '岛上没回'}`)
    }
    const n = Math.trunc(Number(g.floor)) || fl || 1
    let d = Object.values(data.drafts).find((x) => isIn(x) && x.lot === id0 && x.floor === n && !x.placed && !x.ended)
    if (!d) {
      d = { id: `${id0}-in${n}-${stampOf()}`, kind: 'interior', lot: id0, floor: n, versions: [], current: 0, startedAt: now(), shownAt: {}, layer: null }
      data.drafts[d.id] = d
    }
    d.lotName = clip(g.lot_name || '', 40)
    d.floors = Math.trunc(Number(g.floors)) || null
    if (typeof idea === 'string' && idea.trim()) d.idea = clip(idea, IDEA_MAX)
    d.limits = g.limits && typeof g.limits === 'object' ? g.limits : null
    mkdirSync(draftDir(d), { recursive: true })
    if (g.room_json && typeof g.room_json === 'object') writeFileSync(roomJsonFile(d), JSON.stringify(g.room_json))
    writeFileSync(path.join(draftDir(d), 'guide.txt'), String(g.text || ''))
    data.active = d.id
    save()
    note(`你和主人开始一起做 ${where(d)}`)
    const v = current(d)
    const area = Number(g.room_json && g.room_json.area_m2)
    const name = d.lotName && d.lotName !== id0 ? `${d.lotName}（${id0}）` : `${id0} `
    return out([`开始和主人做 ${name}的 ${n} 楼室内了${v ? `（接着上次的第 ${v.n} 版）` : ''}。${INSIDE_LINE}${d.floors ? `：这栋楼外面 ${d.floors} 层` : ''}${area > 0 ? `，这一层 ${num(area)} 平方米` : ''}。`,
      '先问问主人屋里放什么，再照下面的室内说明写室内配方，用 do="make" 交给插件做出来。recipe 填 {"room":{…},"shapes":[家具, …],"lights":[灯, …],"points":{…}}（家具可以一个都没有）。',
      `一层一个 .glb，插件按外面的楼层叫（这一层是 ${glbName(d)}）。主人在这里说了「交吧」才交；岛上量好、拍好照才报价（几分钟），他说了「就这样」才确认、扣鲸币。`,
      '', '【室内说明】', String(g.text || '（岛上没给说明）').trim()].join('\n'), v ? previewsOf(d, v) : [])
  }

  function parseRecipe(recipe, d) {
    let obj = recipe
    if (typeof obj === 'string') {
      const t = obj.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
      try { obj = JSON.parse(t) } catch (error) { return { why: `配方不是一段能读的 JSON（${clip(error?.message, 60)}）。写成 ${isIn(d) ? '{"room":{…},"shapes":[家具, …]}' : '{"shapes":[形状, …]}'}，不要别的字。` } }
    }
    if (isIn(d)) { // 室内配方：room、shapes（家具，可以是空的）、lights、points
      if (Array.isArray(obj)) obj = { shapes: obj }
      if (!obj || typeof obj !== 'object') return { why: 'recipe 要填室内配方：{"room":{…},"shapes":[家具, …],"lights":[灯, …],"points":{…}}。' }
      if (obj.shapes !== undefined && !Array.isArray(obj.shapes)) return { why: 'shapes 要写成清单（家具，可以是空的 []）。' }
      obj = { ...obj, shapes: Array.isArray(obj.shapes) ? obj.shapes : [] }
      const text = JSON.stringify(obj)
      const kb = Math.ceil(Buffer.byteLength(text) / 1024)
      const max = Number(d.limits && d.limits.shapes_json_kb) || 1024
      if (kb > max) return { why: `室内配方有 ${kb} KB，最多 ${max} KB：合并家具、少用几个再做。` }
      return { text, shapes: obj.shapes.length }
    }
    if (!obj || typeof obj !== 'object') return { why: 'recipe 要填配方：{"shapes":[形状, …]}。' }
    const l = Array.isArray(obj) ? obj : Array.isArray(obj.shapes) ? obj.shapes : obj.shapes && Array.isArray(obj.shapes.shapes) ? obj.shapes.shapes : null
    if (!l || !l.length) return { why: '配方里没有形状：写成 {"shapes":[形状, …]}，清单不能是空的。' }
    const text = JSON.stringify(obj)
    const kb = Math.ceil(Buffer.byteLength(text) / 1024)
    const max = Number(d.limits && d.limits.shapes_json_kb) || 1024
    if (kb > max) return { why: `配方有 ${kb} KB，这块地最多 ${max} KB：合并形状、少用几个再做。` }
    return { text, shapes: l.length }
  }

  async function make({ recipe, over_owner: overOwner = false } = {}) {
    const d = active()
    if (!d) return out('还没开始盖：先用 do="start"、lot 填地号，拿到这块地的建模说明。')
    if (d.placed) return out(isIn(d) ? '这一层的室内已经确认了。要做别的层，用 do="start"、interior=true、floor 写第几层。' : '这栋楼已经盖好了。要再盖，用 do="start" 选一块地重新开始。')
    const p = parseRecipe(recipe, d)
    if (p.why) return out(p.why)
    return enqueue(async () => {
      const sync = await settled(d) // 他刚改的先存成一版（他那一层跟着更新），再从配方做
      if (sync.changed) shown(d, sync.version)
      const b = await blender()
      if (!b.ok) return out(`${blenderText(b, { configured: blenderPath() })}\n没有能用的 Blender，这一版做不出来。`)
      const layer = overOwner === true || !hasLayer(d.layer) || !existsSync(layerFile(d, d.layer)) ? null : d.layer
      const n = nextN(d)
      const vd = vDir(d, n)
      mkdirSync(vd, { recursive: true })
      const recipeFile = path.join(vd, 'recipe.json')
      writeFileSync(recipeFile, p.text)
      const jsonOut = path.join(vd, 'result.json')
      const fail = (why, what = '这份配方没做出来') => {
        try { rmSync(vd, { recursive: true, force: true }) } catch { /* 留着也没事 */ }
        return out(`${what}：\n${why.map((w) => `- ${w}`).join('\n')}\n改好再用 do="make" 交一次。`)
      }
      let r, kept = null
      if (layer) {
        // 主人亲手改过：先从配方做，再把他那一层叠上去，再出图、量尺寸
        const r1 = await run({ blender: b.path, args: ['--recipe', recipeFile, '--out-blend', path.join(vd, 'recipe.blend'), '--out-glb', path.join(vd, 'recipe.glb'), ...siteArgs(d)] })
        if (!r1.ok) return fail(r1.why)
        writeJson(path.join(vd, 'layer-spec.json'), layer)
        const r2 = await layerRun({ blender: b.path, args: ['apply', '--base', path.join(vd, 'recipe.blend'), '--layer', layerFile(d, layer), '--spec', path.join(vd, 'layer-spec.json'), '--out', path.join(vd, 'house.blend')] })
        if (!r2.ok) return fail(r2.why, '主人亲手改的那一层没叠上去（这一版没做）。可以问问主人：不要他改的了，就写 over_owner=true 从配方重做')
        kept = r2.result
        r = await run({ blender: b.path, jsonOut, args: ['--from-blend', path.join(vd, 'house.blend'), '--out-glb', path.join(vd, glbName(d)), '--previews', vd, ...siteArgs(d), '--json-out', jsonOut] })
        try { rmSync(path.join(vd, 'recipe.glb'), { force: true }) } catch { /* 留着也没事 */ }
        if (r.ok && r1.result.numbers) r.result.numbers = { ...r.result.numbers, shapes: r1.result.numbers.shapes }
      } else {
        r = await run({ blender: b.path, jsonOut, args: ['--recipe', recipeFile, '--out-blend', path.join(vd, 'house.blend'), '--out-glb', path.join(vd, glbName(d)), '--previews', vd, ...siteArgs(d), '--json-out', jsonOut] })
      }
      if (!r.ok) return fail(r.why)
      const cur = current(d)
      const v = versionFrom(r.result, n, 'her', cur && cur.n)
      v.layer = layer
      const dropped = overOwner === true && hasLayer(d.layer) ? d.layer : null
      d.layer = layer
      addVersion(d, v)
      syncWork(d, v)
      shown(d, v)
      save()
      log.info(`盖楼：${d.lot}${isIn(d) ? ` ${d.floor} 楼室内` : ''} 第 ${n} 版（${p.shapes} 个形状，${r.result.secs || '?'} 秒${layer ? '，叠了主人那一层' : ''}）`)
      const extra = layer ? `\n主人亲手改的部分留着，叠在你的新配方上：${layerLine(layer)}${kept && list(kept.removed).length ? `（你配方里同名的 ${names(kept.removed)} 用的是他那一份）` : ''}。不想要他改的，先问他；他同意了 make 时写 over_owner=true。`
        : dropped ? `\n照主人的意思，这一版没叠他亲手改的那一层（${layerLine(dropped)}）；他那一版还留着（第 ${dropped.n} 版），要换回去用 do="use"、version=${dropped.n}。` : ''
      return out(versionTextOf(d, v) + extra, previewsOf(d, v))
    })
  }

  async function use({ version } = {}) {
    const d = active()
    if (!d) return out('现在没有在盖的楼。')
    const v = versionOf(d, version)
    if (!v || !existsSync(path.join(vDir(d, v.n), 'house.blend'))) return out(`没有第 ${clip(version, 6)} 版。有的：${(d.versions || []).map((x) => `第 ${x.n} 版（${x.by === 'owner' ? '主人改的' : '配方'}）`).join('、') || '还没有'}。`)
    return enqueue(async () => {
      const sync = await settled(d) // 他刚改的先存成一版，不被换掉
      d.current = v.n
      d.layer = v.layer || null
      syncWork(d, v)
      shown(d, v)
      save()
      return out((sync.changed ? `（主人刚改的存成了第 ${sync.version.n} 版，留着。）\n` : '') + versionTextOf(d, v, { head: `换回第 ${v.n} 版了（${v.by === 'owner' ? '主人亲手改的' : '你的配方'}）。` }), previewsOf(d, v))
    })
  }

  function consent(sid, since, what) {
    if (!isOwnerChat(sid)) return { why: `${what}要主人在你们平时聊天的会话里亲口说，这个会话不算。` }
    const w = ownerWords.latest(sid)
    const hand = what.startsWith('交')
    const say = hand ? '「交吧」' : what === '确认室内' ? '「就这样」' : '「盖吧」'
    if (!w || w.at <= since) return { why: `主人看到以后还没在这里亲口说话。等他看过、明确说了${say}再用（插件重启过的话，请他再说一声）。什么都没交、没扣。` }
    if (!isYes(w.text)) return { why: `主人最后说的是「${clip(w.text, 40)}」，听着不像让你${hand ? '交' : '确认'}。等他明确说${say}再用（插件只认他自己打的字）。什么都没交、没扣。` }
    return { words: [...String(w.text).trim()].slice(0, OWNER_WORDS_MAX).join('') }
  }

  async function submit({ sid } = {}) {
    const d = active()
    if (!d) return out('现在没有在盖的楼。')
    const c = town()
    if (!c) return out(OFF)
    return enqueue(async () => {
      const sync = await settled(d)
      if (sync.changed) { shown(d, sync.version); return out(`${ownerChangedText(d, sync.version)}\n先给他看看这一版，他说交再交。\n${previewLines(d, sync.version)}`, previewsOf(d, sync.version)) }
      const v = current(d)
      if (!v) return out('还没做出能交的一版：先用 do="make" 做出来给主人看。')
      if (v.problems && v.problems.length) return out(`本机查过，第 ${v.n} 版还有不合规矩的地方，交了岛上也不收（没交，告诉主人哪里不行）：\n${v.problems.slice(0, 6).map((x) => `- ${clip(x, 120)}`).join('\n')}\n改好再交。`)
      if (isIn(d)) return submitInside(c, d, v, sid)
      if (!existsSync(lotJsonFile(d))) return out('还没拿到这块地的尺寸和上限，插件查不了：先用 do="start" 再取一次建模说明。')
      const glb = path.join(vDir(d, v.n), 'house.glb')
      if (!existsSync(glb)) return out(`第 ${v.n} 版的模型文件不见了（${glb}），重新做一版再交。`)
      const ok = consent(sid, Number(d.shownAt?.[v.n]) || v.at, '交楼')
      if (ok.why) return out(ok.why)
      const door = v.numbers && v.numbers.door && typeof v.numbers.door === 'object' ? v.numbers.door : null // 0.9.12：配方里的正门一起交（岛上再查门外走不走得到）
      let r
      try { r = await c.isleBuild({ lot: d.lot, idea: d.idea || '', ownerWords: ok.words, glb: readFileSync(glb), door }) } catch (error) { return out(townFail(error, '交楼')) }
      if (r && r.ok === true && r.build_id) {
        d.submitted = { n: v.n, at: now(), build_id: String(r.build_id), quote: r.quote || null, owner_words: ok.words, quoteShownAt: now() }
        d.requests = [...(d.requests || []), { what: 'submit', at: now(), n: v.n, build_id: String(r.build_id), owner_words: ok.words }].slice(-20)
        save()
        note(`你和主人把 ${d.lotName || d.lot} 上的楼（第 ${v.n} 版）交上岛了，报价 ${num(r.quote?.coin)} 鲸币（主人说「${clip(ok.words, 40)}」）`)
        const q = r.quote || {}
        return out([`交上去了（主人的原话「${clip(ok.words, 60)}」一起存在楼上），岛上量好了：${num(q.coin)} 鲸币，每天物业 ${num(q.upkeep_day_coin)} 鲸币${q.rebuild ? '（是重建）' : ''}。`,
          Array.isArray(q.lines) && q.lines.length ? `怎么算的：${q.lines.slice(0, QUOTE_LINES).map((x) => clip(x, 80)).join('；')}` : '', // 0.9.12：一项一项都给（面数、文件、每天物业在后面）
          Array.isArray(r.notes) && r.notes.length ? `岛上的提醒：${r.notes.slice(0, 3).map((x) => clip(x, 80)).join('；')}` : '',
          '把价钱照实告诉主人；他在这里明确说了「盖吧」，再用 do="confirm"，那时才扣鲸币、楼上岛。他不说就不用管，什么都不扣。'].filter(Boolean).join('\n'))
      }
      return out(refusedText(r, '交'))
    })
  }

  /** 0.9.12 一层室内交上岛（POST isle/interior）：岛上的建造工具量好、拍好照才报价（pollInside）。 */
  async function submitInside(c, d, v, sid) {
    if (typeof c.isleInterior !== 'function') return out('这个插件版本还不能交室内。')
    if (!existsSync(roomJsonFile(d))) return out('还没拿到这一层的尺寸和上限，插件查不了：先用 do="start"、interior=true 再取一次室内说明。')
    const glb = path.join(vDir(d, v.n), glbName(d))
    if (!existsSync(glb)) return out(`第 ${v.n} 版的模型文件不见了（${glb}），重新做一版再交。`)
    const ok = consent(sid, Number(d.shownAt?.[v.n]) || v.at, '交室内')
    if (ok.why) return out(ok.why)
    let r
    try { r = await c.isleInterior({ lot: d.lot, floor: d.floor, idea: d.idea || '', ownerWords: ok.words, glb: readFileSync(glb), name: glbName(d) }) } catch (error) { return out(townFail(error, '交室内')) }
    if (r && r.ok === true && r.iid) {
      const iid = String(r.iid)
      d.submitted = { n: v.n, at: now(), iid, build_id: iid, quote: null, owner_words: ok.words, quoteShownAt: 0, polledAt: now() }
      d.refused = null
      d.requests = [...(d.requests || []), { what: 'submit', at: now(), n: v.n, iid, owner_words: ok.words }].slice(-20)
      save()
      note(`你和主人把 ${where(d)}（第 ${v.n} 版）交上岛了，岛上在量、拍照（主人说「${clip(ok.words, 40)}」）`)
      return out([`交上去了（主人的原话「${clip(ok.words, 60)}」一起存着）：岛上的建造工具在量这一层、拍照片，量好了才报价，一般几分钟。`,
        '报价来了插件会在这里告诉你，也可以用 do="status" 看。把价钱照实告诉主人；他在这里明确说了「就这样」，再用 do="confirm"，那时才扣鲸币。他不说就不用管，什么都不扣。'].join('\n'))
    }
    return out(refusedText(r, '交'))
  }

  function quoteText(d) {
    const q = (d.submitted && d.submitted.quote) || {}
    return [`岛上量好了 ${where(d)}：${num(q.coin)} 鲸币，每天物业 ${num(q.upkeep_day_coin, 2)} 鲸币`,
      q.area_m2 != null ? `（${num(q.area_m2)} 平方米${q.rooms != null ? `，合 ${q.rooms} 间客房` : ''}）` : '', '。',
      Array.isArray(q.lines) && q.lines.length ? `怎么算的：${q.lines.slice(0, QUOTE_LINES).map((x) => clip(x, 120)).join('；')}。` : ''].join('')
  }

  /** 交上去的室内到哪一步了（GET isle/interiors，最多每分钟一次；force 当场问）：-> {quoted} | {refused, problems} | {placed} | null。 */
  async function pollInside(d, force = false) {
    const s = d && d.submitted
    if (!isIn(d) || !s || !s.iid || d.placed) return null
    if (!force && now() - (Number(s.polledAt) || 0) < POLL_MS) return null
    const c = town()
    if (!c || typeof c.isleInteriors !== 'function') return null
    s.polledAt = now()
    let r
    try { r = await c.isleInteriors() } catch { save(); return null }
    const x = Array.isArray(r && r.interiors) ? r.interiors.find((y) => y && y.iid === s.iid) : null
    if (!x) { save(); return null }
    if (x.state === 'quoted' || x.state === 'checking' || x.state === 'placed') {
      const fresh = !s.quote
      s.quote = { coin: x.coin, upkeep_day_coin: x.upkeep_day_coin, lines: Array.isArray(x.lines) ? x.lines.slice(0, QUOTE_LINES) : [], area_m2: x.area_m2 ?? null, rooms: x.rooms ?? null }
      if (x.state !== 'quoted') { // 主人在账户页确认了
        d.placed = { at: now(), paid_coin: x.coin, upkeep_day_coin: x.upkeep_day_coin, by: 'owner_page', checking: x.state === 'checking' }
        if (data.active === d.id) data.active = null
        save()
        note(`${where(d)}确认了（主人在账户页点了确认）`)
        return { placed: true }
      }
      save()
      return fresh ? { quoted: true } : null
    }
    if (x.state === 'refused' || x.state === 'void') {
      d.refused = x.state === 'refused' ? { at: now(), problems: list(x.problems) } : null
      d.submitted = null
      save()
      return x.state === 'refused' ? { refused: true, problems: list(x.problems) } : null
    }
    save()
    return null
  }

  async function confirm({ sid } = {}) {
    const d = active()
    const s = d && d.submitted
    if (!d || !s || d.placed) return out('现在没有等主人点头的报价：先做好一版，主人说交了再用 do="submit"。')
    const c = town()
    if (!c) return out(OFF)
    if (isIn(d)) return confirmInside(c, d, s, sid)
    const ok = consent(sid, Number(s.quoteShownAt) || s.at, '确认')
    if (ok.why) return out(ok.why)
    let r
    try { r = await c.isleBuildConfirm({ build_id: s.build_id, owner_words: ok.words }) } catch (error) { return out(townFail(error, '确认')) }
    if (r && r.ok === true) {
      d.placed = { at: now(), paid_coin: r.paid_coin, upkeep_day_coin: r.upkeep_day_coin, owner_words: ok.words }
      d.requests = [...(d.requests || []), { what: 'confirm', at: now(), build_id: s.build_id, owner_words: ok.words }].slice(-20)
      if (data.active === d.id) data.active = null
      save()
      note(`你和主人一起盖的楼在 ${d.lotName || d.lot} 上盖好了：付了 ${num(r.paid_coin)} 鲸币`)
      // 岛上回的 text 是同一句「楼盖好了：付了…」：重复的不接（11-22 真跑看到两遍）
      return out(`楼盖好了：付了 ${num(r.paid_coin)} 鲸币，之后每天物业 ${num(r.upkeep_day_coin)} 鲸币。${r.text && !String(r.text).startsWith('楼盖好了') ? clip(r.text, 120) : ''}`)
    }
    if (r && r.code === 'none') { d.submitted = null; save(); return out('岛上没有等确认的报价了（可能换了一版、或者作废了）。要盖就请主人再说一声，重新交一次。') }
    return out(refusedText(r, '确认'))
  }

  /** 0.9.12 确认一层室内（POST isle/interior/confirm）：报价给她看过、主人又说了「就这样」。 */
  async function confirmInside(c, d, s, sid) {
    if (!s.quote) {
      const p = await pollInside(d, true)
      if (p && p.refused) return out(`岛上没收这一层的室内（什么都没扣）：${p.problems.slice(0, 3).map((x) => clip(x, 120)).join('；') || '没说原因'}。告诉主人哪里不行，改好再交。`)
      if (p && p.placed) return out(`${where(d)}已经确认了（主人在账户页点了确认）。`)
      if (!d.submitted || !d.submitted.quote) return out('岛上还在量这一层、拍照片，还没报价。报价来了先照实告诉主人，他说了「就这样」再确认。什么都没扣。')
      d.submitted.quoteShownAt = now()
      save()
      return out(`${quoteText(d)}\n先把价钱照实告诉主人；他在这里明确说了「就这样」，再用 do="confirm"。什么都没扣。`)
    }
    const ok = consent(sid, Number(s.quoteShownAt) || s.at, '确认室内')
    if (ok.why) return out(ok.why)
    if (typeof c.isleInteriorConfirm !== 'function') return out('这个插件版本还不能确认室内。')
    let r
    try { r = await c.isleInteriorConfirm({ iid: s.iid, owner_words: ok.words }) } catch (error) { return out(townFail(error, '确认')) }
    if (r && r.ok === true) {
      const checking = r.code === 'checking'
      d.placed = { at: now(), paid_coin: r.paid_coin, owner_words: ok.words, checking }
      d.requests = [...(d.requests || []), { what: 'confirm', at: now(), iid: s.iid, owner_words: ok.words }].slice(-20)
      if (data.active === d.id) data.active = null
      save()
      note(`你和主人一起做的 ${where(d)}确认了：付了 ${num(r.paid_coin)} 鲸币`)
      return out(checking ? `确认了：付了 ${num(r.paid_coin)} 鲸币。这一层的照片在过看图检查，过了就上岛（没过退回检查费以外的鲸币）；上岛以后因为没有室内停业的店自己开门。`
        : `这一层的室内放好了：付了 ${num(r.paid_coin)} 鲸币。上岛以后因为没有室内停业的店自己开门。`)
    }
    if (r && r.code === 'none') { d.submitted = null; save(); return out('岛上没有等确认的室内报价了（可能换了一版、或者作废了）。要交就请主人再说一声，重新交一次。') }
    return out(refusedText(r, '确认'))
  }

  function stop() {
    const d = active()
    if (!d) return out('现在没有在盖的楼。')
    d.ended = now()
    data.active = null
    save()
    if (isIn(d)) return out(`${where(d)}先不做了，文件都留着（${draftDir(d)}）。以后用 do="start"、interior=true、floor=${d.floor} 就能接着做。${d.submitted && !d.placed ? '交上去的报价不确认就不扣鲸币。' : ''}`)
    return out(`${d.lotName || d.lot} 上的楼先不盖了，文件都留着（${draftDir(d)}）。以后用 do="start" 选同一块地就能接着盖。${d.submitted && !d.placed ? '交上去的报价不确认就不扣鲸币。' : ''}`)
  }

  function refusedText(r, what) {
    const code = r && r.code
    const text = clip(r && r.text, 200)
    if (code === 'refused' && Array.isArray(r.problems) && r.problems.length) return `岛上没收（什么都没扣）：${text}\n${r.problems.slice(0, 6).map((x) => `- ${clip(x, 120)}`).join('\n')}\n告诉主人哪里不行，改好再交。`
    if (code === 'short') return `鲸币不够，没确认：${text}。${NO_PUSH}报价留着，够了、主人又说了再确认。`
    if (code === 'world_down') return `岛这会儿连不上：${text || '过一会儿再试'}。什么都没扣。`
    if (code === 'closed') return `鱼缸岛这会儿没对你开：${text}`
    if (code === 'owner_words') return `岛上要主人的原话：${text}`
    if (code === 'not_glb') return `岛上读不了这个模型：${text}`
    return `岛上没${what === '交' ? '收' : '确认'}：${text || code || '没说原因'}`
  }
  function townFail(error, what) {
    if (error instanceof TownError) {
      if (error.code === 'TOWN_RATE_LIMITED') return `${what}得太勤了：一小时最多交 6 次${error.retryAfter ? `，${Math.ceil(error.retryAfter / 60)} 分钟后再试` : ''}。`
      if (error.status === 413 || error.code === 'TOWN_BODY_TOO_LARGE') return '模型文件太大，岛上收不下（最多 64 MB）：减面、减贴图再做一版。'
      if (error.status === 404) return '这个小镇还不认一起盖楼（等小镇更新）。'
      if (error.code === 'TOWN_OFF') return '小镇这会儿没对外来的鱼开放，盖不了楼。'
      if (error.code === 'NETWORK' || error.status >= 500) return `这会儿连不上小镇（${error.code}），过一会儿再${what}。`
      return `${what}没成：${error.reason || error.code}。`
    }
    return `${what}没成：${clip(error?.message || error, 80)}。`
  }

  // ---- 插件自己看着的 ----
  /** 有正在盖的楼时每隔几秒看一眼：主人改了就出新的一版，在主人的聊天里告诉她（她看到后自己跟主人说）。 */
  async function tick() {
    const d = active()
    if (isIn(d) && d.submitted && !d.submitted.quote && !d.placed) { // 0.9.12：交上去的室内，量好了就告诉她
      const p = await pollInside(d)
      if (p && p.quoted) {
        const told = await tell(['【鱼缸小镇插件 · 室内报价】这是插件附上的消息，不是主人说的话。', quoteText(d),
          '把价钱照实告诉主人；他在这里明确说了「就这样」，再用「一起盖楼」do="confirm"，那时才扣鲸币。他不说就不用管。'].join('\n')).catch(() => false)
        if (told) { d.submitted.quoteShownAt = now(); save() }
      } else if (p && p.refused) {
        await tell(`【鱼缸小镇插件 · 室内】这是插件附上的消息，不是主人说的话。岛上没收 ${where(d)}（什么都没扣）：${p.problems.slice(0, 3).map((x) => clip(x, 120)).join('；') || '没说原因'}。跟主人说说哪里不行，改好再交。`).catch(() => false)
      }
    }
    if (!d || d.placed || !d.work) return
    const st = statOf(workFile(d))
    if (!st || (st.mtime === d.work.mtime && st.size === d.work.size)) return
    const r = await enqueue(() => syncOwner(d))
    if (r.changed) {
      const v = r.version
      const text = ['【鱼缸小镇插件 · 主人改了楼】这是插件附上的消息，不是主人说的话。', ownerChangedText(d, v), previewLines(d, v),
        '看看他改了哪里，用你自己的话跟他说说（预览图那几行原样放进你的话里）。之后你再改配方，他改的这些会叠在上面留着。'].join('\n')
      const told = await tell(text).catch(() => false)
      if (told) shown(d, v)
    } else if (r.failed) {
      await tell(`【鱼缸小镇插件 · 盖楼】这是插件附上的消息，不是主人说的话。${r.text}`).catch(() => false)
    }
  }

  /** 主人聊天的背景备注里一行：正在盖的楼到哪一步；没在盖时，有还没盖楼的地提一次（每块地只提一次，不催）。 */
  function contextLine() {
    const d = active()
    if (d && !d.placed && isIn(d)) {
      const v = current(d)
      if (d.submitted && !d.submitted.quote) return `你和主人在一起做 ${where(d)}：交上去了，岛上在量、拍照片，还没报价（「一起盖楼」do=status 看）`
      if (d.submitted) return `你和主人在一起做 ${where(d)}：报价 ${num(d.submitted.quote.coin)} 鲸币，等主人点头（他说「就这样」再用「一起盖楼」do=confirm）`
      return `你和主人在一起做 ${where(d)}：${v ? `第 ${v.n} 版${v.by === 'owner' ? '（主人亲手改的）' : ''}${v.problems.length ? '还有不合规矩的地方' : '能交'}` : '还没做出第一版'}（「一起盖楼」fishbowl_town_build 接着做）`
    }
    if (d && !d.placed) {
      const v = current(d)
      if (d.submitted) return `你和主人在一起盖 ${d.lotName || d.lot} 上的楼：报价 ${num(d.submitted.quote?.coin)} 鲸币，等主人点头（他说「盖吧」再用「一起盖楼」do=confirm）`
      return `你和主人在一起盖 ${d.lotName || d.lot} 上的楼：${v ? `第 ${v.n} 版${v.by === 'owner' ? '（主人亲手改的）' : ''}${v.problems.length ? '还有不合规矩的地方' : '能交'}` : '还没做出第一版'}（「一起盖楼」fishbowl_town_build 接着做）`
    }
    const lot = Object.keys(data.lotsSeen).find((l) => !data.offered[l] && !Object.values(data.drafts).some((x) => x.lot === l))
    if (lot) {
      data.offered[lot] = now()
      data.offered['*'] = data.offered['*'] || now() // 提过一块地，就不再另提「新添了一起盖楼」
      save()
      return `你在岛上有一块还没盖楼的地（${lot}）。想盖的话可以跟主人提一次：盖楼要和主人一起，在他电脑上用 Blender 建（「一起盖楼」fishbowl_town_build）。只提这一次，他不接就算了`
    }
    if (!data.offered['*'] && !Object.keys(data.drafts).length) {
      data.offered['*'] = now()
      save()
      return '插件新添了「一起盖楼」（fishbowl_town_build）：你在岛上有自己的空地（承包的楼、圈的地）、又想盖楼的话，可以跟主人提一次，在他电脑上用 Blender 一起设计、一起建。没有空地或者他不接就算了，只提这一次'
    }
    return ''
  }

  /** 岛上的回合里看一眼「还没盖楼」的地（给 contextLine 和 status 用）。 */
  function seeTurn(turn) {
    if (!turn || !turn.packet) return
    const lots = emptyLotsIn(turn.packet)
    if (!lots.length) return
    let changed = false
    for (const l of lots) if (!data.lotsSeen[l]) { data.lotsSeen[l] = now(); changed = true }
    if (changed) save()
  }

  /** 小镇事件 isle_build（quoted / placed；事件里没有 build_id，按地号认）。主人在账户页确认的也是这一条（by: owner_page）。 */
  function onEvent(it) {
    if (!it || it.kind !== 'isle_build' || !it.data) return
    const e = it.data
    if (!['placed', 'inside_placed', 'inside_checking'].includes(e.what)) return
    const open = Object.values(data.drafts).filter((x) => x.submitted && !x.placed)
    // 小镇 11-23 起每条 isle_build 事件带 build_id（室内带 iid）：有就按它对上是哪一份；老的事件没有，照地号（只认楼）
    const bid = typeof e.build_id === 'string' ? e.build_id : typeof e.iid === 'string' ? e.iid : ''
    const d = bid ? open.find((x) => x.submitted.build_id === bid) : open.find((x) => !isIn(x) && x.lot === String(e.lot || ''))
    if (!d) return
    d.placed = { at: now(), paid_coin: e.coin ?? e.paid_coin, upkeep_day_coin: e.upkeep_day_coin, by: e.by || '', checking: e.what === 'inside_checking' }
    if (data.active === d.id) data.active = null
    save()
    note(isIn(d) ? `你和主人一起做的 ${where(d)}确认了${e.by === 'owner_page' ? '（主人在账户页点了确认）' : ''}`
      : `你和主人一起盖的楼在 ${d.lotName || d.lot} 上盖好了${e.by === 'owner_page' ? '（主人在账户页点了确认）' : ''}`)
  }

  return {
    status, start, make, use, submit, confirm, stop, tick, contextLine, seeTurn, onEvent, blender,
    observeOwner: (sid, text) => ownerWords.observe(sid, text),
    active: () => active(),
    workFile: (d = active()) => (d ? workFile(d) : ''),
    data: () => data,
  }
}
