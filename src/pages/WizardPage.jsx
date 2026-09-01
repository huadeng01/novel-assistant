import { useEffect, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatStream, chatJSON } from '../lib/llm.js'
import { GENRES, TONES, synopsisMessages, worldMessages, outlineMessages, draftMessages, chapterSummaryMessages, timelineMessages } from '../lib/prompts.js'
import { downloadText, countWords, uid } from '../lib/utils.js'
import { loadWizardState, saveWizardState } from '../lib/backup.js'
import { put } from '../lib/db.js'
import { newProject } from '../lib/longform.js'

const STEPS = [
  { id: 1, label: '故事创意' },
  { id: 2, label: '世界观设定' },
  { id: 3, label: '章节细纲' },
  { id: 4, label: '章节初稿' },
  { id: 5, label: '时间线与看板' },
]

const DEFAULT_STATE = { step: 1, idea: '', genre: GENRES[0], tone: TONES[0], synopsis: '', world: '', outline: '', outlineCount: 5, chapter: 1, draft: '', drafts: {}, timeline: '' }

export default function WizardPage({ apiKey, onNeedKey, onOpenLongForm }) {
  const lib = useLibrary()
  const [st, setSt] = useState(() => ({ ...DEFAULT_STATE, ...loadWizardState() }))
  const [streaming, setStreaming] = useState(false)
  const [err, setErr] = useState('')
  // 数字输入框用独立的字符串态：允许输入中清空，失焦时才校验回弹，避免“删完自动回弹/输入 51 变 20”的糟糕体验
  const [outlineCountStr, setOutlineCountStr] = useState(() => String(st.outlineCount))
  const [chapterStr, setChapterStr] = useState(() => String(st.chapter))

  // 向导进度自动持久化（防抖 800ms，避免流式生成时每个字都写 localStorage）
  useEffect(() => {
    const t = setTimeout(() => saveWizardState(st), 800)
    return () => clearTimeout(t)
  }, [st])

  const patch = (p) => setSt((s) => ({ ...s, ...p }))

  const commitOutlineCount = () => {
    if (!outlineCountStr.trim()) {
      setOutlineCountStr(String(st.outlineCount))
      return
    }
    const n = Math.min(20, Math.max(3, Number(outlineCountStr)))
    patch({ outlineCount: n })
    setOutlineCountStr(String(n))
  }

  const commitChapter = () => {
    if (!chapterStr.trim()) {
      setChapterStr(String(st.chapter))
      return
    }
    const n = Math.min(st.outlineCount, Math.max(1, Number(chapterStr)))
    patch({ chapter: n })
    setChapterStr(String(n))
  }

  const runStream = async (messages, field, temperature) => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    setErr('')
    setStreaming(true)
    patch({ [field]: '' })
    try {
      await chatStream({
        apiKey,
        messages,
        temperature,
        onDelta: (full) => patch({ [field]: full }),
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      setStreaming(false)
    }
  }

  const { step } = st
  const canNext = { 1: !!st.synopsis, 2: !!st.world, 3: !!st.outline, 4: Object.keys(st.drafts).length > 0, 5: false }[step]

  // 第五步：把已存档各章摘要串成细粒度完整时间线（标注因果与伏笔呼应）
  const runTimeline = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    const chapterSummaries = Object.entries(st.drafts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([no, d]) => ({ no: Number(no), summary: d.summary || (d.content || '').slice(0, 200) }))
    if (!chapterSummaries.length) {
      setErr('请先在第四章存档至少一章初稿，才能梳理时间线。')
      return
    }
    setErr('')
    setStreaming(true)
    patch({ timeline: '' })
    try {
      await chatStream({
        apiKey,
        messages: timelineMessages({ chapterSummaries }),
        temperature: 0.4,
        onDelta: (full) => patch({ timeline: full }),
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      setStreaming(false)
    }
  }

  // 看板诊断输入：各章摘要 + 当前初稿尾部；背景用梗概 + 细纲约束，避免 AI 脑补未写内容
  const diagnoseText = [
    ...Object.entries(st.drafts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([no, d]) => `第${no}章摘要：${d.summary || (d.content || '').slice(0, 200)}`),
    st.draft ? `当前初稿结尾：${st.draft.slice(-2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const diagnoseContext = [st.synopsis && `【故事梗概】${st.synopsis.slice(0, 500)}`, st.outline && `【章节细纲】${st.outline.slice(0, 1500)}`]
    .filter(Boolean)
    .join('\n')

  // 生成章节初稿：第 2 章起自动注入前文各章摘要 + 上一章结尾，保证前后章节衔接连贯；
  // 完成后自动解析标题、生成章节摘要并存档到 drafts（供后续章节作上下文）
  const runDraft = async (targetNo) => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (!st.outline) {
      setErr('请先在第三步生成章节细纲。')
      return
    }
    const no = targetNo || st.chapter
    setErr('')
    setStreaming(true)
    patch({ draft: '' })
    const prevChapters = Object.entries(st.drafts)
      .filter(([n]) => Number(n) < no)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([n, d]) => ({ no: Number(n), summary: d.summary || (d.content || '').slice(0, 100) }))
    const prevDraft = st.drafts[no - 1]
    const prevTail = prevDraft ? (prevDraft.content || '').slice(-1200) : ''
    try {
      const full = await chatStream({
        apiKey,
        messages: draftMessages({
          synopsis: st.synopsis,
          world: st.world,
          outline: st.outline,
          chapter: no,
          style: lib.style?.profile,
          forbidden: lib.style?.forbidden,
          prevChapters,
          prevTail,
        }),
        temperature: 0.9,
        onDelta: (f) => patch({ draft: f }),
      })
      // 解析第一行作为标题（兼容“第1章”与“第一章”等中文数字写法），并为本章生成摘要存档（供后续章节保持连贯）
      const firstLine = ((full || '').split('\n').find((l) => l.trim()) || '').trim()
      const title = /^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章/.test(firstLine) ? firstLine : `第${no}章`
      let summary = ''
      try {
        summary = (await chatJSON({ apiKey, messages: chapterSummaryMessages({ text: full }), temperature: 0.3 })).summary || ''
      } catch {
        /* 摘要失败不阻塞存档 */
      }
      setSt((s) => ({ ...s, draft: full, drafts: { ...s.drafts, [no]: { title, content: full, summary } } }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setStreaming(false)
    }
  }

  // 一键写下一章：章号 +1 并直接开始生成（上下文自动包含已存档的各章摘要）
  const writeNext = () => {
    const next = st.chapter + 1
    patch({ chapter: next })
    setChapterStr(String(next))
    runDraft(next)
  }

  // 转入长篇写作：把向导产出的设定与已写章节打包成长篇项目，后续由一致性档案接手连载
  const migrateToLongForm = async () => {
    const entries = Object.entries(st.drafts).sort(([a], [b]) => Number(a) - Number(b))
    if (!entries.length) return
    const proj = newProject(st.idea.trim().slice(0, 20) || '新手写作迁移')
    proj.synopsis = st.synopsis
    proj.world = st.world
    proj.outline = st.outline
    proj.chapters = entries.map(([no, d]) => ({
      id: uid(),
      chapterNo: Number(no),
      title: d.title || `第${no}章`,
      content: d.content || '',
      wordCount: countWords(d.content || ''),
      summary: d.summary || '',
      issueCount: 0,
      createdAt: Date.now(),
    }))
    await put('projects', proj)
    localStorage.setItem('na_open_project', proj.id)
    onOpenLongForm && onOpenLongForm()
  }

  const savedDrafts = Object.entries(st.drafts).sort(([a], [b]) => Number(a) - Number(b))

  const chip = (active) =>
    `rounded-full px-3.5 py-2 text-sm transition-colors ${active ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-600 hover:bg-stone-50'}`

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} />

        <div className="min-w-0 space-y-4">
          {/* 步骤条 */}
          <nav className="flex gap-2 overflow-x-auto rounded-2xl bg-[#fbf8ef] p-3 shadow-sm">
            {STEPS.map((s) => (
              <button
                key={s.id}
                onClick={() => !streaming && patch({ step: s.id })}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors ${
                  step === s.id ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100'
                }`}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${step === s.id ? 'bg-[#fbf8ef]/20' : 'bg-stone-200'}`}>
                  {s.id}
                </span>
                {s.label}
              </button>
            ))}
          </nav>

          {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}

          {/* 第一步：故事创意 */}
          {step === 1 && (
            <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
              <h2 className="text-base font-bold"><Ic n="bulb" /> 用一句话描述你的故事</h2>
              <textarea
                value={st.idea}
                onChange={(e) => patch({ idea: e.target.value })}
                placeholder="例如：一个外卖员意外捡到能预知死亡的手机，从此卷入一场超自然博弈…"
                rows={3}
                className="w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none"
              />
              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">选择题材</p>
                <div className="flex flex-wrap gap-2">
                  {GENRES.map((g) => (
                    <button key={g} onClick={() => patch({ genre: g })} className={chip(st.genre === g)}>
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">选择基调</p>
                <div className="flex flex-wrap gap-2">
                  {TONES.map((t) => (
                    <button key={t} onClick={() => patch({ tone: t })} className={chip(st.tone === t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => runStream(synopsisMessages({ idea: st.idea, genre: st.genre, tone: st.tone }), 'synopsis', 0.9)}
                disabled={streaming || st.idea.trim().length < 5}
                className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {streaming ? 'AI 扩写中…' : '生成故事梗概'}
              </button>
              {st.synopsis && (
                <div>
                  <p className="mb-2 text-xs font-semibold text-stone-500">故事梗概（可直接编辑）</p>
                  <textarea
                    value={st.synopsis}
                    onChange={(e) => patch({ synopsis: e.target.value })}
                    disabled={streaming}
                    rows={10}
                    className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                  />
                </div>
              )}
            </section>
          )}

          {/* 第二步：世界观 */}
          {step === 2 && (
            <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
              <h2 className="text-base font-bold"><Ic n="globe" /> 世界观与人物卡</h2>
              <p className="text-xs text-stone-400">基于你的故事梗概生成世界观与主要人物设定，生成后可自由编辑。</p>
              <button
                onClick={() => runStream(worldMessages({ synopsis: st.synopsis }), 'world', 0.8)}
                disabled={streaming || !st.synopsis}
                className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {streaming ? 'AI 构建中…' : st.world ? '重新生成世界观' : '生成世界观设定'}
              </button>
              {st.world && (
                <textarea
                  value={st.world}
                  onChange={(e) => patch({ world: e.target.value })}
                  disabled={streaming}
                  rows={14}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                />
              )}
            </section>
          )}

          {/* 第三步：章节细纲 */}
          {step === 3 && (
            <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
              <h2 className="text-base font-bold"><Ic n="map" /> 章节细纲</h2>
              <div className="flex items-center gap-3">
                <label className="text-sm text-stone-600">生成前</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={outlineCountStr}
                  onChange={(e) => setOutlineCountStr(e.target.value.replace(/\D/g, ''))}
                  onBlur={commitOutlineCount}
                  onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                  placeholder="3~20"
                  className="w-20 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                />
                <label className="text-sm text-stone-600">章细纲</label>
                <span className="text-xs text-stone-400">支持 3~20 章，超出范围失焦后会自动回弹到边界值</span>
              </div>
              <button
                onClick={() => runStream(outlineMessages({ synopsis: st.synopsis, world: st.world, count: st.outlineCount }), 'outline', 0.7)}
                disabled={streaming || !st.world}
                className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {streaming ? 'AI 编排中…' : st.outline ? '重新生成细纲' : '生成章节细纲'}
              </button>
              {st.outline && (
                <textarea
                  value={st.outline}
                  onChange={(e) => patch({ outline: e.target.value })}
                  disabled={streaming}
                  rows={14}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                />
              )}
            </section>
          )}

          {/* 第四步：章节初稿 */}
          {step === 4 && (
            <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold"><Ic n="book" /> 章节初稿</h2>
                {lib.selectedBook && lib.style ? (
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">初稿将贴合《{lib.selectedBook.name}》文风</span>
                ) : (
                  <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">在左侧选择并分析一本小说，初稿会更贴近你的文风</span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-stone-400">
                每章生成后会自动存档并提取摘要；写后续章节时，前文各章摘要与上一章结尾会自动注入上下文，保证剧情衔接连贯。
              </p>
              {st.chapter > 10 && (
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
                  已超过 10 章：建议转入「长篇写作」模式继续连载，那里有滚动摘要、伏笔账本与一致性校验自动维护连贯性。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm text-stone-600">撰写第</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={chapterStr}
                  onChange={(e) => setChapterStr(e.target.value.replace(/\D/g, ''))}
                  onBlur={commitChapter}
                  onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                  placeholder={`1~${st.outlineCount}`}
                  className="w-20 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                />
                <label className="text-sm text-stone-600">章</label>
                <span className="text-xs text-stone-400">可清空重输，失焦时自动校验</span>
                {st.draft && !streaming && (
                  <button
                    onClick={() => downloadText(`第${st.chapter}章初稿.txt`, st.draft)}
                    className="ml-auto rounded-full border border-stone-300 px-4 py-2 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    导出 txt
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => runDraft()}
                  disabled={streaming || !st.outline}
                  className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {streaming ? 'AI 撰写中…' : st.drafts[st.chapter] ? '重新生成本章初稿' : '生成章节初稿'}
                </button>
                {st.drafts[st.chapter] && !streaming && st.chapter < st.outlineCount && (
                  <button
                    onClick={writeNext}
                    className="rounded-full border-2 border-stone-800 px-6 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100"
                  >
                    <Ic n="pen" /> 保存完毕，继续写第 {st.chapter + 1} 章
                  </button>
                )}
                {savedDrafts.length > 0 && (
                  <button
                    onClick={migrateToLongForm}
                    className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-600 hover:bg-stone-50"
                  >
                    <Ic n="mountain" /> 转入长篇写作继续连载（已存 {savedDrafts.length} 章）
                  </button>
                )}
              </div>
              {st.draft && (
                <textarea
                  value={st.draft}
                  onChange={(e) => patch({ draft: e.target.value })}
                  disabled={streaming}
                  rows={18}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                />
              )}
              {savedDrafts.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold text-stone-500"><Ic n="ok" /> 已存档章节（{savedDrafts.length}，生成后自动保存，供后续章节作上下文）</p>
                  <ul className="space-y-2">
                    {savedDrafts.map(([no, d]) => (
                      <li key={no} className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 px-3 py-2 text-sm">
                        <span className="font-medium">{d.title || `第${no}章`}</span>
                        <span className="text-xs text-stone-400">{countWords(d.content)} 字</span>
                        {d.summary && <span className="min-w-0 flex-1 truncate text-xs text-stone-400">{d.summary}</span>}
                        <button
                          onClick={() => {
                            patch({ chapter: Number(no), draft: d.content })
                            setChapterStr(String(no))
                          }}
                          className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                        >
                          载入编辑
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* 第五步：完整时间线与诊断看板 */}
          {step === 5 && (
            <div className="space-y-4">
              <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                <h2 className="text-base font-bold"><Ic n="hourglass" /> 完整故事时间线</h2>
                <p className="text-xs leading-relaxed text-stone-400">
                  基于已存档各章的摘要，梳理整个故事的细粒度时间线：逐章展开关键事件、标注因果与伏笔呼应，并总结当前停在哪里。
                </p>
                <button
                  onClick={runTimeline}
                  disabled={streaming || Object.keys(st.drafts).length === 0}
                  className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {streaming ? 'AI 梳理中…' : st.timeline ? '重新梳理时间线' : '梳理完整时间线'}
                </button>
                {st.timeline && (
                  <textarea
                    value={st.timeline}
                    onChange={(e) => patch({ timeline: e.target.value })}
                    disabled={streaming}
                    rows={16}
                    className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                  />
                )}
              </section>
              <DiagnosePanel apiKey={apiKey} text={diagnoseText} context={diagnoseContext} disabled={streaming} cacheKey={`na_diag_wizard_${Object.keys(st.drafts).length}`} />
            </div>
          )}

          {/* 上一步 / 下一步 */}
          <div className="flex justify-between">
            <button
              onClick={() => patch({ step: Math.max(1, step - 1) })}
              disabled={step === 1 || streaming}
              className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-600 hover:bg-[#fbf8ef] disabled:opacity-40"
            >
              ← 上一步
            </button>
            {step < 5 && (
              <button
                onClick={() => patch({ step: step + 1 })}
                disabled={!canNext || streaming}
                className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40"
              >
                下一步 →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
