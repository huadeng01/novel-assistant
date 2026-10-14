import { useEffect, useRef, useState } from 'react'
import { chatStream, writerConfig } from '../lib/llm.js'

// 通用"提示词透明"弹窗：所有 AI 调用前弹出，展示即将发送的提示词供用户编辑，
// 发送后流式显示回复。是新范式（人在环路、告别暗箱）的核心交互组件。
export default function PromptEditorModal({
  open,
  title = '提示词',
  initialPrompt = '',
  systemPrompt = '',
  thinking = false,
  // M30：可选采样温度，缺省 undefined = 沿用 chatStream 默认(0.9，适合创作正文)；
  // 结构化抽取类调用(如长篇页「分析原文」出｜分列表格)由调用方传低值(0.3)减少格式漂移、丢行
  temperature,
  onClose,
  onAdopt,
}) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [copied, setCopied] = useState(false) // L8：复制成功的瞬时反馈
  const abortRef = useRef(null)
  const wasOpenRef = useRef(false)

  // 只在弹窗由关到开的那一刻用 initialPrompt 重置；弹窗开着时父组件上游文本变化不会覆盖用户已改的提示词（item 28）
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPrompt(initialPrompt)
      // H8：重开不再无条件清空 reply——上次已生成(可能已烧 token)的回复保留，避免"生成完未采纳、关掉重开就全丢"。
      //   提示词仍重置为最新 initialPrompt；若与保留的 reply 不对应，用户可点「重发」。(C1 已另外堵住遮罩误触关闭)
      setError('')
      setSending(false)
      setTruncated(false)
    }
    wasOpenRef.current = open
  }, [open, initialPrompt])

  // 关弹窗即中止在跑的请求，避免后台空跑浪费额度、也避免回复写回已关闭的弹窗
  useEffect(() => {
    if (!open) abortRef.current?.abort()
  }, [open])

  const send = async () => {
    if (!writerConfig().key) {
      setError('还没有设置写作引擎的 API Key。请先到「我的」页设置，再回来发送。')
      return
    }
    setSending(true)
    const prevReply = reply // M19：暂存旧回复，请求失败(非用户中断)时回填，避免"点重发→失败→连上次回复也丢、采纳按钮同时失效"
    setReply('')
    setError('')
    setTruncated(false)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const finish = {}
    try {
      const messages = []
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
      messages.push({ role: 'user', content: prompt })
      await chatStream({ messages, onDelta: setReply, signal: ctrl.signal, finishInfo: finish, maxTokens: 16000, thinking, temperature })
      if (finish.truncated || finish.incomplete) setTruncated(true)
    } catch (e) {
      // C2：手动点「停止」(或看门狗 abort) 会留下已流式生成的半截 reply，但此处 catch 到的是 AbortError、
      // await 之后的 setTruncated 永不执行 ⟹ 半截稿会被当成完整结果直接采纳。在 abort 分支补标记截断。
      if (e?.name === 'AbortError') setTruncated(true)
      else { setError(e?.message || String(e)); setReply(prevReply) } // M19：非中断的失败回填旧回复，不让用户既丢新结果又丢旧结果
    } finally {
      setSending(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  // L8：复制按钮原来 `navigator.clipboard?.writeText(reply)` 不处理失败也不提示——非安全上下文(http 局域网 IP / file://)下 clipboard 为 undefined 点了没反应，
  //   writeText 的 promise reject 也是未处理 rejection。这里 try/catch +「已复制」瞬时提示，失败时给出手动复制的引导。
  const doCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(reply)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败（当前环境不支持剪贴板或权限被拒），请在回复区手动选中文本复制。')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={sending || reply ? undefined : onClose}>
      <div
        className="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">{title}</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1 text-xs font-medium text-stone-500">提示词（发送前可自由修改）</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={9}
              className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-[13px] leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200"
            />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-stone-500">AI 回复{sending ? '（生成中…）' : ''}</div>
            <div className="min-h-[140px] whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm leading-relaxed text-ink">
              {reply || (sending ? '' : '（点「发送」后在此流式显示）')}
            </div>
            {truncated && (
              <div className="mt-1 text-xs text-amber-600">回复可能被截断或未完整结束（末尾不完整），请检查后再采纳，或点「发送」重试。</div>
            )}
            {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button
            onClick={doCopy}
            disabled={!reply}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-40"
          >
            {copied ? '已复制' : '复制回复'}
          </button>
          <button
            onClick={sending ? stop : send}
            disabled={sending ? false : !prompt.trim()}
            className={`rounded-lg border px-4 py-1.5 text-sm disabled:opacity-40 ${
              sending
                ? 'border-red-400 bg-stone-100 text-red-400 hover:bg-stone-200'
                : 'border-stone-300 bg-stone-50 text-stone-700 hover:border-stone-400 hover:bg-stone-100'
            }`}
          >
            {sending ? '停止' : reply ? '重发' : '发送'}
          </button>
          {onAdopt && (
            <button
              onClick={() => onAdopt(reply, prompt)}
              disabled={!reply || sending}
              className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:opacity-40"
            >
              采纳
            </button>
          )}
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
