import { STATE_WORDS_CN } from '../../lib/parseAssets.js'
import { genBtn, ghostBtn } from './styles.js'

// 已有资产更新预览弹窗：逐条勾选/改状态词后落库，默认不勾选
export default function UpdatesPreviewModal({ open, onClose, pendingUpdates, selUp, setSelUp, setPendingUpdates, onApply }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="已有资产更新">
      <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">已有资产更新预览（勾选后落库）</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {pendingUpdates.map((u, i) => (
            <label key={i} className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
              <input type="checkbox" checked={selUp.includes(i)} onChange={(e) => setSelUp(e.target.checked ? [...selUp, i] : selUp.filter((x) => x !== i))} className="mt-0.5" />
              {u.fromCh ? <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-600">第{u.fromCh}章</span> : null}
              <span className="font-medium text-ink">{u.name}</span>
              <span className="flex-1 text-stone-600">{u.info}</span>
              <select value={u.state} onChange={(e) => setPendingUpdates((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} className="rounded border border-stone-300 bg-paper px-1 py-0.5">
                {STATE_WORDS_CN.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!pendingUpdates.length && <div className="text-xs text-stone-400">无待落库更新</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <span className="mr-auto text-xs text-stone-400">默认不勾选，逐条确认后再落库</span>
          <button onClick={() => setSelUp(pendingUpdates.map((_, i) => i))} className={ghostBtn} disabled={!pendingUpdates.length}>
            全选
          </button>
          <button onClick={() => setSelUp([])} className={ghostBtn} disabled={!selUp.length}>
            清空
          </button>
          <button onClick={onApply} disabled={!selUp.length} className={genBtn}>
            落库选中（{selUp.length}）
          </button>
          <button onClick={onClose} className={ghostBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
