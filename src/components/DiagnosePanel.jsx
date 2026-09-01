// 全局诊断看板：让 AI 对已有内容做一次"体检"——梳理故事线、诊断节奏（含伏笔是否收太早）、给出建议
// 四个 tab（长篇 / 新手 / 续写 / 改写）复用；调用方负责把要诊断的内容组装进 text
import { useEffect, useState } from 'react'
import Ic from './Ic.jsx'
import { chatJSON } from '../lib/llm.js'
import { diagnoseMessages } from '../lib/prompts.js'

const LIMIT = 16000 // 诊断输入上限，避免超长文本撑爆上下文

export default function DiagnosePanel({ apiKey, text, context, disabled, cacheKey }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const [fromCache, setFromCache] = useState(false)

  // 结果缓存：同一内容状态（如章节数未变）下直接读本地缓存，避免重复消耗 API；点“重新诊断”强制刷新并写回缓存
  useEffect(() => {
    let c = null
    if (cacheKey) {
      try {
        c = JSON.parse(localStorage.getItem(cacheKey))
      } catch {
        c = null
      }
    }
    setResult(c?.result || null)
    setFromCache(!!c?.result)
  }, [cacheKey])

  const run = async () => {
    if (!apiKey || !text) return
    setErr('')
    setBusy(true)
    setResult(null)
    try {
      const res = await chatJSON({
        apiKey,
        messages: diagnoseMessages({ text: String(text).slice(0, LIMIT), context }),
        temperature: 0.3,
      })
      setResult(res)
      setFromCache(false)
      if (cacheKey) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), result: res }))
        } catch {
          /* 缓存写失败不影响诊断结果 */
        }
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const storylines = Array.isArray(result?.storylines) ? result.storylines : []
  const paceIssues = Array.isArray(result?.pace_issues) ? result.pace_issues : []
  const hooks = Array.isArray(result?.foreshadows) ? result.foreshadows : []
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : []

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold"><Ic n="doctor" /> AI 全局诊断看板</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            梳理现有故事线、诊断节奏问题（进程过快 / 伏笔收得太早 / 事件密度过高），并给出写作建议。
          </p>
        </div>
        <button
          onClick={run}
          disabled={busy || disabled || !text}
          className="rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? 'AI 诊断中…' : result ? '重新诊断' : '开始诊断'}
        </button>
      </div>
      {fromCache && result && (
        <p className="mt-2 text-xs text-stone-400"><Ic n="box" /> 当前为缓存快照（上次诊断时间的结果），内容未变化时无需重复消耗；点“重新诊断”可刷新。</p>
      )}

      {err && <p className="mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-xs text-red-700">{err}</p>}
      {!text && !disabled && <p className="mt-3 rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">还没有可诊断的内容。</p>}

      {result && (
        <div className="mt-4 space-y-3">
          {storylines.length > 0 && (
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-xs font-semibold text-stone-500"><Ic n="thread" /> 现有故事线（{storylines.length}）</p>
              <ul className="mt-2 space-y-1.5">
                {storylines.map((s, i) => (
                  <li key={i} className="text-xs leading-relaxed text-stone-600">
                    <span className="font-medium text-stone-700">{s.name}：</span>
                    {s.progress}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className={`rounded-xl p-3 ${paceIssues.length ? 'bg-amber-50' : 'bg-emerald-50'}`}>
            <p className={`text-xs font-semibold ${paceIssues.length ? 'text-amber-700' : 'text-emerald-700'}`}><Ic n="timer" /> 节奏诊断</p>
            {paceIssues.length === 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-emerald-700">未发现明显的节奏问题。</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {paceIssues.map((p, i) => (
                  <li key={i} className="text-xs leading-relaxed text-amber-800">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {hooks.length > 0 && (
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-xs font-semibold text-stone-500"><Ic n="hook" /> 未回收伏笔与建议回收时机（{hooks.length}）</p>
              <ul className="mt-2 space-y-1.5">
                {hooks.map((f, i) => (
                  <li key={i} className="text-xs leading-relaxed text-stone-600">
                    <span className="font-medium text-stone-700">{f.content}</span>
                    {f.suggestion && <span className="text-stone-500"> —— {f.suggestion}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-xs font-semibold text-stone-500"><Ic n="bulb" /> 写作建议</p>
              <ol className="mt-2 list-decimal space-y-1 pl-4">
                {suggestions.map((s, i) => (
                  <li key={i} className="text-xs leading-relaxed text-stone-600">
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
