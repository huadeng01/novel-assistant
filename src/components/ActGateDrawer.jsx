// 幕末确认门 slide-over（§7 + §13 阶段5）：一幕 / 一卷生成完毕后的 human-in-the-loop 检查点。
// 「事中不停、把人工干预后移到幕末」——本幕每章正文 + critic 报告一屏纵览，可逐章「意见 / 修订」（拉起 ChapterReviewDrawer），
// 确认无误后关闭，再启动下一幕自动连写。用 slide-over 而非 modal（§16），层级低于单章抽屉（z-40 < z-50）。
import Ic from './Ic.jsx'
import { formatNovelParagraphs } from '../lib/longform.js'

export default function ActGateDrawer({ project, range, onClose, onReviewChapter, busy }) {
  const from = Number(range?.from) || 0
  const to = Number(range?.to) || 0
  const chapters = (project.chapters || [])
    .filter((c) => c.chapterNo >= from && c.chapterNo <= to)
    .sort((a, b) => a.chapterNo - b.chapterNo)
  const totalWords = chapters.reduce((s, c) => s + (c.wordCount || 0), 0)
  const hardTotal = chapters.reduce((s, c) => s + (c.issues || []).filter((i) => i.severity !== 'soft').length, 0)

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="幕末确认门">
      <div className="glass-scrim absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <aside className="glass-panel absolute right-0 top-0 flex h-full w-full max-w-3xl flex-col border-l border-stone-200 bg-paper shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="min-w-0 text-base font-bold">
            <Ic n="target" /> 幕末确认门
            <span className="ml-2 text-xs font-normal text-stone-400">{range?.label || `第 ${from}-${to} 章`}</span>
          </h2>
          <button onClick={onClose} className="shrink-0 rounded-full border border-stone-300 p-1.5 text-stone-500 hover:bg-stone-100" aria-label="关闭">
            <Ic n="x" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p className="rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs leading-relaxed text-sky-700">
            <Ic n="notepad" /> 本幕共 {chapters.length} 章、约 {totalWords} 字，每章均走完「场景清单 → 初稿 → 审校 → 归档」流水线。
            {hardTotal > 0
              ? <span className="text-red-600"> 其中 {hardTotal} 处一致性硬存疑，建议逐章「意见 / 修订」后再继续下一幕。</span>
              : ' 未检出一致性硬存疑，可逐章复查后继续下一幕。'}
          </p>

          {chapters.length === 0 && (
            <p className="rounded-xl bg-stone-100 px-3 py-6 text-center text-xs text-stone-400">本幕暂无已落库章节。</p>
          )}

          {chapters.map((c) => {
            const hard = (c.issues || []).filter((i) => i.severity !== 'soft').length
            const soft = (c.issues || []).length - hard
            const pending = (c.userNotes || []).filter((n) => !n.applied).length
            return (
              <article key={c.id} className="rounded-xl border border-stone-200 bg-white/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 text-sm font-semibold">
                    第{c.chapterNo}章 {c.title?.replace(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[\s:：]*/, '') || ''}
                    <span className="ml-2 text-xs font-normal text-stone-400">{c.wordCount || 0} 字</span>
                  </h3>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {hard > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-600">{hard} 硬存疑</span>}
                    {soft > 0 && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">{soft} 软存疑</span>}
                    {pending > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">{pending} 待落实意见</span>}
                    <button
                      onClick={() => onReviewChapter(c.chapterNo)}
                      disabled={busy}
                      className="rounded-full bg-stone-800 px-3 py-1 text-[11px] font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                    >
                      <Ic n="chat" /> 意见 / 修订
                    </button>
                  </div>
                </div>
                {c.summary && <p className="mt-1.5 text-xs leading-relaxed text-stone-500"><Ic n="notepad" /> {c.summary}</p>}
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600">展开正文</summary>
                  <div className="novel-text mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">
                    {formatNovelParagraphs(c.content).text}
                  </div>
                </details>
              </article>
            )
          })}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-stone-200 px-5 py-3">
          <p className="text-xs text-stone-400">确认本幕无误后关闭，再启动下一幕自动连写。</p>
          <button onClick={onClose} className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">
            <Ic n="ok" /> 本幕已确认
          </button>
        </footer>
      </aside>
    </div>
  )
}
