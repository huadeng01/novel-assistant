import { HISTORY_MAX } from '../../lib/longformPlan.js'
import { ghostBtn } from './styles.js'

// 章节历史版本弹窗：新版在上，逐版可回滚(载回编辑区，确认后保存生效)
export default function HistoryModal({ open, onClose, chapterNo, currentHistory, onRollback }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="历史版本">
      <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">第{chapterNo}章 · 历史版本（{currentHistory.length}）</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {currentHistory.length === 0 && (
            <p className="text-sm text-stone-400">本章暂无历史版本。每次「保存本章」覆盖旧正文时，旧版会自动存进来（最多保留 {HISTORY_MAX} 版）。</p>
          )}
          {[...currentHistory].reverse().map((v, idx) => {
            const key = currentHistory.length - 1 - idx
            const body = String(v.text || '')
            return (
              <div key={key} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-stone-500">
                    {v.savedAt ? new Date(v.savedAt).toLocaleString() : '旧版'} · {body.length} 字{v.title ? ` · ${v.title}` : ''}
                  </span>
                  <button onClick={() => onRollback(v)} className="shrink-0 rounded-lg border border-stone-300 bg-paper px-3 py-1 text-xs text-stone-700 hover:bg-stone-100">
                    回滚到此版
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-stone-600">
                  {body.slice(0, 200)}
                  {body.length > 200 ? '…' : ''}
                </p>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <span className="mr-auto text-xs text-stone-400">回滚=载回编辑区，确认后点「保存本章」生效（当前正文会存入历史，不丢）</span>
          <button onClick={onClose} className={ghostBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
