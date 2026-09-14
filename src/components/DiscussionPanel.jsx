// 剧情讨论面板：绑定本书全部档案（梗概/滚动摘要/最近章节/伏笔/故事线）的自由对话。
// 定位是"能商量剧情的合著编辑"：给选项、给推演、不替作者拍板；聊天记录随书持久化（最近 60 条）。
import { useEffect, useRef, useState } from 'react'
import { chatStream } from '../lib/llm.js'
import { discussionSystem } from '../lib/prompts.js'
import Ic from './Ic.jsx'

const QUICKS = [
  '当前卡文了，给我 3 个下一章的破局方向，各带后续 2 章推演',
  '最近几章的节奏怎么样？哪里可能让读者弃书？',
  '主角现在的动机还成立吗？有没有行为与人设矛盾的地方？',
  '未回收的伏笔里，哪条最适合在接下来 3 章内兑现？怎么兑？',
]

export default function DiscussionPanel({ project, saveProject, apiKey, onNeedKey, onClose }) {
  const messages = project?.discussion || []
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const abortRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length, busy])

  const send = async (text) => {
    const q = (text ?? input).trim()
    if (!q || busy) return
    if (!apiKey) return onNeedKey?.()
    setErr('')
    setInput('')
    const userMsg = { role: 'user', content: q, at: Date.now() }
    const history = [...messages, userMsg].slice(-60)
    await saveProject({ ...project, discussion: history, updatedAt: Date.now() })
    setBusy(true)
    abortRef.current = new AbortController()
    let acc = ''
    try {
      const sys = discussionSystem({
        synopsis: project.synopsis,
        rollingSummary: project.rollingSummary,
        chapters: (project.chapters || []).slice(-6),
        foreshadows: (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
        storylines: project.storylines || [],
        characters: project.characters || [],
      })
      // 历史只带最近 10 轮进上下文，防止讨论本身撞爆窗口
      const hist = history.slice(0, -1).slice(-10).map((m) => ({ role: m.role, content: m.content }))
      const res = await chatStream({
        apiKey,
        messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: q }],
        temperature: 0.8,
        signal: abortRef.current.signal,
        onDelta: (t) => {
          acc = t
          // 流式回显：只更新最后一条占位消息，结束后统一落库（避免高频写 IndexedDB）
          setStreamingPreview(t)
        },
      })
      await saveProject({ ...project, discussion: [...history, { role: 'assistant', content: res || acc, at: Date.now() }].slice(-60), updatedAt: Date.now() })
    } catch (e) {
      if (e.name === 'AbortError') {
        if (acc) await saveProject({ ...project, discussion: [...history, { role: 'assistant', content: acc, at: Date.now() }].slice(-60) })
      } else {
        setErr(e.message)
      }
    } finally {
      setStreamingPreview('')
      abortRef.current = null
      setBusy(false)
    }
  }

  const [streamingPreview, setStreamingPreview] = useState('')

  const clearAll = async () => {
    if (!window.confirm('清空本书的全部讨论记录？')) return
    await saveProject({ ...project, discussion: [], updatedAt: Date.now() })
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex h-[70vh] w-[min(480px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-[#fbf8ef] shadow-xl">
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <h3 className="text-sm font-bold"><Ic n="thread" /> 剧情讨论（AI 熟悉本书全部档案）</h3>
        <div className="flex items-center gap-2">
          <button onClick={clearAll} className="text-xs text-stone-400 underline hover:text-stone-600">清空记录</button>
          <button onClick={onClose} className="rounded-full px-2 py-1 text-stone-500 hover:bg-stone-100"><Ic n="x" /></button>
        </div>
      </div>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !streamingPreview && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-stone-400">
              和熟悉这本书的编辑聊聊：剧情分支、人物动机、卡文破局、伏笔兑现时机。它只给选项和推演，拍板权永远在你。
            </p>
            {QUICKS.map((q, i) => (
              <button key={i} onClick={() => send(q)} disabled={busy || !apiKey} className="block w-full rounded-xl border border-stone-200 bg-white p-2.5 text-left text-xs leading-relaxed text-stone-600 hover:border-stone-400 disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'bg-stone-800 text-white' : 'border border-stone-200 bg-white text-stone-700'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {streamingPreview && (
          <div className="flex justify-start">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs leading-relaxed text-stone-700">{streamingPreview}</div>
          </div>
        )}
        {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      </div>
      <div className="border-t border-stone-200 p-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="聊聊剧情，例如：主角该不该在这里暴露身份…"
            className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-xs focus:border-stone-500 focus:outline-none"
          />
          {busy ? (
            <button onClick={() => abortRef.current?.abort()} className="rounded-full border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
              停止
            </button>
          ) : (
            <button onClick={() => send()} disabled={!input.trim() || !apiKey} className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
