import { genBtn, ghostBtn } from './styles.js'

// 新资产预览弹窗：逐条勾选/改透出章后落库，默认不勾选
export default function NewAssetsPreviewModal({ open, onClose, pendingNew, selNew, setSelNew, setPendingNew, onApply }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="新资产">
      <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">新资产预览（勾选后落库）</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {pendingNew.map((n, i) => (
            <label key={i} className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
              <input type="checkbox" checked={selNew.includes(i)} onChange={(e) => setSelNew(e.target.checked ? [...selNew, i] : selNew.filter((x) => x !== i))} className="mt-0.5" />
              <span className="rounded bg-stone-100 px-1 py-0.5 text-stone-600">{n.type}</span>
              <span className="font-medium text-ink">{n.name}</span>
              <span className="flex-1 text-stone-600">{n.desc}</span>
              {n.fromCh ? <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-500">来源第{n.fromCh}章</span> : null}
              <span className="text-stone-500">透出章</span>
              <input type="number" value={n.reveal || n.fromCh || 0} onChange={(e) => setPendingNew((p) => p.map((x, j) => (j === i ? { ...x, reveal: Number(e.target.value) || 0 } : x)))} className="w-14 rounded border border-stone-300 bg-paper px-1 py-0.5" />
            </label>
          ))}
          {!pendingNew.length && <div className="text-xs text-stone-400">无待落库新资产</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <span className="mr-auto text-xs text-stone-400">默认不勾选，逐条确认后再落库</span>
          <button onClick={() => setSelNew(pendingNew.map((_, i) => i))} className={ghostBtn} disabled={!pendingNew.length}>
            全选
          </button>
          <button onClick={() => setSelNew([])} className={ghostBtn} disabled={!selNew.length}>
            清空
          </button>
          <button onClick={onApply} disabled={!selNew.length} className={genBtn}>
            落库选中（{selNew.length}）
          </button>
          <button onClick={onClose} className={ghostBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
