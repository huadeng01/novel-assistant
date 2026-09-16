// Stylist 文风蒸馏师：真·语言指纹（用词 / 口头禅 / 语气词 / 称呼），统一解析入口。
// 链路：sampleNovel(切样本) → styleAnalyzeMessages(定性画像 + habits + samples) → distillStyleBand(14 维量化，零 Token) → blendStyles(多份融合)。
// 含 A/B 文风改动（chat-4 已含）：六维语言指纹、无句式配额、不硬凑排比。
import { chatJSON } from '../llm.js'
import { styleAnalyzeMessages, sampleNovel, sanitizeHabits } from '../prompts.js'
import { distillStyleBand, blendStyles } from '../longform.js'

export const stylistAgent = {
  id: 'stylist',
  name: 'Stylist',
  role: 'generate',
  // 蒸馏单份样本文本 → 文风档案 rec（可存入 styles 库）
  async distillOne(ctx) {
    const { apiKey, text, bookId, signal, progress } = ctx
    progress?.push({ agent: 'stylist', phase: 'distill', bookId })
    const smp = sampleNovel(text)
    const res = await chatJSON({ apiKey, messages: styleAnalyzeMessages(smp), temperature: 0.3, signal })
    const band = distillStyleBand(smp.join('\n'))
    const { habits } = sanitizeHabits(res.habits || [])
    return {
      bookId,
      profile: String(res.style_profile || ''),
      habits,
      samples: (res.samples || []).filter(Boolean).slice(0, 3),
      metrics: band.metrics,
      thresholds: band.thresholds,
      bandReliable: band.reliable,
      origin: 'user',
      updatedAt: Date.now(),
    }
  },
  // 融合多份档案 → blended（单份原样返回，空返回 null）；纯函数，零 LLM
  blend(recs, opts) {
    return blendStyles(recs, opts)
  },
}
