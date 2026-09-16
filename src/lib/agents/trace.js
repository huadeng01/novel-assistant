// 运行轨迹解读（纯函数，供编剧团队面板可视化 + 单测）：把 makeProgress 收集的事件流翻译成「每个 agent 的状态灯」与「本次运行摘要」。
// 只读事件、不碰 React、不调 LLM——与 registry.js 的 AGENT_STATUS / PIPELINE 配合渲染。
//
// 事件来源（见 runtime.criticLoop + showrunnerAgent.criticChapter + 页面 autoContinue 的显式 push）：
//   { agent, phase:'start'|'done'|'error'|'aborted' }      —— runAgent / 页面显式标注某 agent 起止
//   { agent:'polisher', phase:'revise-start' }             —— 定点重写开始
//   { phase:'drafted' }                                    —— Writer 初稿产出（criticLoop）
//   { phase:'critiqued', round, pass, blockers, findings } —— Logic+Editor 合并裁决（criticLoop）
//   { phase:'revised', round }                             —— Polisher 定点重写完成（criticLoop）

// phase → 隐含 agent 的映射：criticLoop 的阶段事件不带 agent 字段，按流水线职责归位。
const PHASE_AGENT = {
  drafted: ['writer'],
  critiqued: ['logic', 'editor'],
  revised: ['polisher'],
}

// 由事件流推导每个 agent 的当前状态灯（idle/running/done/blocked/error）。
// 按时间顺序处理，后发事件覆盖先发——多章连写时反映「最近一章」的实时状态。
// 未出现在事件流里的 agent 不纳入结果（面板按 idle 渲染）。
export function deriveAgentStatus(trace = []) {
  const status = {}
  for (const e of Array.isArray(trace) ? trace : []) {
    if (!e) continue
    const ph = e.phase
    if (e.agent) {
      if (ph === 'start' || ph === 'revise-start') status[e.agent] = 'running'
      else if (ph === 'done') status[e.agent] = 'done'
      else if (ph === 'error') status[e.agent] = 'error'
      else if (ph === 'aborted') status[e.agent] = 'idle'
    }
    const implied = PHASE_AGENT[ph]
    if (implied) for (const id of implied) status[id] = 'done'
    // 裁决未过（仍有硬门 blocker）→ Logic/Editor 标为 blocked（朱砂警示），提示本章未干净通过
    if (ph === 'critiqued' && e.pass === false) {
      status.logic = 'blocked'
      status.editor = 'blocked'
    }
  }
  return status
}

// 本次运行摘要： drafts/critiques/revisions 计数 + 最近一次裁决是否通过 + 涉及章号。
export function summarizeTrace(trace = []) {
  const list = Array.isArray(trace) ? trace : []
  const critiques = list.filter((e) => e.phase === 'critiqued')
  const last = critiques[critiques.length - 1]
  const chapters = [...new Set(list.map((e) => e.chapterNo).filter((n) => Number.isFinite(Number(n)) && n != null).map(Number))].sort((a, b) => a - b)
  return {
    events: list.length,
    drafts: list.filter((e) => e.phase === 'drafted').length,
    critiques: critiques.length,
    revisions: list.filter((e) => e.phase === 'revised').length,
    errors: list.filter((e) => e.phase === 'error').length,
    lastPass: last ? last.pass !== false : null,
    lastBlockers: last ? (last.blockers || 0) : 0,
    chapters,
  }
}
