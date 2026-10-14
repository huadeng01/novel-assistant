import { useEffect, useMemo, useState } from 'react'
import { ASSET_TYPE_LABEL, LINK_LABEL, LINK_TARGET_TYPE, dashOut, isDangling, linkGroupsFor, matchesName } from '../lib/assets.js'

const sel = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-1 text-xs focus:border-red-400 focus:outline-none'
const miniBtn = 'rounded-lg bg-red-700 px-2.5 py-1 text-xs text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostMini = 'rounded-lg border border-stone-300 bg-stone-50 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100'

// 目标资产选择器：可自由输入（名册外也允许，标红提示）+ 下拉按资产类型分组、支持输入过滤（资产多时必需，设计 §3 需求5）
function TargetPicker({ value, onChange, assets, excludeName = '', created = [], placeholder = '目标资产名' }) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => {
    const q = String(value || '').trim()
    const map = new Map()
    ;(assets || []).forEach((a) => {
      if (!a || !a.name || a.name === excludeName) return
      if (q && !matchesName(a, q)) return
      const t = a.type || 'person'
      if (!map.has(t)) map.set(t, [])
      map.get(t).push(a)
    })
    // 本地「顺便建档」过的名字也进候选，避免建完还要手打一遍
    created.forEach((n) => {
      if (!n || n === excludeName) return
      if (q && !String(n).includes(q)) return
      if (!map.has('_new')) map.set('_new', [])
      if (!map.get('_new').some((x) => x.name === n)) map.get('_new').push({ name: n, type: '_new' })
    })
    return [...map.entries()].map(([type, items]) => ({ type, label: type === '_new' ? '刚建档' : ASSET_TYPE_LABEL[type] || type, items }))
  }, [assets, value, excludeName, created])

  return (
    <div className="relative min-w-0 flex-1">
      <input
        value={value || ''}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`${sel} w-full`}
        aria-label="关系目标资产名"
      />
      {open && groups.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-44 overflow-y-auto rounded-lg border border-stone-300 bg-paper shadow-lg">
          {groups.map((g) => (
            <div key={g.type}>
              <div className="sticky top-0 bg-stone-100 px-2 py-0.5 text-[10px] text-stone-400">{g.label}</div>
              {g.items.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  // 用 onMouseDown + preventDefault 抢在 input blur 之前，否则面板先关掉、点不中
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(a.name)
                    setOpen(false)
                  }}
                  className="block w-full truncate px-2 py-1 text-left text-xs text-stone-700 hover:bg-stone-100"
                >
                  {a.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 关系类型下拉：按源资产类型过滤 + 分组 optgroup（设计 §3 需求6：用户看到的是「地点/势力/道具/人际」分组，
// 而不是 13 个平铺枚举；不新增枚举值，复用 parseAssets.js LINK_LABEL 已有的 located_in 等）
function TypeSelect({ value, onChange, assetType, className = '' }) {
  const groups = linkGroupsFor(assetType)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${sel} ${className}`} aria-label="关系类型">
      {groups.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((it) => (
            <option key={it.value} value={it.value}>
              {it.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// 加边 / 删边 / 起始章 / 名册外「顺便建档」（设计 §3 需求5、§6.3）。
// 三处复用：EditAssetModal（替换现有只能删边的只读列表）、NewAssetModal（新增时就能建边）、AssetGraphModal 节点弹窗。
// 受控组件：links 进、next links 出，不自己落库 —— 落库时机由调用方（useAssets 的提交式保存）决定。
//
// props
//   links        [{ type, to, since_ch?, status?, note? }]
//   onChange     (nextLinks) => void
//   assets       全量资产（名册，用于目标下拉与悬空判据）
//   assetType    源资产类型（决定可选关系类型）
//   selfName     源资产名（从候选里排除自己）
//   onQuickCreate ({ name, type }) => void  「顺便建档」回调；不传也能用（本地记名，红字消失）
//   allowCreate  是否显示「顺便建档」按钮
export default function LinkEditor({ links, onChange, assets = [], assetType = 'person', selfName = '', onQuickCreate, allowCreate = true, disabled = false, title = '关系绑定' }) {
  const list = Array.isArray(links) ? links : []
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ type: '', to: '', since_ch: '' })
  const [created, setCreated] = useState([])
  const [tip, setTip] = useState('')

  // 源类型变化时把关系类型重置为该类型的第一个可选项（避免留着 person 的 holds 去挂 place）
  useEffect(() => {
    const first = linkGroupsFor(assetType)[0]
    setDraft((d) => ({ ...d, type: first && first.items[0] ? first.items[0].value : 'related' }))
  }, [assetType])

  const roster = useMemo(() => (assets || []).map((a) => (a && a.name) || '').filter(Boolean), [assets])
  const emit = (next) => onChange && onChange(next)

  const patchAt = (i, patch) => {
    const next = list.map((l, j) => (j === i ? { ...l, ...patch } : l))
    // M9：改类型/目标后去重(与 addRow 同判据 to+type)，避免把某条边改成与另一条完全重复
    const seen = new Set()
    emit(next.filter((l) => { const k = `${l.type}→${l.to}`; if (seen.has(k)) return false; seen.add(k); return true }))
  }
  const removeAt = (i) => emit(list.filter((_, j) => j !== i))

  const addRow = () => {
    const to = dashOut(draft.to)
    if (!draft.type) {
      setTip('先选关系类型')
      return
    }
    if (!to) {
      setTip('填一个目标资产名（名册外的名字也行，可顺便建档）')
      return
    }
    // 去重：与 addLink / mergeRelations 同判据（to+type 相同即视为同一条），连点两次不会产生重复边(M48)
    if (list.some((l) => l.to === to && l.type === draft.type)) {
      setTip(`「${LINK_LABEL[draft.type] || draft.type} → ${to}」这条关系已存在，未重复添加`)
      return
    }
    const since = Number(draft.since_ch) || 0
    emit([...list, since > 0 ? { type: draft.type, to, since_ch: since } : { type: draft.type, to }])
    setDraft({ type: draft.type, to: '', since_ch: '' })
    setTip(`已加「${LINK_LABEL[draft.type] || draft.type} → ${to}」${since ? `（自第${since}章）` : ''}`)
  }

  const quickCreate = (name, linkType) => {
    const n = dashOut(name)
    if (!n) return
    // H7：建档类型按「触发建档的那条边」的关系类型推导——已存在悬空边(下方 onClick 传 l.type)用 l.type，新增行用 draft.type；原写法一律用 draft.type 会给已存在边建错类型
    const type = LINK_TARGET_TYPE[linkType || draft.type] || 'person'
    if (onQuickCreate) onQuickCreate({ name: n, type })
    if (!created.includes(n)) setCreated((c) => [...c, n])
    setTip(`「${n}」已按${ASSET_TYPE_LABEL[type] || type}建档（只有名字，其余字段可空着后面补）`)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-stone-500">{title}</span>
        <span className="text-[10px] text-stone-400">{list.length} 条</span>
        {!disabled && (
          <button type="button" onClick={() => setAdding((v) => !v)} className={`${ghostMini} ml-auto`}>
            {adding ? '收起' : '+ 加一条关系'}
          </button>
        )}
      </div>

      {list.length === 0 && !adding && <div className="text-[11px] text-stone-400">暂无绑定边。点「+ 加一条关系」手动挂人物↔地点/道具/势力。</div>}

      {list.map((l, i) => {
        const dangling = isDangling(l.to, assets) && !created.includes(l.to)
        return (
          <div key={`${l.type}_${l.to}_${i}`} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50/60 px-2 py-1.5">
            <TypeSelect value={l.type} onChange={(t) => patchAt(i, { type: t })} assetType={assetType} className={disabled ? 'opacity-60' : ''} />
            <span className="text-[11px] text-stone-400">→</span>
            <span className={`max-w-[9rem] truncate text-xs ${dangling ? 'text-red-400' : 'text-stone-700'}`} title={dangling ? '目标未建档' : l.to}>
              {l.to}
            </span>
            <label className="flex items-center gap-1 text-[10px] text-stone-400">
              自第
              <input
                type="number"
                min="0"
                value={l.since_ch || ''}
                disabled={disabled}
                onChange={(e) => patchAt(i, { since_ch: Number(e.target.value) || 0 })}
                className="w-12 rounded border border-stone-300 bg-paper px-1 py-0.5 text-[11px]"
                aria-label="关系成立章"
              />
              章
            </label>
            {dangling && allowCreate && !disabled && (
              <button type="button" onClick={() => quickCreate(l.to, l.type)} className="rounded border border-red-400/50 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-900/20">
                顺便建档
              </button>
            )}
            {!disabled && (
              <button type="button" onClick={() => removeAt(i)} className="ml-auto text-[11px] text-red-400 hover:underline">
                删边
              </button>
            )}
            {dangling && (
              <div className="w-full text-[10px] text-red-400">目标未建档：可保留（只提示不阻断），或点「顺便建档」补一条只有名字的资产。</div>
            )}
          </div>
        )
      })}

      {adding && !disabled && (
        <div className="space-y-1.5 rounded-lg border border-stone-300 bg-paper p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeSelect value={draft.type} onChange={(t) => setDraft((d) => ({ ...d, type: t }))} assetType={assetType} />
            <span className="text-[11px] text-stone-400">→</span>
            <TargetPicker value={draft.to} onChange={(to) => setDraft((d) => ({ ...d, to }))} assets={assets} excludeName={selfName} created={created} />
            <label className="flex items-center gap-1 text-[10px] text-stone-400">
              自第
              <input
                type="number"
                min="0"
                value={draft.since_ch}
                onChange={(e) => setDraft((d) => ({ ...d, since_ch: e.target.value }))}
                className="w-14 rounded border border-stone-300 bg-stone-50 px-1 py-0.5 text-[11px]"
                aria-label="关系成立章"
              />
              章
            </label>
            <button type="button" onClick={addRow} className={miniBtn}>
              添加
            </button>
          </div>
          {draft.to && isDangling(draft.to, assets) && !created.includes(dashOut(draft.to)) && (
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-red-400">
              <span>「{dashOut(draft.to)}」不在名册（目标未建档）</span>
              {allowCreate && (
                <button type="button" onClick={() => quickCreate(draft.to)} className="rounded border border-red-400/50 px-1.5 py-0.5 hover:bg-red-900/20">
                  顺便建档为{ASSET_TYPE_LABEL[LINK_TARGET_TYPE[draft.type] || 'person'] || '资产'}
                </button>
              )}
            </div>
          )}
          <div className="text-[10px] text-stone-400">关系类型已按源资产类型（{ASSET_TYPE_LABEL[assetType] || assetType}）过滤并分组；起始章可空。</div>
        </div>
      )}

      {tip && <div className="text-[11px] text-stone-400">{tip}</div>}
      {roster.length === 0 && <div className="text-[10px] text-stone-400">名册为空：目标名可先手填，之后用「顺便建档」补上。</div>}
    </div>
  )
}
