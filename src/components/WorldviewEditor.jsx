// 世界模板编辑器：查看/编辑某题材的世界模板（仅世界架构+力量体系，供灵感参考不定死世界）；
// 保存写入本机题材库（覆盖内置模板，不污染内置文件）；新手写作「世界观确认」与长篇写作「世界观」页共用。
// 完整世界观（势力/冲突等）在选定灵感后由开书流程自动生成，不在本编辑器。
// 注意：父组件切换题材时需用 key={genre} 重挂载本组件。
import { useState } from 'react'
import { BUILTIN_WORLDVIEWS, EMPTY_WORLDVIEW, getWorldview, isOverridden, resetWorldview, saveWorldview } from '../lib/worldviews/index.js'

const FIELDS = [
  ['world', '世界架构', '世界构成、世界层级、舞台格局…（模板参考，非定死设定）'],
  ['power', '力量体系', '修炼/科技/能力阶位与代价…（公认框架，具体细节留给本书）'],
]

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

  const save = () => {
    saveWorldview(genre, { world: wv.world || '', power: wv.power || '' })
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
      </div>
      {FIELDS.map(([k, label, ph]) => (
        <div key={k}>
          <p className="mb-1 text-xs font-semibold text-stone-500">{label}</p>
          <textarea value={wv[k] || ''} onChange={(e) => patch({ [k]: e.target.value })} placeholder={ph} rows={2} className={taCls} />
        </div>
      ))}
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
