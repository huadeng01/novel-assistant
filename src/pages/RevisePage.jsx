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
//   用页面既有的取数口自己取一次**全量**池（预置六本 + 全部用户蒸馏档），而不是只取选中的那一份。
import { getAll } from '../lib/db.js'
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { resolveStyleRec } from '../lib/longform.js'

// 5.3：题材来源——useLibrary 暴露 genre（localStorage 持久化；绑定的书会用其文风档案里存的 genre）。
// 下面 resolveStyleRec 第三参传 lib.genre，genreSkinOf 据此映射主导嗓音；选「不限」时回落默认嗓音（行为同改造前）。
// M20：续写页(ContinuePage)已删除文风块（不再解析/注入文风、不消费 genre，改由 continueMessages 的 CONTINUE_STYLE_HINT 直接参照原文风格），
//   故 genre 现仅本页（改写润色）消费；原「两页喂同一份池、嗓音一致」的对照说明已随续写页文风块(effectiveStyle/stylePool)移除而失效，删去。

// H10：改写页草稿的 localStorage 键（原文 + 点评/4版本结果），刷新/切 tab 不丢
const REVISE_DRAFT_KEY = 'na_revise_draft'

export default function RevisePage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  // H10：原文 + 结果(点评/4版本)从 localStorage 恢复——原先零持久化，App 条件渲染切走即卸载、刷新丢失已烧 token 的 4 版本
  const [text, setText] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem(REVISE_DRAFT_KEY) || 'null')
      return d && typeof d.text === 'string' ? d.text : ''
    } catch {
      return ''
    }
  })
  const [result, setResult] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem(REVISE_DRAFT_KEY) || 'null')
      return (d && d.result) || null // {need_revision, review, versions}
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [versionProgress, setVersionProgress] = useState(0)
  const [err, setErr] = useState('')
  // 5.1：发送前提示词确认（人在环路）。点"生成"先弹窗展示将发送的【点评】+【4 个改写方向】提示词，可查看/编辑，确认后才真正发送（保留各自 temperature / jsonMode / 并发，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, groups: [{ label, messages }], proceed }
  const timerRef = useRef(null)
  // 全量文风混合池（= 长篇页 libStyles 的同形构造）。为什么本页必须自己取一次：混合池的内容要与主路**逐字相同**，
  //   而主路传的是「预置六本 + 全部用户蒸馏档」；只传预置、或只传选中的那一份，跨源 habits 配额与禁用词并集的
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
        localStorage.setItem(REVISE_DRAFT_KEY, JSON.stringify({ text, result }))
      } catch {
        /* 存储不可用：草稿存不下不影响本次改写 */
      }
    }, 500)
    return () => clearTimeout(t)
  }, [text, result])

  // 带一次"格式错误自动降温度重试"的 JSON 调用
  const callJSON = async (messages, temp) => {
    try {
      return await chatJSON({ apiKey, messages, temperature: temp })
    } catch (e) {
      if (/格式/.test(e.message)) return await chatJSON({ apiKey, messages, temperature: 0.3 })
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
    setPromptConfirm({ title: 'AI 修改（点评 + 4 个版本）', groups, proceed: runGenerate })
  }

  // 用户确认提示词后真正执行：先点评，若判定需修改再按 4 个方向并发（各自 temperature 不变；用编辑后的提示词）
  const runGenerate = async (groups) => {
    setPromptConfirm(null)
    const prevResult = result // M18：暂存旧结果，失败时回填，避免"一次失败连上次生成的 4 版本也消失"
    setLoading(true)
    setResult(null)
    setVersionProgress(0)
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    try {
      // 第一步：点评 + 判断是否需要修改（独立一次请求）
      const reviewRes = await callJSON(groups[0].messages, 0.4)
      const needRevision = reviewRes.need_revision !== false
      const review = reviewRes.review || ''
      let versions = []

      // 第二步：四个版本各自独立生成，各自带明确且不同的改写方向，避免四版雷同
      if (needRevision) {
        const items = groups.slice(1).map((g, i) => ({ g, angle: VERSION_ANGLES[i], i }))
        const results = await mapLimit(items, 2, async ({ g, angle, i }) => {
          try {
            const r = await callJSON(g.messages, angle.temp)
            return {
              title: r.title || angle.title,
              revised_text: r.revised_text || '',
              suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
            }
          } catch (e) {
            return { error: e.message, title: angle.title }
          } finally {
            setVersionProgress((p) => p + 1)
          }
        })
        versions = results.filter((r) => !r.error && r.revised_text)
        const failed = results.filter((r) => r.error)
        // M18：全 4 版都失败时不要再报"已展示成功版本"(实际 0 版、版本区不渲染会误导)，单独给明确文案
        if (results.length > 0 && failed.length === results.length) {
          setErr(`4 个版本全部生成失败：${failed.map((f) => f.title).join('、')}。请检查 API Key / 余额 / 网络后重试。`)
        } else if (failed.length) {
          setErr(`有 ${failed.length} 个版本生成失败：${failed.map((f) => f.title).join('、')}，已展示成功版本。`)
        }
      }

      setResult({ needRevision: needRevision, review, versions })
    } catch (e) {
      setErr(e.message)
      setResult(prevResult) // M18：整体失败时恢复上次的点评/版本，不让用户既丢新结果又丢旧结果
    } finally {
      setLoading(false)
      setVersionProgress(0)
      clearInterval(timerRef.current)
    }
  }

  const copy = async (t, btn) => {
    await copyText(t)
    if (btn) {
      btn.textContent = '已复制 ✓'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
  }

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
              {lib.selectedBook && lib.style && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">已贴合《{lib.selectedBook.title || lib.selectedBook.name}》文风</span>
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
                {loading ? `AI 修改中… ${elapsed} 秒` : '生成 4 个修改版本'}
              </button>
              <span className="text-xs text-stone-400">预计耗时 1 ~ 3 分钟</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
            {loading && (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
                {versionProgress > 0 ? `已完成 ${versionProgress} / 4 个版本…` : '正在点评原文…'}
              </div>
            )}
          </section>

          {/* 诊断看板：梳理片段的故事线与节奏问题（含伏笔是否收太早） */}
          {text && <DiagnosePanel apiKey={apiKey} text={text} disabled={loading} cacheKey={`na_diag_rev_${text.length}_${text.slice(0, 16)}`} />}

          {/* 无需修改的提示 */}
          {result && !result.needRevision && (
            <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="text-sm font-semibold text-emerald-800"><Ic n="clap" /> 这一段写得很好，AI 认为不需要修改</p>
              <p className="mt-1 text-xs text-emerald-700/80">以下是 AI 给出的详细点评，见下方点评区。</p>
            </section>
          )}

          {/* 四个版本卡片 */}
          {result && result.needRevision && result.versions.length > 0 && (
            <section className="grid gap-4 sm:grid-cols-2">
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

          {/* 底部点评区：无论是否需要修改都展示 */}
          {result && result.review && (
            <section className="rounded-2xl border border-amber-100 bg-amber-50 p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900">
                <Ic n="notepad" /> AI 写作点评
              </h3>
              <p className="novel-text mt-2 text-sm leading-relaxed whitespace-pre-wrap text-amber-900/90">{result.review}</p>
            </section>
          )}
        </div>
      </div>
      {promptConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={() => setPromptConfirm(null)}>
          <div className="flex max-h-[88vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词</span>
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
                            return { ...p, groups }
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
              <span className="mr-auto text-[11px] text-stone-400">点评先发；若判定需修改，再按上面 4 个方向并发生成（各自 temperature 不变）。</span>
              <button onClick={() => setPromptConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">取消</button>
              <button onClick={() => promptConfirm.proceed(promptConfirm.groups)} disabled={loading} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50">确认并发送</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
