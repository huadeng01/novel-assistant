// 角色声音一致性面板（P0+ · OOC）：为每个角色登记专属语言签名（口头禅 / 自称），
// 归档时确定性检测「台词串味」（A 说出 B 的专属口头禅）与「自称漂移」（A 自称 B 的专属称谓）——治 AI 写久角色声音崩掉。
// 数据落 characters[].voice = {catchphrases[], selfRef[], note}；门禁见 continuityGate → voiceGate。
// 另提供「声音蒸馏」：从现有正文挖每个角色的专属签名候选（对标 novel-distiller 灵魂蒸馏），勾选采纳。纯前端、零 AI 费用。
import { useMemo, useState } from 'react'
import { assembleVoices, scanAllVoiceConflicts, distillVoices, SELFREF_PRESETS } from '../lib/voice.js'
import Ic from './Ic.jsx'

const splitList = (s) => String(s || '').split(/[，,、]/).map((x) => x.trim()).filter(Boolean)

export default function VoicePanel({ project, saveProject }) {
  const chars = useMemo(() => (project?.characters || []).filter((c) => c && c.uid && c.name), [project])
  const voiced = useMemo(() => assembleVoices(project), [project])
  const scan = useMemo(() => scanAllVoiceConflicts(project), [project])
  const [openChar, setOpenChar] = useState(null)
  const [distilled, setDistilled] = useState(null)

  // 直接基于完整 project.characters 回写（不用过滤后的 chars，避免丢弃无 name 的半成品角色）
  const patchChar = (cuid, p) => saveProject({ ...project, characters: (project?.characters || []).map((c) => (c && c.uid === cuid ? { ...c, ...p } : c)) })
  const patchVoice = (c, p) => patchChar(c.uid, { voice: { ...(c.voice || {}), ...p } })

  const voiceOf = (c) => c.voice || {}
  const addCatch = (c, phrase) => {
    const v = voiceOf(c)
    const list = (v.catchphrases || []).filter((x) => x !== phrase)
    patchVoice(c, { catchphrases: [...list, phrase] })
  }
  const addSelfRef = (c, ref) => {
    const v = voiceOf(c)
    if ((v.selfRef || []).includes(ref)) return
    patchVoice(c, { selfRef: [...(v.selfRef || []), ref] })
  }
  const runDistill = () => setDistilled(distillVoices(project))
  const distillFor = (uid) => (distilled || []).find((d) => d.uid === uid)

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="chat" /> 角色声音一致性门 · 口头禅/自称（OOC）</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            为每个角色登记<b className="text-stone-500">专属语言签名</b>（口头禅 / 自称），归档时确定性检测
            <Ic n="alert" /> <b className="text-stone-500">台词串味</b>（A 说出 B 的专属口头禅）与
            <b className="text-stone-500">自称漂移</b>（A 自称 B 的专属称谓）——治 AI 写久「角色声音崩掉」的 OOC 漂移。
            共享词与通用代词（我/你/他）自动豁免；故意模仿语境自动降级。纯前端、零 AI 费用。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
          <Ic n="chart" /> {voiced.length} 位已登记 · {chars.length} 位角色
        </span>
      </div>

      {/* 全书声音穿帮总扫 */}
      {scan.blockers.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> 全书发现 {scan.blockers.length} 处角色声音穿帮（串味 / 自称漂移）</p>
          <ul className="mt-2 space-y-1">
            {scan.blockers.slice(0, 12).map((b, i) => (
              <li key={i} className="text-xs leading-relaxed text-red-700/90">第 {b.chapterNo} 章《{b.title}》· {b.what}</li>
            ))}
            {scan.blockers.length > 12 && <li className="text-xs text-red-600/70">…另有 {scan.blockers.length - 12} 处。</li>}
          </ul>
        </div>
      )}
      {scan.warnings.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800"><Ic n="bulb" /> {scan.warnings.length} 处疑似仿拟（已降级为提醒，请自行判断）</p>
          <ul className="mt-2 space-y-1">
            {scan.warnings.slice(0, 8).map((w, i) => (
              <li key={i} className="text-xs leading-relaxed text-amber-800/90">第 {w.chapterNo} 章《{w.title}》· {w.what}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 声音蒸馏：从现有正文挖专属签名候选 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={runDistill} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">
          <Ic n="wand" /> 从现有正文蒸馏签名候选
        </button>
        <span className="text-xs text-stone-400">统计每个角色台词里高频、且【只属于他】的短语，勾选即可登记为专属口头禅。</span>
      </div>

      {/* 逐角色声音签名编辑 */}
      <div className="mt-3 space-y-2">
        {chars.length === 0 && <p className="rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-400">尚无人物，请先在「设定与人物」中创建。</p>}
        {chars.map((c) => {
          const v = voiceOf(c)
          const open = openChar === c.uid
          const cp = v.catchphrases || []
          const sr = v.selfRef || []
          const dist = distillFor(c.uid)
          return (
            <div key={c.uid} className="rounded-xl border border-stone-200 bg-white p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button onClick={() => setOpenChar(open ? null : c.uid)} className="min-w-0 flex-1 text-left">
                  <span className="text-sm font-medium text-stone-600">{c.name}</span>
                  {cp.length > 0 && <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-500">口头禅 {cp.map((x) => `「${x}」`).join('')}</span>}
                  {sr.length > 0 && <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-normal text-violet-700">自称 {sr.join('/')}</span>}
                  {(!cp.length && !sr.length) && <span className="ml-2 text-xs font-normal text-stone-300">未登记声音签名</span>}
                </button>
                <span className="shrink-0 rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-500">{open ? '收起' : '编辑'}</span>
              </div>

              {/* 蒸馏候选（仅展开或已蒸馏时显示对应角色的采纳 chips） */}
              {dist && dist.candidates.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-2">
                  <span className="text-xs text-stone-400"><Ic n="sparkle" /> 候选：</span>
                  {dist.candidates.map((d) => {
                    const owned = cp.includes(d.phrase)
                    return (
                      <button
                        key={d.phrase}
                        onClick={() => addCatch(c, d.phrase)}
                        disabled={owned}
                        className={`rounded-full px-2.5 py-0.5 text-xs ${owned ? 'bg-stone-100 text-stone-400' : 'border border-violet-200 text-violet-600 hover:bg-violet-50'}`}
                        title={`在 ${d.count} 处台词中出现，且专属`}
                      >
                        {owned ? <Ic n="check" /> : '+ '}「{d.phrase}」<span className="text-stone-300">×{d.count}</span>
                      </button>
                    )
                  })}
                </div>
              )}

              {open && (
                <div className="mt-3 space-y-3 border-t border-stone-100 pt-3">
                  <div>
                    <label className="text-xs font-medium text-stone-500">专属口头禅 / 签名短语（逗号分隔，≥2 字；只登记【独一无二】属于他的）</label>
                    <input
                      value={cp.join('，')}
                      onChange={(e) => patchVoice(c, { catchphrases: splitList(e.target.value) })}
                      placeholder="如：有意思，且慢，容我拒绝"
                      className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-stone-500">专属自称（别人这么自称就是漂移；通用代词「我/你」无需登记）</label>
                    <input
                      value={sr.join('，')}
                      onChange={(e) => patchVoice(c, { selfRef: splitList(e.target.value) })}
                      placeholder="如：本王，贫道，老朽"
                      className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {SELFREF_PRESETS.map((r) => (
                        <button key={r} onClick={() => addSelfRef(c, r)} disabled={sr.includes(r)} className={`rounded-full px-2 py-0.5 text-xs ${sr.includes(r) ? 'bg-stone-100 text-stone-400' : 'border border-stone-200 text-stone-500 hover:bg-violet-50 hover:text-violet-600'}`}>{r}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-stone-500">声口备注（说话风格 / 语气 / 忌讳，供写作参考）</label>
                    <input
                      value={v.note || ''}
                      onChange={(e) => patchVoice(c, { note: e.target.value })}
                      placeholder="如：言简意赅、从不带脏字、爱用反问"
                      className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
