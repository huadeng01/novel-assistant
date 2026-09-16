// Pacer 节奏把控师（critic）：补 chat-4 关键缺口——volumes[].acts[]={act,start,end,goal} 已落库，
// 但 acts[].goal 写作时从未注入 prompt（§3 缺口）。Pacer 在 Writer 落笔前把「本幕目标 + 幕区间 + 起承转合定位」
// 显式喂进 longFormDraftMessages 的 actGoal 段，并在事后做轻量节奏巡检（只报 finding，绝不阻断，避免误杀）。
// 全部为纯函数：不调 LLM、不碰页面 state，便于单测（§15）。
import { currentVolume, outlinePositionFor, volumeRole, ACT_RATIO_GUIDE } from '../longform.js'

// 找到本章所属的幕：acts[].start/end 为「卷内坐标」（1..length），须把全局章号换算成卷内位置再匹配。
// 无卷档案 / 无幕 / 落不进任何幕区间时返回 null（Pacer 优雅退化，不注入）。
export function actForChapter(project, chapterNo) {
  const v = currentVolume(project, chapterNo)
  if (!v || !Array.isArray(v.acts) || !v.acts.length) return null
  const local = Number(chapterNo) - Number(v.startChapter || 1) + 1
  const act = v.acts.find((a) => a && Number.isFinite(Number(a.start)) && Number.isFinite(Number(a.end)) && local >= Number(a.start) && local <= Number(a.end))
  return act ? { volume: v, act, local } : { volume: v, act: null, local }
}

export const pacerAgent = {
  id: 'pacer',
  name: 'Pacer',
  role: 'critic',

  // 主职：产出「本幕目标」注入片段（喂给 longFormDraftMessages 的 actGoal 参数）。
  // 返回 { actGoal, actLabel, position, volumeEmotion, arcGuide }——actGoal 为空串时调用方不注入，输出与改造前逐字节一致（§14 可控开关）。
  actContext(ctx = {}) {
    const { project, chapterNo } = ctx
    const empty = { actGoal: '', actLabel: '', position: '', volumeEmotion: '', arcGuide: '' }
    if (!project || !Number.isFinite(Number(chapterNo))) return empty
    const hit = actForChapter(project, chapterNo)
    const position = outlinePositionFor(project.outline, chapterNo) || ''
    if (!hit) return { ...empty, position }
    const { volume: v, act } = hit
    const volumeEmotion = v.emotion || ''
    const arcGuide = ACT_RATIO_GUIDE[volumeRole(v.volumeNo, (project.volumes || []).map((x) => x.weight || x.length || 1))] || ''
    if (!act) return { ...empty, position, volumeEmotion, arcGuide }
    const actLabel = `${act.act || '本幕'}（卷内第${act.start}-${act.end}章）`
    const goal = String(act.goal || '').trim()
    // 只注入「幕区间 + 幕级目标」——卷情感走向(v.emotion)与起承转合结构(v.arc)已由 volumeStrategyText 注入，此处不重复，避免稀释注意力；块标题由 longFormDraftMessages 统一加。
    const actGoal = goal ? `${actLabel}：${goal}` : ''
    return { actGoal, actLabel, position, volumeEmotion, arcGuide }
  },

  // 巡检：轻量、确定性、只产 finding（pass 恒 true，绝不进 mergeVerdicts 的阻断项）。
  // 供编剧团队面板展示「本章在幕/卷中的定位」，并对明显偏短给出软提示；不做语义判断（那是 Editor 的活）。
  checkDrift(ctx = {}) {
    const { project, chapterNo, text = '', chapterWords = 0 } = ctx
    const findings = []
    const info = this.actContext({ project, chapterNo })
    if (info.actLabel) findings.push({ severity: 'finding', category: '节奏定位', what: `本章属${info.actLabel}${info.position ? `·结构定位「${info.position}」` : ''}` })
    const words = String(text).replace(/\s/g, '').length
    if (chapterWords > 0 && words && words < chapterWords * 0.6) {
      findings.push({ severity: 'finding', category: '篇幅偏短', what: `本章约 ${words} 字，低于目标 ${chapterWords} 字的六成，节奏可能被压缩`, fix_hint: '补足本幕目标要求的过程与细节' })
    }
    return { pass: true, blockers: [], findings, fixPrompt: '', actLabel: info.actLabel, position: info.position }
  },

  // 统一 agent 契约：run = 产出注入片段（编排层在 Writer 前调用）。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'pacer', phase: 'start' })
    const out = this.actContext(ctx)
    ctx.progress?.push({ agent: 'pacer', phase: 'done', injected: !!out.actGoal })
    return out
  },
}
