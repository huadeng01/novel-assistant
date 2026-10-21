import { useEffect, useRef, useState } from 'react'
import { chatStream, writerConfig } from '../lib/llm.js'

// M3：reply 对应的 prompt 指纹（长度 + 首尾各 16 字）——判断"当前编辑的提示词"与"已生成的 reply"是否还对应。
//   H8 让重开保留 reply，但重开时 prompt 会重置为最新 initialPrompt（或用户又编辑过），旧 reply 就配不上新提示词；
//   指纹不匹配时禁止「采纳」，避免把上一次提示词的产物写进当前章。
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
  const [empty, setEmpty] = useState(false) // item21：消费 llm.js 的 finish.empty——AI 全程无正文时置真，回复区显式区分「AI 返回空稿」与「还没发送」
  const [replyFp, setReplyFp] = useState('') // M3：当前 reply 是基于哪个 prompt 生成的（指纹）；与 prompt 不匹配时禁止采纳
  const [copied, setCopied] = useState(false) // L8：复制成功的瞬时反馈
  const abortRef = useRef(null)
  const wasOpenRef = useRef(false)
  // 尾批[1]：追踪本次流式已生成的半截正文——catch 里的 `reply` 闭包是 send() 开始时的旧值(已 setReply(''))，
  //   读不到流式过程中累积的内容，故用 ref 实时记录，非中断失败时据此判断「有没有半截稿值得保留」。
  const replyRef = useRef('')
  const copyTimerRef = useRef(null) // L：「已复制」1.5s 复位定时器——卸载时清掉，避免对已卸载组件 setCopied

  // 只在弹窗由关到开的那一刻用 initialPrompt 重置；弹窗开着时父组件上游文本变化不会覆盖用户已改的提示词（item 28）
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPrompt(initialPrompt)
      // H8：重开不再无条件清空 reply——上次已生成(可能已烧 token)的回复保留，避免"生成完未采纳、关掉重开就全丢"。
      //   提示词仍重置为最新 initialPrompt；若与保留的 reply 不对应，用户可点「重发」。(C1 已另外堵住遮罩误触关闭)
      setError('')
      setSending(false)
      // 次修13②（第十一轮·存疑F）：重开是新会话（prompt 已重置为 initialPrompt），上次「空稿」的 amber 提示不该继续挂着 → 一并重置 empty。
      //   与下面 truncated 不同：empty 意味着 reply=''（无任何内容可保留），重置安全；truncated 配对的是 H8 保留的半截稿，故 #10 刻意不重置 truncated。
      setEmpty(false)
      // #10(H8 回归)：truncated 必须与 reply 成对——H8 已让重开保留 reply，这里就不能再把 truncated 重置为 false，
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

  // M2：组件随页面卸载时 open 不变(仍 true)，上面那个 [open] effect 不触发 → 在飞的流式请求(如资产分析第 1 段)继续跑白烧额度、
  //   onDelta 还对已卸载组件 setReply。补一个仅卸载触发的 abort cleanup。此修在共享组件里，覆盖所有用 PromptEditorModal 的页面(含 A 区)。
  //   abort 后 chatStream 抛 AbortError，已被 send() 的 catch 静默处理(PE8：标 truncated、不报错)；卸载后 setState 在 React18 是静默 no-op。
  useEffect(() => () => abortRef.current?.abort(), [])

  const send = async () => {
    if (!writerConfig().key) {
      setError('还没有设置写作引擎的 API Key。请先到「我的」页设置，再回来发送。')
      return
    }
    setSending(true)
    const prevReply = reply // M19：暂存旧回复，请求失败(非用户中断)时回填，避免"点重发→失败→连上次回复也丢、采纳按钮同时失效"
    const prevFp = replyFp // M3：与 prevReply 成对暂存指纹
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
      setEmpty(!!finish.empty) // item21：空稿标记（llm.js finish.empty=!full）。与 incomplete 互斥（incomplete 要求 full 非空）；但与 truncated **不互斥**——
      //   第十轮订正：truncated=(finishReason==='length') 不要求 full 非空，思考耗尽输出预算时 finishReason='length'(truncated) 而 full=''(empty) 同真 ⟹ 空稿 + 截断两提示同屏（各自表意、不冲突，原注释误称三者互斥）。
      setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt)) // M3+PE9：这份 reply 对应当前 system+user（system 换了指纹也换）
    } catch (e) {
      // C2：手动点「停止」(或看门狗 abort) 会留下已流式生成的半截 reply，但此处 catch 到的是 AbortError、
      // await 之后的 setTruncated 永不执行 ⟹ 半截稿会被当成完整结果直接采纳。在 abort 分支补标记截断。
      // PE8：看门狗超时抛的是 TimeoutError（非 AbortError），同样会留下半截 reply——原来走 else 分支 setReply(prevReply)
      //   把半截稿丢掉、truncated 也已在 send 开头清空 ⟹ 用户既丢了这次已烧 token 的半截稿、又看不到截断警告。与 AbortError 同路处理。
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        // 次修13①（第十一轮·存疑F）：首个 delta 前就停止/超时（replyRef 为空、无半截稿）→ 置 empty（走"AI 返回空稿"提示）而非 truncated——
        //   空回复框配"回复可能被截断"警告是误导（根本没有内容可截断）。有半截稿才置 truncated + 指纹（可采纳、带截断警告）。
        if (replyRef.current && replyRef.current.trim()) {
          setTruncated(true)
          setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt)) // M3+PE9：半截 reply 仍对应当前 system+user（可采纳，但带截断警告）
        } else {
          setEmpty(true)
        }
      } else {
        // 尾批[1]：非中断失败（网络断 / HTTP 错 / 流式中途报错）——若已流式生成了半截正文，保留它供用户抢救（标截断），
        //   不再无条件 setReply(prevReply) 把这次已烧 token 的半截稿覆盖成旧稿。只有本次一个字都没出来时才回填旧稿(M19)。
        setError(e?.message || String(e))
        const partial = replyRef.current
        if (partial && partial.trim()) {
          setTruncated(true)
          setReplyFp(promptFingerprint(systemPrompt + '\0' + prompt)) // 半截稿对应当前 system+user
          // reply 已是半截稿（onDelta 设过），不覆盖
        } else {
          setReply(prevReply) // M19：本次无任何新内容，回填旧回复，不让用户既丢新结果又丢旧结果
          setReplyFp(prevFp) // M3：指纹与 reply 成对回填，保持对应关系
        }
      }
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
      clearTimeout(copyTimerRef.current) // L：连点复制时先清上一个定时器，避免提前把「已复制」打回
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败（当前环境不支持剪贴板或权限被拒），请在回复区手动选中文本复制。')
    }
  }

  if (!open) return null

  // M3+PE9：当前 system+user 与 reply 的指纹不匹配 = 这份 reply 是上一次提示词生成的（H8 重开保留 reply 但 prompt/system 已重置或被编辑）→ 禁止采纳
  const replyStale = !!reply && replyFp !== promptFingerprint(systemPrompt + '\0' + prompt)

  return (
    // C2（审计轮5 记接受、不改）：遮罩用 `sending || reply ? undefined : onClose` 而非别处的 edited 脏检查——
    //   本弹窗的诉求是「生成中 / 已有回复时别误点遮罩关掉丢了回复」，sending||reply 正好覆盖；重开重置 prompt 为最新 initialPrompt 是 item28 既有取舍(非回归)。
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
              // item23：onAdopt 增回传第3参 {truncated, empty}——首段在本弹窗生成，其截断/空稿状态不经调用方的分段循环；
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
