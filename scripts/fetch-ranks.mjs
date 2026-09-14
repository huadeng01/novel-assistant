#!/usr/bin/env node
// 墨语 · 每日小说榜单抓取入口（GitHub Actions 每日定时运行 / 本地手动运行）
//
// 流程：遍历各平台 adapter →
//   ① 运行时逐个校验 robots.txt（每个榜单 URL 的路径，User-agent:* 段 Disallow → 跳过该榜）
//   ② 允许的 → 抓榜单列表页（透明 UA、超时 15s、重试≤3、同域限速 ≥5s、并发=1）
//   ③ parse → 抽取榜单元数据（排名/书名/作者/封面/简介/分类/官方链接）
//   ④ 每个平台可配置多个榜单 URL（含男频/女频、分类子榜），逐 URL 尽力而为：
//      部分榜失败仍保留成功榜（平台 ok:true），全部失败才 ok:false 占位，不阻塞其它平台
// 输出：public/ranks.json（§3 schema；UTF-8，2 空格缩进）
//
// 合规红线（交接文档 §6）：只元数据、不抓正文/章节、不伪装 UA、不破解技术措施（含字体加密）。
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import adapters from './ranks/adapters/index.mjs'
import { checkRobots } from './ranks/robots.mjs'
import { get } from './ranks/http.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'public', 'ranks.json')

const MAX_BOOKS_PER_LIST = 20

function originOf(home) {
  try {
    return new URL(home).origin
  } catch {
    return home
  }
}

// 限制每榜书籍数量（最小必要采集）
function clampLists(lists) {
  return lists.map((l) => ({
    ...l,
    books: (l.books || []).slice(0, MAX_BOOKS_PER_LIST),
  }))
}

/**
 * 抓取单个平台：逐个抓取 lists 配置中的榜单页，尽力而为合并 lists。
 * @returns {Promise<{platform, platformName, home, ok, error, robotsAllowed, fetchedAt, lists}>}
 */
async function fetchPlatform(adapter) {
  const platformName = adapter.name
  const home = adapter.home
  const origin = originOf(home)
  const base = {
    platform: adapter.id,
    platformName,
    home,
    ok: false,
    error: null,
    robotsAllowed: true,
    fetchedAt: new Date().toISOString(),
    lists: [],
  }

  // 显式禁用的平台（如 WAF 反爬）：直接占位，不发起任何请求
  if (adapter.disabled) {
    return { ...base, error: adapter.disabledReason || 'disabled', robotsAllowed: false }
  }

  // 榜单配置：adapter.lists = [{ listId, listName, url, gender?, category? }]（数量因平台而异）
  const listsCfg = adapter.lists || (adapter.rankUrls || []).map((url) => ({ listId: 'list', listName: '', url }))
  if (!listsCfg.length) return { ...base, error: 'no-rank-url' }

  const lists = []
  let robotsAllowed = true
  let firstError = null

  for (const cfg of listsCfg) {
    const url = cfg.url
    // ① 逐个榜单 URL 做 robots 校验（不同路径的规则可能不同）
    let pathname
    try {
      pathname = new URL(url).pathname
    } catch {
      firstError ||= 'bad-rank-url'
      continue
    }
    const rb = await checkRobots(origin, pathname)
    if (rb.error) {
      firstError ||= rb.error
      robotsAllowed = false
      continue
    }
    if (rb.robotsAllowed === false) {
      firstError ||= 'robots-disallow'
      robotsAllowed = false
      continue
    }
    robotsAllowed = rb.robotsAllowed

    // ② 抓榜单页（个别平台对机器人 UA 直接 404，见 adapter.needsBrowserUA 说明）
    let res
    try {
      const opts = adapter.needsBrowserUA && adapter.browserUA ? { userAgent: adapter.browserUA } : {}
      res = await get(url, opts)
    } catch (e) {
      firstError ||= `http-${(e && e.message) || e}`
      continue
    }
    if (!res.ok) {
      firstError ||= `http-${res.status}`
      continue
    }

    // ③ 解析。parse(html, ctx) 返回两种形态：
    //    - books 数组（普通平台）→ 用配置中的 listId/listName/gender/category 组装；
    //    - [{listId, listName, gender, books}, …]（单页多榜单平台，如书旗）→ 直接采用（parse 自带 gender）。
    try {
      const parsed = await adapter.parse(res.text, { get, url })
      const outLists = Array.isArray(parsed) && parsed.length && parsed[0] && Array.isArray(parsed[0].books)
        ? parsed
        : [{ listId: cfg.listId, listName: cfg.listName, category: cfg.category || '全部', gender: cfg.gender || '全部', books: parsed }]
      const clamped = clampLists(outLists)
      if (clamped.length) lists.push(...clamped)
      else firstError ||= 'empty-lists'
    } catch (e) {
      firstError ||= `parse-${(e && e.message) || e}`
    }
  }

  if (!lists.length) {
    return { ...base, error: firstError || 'empty-lists', robotsAllowed }
  }
  const extra = adapter.needsBrowserUA ? { ua: 'browser-fallback' } : {}
  return { ...base, ok: true, robotsAllowed, lists, ...extra }
}

function beijingLabel(iso) {
  const d = new Date(iso)
  const s = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return `${s.replace(/\//g, '-')} (Asia/Shanghai)`
}

async function main() {
  const started = Date.now()
  const results = []
  for (const adapter of adapters) {
    const r = await fetchPlatform(adapter)
    results.push(r)
    const tag = r.ok ? 'ok  ' : 'skip'
    const books = r.lists.reduce((n, l) => n + (l.books || []).length, 0)
    console.log(`[${tag}] ${r.platformName.padEnd(6)} ${r.ok ? `${r.lists.length} 榜 / ${books} 本` : r.error}`)
  }

  const generatedAt = new Date().toISOString()
  const payload = {
    schemaVersion: 1,
    generatedAt,
    generatedAtLocal: beijingLabel(generatedAt),
    note: '榜单快照由 scripts/fetch-ranks.mjs 每日抓取生成；仅含榜单元数据（排名/书名/作者/封面/简介/分类/频道/官方链接），点击外链至官方阅读页，本应用不存储任何正文。榜单按平台真实结构组织（男频/女频频道 + 站内分类子榜/总榜），不含任何虚构数据。',
    sources: results,
  }

  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8')

  const okCount = results.filter((r) => r.ok).length
  const totalBooks = results.reduce((n, r) => n + r.lists.reduce((m, l) => m + (l.books || []).length, 0), 0)
  console.log(`\n完成：${okCount}/${results.length} 平台成功，共 ${totalBooks} 本；耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`输出：${OUT}`)

  // 全部平台失败才失败（避免单平台故障让整个 workflow 标红）
  if (okCount === 0) process.exit(1)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
