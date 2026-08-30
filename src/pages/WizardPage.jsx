import { useEffect, useState } from 'react'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatStream } from '../lib/llm.js'
import { GENRES, TONES, synopsisMessages, worldMessages, outlineMessages, draftMessages } from '../lib/prompts.js'
import { downloadText } from '../lib/utils.js'
import { loadWizardState, saveWizardState } from '../lib/backup.js'

const STEPS = [
  { id: 1, label: '故事创意' },
  { id: 2, label: '世界观设定' },
  { id: 3, label: '章节细纲' },
  { id: 4, label: '章节初稿' },
]

const DEFAULT_STATE = { step: 1, idea: '', genre: GENRES[0], tone: TONES[0], synopsis: '', world: '', outline: '', outlineCount: 5, chapter: 1, draft: '' }

export default function WizardPage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  const [st, setSt] = useState(() => ({ ...DEFAULT_STATE, ...loadWizardState() }))
  const [streaming, setStreaming] = useState(false)
  const [err, setErr] = useState('')

  // 向导进度自动持久化，刷新页面不丢
  useEffect(() => {
    saveWizardState(st)
  }, [st])

  const patch = (p) => setSt((s) => ({ ...s, ...p }))

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
  const canNext = { 1: !!st.synopsis, 2: !!st.world, 3: !!st.outline, 4: false }[step]

  const chip = (active) =>
    `rounded-full px-3.5 py-2 text-sm transition-colors ${active ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-600 hover:bg-stone-50'}`

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} />

        <div className="space-y-4">
          {/* 步骤条 */}
          <nav className="flex gap-2 overflow-x-auto rounded-2xl bg-[#fffaf6] p-3 shadow-sm">
            {STEPS.map((s) => (
              <button
                key={s.id}
                onClick={() => !streaming && patch({ step: s.id })}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors ${
                  step === s.id ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100'
                }`}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${step === s.id ? 'bg-[#fffaf6]/20' : 'bg-stone-200'}`}>
                  {s.id}
                </span>
                {s.label}
              </button>
            ))}
          </nav>

          {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}

          {/* 第一步：故事创意 */}
          {step === 1 && (
            <section className="space-y-4 rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
              <h2 className="text-base font-bold">💡 用一句话描述你的故事</h2>
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
            <section className="space-y-4 rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
              <h2 className="text-base font-bold">🌍 世界观与人物卡</h2>
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
            <section className="space-y-4 rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
              <h2 className="text-base font-bold">🗺 章节细纲</h2>
              <div className="flex items-center gap-3">
                <label className="text-sm text-stone-600">生成前</label>
                <input
                  type="number"
                  min={3}
                  max={20}
                  value={st.outlineCount}
                  onChange={(e) => patch({ outlineCount: Math.max(3, Math.min(20, Number(e.target.value) || 5)) })}
                  className="w-20 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                />
                <label className="text-sm text-stone-600">章细纲</label>
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
            <section className="space-y-4 rounded-2xl bg-[#fffaf6] p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold">📖 章节初稿</h2>
                {lib.selectedBook && lib.style ? (
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">初稿将贴合《{lib.selectedBook.name}》文风</span>
                ) : (
                  <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">在左侧选择并分析一本小说，初稿会更贴近你的文风</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm text-stone-600">撰写第</label>
                <input
                  type="number"
                  min={1}
                  max={st.outlineCount}
                  value={st.chapter}
                  onChange={(e) => patch({ chapter: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-20 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                />
                <label className="text-sm text-stone-600">章</label>
                {st.draft && !streaming && (
                  <button
                    onClick={() => downloadText(`第${st.chapter}章初稿.txt`, st.draft)}
                    className="ml-auto rounded-full border border-stone-300 px-4 py-2 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    导出 txt
                  </button>
                )}
              </div>
              <button
                onClick={() =>
                  runStream(
                    draftMessages({
                      synopsis: st.synopsis,
                      world: st.world,
                      outline: st.outline,
                      chapter: st.chapter,
                      style: lib.style?.profile,
                      forbidden: lib.style?.forbidden,
                    }),
                    'draft',
                    0.9,
                  )
                }
                disabled={streaming || !st.outline}
                className="rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {streaming ? 'AI 撰写中…' : st.draft ? '重新生成初稿' : '生成章节初稿'}
              </button>
              {st.draft && (
                <textarea
                  value={st.draft}
                  onChange={(e) => patch({ draft: e.target.value })}
                  disabled={streaming}
                  rows={18}
                  className="novel-text w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                />
              )}
            </section>
          )}

          {/* 上一步 / 下一步 */}
          <div className="flex justify-between">
            <button
              onClick={() => patch({ step: Math.max(1, step - 1) })}
              disabled={step === 1 || streaming}
              className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-600 hover:bg-[#fffaf6] disabled:opacity-40"
            >
              ← 上一步
            </button>
            {step < 4 && (
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
