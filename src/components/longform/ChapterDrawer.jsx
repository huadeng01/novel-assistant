import { EXPORT_FORMATS } from '../../lib/docio.js'
import { ghostBtn, line } from './styles.js'

// 章节树抽屉：纵览已存章节、跳章、+写下一章、导出全书
export default function ChapterDrawer({ open, onClose, chapters, chapterNo, planTitleOf, nextChapterToWrite, exportFormat, setExportFormat, onLoadChapter, onExport }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <aside className="h-full w-72 overflow-y-auto border-r border-stone-200 bg-paper p-3" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="章节树">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">章节树</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="收起">
            ×
          </button>
        </div>
        <div className="space-y-1">
          {chapters.map((c) => (
            <button
              key={c.no}
              onClick={() => onLoadChapter(c.no)}
              className={`block w-full rounded px-2 py-1 text-left text-xs ${c.no === chapterNo ? 'bg-stone-100 font-medium text-ink' : 'text-stone-600 hover:bg-stone-50'}`}
            >
              第{c.no}章 {c.title === `第${c.no}章` ? planTitleOf(c.no) || '（未命名）' : c.title}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => onLoadChapter(nextChapterToWrite)} className={ghostBtn}>
            +写第{nextChapterToWrite}章
          </button>
          <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} className={line} title="导出格式">
            {EXPORT_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button onClick={onExport} className={ghostBtn}>
            导出全书
          </button>
        </div>
      </aside>
    </div>
  )
}
