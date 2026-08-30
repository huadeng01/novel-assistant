import { useRef, useState } from 'react'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatJSON, chatStream } from '../lib/llm.js'
import { analyzeMessages, continueMessages, CONTINUE_ANGLES, followupMessages, FOLLOWUP_ANGLES, summarizeMessages } from '../lib/prompts.js'
import { copyText, countWords, mapLimit } from '../lib/utils.js'

// 原文过长时：先给前文做摘要，再拼上尾部原文发给续写
const SUMMARIZE_THRESHOLD = 8000 // 超过这个字数才做前文摘要
const TAIL_LENGTH = 4000 // 尾部原文保留字数（紧接续写处）

export default function ContinuePage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  const [text, setText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)
  const [world, setWorld] = useState('')
  const [characters, setCharacters] = useState([])
  const [outline, setOutline] = useState('')
  const [timeline, setTimeline] = useState([])
  const [versions, setVersions] = useState([])
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState('')
  const [showDialog, setShowDialog] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  // 后续版本（AI 自动探索 4 种剧情走向）
  const [followupVersions, setFollowupVersions] = useState([])
  const [followupGenerating, setFollowupGenerating] = useState(false)
  const [followupProgress, setFollowupProgress] = useState(0)
  const [newChar, setNewChar] = useState({ name: '', identity: '', personality: '', description: '' })
  const fileRef = useRef(null)

  // 导入本地文件（.txt / .md），平板走系统文件选择器
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const content = await file.text()
      if (countWords(content) < 20) {
        setErr('文件内容太少，请选择有一定篇幅的小说文件。')
        return
      }
      setText(content)
      setErr('')
    } catch {
      setErr('文件读取失败，请重试。')
    }
  }

  // 分析原文：严格只提取原文明确出现的信息，禁止捏造
  const analyze = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    setErr('')
    setAnalyzing(true)
    const truncated = text.length > ANALYZE_LIMIT
    const analyzeText = truncated ? text.slice(0, ANALYZE_LIMIT) : text
    try {
      const res = await chatJSON({ apiKey, messages: analyzeMessages({ text: analyzeText }), temperature: 0.3 })
      setWorld(res.world_setting || '')
      setCharacters(Array.isArray(res.characters) ? res.characters : [])
      setOutline(res.outline || '')
      setTimeline(Array.isArray(res.timeline) ? res.timeline : [])
      setAnalyzed(true)
      if (truncated) {
        setErr(`原文较长，已分析前 ${ANALYZE_LIMIT} 字。如需完整分析请拆分原文后重试。`)
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setAnalyzing(false)
    }
  }

  // 续写：4 个方向各自独立流式生成，并发 2，从结构上保证内容不雷同
  const generate = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入原文。')
      return
    }
    setErr('')
    setGenerating(true)
    setVersions([])
    setProgress(0)
    const style = lib.style?.profile
    const forbidden = lib.style?.forbidden
    // 原文过长时：先给前文做 AI 摘要，再拼上尾部原文（紧接续写处）
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(0, text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3 })
        summary = sumRes.summary || ''
      } catch {
        // 摘要失败不阻塞续写，降级为仅尾部截断
        summary = ''
      } finally {
        setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    const charText = characters
      .map((c) => `${c.name || ''}：${[c.identity, c.personality, c.description].filter(Boolean).join('，')}`)
      .filter(Boolean)
      .join('\n')
    try {
      await mapLimit(
        CONTINUE_ANGLES.map((a, i) => ({ a, i })),
        2,
        async ({ a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              messages: continueMessages({ text: tail, summary, world, characters: charText, outline, timeline, style, forbidden, instruction, index: i }),
              temperature: a.temp,
              onDelta: (full) => {
                setVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e.message }
              return next
            })
          } finally {
            setProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenerating(false)
    }
  }

  // 后续版本：AI 自动探索 4 种不同剧情走向（区别于自定义续写：不需要用户指令，在剧情走向上本质不同）
  const generateFollowup = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入原文。')
      return
    }
    setErr('')
    setFollowupGenerating(true)
    setFollowupVersions([])
    setFollowupProgress(0)
    const style = lib.style?.profile
    const forbidden = lib.style?.forbidden
    // 同样支持前文摘要 + 尾部全文
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(0, text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3 })
        summary = sumRes.summary || ''
      } catch {
        summary = ''
      } finally {
        setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    const charText = characters
      .map((c) => `${c.name || ''}：${[c.identity, c.personality, c.description].filter(Boolean).join('，')}`)
      .filter(Boolean)
      .join('\n')
    try {
      await mapLimit(
        FOLLOWUP_ANGLES.map((a, i) => ({ a, i })),
        2,
        async ({ a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              messages: followupMessages({ text: tail, summary, world, characters: charText, outline, timeline, style, forbidden, index: i }),
              temperature: a.temp,
              onDelta: (full) => {
                setFollowupVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e.message }
              return next
            })
          } finally {
            setFollowupProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      setErr(e.message)
    } finally {
      setFollowupGenerating(false)
    }
  }

  // 人物卡手动增删
  const addChar = () => {
    if (!newChar.name.trim()) return
    setCharacters([...characters, { ...newChar }])
    setNewChar({ name: '', identity: '', personality: '', description: '' })
  }
  const removeChar = (idx) => setCharacters(characters.filter((_, i) => i !== idx))

  const copy = async (t, btn) => {
    await copyText(t)
    if (btn) {
      btn.textContent = '已复制 ✓'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
  }

  const wordCount = countWords(text)

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} />

        <div className="space-y-4">
          {/* 原文输入 */}
          <section className="rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold">📖 粘贴或导入要续写的原文</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">{wordCount} 字</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="min-h-[40px] rounded-full border border-stone-300 px-4 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50"
                >
                  导入文件
                </button>
                <input ref={fileRef} type="file" accept=".txt,.md" className="hidden" onChange={onFile} />
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="把需要续写的小说原文粘贴到这里，或点右上角导入 .txt / .md 文件…"
              rows={8}
              className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-4 text-base focus:border-stone-500 focus:outline-none"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={analyze}
                disabled={analyzing}
                className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {analyzing ? 'AI 分析中…' : '🔍 分析原文（世界观 / 人物 / 大纲 / 故事线）'}
              </button>
              <span className="text-xs text-stone-400">分析结果可编辑，作为续写的可选上下文</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          </section>

          {/* 分析结果（可编辑） */}
          {analyzed && (
            <section className="space-y-4 rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold">📋 原文分析结果（可编辑）</h2>
                <span className="text-xs text-stone-400">留空的项 = 原文未明确提及，AI 未捏造</span>
              </div>

              {/* 世界观 */}
              <div>
                <p className="mb-1.5 text-xs font-semibold text-stone-500">🌍 世界观设定</p>
                <textarea
                  value={world}
                  onChange={(e) => setWorld(e.target.value)}
                  placeholder="原文未明确提及世界观设定，可手动补充…"
                  rows={3}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                />
              </div>

              {/* 人物卡 */}
              <div>
                <p className="mb-1.5 text-xs font-semibold text-stone-500">👤 人物卡（{characters.length}）</p>
                {characters.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-stone-300 p-3 text-xs text-stone-400">原文未分析出明确人物，可在下方手动添加。</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {characters.map((c, i) => (
                      <div key={i} className="relative rounded-xl border border-stone-200 bg-white p-3">
                        <button
                          onClick={() => removeChar(i)}
                          className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                        >
                          ✕
                        </button>
                        <p className="pr-6 text-sm font-bold text-stone-800">{c.name || '未命名'}</p>
                        {c.identity && <p className="mt-0.5 text-xs text-stone-600">身份：{c.identity}</p>}
                        {c.personality && <p className="mt-0.5 text-xs text-stone-600">性格：{c.personality}</p>}
                        {c.description && <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{c.description}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {/* 手动添加人物 */}
                <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
                  <p className="mb-2 text-xs font-semibold text-stone-500">手动添加人物</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={newChar.name}
                      onChange={(e) => setNewChar({ ...newChar, name: e.target.value })}
                      placeholder="姓名*"
                      className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                    />
                    <input
                      value={newChar.identity}
                      onChange={(e) => setNewChar({ ...newChar, identity: e.target.value })}
                      placeholder="身份 / 职业"
                      className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                    />
                    <input
                      value={newChar.personality}
                      onChange={(e) => setNewChar({ ...newChar, personality: e.target.value })}
                      placeholder="性格"
                      className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                    />
                    <input
                      value={newChar.description}
                      onChange={(e) => setNewChar({ ...newChar, description: e.target.value })}
                      placeholder="其他描述"
                      className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={addChar}
                    disabled={!newChar.name.trim()}
                    className="mt-2 min-h-[36px] rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                  >
                    + 添加人物
                  </button>
                </div>
              </div>

              {/* 大纲 */}
              <div>
                <p className="mb-1.5 text-xs font-semibold text-stone-500">🗺 故事大纲</p>
                <textarea
                  value={outline}
                  onChange={(e) => setOutline(e.target.value)}
                  placeholder="原文未明确梳理出大纲，可手动补充…"
                  rows={3}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                />
              </div>

              {/* 故事线时间线（文字为主，阶段名非真实时间） */}
              {timeline.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold text-stone-500">⏳ 故事线梳理（基于原文已发生情节，非真实时间）</p>
                  <div className="relative pl-6">
                    <div className="absolute left-[7px] top-1 bottom-1 w-0.5 bg-stone-300"></div>
                    {timeline.map((t, i) => (
                      <div key={i} className="relative mb-4 last:mb-0">
                        <div className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-500 shadow"></div>
                        <p className="text-sm font-semibold text-stone-800">{t.stage || `阶段${i + 1}`}</p>
                        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">{t.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 续写按钮区 */}
          <section className="rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold">✍️ 续写</h2>
              {lib.selectedBook && lib.style ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">将贴合《{lib.selectedBook.name}》文风</span>
              ) : (
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">在左侧选择并分析一本小说，续写会更贴合文风</span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">两个按钮任选：「自定义续写」由你在对话框中指定方向，生成 4 种叙述方式的版本；「探索后续版本」由 AI 自动探索 4 种不同剧情走向（顺势发展 / 意外变故 / 人物抉择 / 伏笔回收）。每个版本独立请求 + 不同 system prompt + 不同温度，结构上保证不雷同。</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowDialog(true)}
                disabled={generating || summarizing || followupGenerating}
                className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {summarizing && generating ? '正在摘要前文…' : generating ? `AI 续写中… ${progress}/4` : '✍️ 自定义续写'}
              </button>
              <button
                onClick={generateFollowup}
                disabled={followupGenerating || summarizing || generating}
                className="min-h-[44px] rounded-full border-2 border-stone-800 bg-transparent px-6 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
              >
                {followupGenerating ? `探索后续中… ${followupProgress}/4` : '🔮 探索后续版本'}
              </button>
              {(generating || summarizing || followupGenerating) && (
                <div className="flex items-center gap-2 text-sm text-stone-500">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                  {summarizing ? '原文较长，正在给前文做摘要…' : generating ? '正在生成自定义续写版本，可边看边等…' : '正在探索后续剧情走向，可边看边等…'}
                </div>
              )}
            </div>
          </section>

          {/* 四个续写版本卡片 */}
          {(generating || versions.length > 0) && (
            <section className="grid gap-4 sm:grid-cols-2">
              {CONTINUE_ANGLES.map((a, i) => {
                const v = versions[i]
                return (
                  <article key={i} className="flex flex-col rounded-2xl bg-[#fffaf6] shadow-sm">
                    <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                      <h3 className="text-sm font-bold">{a.title}</h3>
                      {v?.content && !v.error && (
                        <button
                          onClick={(e) => copy(v.content, e.target)}
                          className="min-h-[32px] rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                        >
                          复制
                        </button>
                      )}
                    </header>
                    {v?.error ? (
                      <div className="p-4 text-sm text-red-600">生成失败：{v.error}</div>
                    ) : v?.content ? (
                      <div className="novel-text max-h-[420px] overflow-y-auto px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed">{v.content}</div>
                    ) : generating ? (
                      <div className="flex items-center gap-2 p-4 text-sm text-stone-400">
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                        等待生成…
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </section>
          )}

          {/* 后续版本卡片（AI 自动探索 4 种剧情走向，区别于自定义续写） */}
          {(followupGenerating || followupVersions.length > 0) && (
            <section className="space-y-3">
              <h3 className="text-sm font-bold text-stone-700">🔮 后续版本（AI 自动探索 4 种剧情走向）</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {FOLLOWUP_ANGLES.map((a, i) => {
                  const v = followupVersions[i]
                  return (
                    <article key={i} className="flex flex-col rounded-2xl bg-[#fffaf6] shadow-sm">
                      <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                        <h3 className="text-sm font-bold">{a.title}</h3>
                        {v?.content && !v.error && (
                          <button
                            onClick={(e) => copy(v.content, e.target)}
                            className="min-h-[32px] rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                          >
                            复制
                          </button>
                        )}
                      </header>
                      {v?.error ? (
                        <div className="p-4 text-sm text-red-600">生成失败：{v.error}</div>
                      ) : v?.content ? (
                        <div className="novel-text max-h-[420px] overflow-y-auto px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed">{v.content}</div>
                      ) : followupGenerating ? (
                        <div className="flex items-center gap-2 p-4 text-sm text-stone-400">
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                          等待生成…
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 续写设定对话框 */}
      {showDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !generating && setShowDialog(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-[#fffaf6] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">✍️ 续写设定</h3>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              告诉 AI 你希望故事如何发展，例如：接下来主角发现了一个秘密 / 节奏加快 / 引入新冲突 / 让某人物出场 / 场景切换到某处… 不填则 AI 自由发挥。
            </p>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="输入你的续写需求或方向指令（可选）…"
              rows={5}
              className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
            />
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-stone-500">将同时生成 4 个不同版本（自然续写 / 换种写法 / 细节丰富 / 大胆发挥），通过不同温度和叙述要求保证内容各异</span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowDialog(false)}
                disabled={generating}
                className="min-h-[40px] rounded-full border border-stone-300 px-5 py-2 text-sm text-stone-600 hover:bg-stone-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowDialog(false)
                  generate()
                }}
                disabled={generating || countWords(text) < 50}
                className="min-h-[40px] rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                🚀 开始续写
              </button>
            </div>
            {countWords(text) < 50 && (
              <p className="mt-2 text-right text-xs text-red-500">请先粘贴或导入至少几十字的原文</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
