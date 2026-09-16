// #4 写前场景推演（多智能体）面板：落笔前输入一个「待写场景前提」，并行召集 4 位专家智能体
// （逻辑 / 角色 / 冲突 / 读者）从不同维度推演，再由总编综合者收敛成可执行报告（可行性 / 关键风险 / 建议 / beat 序列）。
// 对标 novel-distiller MiroFish 场景推演、novel-studio 多智能体世界推演。纯 AI（需写作 Key），只推演规划、不代写正文、不替作者拍板。
import { useRef, useState } from 'react'
import { runSceneSim } from '../lib/longform.js'
import { SCENE_SIM_AGENTS } from '../lib/prompts.js'
import Ic from './Ic.jsx'

const VERDICT_STYLE = {
  可行: 'bg-emerald-50 text-emerald-700',
  需调整: 'bg-amber-50 text-amber-700',
  有风险: 'bg-red-50 text-red-700',
  失败: 'bg-stone-100 text-stone-400',
}

export default function SceneSimPanel({ project, apiKey, busy: globalBusy }) {
  const [premise, setPremise] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const ctrl = useRef(null)

  // 拟定章号 = 已归档最大章号 + 1（供推演时对齐「本章详纲 / 前情」）
  const nextChapterNo = (project?.chapters || []).reduce((m, c) => Math.max(m, Number(c?.chapterNo) || 0), 0) + 1

  const start = async () => {
    if (!apiKey) { setErr('需要先在「我的」页配置写作 API Key（通义千问 / DeepSeek）。'); return }
    if (!premise.trim()) { setErr('请先描述待推演的场景前提（谁、在哪、发生什么、要走向何方）。'); return }
    setErr(''); setResult(null); setRunning(true)
    setProgress({ done: 0, total: SCENE_SIM_AGENTS.length + 1, label: '召集智能体' })
    ctrl.current = new AbortController()
    try {
      const res = await runSceneSim({ apiKey, premise: premise.trim(), project, chapterNo: nextChapterNo, signal: ctrl.current.signal, onProgress: setProgress })
      setResult(res)
    } catch (e) {
      if (e && e.name === 'AbortError') setErr('已中止。')
      else setErr((e && e.message) || '推演失败，请稍后重试。')
    } finally {
      setRunning(false); setProgress(null)
    }
  }
  const stop = () => { if (ctrl.current) ctrl.current.abort() }

  return (
    <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
      <div className="min-w-0">
        <h2 className="text-base font-bold"><Ic n="scene" /> 写前场景推演 · 多智能体</h2>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">
          落笔前先推演。输入一个待写场景前提，并行召集 <b className="text-stone-500">逻辑 / 角色 / 冲突 / 读者</b> 四位专家智能体从不同维度推敲，再由总编收敛成可执行报告（可行性 / 关键风险 / 建议 / beat 序列）。只推演规划、不代写正文、不替你拍板。
        </p>
      </div>

      <textarea
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
        rows={3}
        placeholder="例：林昭在洗髓阁后崖堵住苏晚，逼问灭门案真凶，苏晚却反将一军说出林昭身世……"
        className="mt-3 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm leading-relaxed"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={start} disabled={running || globalBusy} className="flex items-center gap-1.5 rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
          <span className={running ? 'animate-spin' : ''}><Ic n={running ? 'rolling' : 'scene'} /></span>
          {running ? '推演中…' : '召集智能体推演'}
        </button>
        {running && <button onClick={stop} className="flex items-center gap-1 rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-500 hover:bg-stone-50"><Ic n="stop" /> 中止</button>}
        {running && progress && (
          <span className="text-xs text-stone-400">
            <span className="mr-1 inline-block animate-spin align-[-0.125em]"><Ic n="rolling" /></span>
            {progress.label}（{progress.done}/{progress.total}）
          </span>
        )}
        <span className="text-xs text-stone-300">拟定用于第 {nextChapterNo} 章</span>
      </div>
      {!apiKey && <p className="mt-2 text-xs text-amber-700">需要先在「我的」页配置写作 API Key。</p>}
      {err && <p className="mt-2 rounded-xl bg-red-50 px-4 py-2.5 text-xs text-red-700">{err}</p>}

      {result && (
        <div className="mt-4 space-y-3">
          {/* 四位专家智能体 */}
          <div className="grid gap-2 sm:grid-cols-2">
            {result.agentOutputs.map((o) => (
              <div key={o.id} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-stone-700"><Ic n={o.icon} /> {o.name}<span className="ml-1 font-normal text-stone-400">· {o.focus}</span></span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${VERDICT_STYLE[o.verdict] || 'bg-stone-100 text-stone-500'}`}>{o.verdict}</span>
                </div>
                {o.error ? (
                  <p className="mt-2 text-xs text-red-600">{o.error}</p>
                ) : (
                  <>
                    {o.analysis && <p className="mt-2 text-xs leading-relaxed text-stone-600">{o.analysis}</p>}
                    {o.risks.length > 0 && <p className="mt-2 text-xs leading-relaxed text-amber-800"><b>风险：</b>{o.risks.join('；')}</p>}
                    {o.suggestions.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {o.suggestions.map((s, i) => (<li key={i} className="text-xs leading-relaxed text-stone-500">· {s}</li>))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* 总编综合报告 */}
          {result.synthesis && !result.synthesis.error && (
            <div className="rounded-xl border border-stone-300 bg-stone-50 p-4">
              <p className="text-sm font-bold text-stone-700"><Ic n="clipboard" /> 总编综合报告</p>
              {result.synthesis.feasibility && <p className="mt-2 text-xs leading-relaxed text-stone-600">{result.synthesis.feasibility}</p>}
              {result.synthesis.key_risks.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-red-700">关键风险（按优先级）</p>
                  <ul className="mt-1 space-y-0.5">
                    {result.synthesis.key_risks.map((r, i) => (<li key={i} className="text-xs leading-relaxed text-red-700/90">{i + 1}. {r}</li>))}
                  </ul>
                </div>
              )}
              {result.synthesis.recommendations.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-stone-600">可执行建议</p>
                  <ul className="mt-1 space-y-0.5">
                    {result.synthesis.recommendations.map((r, i) => (<li key={i} className="text-xs leading-relaxed text-stone-500">{i + 1}. {r}</li>))}
                  </ul>
                </div>
              )}
              {result.synthesis.beat_sequence.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-stone-600"><Ic n="scene" /> 推荐场景 beat 序列</p>
                  <ol className="mt-1 space-y-0.5">
                    {result.synthesis.beat_sequence.map((b, i) => (<li key={i} className="text-xs leading-relaxed text-stone-600">{i + 1}. {b}</li>))}
                  </ol>
                </div>
              )}
            </div>
          )}
          {result.synthesis && result.synthesis.error && <p className="rounded-xl bg-red-50 px-4 py-2.5 text-xs text-red-700">{result.synthesis.error}</p>}
        </div>
      )}
    </section>
  )
}
