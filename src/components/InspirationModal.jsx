import { useEffect, useMemo, useRef, useState } from 'react'
import Ic from './Ic'
import Select from './Select'
import { allGenres, getWorldview, worldviewText } from '../lib/worldviews/index.js'
import { POWER_FANTASY_STANCES, inspirationSeed } from '../lib/prompts'
import { museAgent } from '../lib/agents/index.js'

// 灵感弹窗：内置各题材世界模板 + 爽文元素库（驱动/爽点/流派/金手指），AI 自主参考组合生成灵感。
// 立意下拉承载三种模式：常规小说（不注入爽文库）/ 自由爽文（注入元素库无倾向）/ 6 个立意倾向（软参考）。
// 两段式：① 列表态生成 5 个选题；② 点击选题进入扩充态——注入 full 世界模板把窄 brief 扩充成完整自洽灵感（境界硬校准），
// 用户可在 textarea 直接编辑、或输入想法让 AI 迭代修改，满意后「带入开书」或「返回重选」。
export default function InspirationModal({ genre, apiKey, onPick, onClose }) {
  const genres = useMemo(() => allGenres(), [])
  const [sel, setSel] = useState(genre || genres[0])
  const [stanceId, setStanceId] = useState('free') // normal=常规 / free=自由 / <id>=立意倾向
  const [ideas, setIdeas] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // 扩充态
  const [view, setView] = useState('list') // list | expand
  const [current, setCurrent] = useState(null) // 选中选题 {title, brief}
  const [expandBrief, setExpandBrief] = useState('')
  const [expandLoading, setExpandLoading] = useState(false)
  const [userNote, setUserNote] = useState('')
  const [expandErr, setExpandErr] = useState('')
  const panelRef = useRef(null)
  const g = getWorldview(sel)
  const tropes = (g && g.tropes) || ''

  // 立意倾向：stanceId 命中 STANCES 时为软倾向配方，否则（normal/free）为 null
  const stance = POWER_FANTASY_STANCES.find((s) => s.id === stanceId) || null
  const mode = stanceId === 'normal' ? 'normal' : stance ? 'guided' : 'free'
  // 自由/倾向模式生成随机参考种子（保批间差异）；常规模式不需要
  const seed = useMemo(() => (mode === 'normal' ? '' : inspirationSeed()), [mode, stanceId, sel])
  useEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0 }, [sel, stanceId, view])

  const gen = async () => {
    if (loading) return
    setLoading(true); setErr(''); setIdeas([]); setView('list')
    try {
      const { ideas: list } = await museAgent.run({ apiKey, genre: sel, worldview: worldviewText(g, 'brief'), tropes, mode, stance, seed })
      if (list.length) setIdeas(list)
      else setErr('AI 返回格式未识别，请点「再生成一批」重试。')
    } catch (e) { setErr(e?.message || '生成失败，请检查 API Key / 模型配置。') }
    finally { setLoading(false) }
  }

  // 扩充：baseBrief=当前灵感文本，note=用户修改想法（空=初次扩充）。注入 full 世界模板做境界硬校准。
  const expand = async (baseBrief, note) => {
    setExpandLoading(true); setExpandErr('')
    try {
      const { brief: b } = await museAgent.expand({ apiKey, brief: baseBrief, genre: sel, worldview: worldviewText(g, 'full'), stance, userNote: note })
      if (b && String(b).trim()) setExpandBrief(String(b).trim())
      else setExpandErr('AI 返回格式未识别，请重试。')
    } catch (e) { setExpandErr(e?.message || '扩充失败，请检查 API Key / 模型配置。') }
    finally { setExpandLoading(false) }
  }

  // 点击选题 → 进入扩充态并自动扩充
  const pickIdea = (idea) => {
    setCurrent(idea)
    setExpandBrief(idea.brief)
    setUserNote(''); setExpandErr('')
    setView('expand')
    expand(idea.brief, '')
  }

  const backToList = () => { setView('list'); setCurrent(null); setExpandBrief(''); setUserNote(''); setExpandErr('') }

  const submitNote = () => {
    const n = userNote.trim()
    if (!n || expandLoading) return
    expand(expandBrief, n)
    setUserNote('')
  }

  const stanceOptions = [
    { value: 'normal', label: '常规小说（无爽文元素）', title: '不注入爽文元素库，正常叙事：动机合理、冲突循序渐进、反派有自身立场' },
    { value: 'free', label: '自由爽文（AI 自主组合）', title: '注入爽文元素库，AI 自主参考组合，无倾向约束' },
    ...POWER_FANTASY_STANCES.map((s) => ({ value: s.id, label: s.name, title: s.hook })),
  ]

  return (
    <div className="glass-scrim fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div ref={panelRef} className="glass-modal w-full max-w-2xl overflow-y-auto rounded-2xl border border-stone-200 bg-white shadow-xl" style={{ maxHeight: 'min(86vh, 760px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-amber-600">
              <Ic n="idea" /><h3 className="font-serif text-lg">灵感题材</h3>
              <span className="ml-0.5 hidden shrink-0 rounded-md bg-amber-100/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-700 sm:inline">Muse 灵感选题师</span>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"><Ic n="close" /></button>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            {view === 'list'
              ? '选题材 + 立意（参考），点「生成」抽 5 个选题；点选题卡片让 AI 扩充成完整灵感。'
              : 'AI 已按题材力量体系校准境界并扩充；可直接编辑，或输入想法让 AI 修改，满意后带入开书。'}
          </p>
        </div>

        <div className="px-5 py-4">
          {view === 'list' ? (
            <>
              {/* 一行：题材 + 立意 + 生成 */}
              <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium text-stone-500">题材</span>
                  <Select value={sel} onChange={setSel} options={genres.map((x) => ({ value: x, label: x }))} disabled={loading} />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-medium text-stone-500">立意（参考）</span>
                  <Select value={stanceId} onChange={setStanceId} options={stanceOptions} disabled={loading} />
                </label>
                <button type="button" onClick={gen} disabled={loading} className="flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-50">
                  {loading ? '生成中…' : ideas.length ? '再生成一批' : '生成'}
                </button>
              </div>

              {/* 立意倾向：只读配方卡片（标签/钩子/主驱动/升级链），无流派/金手指选择 */}
              {stance && (
                <div className="mt-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-amber-800">{stance.name}</span>
                    {stance.tags.map((t) => (<span key={t} className="rounded-full bg-amber-600/90 px-2 py-0.5 text-[11px] font-medium text-white">{t}</span>))}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-stone-600">{stance.hook}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
                    主驱动：{stance.drive}（{stance.ladder}） · 爽点密度：{stance.density} · 节奏：{stance.pace}
                    <span className="text-stone-400"> · 软倾向参考，AI 可采纳可突破</span>
                  </p>
                </div>
              )}
              {mode === 'normal' && (<p className="mt-3 text-xs text-stone-400">常规小说：不注入爽文元素库，AI 按正常叙事法则生成（动机合理、冲突循序渐进、反派有自身立场）。</p>)}
              {mode === 'free' && (<p className="mt-3 text-xs text-stone-400">自由爽文：AI 自主从元素库（8 驱动 / 12 爽点 / 26 流派 / 14 金手指）参考组合，无倾向约束。</p>)}

              {loading && <div className="mt-4 flex items-center gap-2 text-sm text-stone-500"><Ic n="loading" className="animate-spin" /> 正在结合{sel ? `「${sel}」` : ''}世界模板与爽文元素库构思灵感…</div>}
              {err && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

              {!loading && !err && ideas.length > 0 && (
                <>
                  <div className="mt-4 border-t border-stone-200 pt-3 text-xs text-stone-500">点任意选题，AI 会注入完整世界模板把它扩充成自洽灵感；不满意就再抽一批。</div>
                  <div className="mt-3 space-y-2">
                    {ideas.map((it, i) => (
                      <button key={i} type="button" onClick={() => pickIdea(it)} className="block w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-left transition hover:border-amber-400 hover:shadow-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-serif text-sm font-medium text-stone-800">{it.title || `选题 ${i + 1}`}</div>
                          <span className="shrink-0 text-[11px] text-amber-600">扩充 →</span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-600">{it.brief}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!loading && !err && ideas.length === 0 && (
                <div className="mt-5 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
                  选好题材与立意，点「生成」开始抽灵感。
                </div>
              )}
            </>
          ) : (
            <>
              {/* 扩充态：标题 + 可编辑 brief + 修改输入框 + 底部两按钮 */}
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-serif text-base font-medium text-stone-800">{current?.title || '灵感扩充'}</span>
                {expandLoading && <span className="flex shrink-0 items-center gap-1 text-xs text-stone-400"><Ic n="loading" className="animate-spin" /> 扩充中…</span>}
              </div>
              <textarea
                value={expandBrief}
                onChange={(e) => setExpandBrief(e.target.value)}
                rows={12}
                disabled={expandLoading}
                placeholder="扩充后的完整灵感…"
                className="mt-3 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm leading-relaxed text-stone-700 focus:border-amber-400 focus:outline-none disabled:opacity-60"
              />
              {expandErr && <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{expandErr}</div>}
              {/* 修改输入框（可选）：用户输入想法，AI 基于当前 brief 迭代修改 */}
              <div className="mt-3 flex gap-2">
                <input
                  value={userNote}
                  onChange={(e) => setUserNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNote() }}
                  disabled={expandLoading}
                  placeholder="输入你的想法，让 AI 按要求修改（可选）"
                  className="min-w-0 flex-1 rounded-xl border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none disabled:opacity-60"
                />
                <button type="button" onClick={submitNote} disabled={expandLoading || !userNote.trim()} className="shrink-0 rounded-xl border border-amber-300 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-40">按想法修改</button>
              </div>
              {/* 底部两按钮 */}
              <div className="mt-4 flex justify-end gap-2 border-t border-stone-200 pt-3">
                <button type="button" onClick={backToList} className="rounded-xl border border-stone-200 px-4 py-2 text-sm text-stone-600 transition hover:bg-stone-50">返回重选</button>
                <button type="button" onClick={() => onPick(expandBrief, sel)} disabled={!expandBrief.trim() || expandLoading} className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-50">带入开书</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
