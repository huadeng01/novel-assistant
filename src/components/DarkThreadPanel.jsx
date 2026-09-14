// #2 暗线追踪台账 + 遗忘预警门面板：登记埋在主线之下的暗线（阴谋/身世/约定/未解之谜），跨章追踪推进进度，
// 纯前端确定性预警：活跃暗线「N 章未推进」（遗忘预警）+「过了预定回收章仍未收束」（逾期预警）。
// 数据落 project.darkThreads；归档时正文提及暗线名/别名会自动回填 lastAdvancedChapter（见 applyReport → advanceThreads）。零 AI、只报警不阻断。
import { useMemo, useState } from 'react'
import { scanDarkThreads } from '../lib/darkthread.js'
import { uid } from '../lib/utils.js'
import Ic from './Ic.jsx'

const STATUSES = ['埋设中', '推进中', '已收束']
const splitList = (s) => String(s || '').split(/[，,、]/).map((x) => x.trim()).filter(Boolean)

export default function DarkThreadPanel({ project, saveProject }) {
  const threads = project?.darkThreads || []
  const [open, setOpen] = useState(null)
  const save = (next) => saveProject({ ...project, darkThreads: next })
  const scan = useMemo(() => scanDarkThreads(project), [project])

  const add = () => {
    const id = uid()
    save([...threads, { id, name: '', aliases: [], premise: '', plantedChapter: null, lastAdvancedChapter: null, status: '埋设中', targetResolveChapter: null, notes: '' }])
    setOpen(id)
  }
  const patch = (id, p) => save(threads.map((t) => (t.id === id ? { ...t, ...p } : t)))
  const remove = (id) => save(threads.filter((t) => t.id !== id))

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="thread" /> 暗线追踪台账 · 遗忘预警门</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            登记埋在主线之下的<b className="text-stone-500">暗线</b>（阴谋 / 身世 / 约定 / 未解之谜），跨章追踪推进进度。纯前端确定性预警：
            <Ic n="hourglass" /> 遗忘预警（活跃暗线 ≥ {scan.threshold} 章未推进）· <Ic n="alert" /> 逾期预警（过了预定回收章仍未收束）。归档时正文提及暗线名会自动回填推进章。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
          <Ic n="chart" /> {threads.length} 条暗线 · 当前第 {scan.current} 章
        </span>
      </div>

      {/* 逾期预警（红）*/}
      {scan.overdue.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> {scan.overdue.length} 条暗线逾期未回收</p>
          <ul className="mt-2 space-y-1">
            {scan.overdue.map((t, i) => (<li key={i} className="text-xs leading-relaxed text-red-700/90">{t.what} — {t.fix_hint}</li>))}
          </ul>
        </div>
      )}
      {/* 遗忘预警（黄）*/}
      {scan.stale.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800"><Ic n="hourglass" /> {scan.stale.length} 条暗线疑似被遗忘（读者可能已忘记）</p>
          <ul className="mt-2 space-y-1">
            {scan.stale.map((t, i) => (<li key={i} className="text-xs leading-relaxed text-amber-800/90">{t.what} — {t.fix_hint}</li>))}
          </ul>
        </div>
      )}
      {threads.length > 0 && scan.overdue.length === 0 && scan.stale.length === 0 && (
        <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700"><Ic n="ok" /> 所有活跃暗线推进节奏正常，无遗忘 / 逾期。</p>
      )}

      {/* 台账 CRUD */}
      <div className="mt-4 space-y-2">
        {threads.length === 0 && <p className="rounded-xl bg-stone-50 px-4 py-2.5 text-xs text-stone-400">尚无暗线。添加后登记「埋设章 / 上次推进章 / 预定回收章」，即可启用遗忘与逾期预警。</p>}
        {threads.map((t) => {
          const norm = scan.threads.find((x) => x.id === t.id) || {}
          const isOpen = open === t.id
          return (
            <div key={t.id} className="rounded-xl border border-stone-200 bg-white p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button onClick={() => setOpen(isOpen ? null : t.id)} className="text-sm font-medium text-stone-600">
                  {t.name || '（未命名暗线）'}
                  <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">{t.status || '推进中'}</span>
                  {norm.resolved ? (
                    <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-normal text-emerald-600">已收束</span>
                  ) : norm.staleGap >= scan.threshold ? (
                    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-700">{norm.staleGap} 章未推进</span>
                  ) : norm.lastAdvancedChapter != null ? (
                    <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">上次第 {norm.lastAdvancedChapter} 章</span>
                  ) : null}
                  <span className="ml-2 text-xs font-normal text-stone-400">{isOpen ? '收起' : '编辑'}</span>
                </button>
                <button onClick={() => remove(t.id)} className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"><Ic n="x" /></button>
              </div>
              {isOpen && (
                <div className="mt-3 space-y-2 border-t border-stone-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input value={t.name} onChange={(e) => patch(t.id, { name: e.target.value })} placeholder="暗线名（如：灭门案真凶）" className="w-44 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    <input value={(t.aliases || []).join('，')} onChange={(e) => patch(t.id, { aliases: splitList(e.target.value) })} placeholder="别名/代号（逗号分隔，正文命中即算推进）" className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    <select value={t.status || '推进中'} onChange={(e) => patch(t.id, { status: e.target.value })} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm">
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <input value={t.premise} onChange={(e) => patch(t.id, { premise: e.target.value })} placeholder="暗线内容（这条线埋的是什么、要走向何方）" className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs text-stone-500">埋设章
                      <input type="number" min="1" value={t.plantedChapter ?? ''} onChange={(e) => patch(t.id, { plantedChapter: e.target.value === '' ? null : Number(e.target.value) })} placeholder="章" className="mt-1 block w-20 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-stone-500">上次推进章
                      <input type="number" min="1" value={t.lastAdvancedChapter ?? ''} onChange={(e) => patch(t.id, { lastAdvancedChapter: e.target.value === '' ? null : Number(e.target.value) })} placeholder="归档自动回填" className="mt-1 block w-24 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-stone-500">预定回收章
                      <input type="number" min="1" value={t.targetResolveChapter ?? ''} onChange={(e) => patch(t.id, { targetResolveChapter: e.target.value === '' ? null : Number(e.target.value) })} placeholder="未定" className="mt-1 block w-24 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    </label>
                  </div>
                  <input value={t.notes} onChange={(e) => patch(t.id, { notes: e.target.value })} placeholder="备注（回收方式 / 关联角色 / 伏笔 id）" className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button onClick={add} className="mt-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加暗线</button>
    </section>
  )
}
