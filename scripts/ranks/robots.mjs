// robots.txt 运行时校验（合规护栏 #1）
// 原则：不硬编码信任——每次抓取前现场 fetch 各平台 /robots.txt，
// 仅当 User-agent:* 段允许目标路径时才继续；命中 Disallow 即跳过。
import { getRaw } from './http.mjs'

/**
 * 抓取并解析某 origin 的 robots.txt。
 * @param {string} origin 如 'https://fanqienovel.com'
 * @returns {Promise<{status:number, text:string|null, error:string|null}>}
 *   - 404 / 无文件：status 非 200，text=null（调用方按「无 robots 文件」策略处理）
 *   - 超时/网络错误：error 有值
 */
export async function fetchRobots(origin) {
  try {
    const res = await getRaw(`${origin}/robots.txt`, { timeout: 10000, retries: 2 })
    return { status: res.status, text: res.status === 200 ? res.text : null, error: null }
  } catch (e) {
    return { status: 0, text: null, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 解析 robots.txt 文本，仅保留 User-agent:*（或 *）段的 Allow/Disallow 规则。
 * @param {string} text
 * @returns {{allows: string[], disallows: string[]}}
 */
export function parseRobots(text) {
  const allows = []
  const disallows = []
  if (!text) return { allows, disallows }
  const lines = text.split(/\r?\n/)
  let inStar = true // robots 协议：未声明 User-agent 前的规则按通配处理；为稳妥，默认从头收集
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([^:#\s]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      // 只收集通用爬虫（*）段的规则；显式命名的 UA 段（含 AI bot）不适用于我们
      inStar = value === '*'
    } else if (key === 'allow' && inStar) {
      allows.push(normalizePath(value))
    } else if (key === 'disallow' && inStar && value !== '') {
      disallows.push(normalizePath(value))
    }
  }
  return { allows, disallows }
}

function normalizePath(p) {
  try {
    const u = new URL(p, 'https://placeholder.invalid')
    return u.pathname + u.search
  } catch {
    return p.startsWith('/') ? p : `/${p}`
  }
}

/**
 * 判断某个路径是否允许抓取（robots 前缀最长匹配）。
 * 默认允许；命中更长的 Disallow 才拒绝。
 * @param {string} path 如 '/rank'
 * @param {{allows: string[], disallows: string[]}} rules
 */
export function isAllowed(path, rules) {
  if (!rules) return true
  const p = normalizePath(path)
  // 找所有匹配的规则中最长的一条
  let best = null // { type: 'allow'|'disallow', len }
  for (const a of rules.allows) {
    if (p.startsWith(a) && (!best || a.length > best.len)) best = { type: 'allow', len: a.length }
  }
  for (const d of rules.disallows) {
    if (p.startsWith(d) && (!best || d.length > best.len)) best = { type: 'disallow', len: d.length }
  }
  return best ? best.type === 'allow' : true
}

/**
 * 组合入口：抓 robots → 解析 → 判断 path 是否允许。
 * @returns {Promise<{robotsAllowed:boolean|'no-robots-file', error?:string}>}
 */
export async function checkRobots(origin, path) {
  const rb = await fetchRobots(origin)
  if (rb.error) return { robotsAllowed: false, error: `robots-fetch-fail:${rb.error}` }
  if (rb.status === 404) {
    // 无 robots 文件 = 默认允许，但记录，低速抓取
    return { robotsAllowed: 'no-robots-file', error: null }
  }
  if (rb.status !== 200 || !rb.text) return { robotsAllowed: false, error: `robots-http-${rb.status}` }
  const rules = parseRobots(rb.text)
  return { robotsAllowed: isAllowed(path, rules), error: isAllowed(path, rules) ? null : 'robots-disallow' }
}
