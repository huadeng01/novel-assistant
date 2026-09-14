// 角色知识状态 / 秘密知情人列表面板（P0）：管理每条秘密的三层状态，扫出「非知情人泄露」穿帮。
// 对标 oh-story 三层「客观事实 / 角色已知 / 读者已见」、tianming「秘密状态·知情角色列表」——悬疑/推理题材命门。
// 纯前端、零 AI 费用：数据落 bible.secrets，门禁在归档时自动跑（见 continuityGate → knowerGate）。
import { useMemo, useState } from 'react'
import { assembleSecrets, dramaticIrony, scanAllKnowledgeConflicts } from '../lib/knowledge.js'
import { uid } from '../lib/utils.js'
import Ic from './Ic.jsx'

// 客观事实层：秘密在故事世界里到底属不属实（驱动戏剧反讽与「读者被误导」检查）
const OBJECTIVES = [
  { v: 'unknown', label: '未定' },
  { v: 'true', label: '客观属实' },
  { v: 'partial', label: '部分属实' },
  { v: 'false', label: '谣言/误信' },
]
const objLabel = (v) => (OBJECTIVES.find((o) => o.v === v) || OBJECTIVES[0]).label

export default function KnowledgePanel({ project, saveProject }) {
  // saveProject 由父级注入；本面板所有写操作都走 persist()（只改 bible.secrets，其余原样）
  const chars = useMemo(() => (project?.characters || []).filter((c) => c && c.uid && c.name), [project])
  const secrets = project?.bible?.secrets || []
  const assembled = useMemo(() => assembleSecrets(project), [project])
  const irony = useMemo(() => dramaticIrony(project), [project])
  const conflicts = useMemo(() => scanAllKnowledgeConflicts(project), [project])
  const [openId, setOpenId] = useState(null)

  // 所有写操作都走 save()：只改 bible.secrets，其余字段原样回写
  const save = (next) => {
    saveProject({ ...project, bible: { ...(project?.bible || {}), secrets: next } })
  }

  const addSecret = () => {
    const s = { id: uid(), statement: '', aliases: [], knowers: [], readerSeenChapter: null, objective: 'unknown', note: '' }
    save([...secrets, s])
    setOpenId(s.id)
  }
  const patch = (id, p) => save(secrets.map((s) => (s.id === id ? { ...s, ...p } : s)))
  const remove = (id) => {
    save(secrets.filter((s) => s.id !== id))
    if (openId === id) setOpenId(null)
  }
  const toggleKnower = (id, cuid) => {
    const s = secrets.find((x) => x.id === id)
    if (!s) return
    const kn = s.knowers || []
    patch(id, { knowers: kn.includes(cuid) ? kn.filter((u) => u !== cuid) : [...kn, cuid] })
  }

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="key" /> 角色知识状态 · 秘密知情人</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            为每条秘密维护三层状态——<b className="text-stone-500">客观事实</b>（是否属实）/ <b className="text-stone-500">角色已知</b>（谁掌握真相）/ <b className="text-stone-500">读者已见</b>（第几章揭示）。
            归档时自动拦截「非知情人在台词里说出秘密」的悬疑穿帮。纯前端、零 AI 费用。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
          <Ic n="chart" /> {assembled.length} 条秘密 · {chars.length} 位角色
        </span>
      </div>

      {/* 全书知情人穿帮总扫：非知情人泄露秘密 */}
      {conflicts.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> 全书发现 {conflicts.length} 处「非知情人泄露秘密」穿帮</p>
          <ul className="mt-2 space-y-1">
            {conflicts.slice(0, 12).map((c, i) => (
              <li key={i} className="text-xs leading-relaxed text-red-700/90">
                第 {c.chapterNo} 章《{c.title}》· {c.what}
              </li>
            ))}
            {conflicts.length > 12 && <li className="text-xs text-red-600/70">…另有 {conflicts.length - 12} 处。</li>}
          </ul>
        </div>
      )}

      {/* 戏剧反讽张力点：读者已见但仍有在世角色蒙在鼓里 */}
      {irony.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800"><Ic n="bulb" /> {irony.length} 处戏剧反讽张力点（读者已知、角色未知）</p>
          <ul className="mt-2 space-y-1">
            {irony.slice(0, 8).map((s, i) => (
              <li key={i} className="text-xs leading-relaxed text-amber-800/90">
                「{s.statement.slice(0, 24)}{(s.statement.length > 24 ? '…' : '')}」第 {s.readerSeenChapter} 章已揭示 ·
                知情：{s.knowers.join('、') || '（无）'} · <span className="text-amber-700">蒙在鼓里：{s.unaware.join('、')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 秘密清单 + 编辑器 */}
      <div className="mt-4 space-y-2">
        {assembled.length === 0 && (
          <p className="rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-400">
            还没有登记秘密。添加后，为每条秘密勾选「知情人」，系统即可在归档时拦截非知情人的提前泄露——这是悬疑/推理题材最关键的一致性防线。
          </p>
        )}
        {assembled.map((s) => {
          const open = openId === s.id
          return (
            <div key={s.id} className="rounded-xl border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button onClick={() => setOpenId(open ? null : s.id)} className="min-w-0 flex-1 text-left">
                  <span className="text-sm font-semibold text-stone-700">{s.statement || '（未填写秘密内容）'}</span>
                  <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-500">{objLabel(s.objective)}</span>
                  {s.readerSeen ? (
                    <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-normal text-sky-700">读者已见·第{s.readerSeenChapter}章</span>
                  ) : (
                    <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">读者未见</span>
                  )}
                  <span className="ml-1.5 text-xs font-normal text-stone-400">知情人 {s.knowers.length}</span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => setOpenId(open ? null : s.id)} className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-50">{open ? '收起' : '编辑'}</button>
                  <button onClick={() => remove(s.id)} className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"><Ic n="x" /></button>
                </div>
              </div>

              {open && (
                <div className="mt-3 space-y-3 border-t border-stone-100 pt-3">
                  <div>
                    <label className="text-xs font-medium text-stone-500">秘密内容（客观事实层）</label>
                    <textarea
                      value={s.statement}
                      onChange={(e) => patch(s.id, { statement: e.target.value })}
                      rows={2}
                      placeholder="一句话描述这个秘密的真相，如「林昭的生父是灭门案真凶」"
                      className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-stone-500">代号 / 别名（逗号分隔，门禁按此命中）</label>
                      <input
                        value={(s.aliases || []).join('，')}
                        onChange={(e) => patch(s.id, { aliases: e.target.value.split(/[，,]/).map((x) => x.trim()).filter(Boolean) })}
                        placeholder="如：灭门案，身世真相"
                        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-stone-500">客观事实：是否属实</label>
                      <select
                        value={s.objective || 'unknown'}
                        onChange={(e) => patch(s.id, { objective: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                      >
                        {OBJECTIVES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-stone-500">角色已知：谁掌握这个秘密（勾选知情人）</label>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {chars.length === 0 && <span className="text-xs text-stone-400">尚无人物，请先在「设定与人物」中创建。</span>}
                      {chars.map((c) => {
                        const on = (s.knowers || []).includes(c.uid)
                        return (
                          <button
                            key={c.uid}
                            onClick={() => toggleKnower(s.id, c.uid)}
                            className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-sky-600 text-white' : 'border border-stone-300 text-stone-500 hover:bg-stone-50'} ${c.alive === 'dead' ? 'opacity-50 line-through' : ''}`}
                          >
                            {on && <Ic n="check" /> } {c.name}{c.alive === 'dead' ? '（已死）' : ''}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-stone-500">读者已见章（归档自动回填，可手改）</label>
                      <input
                        type="number"
                        min="1"
                        value={s.readerSeenChapter ?? ''}
                        onChange={(e) => patch(s.id, { readerSeenChapter: e.target.value === '' ? null : Number(e.target.value) })}
                        placeholder="尚未揭示留空"
                        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-stone-500">备注</label>
                      <input
                        value={s.note || ''}
                        onChange={(e) => patch(s.id, { note: e.target.value })}
                        placeholder="揭示节奏 / 误导设计等（可选）"
                        className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        onClick={addSecret}
        className="mt-3 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
      >
        + 添加秘密
      </button>
    </section>
  )
}
