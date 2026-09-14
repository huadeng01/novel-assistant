// 纵横中文网榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：纵横 /rank?nav={key}&rankType={N} 通过 query 切换 10 种书籍榜（人气/月票/24小时畅销/新书/点击/推荐/打赏/完结/新书订阅/24小时更新）。
// SSR 每本以 <div data-id="{id}" class="zh-modules-rank-book..."> 分块，各 nav 共用同一模板。
// 逐榜尽力而为：个别 tab 若为客户端渲染（首屏 HTML 无数据）则该榜解析为空、自动跳过，不影响其它榜。
// 作者人气榜（nav=author-popularity）是作者榜非书籍榜，结构不同，故不纳入。
// gender：纵横中文网为男频向平台，整体归【男频】。
import { get } from '../http.mjs'

const HOME = 'https://www.zongheng.com'

// 纵横真实榜单（nav/rankType 来自站内导航，2026-09-14 侦察确认）
const RANKS = [
  { id: 'popular', name: '人气榜', nav: 'default' },
  { id: 'monthly-ticket', name: '月票榜', nav: 'monthly-ticket', type: 1 },
  { id: 'one-day-sell', name: '24小时畅销榜', nav: 'one-day', type: 3 },
  { id: 'new-book', name: '新书榜', nav: 'new-book', type: 4 },
  { id: 'click', name: '点击榜', nav: 'click', type: 5 },
  { id: 'recommend', name: '推荐榜', nav: 'recommend', type: 6 },
  { id: 'claque', name: '打赏榜', nav: 'claque', type: 7 },
  { id: 'end', name: '完结榜', nav: 'end', type: 8 },
  { id: 'new-book-subscribe', name: '新书订阅榜', nav: 'new-book-subscribe', type: 9 },
  { id: 'one-day-update', name: '24小时更新榜', nav: 'one-day-update', type: 10 },
]

export default {
  id: 'zongheng',
  name: '纵横中文网',
  home: HOME,
  lists: RANKS.map((r) => ({ listId: r.id, listName: r.name, gender: '男频', category: '全部', url: `${HOME}/rank?nav=${r.nav}${r.type ? `&rankType=${r.type}` : ''}` })),
  officialUrlOf: (book) => `${HOME}/detail/${book.bookId}`,

  async parse(html) {
    const books = []
    const re = /<div data-id="(\d+)" class="zh-modules-rank-book[^"]*"[\s\S]*?(?=<div data-id="\d+" class="zh-modules-rank-book|<\/section>)/g
    let m
    while ((m = re.exec(html))) {
      const bookId = m[1]
      const block = m[0]
      const titleM = block.match(/book-rank--title-text[^>]*>[\s\S]*?<a title="([^"]+)" href="\/\/www\.zongheng\.com\/detail\/\d+"/)
      const authorM = block.match(/rank-content-default__right-slot[\s\S]*?<a href="\/\/home\.zongheng\.com\/show\/userInfo\/\d+\.html"[^>]*>([^<]+)<\/a>/)
      const votesM = block.match(/rank-content-default--desc[^>]*>[\s\S]*?<em[^>]*>([\d,]+)<\/em>/)
      const coverM = block.match(/book-rankimg--cover[^>]*>[\s\S]*?<img src="([^"]+)"/)
      const title = strip(titleM ? titleM[1] : '')
      if (!title) continue
      books.push({
        rank: books.length + 1,
        title,
        author: strip(authorM ? authorM[1] : ''),
        cover: coverM ? coverM[1] : '',
        intro: '',
        category: '',
        officialUrl: `${HOME}/detail/${bookId}`,
        extra: { votes: votesM ? votesM[1] : '' },
      })
      if (books.length >= 20) break
    }
    return books
  },
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
