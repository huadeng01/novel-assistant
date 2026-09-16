// Polisher 单章精修师（generate）：单章精修——去 AI 味 / 残留重复 / 标点归一 / 段级定点改写（§4）。
// 两个能力：
//   refine(text)  —— 纯确定性精修（章末复读尾巴 + 中段近重复句 + 大段重复子句 + run-on 标点归一），零 Token、幂等、可单测；
//   rewrite(ctx)  —— 带 fixPrompt 的定点重写（复用 ChapterRewriter 同款 chapterRewriteMessages + DeepSeek），只改指令指出的问题。
// 在 criticLoop 里充当 revise：Logic/Editor 判不过时，Showrunner 把合并 fixPrompt 交它定点重写。
import { chatStream, ANTI_REPETITION } from '../llm.js'
import { chapterRewriteMessages } from '../prompts.js'
import { dedupeChapterTail, dedupeChapterSentences, dedupeRepeatedClauses, normalizeRunOnPunctuation, residualRepeats } from '../longform.js'
import { countWords } from '../utils.js'

// 极简标题切分（与 ChapterRewriter.parseTitle 同口径）：首行是短标题/「第X章 标题」壳则剥离，否则整段视为正文。
// 调用方可注入页面更健壮的 stripTitle 覆盖它（生产路径用页面版，测试用默认版）。
export function defaultSplitTitle(full) {
  const lines = String(full).split('\n')
  const firstIdx = lines.findIndex((l) => l.trim())
  if (firstIdx < 0) return { title: '', text: '' }
  const firstLine = lines[firstIdx].trim()
  let title = ''
  const m = firstLine.match(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[：:\s]*(.*)$/)
  if (m) title = m[1].trim()
  else if (firstLine.length <= 20 && !/[。！？!?…，,]$/.test(firstLine)) title = firstLine
  const text = title ? lines.slice(firstIdx + 1).join('\n').replace(/^\s+/, '') : String(full)
  return { title, text }
}

export const polisherAgent = {
  id: 'polisher',
  name: 'Polisher',
  role: 'generate',

  // 纯确定性精修（不调模型）：与 generateChapterBody 落库前的去重/标点归一同源，抽成可复用可单测的纯函数。
  refine(text = '') {
    let out = String(text || '')
    const notes = []
    const t1 = dedupeChapterTail(out); if (t1.flagged) { out = t1.text; notes.push(`章末重复约 ${countWords(t1.removed || '')} 字`) }
    const t2 = dedupeChapterSentences(out); if (t2.flagged) { out = t2.text; notes.push(`中段近重复句 ${t2.removedCount} 处`) }
    const t3 = dedupeRepeatedClauses(out); if (t3.flagged) { out = t3.text; notes.push(`大段重复子句 ${t3.removedCount} 处`) }
    const t4 = normalizeRunOnPunctuation(out); if (t4.flagged) { out = t4.text; notes.push(`无标点长句补断 ${t4.inserted} 处`) }
    return { text: out, notes, changed: notes.length > 0, residual: residualRepeats(out) }
  },

  // 定点重写：按 fixPrompt 只改问题处，其余尽量保持原样（DeepSeek 执行，复用书风规则）。返回 { full, text, title }。
  async rewrite(ctx = {}) {
    const {
      apiKey, chapterNo, title = '', content = '', fixPrompt = '', world = '', prevSummary = '', nextSummary = '',
      forbidden = [], style = '', habits = [], rules = [], samples = [], characters = [], signal, onDelta,
      splitTitle = defaultSplitTitle, minWords = 200,
    } = ctx
    if (!String(fixPrompt || '').trim()) return { full: content, text: content, title, unchanged: true }
    const full = await chatStream({
      apiKey,
      ...ANTI_REPETITION,
      messages: chapterRewriteMessages({ chapterNo, title, content, fixPrompt, world, prevSummary, nextSummary, forbidden, style, habits, rules, samples, characters }),
      temperature: 0.8,
      signal,
      onDelta,
    })
    if (countWords(full) < minWords) throw new Error(`第 ${chapterNo} 章重写结果太短（${countWords(full)} 字），疑似异常`)
    const parsed = splitTitle(full)
    return { full, text: parsed.text, title: parsed.title || title }
  },

  // 统一 agent 契约：run = 定点重写（generate 角色，编排层作为 revise 传入 criticLoop）。
  async run(ctx = {}) {
    ctx.progress?.push({ agent: 'polisher', phase: 'start' })
    const out = await this.rewrite(ctx)
    ctx.progress?.push({ agent: 'polisher', phase: 'done', words: countWords(out.text || '') })
    return out
  },
}
