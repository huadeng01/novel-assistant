// 潇湘书院榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：潇湘书院 /rank 系列含 7 个站内总榜——
//   ★ 修正：/rank 默认页是【人气榜单】（非票榜）；潇湘票榜实为 /rank/xxyuepiao。
//   人气榜单/rank、潇湘票榜/rank/xxyuepiao、新书榜/rank/new、畅销榜/rank/bestsales、
//   完结榜/rank/finish、阅读榜/rank/reading、收藏榜/rank/collections。
// 两种页面 DOM（li.n2 票榜结构 / a.page-one 书单结构）随榜不同，故 parse 两种都试、取命中多者（稳健，不依赖 URL 判断）。
// ★ 题材分类（古代言情/现代言情…）指向 /category/N.html 书库页（非榜单），故不做题材子榜。
// gender：潇湘书院为女频向平台，站内总榜不再拆男女频，整体归【女频】。
import { get } from '../http.mjs'

const HOME = 'https://www.xxsy.net'

export default {
  id: 'xxsy',
  name: '潇湘书院',
  home: HOME,
  lists: [
    { listId: 'popular', listName: '人气榜单', gender: '女频', category: '全部', url: `${HOME}/rank` },
    { listId: 'ticket', listName: '潇湘票榜', gender: '女频', category: '全部', url: `${HOME}/rank/xxyuepiao` },
    { listId: 'new', listName: '新书榜', gender: '女频', category: '全部', url: `${HOME}/rank/new` },
    { listId: 'best-sale', listName: '畅销榜', gender: '女频', category: '全部', url: `${HOME}/rank/bestsales` },
    { listId: 'finish', listName: '完结榜', gender: '女频', category: '全部', url: `${HOME}/rank/finish` },
    { listId: 'reading', listName: '阅读榜', gender: '女频', category: '全部', url: `${HOME}/rank/reading` },
    { listId: 'collections', listName: '收藏榜', gender: '女频', category: '全部', url: `${HOME}/rank/collections` },
  ],
  officialUrlOf: (book) => `${HOME}/book/${book.bookId}`,

  async parse(html) {
    // 两种模板都尝试，取命中书目更多者（票榜页 li.n2 / 书单页 a.page-one），稳健且不依赖 URL 判断
    const reading = parseReading(html)
    const tickets = parseTickets(html)
    return reading.length >= tickets.length ? reading : tickets
  },
}

// 默认票榜页：<li class="n2" data-bookid="...">，内含 排名 span.num / 作者 span.piao / 书名 p>a
function parseTickets(html) {
  const books = []
  const liRe = /<li[^>]*class="[^"]*\bn2\b[^"]*"[^>]*data-bookid="(\d+)"[\s\S]*?<\/li>/g
  let m
  while ((m = liRe.exec(html))) {
    const block = m[0]
    const bookId = m[1]
    const rankM = block.match(/<span[^>]*class="[^"]*num[^"]*"[^>]*>\s*(\d+)/)
    const authorM = block.match(/<span[^>]*class="[^"]*piao[^"]*"[^>]*>([^<]+)<\/span>/)
    const titleM = block.match(/<p[^>]*>\s*<a[^>]*>([^<]+)<\/a>/)
    const title = strip(titleM ? titleM[1] : '')
    if (!title) continue
    books.push({
      rank: rankM ? Number(rankM[1]) : books.length + 1,
      title,
      author: strip(authorM ? authorM[1] : ''),
      cover: '',
      intro: '',
      category: '',
      officialUrl: `${HOME}/book/${bookId}`,
      extra: {},
    })
    if (books.length >= 20) break
  }
  return books
}

// 阅读/完结/畅销榜页：<a class="page-one" href="/book/{id}" title="书名">，封面走 bookcover.yuewen.com
function parseReading(html) {
  const books = []
  const aRe = /<a[^>]*class="[^"]*page-one[^"]*"[^>]*href="\/book\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = aRe.exec(html))) {
    const bookId = m[1]
    const inner = m[2]
    const titleM = inner.match(/title="([^"]+)"/) || m[0].match(/title="([^"]+)"/)
    const coverM = (m[0] + inner).match(/(?:data-original|src)="(\/\/bookcover\.yuewen\.com\/[^"]+)"/)
    const title = strip(titleM ? titleM[1] : '')
    if (!title) continue
    books.push({
      rank: books.length + 1,
      title,
      author: '',
      cover: coverM ? `https:${coverM[1]}` : '',
      intro: '',
      category: '',
      officialUrl: `${HOME}/book/${bookId}`,
      extra: {},
    })
    if (books.length >= 20) break
  }
  return books
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
