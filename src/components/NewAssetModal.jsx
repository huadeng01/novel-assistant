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

// 状态面板对这几类有意义：人物/群像（生理修为位置剧情）、道具/宠物（流转与损毁标注，设计 §4.5）
const STATE_TYPES = ['person', 'group', 'item', 'beast']
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
// props
//   open         是否渲染
//   mode         'create' | 'edit'
//   initial      编辑模式的原始资产（会先过 normalizeAsset）
//   assets       名册（重名判据 + LinkEditor/StatePanel 的候选）
//   perVol       perVolOf(book)（ChapterField 的按卷估算，两页必须同源，需求4）
//   chapterNo    当前章号（写进 state.meta.sourceCh）
//   onSubmit     (asset, info) => void；info = { mode:'create'|'edit'|'merge', mergedFrom?:id }
//   onClose      关闭
//   onQuickCreate ({name,type}) => void  LinkEditor「顺便建档」透传（不传则只在表单内本地记名）
export default function NewAssetModal({ open, mode = 'create', initial = null, assets = [], perVol = 40, chapterNo = 0, onSubmit, onClose, onQuickCreate, idPrefix = 'mn' }) {
  const [draft, setDraft] = useState(blankDraft)
  const [msg, setMsg] = useState('')
  const [dupe, setDupe] = useState(null)

  // 打开时（或切换编辑对象时）重置草稿；关弹窗不销毁组件实例也没关系，下次 open 会重灌
  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initial) {
      const a = normalizeAsset(initial, { idPrefix })
      setDraft({
        ...blankDraft(),
        ...a,
        aliasesStr: (a.aliases || []).join(', '),
        knowersStr: (a.knowers || []).join(', '),
        controller: ((a.links || []).find((l) => l.type === 'controlled_by') || {}).to || '',
        ch_reveal: a.ch_reveal || '',
        ch_rumor: a.ch_rumor || '',
        reveal_volume: a.reveal_volume || '',
        rumor_volume: a.rumor_volume || '',
      })
    } else {
      setDraft({ ...blankDraft(), state: normalizeState(null) })
    }
    setMsg('')
    setDupe(null)
  }, [open, mode, initial, idPrefix])

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
        id: mode === 'edit' && initial ? initial.id : undefined,
        aliases: splitListValue(draft.aliasesStr),
        knowers: splitListValue(draft.knowersStr),
        state: normalizeState(draft.state),
      },
      { idPrefix },
    )

  const submit = () => {
    if (!worth) {
      // 全空 → 不入库、不弹错误框；create 模式直接关窗（设计 §3 需求7）
      const tip = '没填任何内容，已放弃' + (mode === 'edit' ? '保存（原资产未改动）' : '新增')
      if (mode === 'edit') {
        setMsg(tip)
        return
      }
      if (onSubmit) onSubmit(null, { mode: 'empty', reason: tip })
      if (onClose) onClose()
      return
    }
    const asset = toAsset()
    // 重名：不静默丢弃，给「合并 / 仍新增」两个选择
    const hit = findByName(roster.filter((a) => mode !== 'edit' || !initial || a.id !== initial.id), asset.name)
    if (hit) {
      setDupe(hit)
      setMsg(`名册里已有《${hit.name}》（${ASSET_TYPE_LABEL[hit.type] || hit.type}）。选一个处理方式，不会静默丢弃。`)
      return
    }
    setDupe(null)
    if (onSubmit) onSubmit(asset, { mode })
    // M27：不再 setMsg——紧接 onClose() 后弹窗即卸载(!open return null)，msg 永不渲染(死代码)；成功提示由父层(ContinuePage setAssetMsg)负责
    if (onClose) onClose()
  }

  const doMerge = () => {
    if (!dupe) return
    const merged = mergeAssetDraft(dupe, draft, { idPrefix })
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
  const showState = STATE_TYPES.includes(draft.type)
  const showTier = draft.type === 'person' || draft.type === 'group'
  const quickCreate = useMemo(
    () => ({ name, type }) => {
      if (onQuickCreate) onQuickCreate({ name, type })
      else setMsg(`「${name}」未在名册：本次先保留为悬空目标（只提示不阻断），可在资产库里再补建档。`)
    },
    [onQuickCreate],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[min(620px,95vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">{mode === 'edit' ? '编辑资产' : '新增资产'}</span>
          <span className="text-[11px] text-stone-400">所有字段都可留空{mode === 'edit' ? '' : `；已填 ${filled} 项`}</span>
          <button onClick={onClose} className="ml-2 text-stone-400 hover:text-stone-600" aria-label="关闭">
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
              <select value={draft.type} onChange={(e) => set({ type: e.target.value })} className={line}>
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
            {(draft.type === 'place' || draft.type === 'faction') && (
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
            {draft.type === 'item' && (
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
              <span className="mr-auto text-[11px] text-stone-400">{worth ? `将保存 ${filled} 项内容` : '全空提交 = 不入库'}</span>
              <button onClick={submit} className={genBtn}>
                {mode === 'edit' ? '保存修改' : '新增资产'}
              </button>
              <button onClick={onClose} className={ghostBtn}>
                取消
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
