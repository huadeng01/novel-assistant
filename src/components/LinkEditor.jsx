import { useEffect, useMemo, useRef, useState } from 'react'
import { ASSET_TYPE_LABEL, LINK_LABEL, LINK_TARGET_TYPE, dashOut, isDangling, linkGroupsFor } from '../lib/assets.js'

const sel = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-1 text-xs focus:border-red-400 focus:outline-none'
const miniBtn = 'rounded-lg bg-red-700 px-2.5 py-1 text-xs text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostMini = 'rounded-lg border border-stone-300 bg-stone-50 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100'

// 目标资产选择器：可自由输入（名册外也允许，标红提示）+ 下拉按资产类型分组、支持输入过滤（资产多时必需，设计 §3 需求5）
function TargetPicker({ value, onChange, assets, excludeName = '', created = [], placeholder = '目标资产名' }) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => {
    const q = String(value || '').trim()
    // 决策1 把 matchesName 严格化（归一后主名/别名完全相等）——那是给「落库结算」用的判据。
    //   但这里是下拉的「边打字边过滤」UI 场景：若沿用严格相等，用户输入部分名字（如打「陆」想找「陆沉」）时下拉会直接空掉、变成死胡同。
    //   故 UI 过滤单独用宽松子串包含（名/别名 includes 归一后的查询）；真正落库仍走 findAssetByName/matchesName 的严格匹配，两者互不影响。
    const qq = dashOut(q)
    const map = new Map()
    ;(assets || []).forEach((a) => {
      if (!a || !a.name || a.name === excludeName) return
      if (qq && ![a.name, ...(a.aliases || [])].some((x) => dashOut(x).includes(qq))) return
      const t = a.type || 'person'
      if (!map.has(t)) map.set(t, [])
      map.get(t).push(a)
    })
    // 本地「顺便建档」过的名字也进候选，避免建完还要手打一遍
    created.forEach((n) => {
      if (!n || n === excludeName) return
      if (qq && !dashOut(n).includes(qq)) return
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
function TypeSelect({ value, onChange, assetType, className = '', disabled = false }) {
  const groups = linkGroupsFor(assetType)
  // M-F：当前边类型不在本源类型的可选白名单里（AI 提取的边、或 EditAssetModal 改过源类型）——
  //   <select value> 找不到匹配 option 会显示空白，且用户一选就把原类型永久改掉、原边类型丢失。
  //   补一个「当前值」兜底 option：既如实显示原类型，又不会被误改（用户不主动选就保持不变）。
  const inWhitelist = groups.some((g) => g.items.some((it) => it.value === value))
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`${sel} ${className}`} aria-label="关系类型">
      {!inWhitelist && value && <option value={value}>{`${LINK_LABEL[value] || value}（当前）`}</option>}
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
  // A#4：建档回调可能是 async（LongFormPage 的 quickCreateAsset）——await 期间禁用「顺便建档」按钮防重复点。
  //   creatingRef 做同步防重入（双击在 setState 重渲染前都能挡住），creating 状态驱动按钮 disabled。
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)

  // 源类型变化时把关系类型重置为该类型的第一个可选项（避免留着 person 的 holds 去挂 place）
  useEffect(() => {
    const first = linkGroupsFor(assetType)[0]
    setDraft((d) => ({ ...d, type: first && first.items[0] ? first.items[0].value : 'related' }))
  }, [assetType])

  const roster = useMemo(() => (assets || []).map((a) => (a && a.name) || '').filter(Boolean), [assets])
  const emit = (next) => onChange && onChange(next)

  const patchAt = (i, patch) => {
    const next = list.map((l, j) => (j === i ? { ...l, ...patch } : l))
    const key = (l) => `${l.type}→${l.to}`
    // P1-9：改类型/目标撞上已有边时，原实现用 filter 去重——它删的是数组里靠后的那条，往往正是「用户正在编辑的这一行」，
    //   于是行凭空消失且无任何提示。改为：命中重复就不 emit（保留原行不动）+ setTip 告知，由用户决定改回还是删掉另一条。
    //   只改 since_ch 时 type→to 不变、不会误判（现有行本就已去重）。
    const dup = next.some((l, j) => j !== i && key(l) === key(next[i]))
    if (dup) {
      setTip(`「${LINK_LABEL[next[i].type] || next[i].type} → ${next[i].to}」这条关系已存在，本次未改动（避免重复边）`)
      return
    }
    setTip('')
    emit(next)
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

  const quickCreate = async (name, linkType) => {
    const n = dashOut(name)
    if (!n || creatingRef.current) return // A#4：建档在飞时不重入
    // H7：建档类型按「触发建档的那条边」的关系类型推导——已存在悬空边(下方 onClick 传 l.type)用 l.type，新增行用 draft.type；原写法一律用 draft.type 会给已存在边建错类型
    const type = LINK_TARGET_TYPE[linkType || draft.type] || 'person'
    // M-C + A#4：onQuickCreate 可能是 async（LongFormPage）——必须 await 才能拿到 { ok:false } 做回滚；
    //   原来不 await 时 r 是 Promise、r.ok===false 永假、回滚分支是死代码（ContinuePage 同步版才碰巧生效）。
    //   await 对同步返回值也兼容（ContinuePage 同步 quickCreateAsset 不受影响）；回调不返回值(undefined)按成功处理，向后兼容 A 区 AssetGraphModal。
    if (onQuickCreate) {
      creatingRef.current = true
      setCreating(true)
      let r
      try {
        r = await onQuickCreate({ name: n, type })
      } catch (err) {
        // L7：onQuickCreate 抛错（建档 async 失败）原来只有 try/finally 无 catch → reject 逸出成 unhandled rejection、用户也无提示
        setTip(`「${n}」建档失败：${err?.message || String(err)}`)
        return
      } finally {
        creatingRef.current = false
        setCreating(false)
      }
      if (r && r.ok === false) {
        setTip(`「${n}」建档未成功${r.msg ? `：${r.msg}` : '（可能存储空间不足或重名）'}，未标记为已知`)
        return
      }
    }
    if (!created.includes(n)) setCreated((c) => [...c, n])
    // P2：没接 onQuickCreate 回调时并不会真建档（只在本弹窗记名、让红字消失）——原来一律说「已建档」是撒谎
    setTip(
      onQuickCreate
        ? `「${n}」已按${ASSET_TYPE_LABEL[type] || type}建档（只有名字，其余字段可空着后面补）`
        : `「${n}」已在本弹窗标记为已知、红字消失（当前页未接入建档回调，未真正入库）`,
    )
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
        // P2：created 里存的是 dashOut 归一后的名字（quickCreate 存的），这里比对也要 dashOut——
        //   原来用裸 l.to，带空格/书名号的目标即便已「顺便建档」红字也不消失（与下方新增行的 dashOut(draft.to) 判据不一致）
        const dangling = isDangling(l.to, assets) && !created.includes(dashOut(l.to))
        return (
          <div key={`${l.type}_${l.to}_${i}`} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50/60 px-2 py-1.5">
            <TypeSelect value={l.type} onChange={(t) => patchAt(i, { type: t })} assetType={assetType} disabled={disabled} className={disabled ? 'opacity-60' : ''} />
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
              <button type="button" onClick={() => quickCreate(l.to, l.type)} disabled={creating} className="rounded border border-red-400/50 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-40">
                {creating ? '建档中…' : '顺便建档'}
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
                <button type="button" onClick={() => quickCreate(draft.to)} disabled={creating} className="rounded border border-red-400/50 px-1.5 py-0.5 hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-40">
                  {creating ? '建档中…' : `顺便建档为${ASSET_TYPE_LABEL[LINK_TARGET_TYPE[draft.type] || 'person'] || '资产'}`}
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
