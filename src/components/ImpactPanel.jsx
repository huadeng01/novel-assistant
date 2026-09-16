// 影响分析面板（P0）：改设定 → 反查受影响章节 → 定向重写 / 重跑归档。纯前端、零 AI 费用。
// 对标 tianming「改设定 → 重跑校验 → 精确列出受影响章节号 → 一致性调和」：
//   · 选一个设定项（人物 / 世界规则 / 金手指规则 / 伏笔），列出所有引用它的章节 + 命中证据片段；
//   · 人物受控状态（死亡 / 濒死 / 失声 / 残肢）改动时，用现有硬门重跑受影响章节，标出「设定已改、正文仍是旧值」的矛盾；
//   · 每章可「定向重写」（复用 ChapterRewriter，修改指令自动生成）或「重跑该章归档」。
import { useMemo, useState } from 'react'
import { impactedChapters, impactEntities, detectSettingConflicts, scanAllConflicts, refsCoverage, buildAllChapterRefs } from '../lib/impact.js'
import ChapterRewriter from './ChapterRewriter.jsx'
import Ic from './Ic.jsx'

const injText = (c) => {
  const inj = c && c.mutableInjuries && typeof c.mutableInjuries === 'object' ? c.mutableInjuries : {}
  return Object.entries(inj)
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `${k}=${v}`)
    .join('；')
}

// 依据设定项当前值，生成「定点核对/修正」的重写指令（只让模型改矛盾处，其余保持原样）
function fixPromptFor(project, ent) {
  if (!ent) return ''
  if (ent.kind === 'character') {
    const c = (project.characters || []).find((x) => x && x.uid === ent.id)
    if (!c) return ''
    const lines = [`设定已更新，请核对并定点修正本章与「${c.name}」相关的描写，使其与最新设定一致；未涉及的部分（剧情、文笔、节奏）尽量保持原样：`]
    lines.push(`- 生死状态：${c.alive === 'dead' ? '已死亡' : c.alive === 'dying' ? '濒死' : '存活'}`)
    if (c.canSpeak === false) lines.push('- 不能说话（失声/哑）：本章不得让其开口说话')
    if (c.location) lines.push(`- 当前位置：${c.location}`)
    const inj = injText(c)
    if (inj) lines.push(`- 伤残：${inj}（已残废/缺失的肢体不得再做出正常动作）`)
    if (c.status) lines.push(`- 近况：${c.status}`)
    lines.push('若本章存在与上述设定矛盾之处（如已死亡却出场/说话、已残的肢体却正常行动、位置或状态不符），请只修正这些矛盾句子；若无矛盾则保持原样。')
    return lines.join('\n')
  }
  if (ent.kind === 'rule') {
    const b = (project.worldBlocks || []).find((x) => x && x.id === ent.id)
    const r = (project.bible?.powerRules || []).find((x) => x && (x.id || x.name) === ent.id)
    if (b) return `世界规则设定已更新，请核对本章涉及「${b.name}」的描写是否违背该规则，如违背请定点修正，其余保持原样：\n规则内容：${b.content || '(未填写正文)'}`
    if (r) return `金手指规则设定已更新，请核对本章涉及「${r.name || r.id}」的描写：触发该规则就必须写出对应后果，如违背请定点修正，其余保持原样。\n触发：${r.trigger || ''}\n后果：${r.consequence || ''}`
    return ''
  }
  if (ent.kind === 'foreshadow') {
    const f = (project.foreshadows || []).find((x) => x && x.id === ent.id)
    if (!f) return ''
    return `伏笔设定已更新，请核对本章与以下伏笔相关的描写是否与最新设定一致，如有出入请定点修正，其余保持原样：\n伏笔：${f.content}\n（埋设第 ${f.plantedChapter} 章${f.resolveChapter ? `，回收第 ${f.resolveChapter} 章` : '，尚未回收'}）`
  }
  return ''
}

export default function ImpactPanel({ project, saveProject, apiKey, busy: globalBusy, onRewriteDone, rerunChapter }) {
  const [selIdx, setSelIdx] = useState(-1)
  const [backfilling, setBackfilling] = useState(false)

  const entities = useMemo(() => impactEntities(project), [project])
  const cov = useMemo(() => refsCoverage(project), [project])
  const allConflicts = useMemo(() => scanAllConflicts(project), [project])

  const ent = selIdx >= 0 ? entities[selIdx] : null
  const change = ent ? { kind: ent.kind, id: ent.id } : null
  const impacted = useMemo(() => (change ? impactedChapters(project, change) : []), [project, change])
  const conflicts = useMemo(() => (change ? detectSettingConflicts(project, change) : []), [project, change])

  // 按 group 分组，供 <optgroup> 渲染
  const groups = useMemo(() => {
    const m = new Map()
    entities.forEach((e, i) => {
      if (!m.has(e.group)) m.set(e.group, [])
      m.get(e.group).push({ e, i })
    })
    return [...m.entries()]
  }, [entities])

  const backfill = async () => {
    setBackfilling(true)
    try {
      await saveProject(buildAllChapterRefs(project))
    } finally {
      setBackfilling(false)
    }
  }

  const busy = globalBusy || backfilling
  const fixPrompt = fixPromptFor(project, ent)

  return (
    <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold"><Ic n="target" /> 设定变更影响分析</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            改了人物状态 / 世界规则 / 伏笔后，反查所有引用它的章节并给出命中证据，可一键定向重写或重跑归档。纯前端计算、零 AI 费用，只提醒不阻断。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
          <Ic n="chart" /> 索引 {cov.indexed}/{cov.total} 章
        </span>
      </div>

      {/* 索引回填提示：旧书 / 导入章节尚无 refs，回填后反查更快更准（未回填也能实时匹配，只是慢） */}
      {cov.missing > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
          <p className="text-xs text-amber-800">
            <Ic n="alert" /> 有 {cov.missing} 章尚未建立影响索引（多为旧书或导入章节）。回填后可秒级反查；不回填也能用（实时匹配，稍慢）。
          </p>
          <button
            onClick={backfill}
            disabled={busy}
            className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {backfilling ? '回填中…' : <><Ic n="box" /> 回填全部章节索引</>}
          </button>
        </div>
      )}

      {/* 全书设定-正文冲突总扫：只扫带限制性状态（死亡/濒死/失声/残肢）的人物，命中即「设定已改、正文仍旧值」 */}
      {allConflicts.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> 全书发现 {allConflicts.length} 处设定-正文冲突（死者开口 / 残肢发力等）</p>
          <ul className="mt-2 space-y-1">
            {allConflicts.slice(0, 12).map((c, i) => (
              <li key={i} className="text-xs leading-relaxed text-red-700/90">
                第 {c.chapterNo} 章《{c.title}》· {c.name}：{c.blockers[0]?.what || '存在矛盾'}
              </li>
            ))}
            {allConflicts.length > 12 && <li className="text-xs text-red-600/70">…另有 {allConflicts.length - 12} 处，请在下方选择对应人物查看。</li>}
          </ul>
        </div>
      )}

      {/* 设定项选择器 */}
      <div className="mt-4">
        <label className="text-xs font-medium text-stone-500">选择要分析的设定项</label>
        <select
          value={selIdx}
          onChange={(e) => setSelIdx(Number(e.target.value))}
          className="mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
        >
          <option value={-1}>— 请选择（人物 / 世界规则 / 金手指规则 / 伏笔）—</option>
          {groups.map(([g, items]) => (
            <optgroup key={g} label={g}>
              {items.map(({ e, i }) => (
                <option key={`${e.kind}:${e.id}:${i}`} value={i}>
                  {e.label}{e.restrictive ? ' ⚠限制性状态' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {!entities.length && <p className="mt-2 text-xs text-stone-400">尚无可分析的设定项，请先在「设定与人物 / 世界观 / 伏笔账本」中创建。</p>}
      </div>

      {/* 选中设定项后：冲突（若为人物）+ 受影响章节清单 */}
      {ent && (
        <div className="mt-4 space-y-3">
          {conflicts.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-semibold text-red-700"><Ic n="alert" /> 「{ent.label}」当前设定与以下章节正文冲突（设定已改、正文仍停留在旧值）</p>
              <ul className="mt-2 space-y-1.5">
                {conflicts.map((c, i) => (
                  <li key={i} className="text-xs leading-relaxed text-red-700/90">
                    <span className="font-medium">第 {c.chapterNo} 章《{c.title}》</span>
                    {c.blockers.map((b, j) => <span key={j}>　· {b.what}</span>)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-stone-700">
              <Ic n="search" /> 受影响章节：<span className="text-stone-900">{impacted.length}</span> 章
            </p>
            {ent.restrictive && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">限制性状态 · 建议逐章核对</span>}
          </div>

          {impacted.length === 0 ? (
            <p className="rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-400">没有章节引用该设定项（或索引尚未覆盖，可先回填索引）。</p>
          ) : (
            impacted.map((ic) => (
              <div key={ic.chapterNo} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-stone-700">
                    第 {ic.chapterNo} 章《{ic.title}》
                    <span className="ml-2 text-xs font-normal text-stone-400">{ic.why}</span>
                    {!ic.indexed && <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-400">实时匹配</span>}
                  </p>
                </div>
                {ic.evidence?.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {ic.evidence.map((ev, i) => (
                      <li key={i} className="text-xs leading-relaxed text-stone-500">
                        <span className="text-stone-400">{ev.why}：</span>
                        <span className="novel-text rounded bg-stone-50 px-1.5 py-0.5 text-stone-600">{ev.snippet}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {fixPrompt && (
                    <ChapterRewriter
                      project={project}
                      saveProject={saveProject}
                      apiKey={apiKey}
                      chapterNo={ic.chapterNo}
                      fixPrompt={fixPrompt}
                      label={`定向重写第 ${ic.chapterNo} 章`}
                      disabled={busy || !apiKey}
                      onDone={onRewriteDone}
                    />
                  )}
                  <button
                    onClick={() => rerunChapter?.(ic.chapterNo)}
                    disabled={busy || !apiKey}
                    className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                  >
                    <Ic n="rerun" /> 重跑该章归档
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}
