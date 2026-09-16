// Muse 灵感选题师：立意 / 题材 / 爽点 / 核心冲突的脑洞生成（复用 inspirationMessages）。
// 走当前写作引擎的 chatJSON（高温发散）；只负责「生成一批灵感 + 按用户想法扩充 brief」，不碰页面 state。
import { chatJSON } from '../llm.js'
import { inspirationMessages, inspirationExpandMessages } from '../prompts.js'

export const museAgent = {
  id: 'muse',
  name: 'Muse',
  role: 'generate',
  // 生成一批灵感选题：返回 { ideas: [{title, brief}] }
  async run(ctx) {
    const { apiKey, genre, worldview, tropes, mode = 'free', stance = null, seed = '', signal, progress } = ctx
    progress?.push({ agent: 'muse', phase: 'start' })
    const messages = inspirationMessages(genre, worldview, tropes, { mode, stance, seed })
    const data = await chatJSON({ apiKey, messages, temperature: 1.15, signal })
    const ideas = (data.ideas || []).filter((it) => it && it.brief)
    progress?.push({ agent: 'muse', phase: 'done', count: ideas.length })
    return { ideas }
  },
  // 按用户想法扩充 / 修改 brief：返回 { brief }
  async expand(ctx) {
    const { apiKey, brief, genre, worldview, stance = null, userNote = '', signal } = ctx
    const messages = inspirationExpandMessages({ brief, genre, worldview, stance, userNote })
    const data = await chatJSON({ apiKey, messages, temperature: 0.8, signal })
    return { brief: String(data.brief || '') }
  },
}
