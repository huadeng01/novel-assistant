// 全局诊断看板：让 AI 对已有内容做一次"体检"——梳理故事线、诊断节奏（含伏笔是否收太早）、给出建议
// 续写页、改写页复用（长篇 / 新手页当前未挂载诊断入口）；调用方负责把要诊断的内容组装进 text
import { useEffect, useRef, useState } from 'react'
import Ic from './Ic.jsx'
import { chatJSON, STRUCTURED_TEMP } from '../lib/llm.js'
import { diagnoseMessages } from '../lib/prompts.js'

const LIMIT = 16000 // 诊断输入上限，避免超长文本撑爆上下文

const diagStr = (v) => (v == null ? '' : String(v))
const sanitizeDiag = (r) => {
  if (!r || typeof r !== 'object') return null
  const arr = (v) => (Array.isArray(v) ? v : [])
  return {
    ...r,
    storylines: arr(r.storylines).map((s) => (s && typeof s === 'object' ? { ...s, name: diagStr(s.name), progress: diagStr(s.progress) } : null)).filter(Boolean),
    pace_issues: arr(r.pace_issues).map(diagStr),
    foreshadows: arr(r.foreshadows).map((f) => (f && typeof f === 'object' ? { ...f, content: diagStr(f.content), suggestion: diagStr(f.suggestion) } : null)).filter(Boolean),
    suggestions: arr(r.suggestions).map(diagStr),
  }
}

// 诊断看板：把现有原文的故事线与节奏梳理成报告（含伏笔是否收太早），结果按原文片段缓存，切回不重烧额度。
export default function DiagnosePanel({ apiKey, text, context, disabled, cacheKey, total }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const [fromCache, setFromCache] = useState(false)
  // 5.1：发送前提示词确认（人在环路）。点"开始诊断"先弹窗展示将发送的 system+user 提示词，可查看/编辑，确认后才真正发 chatJSON（保留 jsonMode / temperature 0.3 / 缓存写回，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, messages, proceed }
  const producedKeyRef = useRef(null)
  const abortRef = useRef(null)
  const mountedRef = useRef(true)
  const keyRef = useRef(cacheKey)
  keyRef.current = cacheKey

  useEffect(() => {
    mountedRef.current = true
    //   旧键形如 na_diag_<字数>_<原文片段>（键名内含用户原文、属隐私面），既不会再被读到、也不被同类前缀清理命中，
    //   过去只靠 wipeAll 兜底（用户可能永远不点）。挂载时扫一遍，删掉 na_diag_ 开头但不含 cont/rev 中缀的孤儿键。
    try {
      const legacy = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)
        if (k && k.startsWith('na_diag_') && !k.startsWith('na_diag_cont_') && !k.startsWith('na_diag_rev_')) legacy.push(k)
      }
      for (const k of legacy) localStorage.removeItem(k)
    } catch {
      /* 隐私模式 / localStorage 不可用：忽略 */
    }
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // 结果缓存：同一内容状态（如章节数未变）下直接读本地缓存，避免重复消耗 API；点“重新诊断”强制刷新并写回缓存
  useEffect(() => {
    if (cacheKey && cacheKey === producedKeyRef.current) return
    //   否则「K1 出结果(producedKeyRef=K1) → 改文切 K2(回读 K2) → 改回 K1」时，effect 因 K1===producedKeyRef 提前 return、不回读 localStorage[K1]，
    //   内存里还是 K2 的结果(或 null) → K1 明明有快照却显空白（可自愈：再点一次诊断即恢复，但误导）。清掉后切回 K1 正常回读其快照。
    producedKeyRef.current = null
    let c = null
    if (cacheKey) {
      try {
        c = JSON.parse(localStorage.getItem(cacheKey))
      } catch {
        c = null
      }
    }
    setResult(sanitizeDiag(c?.result)) // 必修A：缓存可能是本修复前写入的毒丸，回读也归一（sanitizeDiag(null/undefined)→null，与原 `|| null` 等价）
    setFromCache(!!c?.result)
  }, [cacheKey])

  // 真正发送（用户在确认窗点"确认并发送"后调用；messages 可能已被用户编辑）
  const run = async (messages) => {
    if (!apiKey) {
      setErr('还没有设置写作引擎的 API Key，请先到「我的」页配置后再诊断。')
      return
    }
    if (!text) {
      setErr('还没有可诊断的内容，先粘贴 / 导入原文再诊断。')
      return
    }
    const myKey = cacheKey
    //   原写 `cacheKey || null` 会让未传 cacheKey 时 myKey=null 而 keyRef.current=undefined，:84 `undefined !== null` 恒真 → 新鲜结果恒被判过期丢弃（现两调用方都传键=潜伏）。
    setErr('')
    setBusy(true)
    setResult(null)
    setPromptConfirm(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = sanitizeDiag(await chatJSON({ apiKey, messages, temperature: STRUCTURED_TEMP, signal: ctrl.signal }))
      if (!mountedRef.current || keyRef.current !== myKey) return
      //   从而跳过下面的「删同类旧键(:110-114) + 写 {result:null}(:115)」——否则上次已付费的有效快照被永久抹掉、界面空白、还不报错（原代码 setResult(null) 后照常删键写 null 缓存）。
      if (!res) throw new Error('AI 返回的内容格式不正确（非诊断结构），请点「重新诊断」重试。')
      setResult(res)
      setFromCache(false)
      producedKeyRef.current = myKey
      if (cacheKey) {
        try {
          const prefix = cacheKey.split('_').slice(0, 3).join('_') + '_'
          for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const k = localStorage.key(i)
            if (k && k.startsWith(prefix) && k !== cacheKey) localStorage.removeItem(k)
          }
          localStorage.setItem(cacheKey, JSON.stringify({ result: res }))
        } catch {
          /* 缓存写/清失败不影响诊断结果 */
        }
      }
    } catch (e) {
      if (!mountedRef.current || keyRef.current !== myKey) return
      if (e?.name === 'AbortError') {
        setErr('诊断已中断。')
        return
      }
      setErr(e?.message || String(e))
      if (cacheKey) {
        try {
          const c = JSON.parse(localStorage.getItem(cacheKey))
          if (c && c.result) {
            setResult(sanitizeDiag(c.result)) // 必修A：失败回读的缓存同样归一，防毒丸
            setFromCache(true)
            producedKeyRef.current = cacheKey
          }
        } catch {
          /* 无可用缓存则保持空结果 */
        }
      }
    } finally {
      abortRef.current = null
      //   keyRef.current!==myKey 成立；若据此跳过复位，busy 永远停在 true → 按钮永久「诊断中」且禁用、缓存回读 effect 也不复位。
      //   过期守卫只该挡「结果上屏」（上面 then/catch 已挡），busy 只要组件还挂载就必须解除。
      if (mountedRef.current) setBusy(false)
    }
  }

  // 点"开始诊断"：先组装将发送的提示词并弹确认窗，用户查看/编辑后再走 run（不直接发送）
  const openConfirm = () => {
    if (!apiKey) {
      setErr('还没有设置写作引擎的 API Key，请先到「我的」页配置后再诊断。')
      return
    }
    if (!text) {
      setErr('还没有可诊断的内容，先粘贴 / 导入原文再诊断。')
      return
    }
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
  //   续写页(ContinuePage)先把原文截成末尾 16000 字再传进来（续写看近文），此时 text.length≤LIMIT，
  //   若只看 text.length 会恒判未超限、提示永不出现（真·静默截断）；故用 total 判 overLimit。
  //   改写页(RevisePage)传全文、由本组件 slice(0,LIMIT) 截头，不传 total → 回落 text.length。
  const totalLen = total != null ? Number(total) || 0 : String(text || '').length
  const overLimit = totalLen > LIMIT

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
      {overLimit && (
        <p className="mt-2 rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-700">原文较长（共 {totalLen} 字），本次仅诊断{total != null ? '末尾' : '前'} {LIMIT} 字（超出部分不参与分析）。</p>
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
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
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
            <button onClick={() => promptConfirm.proceed(promptConfirm.messages)} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700">确认并发送</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
