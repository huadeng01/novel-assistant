import { useMemo, useState } from 'react'
import { STATE_DIM_LABEL, STATE_DIMS_CORE, STATE_DIMS_EXTRA, normalizeState, stateHasContent, stateLabel, stateOptions } from '../lib/assets.js'

const sel = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-1 text-xs focus:border-red-400 focus:outline-none'
const inp = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-1 text-xs focus:border-red-400 focus:outline-none'
const rowCls = 'flex flex-wrap items-center gap-1.5 border-b border-stone-200/70 py-1.5 last:border-b-0'
const dimCls = 'w-14 shrink-0 text-xs font-medium text-stone-500'
const addBtn = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-600 hover:bg-stone-100'

const sinceBox = (v, set, label = '自第') => (
  <label className="flex items-center gap-1 text-[10px] text-stone-400">
    {label}
    <input type="number" min="0" value={v || ''} onChange={(e) => set(Number(e.target.value) || 0)} className={`${inp} w-14 px-1 py-0.5 text-[11px]`} aria-label={label} />
    章
  </label>
)

// 人物状态维度面板（设计 §4.3）。
// 8 大维度全做，但按拍板分两层：5 核心维度（生理/修为/持有/剧情/位置）默认展开，3 维度（心理/身份社会/关系）折叠在「更多维度」里，
// 不填也能存 —— schema 留位，避免以后再改数据结构。
//
// 纪律（设计 §4.4，硬要求）：这里录入的是结构化数据，但**给 AI 的注入一律走 stateToPromptLine 压成一句人话**，
// 绝不把维度拆成子字段堆给 AI、不输出 JSON、不出现 tag 英文枚举或字段名。下拉上给用户看的全是中文口语词，存的是英文枚举
// （与 parseAssets.js LINK_LABEL 同范式）。
//
// props
//   value       state（v1 字符串 / null / v2 对象都吃，内部走 normalizeState）
//   onChange    (nextStateV2) => void
//   assets      名册（位置维度的地点候选、持有维度的道具候选）
//   chapterNo   当前章号（写进 meta.sourceCh，可追溯是哪一章结算来的）
//   updatedBy   'user' | 'analyze'
export default function StatePanel({ value, onChange, assets = [], chapterNo = 0, updatedBy = 'user', showMeta = true, defaultOpenExtra = false }) {
  const st = useMemo(() => normalizeState(value), [value])
  const [openExtra, setOpenExtra] = useState(defaultOpenExtra)

  const places = useMemo(() => (assets || []).filter((a) => a && a.type === 'place').map((a) => a.name).filter(Boolean), [assets])
  const items = useMemo(() => (assets || []).filter((a) => a && (a.type === 'item' || a.type === 'beast')).map((a) => a.name).filter(Boolean), [assets])
  const persons = useMemo(() => (assets || []).filter((a) => a && (a.type === 'person' || a.type === 'group' || a.type === 'faction')).map((a) => a.name).filter(Boolean), [assets])

  if (!onChange) return null

  // 空维度一律落 null / []，不落「空壳对象」——否则 isAssetWorthSaving 会把没填过的状态算成有内容，需求7 失效
  const write = (next) => {
    const meta = { updatedAt: Date.now(), updatedBy: updatedBy || 'user', sourceCh: Number(chapterNo) || (st.meta && st.meta.sourceCh) || 0 }
    onChange({ ...next, v: 2, meta })
  }

  const setObjDim = (dim, patch) => {
    const cur = st[dim] && typeof st[dim] === 'object' ? st[dim] : {}
    const merged = { ...cur, ...patch }
    const filled = ['tag', 'note', 'ref', 'to', 'since', 'ch', 'firstCh', 'lastCh'].some((k) => {
      const v = merged[k]
      return typeof v === 'number' ? v > 0 : String(v == null ? '' : v).trim() !== ''
    })
    write({ ...st, [dim]: filled ? merged : null })
  }

  const setListDim = (dim, i, patch) => {
    const arr = Array.isArray(st[dim]) ? st[dim] : []
    write({ ...st, [dim]: arr.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  }
  const addListDim = (dim, seed) => {
    const arr = Array.isArray(st[dim]) ? st[dim] : []
    write({ ...st, [dim]: [...arr, seed] })
  }
  const delListDim = (dim, i) => {
    const arr = Array.isArray(st[dim]) ? st[dim] : []
    write({ ...st, [dim]: arr.filter((_, j) => j !== i) })
  }

  const tagSelect = (dim, extra = '') => (
    <select value={(st[dim] && st[dim].tag) || ''} onChange={(e) => setObjDim(dim, { tag: e.target.value })} className={`${sel} ${extra}`} aria-label={`${STATE_DIM_LABEL[dim]}状态`}>
      {stateOptions(dim).map((o) => (
        <option key={o.value || 'none'} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )

  const noteInput = (dim, ph) => (
    <input
      value={(st[dim] && st[dim].note) || ''}
      placeholder={ph}
      onChange={(e) => setObjDim(dim, { note: e.target.value })}
      className={`${inp} min-w-0 flex-1`}
      aria-label={`${STATE_DIM_LABEL[dim]}说明`}
    />
  )

  const simpleDim = (dim, ph) => (
    <div className={rowCls}>
      <span className={dimCls}>{STATE_DIM_LABEL[dim]}</span>
      {tagSelect(dim)}
      {noteInput(dim, ph)}
      {sinceBox(st[dim] && st[dim].since, (since) => setObjDim(dim, { since }))}
    </div>
  )

  const meta = st.meta
  const hasAny = stateHasContent(st)

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/40 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-ink">状态</span>
        {!hasAny && <span className="text-[10px] text-stone-400">全可空，不填也能保存</span>}
        {showMeta && meta && (meta.sourceCh || meta.updatedAt) && (
          <span className="ml-auto text-[10px] text-stone-400">
            {meta.sourceCh ? `第 ${meta.sourceCh} 章更新` : '已更新'} · {meta.updatedBy === 'analyze' ? 'AI 结算' : '手动'}
          </span>
        )}
      </div>

      {/* —— 核心 5 维（默认展开）—— */}
      {simpleDim('phys', '说明，如：左臂中毒未解')}

      <div className={rowCls}>
        <span className={dimCls}>{STATE_DIM_LABEL.power}</span>
        {tagSelect('power')}
        <input
          value={(st.power && st.power.note) || ''}
          placeholder="境界名，如：金丹中期"
          onChange={(e) => setObjDim('power', { note: e.target.value, tag: (st.power && st.power.tag) || 'realm' })}
          className={`${inp} min-w-0 flex-1`}
          aria-label="修为境界"
        />
        {sinceBox(st.power && st.power.since, (since) => setObjDim('power', { since }))}
      </div>

      <div className={rowCls}>
        <span className={dimCls}>{STATE_DIM_LABEL.hold}</span>
        <div className="min-w-0 flex-1 space-y-1">
          {(Array.isArray(st.hold) ? st.hold : []).map((h, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                value={h.name || ''}
                list={`statepanel-items-${i}`}
                placeholder="资产名，如：青竹剑"
                onChange={(e) => setListDim('hold', i, { name: e.target.value })}
                className={`${inp} w-28`}
                aria-label="持有资产名"
              />
              <datalist id={`statepanel-items-${i}`}>
                {items.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <select value={h.change || ''} onChange={(e) => setListDim('hold', i, { change: e.target.value })} className={sel} aria-label="流转类型">
                {stateOptions('hold').map((o) => (
                  <option key={o.value || 'none'} value={o.value}>
                    {o.value ? o.label : '未设定'}
                  </option>
                ))}
              </select>
              {sinceBox(h.ch, (ch) => setListDim('hold', i, { ch }), '第')}
              <input value={h.note || ''} placeholder="备注（可空）" onChange={(e) => setListDim('hold', i, { note: e.target.value })} className={`${inp} min-w-0 flex-1`} aria-label="流转备注" />
              <button type="button" onClick={() => delListDim('hold', i)} className="text-[11px] text-red-400 hover:underline">
                删
              </button>
            </div>
          ))}
          <button type="button" onClick={() => addListDim('hold', { name: '', change: '', ch: Number(chapterNo) || 0 })} className={addBtn}>
            + 变更（获得/失去/损坏/消耗/易主）
          </button>
          <div className="text-[10px] text-stone-400">损毁/消耗的道具只做标注、不从资产表删除，AI 才知道「为什么主角不用它」。</div>
        </div>
      </div>

      <div className={rowCls}>
        <span className={dimCls}>{STATE_DIM_LABEL.plot}</span>
        {tagSelect('plot')}
        {sinceBox(st.plot && st.plot.firstCh, (firstCh) => setObjDim('plot', { firstCh }), '首现')}
        {sinceBox(st.plot && st.plot.lastCh, (lastCh) => setObjDim('plot', { lastCh }), '末现')}
      </div>

      <div className={rowCls}>
        <span className={dimCls}>{STATE_DIM_LABEL.place}</span>
        {tagSelect('place')}
        <input
          value={(st.place && st.place.ref) || ''}
          list="statepanel-places"
          placeholder="地点，如：青冥山"
          onChange={(e) => setObjDim('place', { ref: e.target.value, tag: (st.place && st.place.tag) || 'at' })}
          className={`${inp} min-w-0 flex-1`}
          aria-label="所在地点"
        />
        <datalist id="statepanel-places">
          {places.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {sinceBox(st.place && st.place.since, (since) => setObjDim('place', { since }))}
      </div>
      <div className="pb-1 text-[10px] text-stone-400">设了「在某地」会自动补一条「位于」关系边；删边不会清掉这里的位置（避免误清）。</div>

      {/* —— 更多维度（默认折叠：心理 / 身份社会 / 关系）—— */}
      <button type="button" onClick={() => setOpenExtra((v) => !v)} className="mt-1 text-[11px] text-stone-500 hover:text-stone-700">
        {openExtra ? '▾' : '▸'} 更多维度（{STATE_DIMS_EXTRA.map((d) => STATE_DIM_LABEL[d]).join(' / ')}）
      </button>
      {openExtra && (
        <div className="mt-1 rounded-lg border border-stone-200 bg-paper/60 px-2">
          {simpleDim('mind', '说明，如：认定师兄是内鬼')}
          {simpleDim('social', '说明，如：青冥宗外门弟子 / 被通缉')}

          <div className={rowCls}>
            <span className={dimCls}>{STATE_DIM_LABEL.rel}</span>
            <div className="min-w-0 flex-1 space-y-1">
              {(Array.isArray(st.rel) ? st.rel : []).map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <select value={r.tag || ''} onChange={(e) => setListDim('rel', i, { tag: e.target.value })} className={sel} aria-label="关系状态">
                    {stateOptions('rel').map((o) => (
                      <option key={o.value || 'none'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={r.to || ''}
                    list={`statepanel-persons-${i}`}
                    placeholder="对象名"
                    onChange={(e) => setListDim('rel', i, { to: e.target.value })}
                    className={`${inp} w-28`}
                    aria-label="关系对象"
                  />
                  <datalist id={`statepanel-persons-${i}`}>
                    {persons.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                  {sinceBox(r.ch, (ch) => setListDim('rel', i, { ch }), '第')}
                  <input value={r.note || ''} placeholder="备注（可空）" onChange={(e) => setListDim('rel', i, { note: e.target.value })} className={`${inp} min-w-0 flex-1`} aria-label="关系备注" />
                  <button type="button" onClick={() => delListDim('rel', i)} className="text-[11px] text-red-400 hover:underline">
                    删
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => addListDim('rel', { tag: '', to: '', ch: Number(chapterNo) || 0 })} className={addBtn}>
                + 关系变更
              </button>
              <div className="text-[10px] text-stone-400">这里是「关系的时序版」（谁在第几章背叛/和解）；稳定的静态关系用上方「关系绑定」的边承载。</div>
            </div>
          </div>
        </div>
      )}

      {st.legacy && <div className="mt-1 text-[10px] text-stone-400">旧版状态字符串「{st.legacy}」已迁移到剧情维度（原值保留不丢）。</div>}
      {!hasAny && STATE_DIMS_CORE.length > 0 && <div className="mt-1 text-[10px] text-stone-400">现在没有任何状态记录：注入给 AI 时不会出现「现况」行。</div>}
      {hasAny && <div className="mt-1 text-[10px] text-stone-500">给 AI 的注入会压成一句人话（不出现字段名/英文枚举）。</div>}
    </div>
  )
}

// 只读展示形态：资产卡上的「现况」行与结算预览共用（同源文本，设计 §6.1）
export function StateSummary({ value, className = '' }) {
  const st = useMemo(() => normalizeState(value), [value])
  if (!stateHasContent(st)) return null
  const bits = []
  if (st.power && (st.power.note || st.power.tag)) bits.push(st.power.tag === 'realm' ? st.power.note : stateLabel('power', st.power.tag))
  if (st.phys && (st.phys.note || st.phys.tag)) bits.push(st.phys.note || stateLabel('phys', st.phys.tag))
  if (st.place && st.place.ref) bits.push(`人在${st.place.ref}`)
  if (Array.isArray(st.hold) && st.hold.length) bits.push(`持有 ${st.hold.filter((h) => h.change === 'gain' || !h.change).map((h) => h.name).filter(Boolean).join('、') || '—'}`)
  if (st.plot && st.plot.tag && st.plot.tag !== 'active') bits.push(stateLabel('plot', st.plot.tag))
  const text = bits.filter(Boolean).join('，')
  if (!text) return null
  return <div className={`text-[11px] leading-relaxed text-stone-500 ${className}`}>{text}</div>
}
