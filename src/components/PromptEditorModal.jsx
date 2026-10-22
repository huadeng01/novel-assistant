import { useEffect, useRef, useState } from 'react'
import { chatStream, writerConfig } from '../lib/llm.js'

const promptFingerprint = (s) => {
  const t = String(s == null ? '' : s)
  return `${t.length}:${t.slice(0, 16)}:${t.slice(-16)}`
}

// 通用"提示词透明"弹窗：所有 AI 调用前弹出，展示即将发送的提示词供用户编辑，
// 发送后流式显示回复。是新范式（人在环路、告别暗箱）的核心交互组件。
export default function PromptEditorModal({
  open,
  title = '提示词',
  initialPrompt = '',
  systemPrompt = '',
  thinking = false,
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
  const [empty, setEmpty] = useState(false)
  const [replyFp, setReplyFp] = useState('')
  const [copied, setCopied] = useState(false)
  const abortRef = useRef(null)
  const wasOpenRef = useRef(false)
  // 尾批[1]：追踪本次流式已生成的半截正文——catch 里的 `reply` 闭包是 send() 开始时的旧值(已 setReply(''))，
  //   读不到流式过程中累积的内容，故用 ref 实时记录，非中断失败时据此判断「有没有半截稿值得保留」。
  const replyRef = useRef('')
  const copyTimerRef = useRef(null) // L：「已复制」1.5s 复位定时器——卸载时清掉，避免对已卸载组件 setCopied

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPrompt(initialPrompt)
      setError('')
      setSending(false)
      setEmpty(false)
      //   否则上次的半截稿重开后"可能被截断"警告消失、采纳按钮照常可点，用户会把半截稿当完整结果采纳。
    }
    wasOpenRef.current = open
  }, [open, initialPrompt])

  // L：卸载清理复制提示定时器
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  // 关弹窗即中止在跑的请求，避免后台空跑浪费额度、也避免回复写回已关闭的弹窗
  useEffect(() => {
    if (!open) abortRef.current?.abort()
  }, [open])

  //   onDelta 还对已卸载组件 setReply。补一个仅卸载触发的 abort cleanup。此修在共享组件里，覆盖所有用 PromptEditorModal 的页面(含 A 区)。
  //   abort 后 chatStream 抛 AbortError，已被 send() 的 catch 静默处理(PE8：标 truncated、不报错)；卸载后 setState 在 React18 是静默 no-op。
  useEffect(() => () => abortRef.current?.abort(), [])

  const send = async () => {
    if (!writerConfig().key) {
      setError('还没有设置写作引擎的 API Key。请先到「我的」页设置，再回来发送。')
      return
    }
    setSending(true)
    const prevReply = reply
    const prevFp = replyFp
    setReply('')
    replyRef.current = '' // 尾批[1]：清空半截追踪，与 setReply('') 同步
    setError('')
    setTruncated(false)
    setEmpty(false)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const finish = {}
    try {
      const messages = []
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
      messages.push({ role: 'user', content: prompt })
      await chatStream({ messages, onDelta: (t) => { replyRef.current = t; setReply(t) }, signal: ctrl.signal, finishInfo: finish, maxTokens: 16000, thinking, temperature })
      if (finish.truncated || finish.incomplete) setTruncated(true)
      setEmpty(!!finish.empty)
      setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt))
    } catch (e) {
      // await 之后的 setTruncated 永不执行 ⟹ 半截稿会被当成完整结果直接采纳。在 abort 分支补标记截断。
      // PE8：看门狗超时抛的是 TimeoutError（非 AbortError），同样会留下半截 reply——原来走 else 分支 setReply(prevReply)
      //   把半截稿丢掉、truncated 也已在 send 开头清空 ⟹ 用户既丢了这次已烧 token 的半截稿、又看不到截断警告。与 AbortError 同路处理。
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        //   空回复框配"回复可能被截断"警告是误导（根本没有内容可截断）。有半截稿才置 truncated + 指纹（可采纳、带截断警告）。
        if (replyRef.current && replyRef.current.trim()) {
          setTruncated(true)
          setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt))
        } else {
          setEmpty(true)
        }
      } else {
        // 尾批[1]：非中断失败（网络断 / HTTP 错 / 流式中途报错）——若已流式生成了半截正文，保留它供用户抢救（标截断），
        setError(e?.message || String(e))
        const partial = replyRef.current
        if (partial && partial.trim()) {
          setTruncated(true)
          setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt)) // 半截稿对应当前 system+user
          // reply 已是半截稿（onDelta 设过），不覆盖
        } else {
          setReply(prevReply)
          setReplyFp(prevFp)
        }
      }
    } finally {
      setSending(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  //   writeText 的 promise reject 也是未处理 rejection。这里 try/catch +「已复制」瞬时提示，失败时给出手动复制的引导。
  const doCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(reply)
      setCopied(true)
      clearTimeout(copyTimerRef.current) // L：连点复制时先清上一个定时器，避免提前把「已复制」打回
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败（当前环境不支持剪贴板或权限被拒），请在回复区手动选中文本复制。')
    }
  }

  if (!open) return null

  const replyStale = !!reply && replyFp !== promptFingerprint(systemPrompt + '\0' + prompt)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={sending || reply ? undefined : onClose} role="dialog" aria-modal="true" aria-label={title}>
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
              {reply || (sending ? '' : empty ? '（AI 未返回任何正文）' : '（点「发送」后在此流式显示）')}
            </div>
            {empty && (
              <div className="mt-1 text-xs text-amber-600">AI 返回空稿（模型未产出任何正文）——可能是思考模式耗尽了输出预算、提示词触发了内容过滤、或模型拒答。请点「重发」重试；若反复如此，可调整或缩短提示词。</div>
            )}
            {truncated && (
              <div className="mt-1 text-xs text-amber-600">回复可能被截断或未完整结束（末尾不完整），请检查后再采纳，或点「发送」重试。</div>
            )}
            {replyStale && (
              <div className="mt-1 text-xs text-red-500">此回复对应上一次的提示词（提示词已重置或被编辑），与当前不匹配——「采纳」已禁用，请点「重发」用当前提示词重新生成后再采纳。</div>
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
              //   ContinuePage 资产分析据此把「第1段」纳入 truncSegs（原来只报第2..N段、漏报首段）。附加参数向后兼容，其余 onAdopt 消费方忽略即可。
              onClick={() => onAdopt(reply, prompt, { truncated, empty })}
              disabled={!reply || sending || replyStale}
              title={replyStale ? '此回复对应上一次的提示词，与当前不匹配；点「重发」重新生成后再采纳' : undefined}
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
