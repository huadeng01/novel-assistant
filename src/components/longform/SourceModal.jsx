import { useRef } from 'react'
import { READ_ACCEPT } from '../../lib/docio.js'
import { box, genBtn, ghostBtn } from './styles.js'

// 分析原文录入弹窗：粘贴或导入原文，点「开始分析」转提示词弹窗
export default function SourceModal({ open, onClose, sourceText, setSourceText, onFile, onStart }) {
  const fileRef = useRef(null)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="分析原文">
      <div className="flex max-h-[86vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">分析原文 → 资产更新/新资产</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex gap-2">
            <button onClick={() => fileRef.current && fileRef.current.click()} className={ghostBtn}>
              导入原文文件
            </button>
            <input ref={fileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onFile} />
          </div>
          <textarea value={sourceText} onChange={(e) => setSourceText(e.target.value)} rows={12} className={box} placeholder="粘贴或导入已写章节/参考原文，点「开始分析」产出已有资产更新+新资产两组预览。" />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button onClick={onStart} disabled={!sourceText.trim()} className={genBtn}>
            开始分析
          </button>
          <button onClick={onClose} className={ghostBtn}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
