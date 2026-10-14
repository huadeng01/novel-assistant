import { useEffect, useState } from 'react'

// 通用"补全问答"弹窗：AI 提出 N 个补全问题，每题 3 个候选选项 + 自由回复框，支持上一题/下一题/提交。
// 交互参考 AskUserQuestion；独立可复用组件——任何需要"AI 提问 → 用户选择补全"的环节都可接入。
export default function ClarifyModal({ open, questions = [], title = '补全逻辑问答', onClose, onSubmit }) {
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState([])

  useEffect(() => {
    if (open) {
      setIdx(0)
      setAnswers(questions.map(() => ({ option: -1, free: '' })))
    }
    // M26：依赖 questions.length 而非 questions 身份，避免父组件传入新数组身份(派生表达式/重渲染)时把用户已答的题静默清空、跳回第1题
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, questions.length])

  if (!open || !questions.length) return null

  const q = questions[idx] || questions[0]
  const cur = answers[idx] || { option: -1, free: '' }
  const setAns = (patch) => setAnswers((a) => a.map((x, i) => (i === idx ? { ...x, ...patch } : x)))
  const last = idx >= questions.length - 1
  const answeredCount = answers.filter((a) => a.option >= 0 || (a.free || '').trim()).length

  return (
    // L28：已答过题(answeredCount>0)时遮罩不响应点击，避免误点弹窗外丢弃全部答案(重答需重新生成问题=一次 AI 调用)；× 与「取消」按钮仍可关闭
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={answeredCount > 0 ? undefined : onClose}>
      <div
        className="flex max-h-[88vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">
            {title}（第 {idx + 1}/{questions.length} 题）
          </span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="text-sm font-medium text-ink">{q.question}</div>
          {(q.options || []).map((o, oi) => (
            <button
              key={oi}
              onClick={() => setAns({ option: cur.option === oi ? -1 : oi })}
              className={`block w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                cur.option === oi
                  ? 'border-red-400 bg-stone-100 ring-2 ring-red-200'
                  : 'border-stone-300 bg-stone-50 hover:border-stone-400'
              }`}
            >
              <span className="block text-sm font-medium text-ink">{o.label}</span>
              {o.description && <span className="mt-1 block text-xs text-stone-500">{o.description}</span>}
            </button>
          ))}
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-500">或自己写（填写后覆盖选项）</label>
            <textarea
              value={cur.free}
              onChange={(e) => setAns({ free: e.target.value })}
              rows={2}
              placeholder="自己的答案…"
              className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-stone-200 px-5 py-3">
          <button
            onClick={() => setIdx(Math.max(0, idx - 1))}
            disabled={idx === 0}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-40"
          >
            上一题
          </button>
          <span className="text-xs text-stone-500">已答 {answeredCount}/{questions.length}</span>
          <div className="flex gap-2">
            {last ? (
              <button
                onClick={() => onSubmit && onSubmit(answers)}
                disabled={answeredCount === 0}
                title={answeredCount === 0 ? '至少答一题再提交' : undefined}
                className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:opacity-40"
              >
                提交并继续
              </button>
            ) : (
              <button
                onClick={() => setIdx(Math.min(questions.length - 1, idx + 1))}
                className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600"
              >
                下一题
              </button>
            )}
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
