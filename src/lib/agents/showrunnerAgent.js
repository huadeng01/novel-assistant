// Showrunner 总编剧（orchestrator）：整体把控流程——编排单章 critic 循环、状态回灌、断点续跑、意见调度（§4）。
// 阶段3 先落地「单章 critic 循环」（治「生成后缺少逻辑」核心，§5）：
//   Writer 初稿 → Logic(确定性硬门) + Editor(GLM 语义) 合并裁决 → 未过带 fixPrompt 交 Polisher 定点重写 → 复审，
//   最多 maxRounds 轮（默认1，strict档2）；提案待拍板则不进循环、直接交编排层暂停。
// 阶段4 再在此文件补 generateAct / generateVolume（幕级/卷级编排，突破 10 章上限）。
// 严格分离：Showrunner 只编排，不写文（Writer）、不判稿（Logic/Editor）、不改稿（Polisher）。
import { criticLoop } from './runtime.js'
import { logicAgent } from './logicAgent.js'
import { editorAgent } from './editorAgent.js'
import { polisherAgent } from './polisherAgent.js'
import { activeStyleRules, currentVolume } from '../longform.js'
import { actForChapter } from './pacerAgent.js'

// 取本章之前最近一章的摘要（当前章尚未落库，故 nextSummary 恒空）。
function prevSummaryOf(project, chapterNo) {
  const prev = [...((project && project.chapters) || [])]
    .filter((c) => c && Number(c.chapterNo) < Number(chapterNo))
    .sort((a, b) => Number(a.chapterNo) - Number(b.chapterNo))
    .pop()
  return (prev && prev.summary) || ''
}

// 生成粒度规划（§6 幕级/卷级编排的「大脑」，突破旧 Math.min(10) 十章硬上限）：
// 纯函数——按 scope（单章 / 一幕 / 一卷）算出本次自动连写的自然边界章号 stopAtChapter，编排层循环到该章为止。
// 未建卷档案 / 未分幕时优雅退回单章（fallback:true），绝不失控狂奔。
// generateAct / generateVolume 即「planGenScope('act'|'volume') + 页面 boundary-driven autoContinue」的组合：
// Showrunner 只负责「写到哪一章」的编排决策（纯、可单测），逐章执行仍复用页面里带 autoStopRef/断卷/提案/检查点的 autoContinue，避免两套循环发散。
export function planGenScope(project, { scope = 'act', fromChapter } = {}) {
  const proj = project || {}
  const from = Number(fromChapter) || ((proj.chapters || []).reduce((m, c) => Math.max(m, Number(c.chapterNo) || 0), 0) + 1)
  const single = (label, extra = {}) => ({ scope: 'chapter', stopAtChapter: from, fromChapter: from, label, ...extra })
  if (scope === 'chapter') return single(`第 ${from} 章`)
  const v = currentVolume(proj, from)
  if (scope === 'volume') {
    if (v && Number(v.length)) {
      const stopAt = Number(v.startChapter) + Number(v.length) - 1
      return { scope: 'volume', stopAtChapter: stopAt, fromChapter: from, volumeNo: v.volumeNo, label: `第${v.volumeNo}卷《${v.name || ''}》（第${v.startChapter}-${stopAt}章）` }
    }
    return single(`第 ${from} 章（未建卷档案，退回单章）`, { fallback: true })
  }
  // scope === 'act'：找到本章所属幕，边界 = 卷起点 + 幕内 end 坐标 - 1（acts[].start/end 为卷内坐标）
  const hit = actForChapter(proj, from)
  if (hit && hit.act && v && Number(v.length)) {
    const stopAt = Number(v.startChapter) + Number(hit.act.end) - 1
    const startG = Number(v.startChapter) + Number(hit.act.start) - 1
    const actIndex = (v.acts || []).indexOf(hit.act)
    return { scope: 'act', stopAtChapter: stopAt, fromChapter: from, volumeNo: v.volumeNo, actIndex, label: `${hit.act.act || '本幕'}（第${startG}-${stopAt}章）` }
  }
  return single(`第 ${from} 章（未分幕，退回单章）`, { fallback: true })
}

export const showrunnerAgent = {
  id: 'showrunner',
  name: 'Showrunner',
  role: 'orchestrator',

  // 单章 critic 循环。ctx:
  //   draft        Writer/generateChapterBody 的产出 { text, title, sceneText, proposals, proj }
  //   project      当前书对象（供 Logic/Editor/Polisher 取世界/人物/伏笔/真相/前文）
  //   chapterNo    本章章号
  //   apiKey/glmKey 写作引擎 Key / GLM 审核 Key（glmKey 缺失时 Editor 自动跳过）
  //   styleRec     本书文风档案 { profile, habits, forbidden, samples, thresholds }
  //   maxRounds    最多重写轮数（默认1；qualityPolicy==='strict' 时 2）
  //   signal       AbortSignal（用户停止）；progress 事件流；splitTitle 标题切分（注入页面健壮版）
  // 返回 { draft, verdict, rounds, passed, paused? }——draft 为（可能已重写的）最终稿，交 Archivist 落库。
  async criticChapter(ctx = {}) {
    const {
      draft, project, chapterNo, apiKey, glmKey, styleRec = {}, signal, progress,
      splitTitle, onRewriteDelta, maxRounds, qualityPolicy,
    } = ctx
    const noop = { pass: true, blockers: [], findings: [], fixPrompt: '' }
    // 提案待拍板：遇到需要用户决策的剧情分支，不进 critic 循环（初稿原样保留，交编排层暂停等人）
    if (Array.isArray(draft && draft.proposals) && draft.proposals.length) {
      return { draft, verdict: noop, rounds: 0, passed: true, paused: 'proposals' }
    }
    const rounds = Number.isFinite(maxRounds) ? maxRounds : (qualityPolicy === 'strict' ? 2 : 1)
    const rules = activeStyleRules(project)
    const prevSummary = prevSummaryOf(project, chapterNo)
    const logicCtx = { project, chapterNo, samples: styleRec.samples || [], forbidden: styleRec.forbidden || [], thresholds: styleRec.thresholds }

    const result = await criticLoop({
      generate: async () => draft,
      critics: [
        async ({ draft: d }) => logicAgent.gate({ ...logicCtx, text: d.text }),
        async ({ draft: d }) => editorAgent.review({ glmKey, project, chapterNo, text: d.text, title: d.title, signal }),
      ],
      revise: async ({ draft: d, verdict }) => {
        progress?.push({ agent: 'polisher', phase: 'revise-start', round: verdict && verdict.round })
        const rw = await polisherAgent.rewrite({
          apiKey, chapterNo, title: d.title, content: d.text, fixPrompt: verdict.fixPrompt,
          world: (project && project.world) || '', prevSummary, nextSummary: '',
          forbidden: styleRec.forbidden || [], style: styleRec.profile || '', habits: styleRec.habits || [],
          rules, samples: styleRec.samples || [], characters: (project && project.characters) || [],
          signal, onDelta: onRewriteDelta, splitTitle,
        })
        return { ...d, text: rw.text, title: rw.title || d.title, revised: true }
      },
      ctx: { progress },
      maxRounds: rounds,
    })
    return { draft: result.draft, verdict: result.verdict, rounds: result.rounds, passed: result.passed }
  },

  // 统一 agent 契约：run = 单章 critic 循环（编排层可直接 runAgent(showrunnerAgent, ctx)）。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'showrunner', phase: 'start' })
    const out = await this.criticChapter(ctx)
    ctx.progress?.push({ agent: 'showrunner', phase: 'done', passed: out.passed, rounds: out.rounds })
    return out
  },
}
