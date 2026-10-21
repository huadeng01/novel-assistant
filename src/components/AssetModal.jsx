import { useMemo, useState } from 'react'
import AssetFilterBar from './AssetFilterBar.jsx'
import ChapterField from './ChapterField.jsx'
import { ASSET_TYPE_LABEL, LINK_LABEL, countByType, dashOut, isDangling, isMissingReveal, stateToCardLine } from '../lib/assets.js'

const genBtn = 'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostBtn = 'rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100'

// #4：最近编辑的相对时间（决策#4：只做「最近编辑过」的轻量显示，不做按最近修改排序）
const relTime = (ts) => {
  const diff = Date.now() - Number(ts || 0)
  if (!Number.isFinite(diff) || diff < 0) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

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
  // M24：把「全表扫描」提前用 useMemo 建成索引——occupantsByPlace(地点「此地有谁」)，避免每张资产卡渲染时对全表 .filter。
  //   hooks 必须在 early-return 之前调用。
  // P1-10：悬空边判定改用 assets.js isDangling 单一出处（dashOut 归一两边）——原来用 nameSet.has(l.to) 比的是原值，
  //   与 LinkEditor 的 isDangling 口径不一致：同一条带空格/书名号的边，卡片标红而弹窗不标红。nameSet 随之删除。
  const all = useMemo(() => (book && book.assets) || [], [book])
  const occupantsByPlace = useMemo(() => {
    const m = new Map()
    all.forEach((a) => {
      if (!a || a.type === 'place') return
      const p = a.state && a.state.place
      // P2：移动中 / 下落不明 = 当前不固定在某地，不该算进「此地有谁」
      if (p && (p.tag === 'moving' || p.tag === 'missing')) return
      const edgeTo = ((a.links || []).find((l) => l.type === 'located_in') || {}).to
      // inferred（推定短语，如「前往昆仑」）：ref 不是确定地名、B区也不为它建 located_in 边 → 不按 ref 归入；
      //   但若用户经 LinkEditor 手建了 located_in 边（确定断言），以边为准归入「此地有谁」（手建边视为确定位置）。
      const pl = (p && !p.inferred && p.ref) || edgeTo
      // 尾批[5]：索引键走 dashOut 归一（去空白/《》「」）——AI 提取的 place.ref 可能带书名号或空格，
      //   与地点资产名对不上会让「此地有谁」漏人；whoHere 查时同样 dashOut，两边口径一致。
      const key = dashOut(pl)
      if (key) {
        if (!m.has(key)) m.set(key, [])
        m.get(key).push(a.name)
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
  // item3：filter 回调加 `a &&` 守卫（与本文件 occupantsByPlace :49、assets.js filterAssets/countByType 同口径）——
  //   all 里可能混入 null 资产，原来 filter≠'all' 时裸取 a.type 抛 TypeError；null 若漏进下面的 .map 也会崩，故整个回调先剔 null。
  const assets = all.filter((a) => a && (filter === 'all' ? true : filter === 'missing' ? isMissingReveal(a, perVol) : a.type === filter))
  const counts = countByType(all, perVol)
  const warnMap = {}
  ;(warnings || []).forEach((w) => {
    ;(warnMap[w.name] = warnMap[w.name] || []).push(w.msg)
  })

  // 双向位置(设计 §8 拍板2)：人物「此人位于哪」= state.place 优先、回落 located_in 边。
  // P2：原来只取 place.ref、忽略 place.tag，把「流放于幽州 / 被囚于天牢 / 移动中」一律显示成「此人位于：幽州」——语义错。
  //   按 tag 给出准确说法（tag 缺省或 at 才是「在某地」）。
  const PLACE_LEAD = {
    at: (r) => `此人在${r}`,
    moving: (r) => `此人移动中，最近见于${r}`,
    missing: (r) => `此人下落不明，最后在${r}`,
    imprisoned: (r) => `此人被囚于${r}`,
    exiled: (r) => `此人被流放于${r}`,
    returned: (r) => `此人已归来，现在${r}`,
  }
  const placeOf = (a) => {
    const p = a && a.state && a.state.place
    const edgeTo = (((a && a.links) || []).find((l) => l.type === 'located_in') || {}).to || ''
    // inferred（B区第三路推定的裸词/动词短语，如「前往昆仑」「躲在柴房」）：ref 不是确定地名，不能套 PLACE_LEAD 断言「此人在/被囚于…」。
    //   但若用户经 LinkEditor 手建了 located_in 边（确定断言）→ 以边为准、按正常口径渲染（手建边视为确定位置，不再标「推定」）；
    //   无手建边才中性呈现推定原词并标「推定」，与 B区 placePhrase 对 inferred 不加「人在」同口径。
    if (p && p.inferred) {
      if (edgeTo) return (PLACE_LEAD[p.tag] || PLACE_LEAD.at)(edgeTo)
      return p.ref ? `位置（推定，非确定地名）：${p.ref}` : ''
    }
    const ref = (p && p.ref) || edgeTo
    if (!ref) return ''
    const lead = PLACE_LEAD[p && p.tag] || PLACE_LEAD.at
    return lead(ref)
  }
  // 地点「此地有谁」= 查预建索引(M24)，不再每卡全表 filter
  const whoHere = (placeName) => occupantsByPlace.get(dashOut(placeName)) || [] // 尾批[5]：与索引键同走 dashOut 归一

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="资产库">
      <div className="flex max-h-[86vh] w-[min(880px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
                {a.updatedAt > (a.createdAt || 0) && <div className="mt-0.5 text-[10px] text-stone-400">✎ 最近编辑 {relTime(a.updatedAt)}</div>}
                {at && <div className="mt-0.5 text-[11px] text-stone-500">{at}</div>}
                {a.type === 'place' && here.length > 0 && (
                  <div className="mt-0.5 text-[11px] text-stone-500">
                    此地有谁：{here.slice(0, 8).join('、')}
                    {here.length > 8 ? ` 等${here.length}人` : ''}
                  </div>
                )}
                {(a.links || []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(a.links || []).map((l, i) => (
                      <span key={i} className={`rounded px-1 py-0.5 text-[10px] ${isDangling(l.to, all) ? 'bg-red-900/40 text-red-400' : 'bg-stone-100 text-stone-600'}`}>
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
