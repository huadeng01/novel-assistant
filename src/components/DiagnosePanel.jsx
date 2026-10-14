// 全局诊断看板：让 AI 对已有内容做一次"体检"——梳理故事线、诊断节奏（含伏笔是否收太早）、给出建议
// 续写页、改写页复用（长篇 / 新手页当前未挂载诊断入口）；调用方负责把要诊断的内容组装进 text
import { useEffect, useRef, useState } from 'react'
import Ic from './Ic.jsx'
import { chatJSON } from '../lib/llm.js'
import { diagnoseMessages } from '../lib/prompts.js'

const LIMIT = 16000 // 诊断输入上限，避免超长文本撑爆上下文

export default function DiagnosePanel({ apiKey, text, context, disabled, cacheKey }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const [fromCache, setFromCache] = useState(false)
  // 5.1：发送前提示词确认（人在环路）。点"开始诊断"先弹窗展示将发送的 system+user 提示词，可查看/编辑，确认后才真正发 chatJSON（保留 jsonMode / temperature 0.3 / 缓存写回，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, messages, proceed }
  // C8：记录最近一次 run 产出新鲜结果时的 cacheKey；该 key 的内存 result 已是最新，effect 不再回读缓存覆盖它（防异步竞态把新鲜结果打回旧快照）
  const producedKeyRef = useRef(null)

  // 结果缓存：同一内容状态（如章节数未变）下直接读本地缓存，避免重复消耗 API；点“重新诊断”强制刷新并写回缓存
  useEffect(() => {
    if (cacheKey && cacheKey === producedKeyRef.current) return // C8：本轮刚产出的结果，跳过缓存回读
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

  // 真正发送（用户在确认窗点"确认并发送"后调用；messages 可能已被用户编辑）
  const run = async (messages) => {
    if (!apiKey || !text) return
    setErr('')
    setBusy(true)
    setResult(null)
    setPromptConfirm(null)
    try {
      const res = await chatJSON({ apiKey, messages, temperature: 0.3 })
      setResult(res)
      setFromCache(false)
      producedKeyRef.current = cacheKey || null // C8：标记这份新鲜结果归属的 cacheKey，effect 不回读覆盖
      if (cacheKey) {
        try {
          // M17：诊断缓存无界增长防护——写当前键前，清掉其它 na_diag_ 前缀的旧快照（每次 text 变都写新键、从不清 → localStorage 堆积）
          for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const k = localStorage.key(i)
            if (k && k.startsWith('na_diag_') && k !== cacheKey) localStorage.removeItem(k)
          }
          localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), result: res }))
        } catch {
          /* 缓存写/清失败不影响诊断结果 */
        }
      }
    } catch (e) {
      setErr(e?.message || String(e)) // C4：非 Error 抛出时 e.message 为 undefined，界面会完全不提示
      // M16：失败时按 cacheKey 回读缓存恢复上次结果，避免"一次失败抹掉已付费的缓存快照、按钮退回『开始诊断』"
      if (cacheKey) {
        try {
          const c = JSON.parse(localStorage.getItem(cacheKey))
          if (c && c.result) {
            setResult(c.result)
            setFromCache(true)
            producedKeyRef.current = cacheKey
          }
        } catch {
          /* 无可用缓存则保持空结果 */
        }
      }
    } finally {
      setBusy(false)
    }
  }

  // 点"开始诊断"：先组装将发送的提示词并弹确认窗，用户查看/编辑后再走 run（不直接发送）
  const openConfirm = () => {
    if (!apiKey || !text) return
    setErr('')
    setPromptConfirm({
      title: 'AI 全局诊断',
      messages: diagnoseMessages({ text: String(text).slice(0, LIMIT), context }),
      proceed: run,
    })
  }

  const storylines = Array.isArray(result?.storylines) ? result.storylines : []
  const paceIssues = Array.isArray(result?.pace_issues) ? result.pace_issues : []
  const hooks = Array.isArray(result?.foreshadows) ? result.foreshadows : []
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : []

  return (
    <>
    <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold"><Ic n="doctor" /> AI 全局诊断看板</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            梳理现有故事线、诊断节奏问题（进程过快 / 伏笔收得太早 / 事件密度过高），并给出写作建议。
          </p>
        </div>
        <button
          onClick={openConfirm}
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
    {promptConfirm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={() => setPromptConfirm(null)}>
        <div className="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
            <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词</span>
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
                      return { ...p, messages: ms }
                    })
                  }
                  className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-[13px] leading-relaxed focus:border-stone-500 focus:outline-none"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
            <button onClick={() => setPromptConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">取消</button>
            <button onClick={() => promptConfirm.proceed(promptConfirm.messages)} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700">确认并发送</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
