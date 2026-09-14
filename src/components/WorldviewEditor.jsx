// 世界模板编辑器：查看/编辑某题材的八字段世界模板（供灵感参考不定死世界）；
// 保存写入本机题材库（覆盖内置模板，不污染内置文件）；新手写作「世界观确认」与长篇写作「世界观」页共用。
// 完整世界观（势力/冲突等）在选定灵感后由开书流程自动生成，不在本编辑器。
// 字段清单、标签、字数区间与输入框行数统一从 WORLDVIEW_FIELDS 读（唯一事实源），
// 避免「UI 能编辑的字段」与「worldviewText 会注入的字段」两处漂移。
// 注意：父组件切换题材时需用 key={genre} 重挂载本组件。
import { useState } from 'react'
import { BUILTIN_WORLDVIEWS, EMPTY_WORLDVIEW, WORLDVIEW_FIELDS, getWorldview, isOverridden, resetWorldview, saveWorldview } from '../lib/worldviews/index.js'

const taCls = 'w-full resize-y rounded-xl border border-stone-200 bg-white/70 px-3 py-2 text-xs leading-relaxed text-stone-700 focus:border-stone-500 focus:outline-none'

export default function WorldviewEditor({ genre, onChanged }) {
  const [wv, setWv] = useState(() => ({ ...EMPTY_WORLDVIEW, ...(getWorldview(genre) || {}) }))
  const [tip, setTip] = useState('')
  const overridden = isOverridden(genre)
  const builtin = !!BUILTIN_WORLDVIEWS[genre]

  const patch = (p) => {
    setWv((w) => ({ ...w, ...p }))
    setTip('')
  }

  // 提交全部八字段：旧数据缺失的维度按空串落库，getWorldview 读回时仍以 EMPTY_WORLDVIEW 打底，不会丢维度
  const save = () => {
    const next = {}
    for (const f of WORLDVIEW_FIELDS) next[f.key] = wv[f.key] || ''
    saveWorldview(genre, next)
    setTip('已保存到本机题材库，灵感生成立即使用新模板。')
    onChanged && onChanged()
  }

  const reset = () => {
    if (!window.confirm(`确定把「${genre}」世界模板恢复为内置版本？你的修改将丢弃。`)) return
    resetWorldview(genre)
    setWv({ ...EMPTY_WORLDVIEW, ...(BUILTIN_WORLDVIEWS[genre] || {}) })
    setTip('已恢复内置模板。')
    onChanged && onChanged()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${overridden ? 'bg-amber-100 text-amber-700' : 'bg-stone-200 text-stone-500'}`}>
          {overridden ? '已修改' : builtin ? '内置模板' : '自定义题材'}
        </span>
        <span className="text-xs text-stone-400">题材：{genre}</span>
        <span className="text-[10px] text-stone-400">八字段共 {WORLDVIEW_FIELDS.length} 项；字数为参考区间，只提示不阻断</span>
      </div>
      {WORLDVIEW_FIELDS.map((f) => {
        const n = String(wv[f.key] || '').trim().length
        const off = n > 0 && (n < f.min || n > f.max)
        return (
          <div key={f.key}>
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <p className="text-xs font-semibold text-stone-500">{f.label}</p>
              {/* 实时字数 / 目标区间：越界转琥珀色，空字段不告警（旧数据可分次补填） */}
              <span className={`text-[10px] tabular-nums ${off ? 'text-amber-600' : 'text-stone-400'}`}>
                {n} / {f.min}~{f.max}
              </span>
            </div>
            <textarea value={wv[f.key] || ''} onChange={(e) => patch({ [f.key]: e.target.value })} placeholder={f.placeholder} rows={f.rows} className={taCls} />
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={save} className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700">保存修改</button>
        {builtin && overridden && (
          <button onClick={reset} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">恢复内置模板</button>
        )}
        {tip && <span className="text-xs text-emerald-700">{tip}</span>}
      </div>
    </div>
  )
}
