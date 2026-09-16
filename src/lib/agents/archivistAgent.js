// Archivist 归档师（generate）：章后归档——摘要 / 状态 / 伏笔 / 一致性 / 故事线 / 记忆回写（§4）。
// 直接复用 runPostChapter（五路并发 + 检查点逐步落盘，中断可续跑）；本 agent 是它在编剧团队里的「身份证」，
// 让归档成为层层递进流水线里一个可见、可标注、可编排的独立阶段，而非散落在页面里的匿名调用。
import { runPostChapter } from '../longform.js'

export const archivistAgent = {
  id: 'archivist',
  name: 'Archivist',
  role: 'generate',

  // 归档一章：返回 runPostChapter 的报告（summary/updates/newCharacters/events/newForeshadows/resolved/issues/drift/volumeMemory...）。
  async archive(ctx = {}) {
    const { apiKey, project, chapterNo, text, title = '', onStep, checkpointId = null, lanes = null, policy = 'fast', instruction = '', scenePlan = '' } = ctx
    return runPostChapter({ apiKey, project, chapterNo, text, title, onStep, checkpointId, lanes, policy, instruction, scenePlan })
  },

  // 统一 agent 契约：run = 章后归档。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'archivist', phase: 'start' })
    const rep = await this.archive(ctx)
    ctx.progress?.push({ agent: 'archivist', phase: 'done', issues: (rep && Array.isArray(rep.issues) ? rep.issues.length : 0) })
    return rep
  },
}
