import { useEffect, useMemo, useState } from 'react'
import Ic from '../components/Ic.jsx'
import { loadRanks, ranksSummary, generatedLabel, gendersOf, listsByGender } from '../lib/ranks.js'
import { chatJSON, writerConfig } from '../lib/llm.js'
import { rankInsightMessages } from '../lib/prompts.js'

// 榜单区（顶栏「榜单」页）：展示各平台【每日热门榜快照】。
// 数据来自同源静态 public/ranks.json（由 scripts/fetch-ranks.mjs 每日抓取生成），
// 本页运行时【不发起任何跨域抓取】——只显示最新元数据；点击书名 → 外链跳转平台官方阅读页，
// 本应用不存储、不展示、不缓存任何正文章节（合规红线，见 docs/榜单抓取_GitHubActions_交接文档.md）。

const RANK_STYLE = {
  1: 'bg-amber-500 text-white',
  2: 'bg-stone-400 text-white',
  3: 'bg-amber-700/75 text-white',
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
      setState({ loading: false, data: r.data, error: r.ok ? '' : r.error })
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

  const summary = useMemo(() => ranksSummary(state.data), [state.data])
  const source = useMemo(
    () => (state.data ? state.data.sources.find((s) => s.platform === active) || null : null),
    [state.data, active],
  )
  // 当前平台实际存在的频道（男频/女频/全部）：>1 才显示频道过滤条（单一频道无需过滤）。
  const platformGenders = useMemo(() => gendersOf(source), [source])
  // 按当前频道过滤后的榜单集合（listIdx 在此集合内取值）。
  const visLists = useMemo(() => (source && source.ok ? listsByGender(source, gender) : []), [source, gender])
  const list = visLists.length ? visLists[Math.min(listIdx, visLists.length - 1)] : null

  const selectPlatform = (id) => { setActive(id); setGender('全部'); setListIdx(0) }
  const selectGender = (g) => { setGender(g); setListIdx(0) }

  return (
    <div className="space-y-4">
      {/* 头部：标题 + 快照时间 + 概览 + 刷新 */}
      <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold text-stone-800">
              <span className="text-amber-600"><Ic n="flame" /></span>
              各平台每日热门榜
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">
              聚合主流网文平台的公开榜单快照，帮你快速看清风向、找灵感。
              {state.data && generatedLabel(state.data) ? ` 数据快照：${generatedLabel(state.data)}` : ''}
            </p>
          </div>
          <button
            onClick={() => fetchRanks()}
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
        <section className="rounded-2xl bg-[#fbf8ef] p-10 text-center text-sm text-stone-400 shadow-sm">
          <span className="mr-2 inline-block animate-spin align-[-0.125em]"><Ic n="rolling" /></span>
          正在加载榜单快照…
        </section>
      )}
      {!state.loading && state.error && !state.data && (
        <section className="rounded-2xl bg-[#fbf8ef] p-10 text-center shadow-sm">
          <p className="text-sm text-stone-500"><Ic n="alert" className="mr-1 text-amber-600" />{state.error}</p>
          <p className="mt-2 text-xs leading-relaxed text-stone-400">
            运行 <code className="rounded bg-stone-100 px-1 py-0.5">node scripts/fetch-ranks.mjs</code> 生成快照，或等待 GitHub Actions 每日定时抓取。
          </p>
        </section>
      )}

      {/* 平台切换 + 榜单 */}
      {state.data && state.data.sources.length > 0 && (
        <>
          <nav className="flex gap-2 overflow-x-auto rounded-2xl bg-[#fbf8ef] p-3 shadow-sm">
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

          {source && !source.ok && (
            <section className="rounded-2xl bg-[#fbf8ef] p-8 text-center shadow-sm">
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
            <section className="rounded-2xl bg-[#fbf8ef] p-4 shadow-sm">
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
                        i === listIdx ? 'bg-amber-600 text-white' : 'border border-stone-200 text-stone-500 hover:bg-stone-50'
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
              key={source.platform + ':' + gender + ':' + listIdx}
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
    <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white/60 px-2.5 py-1 text-stone-500">
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
          <span className="truncate text-sm font-medium text-stone-800">{book.title}</span>
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
  const cls = 'flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-white/50 p-3 text-left transition-colors hover:border-amber-300 hover:bg-amber-50/40'
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
function RankInsight({ platformName, listName, books }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [data, setData] = useState(null)

  const analyze = async () => {
    if (!writerConfig().key) {
      setErr('尚未配置 API Key：请先到「我的」页面填写通义千问或 DeepSeek 密钥，再来分析榜单。')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await chatJSON({ messages: rankInsightMessages({ platformName, listName, books }), temperature: 0.5 })
      if (!res || (!Array.isArray(res.books) && !res.overview)) {
        setErr('AI 返回的内容格式不正确，请点「重新分析」重试。')
      } else {
        setData(res)
      }
    } catch (e) {
      setErr((e && e.message) || '分析失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const genres = data && Array.isArray(data.genres) ? data.genres : []
  const items = data && Array.isArray(data.books) ? data.books : []

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-stone-800">
          <span className="text-amber-600"><Ic n="sparkle" /></span>
          AI 故事偏向分析 · {platformName}{listName ? ' ' + listName : ''}
        </h3>
        <button
          onClick={analyze}
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
            <div className="rounded-xl border border-stone-200 bg-white/60 p-3">
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
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white/60 px-2.5 py-1 text-[11px] text-stone-600"
                >
                  <span className="font-medium text-stone-700">{g.genre}</span>
                  <span className="text-amber-700">{g.count}本</span>
                  {g.note && <span className="text-stone-400">· {g.note}</span>}
                </span>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((b, i) => (
                <li key={i} className="rounded-xl border border-stone-200 bg-white/50 p-3">
                  <p className="text-xs font-semibold text-stone-800">{i + 1}. {b.title || '未命名'}</p>
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
  )
}
