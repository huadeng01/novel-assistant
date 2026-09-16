// Writer 执笔写手（generate）：单章写作——逐场景扩写，只管写不自审（§4）。
// 内核直接复用 generateChapterBody 的「逐场景扩写段」：场景 ≥2 个时每场景一次请求（根治后段压缩），
// 无场景清单退回单次生成；每场景 max_tokens 与提示词字数预算同源（sceneWordBudget/tokenCapForWords）。
// 审校（Logic/Editor）与精修（Polisher）都不在这里——Writer 只负责把 draftArgs + 场景清单铺成正文。
// stream 可注入（默认真实 chatStream），便于单测用假流验证「逐场景拼接 + 预算递减 + onDelta 累计」而不打真实 API。
import { chatStream, ANTI_REPETITION } from '../llm.js'
import { longFormDraftMessages } from '../prompts.js'
import { singleTokenCap, sceneWordBudget, tokenCapForWords, trimTruncatedScene, dedupeScenePiece } from '../longform.js'
import { countWords } from '../utils.js'

export const writerAgent = {
  id: 'writer',
  name: 'Writer',
  role: 'generate',

  // 逐场景扩写：返回正文全文（不含标题剥离/审计/去重——那些是 Polisher/Logic 的活）。
  // ctx: { draftArgs, sceneText, chapterWords, driven, apiKey, onDelta, stream }
  async draft(ctx = {}) {
    const { draftArgs = {}, sceneText = '', chapterWords = 2000, driven = false, apiKey, onDelta, signal, stream = chatStream } = ctx
    const scenes = String(sceneText || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const singleCap = singleTokenCap(chapterWords)
    if (scenes.length >= 2) {
      let base = ''
      for (let i = 0; i < scenes.length; i++) {
        const budget = sceneWordBudget(chapterWords, scenes.length, i, countWords(base))
        const piece = await stream({
          apiKey,
          ...ANTI_REPETITION,
          messages: longFormDraftMessages({ ...draftArgs, scenePlan: scenes[i], upcoming: scenes.slice(i + 1).join('\n'), multiScene: true, withTitle: i === 0, lastScene: i === scenes.length - 1, tail: base ? base.slice(-(driven ? 800 : 2000)) : draftArgs.tail, chapterWords, sceneCount: scenes.length, sceneWords: budget }),
          temperature: 0.9,
          signal,
          maxTokens: tokenCapForWords(budget),
          onDelta: onDelta ? (t) => onDelta(base + t) : undefined,
        })
        const pieceM = trimTruncatedScene(piece, budget)
        base += (base ? '\n\n' : '') + dedupeScenePiece(base, pieceM.text)
      }
      return base
    }
    let full = await stream({ apiKey, ...ANTI_REPETITION, messages: longFormDraftMessages({ ...draftArgs, chapterWords, sceneCount: 1 }), temperature: 0.9, signal, maxTokens: singleCap, onDelta })
    const singleM = trimTruncatedScene(full, chapterWords)
    if (singleM.flagged) full = singleM.text
    return full
  },

  // 统一 agent 契约：run = 逐场景扩写产出初稿。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'writer', phase: 'start' })
    const text = await this.draft(ctx)
    ctx.progress?.push({ agent: 'writer', phase: 'done', words: countWords(text) })
    return { text }
  },
}
