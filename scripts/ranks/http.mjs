// 轻量 HTTP 客户端（合规护栏 #2/#3/#4）
// - 透明、可识别的 UA（不伪装搜索引擎/AI bot）
// - 单请求超时 15s；失败重试 ≤3 次（指数退避 1s/2s/4s）
// - 全局限速：同域两次请求间隔 ≥5s（串行，并发=1）
import { setTimeout as sleep } from 'node:timers/promises'

// 透明可识别 UA：声明 bot 身份，不伪装搜索引擎 / AI 爬虫。部署时可把联系方式换成本仓库地址。
export const UA = 'Mozilla/5.0 (compatible; MoyuRankBot/1.0)'

const MIN_INTERVAL_MS = 5000
const lastHit = new Map() // domain -> timestamp

// 同域限速：距上次请求不足 MIN_INTERVAL_MS 则等待
async function throttle(domain) {
  const now = Date.now()
  const last = lastHit.get(domain) || 0
  const wait = last + MIN_INTERVAL_MS - now
  if (wait > 0) await sleep(wait)
  lastHit.set(domain, Date.now())
}

function domainOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return 'unknown'
  }
}

/**
 * 发起一次带限速/超时/重试的 GET。
 * @param {string} url
 * @param {{timeout?:number, retries?:number, headers?:Record<string,string>, range?:string, userAgent?:string}} opts
 *   userAgent：覆盖默认透明 UA。仅用于「平台对机器人 UA 直接 404/403」的少数平台
 *   （见 adapters/ciweimao.mjs 的说明）；不使用搜索引擎/AI-bot UA。
 * @returns {Promise<{status:number, ok:boolean, text:string, bytes:Uint8Array, finalUrl:string}>}
 */
export async function get(url, opts = {}) {
  const timeout = opts.timeout ?? 15000
  const retries = opts.retries ?? 3
  const domain = domainOf(url)
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1)) // 1s/2s/4s 退避
    await throttle(domain)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const headers = {
        'user-agent': opts.userAgent || UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(opts.headers || {}),
      }
      if (opts.range) headers.range = `bytes=${opts.range}`
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' })
      const bytes = new Uint8Array(await res.arrayBuffer())
      // 页面编码：优先按 charset 声明；拿不到时按字节合法性回退（utf8 非法字节才用 gbk）
      const text = decodeHtml(bytes, res.headers.get('content-type'))
      return { status: res.status, ok: res.ok, text, bytes, finalUrl: res.url }
    } catch (e) {
      lastErr = e
      if (e && e.name === 'AbortError') lastErr = new Error(`timeout(${timeout}ms)`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error('fetch failed')
}

/**
 * 与 get() 相同但返回原始响应（robots 校验用，避免文本解码成本）。
 */
export async function getRaw(url, opts = {}) {
  return get(url, opts)
}

// 按 content-type 里的 charset 解码；未声明时尝试 utf-8，非法则回退 gbk
export function decodeHtml(bytes, contentType = '') {
  const m = contentType && contentType.match(/charset=([\w-]+)/i)
  const charset = m ? m[1].toLowerCase() : ''
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      /* 继续尝试其它 */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 老站常为 GBK 但未声明 charset → 回退
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}
