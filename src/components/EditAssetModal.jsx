import { useEffect, useRef, useState } from 'react'
import { ASSET_TYPES, ASSET_TYPE_LABEL, TIER_LABEL, TIER_ORDER, findByName } from '../lib/assets.js'
import ChapterField from './ChapterField.jsx'
import LinkEditor from './LinkEditor.jsx'
import StatePanel from './StatePanel.jsx'

const box = 'w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 text-sm leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const line = 'rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const label = 'mb-1 block text-xs font-medium text-stone-500'
const genBtn = 'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostBtn = 'rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100'

// 资产编辑弹窗：长篇写作与续写共用。editDraft 为 null 时不渲染。
// 阶段1(设计 §6.2)：透出/传闻章换 ChapterField(原始值输入 + 按卷估算小字)、关系区换 LinkEditor(可加边/删边/起始章/名册外「顺便建档」)、
//   新增 StatePanel(8 维状态，5 核心展开 + 3 折叠)、类型下拉补 skill/beast、加分层 tier 与别名 aliases 编辑。
//   保存白名单须含 state/aliases/tier(见父页 saveEdit：走 normalizeAsset)。
// 别名/知情人用表单字符串(aliasesStr/knowersStr)承载，与 NewAssetModal 同范式，并向后兼容长篇页原 knowersStr 契约；保存时由父页转数组。
// 向后兼容：新增 props(assets/chapterNo/onQuickCreate)可选，长篇页不传也能用(LinkEditor/StatePanel 候选为空则手填)。
export default function EditAssetModal({ editDraft, setEditDraft, onClose, onSave, onDelete, onMerge, perVol = 40, assets = [], chapterNo = 0, onQuickCreate }) {
  // P1-11：改名撞上名册里另一个已有资产时，暂存命中项、弹出三选一面板（合并 / 仍要改名 / 回去改），
  //   不再让「保存修改」直接落库造成两条同名资产（边/悬空判定全歧义）。hooks 必须在 early-return 之前调用。
  const [conflict, setConflict] = useState(null) // { hit } | null
  const [nameErr, setNameErr] = useState(false) // M-G：空名保存被拦时提示
  const draftId = editDraft && editDraft.id
  // M-G：脏检查——捕获打开时的草稿快照，之后 editDraft 与它不同即「有未保存修改」，遮罩/Esc 不直接关（避免误点丢掉已填），
  //   与 ClarifyModal / PromptEditorModal / DiagnosePanel「已编辑则遮罩不响应」口径一致。✕ / 取消 / 保存 是明确操作，照常。
  const initialRef = useRef(null)
  // 换了一个资产来编辑（或弹窗关闭）时清掉上一次的重名面板 / 空名提示，并重置脏快照
  useEffect(() => {
    setConflict(null)
    setNameErr(false)
    initialRef.current = editDraft ? JSON.stringify(editDraft) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])
  const dirty = !!editDraft && initialRef.current != null && JSON.stringify(editDraft) !== initialRef.current
  const requestClose = () => {
    // 遮罩 / Esc 走这里：有未保存修改时不直接关（用户需改用 ✕ / 取消 / 保存，或先撤销修改）
    if (dirty) {
      setNameErr(false)
      setConflict(null)
      // 用一次性提示替代静默丢弃：这里复用 conflict 之外的轻量 alert 语义——直接 confirm，取消则留在弹窗
      if (!window.confirm('有未保存的修改，确定放弃并关闭吗？')) return
    }
    onClose()
  }
  // P2：支持 Esc 关闭（与项目里各弹窗 / 续写页确认弹窗一致）——原来只能点 ✕ / 取消 / 遮罩
  useEffect(() => {
    if (!draftId) return
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, dirty])
  if (!editDraft) return null
  // M7：与 ContinuePage.applyStateSettlement 对齐——它按资产名给任意类型写 state，故所有类型都显示 StatePanel；
  //   原白名单 ['person','group','item','beast'] 排除 faction/place/skill，会导致 AI 结算写了状态、编辑弹窗却看不到也改不了。
  const showState = true
  const showTier = editDraft.type === 'person' || editDraft.type === 'group'
  const str = (v) => (Array.isArray(v) ? v.join(', ') : v || '')
  // 保存前先查重名：findByName 走 assets.js 单一出处（dashOut 归一），排除自身 id
  const handleSave = () => {
    const nm = (editDraft.name || '').trim()
    // M-G：空名拦截——原来 nm 为空时跳过重名检查直接 onSave，normalizeAsset 兜底成「未命名」入图谱
    //   （与 NewAssetModal 拦无名相反），产生一堆「未命名」脏资产、边/悬空判定全歧义。
    if (!nm) {
      setConflict(null)
      setNameErr(true)
      return
    }
    const hit = findByName(assets, nm)
    if (hit && hit.id !== editDraft.id) {
      setNameErr(false)
      setConflict({ hit })
      return
    }
    setConflict(null)
    setNameErr(false)
    onSave()
  }
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/45 p-4" onClick={requestClose} role="dialog" aria-modal="true" aria-label="编辑资产">
      <div className="flex max-h-[86vh] w-[min(600px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">编辑资产</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[10rem] flex-1">
              <label className={label}>名字</label>
              <input value={editDraft.name || ''} onChange={(e) => { setConflict(null); setNameErr(false); setEditDraft({ ...editDraft, name: e.target.value }) }} className={`${line} w-full`} />
              {nameErr && <p className="mt-1 text-[11px] text-red-500">请先填资产名——名字是资产的主键，空名会被兜底成「未命名」污染图谱。</p>}
            </div>
            <div>
              <label className={label}>类型</label>
              <select
                value={editDraft.type || 'person'}
                onChange={(e) => {
                  const type = e.target.value
                  // item6（第十轮）：切类型清掉不再适用的 holder(仅 item/beast)/controller(仅 place)——门控(:164/:175)只藏 UI 不清值 ⟹ 旧值残留、经 onSave→normalizeAsset 落库成脏字段。
                  const clearHolder = type !== 'item' && type !== 'beast'
                  const clearCtrl = type !== 'place'
                  // 次修11（第十一轮·存疑A）：EditAssetModal 编辑的是**既有资产**——清 holder/controller 会让 onSave→rebuildDerivedEdges 按空值重算、静默移除原有 held_by/controlled_by 边（用户数据）。
                  //   故确有会被移除的关系时先 confirm，不静默删。（NewAssetModal 是新建、无既有数据，保持 item6 直接清值、不加 confirm。）
                  const curHolder = editDraft.holder != null ? editDraft.holder : ((editDraft.links || []).find((l) => l.type === 'held_by') || {}).to || ''
                  const curCtrl = editDraft.controller != null ? editDraft.controller : ((editDraft.links || []).find((l) => l.type === 'controlled_by') || {}).to || ''
                  const losing = (clearHolder && String(curHolder).trim()) || (clearCtrl && String(curCtrl).trim())
                  if (losing && !window.confirm('切换类型会移除当前的持有者 / 控制者关系，确定切换吗？')) return
                  setEditDraft({ ...editDraft, type, ...(clearHolder ? { holder: '' } : {}), ...(clearCtrl ? { controller: '' } : {}) })
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
                <select value={editDraft.tier || 'M'} onChange={(e) => setEditDraft({ ...editDraft, tier: e.target.value })} className={line} title="token 紧张时按分层决定谁先被注入">
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
            <input
              value={editDraft.aliasesStr != null ? editDraft.aliasesStr : str(editDraft.aliases)}
              onChange={(e) => setEditDraft({ ...editDraft, aliasesStr: e.target.value })}
              className={`${line} w-full`}
            />
          </div>

          <div>
            <label className={label}>详细信息</label>
            <textarea value={editDraft.detail || ''} onChange={(e) => setEditDraft({ ...editDraft, detail: e.target.value })} rows={4} className={box} />
          </div>

          {showState && (
            <StatePanel value={editDraft.state} onChange={(state) => setEditDraft({ ...editDraft, state })} assets={assets} chapterNo={chapterNo} updatedBy="user" />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <ChapterField kind="reveal" asset={editDraft} value={editDraft.ch_reveal} onChange={(n) => setEditDraft({ ...editDraft, ch_reveal: n })} perVol={perVol} width="w-20" />
            <ChapterField kind="rumor" asset={editDraft} value={editDraft.ch_rumor} onChange={(n) => setEditDraft({ ...editDraft, ch_rumor: n })} perVol={perVol} width="w-20" />
            <div>
              <label className={label}>透出卷</label>
              <input type="number" min="0" value={editDraft.reveal_volume || ''} onChange={(e) => setEditDraft({ ...editDraft, reveal_volume: e.target.value })} className={`${line} w-20`} />
            </div>
            <div>
              <label className={label}>传闻卷</label>
              <input type="number" min="0" value={editDraft.rumor_volume || ''} onChange={(e) => setEditDraft({ ...editDraft, rumor_volume: e.target.value })} className={`${line} w-20`} />
            </div>
          </div>

          <div>
            <label className={label}>知情人（逗号分隔，可空）</label>
            <input
              value={editDraft.knowersStr != null ? editDraft.knowersStr : str(editDraft.knowers)}
              onChange={(e) => setEditDraft({ ...editDraft, knowersStr: e.target.value })}
              className={`${line} w-full`}
            />
          </div>

          {/* P1-12：持有者 / 控制者输入（与 NewAssetModal 对齐）——held_by / controlled_by 边由这两个字段自动生成，
              原来这里没有输入框，用户想改/删这两类边「无从下手」，只能去删边、保存后又被 normalizeAsset 按字段重建。 */}
          {(editDraft.type === 'item' || editDraft.type === 'beast') && (
            <div>
              <label className={label}>持有者（可空 · 道具/妖兽专用，自动生成「被持有」边）</label>
              <input
                value={editDraft.holder != null ? editDraft.holder : ((editDraft.links || []).find((l) => l.type === 'held_by') || {}).to || ''}
                onChange={(e) => setEditDraft({ ...editDraft, holder: e.target.value })}
                placeholder="如：陆沉"
                className={`${line} w-full`}
              />
            </div>
          )}
          {/* item5：控制者只在 place 渲染——controlled_by 仅 LINK_BY_TYPE.place 白名单含（assets.js:490），
              faction 白名单是反向的 controls、其余类型都没有；非 place 类型填了 controller，rebuildDerivedEdges:594 白名单过滤会静默丢弃（假成功）。
              与上方持有者(item||beast，:164)同口径：按 assets.js 实际派生边白名单门控输入框。 */}
          {editDraft.type === 'place' && (
            <div>
              <label className={label}>控制者（可空 · 自动生成「受控于」边）</label>
              <input
                value={editDraft.controller != null ? editDraft.controller : ((editDraft.links || []).find((l) => l.type === 'controlled_by') || {}).to || ''}
                onChange={(e) => setEditDraft({ ...editDraft, controller: e.target.value })}
                placeholder="如：青冥宗"
                className={`${line} w-full`}
              />
            </div>
          )}

          <LinkEditor
            links={editDraft.links || []}
            onChange={(links) => setEditDraft({ ...editDraft, links })}
            assets={assets}
            assetType={editDraft.type || 'person'}
            selfName={editDraft.name || ''}
            onQuickCreate={onQuickCreate}
          />
          {/* P1-12：明示三类派生边的来源，避免用户「删了边保存又冒出来」却不知为何 */}
          {/* 第十轮订正：文案随 item5 门控更新——持有者输入框仅道具/妖兽显示、控制者仅地点显示（原笼统写「上方的持有者、控制者」，对人物等类型指向了并不存在的输入框） */}
          <p className="text-[10px] leading-relaxed text-stone-400">
            注：「位于 / 被持有 / 受控于」这三类边是自动生成的——「位于」来自下方状态面板的<b>位置</b>（所有类型）；「被持有」来自<b>持有者</b>输入框（仅道具/妖兽显示）、「受控于」来自<b>控制者</b>输入框（仅地点显示）。
            直接在关系列表里删这类边、保存后会按来源字段重建；要改请改对应来源（位置改状态面板、持有/控制改对应输入框）。
          </p>
        </div>
        {/* P1-11：重名三选一面板——命中名册里另一个已有资产时挡在保存前，避免落库出两条同名 */}
        {conflict && (
          <div className="border-t border-amber-200 bg-amber-50 px-5 py-3">
            <p className="text-xs leading-relaxed text-amber-800">
              名册里已有《{conflict.hit.name}》。若仍用这个名字保存，会出现两条同名资产，关系边与悬空判定都会歧义。你想怎么处理？
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onMerge && (
                <button
                  onClick={() => { onMerge(editDraft, conflict.hit); setConflict(null) }}
                  className="rounded-lg bg-red-700 px-3 py-1.5 text-xs text-onaccent hover:bg-red-600"
                >
                  合并进《{conflict.hit.name}》
                </button>
              )}
              <button
                onClick={() => { setConflict(null); onSave() }}
                className="rounded-lg border border-amber-400 bg-paper px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100"
              >
                仍要改名（保留两条）
              </button>
              <button onClick={() => setConflict(null)} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100">
                回去改名字
              </button>
            </div>
            {!onMerge && <p className="mt-1.5 text-[10px] text-amber-700">（当前页未接入「合并」，如需合并请到续写页的资产库操作。）</p>}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button onClick={() => { if (window.confirm(`确定删除资产《${editDraft.name || '未命名'}》吗？此操作不可撤销。`)) onDelete() }} className="px-3 py-1.5 text-sm text-red-400 hover:underline">
            删除资产
          </button>
          <button onClick={handleSave} className={genBtn}>
            保存修改
          </button>
          <button onClick={onClose} className={ghostBtn}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
