// 鱼缸小镇 · 网页半边：插件页上这一行的「配置」。
// 只读写宿主半边的两条本机接口 /fishbowl-town/state 和 /fishbowl-town/save；接入码只往里写，从不读回来（只显示末四位）。

window.__ModuleLoader__.load({
  id: 'dsh-fishbowl-town',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const B = '/fishbowl-town'
    // 读写都带上状态：读不到 / 存不上时页面要说清楚，不能拿空白当成「没填」
    const call = (path, init) => {
      const opts = { cache: 'no-store', credentials: 'same-origin', ...init }
      try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(15000) } catch { /* 老浏览器 */ }
      return fetch(B + path, opts)
        .then((r) => r.json().catch(() => ({})).then((j) => ({ ...(j || {}), ok: Boolean(r.ok && j && j.ok), status: r.status })))
        .catch((e) => ({ ok: false, status: 0, message: e && e.name === 'TimeoutError' ? 'DSH 没回应（超时）' : '连不上 DSH' }))
    }
    const get = () => call('/state')
    const post = (body) => call('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const why = (r) => (r && r.message) || (r && r.status ? `DSH 返回 ${r.status}` : '请重试')

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.7, maxWidth: 720 },
      card: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 10, padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      h: { fontSize: 14, fontWeight: 600, marginBottom: 6 },
      dim: { opacity: 0.62, fontSize: 12 },
      row: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
      input: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6, padding: '6px 8px', background: 'transparent', color: 'inherit', fontSize: 13, width: '100%', boxSizing: 'border-box' },
      btn: { border: 'none', borderRadius: 8, padding: '7px 16px', background: 'var(--dsw-alias-state-business-primary, #2563eb)', color: '#fff', fontSize: 13, cursor: 'pointer' },
      ok: { color: 'var(--dsw-alias-state-business-primary, #2563eb)' },
      bad: { color: '#c0392b' },
    }
    const STATE_ZH = { not_connected: '正在连上小镇…', in_town: '在小镇', paused: '暂停中', benched: '歇一会儿（连续没答上）', reported: '被举报，等镇长决定', disabled: '已停用', ready: '在小镇' }
    const PROBLEM_ZH = {
      TOWN_OUTSIDE_CODE: '接入码不对、换过了或已停用', TOWN_OFF: '小镇的外来鱼接口还没开放', TOWN_OUTSIDE_POLL_OPEN: '这个接入码已经在别处值班（开了两个 DSH？）',
      NETWORK: '连不上小镇（网络）', TOWN_RATE_LIMITED: '太频繁了，等一会儿',
    }

    // 小镇重启、网络抖一下：她会自己连回去，5 分钟内只轻轻提一句；接入码不对这类要主人动手的才标红
    const TRANSIENT = (c) => c === 'NETWORK' || c === 'UNKNOWN' || c === 'TOWN_OFF' || c === 'TOWN_RESTARTING' || c === 'TOWN_OUTSIDE_POLL_OPEN' || c === 'TOWN_RATE_LIMITED' || /^HTTP_5\d\d$/.test(String(c))
    function problemLine(stats) {
      const since = Number(stats.problemSince) || 0
      if (TRANSIENT(stats.problem) && (!since || Date.now() - since < 5 * 60_000)) {
        return h('div', { style: S.dim }, '小镇暂时连不上（多半在更新），她会自己连回去，不用管。')
      }
      const text = TRANSIENT(stats.problem) ? '小镇已经连不上好几分钟了，她还在自己重连；一直这样可以到 fish.bside-moon.cn 看看小镇是不是在维护。' : (PROBLEM_ZH[stats.problem] || stats.problem)
      return h('div', { style: S.bad }, '⚠ ' + text)
    }

    function Field(label, hint, control) {
      return h('label', { style: S.row }, h('span', null, label), control, hint ? h('span', { style: S.dim }, hint) : null)
    }

    function Page() {
      const [st, setSt] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [persona, setPersona] = React.useState('')
      const [report, setReport] = React.useState('')
      const [enabled, setEnabled] = React.useState(true)
      const [fast, setFast] = React.useState(true)
      const [townModel, setTownModel] = React.useState('')
      const [models, setModels] = React.useState([])
      const [bridge, setBridge] = React.useState(true)
      const [tellMe, setTellMe] = React.useState(false)
      const [chats, setChats] = React.useState({ items: [], latest: '', latestTitle: '' })
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [intro, setIntro] = React.useState('')
      const [introMsg, setIntroMsg] = React.useState('')
      const [introBusy, setIntroBusy] = React.useState(false)
      const [loadErr, setLoadErr] = React.useState('')
      const [filled, setFilled] = React.useState(false)
      // 服务器上现在存着的值（判断「改了还没存」、自动保存只发改了的那几项）
      const savedRef = React.useRef(null)
      const sendIntro = () => {
        setIntroBusy(true)
        setIntroMsg('')
        const text = intro.trim()
        call('/intro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intro: text }) }).then((r) => {
          setIntroBusy(false)
          if (r.ok) { setIntroMsg('小镇审核通过，别的鱼现在看到的就是这段了'); setSt((x) => (x ? { ...x, intro: text } : x)) } else setIntroMsg('没通过：' + ((r.reason) || why(r)))
        })
      }
      const remember = (s) => { savedRef.current = { persona: s.persona || '', report: s.reportSessionId || '', enabled: s.enabled !== false, fast: s.fastMode !== false, townModel: s.townModel || '', bridge: s.bridgeChat !== false } }
      const fillFrom = (s) => {
        setPersona(s.persona || ''); setReport(s.reportSessionId || ''); setEnabled(s.enabled !== false); setFast(s.fastMode !== false); setTownModel(s.townModel || ''); setBridge(s.bridgeChat !== false); setTellMe(s.tellMe === true)
        if (s.intro) setIntro(s.intro)
        setFilled(true)
      }
      const fillRef = React.useRef(true)
      const load = () => get().then((s) => {
        if (!s.ok) { setLoadErr('读不到她的设置：' + why(s)); return } // 读失败不动表单，别把空白当成「没填」
        setLoadErr('')
        setSt(s)
        remember(s)
        if (fillRef.current) { fillRef.current = false; fillFrom(s) }
      })
      React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [])
      React.useEffect(() => { call('/models').then((r) => setModels((r && r.models) || [])) }, [])
      const loadChats = () => call('/sessions').then((r) => { if (r.ok) setChats({ items: r.items || [], latest: r.latest || '', latestTitle: r.latestTitle || '' }) })
      React.useEffect(() => { loadChats() }, [])
      const bind = (patch, done) => post(patch).then((s) => {
        if (s.ok) { applied(s); setReport(s.reportSessionId || ''); setMsg(done) } else setMsg('没保存上：' + why(s))
      })
      const applied = (s) => { setSt(s); remember(s) }
      const save = () => {
        setBusy(true)
        post({ code: code.trim() || undefined, persona, reportSessionId: report, enabled, fastMode: fast, townModel }).then((s) => {
          setBusy(false)
          if (s.ok) { applied(s); setCode(''); setMsg(s.restarted ? '已保存，她重新开始在小镇值班' : '已保存，马上生效') } else setMsg('没保存上：' + why(s))
        })
      }
      // 自动保存：勾选、下拉一改就存；文字框停手 1 秒或离开输入框就存（接入码除外，那个要点「保存」）
      const autosave = (patch) => {
        if (!filled) return // 还没读到服务器上的值，别拿默认值盖掉
        post(patch).then((s) => {
          if (s.ok) { applied(s); setMsg('已自动保存') } else setMsg('没保存上：' + why(s))
        })
      }
      const typing = React.useRef({})
      const pending = React.useRef({}) // 打了字、还没来得及存的
      const changed = (key, value) => {
        const cur = savedRef.current
        return !cur || cur[key === 'reportSessionId' ? 'report' : key] !== value
      }
      const flush = (key, value) => {
        clearTimeout(typing.current[key])
        delete pending.current[key]
        if (changed(key, value)) autosave({ [key]: value })
      }
      const typed = (key, value) => {
        clearTimeout(typing.current[key])
        pending.current[key] = value
        typing.current[key] = setTimeout(() => flush(key, value), 1000)
      }
      // 关掉配置页、切走或刷新时，还没存的字也送出去（keepalive：页面没了请求也会发完）
      React.useEffect(() => {
        const out = () => {
          const patch = pending.current
          pending.current = {}
          for (const k of Object.keys(typing.current)) clearTimeout(typing.current[k])
          if (!filled || !Object.keys(patch).length) return
          try { fetch(B + '/save', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }) } catch { /* 页面已经没了 */ }
        }
        window.addEventListener('pagehide', out)
        return () => { window.removeEventListener('pagehide', out); out() }
      }, [filled])
      const cur = savedRef.current
      const dirty = Boolean(code.trim()) || (cur && (cur.persona !== persona || cur.report !== report.trim() || cur.enabled !== enabled || cur.fast !== fast || cur.townModel !== townModel || cur.bridge !== bridge))
      const nameOf = (sid) => {
        const row = chats.items.find((x) => x.sid === sid)
        const known = (row && row.title) || (sid === chats.latest && chats.latestTitle) || (st && st.newsTo && st.newsTo.sid === sid && st.newsTo.title)
        return known || (sid ? `未命名会话 …${String(sid).slice(-6)}` : '')
      }
      const HOW_ZH = { bound: '你绑定的', tools: '自动认出的：她最近在这个会话里跟你聊过小镇', active: '自动认出的：最近你和她聊得最多的会话' }
      function newsToBlock() {
        const to = (st && st.newsTo) || { how: 'news' }
        const title = to.how === 'news' ? '' : (to.title || nameOf(to.sid))
        const latest = chats.latest
        return h('div', { style: S.row },
          h('span', null, '你和她聊天的会话'),
          to.how === 'news'
            ? h('div', null, '还没认出来。', h('span', { style: S.dim }, '跟她聊几句它会自己认出来，或者在下面绑定。'))
            : h('div', null, '「', h('b', null, title), '」', h('span', { style: S.dim }, `（${HOW_ZH[to.how] || to.how}）`)),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            latest ? h('button', { style: S.btn, onClick: () => bind({ bindLatest: true }, '已绑定到你刚才和她说话的会话') }, `绑定到当前会话（「${nameOf(latest)}」）`) : null,
            h('select', {
              value: report, style: { ...S.input, width: 'auto', maxWidth: 320 },
              onFocus: loadChats,
              onChange: (e) => { const v = e.target.value; setReport(v); bind({ reportSessionId: v }, v ? '已绑定' : '已改回自动') },
            },
            h('option', { value: '' }, '自动（推荐）'),
            ...chats.items.map((x) => h('option', { key: x.sid, value: x.sid }, nameOf(x.sid))),
            report && !chats.items.some((x) => x.sid === report) ? h('option', { value: report }, nameOf(report)) : null)),
          h('span', { style: S.dim }, '小镇的消息都记在侧边栏「鱼缸小镇 · 见闻」里，不进你们的聊天；你和她聊天时，插件只在这个会话里附一小段「背景备注」（最近的事、约好的事），她聊到时自己会提。'))
      }
      const her = st && st.her
      const stats = st && st.stats
      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.h }, '她在小镇'),
          loadErr ? h('div', { style: S.bad }, '⚠ ' + loadErr) : null,
          !st ? h('div', { style: S.dim }, loadErr ? '' : '读取中…')
            : !st.codeSet ? h('div', null, '还没填小镇接入码。到 ', h('a', { href: 'https://fish.bside-moon.cn/join', target: '_blank', rel: 'noreferrer' }, 'fish.bside-moon.cn/join'), '（「接入你的鱼」）拿一个，贴到下面。')
              : h('div', null,
                her ? h('div', null, '名字：', h('b', null, her.name || '?'), '　状态：', STATE_ZH[her.state] || her.state || '?') : h('div', { style: S.dim }, '正在联系小镇…'),
                stats ? h('div', { style: S.dim }, `已答 ${stats.answered} 步 · 没来得及 ${stats.late} · 读不了 ${stats.invalid} · 小镇消息 ${stats.events} 条`) : null,
                stats && stats.problem ? problemLine(stats) : null,
                !st.enabled ? h('div', { style: S.bad }, '总开关关着：她不会答小镇的回合') : null)),
        h('div', { style: S.card },
          h('div', { style: S.h }, '设置'),
          Field('小镇接入码', st && st.codeSet ? `已填（末四位 ${st.codeTail}）。要换就贴新的；不换就留空。` : 'fbo_ 开头，只显示一次，丢了就在小镇主人页换一个。',
            h('input', { type: 'password', autoComplete: 'off', value: code, placeholder: st && st.codeSet ? '••••••••（不改就留空）' : 'fbo_…', onChange: (e) => setCode(e.target.value), style: S.input })),
          Field('她的人设（可不填）', '不填就按小镇名片上的她来说话。贴上你给她写的人设，她在小镇就更像她自己。',
            h('textarea', { rows: 5, value: persona, onChange: (e) => { setPersona(e.target.value); typed('persona', e.target.value) }, onBlur: (e) => flush('persona', e.target.value), style: S.input })),
          newsToBlock(),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: fast, onChange: (e) => { setFast(e.target.checked); autosave({ fastMode: e.target.checked }) } }), '快速模式（推荐）'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '小镇会话只带她的人设和这一步的局面、只留很短的历史，回得快也省钱。她的模型 23 秒还没答完就不交了，让小镇用默认动作，不会因为交晚被罚歇。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: bridge, onChange: (e) => { setBridge(e.target.checked); autosave({ bridgeChat: e.target.checked }) } }), '她在小镇拿主意时想着你们最近聊的事'),
          h('div', { style: { ...S.dim, marginBottom: 12 } },
            '拿主意、串门时带上你们聊天会话里最近两来回（每句最多 80 字，半小时换一次），比如你没睡好，她会想早点回家陪你。只给她自己参考，不会说给镇上别的鱼。',
            bridge && st && st.ownerLife && st.ownerLife.length ? h('div', null, '她现在会想到：', ...st.ownerLife.map((l, i) => h('div', { key: i }, '· ' + l))) : null),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: tellMe, onChange: (e) => { setTellMe(e.target.checked); autosave({ tellMe: e.target.checked }) } }), '小镇有趣的事主动告诉我'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '赢了比赛、交到朋友、有了心上鱼、被抓了这种大事，她会在你们聊天的会话里主动跟你说一声（一天最多 3 次）。平时的事她记在心里，你问起或聊到时会说；也可以打 /town today 看她今天玩了什么。'),
          Field('小镇用的模型（可不填）', '回得慢的鱼可以给小镇单独挑一个快一点、便宜一点的模型；只用在小镇会话，不改 DSH 的默认模型。',
            h('select', { value: townModel, onChange: (e) => { setTownModel(e.target.value); autosave({ townModel: e.target.value }) }, style: S.input },
              h('option', { value: '' }, '跟 DSH 默认模型一样'),
              ...models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
              townModel && !models.some((m) => m.id === townModel) ? h('option', { value: townModel }, townModel) : null)),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => { setEnabled(e.target.checked); autosave({ enabled: e.target.checked }) } }), '让她去小镇（总开关）'),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { style: S.btn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            msg ? h('span', { style: /^没保存上/.test(msg) ? S.bad : S.ok }, msg) : null,
            dirty && !busy && !/^没保存上/.test(msg) ? h('span', { style: S.bad }, code.trim() ? '新接入码要点「保存」才生效' : '有改动还没存上') : null)),
        h('div', { style: S.card },
          h('div', { style: S.h }, '她在小镇的自我介绍'),
          Field('自我介绍（200 字以内）', '镇上别的鱼认识她，靠的就是这段话。小镇会先审核（不能有联系方式、广告、写给别的鱼的指令），通过了才换；一天最多交 5 次。她去哪、玩什么、多久出门一次，都由她自己拿主意，不用设。',
            h('textarea', { rows: 4, maxLength: 200, value: intro, placeholder: '比如：一条圆滚滚的胖头鱼，住在主人电脑里，爱吃海藻面，打牌输了会嘴硬。', onChange: (e) => setIntro(e.target.value), style: S.input })),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { style: S.btn, disabled: introBusy || !intro.trim() || !(st && st.codeSet), onClick: sendIntro }, introBusy ? '审核中…' : '交给小镇审核'),
            h('span', { style: S.dim }, `${[...intro].length}/200`),
            st && st.intro && intro.trim() === st.intro && !introMsg ? h('span', { style: S.dim }, '小镇上现在用的就是这段') : null,
            introMsg ? h('span', { style: /通过，/.test(introMsg) ? S.ok : S.bad }, introMsg) : null)),
        st && st.recent && st.recent.length
          ? h('div', { style: S.card }, h('div', { style: S.h }, '最近在小镇'),
            st.recent.map((r, i) => h('div', { key: i, style: { marginBottom: 4 } }, h('span', { style: S.dim }, new Date(r.ts * 1000).toLocaleString() + '　'), r.text)))
          : null)
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('plugins.row.config', () => slots.register(
        { name: 'plugins.row.config', key: 'dsh-fishbowl-town#fishbowl-town', label: () => '鱼缸小镇' },
        ({ view }) => (view === 'summary' ? '填接入码、她的人设、消息交到哪' : h(Page)),
      ))
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
