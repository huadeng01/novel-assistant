// 全站共用的小工具集合：id 生成、字数统计、localStorage 容错读写、浏览器下载、复制、并发受限的 map。
// 这些函数都不依赖业务数据，任何页面和 lib 都可以直接 import。

// 生成一个短随机 id。
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// 统计去掉所有空白后的字符数。中文按字计数，与全站界面上「N 字」的显示和各处字数阈值口径一致。
// 函数名叫 countWords 是历史遗留（英文习惯叫法），实际语义是字符数。
export function countWords(text) {
  return (text || '').replace(/\s/g, '').length
}

// localStorage 读写的容错包装，全站单一出处。隐私模式、禁用存储、配额满时读写会直接抛错而不是返回 null，
// 渲染期裸读（如 useState 初始化）抛错会导致整页白屏，所以这里统一吞掉异常。
// 读失败返回 null；写返回布尔值表示是否真的写进去了，调用方可据此避免「看起来成功实际没存」；删除失败静默（清除本就是无操作）。
export function safeGetItem(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
// 写一条 localStorage 记录，返回布尔值表示是否真的写进去。
export function safeSetItem(key, val) {
  try {
    localStorage.setItem(key, val)
    return true
  } catch {
    return false
  }
}
// 删一条 localStorage 记录，存储不可用时静默（清除本就是无操作）。
export function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 存储不可用时清除本就是无操作 */
  }
}

// 触发浏览器下载一个 Blob。下载逻辑的单一出处，避免各处各写一份创建链接、点击、回收的代码。
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

// 把一段文本下载为文件。平板上会走系统的「存储到文件」流程。
export function downloadText(filename, text, type = 'text/plain') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }))
}

// 复制文本到剪贴板，返回是否成功。优先用现代 clipboard 接口；
// 部分浏览器（如 iOS Safari 某些场景）不可用时降级为临时 textarea 选中复制。
// 任何失败都返回 false 而不抛错，由调用方据此提示「复制失败」。
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
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

// 并发受限的 map：最多同时跑 limit 个任务，返回与输入同序的结果数组。
// 任一任务失败即停止领取新任务并抛出该错误（已跑完的结果丢弃），避免白费额度或产生多余副作用。
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  let failed = false
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
