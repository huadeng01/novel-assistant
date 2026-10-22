// 续写页「时间事件账本」的纯函数层：分段切分、条目归一（含旧版时间线迁移）、跨段合并去重、注入提示词时的截取。
// 账本条目 = { time, event }：time 是原文明写的时间表述（没写就空串），event 是该处发生的事件一句话；两者至少其一非空。

// 每段字数。分段分析保证长原文的时间与事件不被遗漏；切分不在 UTF-16 代理对中间断开（emoji/扩展汉字占两个码元），否则半截代理对喂给 AI 会失真。
export const CHRONICLE_CHUNK = 10000

export const chunkText = (src, size = CHRONICLE_CHUNK) => {
  const s = String(src || '')
  if (!s) return []
  const out = []
  for (let i = 0; i < s.length; ) {
    let end = Math.min(i + size, s.length)
    if (end < s.length) {
      const code = s.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    out.push(s.slice(i, end))
    i = end
  }
  return out
}

// 条目归一：字段强制字符串、去首尾空白；time 与 event 全空的条目丢弃。chapter 为原文明写章节标题解析出的章号，无则空串。
// 旧版时间线条目 {stage, summary} 迁移为 {chapter:'', time:'', event:'stage：summary'}，用户已有的分析结果不丢。
export const normalizeChronicle = (raw) => {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      if (!it || typeof it !== 'object') return null
      const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
      if (typeof it.stage === 'string' || typeof it.summary === 'string') {
        const stage = str(it.stage)
        const summary = str(it.summary)
        const event = [stage, summary].filter(Boolean).join('：')
        return event ? { chapter: '', time: '', event } : null
      }
      const chapter = str(it.chapter)
      const time = str(it.time)
      const event = str(it.event)
      return time || event ? { chapter, time, event } : null
    })
    .filter(Boolean)
}

// 各段结果按原文顺序拼接；跨段重复事件（event 归一后相同）只留第一条，防段边界处同一事件被两段各报一次。
export const mergeChronicle = (segments) => {
  const seen = new Set()
  const out = []
  ;(segments || []).forEach((seg) => {
    normalizeChronicle(seg).forEach((it) => {
      const k = it.event.replace(/\s/g, '')
      if (k && seen.has(k)) return
      if (k) seen.add(k)
      out.push(it)
    })
  })
  return out
}

// 注入续写/后续提示词时的截取：账本可能上百条，全投会挤爆上下文。
// 取首条（时间跨度锚）+ 末 40 条（离续写处最近的进展），中间省略。
export const pickChronicleForPrompt = (list, tail = 40) => {
  const arr = normalizeChronicle(list)
  if (arr.length <= tail + 1) return arr
  return [arr[0], ...arr.slice(-tail)]
}

export const chronicleToText = (list) =>
  normalizeChronicle(list)
    .map((t, i) => `${i + 1}. ${t.chapter ? `第${t.chapter}章` : ''}${t.time ? `【${t.time}】` : ''}${t.event}`)
    .join('\n')
