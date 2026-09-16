// 全书润色终 pass 面板（P2）：成书后对已归档章节逐章做「保持剧情/人物不变」的定稿润色。
// 对标 show-me-the-story 的 final polish：去 AI 味、修语病、跨章连贯。非破坏性——先预览逐章结果，作者确认后再一键采用。
// 编排见 longform.polishWholeBook（顺序处理避免打爆 BYOK 限流，单章失败不中断整轮）。
import { useState } from 'react'
import { polishWholeBook, applyPolishResults } from '../lib/longform.js'
import Ic from './Ic.jsx'

export default function PolishPanel({ project, saveProject, apiKey, busy: globalBusy }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults] = useState(null)
  const [ctrl, setCtrl] = useState(null)
  const [openNo, setOpenNo] = useState(null)

  const chapters = (project?.chapters || []).filter((c) => c && typeof c.content === 'string' && c.content.length)
  const busy = globalBusy || running
  const changedCount = results ? results.filter((r) => r.changed).length : 0

  const start = async () => {
    if (!apiKey || !chapters.length || running) return
    const ac = new AbortController()
    setCtrl(ac)
    setRunning(true)
    setResults(null)
    setProgress({ done: 0, total: chapters.length })
    try {
      const out = await polishWholeBook({
        apiKey,
        project,
        setting: project?.world || '',
        signal: ac.signal,
        onProgress: (p) => setProgress(p),
      })
      setResults(out.results || [])
    } catch {
      setResults([])
    } finally {
      setRunning(false)
      setCtrl(null)
      setProgress(null)
    }
  }
  const stop = () => ctrl && ctrl.abort()
  const adopt = () => {
    if (!results || !changedCount) return
    saveProject(applyPolishResults(project, results))
    setResults(null)
    setOpenNo(null)
  }
  const origOf = (no) => (chapters.find((c) => Number(c.chapterNo) === Number(no)) || {}).content || ''

  return (
    <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="pencil" /> 全书润色终 pass</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            成书后对已归档的 <b className="text-stone-500">{chapters.length}</b> 章逐章做定稿润色：在<b className="text-stone-500">严格不改剧情/人物/结局</b>的前提下去 AI 味、修语病、优化跨章连贯。
            顺序处理、非破坏性——先逐章预览，确认后再一键采用（正文变更会自动清除陈旧索引，下次归档重建）。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <button onClick={stop} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"><Ic n="stop" /> 停止</button>
          ) : (
            <button
              onClick={start}
              disabled={busy || !apiKey || !chapters.length}
              className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-900 disabled:opacity-40"
            >
              <Ic n="wand" /> 开始全书润色
            </button>
          )}
        </div>
      </div>

      {!apiKey && <p className="mt-2 text-xs text-amber-700"><Ic n="alert" /> 需要先在「我的」页配置写作 API Key（DeepSeek / 通义千问）。</p>}

      {running && progress && (
        <div className="mt-3 rounded-xl border border-stone-200 bg-white px-4 py-3">
          <p className="text-xs text-stone-500">
            <Ic n="rolling" /> 润色中 {progress.done}/{progress.total}
            {progress.chapterNo ? `　·　第 ${progress.chapterNo} 章《${progress.title || ''}》` : ''}
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
            <div className="h-full rounded-full bg-stone-700 transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
        </div>
      )}

      {results && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-stone-700">
              <Ic n="ok" /> 润色完成：{results.length} 章，其中 <span className="text-stone-900">{changedCount}</span> 章有改动
            </p>
            <div className="flex items-center gap-2">
              <button onClick={adopt} disabled={!changedCount || busy} className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"><Ic n="check" /> 采用全部改动</button>
              <button onClick={() => { setResults(null); setOpenNo(null) }} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">放弃</button>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            {results.map((r) => {
              const open = openNo === r.chapterNo
              return (
                <div key={r.chapterNo} className="rounded-xl border border-stone-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button onClick={() => setOpenNo(open ? null : r.chapterNo)} className="text-left text-sm font-semibold text-stone-700">
                      第 {r.chapterNo} 章《{r.title}》
                      {r.error ? (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-normal text-red-600">失败（已跳过）</span>
                      ) : r.changed ? (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-normal text-emerald-700">有改动</span>
                      ) : (
                        <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">无需改动</span>
                      )}
                      <span className="ml-2 text-xs font-normal text-stone-400">{open ? '收起' : '预览'}</span>
                    </button>
                  </div>
                  {r.notes && <p className="mt-1.5 text-xs leading-relaxed text-stone-500"><Ic n="notepad" /> {r.notes}</p>}
                  {r.error && <p className="mt-1.5 text-xs text-red-600/80">{r.error}</p>}
                  {open && !r.error && (
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-medium text-stone-400">原文</p>
                        <p className="novel-text mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-2 text-xs leading-relaxed text-stone-500">{origOf(r.chapterNo)}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-emerald-600">润色后</p>
                        <p className="novel-text mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-emerald-50/50 p-2 text-xs leading-relaxed text-stone-700">{r.polished}</p>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
