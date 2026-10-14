import { ASSET_TYPES, ASSET_TYPE_LABEL, TIER_LABEL, TIER_ORDER } from '../lib/assets.js'
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
export default function EditAssetModal({ editDraft, setEditDraft, onClose, onSave, onDelete, perVol = 40, assets = [], chapterNo = 0, onQuickCreate }) {
  if (!editDraft) return null
  // M7：与 ContinuePage.applyStateSettlement 对齐——它按资产名给任意类型写 state，故所有类型都显示 StatePanel；
  //   原白名单 ['person','group','item','beast'] 排除 faction/place/skill，会导致 AI 结算写了状态、编辑弹窗却看不到也改不了。
  const showState = true
  const showTier = editDraft.type === 'person' || editDraft.type === 'group'
  const str = (v) => (Array.isArray(v) ? v.join(', ') : v || '')
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
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
              <input value={editDraft.name || ''} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} className={`${line} w-full`} />
            </div>
            <div>
              <label className={label}>类型</label>
              <select value={editDraft.type || 'person'} onChange={(e) => setEditDraft({ ...editDraft, type: e.target.value })} className={line}>
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

          <LinkEditor
            links={editDraft.links || []}
            onChange={(links) => setEditDraft({ ...editDraft, links })}
            assets={assets}
            assetType={editDraft.type || 'person'}
            selfName={editDraft.name || ''}
            onQuickCreate={onQuickCreate}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button onClick={() => { if (window.confirm(`确定删除资产《${editDraft.name || '未命名'}》吗？此操作不可撤销。`)) onDelete() }} className="px-3 py-1.5 text-sm text-red-400 hover:underline">
            删除资产
          </button>
          <button onClick={onSave} className={genBtn}>
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
