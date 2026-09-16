// Logic 逻辑审校（critic，只读）：细节把控的确定性硬门，零 Token（§4）。
// 合并三路纯函数检测器为一个 verdict：
//   ① continuityGate —— 数字台账/生死连续/收束点/事实漂移/角色知识/世界一致性/声音串味（客观错误，硬阻断）
//   ② outlineLeakScan —— 提前剧透终极真相/越界写后续章节节点（硬阻断）+ 越界提示（软 finding）
//   ③ codeLayerAudit —— 文风红线（禁用词/原文照抄泄漏）硬阻断 + AI味/破折号/对话动词/run-on（软 finding）
// 只判不改（readonly）：产出 { pass, blockers, findings, fixPrompt }，fixPrompt 交 Polisher 定点重写。
import { continuityGate, outlineLeakScan, outlineLeakContextFor, codeLayerAudit, reviewTruths } from '../longform.js'

// 把 blockers 渲染成定点修订指令（编号 + 类别 + 问题 + 修法），供 chapterRewriteMessages 的 fixPrompt 使用。
export function buildFixPrompt(blockers = []) {
  return (Array.isArray(blockers) ? blockers : [])
    .map((b, i) => `${i + 1}. [${b.category || '客观错误'}] ${b.what || ''}${b.fix_hint ? `（修法：${b.fix_hint}）` : ''}`.trim())
    .filter((s) => s.length > 3)
    .join('\n')
}

// 越界项字段在不同命中路径下名字不一（kind/what/evidence/needle），统一兜底取值，避免 undefined 污染指令。
const leakWhat = (b) => b.what || b.evidence || b.needle || b.detail || b.kind || '触及后续剧情/终极真相'

export const logicAgent = {
  id: 'logic',
  name: 'Logic',
  role: 'critic',
  readonly: true,

  // 硬门裁决：blockers 非空即 pass=false（触发定点重写）；findings 只报警不阻断。
  gate(ctx = {}) {
    const { project, chapterNo, text = '', samples = [], forbidden = [], thresholds, lockedTruths, outlineCtx } = ctx
    const blockers = []
    const findings = []
    const truths = Array.isArray(lockedTruths) ? lockedTruths : reviewTruths(project || {}).map((t) => t.truth)

    // ① 连贯性硬门（内部已含 codeLayerAudit 的事实/台账/知识/世界/声音子门）
    const cont = continuityGate(project, chapterNo, text)
    for (const b of cont.blockers || []) blockers.push({ source: 'continuity', category: b.category || '客观错误', what: b.what || '', fix_hint: b.fix_hint || '' })
    for (const f of cont.findings || []) findings.push({ source: 'continuity', severity: 'finding', category: f.category || '一致性提示', what: f.what || f.description || '' })

    // ② 剧透/越界硬门
    const lctx = outlineCtx || outlineLeakContextFor(project, chapterNo)
    const leak = outlineLeakScan(text, lctx)
    for (const b of leak.blocked || []) blockers.push({ source: 'leak', category: `越界·${b.kind || '剧透'}`, what: leakWhat(b), fix_hint: '删除或弱化为只留蛛丝马迹，本章不得提前揭示/提前写到后续节点' })
    for (const w of leak.warnings || []) findings.push({ source: 'leak', severity: 'finding', category: `越界提示·${w.kind || ''}`, what: leakWhat(w) })

    // ③ 文风红线（禁用词/原文照抄）硬阻断；AI味/破折号/对话动词/run-on 作软 finding（交由 Polisher 或事后处理）
    const audit = codeLayerAudit(text, samples, { forbidden, lockedTruths: truths, thresholds })
    for (const b of audit.blockers || []) blockers.push({ source: 'style', category: b.category || '文风红线', what: b.what || '', fix_hint: b.fix_hint || '' })
    for (const f of audit.findings || []) findings.push({ source: 'style', severity: 'finding', category: f.category || '文风提示', what: f.what || f.description || '' })
    if (audit.flavorCount >= 3) findings.push({ source: 'style', severity: 'finding', category: 'AI味', what: `命中 AI 味表达 ${audit.flavorCount} 处`, fix_hint: '去 AI 味改写' })
    if (audit.dashOver) findings.push({ source: 'style', severity: 'finding', category: '破折号', what: `破折号超限（${audit.dashes} 处）`, fix_hint: '改用逗号/句号或动作神态归因' })
    if (audit.dialogueVerb && audit.dialogueVerb.over) findings.push({ source: 'style', severity: 'finding', category: '对话动词', what: `「说」式对话动词超限（${audit.dialogueVerb.shuoCount} 处）`, fix_hint: '改用「道」体系或动作/神态归因' })
    if (audit.runOn && audit.runOn.count) findings.push({ source: 'style', severity: 'finding', category: 'run-on', what: `残留无标点长句 ${audit.runOn.count} 处`, fix_hint: '在从句边界补断' })
    if ((audit.leaks || []).length) findings.push({ source: 'style', severity: 'finding', category: '原文泄漏', what: `疑似原文照抄 ${audit.leaks.length} 处` })
    if ((audit.truthLeak || []).length) findings.push({ source: 'style', severity: 'finding', category: '真相剧透', what: `疑似提前剧透终极真相 ${audit.truthLeak.length} 处` })

    const fixPrompt = buildFixPrompt(blockers)
    return { pass: blockers.length === 0, blockers, findings, fixPrompt }
  },

  // 统一 agent 契约：run = 只读裁决（编排层作为 critic 传入 criticLoop）。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'logic', phase: 'start' })
    const v = this.gate(ctx)
    ctx.progress?.push({ agent: 'logic', phase: 'done', pass: v.pass, blockers: v.blockers.length, findings: v.findings.length })
    return v
  },
}
