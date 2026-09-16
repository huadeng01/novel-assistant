// 编剧团队可视化面板（§8，subtab==='room'）：让每个 agent 的作用「直观可查」。
// 三块：① 层层递进流水线时间线（故事线→卷幕章→详纲→初稿→逻辑门→主编审→精修→归档）+ 实时事件流；
//       ② 13 个专职 agent 名册卡片（构思层/写作层两组，角色色 + 职责 + 只读标记 + 状态灯）；
//       ③ 每层产出可点开逐层查看（故事线/结构/详纲/初稿/审校/归档）。
// 视觉语言守「单一强调色」：generate=朱砂(amber)、critic=黛青(sky)、orchestrator=墨黑(stone)，与 index.css @theme 的 --color-agent-* 对应。
import { AGENTS, CONCEPT_AGENTS, WRITING_AGENTS, ROLE_THEME, AGENT_STATUS, PIPELINE } from '../lib/agents/index.js'
import { deriveAgentStatus, summarizeTrace } from '../lib/agents/index.js'
import { countWords } from '../lib/utils.js'
import { formatNovelParagraphs } from '../lib/longform.js'
import Ic from './Ic.jsx'

const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '')

function StatusDot({ statusKey }) {
  const st = AGENT_STATUS[statusKey] || AGENT_STATUS.idle
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-stone-400" title={st.label}>
      <span className={`h-2 w-2 rounded-full ${st.dot}`} />
      {st.label}
    </span>
  )
}

function RoleBadge({ role }) {
  const th = ROLE_THEME[role] || ROLE_THEME.generate
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${th.bg} ${th.text} border ${th.border}`}>
      {th.label}
    </span>
  )
}

function AgentCard({ agent, statusKey }) {
  const th = ROLE_THEME[agent.role] || ROLE_THEME.generate
  return (
    <article className={`rounded-xl border bg-white/60 p-3 ${th.border}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 rounded-lg p-1.5 ${th.bg} ${th.text}`}><Ic n={agent.icon} /></span>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-semibold">{agent.name} <span className="font-normal text-stone-400">{agent.cn}</span></h4>
            <div className="mt-0.5 flex items-center gap-1.5">
              <RoleBadge role={agent.role} />
              {agent.readonly && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">只读</span>}
            </div>
          </div>
        </div>
        <StatusDot statusKey={statusKey} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-stone-500">{agent.duty}</p>
    </article>
  )
}

function Output({ title, icon, meta, children }) {
  return (
    <details className="rounded-xl border border-stone-200 bg-white/50 p-3">
      <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs font-semibold text-stone-600">
        <span><Ic n={icon} /> {title}</span>
        {meta && <span className="font-normal text-stone-400">{meta}</span>}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

const Empty = ({ text }) => <p className="rounded-lg bg-stone-50 px-3 py-4 text-center text-xs text-stone-400">{text}</p>

export default function WritersRoomPanel({ project, trace = [], busy }) {
  const proj = project || {}
  const status = deriveAgentStatus(trace)
  const sum = summarizeTrace(trace)
  const chapters = proj.chapters || []
  const lastCh = chapters.length ? [...chapters].sort((a, b) => b.chapterNo - a.chapterNo)[0] : null
  const storylineWords = countWords(proj.storyline || '')
  const detailKeys = Object.keys(proj.outlineDetail || {})
  const volumes = proj.volumes || []

  // 流水线各阶段状态：构思层看产出是否存在，写作层看实时事件流（无事件但已有章节则视为已完成过）
  const stageStatus = {
    storyline: storylineWords > 0 ? 'done' : 'idle',
    structure: volumes.length ? 'done' : 'idle',
    outline: detailKeys.length ? 'done' : 'idle',
    draft: status.writer || (chapters.length ? 'done' : 'idle'),
    logic: status.logic || 'idle',
    edit: status.editor || 'idle',
    polish: status.polisher || 'idle',
    archive: status.archivist || (chapters.length ? 'done' : 'idle'),
  }
  const recentEvents = trace.slice(-40).reverse()

  return (
    <div className="space-y-4">
      {/* 头部 + 本次运行摘要 */}
      <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold"><Ic n="scene" /> 编剧团队</h2>
          <span className="text-xs text-stone-400">
            {busy ? '生成中，轨迹实时更新…' : sum.events
              ? `本次运行：${sum.drafts} 章初稿 · ${sum.critiques} 次审校 · ${sum.revisions} 次定点重写${sum.errors ? ` · ${sum.errors} 次出错` : ''}`
              : '尚未开始生成，下方为团队名册与既有产出'}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">
          13 个专职 agent 各管一块、层层递进：构思层把「一个念头」养成可写的完整故事世界，写作层把结构逐章写成成稿并归档。生成时这里实时显示每个 agent 的状态与事件流。
        </p>
      </section>

      {/* 层层递进流水线时间线 */}
      <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
        <h3 className="text-sm font-bold"><Ic n="thread" /> 流水线 · 上层喂下层</h3>
        <ol className="mt-3 flex flex-wrap items-center gap-y-3">
          {PIPELINE.map((st, i) => {
            const sk = stageStatus[st.id] || 'idle'
            const dot = (AGENT_STATUS[sk] || AGENT_STATUS.idle).dot
            const ag = AGENTS.find((a) => a.id === st.agent)
            return (
              <li key={st.id} className="flex items-center">
                {i > 0 && <span className="mx-1 h-px w-4 bg-stone-300 sm:mx-1.5 sm:w-6" aria-hidden="true" />}
                <span className="flex flex-col items-center gap-1" title={ag ? `${ag.name} ${ag.cn}` : st.label}>
                  <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
                  <span className="text-[11px] text-stone-500">{st.label}</span>
                </span>
              </li>
            )
          })}
        </ol>
        {/* 实时事件流 */}
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-stone-500"><Ic n="pulse" /> 实时事件流{recentEvents.length ? `（最近 ${recentEvents.length} 条）` : ''}</h4>
          {recentEvents.length === 0
            ? <Empty text="暂无运行事件。启动「自动连写」或单章生成后，这里会逐条记录 drafted → critiqued → revised → archived。" />
            : (
              <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto pr-1">
                {recentEvents.map((e, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg bg-white/60 px-2.5 py-1 text-[11px] text-stone-500">
                    <span className="shrink-0 tabular-nums text-stone-300">{fmtTime(e.t)}</span>
                    {e.agent && <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 font-medium text-stone-600">{e.agent}</span>}
                    <span className="shrink-0 text-stone-400">{e.phase}</span>
                    {e.chapterNo != null && <span className="shrink-0 text-stone-400">第{e.chapterNo}章</span>}
                    {e.phase === 'critiqued' && (
                      <span className={e.pass === false ? 'text-amber-600' : 'text-emerald-600'}>
                        {e.pass === false ? `未过·${e.blockers} 硬门` : '通过'}{e.findings ? `·${e.findings} 软提示` : ''}
                      </span>
                    )}
                    {e.error && <span className="truncate text-amber-700">{e.error}</span>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      </section>

      {/* Agent 名册：构思层 / 写作层 */}
      <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
        <h3 className="text-sm font-bold"><Ic n="user" /> 构思层 · 6 个 agent（新手写作为主，长篇可回炉）</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONCEPT_AGENTS.map((a) => <AgentCard key={a.id} agent={a} statusKey={status[a.id] || 'idle'} />)}
        </div>
        <h3 className="mt-5 text-sm font-bold"><Ic n="pen" /> 写作层 · 7 个 agent（长篇写作为主）</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WRITING_AGENTS.map((a) => <AgentCard key={a.id} agent={a} statusKey={status[a.id] || 'idle'} />)}
        </div>
      </section>

      {/* 每层产出可点开逐层查看 */}
      <section className="glass-card space-y-2 rounded-2xl bg-paper p-5 shadow-sm">
        <h3 className="text-sm font-bold"><Ic n="box" /> 各层产出（点开逐层查看）</h3>

        <Output title="故事线（Storyliner）" icon="thread" meta={storylineWords ? `${storylineWords} 字` : '未生成'}>
          {storylineWords
            ? <p className="novel-text max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">{proj.storyline}</p>
            : <Empty text="尚无故事线。在新手写作向导的「故事线」步由 Storyliner 分段生成 5000-8000 字完整故事线后存于此。" />}
        </Output>

        <Output title="卷 / 幕 / 章结构（Structurer）" icon="map" meta={volumes.length ? `${volumes.length} 卷` : '未建卷'}>
          {volumes.length === 0 ? <Empty text="尚无卷档案。Structurer 结合节奏引擎把故事线拆成卷/幕/章后存于此。" /> : (
            <ul className="space-y-2">
              {volumes.map((v) => (
                <li key={v.id || v.volumeNo} className="rounded-lg bg-stone-50 p-2.5">
                  <p className="text-xs font-semibold text-stone-600">第{v.volumeNo}卷《{v.name || ''}》 <span className="font-normal text-stone-400">第{v.startChapter}章起 · {v.length} 章{v.emotion ? ` · ${v.emotion}` : ''}</span></p>
                  {(v.acts || []).length > 0 && (
                    <ul className="mt-1.5 space-y-1 pl-1">
                      {v.acts.map((a, i) => (
                        <li key={i} className="text-[11px] leading-relaxed text-stone-500">
                          <span className="font-medium text-stone-600">{a.act || `第${i + 1}幕`}</span>（卷内第{a.start}-{a.end}章）{a.goal ? `：${a.goal}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Output>

        <Output title="逐章详纲（Outliner）" icon="notepad" meta={detailKeys.length ? `${detailKeys.length} 章已细化` : '未细化'}>
          {detailKeys.length === 0 ? <Empty text="尚无逐章详纲。Outliner 在写章前把幕内章级细化为 500-700 字详纲后存于此。" /> : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {detailKeys.sort((a, b) => Number(a) - Number(b)).slice(0, 30).map((k) => (
                <li key={k} className="rounded-lg bg-stone-50 p-2.5">
                  <p className="text-[11px] font-semibold text-stone-600">第{k}章</p>
                  <p className="novel-text mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{proj.outlineDetail[k]}</p>
                </li>
              ))}
            </ul>
          )}
        </Output>

        <Output title="最新章节初稿（Writer）" icon="pen" meta={lastCh ? `第${lastCh.chapterNo}章 · ${lastCh.wordCount || 0} 字` : '无章节'}>
          {lastCh
            ? <div className="novel-text max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">{formatNovelParagraphs(lastCh.content).text}</div>
            : <Empty text="尚无章节。Writer 逐场景扩写产出的初稿会存于此。" />}
        </Output>

        <Output title="审校意见（Logic 硬门 + Editor 主编）" icon="search" meta={lastCh ? `第${lastCh.chapterNo}章 · ${(lastCh.issues || []).length} 处存疑` : '无'}>
          {!lastCh ? <Empty text="尚无审校记录。" /> : (lastCh.issues || []).length === 0
            ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">本章暂无一致性存疑（Logic 零 Token 硬门 + Editor 语义审校均通过）。</p>
            : (
              <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed">
                {(lastCh.issues || []).map((it, i) => (
                  <li key={i} className={it.severity === 'soft' ? 'text-stone-500' : 'text-red-600'}>【{it.type}{it.severity === 'soft' ? '·软存疑' : ''}】{it.description}</li>
                ))}
              </ul>
            )}
        </Output>

        <Output title="归档摘要（Archivist）" icon="box" meta={lastCh?.summary ? `第${lastCh.chapterNo}章已归档` : '未归档'}>
          {!lastCh?.summary && !proj.rollingSummary ? <Empty text="尚无归档摘要。Archivist 在每章落库后回写摘要/状态/伏笔/一致性/故事线/记忆。" /> : (
            <div className="space-y-2">
              {lastCh?.summary && <p className="rounded-lg bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-600"><span className="font-semibold">第{lastCh.chapterNo}章摘要：</span>{lastCh.summary}</p>}
              {proj.rollingSummary && <p className="novel-text max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500"><span className="font-semibold">全书滚动摘要：</span>{proj.rollingSummary}</p>}
            </div>
          )}
        </Output>
      </section>
    </div>
  )
}
