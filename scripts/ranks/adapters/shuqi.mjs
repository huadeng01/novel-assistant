// 书旗小说榜单 adapter
//
// 站内结构（真实）：书旗 /rank/ 是【单页多榜】——一页里并排渲染多个 <ul class="cp-ranks-list">，
// 且男频、女频各一组。每组的榜名（点击榜/收藏榜/订阅榜/人气榜/完结榜/更新榜）与频道（男频/女频）
// 以标题文本形式出现在对应 ul 之前。故 parse 需要：
//   ① 定位每个 ul；② 向前回溯最近的「榜名关键词」与「男频/女频」标记；③ 解析 ul 内书目；
//   ④ 以 {频道}-{榜名} 作为 listId 去重，返回多榜数组（fetch-ranks 直接采用，gender 已在其中）。
// 这是"按站内真实分组还原男女频"，不虚构任何频道或书目。
import { get } from '../http.mjs'

const HOME = 'https://www.shuqi.com'

// 榜名关键词 → listId 片段 + 展示名
const BLOCK_TITLES = [
  { kw: '点击榜', key: 'click', name: '点击榜' },
  { kw: '收藏榜', key: 'collect', name: '收藏榜' },
  { kw: '订阅榜', key: 'order', name: '订阅榜' },
  { kw: '人气榜', key: 'popular', name: '人气榜' },
  { kw: '完结榜', key: 'finish', name: '完结榜' },
  { kw: '更新榜', key: 'update', name: '更新榜' },
]
const GENDERS = [
  { kw: '男频', key: 'boy', label: '男频' },
  { kw: '女频', key: 'girl', label: '女频' },
]

export default {
  id: 'shuqi',
  name: '书旗小说',
  home: HOME,
  lists: [
    { listId: 'multi', listName: '书旗排行榜', gender: '全部', category: '全部', url: `${HOME}/rank/` },
  ],
  officialUrlOf: (book) => `${HOME}/book/${book.bookId}.html`,

  async parse(html) {
    const out = []
    const seen = new Set()
    const ulRe = /<ul class="cp-ranks-list[^"]*"[\s\S]*?<\/ul>/g
    let m
    while ((m = ulRe.exec(html))) {
      const ul = m[0]
      const prefix = html.slice(0, m.index)
      const titleHit = nearestOf(prefix, BLOCK_TITLES)
      const genderHit = nearestOf(prefix, GENDERS)
      const listKey = titleHit ? titleHit.key : 'rank'
      const listName = titleHit ? titleHit.name : '排行榜'
      const gKey = genderHit ? genderHit.key : 'all'
      const gender = genderHit ? genderHit.label : '全部'
      const listId = `${gKey}-${listKey}`
      if (seen.has(listId)) continue
      const books = parseBooks(ul)
      if (!books.length) continue
      seen.add(listId)
      out.push({
        listId,
        listName: gender !== '全部' ? `${gender}·${listName}` : listName,
        gender,
        category: '全部',
        books,
      })
    }
    return out
  },
}

// 在 prefix 中找「出现位置最靠后」的关键词条目（即离当前 ul 最近的标题/频道标记）
function nearestOf(prefix, entries) {
  let best = null
  let bestIdx = -1
  for (const e of entries) {
    const idx = prefix.lastIndexOf(e.kw)
    if (idx > bestIdx) {
      bestIdx = idx
      best = e
    }
  }
  return best
}

function parseBooks(ul) {
  const books = []
  const liRe = /<li[\s\S]*?<\/li>/g
  let m
  while ((m = liRe.exec(ul))) {
    const li = m[0]
    const idM = li.match(/href="\/book\/(\d+)\.html"/)
    if (!idM) continue
    const bookId = idM[1]
    const bnM = li.match(/<span class="bn"[^>]*>([^<]+)<\/span>/)
    const title = strip(bnM ? bnM[1] : '')
    if (!title) continue
    const noM = li.match(/<i class="no[^"]*"[^>]*>\s*(\d+)/)
    const auM = li.match(/<span class="au"[^>]*>([^<]+)<\/span>/)
    books.push({
      rank: noM ? Number(noM[1]) : books.length + 1,
      title,
      author: strip(auM ? auM[1] : ''),
      cover: '',
      intro: '',
      category: '',
      officialUrl: `${HOME}/book/${bookId}.html`,
      extra: {},
    })
    if (books.length >= 20) break
  }
  return books
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
