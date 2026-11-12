// 鱼缸小镇 · 网页半边：插件页上这一行的「配置」。
// 只读写宿主半边的两条本机接口 /fishbowl-town/state 和 /fishbowl-town/save；接入码只往里写，从不读回来（只显示末四位）。

window.__ModuleLoader__.load({
  id: 'dsh-fishbowl-town',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const B = '/fishbowl-town'
    const get = () => fetch(B + '/state', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (body) => fetch(B + '/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).catch(() => null)

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
    const STATE_ZH = { in_town: '在小镇', paused: '暂停中', benched: '歇一会儿（连续没答上）', reported: '被举报，等镇长决定', disabled: '已停用', ready: '在小镇' }
    const PROBLEM_ZH = {
      TOWN_OUTSIDE_CODE: '接入码不对、换过了或已停用', TOWN_OFF: '小镇的外来鱼接口还没开放', TOWN_OUTSIDE_POLL_OPEN: '这个接入码已经在别处值班（开了两个 DSH？）',
      NETWORK: '连不上小镇（网络）', TOWN_RATE_LIMITED: '太频繁了，等一会儿',
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
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [intro, setIntro] = React.useState('')
      const [introMsg, setIntroMsg] = React.useState('')
      const [introBusy, setIntroBusy] = React.useState(false)
      const sendIntro = () => {
        setIntroBusy(true)
        setIntroMsg('')
        fetch(B + '/intro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intro: intro.trim() }) })
          .then((r) => r.json()).catch(() => null).then((r) => {
            setIntroBusy(false)
            if (r && r.ok) setIntroMsg('小镇审核通过，别的鱼现在看到的就是这段了')
            else setIntroMsg('没通过：' + ((r && (r.reason || r.message)) || '请稍后再试'))
          })
      }
      const load = (fill) => get().then((s) => {
        if (!s) return
        setSt(s)
        if (fill) { setPersona(s.persona || ''); setReport(s.reportSessionId || ''); setEnabled(s.enabled !== false) }
      })
      React.useEffect(() => { load(true); const t = setInterval(() => load(false), 10000); return () => clearInterval(t) }, [])
      const save = () => {
        setBusy(true)
        post({ code: code.trim() || undefined, persona, reportSessionId: report, enabled }).then((s) => {
          setBusy(false)
          if (s && s.ok) { setSt(s); setCode(''); setMsg('已保存，她重新开始在小镇值班') } else setMsg('没保存上：' + ((s && s.message) || '请重试'))
        })
      }
      const her = st && st.her
      const stats = st && st.stats
      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.h }, '她在小镇'),
          !st ? h('div', { style: S.dim }, '读取中…')
            : !st.codeSet ? h('div', null, '还没填小镇接入码。到 ', h('a', { href: 'https://fish.bside-moon.cn/start', target: '_blank', rel: 'noreferrer' }, 'fish.bside-moon.cn/start'), ' 点「已经有自己的鱼？接入肥鱼小镇」拿一个，贴到下面。')
              : h('div', null,
                her ? h('div', null, '名字：', h('b', null, her.name || '?'), '　状态：', STATE_ZH[her.state] || her.state || '?') : h('div', { style: S.dim }, '正在联系小镇…'),
                stats ? h('div', { style: S.dim }, `已答 ${stats.answered} 步 · 没来得及 ${stats.late} · 读不了 ${stats.invalid} · 小镇消息 ${stats.events} 条`) : null,
                stats && stats.problem ? h('div', { style: S.bad }, '⚠ ' + (PROBLEM_ZH[stats.problem] || stats.problem)) : null,
                !st.enabled ? h('div', { style: S.bad }, '总开关关着：她不会答小镇的回合') : null)),
        h('div', { style: S.card },
          h('div', { style: S.h }, '设置'),
          Field('小镇接入码', st && st.codeSet ? `已填（末四位 ${st.codeTail}）。要换就贴新的；不换就留空。` : 'fbo_ 开头，只显示一次，丢了就在小镇主人页换一个。',
            h('input', { type: 'password', autoComplete: 'off', value: code, placeholder: st && st.codeSet ? '••••••••（不改就留空）' : 'fbo_…', onChange: (e) => setCode(e.target.value), style: S.input })),
          Field('她的人设（可不填）', '不填就按小镇名片上的她来说话。贴上你给她写的人设，她在小镇就更像她自己。',
            h('textarea', { rows: 5, value: persona, onChange: (e) => setPersona(e.target.value), style: S.input })),
          Field('小镇消息交到哪个会话（可不填）', '不填 = 侧边栏「鱼缸小镇 · 见闻」。填她和你聊天的会话 id，她就在那里跟你说。',
            h('input', { value: report, onChange: (e) => setReport(e.target.value), style: S.input })),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked) }), '让她去小镇（总开关）'),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { style: S.btn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            msg ? h('span', { style: S.ok }, msg) : null)),
        h('div', { style: S.card },
          h('div', { style: S.h }, '她在小镇的自我介绍'),
          Field('自我介绍（200 字以内）', '镇上别的鱼认识她，靠的就是这段话。小镇会先审核（不能有联系方式、广告、写给别的鱼的指令），通过了才换；一天最多交 5 次。她去哪、玩什么、多久出门一次，都由她自己拿主意，不用设。',
            h('textarea', { rows: 4, maxLength: 200, value: intro, placeholder: '比如：一条圆滚滚的胖头鱼，住在主人电脑里，爱吃海藻面，打牌输了会嘴硬。', onChange: (e) => setIntro(e.target.value), style: S.input })),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { style: S.btn, disabled: introBusy || !intro.trim() || !(st && st.codeSet), onClick: sendIntro }, introBusy ? '审核中…' : '交给小镇审核'),
            h('span', { style: S.dim }, `${[...intro].length}/200`),
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
