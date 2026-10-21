// 通用小工具
// M12：原 quote/speech/dedup/clause/sentence 等 34 个导出（QUOTE_PAIRS / QUOTE_PAIRS_DOUBLE / QUOTE_CHAR_RE /
//   quotedSpans / quotedLinesOf / speechQuoteSpans / attributeSpeechQuotes / speechVerbReOf / normalizeForDedup /
//   stripFixedPunct / FIXED_PUNCT_RE / clauseFragments / sentenceSpans / isSpeechQuote / isDigitOnlyQuote /
//   DISPLAY_* / SPEECH_* / CLAUSE_* / SENTENCE_* / ELLIPSIS_SRC / READOUT_TAIL_RE / MIN_FRAG_LEN 等）
//   只被已物理删除的暗箱流水线（continuity / threads / voice / knowledge / foreshadowLeak）消费；暗箱删除后全为零消费方，
//   已连同其内部 helper 与实测取证注释一并移除（用户拍板确认删除）。下面 6 个是仍被页面/hooks 使用的零依赖小工具（uid / countWords / downloadBlob / downloadText / copyText / mapLimit）。

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// C40：语义 = 去掉所有空白后的**字符数**（非「词数」）。中文按字计数，与全站 UI 的「N 字」显示、各阈值（如导入「少于100字」、续写「至少几十字」）口径一致，用户无感。
//   函数名 countWords 是历史遗留（英文习惯叫法），本轮**不改名**：改名要动 8 处跨文件引用、收益低风险高；以本注释钉住真实语义即可。
export function countWords(text) {
  return (text || '').replace(/\s/g, '').length
}

// B27：localStorage 读写容错单一出处。隐私模式/禁用存储/配额满时 getItem/setItem 会**抛错**（不只是返回 null），
//   渲染期裸读（如 useState 初始化、writerProvider()）抛错 = 整页白屏。读失败返回 null、写失败静默。
//   原 App.jsx（多行版）与 llm.js（单行版）各留一份逐字等价的副本，现下沉到此、两处改 import。
export function safeGetItem(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function safeSetItem(key, val) {
  try {
    localStorage.setItem(key, val)
  } catch {
    /* 隐私模式/配额满：忽略 */
  }
}

// 触发浏览器下载一个 Blob —— 下载逻辑单一出处（L尾批：此前 utils.downloadText 与 docio.triggerDownload 各写一份逐字相同的 createObjectURL+a.click+revoke）
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 下载为文件（平板上会走系统的"存储到文件"流程）
export function downloadText(filename, text, type = 'text/plain') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }))
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // iOS Safari 部分场景下 clipboard 不可用，降级为选中复制。
    // item12：整段 fallback 包 try/catch + execCommand 存在性守卫——execCommand 在部分浏览器已移除，
    //   裸调会在 catch 内再抛 TypeError → copyText 的 promise reject，调用方(RevisePage/ContinuePage 复制按钮无 try/catch)
    //   卡在"复制"态并产生未处理 rejection。改为永不抛：成功返 true、任何失败返 false，由调用方据 false 提示"复制失败"。
    //   finally 兜住 ta.remove()，避免 execCommand 抛错时 textarea 残留在 body。
    let ta = null
    try {
      ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      return typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    } catch {
      return false
    } finally {
      if (ta) ta.remove()
    }
  }
}

// 并发受限的 map：最多同时跑 limit 个，返回与 items 同序的结果数组
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  let failed = false // L(尾批)：单点失败即置位，其余 worker 停止取新 item（此前 Promise.all reject 后其他 worker 仍把剩余 items 跑完，白费额度/可能产生副作用）
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failed) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        failed = true
        throw e
      }
    }
  })
  await Promise.all(workers)
  return results
}
