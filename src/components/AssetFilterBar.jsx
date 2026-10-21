import { ASSET_TYPES, ASSET_TYPE_LABEL, CORE_TYPES, countByType } from '../lib/assets.js'

const sizeCls = {
  sm: 'px-2.5 py-1 text-xs',
  xs: 'px-1.5 py-0.5 text-[10px]',
}

// 分类按钮组（设计 §3 需求1 / §8 拍板1：弹窗内 + 工具栏两处共用同一组件）。
// 取代 AssetModal 里那个 <select>：把「全部」拆成看得见的一排按钮，每类带实时计数。
// 额外带一个「⚠ 待补全」虚拟分类 = 缺透出章（revealChapterOf===0，不参与防剧透检测）的资产，
// 让用户能一眼定位「是哪几条缺」（设计 §3 需求4 第5步：现在只在弹窗底部给个总数，卡上看不出是哪条）。
//
// B28：删掉 6 个全仓零调用方传入的死 props（assets/showMissing/showAll/types/className/labelAll）——两处调用方
//   (AssetModal / ContinuePage) 都只传 value/onChange/counts/perVol/size，这 6 个恒取默认值，故按默认值硬编、行为逐一等价。
//   perVol 保留（修法未列删）：counts 恒由调用方传入，`counts || countByType([], perVol)` 的兜底分支实际不触发，perVol 仅作 API 兼容留位。
// 0 条的核心类仍显示但置灰 disabled，避免「点了没反应」；skill/beast 属迭代类型，仅在有数据时才出现。
export default function AssetFilterBar({ value = 'all', onChange, counts, perVol = 40, size = 'sm' }) {
  const c = counts || countByType([], perVol)
  const list = CORE_TYPES
  // M4：extra 从全量 ASSET_TYPES 里挑「非核心类但已有数据」的(skill/beast)；原写法从 list(默认=CORE_TYPES)里挑非核心类恒为空 → skill/beast 分类按钮永不出现(countByType 却已计数)
  const extra = ASSET_TYPES.filter((t) => !CORE_TYPES.includes(t) && (c[t] || 0) > 0)
  const items = [
    { key: 'all', label: '全部', n: c.all || 0 },
    ...list.map((t) => ({ key: t, label: ASSET_TYPE_LABEL[t] || t, n: c[t] || 0 })),
    ...extra.map((t) => ({ key: t, label: ASSET_TYPE_LABEL[t] || t, n: c[t] || 0 })),
    { key: 'missing', label: '⚠ 待补全', n: c.missing || 0, warn: true },
  ]
  const pick = (k) => onChange && onChange(k)
  const pad = sizeCls[size] || sizeCls.sm

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="资产分类筛选">
      {items.map((it) => {
        const on = value === it.key
        const empty = !it.n && !on
        return (
          <button
            key={it.key}
            type="button"
            disabled={empty && it.key !== value}
            onClick={() => pick(it.key)}
            title={empty ? `暂无${it.label}资产` : it.key === 'missing' ? '缺透出章：不参与防剧透检测，建议补全' : `只看${it.label}`}
            aria-pressed={on}
            className={[
              'rounded-lg border whitespace-nowrap transition-colors',
              pad,
              on
                ? 'border-red-700 bg-red-700 text-onaccent'
                : it.warn && it.n
                  ? 'border-red-400/50 bg-stone-50 text-red-400 hover:bg-stone-100'
                  : 'border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100',
              empty ? 'cursor-not-allowed opacity-40' : '',
            ].join(' ')}
          >
            {it.label} <span className={on ? 'opacity-80' : 'text-stone-400'}>{it.n}</span>
          </button>
        )
      })}
    </div>
  )
}
