// 通用小工具
// M12：原 quote/speech/dedup/clause/sentence 等 34 个导出（QUOTE_PAIRS / QUOTE_PAIRS_DOUBLE / QUOTE_CHAR_RE /
//   quotedSpans / quotedLinesOf / speechQuoteSpans / attributeSpeechQuotes / speechVerbReOf / normalizeForDedup /
//   stripFixedPunct / FIXED_PUNCT_RE / clauseFragments / sentenceSpans / isSpeechQuote / isDigitOnlyQuote /
//   DISPLAY_* / SPEECH_* / CLAUSE_* / SENTENCE_* / ELLIPSIS_SRC / READOUT_TAIL_RE / MIN_FRAG_LEN 等）
//   只被已物理删除的暗箱流水线（continuity / threads / voice / knowledge / foreshadowLeak）消费；暗箱删除后全为零消费方，
//   已连同其内部 helper 与实测取证注释一并移除（用户拍板确认删除）。下面 5 个是仍被页面/hooks 使用的零依赖小工具。

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function countWords(text) {
  return (text || '').replace(/\s/g, '').length
}

// 下载为文件（平板上会走系统的"存储到文件"流程）
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // iOS Safari 部分场景下 clipboard 不可用，降级为选中复制
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

// 并发受限的 map：最多同时跑 limit 个，返回与 items 同序的结果数组
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
