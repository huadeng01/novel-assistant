// 番茄小说榜单 adapter（v2：榜单 JSON API + 动态全分类 + 男女频 × 阅读/新书 = 74 榜）
//
// 【浏览器 + node 端实测 2026-09-14 结论，务必按此理解】
// 1) 榜单只按「主分类」建：抓一次 /rank/1_2 的 SSR，__INITIAL_STATE__.rank.rankCategoryTypeList
//    给出 male(19) / female(18) 两组分类 {id,name}（与 gender 参数无关，一次拿全）。
//    74 榜位 = male×{阅读榜,新书榜} + female×{阅读榜,新书榜} = 19*2 + 18*2。
// 2) ★ 干净的榜单 JSON API（无需签名 / 无需 cookie，node 直连实测 code:0）：
//      /api/rank/category/list?app_id=2503&rank_list_type=3&offset=0&limit=N&rank_version=&gender={1|0}&rankMold={2|1}&category_id={id}
//    坑：rank_list_type 只能是 3；rank_version 这个 key 必须存在（值可空）；必须带 category_id（"全部"榜无 API）。
//    响应 data.book_list[]：bookId/currentPos(排名)/read_count(在读数)/wordNumber/creationStatus/lastChapterTitle 全明文。
// 3) ★ 字体加密：bookName/author/abstract 里部分汉字被 awesome-font 替换成 PUA 码位(U+E000–U+F8FF)，
//    API 与榜单页 HTML 都一样。按合规护栏【不破解字体、不下 woff2 解码】，改从书籍详情页 /page/{id} 的
//    SSR head（<title>/JSON-LD author/meta description，均明文）兜底；且【只对含 PUA 的书】补详情页，明文书名直接跳过，省请求。
// 4) 网页端【没有完结榜/完本榜】（App 独有）——这也是"项目榜单 ≠ App 完本榜"的根因，故不编造该类榜。
// 5) robots：/rank、/api/rank/category/list、/page 三条路径抓取前经 checkRobots 确认允许（见 fetch-ranks 域级校验 + _verify 实测）。
// 6) 命名：按用户要求去掉"男频/女频阅读榜·"前缀——阅读榜 listName 只留分类名；新书榜加"·新书"最小后缀区分（频道由 gender 字段承载）。
import { get } from '../http.mjs'

const HOME = 'https://fanqienovel.com'
const API = `${HOME}/api/rank/category/list`
const ENTRY = `${HOME}/rank/1_2` // 抓此页 SSR 拿 rankCategoryTypeList.male/female
const TOP_N = Number(process.env.FANQIE_TOP_N || 10) // 每榜展示 / 补详情页的本数
const RANGE = '0-40000'

// rankMold：2=阅读榜，1=新书榜
const MOLDS = [
  { mold: 2, suffix: '' }, // 阅读榜：listName 只留分类名
  { mold: 1, suffix: '·新书' }, // 新书榜：分类名 + 最小区分后缀
]

export default {
  id: 'fanqie',
  name: '番茄小说',
  home: HOME,
  // 单入口：parse 内部动态展开成 74 个分类子榜（返回多榜数组，fetch-ranks 直接采用）
  lists: [{ listId: 'multi', listName: '番茄榜单', gender: '全部', category: '全部', url: ENTRY }],
  officialUrlOf: (book) => `${HOME}/page/${book.bookId}`,

  /**
   * @param {string} html /rank/1_2 的 SSR HTML
   * @param {{get:Function, url:string}} ctx 限速版 get（内部抓 API / 详情页都必须用 ctx.get）
   */
  async parse(html, ctx = {}) {
    const getPage = ctx.get || get
    const st = extractInitialState(html)
    const rctl = st && st.rank && st.rank.rankCategoryTypeList
    if (!rctl || !Array.isArray(rctl.male) || !Array.isArray(rctl.female)) {
      throw new Error('no-rank-category-list')
    }
    const maxLists = Number(process.env.FANQIE_MAX_LISTS || 0) // >0 时只处理前 N 个榜位（快速验证用）
    const channels = [
      { key: 'boy', gender: '男频', gparam: 1, cats: rctl.male },
      { key: 'girl', gender: '女频', gparam: 0, cats: rctl.female },
    ]
    const out = []
    for (const mold of MOLDS) {
      for (const ch of channels) {
        for (const cat of ch.cats) {
          if (!cat || !cat.id) continue
          const books = await fetchRankList(getPage, cat.id, mold.mold, ch.gparam)
          if (books.length) {
            out.push({
              listId: `${ch.key}-${mold.mold}-${cat.id}`,
              listName: `${cat.name || '分类'}${mold.suffix}`,
              gender: ch.gender,
              category: cat.name || '',
              books,
            })
          }
          if (maxLists && out.length >= maxLists) return out
        }
      }
    }
    return out
  },
}

// 抓单个分类榜：API 拿明文指标 → 对含 PUA 的书名/作者用详情页兜底
async function fetchRankList(getPage, categoryId, rankMold, gparam) {
  const url = `${API}?app_id=2503&rank_list_type=3&offset=0&limit=${TOP_N}&rank_version=&gender=${gparam}&rankMold=${rankMold}&category_id=${categoryId}`
  let bl = []
  try {
    const res = await getPage(url, { timeout: 15000, retries: 2, headers: { referer: `${HOME}/rank/` } })
    if (!res.ok) return []
    const j = JSON.parse(res.text)
    bl = (j && j.data && Array.isArray(j.data.book_list)) ? j.data.book_list : []
  } catch {
    return []
  }
  const books = []
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i]
    if (!b || !b.bookId) continue
    const book = {
      rank: Number(b.currentPos) || i + 1,
      title: b.bookName || '',
      author: b.author || '',
      cover: cleanUrl(b.thumbUri) || '',
      intro: stripPua(b.abstract || '').slice(0, 120),
      category: b.categoryV2 || b.category || '',
      officialUrl: `${HOME}/page/${b.bookId}`,
      extra: {
        wordCount: fmtWordCount(b.wordNumber),
        status: String(b.creationStatus) === '0' ? '完结' : '连载',
        readCount: fmtHeat(b.read_count || b.readCount),
        lastChapter: b.lastChapterTitle || '',
      },
    }
    // 仅当书名/作者被字体加密（含 PUA）或缺失时，才抓详情页兜底明文（省请求）
    if (hasPua(book.title) || hasPua(book.author) || !book.title) {
      const d = await fetchBookMeta(`${HOME}/page/${b.bookId}`, getPage)
      if (d) {
        if (d.title) book.title = d.title
        if (d.author) book.author = d.author
        if (d.intro) book.intro = d.intro
      }
    }
    // 兜底后仍残留 PUA → 去掉乱码方块，只保留可读部分（不展示乱码）
    if (hasPua(book.title)) book.title = stripPua(book.title)
    if (hasPua(book.author)) book.author = stripPua(book.author)
    if (hasPua(book.intro)) book.intro = stripPua(book.intro)
    books.push(book)
  }
  return books
}

// ---- 工具函数 ----

// 是否含 PUA 私有区码位（字体加密的特征）
function hasPua(s) {
  return /[\uE000-\uF8FF]/.test(String(s || ''))
}
// 去掉 PUA 码位字符（残留乱码方块）
function stripPua(s) {
  return String(s || '').replace(/[\uE000-\uF8FF]/g, '').trim()
}

export function extractInitialState(html) {
  // window.__INITIAL_STATE__={...}; 后跟 IIFE，须用状态机找 JSON 顶层右花括号（正确处理字符串转义）。
  const marker = 'window.__INITIAL_STATE__='
  const start = html.indexOf(marker)
  if (start < 0) return null
  const jsonStart = start + marker.length
  let depth = 0
  let inStr = false
  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(sanitizeJsObject(html.slice(jsonStart, i + 1))) } catch { return null }
      }
    }
  }
  return null
}

// 把 JS 对象字面量值位置的裸 undefined 替换为 null（字符串内同名文本不受影响）
function sanitizeJsObject(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') { out += text[i + 1] || ''; i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (text.startsWith('undefined', i)) { out += 'null'; i += 8; continue }
    out += c
  }
  return out
}

function cleanUrl(u) {
  if (!u) return ''
  return String(u).replace(/\\u002F/g, '/').replace(/\\\//g, '/')
}

function fmtWordCount(n) {
  const num = Number(n)
  if (!num || num <= 0) return ''
  return num >= 10000 ? `${(num / 10000).toFixed(1).replace(/\.0$/, '')}万字` : `${num}字`
}

function fmtHeat(n) {
  const num = Number(n)
  if (!num || num <= 0) return ''
  return num >= 10000 ? `${(num / 10000).toFixed(1).replace(/\.0$/, '')}万在读` : `${num}在读`
}

// 抓详情页 head 区，提取明文书名/作者/简介（全部来自 SEO 元数据，非正文，不破解字体）
async function fetchBookMeta(url, getPage) {
  try {
    const res = await getPage(url, { timeout: 12000, retries: 1, range: RANGE, headers: { referer: `${HOME}/` } })
    if (!res.ok) return null
    const html = res.text
    const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || ''
    const realTitle = extractRealTitle(title)
    const author = (html.match(/"author":\[\{"@type":"Person","name":"([^"]+)"/) || [])[1] || ''
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || ''
    const intro = desc
      .replace(/^[^。]*?番茄小说网。/g, '')
      .replace(/^番茄小说提供[^。]*?，精彩小说尽在番茄小说网。/, '')
      .slice(0, 120)
    return { title: realTitle || '', author: author || '', intro }
  } catch {
    return null
  }
}

// 形如「天渊完整版在线免费阅读_天渊小说_番茄小说官网」→「天渊」
function extractRealTitle(t) {
  if (!t) return ''
  const m = t.match(/_(.+?)小说_番茄小说官网/)
  if (m) return m[1].trim()
  const first = t.split('_')[0] || ''
  return first.replace(/完整版在线免费阅读$/, '').replace(/全文免费阅读$/, '').trim()
}
