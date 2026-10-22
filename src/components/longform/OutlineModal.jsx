import { genBtn, ghostBtn } from './styles.js'

// 全书详纲弹窗：纵览卷章表全部章行，点章跳写，入口转「续排下一卷」
export default function OutlineModal({ open, onClose, volumeChapters, maxPlanChapter, chapterNo, onLoadChapter, onNextVol }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="结构大纲">
      <div className="flex max-h-[86vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">全书详纲（{volumeChapters.length} 章 · 已排到第 {maxPlanChapter} 章）</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {volumeChapters.length === 0 && <p className="text-sm text-stone-400">卷章表里还没有章行；先在新手写作排章，或点下方「续排下一卷」。</p>}
          {volumeChapters.map((c) => (
            <button
              key={c.no}
              onClick={() => onLoadChapter(c.no)}
              className={`block w-full rounded-lg border px-3 py-2 text-left ${c.no === chapterNo ? 'border-red-300 bg-red-50' : 'border-stone-200 bg-stone-50 hover:border-stone-300'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-ink">第{c.no}章 · {c.title || '（未命名）'}</span>
                {c.mood && <span className="shrink-0 text-xs text-stone-400">{c.mood.length > 22 ? c.mood.slice(0, 22) + '…' : c.mood}</span>}
              </div>
              {c.synopsis && <p className="mt-1 text-xs leading-relaxed text-stone-500">{c.synopsis.length > 120 ? c.synopsis.slice(0, 120) + '…' : c.synopsis}</p>}
              {c.hook && c.hook !== c.title && <p className="mt-1 text-xs text-stone-400">钩子：{c.hook.length > 44 ? c.hook.slice(0, 44) + '…' : c.hook}</p>}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-stone-200 px-5 py-3">
          <span className="text-xs text-stone-400">点任意章跳过去写</span>
          <button onClick={onNextVol} className={genBtn}>
            续排下一卷章表
          </button>
        </div>
      </div>
    </div>
  )
}
