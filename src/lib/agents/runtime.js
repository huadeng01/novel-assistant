// agents 运行时地基：通用编排原语（零依赖纯逻辑，便于单测，不直接调 LLM）。
// 设计原则：生成者 / 批评者 / 编排者严格分离（借鉴 NovelClaw 多 agent 共识）——
//   writer 只写、critic 只判、orchestrator 只编排，互不越界，避免「自己写自己夸」。
// 具体 LLM 调用与确定性检测都放在各 agent 的 run 里，本文件只负责「怎么串起来」。
//
// 导出：
// - makeProgress：事件流收集器（借鉴 NovelClaw progress.log，供编剧团队面板可视化）
// - runAgent：执行单个 agent，统一包裹 start/done/error 事件与中止处理
// - runSequence：串行流水线，前一个产出灌入下一个，任一失败即短路
// - runParallel：并发执行（章后五路归档用），不因单个失败中断其余
// - mergeVerdicts：合并多个 critic 裁决（任一硬门不过即不过）
// - criticLoop：写-审-改循环（治「生成后缺少逻辑」的核心）

// 事件流收集器：每个 agent 运行、每个流水线阶段都 push 一条事件，面板按时间线渲染。
// 只负责记录，不负责渲染；snapshot 返回副本避免外部改动内部 log。
export function makeProgress() {
  const log = []
  return {
    log,
    push(evt = {}) {
      const e = { t: Date.now(), ...evt }
      log.push(e)
      return e
    },
    snapshot() {
      return log.slice()
    },
    clear() {
      log.length = 0
    },
  }
}

// 执行单个 agent：agent = { id, name, role, run(ctx) }。
// AbortError（用户点停止）向上抛，让编排层统一收口；其余错误转为 { ok:false } 不炸流程。
export async function runAgent(agent, ctx = {}) {
  const { progress } = ctx
  progress?.push({ agent: agent.id, phase: 'start', role: agent.role })
  try {
    const out = await agent.run(ctx)
    progress?.push({ agent: agent.id, phase: 'done', role: agent.role })
    return { ok: true, agent: agent.id, out }
  } catch (e) {
    if (e?.name === 'AbortError') {
      progress?.push({ agent: agent.id, phase: 'aborted', role: agent.role })
      throw e
    }
    progress?.push({ agent: agent.id, phase: 'error', role: agent.role, error: e?.message || String(e) })
    return { ok: false, agent: agent.id, error: e }
  }
}

// 串行流水线：按顺序执行，前一个的 out 作为下一个的 ctx.prev；任一失败即短路返回。
// ctx.seed 作为第一个 agent 的 prev（层层递进的起点，如故事线喂给结构规划）。
export async function runSequence(agents, ctx = {}) {
  const results = []
  let carry = ctx.seed
  for (const a of agents) {
    const r = await runAgent(a, { ...ctx, prev: carry })
    results.push(r)
    if (!r.ok) return { ok: false, results, failedAt: a.id, error: r.error }
    carry = r.out
  }
  return { ok: true, results, out: carry }
}

// 并发执行：全部跑完再汇总（章后五路归档用）；不因单个失败中断其余，ok 反映是否全成功。
export async function runParallel(agents, ctx = {}) {
  const results = await Promise.all(agents.map((a) => runAgent(a, ctx)))
  return { ok: results.every((r) => r.ok), results }
}

// 合并多个 critic 的裁决：任一 pass===false 或存在 blocker 即判不过；
// findings/blockers 汇总去重由调用方负责，这里只做扁平合并；fixPrompt 拼接为定点修订指令。
export function mergeVerdicts(verdicts = []) {
  const list = verdicts.filter(Boolean)
  const blockers = list.flatMap((v) => v.blockers || [])
  const findings = list.flatMap((v) => v.findings || [])
  const fixPrompt = list
    .map((v) => v.fixPrompt)
    .filter(Boolean)
    .join('\n')
    .trim()
  const pass = list.every((v) => v.pass !== false) && blockers.length === 0
  return { pass, blockers, findings, fixPrompt }
}

// 写-审-改循环：generate 产出初稿 → critics 逐个审 → merge 合并裁决 →
// 未过则带 verdict（含 fixPrompt）交 revise 定点重写 → 复审，最多 maxRounds 轮重写。
// maxRounds=0 表示只审不改（用于「事中不停、事后逐章意见」的纯检测）；默认 1，strict 档可传 2。
// 通过或耗尽轮数即返回 { draft, verdict, rounds, passed }，由编排层决定是否交 Archivist 落库。
export async function criticLoop({ generate, critics = [], revise, ctx = {}, maxRounds = 1, merge = mergeVerdicts }) {
  const { progress } = ctx
  let draft = await generate(ctx)
  progress?.push({ phase: 'drafted' })
  let verdict = { pass: true, blockers: [], findings: [], fixPrompt: '' }
  let round = 0
  for (;;) {
    const verdicts = []
    for (const c of critics) {
      verdicts.push(await c({ draft, ctx, round }))
    }
    verdict = merge(verdicts)
    progress?.push({
      phase: 'critiqued',
      round,
      pass: verdict.pass,
      blockers: verdict.blockers.length,
      findings: verdict.findings.length,
    })
    if (verdict.pass || round >= maxRounds || !revise) break
    draft = await revise({ draft, verdict, ctx, round })
    progress?.push({ phase: 'revised', round })
    round += 1
  }
  return { draft, verdict, rounds: round + 1, passed: verdict.pass }
}
