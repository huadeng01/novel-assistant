// Worldsmith 世界架构师：完善故事世界 → 小说圣经（势力盘 / 冲突线 / 真相层）。
// 两段生成：① bibleRationalize（理性化圣经：规则/锚点/真相/地图层，带缺字段重试）② bookWorldview（势力盘/冲突线）。
// 「合并锁定项」(mergeBible) 属页面 state 逻辑（保留用户编辑），留在 WizardPage；本 agent 只产出两段原始解析结果。
import { chatJSON } from '../llm.js'
import { bibleRationalizeMessages, bookWorldviewMessages, bibleFromImportMessages } from '../prompts.js'
import { bibleJsonWithRetry, BIBLE_TRUTH_KINDS } from '../longform.js'

export const worldsmithAgent = {
  id: 'worldsmith',
  name: 'Worldsmith',
  role: 'generate',
  // 第一段：从 brief 理性化出圣经骨架（bibleJsonWithRetry 内部缺 power_rules/map_layers 时重试 1 次）
  async runRationalize(ctx) {
    const { apiKey, brief, progress } = ctx
    progress?.push({ agent: 'worldsmith', phase: 'rationalize' })
    return bibleJsonWithRetry({ apiKey, messages: bibleRationalizeMessages({ brief, truthKinds: BIBLE_TRUTH_KINDS }) })
  },
  // 第二段：基于已合并的圣经补全世界势力盘 / 冲突线（失败由调用方显式降级，不在此静默吞错）
  async runWorldview(ctx) {
    const { apiKey, brief, bible, volumeCount, worldviewTemplate = '', signal, progress } = ctx
    progress?.push({ agent: 'worldsmith', phase: 'worldview' })
    return chatJSON({
      apiKey,
      messages: bookWorldviewMessages({ template: worldviewTemplate, brief, bible, volumeCount, level: 'full' }),
      temperature: 0.7,
      signal,
    })
  },
  // 导入支线：从已有章节文本反推圣经（text 截断 60000 字防超长）
  async runFromImport(ctx) {
    const { apiKey, text, progress } = ctx
    progress?.push({ agent: 'worldsmith', phase: 'import' })
    return bibleJsonWithRetry({
      apiKey,
      messages: bibleFromImportMessages({ text: String(text || '').slice(0, 60000), truthKinds: BIBLE_TRUTH_KINDS }),
      temperature: 0.5,
    })
  },
}
