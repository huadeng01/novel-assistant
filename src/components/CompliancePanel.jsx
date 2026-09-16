// #3 平台合规叠加扫描面板：选目标平台（番茄/起点/知乎盐选），按该平台市场规则 + 全平台内容红线，
// 对全书逐章做纯前端确定性叠加扫描（字数 / 章末钩子 / 黄金三章 / 悬念密度 / 敏感题材），只报警不阻断。
// 选定平台后，归档也会叠加扫描（见 continuityGate → complianceScan）。数据落 project.compliancePlatform。零 AI。
import { useMemo } from 'react'
import { PLATFORMS, scanBookCompliance } from '../lib/compliance.js'
import Ic from './Ic.jsx'

export default function CompliancePanel({ project, saveProject }) {
  const platform = project?.compliancePlatform || ''
  const scan = useMemo(() => scanBookCompliance(project, platform), [project, platform])
  const setPlatform = (id) => saveProject({ ...project, compliancePlatform: id })
  const warns = scan.chapters.filter((c) => c.severity === 'warn')
  const finds = scan.chapters.filter((c) => c.severity !== 'warn')
  const p = scan.platform

  return (
    <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
      <div className="min-w-0">
        <h2 className="text-base font-bold"><Ic n="shield" /> 平台合规叠加扫描</h2>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">
          选目标平台，按其<b className="text-stone-500">市场规则</b>（字数 / 章末钩子 / 黄金三章 / 悬念密度）+ <b className="text-stone-500">全平台内容红线</b>（涉赌毒 / 血腥 / 封建迷信 / 露骨）逐章确定性扫描。只报警不阻断，尊重作者拍板。
        </p>
      </div>

      {/* 平台选择 */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => setPlatform('')} className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${!platform ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-500 hover:bg-stone-50'}`}>不扫描</button>
        {PLATFORMS.map((pl) => (
          <button key={pl.id} onClick={() => setPlatform(pl.id)} className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${platform === pl.id ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-500 hover:bg-stone-50'}`}>
            {pl.name} · {pl.model}
          </button>
        ))}
      </div>

      {!p && <p className="mt-3 rounded-xl bg-stone-50 px-4 py-2.5 text-xs text-stone-400">未选择平台。选定后，本书归档与全书扫描都会叠加该平台的市场规则与内容红线检查。</p>}

      {p && (
        <>
          <p className="mt-3 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-xs leading-relaxed text-stone-500">
            <b className="text-stone-600">{p.name}（{p.model}）规则：</b>{p.notes} 建议字数 {p.words[0]}~{p.words[1]} 字/章{p.goldenThree ? ' · 黄金三章开篇钩子' : ''} · 悬念密度 ≥ {p.suspenseMin}。
          </p>
          {/* 内容红线（warn，红）*/}
          {warns.length > 0 && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs font-semibold text-red-700"><Ic n="ban" /> {warns.length} 处内容红线（可能触发平台审核）</p>
              <ul className="mt-2 space-y-1">
                {warns.slice(0, 20).map((w, i) => (<li key={i} className="text-xs leading-relaxed text-red-700/90">第 {w.chapterNo} 章《{w.title}》· [{w.category}] {w.what} — {w.fix_hint}</li>))}
                {warns.length > 20 && <li className="text-xs text-red-700/70">…另有 {warns.length - 20} 处。</li>}
              </ul>
            </div>
          )}
          {/* 市场规则（finding，黄）*/}
          {finds.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-semibold text-amber-800"><Ic n="target" /> {finds.length} 处市场规则建议</p>
              <ul className="mt-2 space-y-1">
                {finds.slice(0, 30).map((f, i) => (<li key={i} className="text-xs leading-relaxed text-amber-800/90">第 {f.chapterNo} 章《{f.title}》· {f.what}</li>))}
                {finds.length > 30 && <li className="text-xs text-amber-700/70">…另有 {finds.length - 30} 处。</li>}
              </ul>
            </div>
          )}
          {warns.length === 0 && finds.length === 0 && (
            <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700"><Ic n="ok" /> 全书符合 {p.name} 的市场规则，未命中内容红线。</p>
          )}
        </>
      )}
    </section>
  )
}
