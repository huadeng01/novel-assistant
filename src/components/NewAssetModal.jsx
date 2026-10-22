import { useEffect, useMemo, useState } from 'react'
import ChapterField from './ChapterField.jsx'
import LinkEditor from './LinkEditor.jsx'
import StatePanel from './StatePanel.jsx'
import {
  ASSET_TYPES,
  ASSET_TYPE_LABEL,
  TIER_LABEL,
  TIER_ORDER,
  assetFieldCount,
  findByName,
  isAssetWorthSaving,
  mergeAssetDraft,
  normalizeAsset,
  normalizeState,
  splitListValue,
} from '../lib/assets.js'

const box = 'w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 text-sm leading-relaxed focus:border-red-400 focus:outline-none'
const line = 'rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none'
const label = 'mb-1 block text-xs font-medium text-stone-500'
const genBtn = 'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostBtn = 'rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100'

// 表单里所有字段的灰色示例（设计 §3 需求7：无红星、无 blur 校验、无提交前拦截，空着就是空着）
const PH = {
  name: '如：青冥山',
  aliases: '如：小青山, 青冥（逗号分隔，可空）',
  detail: '如：洲东最大宗门｜外门弟子三千｜禁地有古阵（可用｜分隔，也可整段白话）',
  knowers: '如：陆沉, 苏挽（可空）',
  controller: '如：青冥宗（选中即建「受控于」关系）',
  holder: '如：陆沉（选中即建「被持有」关系）',
  volume: '给了卷号就能参与透出/传闻分桶与防剧透门',
}

const blankDraft = () => ({
  type: 'person',
  name: '',
  aliasesStr: '',
  tier: 'M',
  detail: '',
  knowersStr: '',
  controller: '',
  holder: '',
  ch_reveal: '',
  ch_rumor: '',
  reveal_volume: '',
  rumor_volume: '',
  links: [],
  state: normalizeState(null),
})

// 新增 / 编辑资产表单（设计 §4.2，需求3 + 需求7 共用一个组件，避免两份表单漂移）。
// 硬要求：**所有字段可空**。只在提交时用 isAssetWorthSaving 判一次 —— 全空则不入库、给一行灰字提示、不弹错误框
// （空表单本来就没有数据损失风险，弹框只增加摩擦）。只有 type 没有别的也算全空（type 有默认值，不构成「用户填了内容」）；
// 只有 name → 入库（最小资产，符合「数量宁多」的既有取向）。
//
export default function NewAssetModal({ open, assets = [], perVol = 40, chapterNo = 0, onSubmit, onClose, onQuickCreate, idPrefix = 'mn' }) {
  const [draft, setDraft] = useState(blankDraft)
  const [msg, setMsg] = useState('')
  const [dupe, setDupe] = useState(null)

  // 打开时重置草稿；关弹窗不销毁组件实例也没关系，下次 open 会重灌
  useEffect(() => {
    if (!open) return
    setDraft({ ...blankDraft(), state: normalizeState(null) })
    setMsg('')
    setDupe(null)
  }, [open])

  const roster = assets || []
  const filled = assetFieldCount({
    ...draft,
    aliases: splitListValue(draft.aliasesStr),
    knowers: splitListValue(draft.knowersStr),
    state: normalizeState(draft.state),
  })
  const worth = isAssetWorthSaving({ ...draft, aliases: splitListValue(draft.aliasesStr), knowers: splitListValue(draft.knowersStr), state: normalizeState(draft.state) })

  const toAsset = () =>
    normalizeAsset(
      {
        ...draft,
        aliases: splitListValue(draft.aliasesStr),
        knowers: splitListValue(draft.knowersStr),
        state: normalizeState(draft.state),
      },
      { idPrefix },
    )

  const submit = () => {
    if (!worth) {
      // 全空 → 不入库、不弹错误框；直接关窗（设计 §3 需求7）
      const tip = '没填任何内容，已放弃新增'
      if (onSubmit) onSubmit(null, { mode: 'empty', reason: tip })
      if (onClose) onClose()
      return
    }
    // 第12轮a[1]·用户拍板A：worth(isAssetWorthSaving) 只看「任一字段有内容」、不校验 name——
    //   只填 links / 透出章 / 状态就能提交出空名资产（useAssets 兜底成「未命名」），污染关系图谱，
    //   且 findByName / isDangling 都按名字判定 → 空名会和别的资产对不上、悬空判定歧义。手动新建必须有名字。
    //   注：只拦这条手动路径；解析入库(parseAnalyze/parseBookAssets 产出的资产都带 name)与共享判据 isAssetWorthSaving 不动。
    if (!String(draft.name || '').trim()) {
      setDupe(null)
      setMsg('请先填资产名——名字是资产的主键，缺名会和别的资产对不上、污染关系图谱（其余字段可留空）')
      return
    }
    const asset = toAsset()
    const hit = findByName(roster, asset.name)
    if (hit) {
      setDupe(hit)
      setMsg(`名册里已有《${hit.name}》（${ASSET_TYPE_LABEL[hit.type] || hit.type}）。选一个处理方式，不会静默丢弃。`)
      return
    }
    setDupe(null)
    if (onSubmit) onSubmit(asset, { mode: 'create' })
    if (onClose) onClose()
  }

  const doMerge = () => {
    if (!dupe) return
    //   直传原始 draft 会静默丢掉用户填的别名/知情人 → 先 splitListValue 转成数组再合并。
    const merged = mergeAssetDraft(dupe, { ...draft, aliases: splitListValue(draft.aliasesStr), knowers: splitListValue(draft.knowersStr) }, { idPrefix })
    if (onSubmit) onSubmit(merged, { mode: 'merge', mergedFrom: dupe.id })
    setDupe(null)
    if (onClose) onClose()
  }

  const doForceAdd = () => {
    const asset = toAsset()
    if (onSubmit) onSubmit(asset, { mode: 'create', force: true })
    setDupe(null)
    if (onClose) onClose()
  }

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  //   存盘后编辑又能改，前后矛盾。统一为所有类型都显示。
  const showState = true
  const showTier = draft.type === 'person' || draft.type === 'group'
  // M-G：遮罩脏检查——已填了内容(filled>0)时点遮罩不直接关（会静默丢掉已填），先确认；与 EditAssetModal / ClarifyModal 口径一致。
  const requestClose = () => {
    if (filled > 0 && !window.confirm('已经填了内容，确定放弃并关闭吗？')) return
    if (onClose) onClose()
  }
  const quickCreate = useMemo(
    () => ({ name, type }) => {
      //   原来这里丢弃返回值(恒 undefined)，LinkEditor 的回滚对 NewAssetModal 这条路径永不生效、失败仍标「已建档」。
      if (onQuickCreate) return onQuickCreate({ name, type })
      setMsg(`「${name}」未在名册：本次先保留为悬空目标（只提示不阻断），可在资产库里再补建档。`)
      return undefined
    },
    [onQuickCreate],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/45 p-4" onClick={requestClose} role="dialog" aria-modal="true" aria-label="新增资产">
      <div className="flex max-h-[88vh] w-[min(620px,95vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">新增资产</span>
          <span className="text-[11px] text-stone-400">所有字段都可留空；已填 {filled} 项</span>
          <button onClick={requestClose} className="ml-2 text-stone-400 hover:text-stone-600" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[12rem] flex-1">
              <label className={label}>名字</label>
              <input value={draft.name} placeholder={PH.name} onChange={(e) => set({ name: e.target.value })} className={`${line} w-full`} />
            </div>
            <div>
              <label className={label}>类型</label>
              <select
                value={draft.type}
                onChange={(e) => {
                  const type = e.target.value
                  //   ①计入 assets.js COUNTED_FIELDS ⟹「已填 N 项」虚高 + 遮罩脏检查 confirm 误报"已填内容"；②经 normalizeAsset 落库 ⟹ 人物/势力带 holder 脏字段。
                  set({ type, ...(type !== 'item' && type !== 'beast' ? { holder: '' } : {}), ...(type !== 'place' ? { controller: '' } : {}) })
                }}
                className={line}
              >
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ASSET_TYPE_LABEL[t] || t}
                  </option>
                ))}
              </select>
            </div>
            {showTier && (
              <div>
                <label className={label}>分层</label>
                <select value={draft.tier} onChange={(e) => set({ tier: e.target.value })} className={line} title="token 紧张时按分层决定谁先被注入">
                  {TIER_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {t} · {TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className={label}>别名（逗号分隔，可空 · 用于名字匹配容错）</label>
            <input value={draft.aliasesStr} placeholder={PH.aliases} onChange={(e) => set({ aliasesStr: e.target.value })} className={`${line} w-full`} />
          </div>

          <div>
            <label className={label}>详细信息</label>
            <textarea value={draft.detail} placeholder={PH.detail} rows={4} onChange={(e) => set({ detail: e.target.value })} className={box} />
          </div>

          {showState && <StatePanel value={draft.state} onChange={(state) => set({ state })} assets={roster} chapterNo={chapterNo} updatedBy="user" />}

          <div className="flex flex-wrap gap-2">
            {draft.type === 'place' && (
              <div className="min-w-[12rem] flex-1">
                <label className={label}>控制方（可空）</label>
                <input value={draft.controller} placeholder={PH.controller} onChange={(e) => set({ controller: e.target.value })} className={`${line} w-full`} list="newasset-controllers" />
                <datalist id="newasset-controllers">
                  {roster
                    .filter((a) => a.type === 'faction' || a.type === 'place')
                    .map((a) => (
                      <option key={a.id || a.name} value={a.name} />
                    ))}
                </datalist>
              </div>
            )}
            {(draft.type === 'item' || draft.type === 'beast') && (
              <div className="min-w-[12rem] flex-1">
                <label className={label}>持有者（可空）</label>
                <input value={draft.holder} placeholder={PH.holder} onChange={(e) => set({ holder: e.target.value })} className={`${line} w-full`} list="newasset-holders" />
                <datalist id="newasset-holders">
                  {roster
                    .filter((a) => a.type === 'person' || a.type === 'group')
                    .map((a) => (
                      <option key={a.id || a.name} value={a.name} />
                    ))}
                </datalist>
              </div>
            )}
            <div className="min-w-[12rem] flex-1">
              <label className={label}>知情人（逗号分隔，可空）</label>
              <input value={draft.knowersStr} placeholder={PH.knowers} onChange={(e) => set({ knowersStr: e.target.value })} className={`${line} w-full`} />
            </div>
          </div>

          <LinkEditor links={draft.links} onChange={(links) => set({ links })} assets={roster} assetType={draft.type} selfName={draft.name} onQuickCreate={quickCreate} />

          <div className="flex flex-wrap items-end gap-3">
            <ChapterField kind="reveal" asset={draft} value={draft.ch_reveal} onChange={(n) => set({ ch_reveal: n })} perVol={perVol} width="w-20" />
            <ChapterField kind="rumor" asset={draft} value={draft.ch_rumor} onChange={(n) => set({ ch_rumor: n })} perVol={perVol} width="w-20" />
            <div>
              <label className={label}>透出卷</label>
              <input type="number" min="0" value={draft.reveal_volume} placeholder="0" onChange={(e) => set({ reveal_volume: e.target.value })} className={`${line} w-20`} title={PH.volume} />
            </div>
            <div>
              <label className={label}>传闻卷</label>
              <input type="number" min="0" value={draft.rumor_volume} placeholder="0" onChange={(e) => set({ rumor_volume: e.target.value })} className={`${line} w-20`} title={PH.volume} />
            </div>
          </div>

          {!worth && <div className="text-[11px] text-stone-400">现在一个字段都没填：提交不会入库（不弹错误框，只在按钮旁给一行灰字）。</div>}
          {msg && <div className="text-[11px] text-stone-400">{msg}</div>}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          {dupe ? (
            <>
              <span className="mr-auto text-[11px] text-stone-500">重名《{dupe.name}》：合并进已有条目，还是当同名不同人另建一条？</span>
              {/* 默认焦点在「合并」（设计 §3 需求7 第3点） */}
              <button autoFocus onClick={doMerge} className={genBtn}>
                合并到已有《{dupe.name}》
              </button>
              <button onClick={doForceAdd} className={ghostBtn}>
                仍新增（同名不同人）
              </button>
              <button onClick={() => setDupe(null)} className="px-2 py-1.5 text-sm text-stone-400 hover:underline">
                回去改名字
              </button>
            </>
          ) : (
            <>
              <span className="mr-auto text-[11px] text-stone-400">{!worth ? '全空提交 = 不入库' : !String(draft.name || '').trim() ? '还缺资产名（必填），其余字段可空' : `将保存 ${filled} 项内容`}</span>
              <button onClick={submit} className={genBtn}>
                新增资产
              </button>
              <button onClick={requestClose} className={ghostBtn}>
                取消
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
