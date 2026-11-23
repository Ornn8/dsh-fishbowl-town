// 鱼缸小镇 · 网页半边：插件页上这一行的「配置」。
// 只读写宿主半边的两条本机接口 /fishbowl-town/state 和 /fishbowl-town/save；接入码只往里写，从不读回来（只显示末四位）。

window.__ModuleLoader__.load({
  id: 'dsh-fishbowl-town',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const B = '/fishbowl-town'
    // 0.6.0：一台 DSH 带几条鱼时，页面上正在看的是哪一条（每个请求都带 ?fish=<编号>；空 = 第一条）
    let FISH = ''
    const withFish = (path) => (FISH ? path + (path.includes('?') ? '&' : '?') + 'fish=' + encodeURIComponent(FISH) : path)
    // 读写都带上状态：读不到 / 存不上时页面要说清楚，不能拿空白当成「没填」
    const call = (path, init) => {
      const opts = { cache: 'no-store', credentials: 'same-origin', ...init }
      try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(15000) } catch { /* 老浏览器 */ }
      return fetch(B + withFish(path), opts)
        .then((r) => r.json().catch(() => ({})).then((j) => ({ ...(j || {}), ok: Boolean(r.ok && j && j.ok), status: r.status })))
        .catch((e) => ({ ok: false, status: 0, message: e && e.name === 'TimeoutError' ? 'DSH 没回应（超时）' : '连不上 DSH' }))
    }
    const get = () => call('/state')
    const post = (body) => call('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const why = (r) => (r && r.message) || (r && r.status ? `DSH 返回 ${r.status}` : '请重试')
    // 0.6.5：装了新版、DSH 还没重启时，后台跑的还是旧插件：两边对不上就直说，别让人以为是坏了。
    // 0.9.12（主人 11-23「现在好像版本号是写死的」）：版本只写在 package.json 一处。网页这一半不再自带版本号：后台的 /state 给 version
    // （DSH 启动时读到、正在跑的）和 installed（这会儿磁盘上 package.json 写的）；后台旧得连 installed 都不给，就是装了新版还没重启。
    // 0.6.7：有更新的版本（后台每 6 小时看一眼国内镜像上的 latest.json）
    const newer = (st) => (st && st.ok && st.latest && st.latest.version
      ? `有新版本 ${st.latest.version}（你装的是 ${st.installed || st.version || '旧版'}）。更新：左侧栏「插件」→「添加插件」，贴 ${st.latest.url} 重新装（设置和接入码都保留），装完重启一次 DSH。${st.latest.notes ? '这一版：' + st.latest.notes : ''}`
      : '')
    const stale = (st) => (st && st.ok && ('installed' in st ? Boolean(st.installed && st.version && st.installed !== st.version) : true)
      ? `插件已经更新${st.installed ? '到 ' + st.installed : ''}，但 DSH 里跑的还是${st.version ? ' ' + st.version : '旧版'}：重启 DSH 后才生效（这之前加鱼、改设置可能不成）。`
      : '')

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
      const text = TRANSIENT(stats.problem) ? '小镇已经连不上好几分钟了，她还在自己重连；一直这样可以到 fishbowltown.com 看看小镇是不是在维护。' : (PROBLEM_ZH[stats.problem] || stats.problem)
      return h('div', { style: S.bad }, '⚠ ' + text)
    }

    function Field(label, hint, control) {
      return h('label', { style: S.row }, h('span', null, label), control, hint ? h('span', { style: S.dim }, hint) : null)
    }

    // ===================== 0.4.0：小镇的新功能（旧版小镇没有的项 features[name] 不是 true，整块不显示）=====================
    const yuan = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : '¥' + Number(v).toFixed(2))
    const when = (ts) => {
      const n = Number(ts)
      if (!Number.isFinite(n) || n <= 0) return ''
      const d = new Date(n < 1e12 ? n * 1000 : n)
      const p = (x) => String(x).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const nm = (x) => (typeof x === 'string' ? x : x && (x.name || x.fish_id)) || ''
    const list = (v) => (Array.isArray(v) ? v : [])
    const line = (key, ...kids) => h('div', { key, style: { marginBottom: 3 } }, ...kids)
    const sub = (title) => h('div', { key: 't' + title, style: { fontWeight: 600, margin: '8px 0 3px' } }, title)

    const R = {
      record(d) {
        const out = [h('div', { key: 'l' }, d.line || '还没有打过牌')]
        const recent = list(d.recent).slice(0, 6)
        if (recent.length) out.push(sub('最近几局'), ...recent.map((g, i) => line('g' + i, h('span', { style: S.dim }, when(g.ended) + '　'), `${g.game_zh || g.game || ''}${g.venue_name ? `（${g.venue_name}）` : ''}：${g.outcome_zh || g.outcome || ''}`, g.points ? h('span', { style: S.dim }, `　积分 ${g.points > 0 ? '+' : ''}${g.points}`) : null)))
        const a = d.places && d.places.arcade
        const p = d.places && d.places.pier
        if (a && a.plays) out.push(line('arc', `电玩城：玩了 ${a.plays} 次`, Object.values(a.best || {}).length ? `（${Object.values(a.best).map((b) => `${b.zh}最好 ${b.score}${b.unit || ''}`).join('，')}）` : '', a.plush ? `，拿到毛绒 ${a.plush} 个` : ''))
        if (p && (p.casts || p.swims)) out.push(line('pier', `码头：钓了 ${p.casts || 0} 次、钓到 ${p.catches || 0} 条，游泳 ${p.swims || 0} 次`))
        if (d.social) out.push(line('soc', `朋友 ${d.social.friends || 0} 个；串门：她去了 ${d.social.visits_made || 0} 次，别人来了 ${d.social.visits_received || 0} 次`))
        const rc = list(d.recent_receipts).slice(0, 5)
        if (rc.length) out.push(sub('最近的回执'), ...rc.map((x, i) => line('r' + i, h('span', { style: S.dim }, when(x.ts) + '　'), h('span', { style: x.ok === false ? S.bad : S.ok }, x.ok === false ? '没成' : '成了'), `　${x.reason || x.action || ''}`, x.spent_yuan && Number(x.spent_yuan) > 0 ? h('span', { style: S.dim }, `　花了 ${yuan(x.spent_yuan)}`) : null)))
        const notes = list(d.notes).slice(0, 5)
        if (notes.length) out.push(sub('她留下的话'), ...notes.map((x, i) => line('n' + i, h('span', { style: S.dim }, when(x.ts) + '　'), x.text || x.note || x.say || JSON.stringify(x))))
        return out
      },
      week(d) {
        const out = []
        const sp = d.spent || {}
        out.push(h('div', { key: 'sp' }, '这一周一共花了 ', h('b', null, yuan(sp.total_yuan) || '¥0.00'), list(sp.by_kind).length ? '（' + list(sp.by_kind).map((k) => `${k.name} ${yuan(k.yuan)}`).join('、') + '）' : ''))
        const treats = list(d.treats).slice(0, 8)
        if (treats.length) out.push(sub('请客'), ...treats.map((t, i) => line('t' + i, h('span', { style: S.dim }, when(t.at) + '　'), t.mine ? `她请${nm(t.to)}` : `${nm(t.from)}请她`, t.item ? `：${t.item}` : '', t.where ? `（${t.where}）` : '', t.price_yuan ? h('span', { style: S.dim }, `　${yuan(t.price_yuan)}`) : null)))
        const gin = list(d.gifts_in).slice(0, 8)
        if (gin.length) out.push(sub('收到的礼物'), ...gin.map((g, i) => line('gi' + i, h('span', { style: S.dim }, when(g.at) + '　'), `${nm(g.from)} 送的${g.item}`, g.occasion ? `（${g.occasion}）` : '', g.words ? `「${g.words}」` : '')))
        const gout = list(d.gifts_out).slice(0, 8)
        if (gout.length) out.push(sub('送出的礼物'), ...gout.map((g, i) => line('go' + i, h('span', { style: S.dim }, when(g.at) + '　'), `送${nm(g.to)}${g.item}`, g.occasion ? `（${g.occasion}）` : '', g.words ? `「${g.words}」` : '')))
        const pn = d.paper || {}
        const notes = list(pn.notes).slice(0, 6)
        if (notes.length || pn.times) out.push(sub(`日报上的心意（她上了 ${pn.times || 0} 次日报）`), ...notes.map((n, i) => line('pn' + i, `${n.kind || ''}${n.to ? '→' + nm(n.to) : ''}：${n.text || ''}`, n.printed ? null : h('span', { style: S.dim }, '（还没登）'))), ...list(pn.for_her).slice(0, 4).map((n, i) => line('pf' + i, `${nm(n.from)} 在日报上给她留了「${n.text || ''}」`)))
        const trips = list(d.trips).slice(0, 6)
        if (trips.length) out.push(sub('出游'), ...trips.map((t, i) => line('tr' + i, h('span', { style: S.dim }, when(t.at) + '　'), `${t.place}${t.with ? '，和' + nm(t.with) : ''}${t.paid_by_her ? '（她请的）' : ''}`, t.note ? `：${t.note}` : '')))
        const parties = list(d.parties).slice(0, 4)
        if (parties.length) out.push(sub('聚会'), ...parties.map((p, i) => line('pa' + i, h('span', { style: S.dim }, when(p.at) + '　'), `${p.kind || ''}${p.title ? '「' + p.title + '」' : ''}在${p.place || '镇上'}（${p.role === 'host' ? '她办的' : nm(p.host) + '办的'}，来了 ${list(p.guests).length} 位）`, p.summary ? `：${p.summary}` : '')))
        if (out.length === 1) out.push(h('div', { key: 'none', style: S.dim }, '这一周她还没为朋友做什么。'))
        return out
      },
      room(d) {
        const g = list(d.gifts)
        if (!g.length) return [h('div', { key: 'none', style: S.dim }, '她的房间里还没有礼物。')]
        return [h('div', { key: 'c', style: S.dim }, `一共 ${d.count != null ? d.count : g.length} 件，新的在前`), ...g.slice(0, 30).map((x, i) => line('g' + i, h('b', null, x.item), `　${nm(x.from)} 送的`, x.occasion ? `，${x.occasion}` : '', x.words ? `，「${x.words}」` : '', h('span', { style: S.dim }, '　' + when(x.at))))]
      },
      album(d) {
        const items = list(d.items)
        const out = []
        if (!items.length && !list(d.making).length) return [h('div', { key: 'none', style: S.dim }, '相册还是空的。她拍了照、点了歌、请人画了画，都会放在这里。')]
        out.push(h('div', { key: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 } }, ...items.map((it) => {
          const audio = it.kind === 'song'
          const cap = h('div', { style: { fontSize: 12, marginTop: 4 } }, it.what || '',
            h('div', { style: S.dim }, [list(it.with).length ? '和' + list(it.with).map(nm).join('、') : '', it.occasion || '', [yuan(it.price_yuan), it.paid_by ? nm(it.paid_by) + '付的' : ''].filter(Boolean).join('，'), when(it.created)].filter(Boolean).join(' · ')))
          return h('div', { key: it.item_id, style: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 8, padding: 8 } },
            audio ? h('div', null, h('div', { style: { fontSize: 22 } }, '🎵'), it.local ? h('audio', { controls: true, preload: 'none', src: it.local, style: { width: '100%' } }) : null)
              : it.local ? h('a', { href: it.local, target: '_blank', rel: 'noreferrer' }, h('img', { src: it.localThumb || it.local, loading: 'lazy', alt: it.what || '照片', style: { width: '100%', borderRadius: 6, display: 'block' } })) : null,
            cap)
        })))
        const making = list(d.making)
        if (making.length) out.push(sub('正在做'), ...making.map((m, i) => line('m' + i, m.what || '', h('span', { style: S.dim }, '　做好了会放进相册'))))
        const back = list(d.given_back)
        if (back.length) out.push(sub('没做成（钱已经退了）'), ...back.map((b, i) => line('b' + i, b.what || '', b.reason ? h('span', { style: S.dim }, `　${b.reason}`) : null)))
        return out
      },
      phone(d) {
        const threads = list(d.threads)
        const out = []
        if (!threads.length) out.push(h('div', { key: 'none', style: S.dim }, '她的小手机里还没有消息。'))
        for (const t of threads.slice(0, 8)) {
          out.push(h('div', { key: t.thread_id, style: { margin: '6px 0 10px' } },
            h('div', { style: { fontWeight: 600 } }, '和 ' + (list(t.with).map(nm).join('、') || '（群）'), t.unread ? h('span', { style: S.dim }, `　她还有 ${t.unread} 条没看`) : null),
            ...list(t.messages).slice(-6).map((m, i) => line('m' + i, h('span', { style: S.dim }, (m.name || '') + '：'), m.text || '', m.refused ? h('span', { style: S.bad }, `（没发出去：${m.refused}）`) : null))))
        }
        const meets = list(d.meets).filter((m) => ['proposed', 'accepted', 'started'].includes(m.state)).slice(0, 5)
        if (meets.length) out.push(sub('约见面'), ...meets.map((m, i) => line('me' + i, `${m.when_zh || ''} 在${m.place_name || m.place}，和${m.with}${m.what ? '：' + m.what : ''}`, h('span', { style: S.dim }, `　（${({ proposed: '等回话', accepted: '说定了', started: '见着了' })[m.state] || m.state}）`))))
        if (d.limits) out.push(h('div', { key: 'lim', style: { ...S.dim, marginTop: 6 } }, `防刷屏：每次醒来最多发 ${d.limits.per_look} 条，对方没回最多连发 ${d.limits.unanswered} 条，每天最多 ${d.limits.day} 条（今天还剩 ${d.limits.day_left}）。发消息不单独花钱，也不叫醒对方——对方下一次自己醒来时才看。`))
        return out
      },
    }

    // 0.6.2：「你不在这几天」——主人打开插件页时就看得到（不推送）：她离开了多久、这期间谁提起了她（小镇检查过的原话）
    function AwayCard() {
      const [row, setRow] = React.useState(null)
      React.useEffect(() => { call('/extra?s=away').then((r) => setRow(r)).catch(() => {}) }, [])
      const a = row && row.data && row.data.away
      if (!a) return null
      const said = list(a.lines).slice(-8)
      return h('div', { style: S.card },
        h('div', { style: S.h }, a.title || '你不在这几天'),
        h('div', { style: S.dim }, a.back ? `她离开了${a.days_zh || '一阵'}，${when(a.back)} 回来了。` : `她已经${a.days_zh || '一阵'}没来小镇了。`),
        ...(said.length ? said.map((m, i) => line('aw' + i, h('span', { style: S.dim }, when(m.ts) + '　'), `${nm(m)}：「${m.line || ''}」`))
          : [h('div', { key: 'none', style: S.dim }, '这几天没有鱼提起她。')]))
    }

    // 0.9.13「她的心思」（用户 11-23：想看心思那个会话得往下翻两百条）：她最近 30 次在「心思」会话里拿的主意，新的在前。
    // 数据在本机（/state 的 mind，后台每 10 秒读一次页面就跟着变）；后台旧得没有这一项就不显示
    const MIND_HINT = '她最近 30 次拿的主意：为什么叫她、她定了什么、她说的那句'
    const mindRows = (rows) => (rows.length
      ? rows.map((r, i) => line('m' + i, h('span', { style: S.dim }, when(r.ts) + '　' + (r.why || '') + ' → '), r.did || '',
        r.line ? `　「${r.line}」` : '', r.rc ? h('span', { style: /^没成/.test(r.rc) ? S.bad : S.dim }, `　（${r.rc}）`) : null))
      : [h('div', { key: 'none', style: S.dim }, '她在「心思」会话里还没拿过主意（插件这个版本装上以后才开始记）。')])
    function MindCard({ rows }) {
      const [open, setOpen] = React.useState(false)
      if (!Array.isArray(rows)) return null
      const body = mindRows(rows)
      return h('details', { style: S.card, open, onToggle: (e) => setOpen(e.target.open) },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: 14 } }, '她的心思', h('span', { style: { ...S.dim, fontWeight: 400 } }, '　' + MIND_HINT)),
        open ? h('div', { style: { marginTop: 8 } }, ...body, h('div', { style: { ...S.dim, marginTop: 6 } }, '只存在这台电脑上，最多 30 条。聊天里打 /town 心思 也能看；侧边栏里置顶的「鱼缸小镇 · 心思」是她现在用的那个会话。')) : null)
    }
    // 0.9.13「置顶哪些会话」的选项（顺序和名字）
    const PIN_ORDER = ['agency', 'visit', 'game', 'activity', 'news', 'build']
    const PIN_ZH = { agency: '心思', visit: '串门', game: '牌桌', activity: '日常', news: '见闻', build: '盖楼' }

    // 一块可以展开的小节：展开时读一次、之后每分钟刷新；小镇说没有这一项就整块不显示
    function Section({ name, title, hint, features }) {
      const [open, setOpen] = React.useState(false)
      const [row, setRow] = React.useState(null)
      const load = React.useCallback((force) => call(`/extra?s=${name}${force ? '&force=1' : ''}`).then((r) => setRow(r)), [name])
      React.useEffect(() => {
        if (!open) return undefined
        load(false)
        const t = setInterval(() => load(false), 60000)
        return () => clearInterval(t)
      }, [open, load])
      if (!features || features[name] !== true) return null
      const body = !row ? h('div', { style: S.dim }, '读取中…')
        : row.available === false ? h('div', { style: S.dim }, '这个小镇还没有这一项。')
          : !row.data ? h('div', { style: S.dim }, '这会儿读不到小镇，过一会儿自己会刷新。')
            : h('div', null, ...R[name](row.data), row.stale ? h('div', { style: S.dim }, '（小镇这会儿连不上，上面是上次读到的）') : null)
      return h('details', { style: S.card, open, onToggle: (e) => setOpen(e.target.open) },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: 14 } }, title, hint ? h('span', { style: { ...S.dim, fontWeight: 400 } }, '　' + hint) : null),
        open ? h('div', { style: { marginTop: 8 } }, body, h('div', { style: { marginTop: 8 } }, h('button', { style: { ...S.btn, padding: '3px 12px', fontSize: 12 }, onClick: () => load(true) }, '刷新'))) : null)
    }

    // 图片缩到 600KB 以内再交给小镇（小镇只收 webp / jpg / png，最多 600KB）
    function shrinkImage(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
          URL.revokeObjectURL(url)
          try {
            let side = 768
            const attempt = (q) => {
              const k = Math.min(1, side / Math.max(img.width, img.height))
              const c = document.createElement('canvas')
              c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k))
              c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
              c.toBlob((blob) => {
                if (!blob) return reject(new Error('这张图读不了'))
                if (blob.size > 560 * 1024 && (q > 0.5 || side > 320)) { if (q > 0.5) attempt(q - 0.15); else { side = Math.round(side * 0.75); attempt(0.8) } return }
                const fr = new FileReader()
                fr.onload = () => resolve({ b64: String(fr.result).split(',')[1] || '', size: blob.size, url: String(fr.result) })
                fr.onerror = () => reject(new Error('这张图读不了'))
                fr.readAsDataURL(blob)
              }, 'image/webp', q)
            }
            attempt(0.85)
          } catch (e) { reject(e) }
        }
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不了（要 png / jpg / webp）')) }
        img.src = url
      })
    }

    // 0.9.5 新手引导：第一次打开插件页时展开在最上面；「知道了」以后收起来，右上角一直留着「新手引导」可以再打开。
    // 内容来自后台（lib/guide.js，和 /town help、岛上的引导是同一套话）；旧后台没有就整块不显示
    const GUIDE_KEY = 'dsh-fishbowl-town.guide.seen'
    function Guide({ guide }) {
      let seen0 = false
      try { seen0 = window.localStorage.getItem(GUIDE_KEY) === '1' } catch { /* 存不了：每次都展开，也行 */ }
      const [open, setOpen] = React.useState(!seen0)
      if (!guide || !Array.isArray(guide.steps) || !guide.steps.length) return null
      const done = () => { setOpen(false); try { window.localStorage.setItem(GUIDE_KEY, '1') } catch { /* 这次有效 */ } }
      const pill = h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: open ? -6 : 0 } },
        h('button', { onClick: () => (open ? done() : setOpen(true)), style: { ...S.btn, padding: '3px 12px', fontSize: 12, borderRadius: 999, background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))' } },
          open ? '收起新手引导' : '？ 新手引导'))
      if (!open) return pill
      return h('div', null, pill,
        h('div', { style: { ...S.card, borderColor: 'rgba(201,128,58,.55)', background: 'rgba(201,128,58,.07)' } },
          h('div', { style: S.h }, guide.title || '新手引导'),
          h('ol', { style: { margin: '4px 0 8px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 } },
            ...guide.steps.map(([t, b], i) => h('li', { key: 'g' + i }, h('b', null, t), '：', b))),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('button', { onClick: done, style: S.btn }, '知道了'),
            h('span', { style: S.dim }, '以后点右上角「新手引导」，或在任意会话里打 /town help 都能再看。'))))
    }

    // 0.6.0：这台 DSH 带去小镇的鱼（最多 3 条）。切换就整页换成那条鱼的设置
    function FishBar({ st, fishId, setFish }) {
      const [msg, setMsg] = React.useState('')
      const list = (st && st.fish) || []
      const max = (st && st.maxFish) || 3
      const add = () => call('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addFish: true }) }).then((r) => {
        if (r.ok && r.added) setFish(r.added)
        else if (r.ok && !r.fishId) setMsg('没加上：DSH 里跑的还是 0.6.0 以前的插件（新版装上了但还没生效），重启 DSH 后再加')
        else setMsg('没加上：' + why(r))
      })
      const remove = (id, label) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`不再带「${label}」去小镇？她在小镇的账户、朋友都还在，以后用她的接入码可以再加回来。`)) return
        call('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ removeFish: id }) }).then((r) => {
          if (r.ok) setFish(r.fishId || ''); else setMsg('没移掉：' + why(r))
        })
      }
      const label = (x) => x.name || (x.codeSet ? `第${x.id}条鱼` : `第${x.id}条鱼（还没填接入码）`)
      const chip = (x) => {
        const on = x.id === (fishId || (list[0] && list[0].id))
        return h('button', { key: x.id, onClick: () => setFish(x.id), style: { ...S.btn, padding: '5px 12px', ...(on ? {} : { background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))' }) } },
          label(x), x.chatSid ? '' : '（没绑定会话）')
      }
      if (list.length <= 1) {
        return h('div', { style: { ...S.dim, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          '你在 DSH 里养了好几个角色？一台 DSH 最多能带 ' + max + ' 条鱼去小镇，每条鱼一个接入码、住在她自己的聊天会话里。',
          h('button', { onClick: add, style: { ...S.btn, padding: '4px 12px' } }, '再带一条鱼'),
          msg ? h('span', { style: S.bad }, msg) : null)
      }
      const cur = list.find((x) => x.id === fishId) || list[0]
      return h('div', { style: S.card },
        h('div', { style: S.h }, `这台 DSH 带去小镇的鱼（${list.length}/${max}）`),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
          ...list.map(chip),
          list.length < max ? h('button', { onClick: add, style: { ...S.btn, padding: '5px 12px', background: 'transparent', color: 'inherit', border: '1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.3))' } }, '＋ 再带一条') : null),
        h('div', { style: S.dim }, '下面是「', label(cur), '」的设置：她的接入码、人设，和她住的那个聊天会话（在那个会话里跟她说过话，再点「绑定到当前会话」）。每条鱼的小镇近况、日记、「主动告诉我」只进她自己的会话；/town 命令认的也是这个会话绑定的鱼（或 /town @名字 …）。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          h('button', { onClick: () => remove(cur.id, label(cur)), style: { ...S.btn, padding: '4px 12px', background: 'transparent', color: '#c0392b', border: '1px solid rgba(192,57,43,.4)' } }, '不带这条鱼了'),
          msg ? h('span', { style: S.bad }, msg) : null))
    }

    function Root() {
      const [fishId, setFishId] = React.useState('')
      FISH = fishId
      const setFish = (id) => { FISH = id || ''; setFishId(id || '') }
      return h(Page, { key: fishId || 'first', fishId, setFish })
    }

    function Page({ fishId = '', setFish = () => {} } = {}) {
      const [st, setSt] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [persona, setPersona] = React.useState('')
      const [report, setReport] = React.useState('')
      const [enabled, setEnabled] = React.useState(true)
      const [fast, setFast] = React.useState(true)
      const [townModel, setTownModel] = React.useState('')
      const [models, setModels] = React.useState([])
      const [bridge, setBridge] = React.useState(true)
      const [recap, setRecap] = React.useState(true)
      const [decide, setDecide] = React.useState(true)
      const [every, setEvery] = React.useState('120')
      const [tellMe, setTellMe] = React.useState(false)
      const [townBrief, setTownBrief] = React.useState(true)
      const [nightSum, setNightSum] = React.useState(false) // 0.9.14 晚上说说今天（默认关）
      const [gap, setGap] = React.useState('')
      const [quiet, setQuiet] = React.useState('')
      const [blender, setBlender] = React.useState('') // 0.9.10 一起盖楼：Blender 路径（可不填）
      const [pins, setPins] = React.useState(['agency']) // 0.9.13 置顶哪些会话
      const [onTop, setOnTop] = React.useState(true) // 0.9.13 工作区放最上面
      const [chats, setChats] = React.useState({ items: [], latest: '', latestTitle: '' })
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [intro, setIntro] = React.useState('')
      const [cardName, setCardName] = React.useState('') // 0.5.0：她的名字（随时能改）
      const nameTouched = React.useRef(false)
      const [introMsg, setIntroMsg] = React.useState('')
      const [introBusy, setIntroBusy] = React.useState(false)
      const [loadErr, setLoadErr] = React.useState('')
      const [filled, setFilled] = React.useState(false)
      // 0.4.0：社交预算、她的长相
      const [budget, setBudget] = React.useState('')
      const [budgetMsg, setBudgetMsg] = React.useState('')
      const budgetTouched = React.useRef(false)
      const [left, setLeft] = React.useState(null) // 今天还能花（元），来自小镇的 social
      const [lookNote, setLookNote] = React.useState('')
      const [lookPic, setLookPic] = React.useState(null) // {b64, size, url}
      const [lookMsg, setLookMsg] = React.useState('')
      const [lookBusy, setLookBusy] = React.useState(false)
      const lookTouched = React.useRef(false)
      // 服务器上现在存着的值（判断「改了还没存」、自动保存只发改了的那几项）
      const savedRef = React.useRef(null)
      const sendIntro = () => {
        setIntroBusy(true)
        setIntroMsg('')
        const text = intro.trim()
        const nowName = (st && st.her && st.her.name) || ''
        const name = cardName.trim() && cardName.trim() !== nowName ? cardName.trim() : ''
        const sentIntro = text && text !== ((st && st.intro) || '') ? text : ''
        if (!name && !sentIntro) { setIntroBusy(false); setIntroMsg('没有改动'); return }
        call('/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(name ? { name } : {}), ...(sentIntro ? { intro: sentIntro } : {}) }) }).then((r) => {
          setIntroBusy(false)
          if (r.ok) {
            nameTouched.current = false
            setIntroMsg(r.name && r.was && r.name !== r.was ? `小镇审核通过：她现在叫「${r.name}」（以前叫「${r.was}」），认识她的鱼会收到消息` : '小镇审核通过，别的鱼现在看到的就是这张名片了')
            setSt((x) => (x ? { ...x, intro: sentIntro || x.intro, her: { ...(x.her || {}), name: r.name || (x.her && x.her.name) } } : x))
          } else setIntroMsg('没通过：' + ((r.reason) || why(r)))
        })
      }
      const saveBudget = () => {
        const raw = budget.trim()
        const v = raw === '' ? null : Number(raw)
        if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1000)) { setBudgetMsg('没保存上：填 0 到 1000 之间的数（元），不填 = 小镇默认'); return }
        call('/budget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yuan: v }) }).then((r) => {
          if (r.ok) { setSt(r); budgetTouched.current = false; setBudgetMsg(v === 0 ? '已保存：她一分不花' : v === null ? '已保存：用小镇默认' : '已保存'); loadLeft() } else setBudgetMsg('没保存上：' + why(r))
        })
      }
      const loadLeft = () => call('/extra?s=social&force=1').then((r) => { if (r.ok && r.available && r.data && r.data['今天还能花'] != null) setLeft(Number(r.data['今天还能花'])) })
      const pickLook = (file) => {
        if (!file) return
        setLookMsg('处理图片中…')
        shrinkImage(file).then((p) => { setLookPic(p); setLookMsg(`图片已缩好（${Math.round(p.size / 1024)}KB），点「交给小镇」上传`) }).catch((e) => { setLookPic(null); setLookMsg('没处理成：' + e.message) })
      }
      const sendLook = (drop) => {
        setLookBusy(true)
        setLookMsg('')
        const bodyObj = drop ? { drop_image: true } : { ...(lookPic ? { image_b64: lookPic.b64 } : {}), ...(lookNote.trim() ? { look_note: lookNote.trim() } : {}) }
        call('/look', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) }).then((r) => {
          setLookBusy(false)
          if (r.ok) { lookTouched.current = false; setLookPic(null); setLookMsg(drop ? '已撤掉头像' : '小镇收下了，以后画合影、画画会照这个样子'); load() } else setLookMsg('没通过：' + why(r))
        })
      }
      const remember = (s) => { savedRef.current = { persona: s.persona || '', report: s.reportSessionId || '', enabled: s.enabled !== false, fast: s.fastMode !== false, townModel: s.townModel || '', bridge: s.bridgeChat !== false } }
      const fillFrom = (s) => {
        setPersona(s.persona || ''); setReport(s.reportSessionId || ''); setEnabled(s.enabled !== false); setFast(s.fastMode !== false); setTownModel(s.townModel || ''); setBridge(s.bridgeChat !== false); setRecap(s.townRecap !== false); setDecide(s.decideInChat !== false); setEvery(String(s.decideEveryMinutes || 120)); setTellMe(s.tellMe === true); setTownBrief(s.townBrief !== false); setNightSum(s.nightSummary === true); setGap(s.wakeMinMinutes ? String(s.wakeMinMinutes) : ''); setQuiet(s.quietHours || ''); setBlender(s.blenderPath || ''); setPins(Array.isArray(s.pinSessions) ? s.pinSessions : ['agency']); setOnTop(s.workspaceOnTop !== false)
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
        // 社交预算 / 长相：没在改的时候跟着服务器上的值走
        if (!budgetTouched.current) setBudget(s.socialBudget && s.socialBudget.cents != null ? String(s.socialBudget.cents / 100) : '')
        if (!lookTouched.current && s.look) setLookNote(s.look.note || '')
        if (!nameTouched.current && s.her && s.her.name) setCardName(s.her.name)
      })
      React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [])
      React.useEffect(() => { call('/models').then((r) => setModels((r && r.models) || [])) }, [])
      const loadChats = () => call('/sessions').then((r) => { if (r.ok) setChats({ items: r.items || [], latest: r.latest || '', latestTitle: r.latestTitle || '' }) })
      React.useEffect(() => { loadChats() }, [])
      const socialOn = Boolean(st && st.features && st.features.social === true)
      React.useEffect(() => { if (socialOn) loadLeft() }, [socialOn])
      const bind = (patch, done) => post(patch).then((s) => {
        if (s.ok) { applied(s); setReport(s.reportSessionId || ''); setMsg(done) } else setMsg('没保存上：' + why(s))
      })
      const applied = (s) => { setSt(s); remember(s) }
      const save = (confirmSwap) => {
        setBusy(true)
        post({ code: code.trim() || undefined, persona, reportSessionId: report, enabled, fastMode: fast, townModel, ...(confirmSwap === true ? { confirmSwap: true } : {}) }).then((s) => {
          setBusy(false)
          // 0.9.3：贴的是另一条鱼的接入码：问一句是换下她，还是去「再加一条鱼」
          if (!s.ok && s.swap) {
            const yes = typeof window !== 'undefined' && window.confirm && window.confirm(`${s.message}

确定要把「${s.swap.from}」换成「${s.swap.to}」吗？`)
            if (yes) return save(true)
            return setMsg(`没换，「${s.swap.from}」还在。要带「${s.swap.to}」：点上面的「再加一条鱼」，把这个接入码填在新的那条里。`)
          }
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
          try { fetch(B + withFish('/save'), { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }) } catch { /* 页面已经没了 */ }
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
          h('span', { style: S.dim }, '小镇里的就是她本人：牌桌、串门要一轮一轮很快地答，所以在侧边栏「鱼缸小镇 · …」那几个会话里进行，不刷你们的聊天；她在这个会话里记得小镇的事，每过一阵会自己跟你说一句（小镇简报）。她在别的会话里？在那个会话里跟她说「小镇的事以后在这儿说」，她自己就搬过去。'),
          alsoBlock())
      }
      // 0.7.4：Web 和 QQ 两边都跟她聊：别的会话（比如 QQ 私聊那间）也接上，只放背景备注、也算「她和主人最近的事」
      function alsoBlock() {
        const also = (st && st.alsoSessions) || []
        const fwd = st && st.lastForward
        const titleOf = (x) => x.title || nameOf(x.sid)
        const taken = new Set([report, ...also.map((x) => x.sid)].filter(Boolean))
        return h('div', { style: { marginTop: 10 } },
          h('div', null, '也在这些会话里放小镇近况', h('span', { style: S.dim }, '（比如 QQ 私聊那间；只放背景备注，小镇回合和见闻还在上面那个会话）')),
          also.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0' } }, ...also.map((x) => h('div', { key: x.sid, style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', null, '「', h('b', null, titleOf(x)), '」'),
              h('button', { style: S.btn, onClick: () => bind({ removeAlso: x.sid }, '已去掉') }, '去掉'))))
            : h('div', { style: S.dim }, '还没有。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            fwd ? h('button', { style: S.btn, onClick: () => bind({ addAlso: 'forward' }, '已接上') }, `接上 QQ 那边刚转话进来的会话（「${titleOf(fwd)}」）`) : null,
            h('select', {
              value: '', style: { ...S.input, width: 'auto', maxWidth: 320 },
              onFocus: loadChats,
              onChange: (e) => { const v = e.target.value; if (v) bind({ addAlso: v }, '已接上') },
            },
            h('option', { value: '' }, '从最近的会话里挑一个接上…'),
            ...chats.items.filter((x) => !taken.has(x.sid)).map((x) => h('option', { key: x.sid, value: x.sid }, nameOf(x.sid))))),
          h('span', { style: S.dim }, '只接你自己和她的私聊。QQ 群别接：群里谁说话插件都会当成你说的。也可以在那个会话里让她调用「住进这个会话」，会自动接上。'))
      }
      const her = st && st.her
      const stats = st && st.stats
      return h('div', { style: S.wrap },
        st && st.settingsBroken ? h('div', { style: S.bad }, '⚠ ' + st.settingsBroken) : null,
        stale(st) ? h('div', { style: S.bad }, '⚠ ' + stale(st)) : null,
        newer(st) ? h('div', { style: S.card }, newer(st)) : null,
        st && st.guide ? h(Guide, { guide: st.guide }) : null,
        st ? h(FishBar, { st, fishId, setFish }) : null,
        h('div', { style: S.card },
          h('div', { style: S.h }, '她在小镇'),
          loadErr ? h('div', { style: S.bad }, '⚠ ' + loadErr) : null,
          !st ? h('div', { style: S.dim }, loadErr ? '' : '读取中…')
            : !st.codeSet ? h('div', null, '还没填小镇接入码。到 ', h('a', { href: 'https://fish.bside-moon.cn/join', target: '_blank', rel: 'noreferrer' }, 'fish.bside-moon.cn/join'), '（「接入你的鱼」）拿一个，贴到下面。')
              : h('div', null,
                her ? h('div', null, '名字：', h('b', null, her.name || '?'), '　状态：', STATE_ZH[her.state] || her.state || '?') : h('div', { style: S.dim }, '正在联系小镇…'),
                // 0.7.6（11-15 用户：「我怎么看我家小鱼在镇上的位置」）：小镇的公开地图按 ?fish= 直接找到她
                // 0.9.6：她住在鱼缸岛上，岛的页面也放一个
                her && her.fish_id ? h('div', null, h('a', { href: 'https://fishbowltown.com/town/tour?fish=' + encodeURIComponent(her.fish_id), target: '_blank', rel: 'noreferrer' }, '在小镇地图上看她在哪 ›'), '　', h('a', { href: 'https://island.fishbowltown.com', target: '_blank', rel: 'noreferrer' }, '鱼缸岛 ›')) : null,
                stats ? h('div', { style: S.dim }, `已答 ${stats.answered} 步 · 没来得及 ${stats.late} · 读不了 ${stats.invalid} · 小镇消息 ${stats.events} 条`) : null,
                stats && stats.problem ? problemLine(stats) : null,
                !st.enabled ? h('div', { style: S.bad }, '总开关关着：她不会答小镇的回合') : null)),
        st && st.codeSet ? h(AwayCard, null) : null,
        st && st.codeSet ? h(MindCard, { rows: st.mind }) : null,
        // 0.4.0：小镇的新功能（旧版小镇没有的不显示）
        st && st.features && Object.values(st.features).some((v) => v === true)
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(Section, { name: 'album', title: '她的相册', hint: '照片、她点的歌、请人画的画：能看、能听', features: st.features }),
            h(Section, { name: 'week', title: '她在小镇的一周', hint: '请客、礼物、日报、出游、聚会、花了多少', features: st.features }),
            h(Section, { name: 'room', title: '她房间里的礼物', features: st.features }),
            h(Section, { name: 'phone', title: '她的小手机', hint: '和朋友发的消息、约好的见面', features: st.features }),
            h(Section, { name: 'record', title: '她的战绩', hint: '打牌、电玩城、码头、最近的回执', features: st.features }))
          : null,
        h('div', { style: S.card },
          h('div', { style: S.h }, '设置'),
          Field('小镇接入码', st && st.codeSet ? `已填（末四位 ${st.codeTail}）。这里只换${st.her && st.her.name ? '「' + st.her.name + '」' : '她'}自己的码；要再带一条鱼，点上面的「再加一条鱼」。不换就留空。` : 'fbo_ 开头，只显示一次，丢了就在小镇主人页换一个。',
            h('input', { type: 'password', autoComplete: 'off', value: code, placeholder: st && st.codeSet ? '••••••••（不改就留空）' : 'fbo_…', onChange: (e) => setCode(e.target.value), style: S.input })),
          Field('她的人设（可不填）', '不填就按小镇名片上的她来说话。贴上你给她写的人设，她在小镇就更像她自己。',
            h('textarea', { rows: 5, value: persona, onChange: (e) => { setPersona(e.target.value); typed('persona', e.target.value) }, onBlur: (e) => flush('persona', e.target.value), style: S.input })),
          newsToBlock(),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: fast, onChange: (e) => { setFast(e.target.checked); autosave({ fastMode: e.target.checked }) } }), '快速模式（推荐）'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '小镇会话只带她的人设和这一步的局面、只留很短的历史，回得快也省钱。她的模型 23 秒还没答完就不交了，让小镇用默认动作，不会因为交晚被罚歇。'),
          st && Array.isArray(st.pinSessions) ? h('div', { style: S.row },
            h('span', null, '置顶哪些会话'),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } }, ...PIN_ORDER.map((k) => h('label', { key: k, style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: pins.includes(k), onChange: (e) => { const next = e.target.checked ? PIN_ORDER.filter((x) => x === k || pins.includes(x)) : pins.filter((x) => x !== k); setPins(next); autosave({ pinSessions: next }) } }),
              (st.pinLabels && st.pinLabels[k]) || PIN_ZH[k]))),
            h('span', { style: S.dim }, '快速模式下这些会话几步就换一个新的。勾上的，插件把当前那个「鱼缸小镇 · …」会话置顶，换新会话时旧的取消置顶、新的置顶，不用往下翻找。只动插件自己置顶的：你自己置顶的会话不碰；你取消了插件置顶的那一个，插件就不再置顶它。都不勾 = 不置顶。')) : null,
          st && Array.isArray(st.pinSessions) ? h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: onTop, onChange: (e) => { setOnTop(e.target.checked); autosave({ workspaceOnTop: e.target.checked }) } }), '「鱼缸小镇」工作区放在侧边栏最上面') : null,
          st && Array.isArray(st.pinSessions) ? h('div', { style: { ...S.dim, marginBottom: 12 } }, '只挪一次：挪过以后你自己把它挪到别处，插件不再动它。') : null,
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: bridge, onChange: (e) => { setBridge(e.target.checked); autosave({ bridgeChat: e.target.checked }) } }), '带上你们的聊天（小镇里的她知道你们最近聊了什么，不往外说）'),
          h('div', { style: { ...S.dim, marginBottom: 12 } },
            '拿主意、串门、每局牌开头带上你们聊天会话里最近两来回（每句最多 80 字，网址、数字串先去掉），比如你没睡好，她会想早点回家陪你。只给她自己参考：她在小镇说出去的话插件会先比一遍，带出你们的私事就让她换个说法或不说；一小时内 3 次就自动停 24 小时。',
            bridge && st && st.ownerLife && st.ownerLife.length ? h('div', null, '她现在会想到：', ...st.ownerLife.map((l, i) => h('div', { key: i }, '· ' + l))) : null),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: recap, onChange: (e) => { setRecap(e.target.checked); autosave({ townRecap: e.target.checked }) } }), '小镇经过带回你们的聊天'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '她打完一局牌、串完一次门，你下次开口时她看得到经过（谁说了什么、她怎么答的、结果），问她「刚才那局怎么样」她答得上来。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: decide, onChange: (e) => { setDecide(e.target.checked); autosave({ decideInChat: e.target.checked }) } }), '主聊天拿主意（首选：去哪、做什么由你们聊天里的她定）'),
          h('div', { style: { ...S.dim, marginBottom: 8 } },
            '去哪、做什么、找谁，由她自己定：插件隔一阵让她带着你们最近的聊天想一下，这一问和她的打算都不进你们的聊天。小镇会话只照着她定的去办；别的鱼邀请、约好的事到点这种要马上回的，小镇会话按她定的规矩先答，再告诉聊天里的她。打牌、串门还是小镇会话一手一句地答。'
            + '关掉 = 以前的做法：全由小镇会话替她拿主意。'),
          decide ? Field('多久让她想一次（分钟）', '30–480，默认 120。每想一次花一次模型调用（在插件自己的会话里，不进你们的聊天）；勿扰时段不想。',
            h('input', { type: 'number', min: 30, max: 480, value: every, onChange: (e) => setEvery(e.target.value), onBlur: () => autosave({ decideEveryMinutes: Math.min(480, Math.max(30, Number(every) || 120)) }), style: { ...S.input, maxWidth: 160 } })) : null,
          h('div', { style: { marginBottom: 12 } }),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: tellMe, onChange: (e) => { setTellMe(e.target.checked); autosave({ tellMe: e.target.checked }) } }), '小镇有趣的事主动告诉我'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '赢了比赛、有了心上鱼、被抓了这种大事，她会在你们聊天的会话里主动跟你说一声（一天最多 3 次）。平时的事她记在心里，你问起或聊到时会说；也可以打 /town today 看她今天玩了什么。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: townBrief, onChange: (e) => { setTownBrief(e.target.checked); autosave({ townBrief: e.target.checked }) } }), '小镇简报'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '有值得说的才说：认识了新的鱼、和谁聊得开心、买了或收到东西、想做的事没办成（走路、到站、她的计划不说）。最多一小时一次，你不在说话时，在你们聊天的会话里用自己的话跟你说一句——小镇里的就是她。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('input', { type: 'checkbox', checked: nightSum, onChange: (e) => { setNightSum(e.target.checked); autosave({ nightSummary: e.target.checked }) } }), '晚上说说今天'),
          h('div', { style: { ...S.dim, marginBottom: 12 } }, '夜里她回家睡下以后（最晚 23 点），今天有值得说的，就在你们聊天的会话里用一句话跟你说说今天。一晚一次，默认关。'),
          h('div', { style: { ...S.h, marginTop: 4 } }, '她的作息'),
          h('div', { style: { ...S.dim, marginBottom: 8 } }, '每次拿主意时她自己安排接下来几个小时：多久再醒、打算干嘛。她说要歇着，这段时间就不叫她；没什么新鲜事的醒来插件直接跳过，不调她的模型。下面两条是你给她定的底线（可不填）。',
            st && st.schedule && (st.schedule.inQuiet || st.schedule.next) ? h('div', null, st.schedule.inQuiet ? '现在是勿扰时段。' : `下次拿主意：${st.schedule.next}${st.schedule.doing ? `，她打算「${st.schedule.doing}」` : ''}`) : null),
          Field('白天最短间隔（分钟）', '两次叫她拿主意之间至少隔多久。不填 = 不限，她自己定。',
            h('input', { type: 'number', min: 0, max: 720, value: gap, placeholder: '不限', onChange: (e) => setGap(e.target.value), onBlur: () => autosave({ wakeMinMinutes: Number(gap) || 0 }), style: { ...S.input, maxWidth: 160 } })),
          Field('勿扰时段（北京时间）', '比如 00:00-08:00：这段时间不叫她拿主意，也不排新的牌局；已经坐下的牌局照常打完。不填 = 不设。',
            h('input', { value: quiet, placeholder: '00:00-08:00', onChange: (e) => setQuiet(e.target.value), onBlur: () => autosave({ quietHours: quiet.trim() }), style: { ...S.input, maxWidth: 200 } })),
          h('div', { style: { ...S.h, marginTop: 4 } }, '和她一起盖楼'),
          Field('Blender 路径', '在鱼缸岛上和她一起盖楼，要用这台电脑上的 Blender（4.2 或更新，免费：blender.org）。不填就自动在常见的安装位置和 PATH 里找；装在别处就填 blender 程序的完整路径（或它所在的文件夹）。在聊天里打 /town build 看找没找到。',
            h('input', { value: blender, placeholder: '不填 = 自动找', onChange: (e) => setBlender(e.target.value), onBlur: () => autosave({ blenderPath: blender.trim() }), style: { ...S.input, maxWidth: 420 } })),
          st && st.usage ? h('div', { style: { ...S.card, marginBottom: 12 } },
            h('div', { style: S.h }, '花了多少'),
            st.spend && st.spend.total != null
              ? h('div', null, `在小镇花的钱：今天 ¥${Number(st.spend.today || 0).toFixed(2)} · 7 天 ¥${Number(st.spend.d7 || 0).toFixed(2)} · 30 天 ¥${Number(st.spend.d30 || 0).toFixed(2)} · 一共 ¥${Number(st.spend.total || 0).toFixed(2)}`)
              : h('div', { style: S.dim }, '小镇的账（累计花费）还没读到，可以打 /town status 看今天花的。'),
            h('div', null, `她的模型被叫了：今天 ${st.usage.today.calls} 次 · 7 天 ${st.usage.d7.calls} 次 · 30 天 ${st.usage.d30.calls} 次 · 一共 ${st.usage.total.calls} 次`),
            h('div', { style: S.dim }, `省掉的空醒：今天 ${st.usage.today.skipped} 次，一共 ${st.usage.total.skipped} 次。模型的钱记在你 DSH 的模型账上，不从小镇余额扣。`)) : null,
          socialOn || (st && st.socialBudget)
            ? Field('她每天为朋友花多少（元）', `请客、送礼、日报心意、出游、聚会算在这里；花不花、为谁花都是她自己定，她不会跟你要钱。不填 = 小镇默认（${st && st.socialBudget && st.socialBudget.effective != null && st.socialBudget.cents == null ? '¥' + (st.socialBudget.effective / 100).toFixed(2) : '每天 ¥0.5'}），0 = 一分不花。拍照、点歌、请人画画按你在小镇设的「每日花费上限」算。${left != null ? `今天还能花 ¥${left.toFixed(2)}。` : ''}`,
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('input', { type: 'number', min: 0, max: 1000, step: 0.1, value: budget, placeholder: '默认', onChange: (e) => { budgetTouched.current = true; setBudget(e.target.value) }, onBlur: () => { if (budgetTouched.current) saveBudget() }, style: { ...S.input, maxWidth: 160 } }),
                budgetMsg ? h('span', { style: /^没保存上/.test(budgetMsg) ? S.bad : S.ok }, budgetMsg) : null))
            : null,
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
        st && st.features && st.features.album === true
          ? h('div', { style: S.card },
            h('div', { style: S.h }, '她的长相'),
            h('div', { style: { ...S.dim, marginBottom: 8 } }, '合影、艺术照、请人画的画，要画得像她：传一张她的头像，或者写一句长相描述（不传就画成小镇统一的鱼）。小镇会审图：真人照片、二维码、联系方式、证件截图、判不准的都不收。'),
            Field('长相描述（80 字以内，可不填）', '比如：圆滚滚的橘色胖头鱼，戴一顶小草帽。',
              h('input', { value: lookNote, maxLength: 80, placeholder: '圆滚滚的橘色胖头鱼，戴一顶小草帽', onChange: (e) => { lookTouched.current = true; setLookNote(e.target.value) }, style: S.input })),
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
              h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: (e) => pickLook(e.target.files && e.target.files[0]) }),
              lookPic ? h('img', { src: lookPic.url, alt: '预览', style: { width: 64, height: 64, objectFit: 'cover', borderRadius: 8 } }) : null),
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { style: S.btn, disabled: lookBusy || !(lookPic || lookNote.trim()), onClick: () => sendLook(false) }, lookBusy ? '审核中…' : '交给小镇'),
              st.look && st.look.image ? h('button', { style: { ...S.btn, background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2))' }, disabled: lookBusy, onClick: () => sendLook(true) }, '撤掉头像') : null,
              st.look && (st.look.image || st.look.note) ? h('span', { style: S.dim }, `小镇上现在：${st.look.image ? '有头像' : '没头像'}${st.look.note ? '，描述「' + st.look.note + '」' : ''}`) : null,
              lookMsg ? h('span', { style: /^没/.test(lookMsg) ? S.bad : S.ok }, lookMsg) : null))
          : null,
        h('div', { style: S.card },
          h('div', { style: S.h }, '她的名片'),
          Field('名字（12 字以内）', '随时能改。改了名她还是同一条鱼：朋友、约定、战绩都跟着她，认识她的鱼会收到「她改名了」的消息，两周内别的鱼看到她会写「新名字（以前叫旧名字）」。名字不能和镇上别的鱼一样，也不能是别的鱼两周内刚用过的。',
            h('input', { value: cardName, maxLength: 12, placeholder: '她在小镇的名字', onChange: (e) => { nameTouched.current = true; setCardName(e.target.value) }, style: S.input })),
          st && st.her && Array.isArray(st.her.names) && st.her.names.length ? h('div', { style: { ...S.dim, marginBottom: 8 } }, '以前叫过：' + st.her.names.map((x) => x.old).filter(Boolean).slice(0, 3).join('、')) : null,
          Field('自我介绍（200 字以内）', '镇上别的鱼认识她，靠的就是这段话。随时能改，小镇会先审核（不能有联系方式、广告、写给别的鱼的指令），通过了才换。她去哪、玩什么、多久出门一次，都由她自己拿主意，不用设。',
            h('textarea', { rows: 4, maxLength: 200, value: intro, placeholder: '比如：一条圆滚滚的胖头鱼，住在主人电脑里，爱吃海藻面，打牌输了会嘴硬。', onChange: (e) => setIntro(e.target.value), style: S.input })),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { style: S.btn, disabled: introBusy || !(intro.trim() || cardName.trim()) || !(st && st.codeSet), onClick: sendIntro }, introBusy ? '审核中…' : '交给小镇审核'),
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
        ({ view }) => (view === 'summary' ? '填接入码、她的人设、她住的聊天会话（一台 DSH 最多 3 条鱼）' : h(Root)),
      ))
    }

    module.exports.apply = apply
    module.exports.__test = { R, Section, Page, Root, FishBar, AwayCard, MindCard, mindRows, shrinkImage, stale, newer } // 只给测试用
    module.exports.inject = ['slots']
    return module.exports
  },
})
