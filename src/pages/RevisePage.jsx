import { useEffect, useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatJSON } from '../lib/llm.js'
import { reviewMessages, versionMessages, VERSION_ANGLES } from '../lib/prompts.js'
import { copyText, downloadText, countWords, mapLimit } from '../lib/utils.js'
// 第4组 路S2（件A）：文风取料口收敛到跨页单一出处 resolveStyleRec（与写正文/段级重写/全书润色/单章重写同一个）。
//   本页是独立路由页（App.jsx 直接渲染），没有父级持有全量混合池 ⟹ 按任务书件A 硬要求2 的处置②，
//   用页面既有的取数口自己取一次**全量**池（预置五本 + 全部用户蒸馏档），而不是只取选中的那一份。
import { getAll } from '../lib/db.js'
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { resolveStyleRec } from '../lib/longform.js'

// 5.3：题材来源——useLibrary 暴露 genre（localStorage 持久化；绑定的书会用其文风档案里存的 genre）。
// 下面 resolveStyleRec 第三参传 lib.genre，genreSkinOf 据此映射主导嗓音；选「不限」时回落默认嗓音（行为同改造前）。
// M20：续写页(ContinuePage)已删除文风块（不再解析/注入文风、不消费 genre，改由 continueMessages 的 CONTINUE_STYLE_HINT 直接参照原文风格），
//   故 genre 现仅本页（改写润色）消费；原「两页喂同一份池、嗓音一致」的对照说明已随续写页文风块(effectiveStyle/stylePool)移除而失效，删去。

// H10：改写页草稿的 localStorage 键（原文 + 点评/4版本结果），刷新/切 tab 不丢
const REVISE_DRAFT_KEY = 'na_revise_draft'

// P1-14：原文指纹（长度 + 首尾各 16 字）——把「点评/4 版本」结果与产出它的那份原文绑定。
//   用户改了原文后，旧结果不再对应当前原文；指纹不匹配就灰显 + 提示，避免把针对旧原文的改写当成当前原文的结果。
const textFp = (s) => {
  const t = String(s == null ? '' : s)
  return `${t.length}:${t.slice(0, 16)}:${t.slice(-16)}`
}

// item2（第十轮）：result「毒丸草稿」防护——chatJSON→extractJSON 不做类型归一，模型把 revised_text/title/review/suggestions
//   返成数组/对象时，直接渲染会抛「Objects are not valid as a React child」→ 整页落 PageErrorBoundary；而 result 已写进 localStorage(:96)，
//   刷新/切回持续崩、错误边界「回到改写页」再崩，用户只能「清空小说与档案」逃生。载入(草稿)与生成(运行时)两处 setResult 前统一 String() 归一各字段。
//   与 item10 的结构校验合并到此：非对象→null；needRevision→布尔；versions 非数组→[]；元素字段一律 String() 归一（对象会成「[object Object]」，丑但不崩、可重生成）。
const sanitizeResult = (r) => {
  if (!r || typeof r !== 'object') return null
  const str = (v) => (v == null ? '' : String(v))
  const versions = Array.isArray(r.versions)
    ? r.versions
        .map((v) =>
          v && typeof v === 'object'
            ? {
                ...v,
                title: str(v.title),
                revised_text: str(v.revised_text),
                suggestions: Array.isArray(v.suggestions)
                  ? v.suggestions.map((s) => (s && typeof s === 'object' ? { point: str(s.point), reason: str(s.reason) } : { point: str(s), reason: '' }))
                  : [],
              }
            : null,
        )
        .filter(Boolean)
    : []
  return { ...r, needRevision: !!r.needRevision, review: str(r.review), versions }
}

export default function RevisePage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  // H10：原文 + 结果(点评/4版本)从 localStorage 恢复——原先零持久化，App 条件渲染切走即卸载、刷新丢失已烧 token 的 4 版本
  // L：草稿只 JSON.parse 一次（原来 text/result/resultFp 三个 useState 各解析同一个 key 三次）
  const [draftSnapshot] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(REVISE_DRAFT_KEY) || 'null')
    } catch {
      return null
    }
  })
  const [text, setText] = useState(() => (draftSnapshot && typeof draftSnapshot.text === 'string' ? draftSnapshot.text : ''))
  // item10+item2：草稿里的 result 可能是旧结构/损坏（缺 versions 数组）或「毒丸」（revised_text/title/review 是数组/对象）——载入时统一过 sanitizeResult
  //   （结构校验 + 各字段 String() 归一），避免 :296/:335 直接 result.versions.length 抛 TypeError、或渲染非字符串抛「Objects are not valid as a React child」
  //   → 整页落 PageErrorBoundary 且随 localStorage(:96) 刷新/切回持续崩。needRevision 为真但 versions 空时正好走"没产出有效版本，请重试"提示而非崩溃。
  const [result, setResult] = useState(() => sanitizeResult(draftSnapshot && draftSnapshot.result)) // {needRevision, review, versions}
  // P1-14：产出当前 result 时的原文指纹（与 result 成对持久化/恢复）
  const [resultFp, setResultFp] = useState(() => (draftSnapshot && typeof draftSnapshot.resultFp === 'string' ? draftSnapshot.resultFp : ''))
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [versionProgress, setVersionProgress] = useState(0)
  const [err, setErr] = useState('')
  // 5.1：发送前提示词确认（人在环路）。点"生成"先弹窗展示将发送的【点评】+【4 个改写方向】提示词，可查看/编辑，确认后才真正发送（保留各自 temperature / jsonMode / 并发，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, groups: [{ label, messages }], proceed }
  const timerRef = useRef(null)
  // M-A：生成的中断句柄 + 挂载标记——切 tab 卸载后，点评 + 4 版本(并发)若继续跑会白烧额度、并对已卸载组件 setState。
  const genCtrlRef = useRef(null)
  const mountedRef = useRef(true)
  const copyTimersRef = useRef([]) // L：复制提示的 1.5s 复位定时器集合，卸载时统一清（原来直接改 btn.textContent + 裸 setTimeout，卸载后仍会触发）
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      genCtrlRef.current?.abort()
      clearInterval(timerRef.current)
      copyTimersRef.current.forEach((t) => clearTimeout(t))
      copyTimersRef.current = []
    }
  }, [])
  // 全量文风混合池（= 长篇页 libStyles 的同形构造）。为什么本页必须自己取一次：混合池的内容要与主路**逐字相同**，
  //   而主路传的是「预置五本 + 全部用户蒸馏档」；只传预置、或只传选中的那一份，跨源 habits 配额与禁用词并集的
  //   分母就变了（四种池的四格差异实测见 scripts/p4s2_style_converge/probe_a.mjs §C）。useLibrary 只按 selectedId
  //   取单份档，拿不到全量 ⟹ 这里补一次全量读取，构造表达式与 LongFormPage/WizardPage 逐字同形（钉住不许漂移）。
  // 依赖 lib.style：作者刚在本页「分析文风」或改了禁用词时，库里那份记录是新的 ⟹ 重读一次，
  //   否则新档案不在池里、resolveStyleRec 会把它当「未命中」而回落到预置聚合档。
  const [stylePool, setStylePool] = useState([])
  useEffect(() => {
    let cancelled = false
    getAll('styles')
      .then((list) => { if (!cancelled) setStylePool([...PRESET_STYLES, ...list.filter((s) => s && s.profile)]) })
      .catch(() => { if (!cancelled) setStylePool([]) }) // 读不到库 ⟹ 池留空 ⟹ 下面四格全落空值（失效方向保守）
    return () => { cancelled = true }
  }, [lib.style])

  useEffect(() => () => clearInterval(timerRef.current), [])

  // H10：text/result 变化后防抖落 localStorage（改写片段 + 4 版本通常远小于 5MB 配额；超配额/隐私模式静默跳过，不影响本次使用）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(REVISE_DRAFT_KEY, JSON.stringify({ text, result, resultFp }))
      } catch {
        /* 存储不可用：草稿存不下不影响本次改写 */
      }
    }, 500)
    return () => clearTimeout(t)
  }, [text, result, resultFp])
  // H10 flush 兜底：防抖有 500ms 窗口，切 tab 卸载 / pagehide 时若正好落在窗口内会丢最后一段编辑 → 用 ref 存最新草稿，unmount 与 pagehide 各立即落盘一次
  const reviseDraftRef = useRef({ text, result, resultFp })
  useEffect(() => {
    reviseDraftRef.current = { text, result, resultFp }
  }, [text, result, resultFp])
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(REVISE_DRAFT_KEY, JSON.stringify(reviseDraftRef.current))
      } catch {
        /* 存储不可用：忽略 */
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush() // 卸载(切 tab)时立即落盘，兜住防抖窗口内的最后编辑
    }
  }, [])

  // 带一次"格式错误自动降温度重试"的 JSON 调用
  const callJSON = async (messages, temp, signal) => {
    try {
      return await chatJSON({ apiKey, messages, temperature: temp, signal })
    } catch (e) {
      if (/格式/.test(e?.message)) return await chatJSON({ apiKey, messages, temperature: 0.3, signal })
      throw e
    }
  }

  // 5.1：点"生成 4 个修改版本"先弹确认窗，展示将发送的【点评】+【4 个改写方向】提示词，用户查看/编辑后再真正发送。
  // 文风取料仍走跨页单一出处 resolveStyleRec（绑定 id 传选中档案 bookId、池传全量、genre 传 lib.genre；失效方向保守：池未读到则四格全空）。
  const generate = () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 10) {
      setErr('请先粘贴一段需要修改的小说片段（至少几十字）。')
      return
    }
    setErr('')
    const styleRec = stylePool.length ? resolveStyleRec(lib.style?.bookId ?? '', stylePool, lib.genre) : null
    const style = styleRec?.profile || ''
    const forbidden = styleRec?.forbidden || []
    const samples = styleRec?.samples || []
    const habits = styleRec?.habits || []
    const groups = [
      { label: '第 1 步 · 点评原文（判断是否需要修改）', messages: reviewMessages({ text }) },
      ...VERSION_ANGLES.map((angle, i) => ({
        label: `第 2 步 · 版本${i + 1}（${angle.title}）`,
        messages: versionMessages({ style, habits, forbidden, samples, text, index: i }),
      })),
    ]
    setPromptConfirm({ title: `AI 修改（点评 + ${VERSION_ANGLES.length} 个版本）`, groups, proceed: runGenerate })
  }

  // 用户确认提示词后真正执行：先点评，若判定需修改再按 4 个方向并发（各自 temperature 不变；用编辑后的提示词）
  const runGenerate = async (groups) => {
    setPromptConfirm(null)
    setLoading(true)
    // L7：生成中不再 setResult(null)——保留上次 result 直到新结果到达；否则"生成中切 tab"会被 H10 的 unmount flush 把 null 落盘、永久覆盖掉上次的 4 版本(与 M18 意图相悖)
    setVersionProgress(0)
    setElapsed(0)
    // M-A：本次生成的中断句柄——卸载时 abort，点评 + 4 版本(并发)不再后台空跑烧额度
    const ctrl = new AbortController()
    genCtrlRef.current = ctrl
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    try {
      // 第一步：点评 + 判断是否需要修改（独立一次请求）
      const reviewRes = await callJSON(groups[0].messages, 0.4, ctrl.signal)
      const needRevision = reviewRes.need_revision !== false
      const review = reviewRes.review || ''
      let versions = []

      // 第二步：四个版本各自独立生成，各自带明确且不同的改写方向，避免四版雷同
      if (needRevision) {
        const items = groups.slice(1).map((g, i) => ({ g, angle: VERSION_ANGLES[i], i }))
        const results = await mapLimit(items, 2, async ({ g, angle, i }) => {
          try {
            const r = await callJSON(g.messages, angle.temp, ctrl.signal)
            return {
              title: r.title || angle.title,
              revised_text: r.revised_text || '',
              suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
            }
          } catch (e) {
            return { error: e?.message || String(e), title: angle.title } // 第11轮[10]：非 Error 抛出时 e.message 为 undefined，兜底成字符串
          } finally {
            if (mountedRef.current) setVersionProgress((p) => p + 1)
          }
        })
        versions = results.filter((r) => !r.error && r.revised_text)
        const failed = results.filter((r) => r.error)
        if (!mountedRef.current) return // M-A：已卸载，丢弃结果不上屏
        // M18：全 4 版都失败时不要再报"已展示成功版本"(实际 0 版、版本区不渲染会误导)，单独给明确文案
        if (results.length > 0 && failed.length === results.length) {
          setErr(`${VERSION_ANGLES.length} 个版本全部生成失败：${failed.map((f) => f.title).join('、')}。请检查 API Key / 余额 / 网络后重试。`)
        } else if (failed.length) {
          setErr(`有 ${failed.length} 个版本生成失败：${failed.map((f) => f.title).join('、')}，已展示成功版本。`)
        }
      }

      if (!mountedRef.current) return // M-A：已卸载，丢弃结果不上屏
      setResult(sanitizeResult({ needRevision, review, versions })) // item2：运行时也归一——AI 把 revised_text/title/review 返成数组/对象时不崩、且写进 localStorage 的不是毒丸
      setResultFp(textFp(text)) // P1-14：记下这份结果对应的原文指纹（text 为发提示词时的原文，确认弹窗期间原文不可改）
    } catch (e) {
      if (!mountedRef.current) return
      if (e?.name === 'AbortError') return // M-A：卸载中断，不报错、不上屏
      setErr(e?.message || String(e)) // 第11轮[10]：非 Error 抛出时 e.message 为 undefined，界面会完全不提示——兜底成字符串
      // L7/M18：生成中已保留旧 result(未 setResult(null))，失败不动它 → 旧点评/版本自然还在，既不会丢新结果也不会被 null 覆盖旧结果
    } finally {
      genCtrlRef.current = null
      clearInterval(timerRef.current)
      if (mountedRef.current) {
        setLoading(false)
        setVersionProgress(0)
      }
    }
  }

  const copy = async (t, btn) => {
    // 尾批[2]：copyText 返回 true/false（clipboard 不可用且 execCommand 也失败时为 false）——原来不看返回值恒显「已复制 ✓」是假成功
    const ok = await copyText(t)
    if (btn) {
      btn.textContent = ok ? '已复制 ✓' : '复制失败✗'
      const tid = setTimeout(() => {
        btn.textContent = '复制'
        copyTimersRef.current = copyTimersRef.current.filter((x) => x !== tid)
      }, 1500)
      copyTimersRef.current.push(tid)
    }
  }

  // P1-14：当前原文与「产出这份结果的原文」指纹不一致 = 结果对应修改前的原文（用户改了原文但没重新生成）
  const resultStale = !!result && resultFp !== textFp(text)

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} />

        <div className="min-w-0 space-y-4">
          {/* 原文输入 */}
          <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold"><Ic n="pencil" /> 粘贴要修改的片段</h2>
              {/* P1-15：徽标加 stylePool.length>0——getAll('styles') 失败时 stylePool=[]、resolveStyleRec 返回 null（四格全空、实际没贴合任何文风），
                  原条件只看 selectedBook&&style 会照样显「已贴合文风」，是假承诺 */}
              {/* item8：再加 profile 非空门控——空 profile 的书其档案被 stylePool 过滤掉(:78 只收 s.profile 非空)、resolveStyleRec 回落预置聚合(style.js:126)，
                  此时生效的是预置基调而非本书文风；原条件只看 lib.style 真值会假报「已贴合《书名》文风」（P1-15 只补了 stylePool=[] 一路，漏了空 profile 这一路）。
                  profile 为空时改显中性「预置基调」提示，不冒领本书专属文风（贴合本项目「提示词透明」范式：给真实信号而非隐藏）。 */}
              {lib.selectedBook && stylePool.length > 0 && !!String(lib.style?.profile || '').trim() && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">已贴合《{lib.selectedBook.title || lib.selectedBook.name}》文风</span>
              )}
              {lib.selectedBook && stylePool.length > 0 && lib.style && !String(lib.style.profile || '').trim() && (
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">本书暂无专属文风档案，当前用预置基调</span>
              )}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="把需要修改的小说片段粘贴到这里…"
              rows={8}
              className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={generate}
                disabled={loading}
                className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {loading ? `AI 修改中… ${elapsed} 秒` : `生成 ${VERSION_ANGLES.length} 个修改版本`}
              </button>
              <span className="text-xs text-stone-400">预计耗时 1 ~ 3 分钟</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
            {loading && (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
                {versionProgress > 0 ? `已完成 ${versionProgress} / ${VERSION_ANGLES.length} 个版本…` : '正在点评原文…'}
              </div>
            )}
          </section>

          {/* 诊断看板：梳理片段的故事线与节奏问题（含伏笔是否收太早） */}
          {/* item20：cacheKey 复用 textFp（长度+首尾各16字）——原 `${text.length}_${text.slice(0,16)}` 只含长度+头部，
              等长同头改尾的两份原文会命中同一缓存、拿到旧诊断。纳入尾部指纹后尾部改动即换键。前缀仍是 na_diag_rev_（DiagnosePanel 的同类清理按前3段判定，不受影响）。 */}
          {text && <DiagnosePanel apiKey={apiKey} text={text} disabled={loading} cacheKey={`na_diag_rev_${textFp(text)}`} />}

          {/* P1-14：原文已改、结果还是旧原文的——明确提示并灰显，避免把针对修改前原文的点评/版本当成当前原文的结果 */}
          {resultStale && (
            <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-800"><Ic n="notepad" /> 下面的点评与版本对应「修改前」的原文</p>
              <p className="mt-1 text-xs text-amber-700">{`你改动了原文但还没重新生成。这些结果已灰显，仅供参考；点「生成 ${VERSION_ANGLES.length} 个修改版本」按当前原文重跑。`}</p>
            </section>
          )}

          {/* 无需修改的提示 */}
          {result && !result.needRevision && (
            <section className={`rounded-2xl border border-emerald-200 bg-emerald-50 p-5 ${resultStale ? 'opacity-50' : ''}`}>
              <p className="text-sm font-semibold text-emerald-800"><Ic n="clap" /> 这一段写得很好，AI 认为不需要修改</p>
              <p className="mt-1 text-xs text-emerald-700/80">以下是 AI 给出的详细点评，见下方点评区。</p>
            </section>
          )}

          {/* 四个版本卡片 */}
          {result && result.needRevision && result.versions.length > 0 && (
            <section className={`grid gap-4 sm:grid-cols-2 ${resultStale ? 'opacity-50' : ''}`}>
              {result.versions.map((v, i) => (
                <article key={i} className="glass-card flex flex-col rounded-2xl bg-paper shadow-sm">
                  <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                    <h3 className="text-sm font-bold">{v.title || `版本${i + 1}`}</h3>
                    <div className="flex gap-2">
                      <button onClick={(e) => copy(v.revised_text || '', e.target)} className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50">
                        复制
                      </button>
                      <button
                        onClick={() => downloadText(`${v.title || `版本${i + 1}`}.txt`, v.revised_text || '')}
                        className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                      >
                        导出
                      </button>
                    </div>
                  </header>
                  <div className="novel-text max-h-64 overflow-y-auto px-4 py-3 text-sm whitespace-pre-wrap">{v.revised_text}</div>
                  {Array.isArray(v.suggestions) && v.suggestions.length > 0 && (
                    <footer className="mt-auto rounded-b-2xl border-t border-stone-100 bg-stone-50 px-4 py-3">
                      <p className="text-xs font-semibold text-stone-500">修改建议与原因</p>
                      <ul className="mt-1.5 space-y-1.5">
                        {v.suggestions.map((s, j) => (
                          <li key={j} className="text-xs leading-relaxed text-stone-600">
                            <span className="font-medium text-ink">{s.point}</span>
                            {s.reason && <span className="text-stone-400"> —— {s.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    </footer>
                  )}
                </article>
              ))}
            </section>
          )}

          {/* 尾批[2]：判定需修改、但 4 个版本都没产出有效正文（revised_text 全空、又没报错）——原来这块什么都不渲染，
              用户只看到「需要修改」却没有任何版本、也没有解释。补一条明确提示，引导重试。 */}
          {result && result.needRevision && result.versions.length === 0 && (
            <section className={`rounded-2xl border border-amber-200 bg-amber-50 p-5 ${resultStale ? 'opacity-50' : ''}`}>
              <p className="text-sm font-semibold text-amber-800">AI 判定需要修改，但这次没产出有效的改写版本</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-700">{`${VERSION_ANGLES.length} 个版本返回的正文都为空（可能被截断或模型未给出内容）。请点「生成 ${VERSION_ANGLES.length} 个修改版本」重试；若反复如此，检查 API 余额 / 网络，或缩短原文后再试。`}</p>
            </section>
          )}

          {/* 底部点评区：无论是否需要修改都展示 */}
          {result && result.review && (
            <section className={`rounded-2xl border border-amber-100 bg-amber-50 p-5 ${resultStale ? 'opacity-50' : ''}`}>
              <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900">
                <Ic n="notepad" /> AI 写作点评
              </h3>
              <p className="novel-text mt-2 text-sm leading-relaxed whitespace-pre-wrap text-amber-900/90">{result.review}</p>
            </section>
          )}
        </div>
      </div>
      {promptConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          // P1-16：已编辑过提示词则遮罩不响应——避免误点遮罩一下就把改过的 5 组提示词全丢（与 PromptEditorModal C1 / DiagnosePanel / RanksPage 统一口径）。✕ 与「取消」仍可关（是明确操作）。
          onClick={() => { if (!promptConfirm.edited) setPromptConfirm(null) }}
          role="dialog"
          aria-modal="true"
          aria-label={promptConfirm.title}
        >
          <div className="flex max-h-[88vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词{promptConfirm.edited ? '（已编辑）' : ''}</span>
              <button onClick={() => setPromptConfirm(null)} className="text-stone-400 hover:text-stone-700" aria-label="关闭">✕</button>
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {promptConfirm.groups.map((g, gi) => (
                <div key={gi} className="space-y-2">
                  <div className="text-xs font-bold text-stone-700">{g.label}</div>
                  {g.messages.map((m, mi) => (
                    <div key={mi}>
                      <div className="mb-1 text-[11px] font-medium text-stone-500">{m.role === 'system' ? 'System（角色与规则）' : 'User（本次发送内容）'}</div>
                      <textarea
                        value={m.content}
                        rows={m.role === 'system' ? 5 : 9}
                        onChange={(e) =>
                          setPromptConfirm((p) => {
                            const groups = p.groups.slice()
                            const msgs = groups[gi].messages.slice()
                            msgs[mi] = { ...msgs[mi], content: e.target.value }
                            groups[gi] = { ...groups[gi], messages: msgs }
                            return { ...p, groups, edited: true }
                          })
                        }
                        className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-[13px] leading-relaxed focus:border-stone-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <span className="mr-auto text-[11px] text-stone-400">{`点评先发；若判定需修改，再按上面 ${VERSION_ANGLES.length} 个方向并发生成（各自 temperature 不变）。`}</span>
              <button onClick={() => setPromptConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">取消</button>
              <button onClick={() => promptConfirm.proceed(promptConfirm.groups)} disabled={loading} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50">确认并发送</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
