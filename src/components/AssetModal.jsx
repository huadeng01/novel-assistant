import { useMemo, useState } from 'react'
import AssetFilterBar from './AssetFilterBar.jsx'
import ChapterField from './ChapterField.jsx'
import { ASSET_TYPE_LABEL, LINK_LABEL, countByType, isMissingReveal, stateToCardLine } from '../lib/assets.js'

const genBtn = 'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostBtn = 'rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100'

// 资产库弹窗：长篇写作与续写共用。点资产卡即唤起编辑弹窗（平板友好），卡内输入框/删除按钮阻止冒泡。
// 阶段1(设计 §6.1)：分类改 AssetFilterBar(受控可选、含「⚠ 待补全」虚拟类)、透出/传闻章改 ChapterField(原始值输入 + 按卷估算小字)、
//   卡片加现况行(stateToCardLine 口语化) + 人物「此人位于哪」/ 地点「此地有谁」双向位置(§8 拍板2) + 缺透出章红点、头部可选「+ 新增资产」、底部统计升级。
// 向后兼容：新增 props(onAddAsset / filter / onFilterChange)均可选，长篇页现有调用不传也能用(内部 filter state 兜底、关窗不重置)。
export default function AssetModal({
  open,
  onClose,
  book,
  onUpdateAsset,
  onDeleteAsset,
  onEditAsset,
  onExpandOpen,
  onRelationOpen,
  onAddAsset,
  warnings,
  perVol = 40,
  filter: filterProp,
  onFilterChange,
}) {
  const [innerFilter, setInnerFilter] = useState('all')
  // M24：把「全表扫描」提前用 useMemo 建成索引——nameSet(悬空边判定) 与 occupantsByPlace(地点「此地有谁」)，
  //   避免每张资产卡渲染时对全表 .some/.filter（原 O(卡×边×n)）；资产多时不掉帧。hooks 必须在 early-return 之前调用。
  const all = useMemo(() => (book && book.assets) || [], [book])
  const nameSet = useMemo(() => new Set(all.map((a) => a && a.name).filter(Boolean)), [all])
  const occupantsByPlace = useMemo(() => {
    const m = new Map()
    all.forEach((a) => {
      if (!a || a.type === 'place') return
      const pl = (a.state && a.state.place && a.state.place.ref) || ((a.links || []).find((l) => l.type === 'located_in') || {}).to
      if (pl) {
        if (!m.has(pl)) m.set(pl, [])
        m.get(pl).push(a.name)
      }
    })
    return m
  }, [all])
  if (!open) return null
  // filter 受控优先(父传 filterProp)，否则用内部 state(关窗不重置)
  const filter = filterProp != null ? filterProp : innerFilter
  const pickFilter = (k) => {
    if (filterProp != null) onFilterChange && onFilterChange(k)
    else setInnerFilter(k)
  }
  const assets = all.filter((a) => (filter === 'all' ? true : filter === 'missing' ? isMissingReveal(a, perVol) : a.type === filter))
  const counts = countByType(all, perVol)
  const warnMap = {}
  ;(warnings || []).forEach((w) => {
    ;(warnMap[w.name] = warnMap[w.name] || []).push(w.msg)
  })

  // 双向位置(设计 §8 拍板2)：人物「此人位于哪」= state.place.ref 优先、回落 located_in 边；
  const placeOf = (a) => {
    const p = a && a.state && a.state.place
    if (p && p.ref) return p.ref
    const edge = ((a && a.links) || []).find((l) => l.type === 'located_in')
    return edge ? edge.to : ''
  }
  // 地点「此地有谁」= 查预建索引(M24)，不再每卡全表 filter
  const whoHere = (placeName) => occupantsByPlace.get(placeName) || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="flex max-h-[86vh] w-[min(880px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 头部第1行：标题 + 操作按钮 */}
        <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-5 py-3">
          <span className="whitespace-nowrap font-semibold text-ink">资产库（{all.length}）</span>
          <div className="flex items-center gap-2">
            {onAddAsset && (
              <button onClick={onAddAsset} className={genBtn}>
                + 新增资产
              </button>
            )}
            {onExpandOpen && (
              <button onClick={onExpandOpen} className={genBtn}>
                扩充资产
              </button>
            )}
            {onRelationOpen && (
              <button onClick={onRelationOpen} className={ghostBtn}>
                生成关系网
              </button>
            )}
            <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
              ×
            </button>
          </div>
        </div>
        {/* 头部第2行：分类筛选(设计 §8 拍板1：分类按钮只放弹窗内，取代原 <select>) */}
        <div className="border-b border-stone-200 px-5 py-2">
          <AssetFilterBar value={filter} onChange={pickFilter} counts={counts} perVol={perVol} size="sm" />
        </div>
        <div className="grid flex-1 gap-2 overflow-y-auto p-4 sm:grid-cols-2">
          {assets.map((a) => {
            const card = stateToCardLine(a)
            const missing = isMissingReveal(a, perVol)
            const at = a.type === 'person' || a.type === 'group' ? placeOf(a) : ''
            const here = a.type === 'place' ? whoHere(a.name) : []
            return (
              <div
                key={a.id}
                onClick={() => onEditAsset && onEditAsset(a)}
                className="cursor-pointer rounded-lg border border-stone-200 bg-stone-50 p-2 transition-colors hover:border-stone-400"
                title="点击编辑"
              >
                <div className="flex items-center gap-2 text-xs font-medium text-ink">
                  <span>
                    {a.name} <span className="text-stone-400">({ASSET_TYPE_LABEL[a.type] || a.type})</span>
                  </span>
                  {missing && (
                    <span className="rounded bg-red-50 px-1 text-[10px] text-red-400" title="缺透出章：不参与防剧透检测，建议补全">
                      ⚠ 缺透出章
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-stone-400">点击编辑</span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-stone-500">{String(a.detail || '').slice(0, 140)}</div>
                {card && <div className="mt-1 text-[11px] leading-relaxed text-stone-600">{card}</div>}
                {at && <div className="mt-0.5 text-[11px] text-stone-500">此人位于：{at}</div>}
                {a.type === 'place' && here.length > 0 && (
                  <div className="mt-0.5 text-[11px] text-stone-500">
                    此地有谁：{here.slice(0, 8).join('、')}
                    {here.length > 8 ? ` 等${here.length}人` : ''}
                  </div>
                )}
                {(a.links || []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(a.links || []).map((l, i) => (
                      <span key={i} className={`rounded px-1 py-0.5 text-[10px] ${nameSet.has(l.to) ? 'bg-stone-100 text-stone-600' : 'bg-red-900/40 text-red-400'}`}>
                        {LINK_LABEL[l.type] || l.type}：{l.to}
                      </span>
                    ))}
                  </div>
                )}
                {(warnMap[a.name] || []).map((m, i) => (
                  <div key={i} className="mt-1 text-[11px] text-red-400">
                    ! {m}
                  </div>
                ))}
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500" onClick={(e) => e.stopPropagation()}>
                  <ChapterField kind="reveal" asset={a} perVol={perVol} inline width="w-14" onChange={(n) => onUpdateAsset(a.id, { ch_reveal: n })} />
                  <ChapterField kind="rumor" asset={a} perVol={perVol} inline width="w-14" onChange={(n) => onUpdateAsset(a.id, { ch_rumor: n })} />
                  <button onClick={() => { if (window.confirm(`确定删除资产《${a.name}》吗？此操作不可撤销。`)) onDeleteAsset(a.id) }} className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-900/30">
                    删除
                  </button>
                </div>
              </div>
            )
          })}
          {!assets.length && (
            <div className="text-xs text-stone-400">
              {filter === 'missing' ? '没有缺透出章的资产（都已指定精确章号或可按卷换算）。' : '无该类型资产。'}
              {onAddAsset ? '点上方「+ 新增资产」手动建档。' : onExpandOpen ? '点「扩充资产」批量生成，或用「分析资产」从导入原文提取。' : ''}
            </div>
          )}
        </div>
        <div className="border-t border-stone-200 px-5 py-2 text-[11px] text-stone-400">
          伏笔{((book && book.foreshadows) || []).length}条／节拍{((book && book.beats) || []).length}条　｜　关系网警告 {(warnings || []).length} 条 · 缺透出章 {counts.missing || 0} 条（红字 / 红点标在资产卡上，只提示不阻断）
        </div>
      </div>
    </div>
  )
}
