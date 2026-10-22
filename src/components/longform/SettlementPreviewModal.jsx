import { ASSET_TYPES, ASSET_TYPE_LABEL, typeKeyOf } from '../../lib/assets.js'
import { genBtn, ghostBtn } from './styles.js'

// 结算预览弹窗：状态变更(旧值→新值,可改状态词)/资产流转/伏笔推进三段，默认全选、逐条可取消，落库选中才写
export default function SettlementPreviewModal({
  open,
  onClose,
  chapterNo,
  pendingState,
  selState,
  setSelState,
  setPendingState,
  pendingFlow,
  selFlow,
  setSelFlow,
  setPendingFlow,
  pendingHook,
  selHook,
  setSelHook,
  setPendingHook,
  oldStateWord,
  assetExists,
  foreshadowStateOf,
  onApply,
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="状态结算预览">
      <div className="flex max-h-[86vh] w-[min(720px,95vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="font-semibold text-ink">结算第{chapterNo}章 · 预览勾选后落库</span>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-500">状态变更（{pendingState.length}）</h4>
            {pendingState.map((sc, i) => (
              <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                <input type="checkbox" checked={selState.includes(i)} onChange={(e) => setSelState(e.target.checked ? [...selState, i] : selState.filter((x) => x !== i))} />
                <span className="font-medium text-ink">{sc.name}</span>
                <span className="rounded bg-stone-200 px-1 text-stone-600">{sc.dim || sc.dimKey}</span>
                {!sc.dimKey && <span className="rounded bg-red-100 px-1 text-red-500">维度未识别，不落库</span>}
                <span className="text-stone-400">{oldStateWord(sc)} →</span>
                <input value={sc.state} onClick={(e) => e.stopPropagation()} onChange={(e) => setPendingState((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} className="w-24 rounded border border-stone-300 bg-paper px-1 py-0.5" aria-label="新状态词" />
                {sc.note && <span className="text-stone-500">{sc.note}</span>}
                {sc.since ? <span className="text-stone-400">@第{sc.since}章</span> : null}
              </label>
            ))}
            {!pendingState.length && <div className="text-xs text-stone-400">本章无状态变更</div>}
          </section>
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-500">资产流转（{pendingFlow.length}）</h4>
            {pendingFlow.map((fl, i) => (
              <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                <input type="checkbox" checked={selFlow.includes(i)} onChange={(e) => setSelFlow(e.target.checked ? [...selFlow, i] : selFlow.filter((x) => x !== i))} />
                <span className="font-medium text-ink">{fl.person}</span>
                <span className="rounded bg-stone-200 px-1 text-stone-600">{fl.changeRaw || fl.change}</span>
                {!fl.change && (
                  <span className="flex items-center gap-1 text-red-400">
                    动作未识别，请改
                    <select
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingFlow((p) => p.map((x, j) => (j === i ? { ...x, change: e.target.value } : x)))}
                      className="rounded border border-stone-300 bg-paper px-1 py-0.5 text-stone-700"
                      aria-label="流转动作"
                    >
                      <option value="">选择动作</option>
                      {[['gain', '获得'], ['lose', '失去'], ['broken', '损坏'], ['consumed', '消耗'], ['transferred', '易主']].map(([v, lab]) => (
                        <option key={v} value={v}>
                          {lab}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
                <span className="text-stone-700">{fl.asset}</span>
                {fl.asset && fl.change === 'gain' && !assetExists(fl.asset) && (
                  <span className="flex items-center gap-1 text-red-400">
                    未建档，落库建为
                    <select
                      value={fl.assetType ? typeKeyOf(fl.assetType) : 'item'}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingFlow((p) => p.map((x, j) => (j === i ? { ...x, assetType: e.target.value } : x)))}
                      className="rounded border border-stone-300 bg-paper px-1 py-0.5 text-stone-700"
                      aria-label="新资产类型"
                    >
                      {ASSET_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {ASSET_TYPE_LABEL[t] || t}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
                {fl.asset && (fl.change === 'broken' || fl.change === 'consumed' || fl.change === 'lose') && <span className="text-stone-400">（标注不删）</span>}
                {fl.ch ? <span className="text-stone-400">@第{fl.ch}章</span> : null}
              </label>
            ))}
            {!pendingFlow.length && <div className="text-xs text-stone-400">本章无资产流转</div>}
          </section>
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-500">伏笔推进（{pendingHook.length}）</h4>
            {pendingHook.map((hm, i) => (
              <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                <input type="checkbox" checked={selHook.includes(i)} onChange={(e) => setSelHook(e.target.checked ? [...selHook, i] : selHook.filter((x) => x !== i))} />
                <span className="font-medium text-ink">{hm.title}</span>
                <span className="rounded bg-stone-200 px-1 text-stone-600">{hm.moveRaw || hm.move}</span>
                <span className="text-stone-400">
                  {foreshadowStateOf(hm.title)} → {hm.move === 'mention' ? '(仅提及，不改状态)' : hm.move}
                </span>
                {hm.note && <span className="text-stone-500">{hm.note}</span>}
              </label>
            ))}
            {!pendingHook.length && <div className="text-xs text-stone-400">本章无伏笔推进</div>}
          </section>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <span className="mr-auto text-xs text-stone-400">默认全选，可逐条取消/改状态词；不点落库则库里一个字节都不变（系统不判断、不拦截）</span>
          <button onClick={onApply} disabled={!selState.length && !selFlow.length && !selHook.length} className={genBtn}>
            落库选中（{selState.length + selFlow.length + selHook.length}）
          </button>
          <button onClick={onClose} className={ghostBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
