// 世界一致性面板（P1）：把地点/势力升为一等实体（可被 entity-match 命中），并录入人物登场/离场/外貌，
// 驱动三道纯前端客观门：时序门（提前登场）/ 缺席门（死者·离场者现身）/ 外貌一致性（发色瞳色前后矛盾）。
// 数据落 bible.places、bible.factions（补 aliases/firstAppearance）、characters（补 firstAppearance/departedAt/appearance）。
// 门禁在归档时自动跑（见 continuityGate → worldGateAll）；本面板另提供全书扫描预览。零 AI 费用、只报警不阻断。
import { useMemo, useState } from 'react'
import { worldGateAll } from '../lib/worldgate.js'
import { uid } from '../lib/utils.js'
import Ic from './Ic.jsx'

// 与 worldgate.js 外貌词典同源的颜色集（发色/瞳色可枚举值）
const COLORS = ['黑', '白', '银', '灰', '金', '红', '赤', '棕', '褐', '紫', '蓝', '青', '绿', '墨', '霜']
const TRAITS = ['发色', '瞳色']

export default function WorldGatePanel({ project, saveProject }) {
  const bible = project?.bible || {}
  const places = bible.places || []
  const factions = bible.factions || []
  const chars = useMemo(() => (project?.characters || []).filter((c) => c && c.uid && c.name), [project])
  const [openChar, setOpenChar] = useState(null)

  const saveBible = (patch) => saveProject({ ...project, bible: { ...bible, ...patch } })
  // 直接基于完整 project.characters 回写（不用过滤后的 chars，避免丢弃无 name 的半成品角色）
  const patchChar = (cuid, p) => saveProject({ ...project, characters: (project?.characters || []).map((c) => (c && c.uid === cuid ? { ...c, ...p } : c)) })

  // 全书一致性扫描：逐章跑三门，聚合 blockers（缺席）与 warnings（时序/外貌）
  const scan = useMemo(() => {
    const chapters = (project?.chapters || []).filter((c) => c && typeof c.content === 'string' && c.content.length)
    const blockers = []
    const warnings = []
    for (const ch of chapters) {
      const no = Number(ch.chapterNo) || 0
      const r = worldGateAll(project, no, ch.content)
      for (const b of r.blockers) blockers.push({ ...b, chapterNo: no, title: ch.title || '' })
      for (const w of r.warnings) warnings.push({ ...w, chapterNo: no, title: ch.title || '' })
    }
    return { blockers, warnings }
  }, [project])

  // 地点 CRUD
  const addPlace = () => saveBible({ places: [...places, { id: uid(), name: '', aliases: [], firstAppearance: null }] })
  const patchPlace = (id, p) => saveBible({ places: places.map((x) => (x.id === id ? { ...x, ...p } : x)) })
  const removePlace = (id) => saveBible({ places: places.filter((x) => x.id !== id) })
  // 势力补 P1 字段（别名 / 首次登场章）；势力主体仍在「世界观向导」维护，这里只补一致性门所需字段
  const patchFaction = (id, p) => saveBible({ factions: factions.map((x) => ((x.id || x.name) === id ? { ...x, ...p } : x)) })

  const appValue = (c, trait) => ((c.appearance || []).find((a) => a && a.trait === trait) || {}).value || ''
  const setApp = (c, trait, value) => {
    const list = (c.appearance || []).filter((a) => a && a.trait !== trait)
    if (value) list.push({ trait, value })
    patchChar(c.uid, { appearance: list })
  }

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="globe" /> 世界一致性门 · 地点/势力/外貌</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            把地点、势力升为<b className="text-stone-500">一等实体</b>（可被正文命中反查），并登记人物<b className="text-stone-500">首次登场章 / 离场章 / 外貌特征</b>，
            驱动三道纯前端客观门：<Ic n="hourglass" /> 时序门（提前登场）· <Ic n="ban" /> 缺席门（死者/离场者现身）· <Ic n="user" /> 外貌一致性（发色瞳色矛盾）。只报警不阻断。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
          <Ic n="chart" /> {places.length} 地点 · {factions.length} 势力
        </span>
      </div>

      {/* 全书扫描结果 */}
      {scan.blockers.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> 全书发现 {scan.blockers.length} 处缺席门穿帮（死者/离场者现身活动）</p>
          <ul className="mt-2 space-y-1">
            {scan.blockers.slice(0, 10).map((b, i) => (
              <li key={i} className="text-xs leading-relaxed text-red-700/90">第 {b.chapterNo} 章《{b.title}》· {b.what}</li>
            ))}
          </ul>
        </div>
      )}
      {scan.warnings.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800"><Ic n="alert" /> 全书 {scan.warnings.length} 处时序/外貌提醒（可能是合理铺垫，请自行判断）</p>
          <ul className="mt-2 space-y-1">
            {scan.warnings.slice(0, 10).map((w, i) => (
              <li key={i} className="text-xs leading-relaxed text-amber-800/90">
                第 {w.chapterNo} 章《{w.title}》· {w.kind}：
                {w.kind === '外貌一致性' ? `${w.name}的${w.trait}登记为「${w.canonical}」，正文出现「${w.found}」（${w.evidence}）` : `「${w.name}」登记第 ${w.firstAppearance} 章登场，却在第 ${w.chapterNo} 章提前出现（${w.evidence}）`}
              </li>
            ))}
            {scan.warnings.length > 10 && <li className="text-xs text-amber-700/70">…另有 {scan.warnings.length - 10} 处。</li>}
          </ul>
        </div>
      )}

      {/* ============ 一等实体：地点（CRUD）+ 势力（补别名/登场章）============ */}
      <div className="mt-4">
        <h3 className="text-sm font-bold text-stone-700"><Ic n="map" /> 地点（一等实体）</h3>
        <div className="mt-2 space-y-2">
          {places.length === 0 && <p className="rounded-xl bg-stone-50 px-4 py-2.5 text-xs text-stone-400">尚无地点。添加后，正文提及该地点即可被反查；登记首次登场章可启用时序门。</p>}
          {places.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white p-2.5">
              <input value={p.name} onChange={(e) => patchPlace(p.id, { name: e.target.value })} placeholder="地点名（如：洗髓阁）" className="w-36 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
              <input value={(p.aliases || []).join('，')} onChange={(e) => patchPlace(p.id, { aliases: e.target.value.split(/[，,]/).map((x) => x.trim()).filter(Boolean) })} placeholder="别名（逗号分隔）" className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
              <label className="flex items-center gap-1 text-xs text-stone-400">首登场
                <input type="number" min="1" value={p.firstAppearance ?? ''} onChange={(e) => patchPlace(p.id, { firstAppearance: e.target.value === '' ? null : Number(e.target.value) })} placeholder="章" className="w-16 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
              </label>
              <button onClick={() => removePlace(p.id)} className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"><Ic n="x" /></button>
            </div>
          ))}
        </div>
        <button onClick={addPlace} className="mt-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加地点</button>
      </div>

      {factions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-bold text-stone-700"><Ic n="shield" /> 势力（补一致性门字段）</h3>
          <p className="mt-1 text-xs text-stone-400">势力主体在「世界观向导」维护；这里只补别名与首次登场章，供时序门/实体反查使用。</p>
          <div className="mt-2 space-y-2">
            {factions.map((f) => {
              const fid = f.id || f.name
              return (
                <div key={fid} className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white p-2.5">
                  <span className="w-36 truncate text-sm font-medium text-stone-600">{f.name || '（未命名）'}</span>
                  <input value={(f.aliases || []).join('，')} onChange={(e) => patchFaction(fid, { aliases: e.target.value.split(/[，,]/).map((x) => x.trim()).filter(Boolean) })} placeholder="别名（逗号分隔）" className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                  <label className="flex items-center gap-1 text-xs text-stone-400">首登场
                    <input type="number" min="1" value={f.firstAppearance ?? ''} onChange={(e) => patchFaction(fid, { firstAppearance: e.target.value === '' ? null : Number(e.target.value) })} placeholder="章" className="w-16 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                  </label>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ============ 人物时序 / 外貌 ============ */}
      <div className="mt-4">
        <h3 className="text-sm font-bold text-stone-700"><Ic n="user" /> 人物登场 / 离场 / 外貌</h3>
        <div className="mt-2 space-y-2">
          {chars.length === 0 && <p className="rounded-xl bg-stone-50 px-4 py-2.5 text-xs text-stone-400">尚无人物。</p>}
          {chars.map((c) => {
            const open = openChar === c.uid
            return (
              <div key={c.uid} className="rounded-xl border border-stone-200 bg-white p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button onClick={() => setOpenChar(open ? null : c.uid)} className="text-sm font-medium text-stone-600">
                    {c.name}
                    {c.firstAppearance != null && <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">第{c.firstAppearance}章登场</span>}
                    {(c.departedAt != null || c.absentFrom != null) && <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">第{c.departedAt ?? c.absentFrom}章离场</span>}
                    {(c.appearance || []).length > 0 && <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">{(c.appearance || []).map((a) => `${a.trait}${a.value}`).join('·')}</span>}
                    <span className="ml-2 text-xs font-normal text-stone-400">{open ? '收起' : '编辑'}</span>
                  </button>
                </div>
                {open && (
                  <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-stone-100 pt-3">
                    <label className="text-xs text-stone-500">首次登场章
                      <input type="number" min="1" value={c.firstAppearance ?? ''} onChange={(e) => patchChar(c.uid, { firstAppearance: e.target.value === '' ? null : Number(e.target.value) })} placeholder="未定" className="mt-1 block w-24 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-stone-500">离场章（此后不得现身）
                      <input type="number" min="1" value={c.departedAt ?? ''} onChange={(e) => patchChar(c.uid, { departedAt: e.target.value === '' ? null : Number(e.target.value) })} placeholder="未离场" className="mt-1 block w-28 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                    </label>
                    {TRAITS.map((trait) => (
                      <label key={trait} className="text-xs text-stone-500">{trait}
                        <select value={appValue(c, trait)} onChange={(e) => setApp(c, trait, e.target.value)} className="mt-1 block w-24 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm">
                          <option value="">未登记</option>
                          {COLORS.map((col) => <option key={col} value={col}>{col}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
