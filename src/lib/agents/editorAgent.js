// Editor 综合主编（critic，只读）：细节把控的语义评审（§4）。
// 复用 ReviewPanel 同款 GLM 审核链路（chapterReviewMessages + glmChatJSON），但聚焦「刚写完的这一章」而非 5 章窗口，
// 把每 5 章才一次的人工审核前移成「每章落库前的语义门」。只判不改：产出 verdict，fixPrompt 交 Polisher 定点重写。
// 无 glmKey 时优雅跳过（pass:true, skipped:true）——Editor 是增强项，缺 Key 不应阻断写作（Logic 零 Token 硬门仍在）。
import { glmChatJSON } from '../llm.js'
import { chapterReviewMessages } from '../prompts.js'
import { outlinePositionFor, reviewTruths } from '../longform.js'

// 组装「单章」审核输入（与 buildReviewInput 同口径，但 chapters 只含当前草稿章，时间线/前文摘要按章号就近取）。
export function buildChapterReviewInput(project, chapterNo, text, title = '') {
  const proj = project || {}
  const no = Number(chapterNo) || 0
  const prev = [...(proj.chapters || [])].filter((c) => c && Number(c.chapterNo) < no).sort((a, b) => a.chapterNo - b.chapterNo)
  const timeline = (proj.events || [])
    .filter((e) => e.chapter >= no - 10 && e.chapter <= no)
    .slice(-120)
    .map((e) => `第${e.chapter}章：${e.text}`)
    .join('\n')
  return {
    world: proj.world,
    timeline,
    rollingSummary: proj.rollingSummary,
    characters: proj.characters,
    foreshadows: (proj.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
    beforeSummary: prev.slice(-8).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).join('\n'),
    chapters: [{ chapterNo: no, title, content: text }],
    positions: [{ chapterNo: no, position: outlinePositionFor(proj.outline, no) }],
    truths: reviewTruths(proj),
  }
}

// 合成「定向重写」修订指令（§7）：把作者逐章意见（userNotes，最高优先级）与 Logic 零 Token 硬门的 fixPrompt
// 拼成一份交给 chapterRewriteMessages 的修改指令。纯函数、可单测：作者意见在前（创作意图优先），硬门在后（客观必须修掉）。
// 两者皆空 → 返回 ''（调用方据此禁用重写按钮，绝不发空指令重写）。userNotes 元素可为字符串或 {text} 对象。
export function buildRevisionPrompt({ userNotes = [], logicFixPrompt = '' } = {}) {
  const notes = (Array.isArray(userNotes) ? userNotes : [])
    .map((n) => String(typeof n === 'string' ? n : (n && n.text) || '').trim())
    .filter(Boolean)
  const logic = String(logicFixPrompt || '').trim()
  const parts = []
  if (notes.length) {
    parts.push(`【作者对本章的修改意见（最高优先级，必须逐条落实；意见未提及的情节尽量保持原样）】\n${notes.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
  }
  if (logic) {
    parts.push(`【逻辑硬门检出、必须修掉的客观问题（连贯/剧透/文风红线）】\n${logic}`)
  }
  return parts.join('\n\n')
}

// GLM 原始裁决 { pass, analysis, suggestions:[{chapter_no, problem, fix_prompt}] } → 统一 verdict。
export function toVerdict(res = {}) {
  const suggestions = (Array.isArray(res.suggestions) ? res.suggestions : []).filter((s) => s && (s.fix_prompt || s.problem))
  const blockers = suggestions.map((s) => ({
    source: 'editor',
    category: '语义连贯',
    what: s.problem || '主编指出的连贯性问题',
    fix_hint: '',
    chapterNo: Number(s.chapter_no) || undefined,
  }))
  const findings = res.analysis ? [{ source: 'editor', severity: 'finding', category: '主编分析', what: String(res.analysis) }] : []
  const fixPrompt = suggestions.map((s) => String(s.fix_prompt || s.problem || '').trim()).filter(Boolean).join('\n')
  const pass = res.pass !== false && blockers.length === 0
  return { pass, blockers, findings, fixPrompt, analysis: res.analysis || '', suggestions }
}

export const editorAgent = {
  id: 'editor',
  name: 'Editor',
  role: 'critic',
  readonly: true,

  // 逐章意见 + 逻辑硬门 → 合成定向重写指令（§7）。纯函数，挂在 agent 上供编排层/UI 取用。
  buildRevisionPrompt,

  // 语义评审一章：返回 verdict。glmKey 缺失 → skipped（不阻断）。
  async review(ctx = {}) {
    const { glmKey, project, chapterNo, text = '', title = '', signal } = ctx
    if (!glmKey) return { pass: true, skipped: true, blockers: [], findings: [], fixPrompt: '' }
    const input = buildChapterReviewInput(project, chapterNo, text, title)
    const messages = chapterReviewMessages(input)
    let res
    try {
      res = await glmChatJSON({ apiKey: glmKey, messages, temperature: 0.2, signal })
    } catch (e) {
      // GLM 输出格式不稳时降温度重试一次（与 ReviewPanel 同策略）；仍失败则跳过（不阻断写作）
      if (/格式/.test(e?.message || '')) {
        try { res = await glmChatJSON({ apiKey: glmKey, messages, temperature: 0.1, signal }) }
        catch { return { pass: true, skipped: true, error: e?.message || 'GLM 审核失败', blockers: [], findings: [], fixPrompt: '' } }
      } else {
        return { pass: true, skipped: true, error: e?.message || 'GLM 审核失败', blockers: [], findings: [], fixPrompt: '' }
      }
    }
    return toVerdict(res)
  },

  // 统一 agent 契约：run = 语义裁决（编排层作为 critic 传入 criticLoop）。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'editor', phase: 'start' })
    const v = await this.review(ctx)
    ctx.progress?.push({ agent: 'editor', phase: v.skipped ? 'skipped' : 'done', pass: v.pass, blockers: v.blockers.length })
    return v
  },
}
