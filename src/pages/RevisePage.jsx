import { useEffect, useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatJSON } from '../lib/llm.js'
import { reviewMessages, versionMessages, VERSION_ANGLES } from '../lib/prompts.js'
import { copyText, downloadText, countWords, mapLimit } from '../lib/utils.js'

export default function RevisePage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  const [text, setText] = useState('')
  const [result, setResult] = useState(null) // {need_revision, review, versions}
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [versionProgress, setVersionProgress] = useState(0)
  const [err, setErr] = useState('')
  const timerRef = useRef(null)

  useEffect(() => () => clearInterval(timerRef.current), [])

  // 带一次"格式错误自动降温度重试"的 JSON 调用
  const callJSON = async (messages, temp) => {
    try {
      return await chatJSON({ apiKey, messages, temperature: temp })
    } catch (e) {
      if (/格式/.test(e.message)) return await chatJSON({ apiKey, messages, temperature: 0.3 })
      throw e
    }
  }

  const generate = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 10) {
      setErr('请先粘贴一段需要修改的小说片段（至少几十字）。')
      return
    }
    setErr('')
    setLoading(true)
    setResult(null)
    setVersionProgress(0)
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)

    const style = lib.style?.profile
    const forbidden = lib.style?.forbidden
    const samples = lib.style?.samples || []
    try {
      // 第一步：点评 + 判断是否需要修改（独立一次请求）
      const reviewRes = await callJSON(reviewMessages({ text }), 0.4)
      const needRevision = reviewRes.need_revision !== false
      const review = reviewRes.review || ''
      let versions = []

      // 第二步：四个版本各自独立生成，各自带明确且不同的改写方向，避免四版雷同
      if (needRevision) {
        const items = VERSION_ANGLES.map((angle, i) => ({ angle, i }))
        const results = await mapLimit(items, 2, async ({ angle, i }) => {
          try {
            const r = await callJSON(versionMessages({ style, forbidden, samples, text, index: i }), angle.temp)
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
        if (failed.length) {
          setErr(`有 ${failed.length} 个版本生成失败：${failed.map((f) => f.title).join('、')}，已展示成功版本。`)
        }
      }

      setResult({ needRevision: needRevision, review, versions })
    } catch (e) {
      setErr(e.message)
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
          <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold"><Ic n="pencil" /> 粘贴要修改的片段</h2>
              {lib.selectedBook && lib.style && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">已贴合《{lib.selectedBook.name}》文风</span>
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
                {versionProgress > 0 ? `正在生成第 ${versionProgress} / 4 个版本…` : '正在点评原文…'}
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
                <article key={i} className="flex flex-col rounded-2xl bg-[#fbf8ef] shadow-sm">
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
                            <span className="font-medium text-stone-800">{s.point}</span>
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
    </div>
  )
}
