// Storyliner 故事线作家：写 5000-8000 字完整故事线（把整个故事讲完），分 5 段生成后拼合。
// 与结构化梗概(mainline)不同——storyline 是【叙事性】剧情通稿，存 project.storyline，供长篇写作层把握全局走向。
// 逐段 chatStream（散文 opt-in 防复读），前段全文喂后段保证连贯；每段完成即回调 onSegment 供 UI 增量展示与持久化。
import { chatStream, ANTI_REPETITION } from '../llm.js'
import { storylineMessages, STORYLINE_SEGMENTS } from '../prompts.js'

export const storylinerAgent = {
  id: 'storyliner',
  name: 'Storyliner',
  role: 'generate',
  // 分段生成完整故事线：返回 { storyline, segments:[{id,label,text}], wordCount }
  async run(ctx) {
    const { apiKey, brief, genre, bible, mainline = '', totalWords, volumeCount, signal, progress, onSegment } = ctx
    const segments = []
    let storyline = ''
    for (const seg of STORYLINE_SEGMENTS) {
      if (signal?.aborted) break
      progress?.push({ agent: 'storyliner', phase: 'segment', segment: seg.id, label: seg.label })
      const messages = storylineMessages({ segment: seg, brief, genre, bible, mainline, prevText: storyline, totalWords, volumeCount })
      // 温度 0.85：叙事散文既要连贯又不呆板；展开 ANTI_REPETITION 防长文尾部复读
      const text = await chatStream({ apiKey, messages, temperature: 0.85, signal, ...ANTI_REPETITION })
      const clean = String(text || '').trim()
      if (!clean) continue
      segments.push({ id: seg.id, label: seg.label, text: clean })
      storyline += (storyline ? '\n\n' : '') + clean
      onSegment?.({ id: seg.id, label: seg.label, text: clean, storyline, wordCount: storyline.length })
    }
    progress?.push({ agent: 'storyliner', phase: 'done', wordCount: storyline.length, segments: segments.length })
    return { storyline, segments, wordCount: storyline.length }
  },
}
