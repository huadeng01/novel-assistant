import { useEffect, useMemo, useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import { loadRanks, ranksSummary, generatedLabel, gendersOf, listsByGender } from '../lib/ranks.js'
import { chatJSON, writerConfig } from '../lib/llm.js'
import { rankInsightMessages } from '../lib/prompts.js'

// 榜单区（顶栏「榜单」页）：展示各平台【热门榜快照】（内置静态数据，非实时）。
// 数据来自同源静态 public/ranks.json（M22：原抓取脚本 scripts/fetch-ranks.mjs 已随项目精简移除、快照不再每日更新；实际快照日期见页内 generatedLabel），
// 本页运行时【不发起任何跨域抓取】——只显示最新元数据；点击书名 → 外链跳转平台官方阅读页，
// 本应用不存储、不展示、不缓存任何正文章节（合规红线）。

const RANK_STYLE = {
  1: 'bg-amber-500 text-white',
  2: 'bg-stone-400 text-white',
  3: 'bg-amber-700/75 text-white',
}

// P1-17：AI 故事偏向分析结果按「平台:频道:榜单下标」缓存到 localStorage——RankInsight 组件按这个 key 重挂载，
//   原来切榜单 / 切 tab 即丢已烧 token 的分析；缓存后切回来直接回读，不必重跑。
const INSIGHT_PREFIX = 'na_rank_insight_'
// 必修6（第十一轮·毒丸第3处，同型 item2 RevisePage / 必修A DiagnosePanel）：RankInsight 结果归一。
//   readInsight 原来只校验 presence（books/overview/genres 存在），不校验元素字段类型；AI 把 overview 返对象、或 genres[]/books[] 元素的
//   genre/count/title/orientation/synopsis 返对象/数组时，直接渲染（:428/:439/:450…）会抛「Objects are not valid as a React child」→ 整页落 PageErrorBoundary；
//   且结果已写 localStorage(:33) → 每次进该榜单持续崩、只能清数据逃生。（item25 的 `||''`/`||0` 只兜 undefined/falsy，兜不住 truthy 的对象/数组。）
//   对象/数组归空（既防崩、又不显「[object Object]」），字符串/数字保留；新鲜结果、写缓存前、缓存回读三处都过。
const insightStr = (v) => (v == null ? '' : typeof v === 'object' ? '' : String(v))
const sanitizeInsight = (d) => {
  if (!d || typeof d !== 'object') return null
  const arr = (v) => (Array.isArray(v) ? v : [])
  return {
    ...d,
    overview: insightStr(d.overview),
    genres: arr(d.genres).map((g) => (g && typeof g === 'object' ? { ...g, genre: insightStr(g.genre), count: Number(g.count) || 0, note: insightStr(g.note) } : null)).filter(Boolean),
    books: arr(d.books).map((b) => (b && typeof b === 'object' ? { ...b, title: insightStr(b.title), orientation: insightStr(b.orientation), synopsis: insightStr(b.synopsis) } : null)).filter(Boolean),
  }
}
const readInsight = (cacheKey) => {
  if (!cacheKey) return null
  try {
    const d = JSON.parse(localStorage.getItem(INSIGHT_PREFIX + cacheKey) || 'null')
    return d && (Array.isArray(d.books) || d.overview || Array.isArray(d.genres)) ? sanitizeInsight(d) : null // 必修6：缓存回读也归一（防本修复前写入的毒丸缓存）
  } catch {
    return null
  }
}
const writeInsight = (cacheKey, data) => {
  if (!cacheKey) return
  try {
    localStorage.setItem(INSIGHT_PREFIX + cacheKey, JSON.stringify(data))
  } catch {
    /* 存储不可用 / 配额满：缓存存不下不影响本次分析 */
  }
}

export default function RanksPage() {
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  const [active, setActive] = useState('') // 当前选中平台 id
  const [gender, setGender] = useState('全部') // 当前频道过滤：全部 / 男频 / 女频
  const [listIdx, setListIdx] = useState(0) // 当前频道内选中的榜单下标

  const fetchRanks = (signal) => {
    setState((s) => ({ ...s, loading: true }))
    return loadRanks(signal).then((r) => {
      if (r.error === 'aborted') return null
      // RP13：刷新失败(r.data=null)时保留已加载的榜单，只把 error 透出——原来直接 data:r.data 会把榜单清空退回错误态
      setState((s) => ({ loading: false, data: r.data ?? s.data, error: r.ok ? '' : r.error }))
      return r.data
    })
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetchRanks(ctrl.signal).then((data) => {
      if (data && data.sources.length) {
        const firstOk = data.sources.find((s) => s.ok) || data.sources[0]
        setActive((prev) => prev || firstOk.platform)
      }
    })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 第11轮[12]：手动「刷新」原来调 fetchRanks() 不传 signal——切走/卸载后请求回来仍 setState（更新已卸载组件）。
  //   用 ref 存本次刷新的 controller，卸载时 abort；再次点刷新先 abort 上一次，避免并发刷新互相覆盖。
  const refreshCtrlRef = useRef(null)
  useEffect(() => () => refreshCtrlRef.current?.abort(), [])
  const manualRefresh = () => {
    refreshCtrlRef.current?.abort()
    const ctrl = new AbortController()
    refreshCtrlRef.current = ctrl
    fetchRanks(ctrl.signal)
  }

  const summary = useMemo(() => ranksSummary(state.data), [state.data])
  const source = useMemo(
    () => (state.data ? state.data.sources.find((s) => s.platform === active) || null : null),
    [state.data, active],
  )
  // 当前平台实际存在的频道（男频/女频/全部）：>1 才显示频道过滤条（单一频道无需过滤）。
  const platformGenders = useMemo(() => gendersOf(source), [source])
  // 按当前频道过滤后的榜单集合（listIdx 在此集合内取值）。
  const visLists = useMemo(() => (source && source.ok ? listsByGender(source, gender) : []), [source, gender])
  // P2：切换频道后 visLists 可能变短，listIdx 会越界——用夹取后的有效下标同时驱动「取哪条榜单」与「哪个 tab 高亮」，
  //   原来 list 夹取了、高亮却用裸 listIdx，越界时榜单显示着却没有任何 tab 高亮。
  const effListIdx = visLists.length ? Math.min(listIdx, visLists.length - 1) : 0
  const list = visLists.length ? visLists[effListIdx] : null
  // P2：generatedLabel 原来在同一行 JSX 里算两次，这里算一次复用
  const snapLabel = state.data ? generatedLabel(state.data) : ''

  const selectPlatform = (id) => { setActive(id); setGender('全部'); setListIdx(0) }
  const selectGender = (g) => { setGender(g); setListIdx(0) }

  return (
    <div className="space-y-4">
      {/* 头部：标题 + 快照时间 + 概览 + 刷新 */}
      <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
              <span className="text-amber-600"><Ic n="flame" /></span>
              各平台热门榜快照
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">
              聚合主流网文平台的公开榜单快照，帮你快速看清风向、找灵感。
              {snapLabel ? ` 数据快照：${snapLabel}` : ''}
            </p>
          </div>
          <button
            onClick={manualRefresh}
            disabled={state.loading}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 px-3.5 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            <span className={state.loading ? 'animate-spin' : ''}><Ic n="rolling" /></span>
            刷新
          </button>
        </div>
        {state.data && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Chip icon="globe">{summary.okCount} 个平台有数据</Chip>
            <Chip icon="notepad">{state.data.sources.reduce((n, s) => n + (s.ok && Array.isArray(s.lists) ? s.lists.length : 0), 0)} 个榜单</Chip>
            <Chip icon="library">{summary.bookCount} 本上榜</Chip>
            {summary.failCount > 0 && <Chip icon="ban">{summary.failCount} 个平台今日不可用</Chip>}
          </div>
        )}
        {state.data?.note && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
            {state.data.note}
          </p>
        )}
      </section>

      {/* 加载 / 错误 / 空态 */}
      {state.loading && !state.data && (
        <section className="glass-card rounded-2xl bg-paper p-10 text-center text-sm text-stone-400 shadow-sm">
          <span className="mr-2 inline-block animate-spin align-[-0.125em]"><Ic n="rolling" /></span>
          正在加载榜单快照…
        </section>
      )}
      {!state.loading && state.error && !state.data && (
        <section className="glass-card rounded-2xl bg-paper p-10 text-center shadow-sm">
          <p className="text-sm text-stone-500"><Ic n="alert" className="mr-1 text-amber-600" />{state.error}</p>
          <p className="mt-2 text-xs leading-relaxed text-stone-400">
            榜单为内置快照，可能已过期；原抓取脚本已随项目精简移除，如需更新请替换 public/ranks.json 里的快照数据。
          </p>
        </section>
      )}

      {/* P2（补 RP13）：刷新失败但保留了上次数据时，错误原来被 `!state.data` 挡掉、用户看不到——给一条非阻断提示，
          别让人以为当前是最新快照。首屏就失败(无数据)仍走上面的整块错误态。 */}
      {!state.loading && state.error && state.data && (
        <p className="mb-3 rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <Ic n="alert" className="mr-1 align-[-0.125em]" />刷新失败（{state.error}）；当前显示的是上次成功加载的榜单快照。
        </p>
      )}

      {/* 平台切换 + 榜单 */}
      {state.data && state.data.sources.length > 0 && (
        <>
          <nav className="glass-card flex gap-2 overflow-x-auto rounded-2xl bg-paper p-3 shadow-sm">
            {state.data.sources.map((s) => (
              <button
                key={s.platform}
                onClick={() => selectPlatform(s.platform)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm transition-colors ${
                  active === s.platform ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-600 hover:bg-stone-50'
                }`}
              >
                {!s.ok && <span className={active === s.platform ? 'text-stone-400' : 'text-stone-300'}><Ic n="ban" /></span>}
                {s.platformName}
              </button>
            ))}
          </nav>

          {/* item25：source=null（active 未匹配任何平台——初始未选中 / 刷新后 active 指向已不存在的平台 / 挂载 fetch 被 abort 未自动选中）时，
              nav 有按钮但无选中、下面三个内容分支(source&&!ok / source&&ok / insight)全不渲染 ⟹ 正文全空且无提示。补一条显式引导。 */}
          {!source && (
            <section className="glass-card rounded-2xl bg-paper p-8 text-center shadow-sm">
              <p className="text-sm text-stone-500">
                <Ic n="alert" className="mr-1 text-amber-600" />
                请在上方选择一个平台查看榜单
              </p>
            </section>
          )}

          {source && !source.ok && (
            <section className="glass-card rounded-2xl bg-paper p-8 text-center shadow-sm">
              <p className="text-sm text-stone-500">
                <Ic n="ban" className="mr-1 text-stone-400" />
                {source.platformName} 今日不可用
              </p>
              {source.error && <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-stone-400">{source.error}</p>}
              {source.home && (
                <a href={source.home} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-amber-700 hover:underline">
                  前往 {source.platformName} 官网 <Ic n="globe" />
                </a>
              )}
            </section>
          )}

          {source && source.ok && (
            <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
              {/* 频道过滤（全部 / 男频 / 女频）——仅当该平台有 >1 个频道时显示 */}
              {platformGenders.length > 1 && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="mr-0.5 text-xs text-stone-400"><Ic n="user" /> 频道</span>
                  {platformGenders.map((g) => (
                    <button
                      key={g}
                      onClick={() => selectGender(g)}
                      className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
                        g === gender ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-500 hover:bg-stone-50'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              )}
              {/* 多榜单子切换（热门/新书/完结等；已按当前频道过滤） */}
              {visLists.length > 1 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {visLists.map((l, i) => (
                    <button
                      key={l.listId + i}
                      onClick={() => setListIdx(i)}
                      className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                        i === effListIdx ? 'bg-amber-600 text-white' : 'border border-stone-200 text-stone-500 hover:bg-stone-50'
                      }`}
                    >
                      {l.listName}{l.category && l.category !== '全部' && l.category !== l.listName && !l.listName.startsWith(l.category) ? ` · ${l.category}` : ''}
                      {gender === '全部' && l.gender && l.gender !== '全部' ? <span className="ml-1 opacity-70">· {l.gender}</span> : ''}
                    </button>
                  ))}
                </div>
              )}
              {list && list.books.length > 0 ? (
                <ul className="space-y-2">
                  {list.books.map((b) => (
                    <BookRow key={b.rank + b.title} book={b} />
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-xs text-stone-400">该榜单暂无数据。</p>
              )}
            </section>
          )}

          {/* 底部：AI 故事偏向分析（针对当前平台当前榜单；切换平台/榜单用 key 重置状态） */}
          {source && source.ok && list && list.books.length > 0 && (
            <RankInsight
              key={source.platform + ':' + gender + ':' + effListIdx}
              cacheKey={source.platform + ':' + gender + ':' + effListIdx}
              platformName={source.platformName}
              listName={`${list.gender && list.gender !== '全部' ? list.gender + '·' : ''}${list.listName}`}
              books={list.books}
            />
          )}
        </>
      )}

      {/* 合规声明 */}
      <p className="px-2 text-center text-[11px] leading-relaxed text-stone-400">
        只显示最新榜单快照（书名 / 作者 / 简介等公开元数据）；点击书名跳转平台官方阅读页。
        本应用不抓取、不存储、不展示任何正文章节，尊重各平台 robots 协议与版权。
      </p>
    </div>
  )
}

function Chip({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-paper/60 px-2.5 py-1 text-stone-500">
      <Ic n={icon} className="text-stone-400" />
      {children}
    </span>
  )
}

function BookRow({ book }) {
  const badge = RANK_STYLE[book.rank] || 'bg-stone-100 text-stone-500'
  const inner = (
    <>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${badge}`}>{book.rank}</span>
      {book.cover ? (
        <img src={book.cover} alt="" loading="lazy" className="h-14 w-10 shrink-0 rounded-md object-cover shadow-sm" />
      ) : (
        <span className="flex h-14 w-10 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-300"><Ic n="book" /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-medium text-ink">{book.title}</span>
          {book.author && <span className="text-xs text-stone-400">{book.author}</span>}
          {book.category && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">{book.category}</span>}
          {book.extra?.status && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{book.extra.status}</span>}
          {book.extra?.wordCount && <span className="text-[10px] text-stone-400">{book.extra.wordCount}</span>}
        </span>
        {book.intro && <span className="mt-1 block truncate text-xs leading-relaxed text-stone-500">{book.intro}</span>}
      </span>
      <span className="shrink-0 self-center text-stone-300"><Ic n="globe" /></span>
    </>
  )
  const cls = 'flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-paper/50 p-3 text-left transition-colors hover:border-amber-300 hover:bg-amber-50/40'
  return (
    <li>
      {book.officialUrl ? (
        <a href={book.officialUrl} target="_blank" rel="noopener noreferrer" className={cls} title={`在官方站点查看《${book.title}》`}>
          {inner}
        </a>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  )
}
function RankInsight({ platformName, listName, books, cacheKey = '' }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // P1-17：初值从 localStorage 回读（组件按 cacheKey 重挂载，切回本榜即恢复上次分析，不重烧 token）
  const [data, setData] = useState(() => readInsight(cacheKey))
  const [fromCache, setFromCache] = useState(() => !!data) // L：复用上一行已算出的 data，不再二次 readInsight（二次 JSON.parse）
  // 5.1：发送前提示词确认（人在环路）。点"分析本榜"先弹窗展示将发送的 system+user，可查看/编辑，确认后才真正发 chatJSON（保留 jsonMode / temperature 0.5）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, messages, proceed }
  // 尾批[6]：切榜单/切 tab 时本组件按 key 重挂载——旧实例在跑的 chatJSON 若不中断会继续烧额度、并对已卸载组件 setState。
  const abortRef = useRef(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const analyze = async (messages) => {
    if (!writerConfig().key) {
      setErr('尚未配置 API Key：请先到「我的」页面填写通义千问或 DeepSeek 密钥，再来分析榜单。')
      return
    }
    setBusy(true)
    setErr('')
    setPromptConfirm(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await chatJSON({ messages, temperature: 0.5, signal: ctrl.signal })
      if (!mountedRef.current) return // 尾批[6]：已卸载/已切榜，丢弃结果不上屏
      if (!res || (!Array.isArray(res.books) && !res.overview)) {
        setErr('AI 返回的内容格式不正确，请点「重新分析」重试。')
      } else {
        const clean = sanitizeInsight(res) // 必修6：归一后再上屏 + 落缓存——毒丸（对象/数组字段）既不进 state 也不进 localStorage，避免刷新/切回持续崩
        setData(clean)
        setFromCache(false)
        writeInsight(cacheKey, clean) // P1-17：落缓存，切榜单/切 tab 再回来不丢
      }
    } catch (e) {
      if (!mountedRef.current) return
      if (e?.name === 'AbortError') return // 卸载中断：不报错、不上屏
      setErr((e && e.message) || '分析失败，请稍后重试。')
    } finally {
      abortRef.current = null
      if (mountedRef.current) setBusy(false)
    }
  }

  // 点"分析本榜"：先组装将发送的提示词并弹确认窗，用户查看/编辑后再走 analyze（不直接发送）
  const openConfirm = () => {
    if (!writerConfig().key) {
      setErr('尚未配置 API Key：请先到「我的」页面填写通义千问或 DeepSeek 密钥，再来分析榜单。')
      return
    }
    setErr('')
    setPromptConfirm({
      title: `AI 故事偏向分析 · ${platformName}${listName ? ' ' + listName : ''}`,
      messages: rankInsightMessages({ platformName, listName, books }),
      proceed: analyze,
    })
  }

  const genres = data && Array.isArray(data.genres) ? data.genres : []
  const items = data && Array.isArray(data.books) ? data.books : []

  return (
    <>
    <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="text-amber-600"><Ic n="sparkle" /></span>
          AI 故事偏向分析 · {platformName}{listName ? ' ' + listName : ''}
        </h3>
        <button
          onClick={openConfirm}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-stone-800 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-50"
        >
          <span className={busy ? 'animate-spin' : ''}><Ic n={busy ? 'rolling' : 'sparkle'} /></span>
          {busy ? '分析中…' : data ? '重新分析' : '分析本榜'}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-stone-400">
        基于本榜 {books.length} 本书的公开元数据（题材 / 简介），由 AI 归纳整榜故事偏向，并逐本提炼故事梗概。不联网、不杜撰元数据之外的情节。
      </p>
      {/* P1-17：回读的是上次缓存的分析（非本次新跑）——如实标注，榜单快照未变时无需重烧 token */}
      {data && fromCache && !busy && (
        <p className="mt-1 text-[11px] text-stone-400"><Ic n="box" /> 这是上次分析的缓存结果（切走再切回不丢）；榜单未变无需重跑，点「重新分析」可刷新。</p>
      )}

      {!busy && !err && !data && (
        <p className="mt-3 rounded-xl bg-stone-100 px-4 py-3 text-xs text-stone-500">
          点击右上「分析本榜」，AI 将解读这一批上榜小说的故事偏向与梗概。
        </p>
      )}
      {busy && (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="mr-1.5 inline-block animate-spin align-[-0.125em]"><Ic n="rolling" /></span>
          正在分析「{platformName}」榜单的故事偏向…
        </p>
      )}
      {err && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-700">{err}</p>}

      {data && !busy && (
        <div className="mt-3 space-y-3">
          {data.overview && (
            <div className="rounded-xl border border-stone-200 bg-paper/60 p-3">
              <p className="text-xs font-semibold text-stone-700">整榜故事偏向</p>
              <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-stone-600">{data.overview}</p>
            </div>
          )}
          {genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {genres.map((g, i) => (
                <span
                  key={i}
                  title={g.note || ''}
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-paper/60 px-2.5 py-1 text-[11px] text-stone-600"
                >
                  <span className="font-medium text-stone-700">{g.genre || ''}</span>
                  <span className="text-amber-700">{g.count || 0}本</span>
                  {g.note && <span className="text-stone-400">· {g.note}</span>}
                </span>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((b, i) => (
                <li key={i} className="rounded-xl border border-stone-200 bg-paper/50 p-3">
                  <p className="text-xs font-semibold text-ink">{i + 1}. {b.title || '未命名'}</p>
                  {b.orientation && (
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-900">
                      <span className="mr-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">偏向</span>
                      {b.orientation}
                    </p>
                  )}
                  {b.synopsis && (
                    <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
                      <span className="mr-1 rounded bg-stone-100 px-1 py-0.5 text-[10px] font-medium text-stone-500">梗概</span>
                      {b.synopsis}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
    {promptConfirm && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
        // P1-16：已编辑过提示词则遮罩不响应，避免误点丢掉改过的提示词（与 RevisePage / DiagnosePanel / PromptEditorModal C1 统一）
        onClick={() => { if (!promptConfirm.edited) setPromptConfirm(null) }}
        role="dialog"
        aria-modal="true"
        aria-label={promptConfirm.title}
      >
        <div className="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
            <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词{promptConfirm.edited ? '（已编辑）' : ''}</span>
            <button onClick={() => setPromptConfirm(null)} className="text-stone-400 hover:text-stone-700" aria-label="关闭">✕</button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {promptConfirm.messages.map((m, i) => (
              <div key={i}>
                <div className="mb-1 text-xs font-medium text-stone-500">{m.role === 'system' ? 'System（角色与规则）' : 'User（本次发送内容）'}</div>
                <textarea
                  value={m.content}
                  rows={m.role === 'system' ? 6 : 12}
                  onChange={(e) =>
                    setPromptConfirm((p) => {
                      const ms = p.messages.slice()
                      ms[i] = { ...ms[i], content: e.target.value }
                      return { ...p, messages: ms, edited: true }
                    })
                  }
                  className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-[13px] leading-relaxed focus:border-stone-500 focus:outline-none"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
            <button onClick={() => setPromptConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">取消</button>
            <button onClick={() => promptConfirm.proceed(promptConfirm.messages)} disabled={busy} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50">确认并发送</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
