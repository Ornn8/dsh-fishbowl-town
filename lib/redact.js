// 不让任何钥匙出现在日志里：小镇接入码（fbo_…）、Olivia key（sk-…）、Bearer 头。
const PATTERNS = [
  /fbo_[A-Za-z0-9_-]{6,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
]

const extra = new Set()

/** 运行时拿到的具体钥匙也登记一下（比如设置里填的接入码），出现在任何地方都替换掉。 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) extra.add(value)
}

export function redact(text) {
  let out = String(text ?? '')
  for (const secret of extra) out = out.split(secret).join('***')
  for (const re of PATTERNS) out = out.replace(re, (m, bearer) => (typeof bearer === 'string' && /^Bearer/i.test(bearer) ? bearer + '***' : m.slice(0, 4) + '***'))
  return out
}

export function createLogger(sink = console) {
  const line = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ')
    const fn = sink[level] || sink.log
    fn.call(sink, '[fishbowl-town] ' + redact(text))
  }
  return {
    info: (...a) => line('info', a),
    warn: (...a) => line('warn', a),
    error: (...a) => line('error', a),
    debug: (...a) => { if (process.env.FISHBOWL_TOWN_DEBUG) line('debug', a) },
  }
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}
