// 塔读文学榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：塔读 /book/rank/list/{gender}-{rankType}-{category}-{wordcount}-{page}
//   ★ 首参 gender：0=男频、3=女频（站内导航「男频总榜单 readLike=0 / 女频总榜单 readLike=3」+ 男/女频两组链接确认，此前"语义不明"已澄清）。
//   rankType：hour72 人气榜(近72h) / potential 新书榜 / wholebook 完本榜 / votes 银票榜 / interactive 互动榜。
//   ★ 第3参 category 是【题材分类子榜】（男频页实测）：0全部/99东方玄幻/103现代都市/108历史架空/109武侠仙侠/
//     111科幻末世/128灵异悬疑/107西方奇幻/135脑洞创意/112游戏竞技/113军事战争。
//   女频(3)页未暴露题材分类ID，故女频只按 rankType 建总榜，不臆造分类。
// 每本以 <div class="booklist"> 分块，含 书名 span.bookname_name、排名 span.bookname_number(NO.x)、
// 作者/分类/字数/人气 混在 div.booknick（·分隔）。各 gender/category 共用同一模板。
import { get } from '../http.mjs'

const HOME = 'https://www.tadu.com'
const base = `${HOME}/book/rank/list`

// 男频(0) 人气榜的题材分类子榜（categoryId 来自男频页实测导航）
const BOY_CATS = [
  { cat: '全部', id: 0 },
  { cat: '东方玄幻', id: 99 },
  { cat: '现代都市', id: 103 },
  { cat: '历史架空', id: 108 },
  { cat: '武侠仙侠', id: 109 },
  { cat: '科幻末世', id: 111 },
  { cat: '灵异悬疑', id: 128 },
  { cat: '西方奇幻', id: 107 },
  { cat: '脑洞创意', id: 135 },
  { cat: '游戏竞技', id: 112 },
  { cat: '军事战争', id: 113 },
]
// 男频人气榜 × 题材分类
const boyPopular = BOY_CATS.map((c) => ({ listId: `boy-hour72-${c.id}`, listName: '人气榜', gender: '男频', category: c.cat, url: `${base}/0-hour72-${c.id}-0-1` }))
// 男频其它榜（全部题材）
const boyOther = [
  { listId: 'boy-potential', listName: '新书榜', gender: '男频', category: '全部', url: `${base}/0-potential-0-0-1` },
  { listId: 'boy-wholebook', listName: '完本榜', gender: '男频', category: '全部', url: `${base}/0-wholebook-0-0-1` },
  { listId: 'boy-votes', listName: '银票榜', gender: '男频', category: '全部', url: `${base}/0-votes-0-0-1` },
]
// 女频(3) 各榜（题材分类未暴露，只做总榜）
const girl = [
  { listId: 'girl-hour72', listName: '人气榜', gender: '女频', category: '全部', url: `${base}/3-hour72-0-0-1` },
  { listId: 'girl-potential', listName: '新书榜', gender: '女频', category: '全部', url: `${base}/3-potential-0-0-1` },
  { listId: 'girl-wholebook', listName: '完本榜', gender: '女频', category: '全部', url: `${base}/3-wholebook-0-0-1` },
  { listId: 'girl-votes', listName: '银票榜', gender: '女频', category: '全部', url: `${base}/3-votes-0-0-1` },
]

export default {
  id: 'tadu',
  name: '塔读文学',
  home: HOME,
  lists: [...boyPopular, ...boyOther, ...girl],
  officialUrlOf: (book) => `${HOME}/book/${book.bookId}`,

  async parse(html) {
    const books = []
    const re = /<div class="booklist">([\s\S]*?)(?=<div class="booklist">|<\/body>)/g
    let m
    while ((m = re.exec(html))) {
      const block = m[1]
      const idM = block.match(/href="\/book\/(\d+)"/)
      const nameM = block.match(/<span class="bookname_name">([^<]+)<\/span>/)
      const rankM = block.match(/<span class="bookname_number"[^>]*>NO\.(\d+)<\/span>/)
      const coverM = block.match(/data-src="([^"]+)"/)
      const nickM = block.match(/<div class="booknick">([^<]+)<\/div>/)
      const title = strip(nameM ? nameM[1] : '')
      if (!title) continue
      const nick = splitNick(nickM ? nickM[1] : '')
      const bookId = idM ? idM[1] : ''
      books.push({
        rank: rankM ? Number(rankM[1]) : books.length + 1,
        title,
        author: nick.author,
        cover: coverM ? coverM[1] : '',
        intro: '',
        category: nick.category,
        officialUrl: bookId ? `${HOME}/book/${bookId}` : '',
        extra: { wordCount: nick.words, heat: nick.heat },
      })
      if (books.length >= 20) break
    }
    return books
  },
}

// booknick 形如「作者·分类·字数·日人气」，按 · 拆分为字段（缺省容错）
function splitNick(raw) {
  const parts = strip(raw).split('·').map((s) => s.trim()).filter(Boolean)
  return {
    author: parts[0] || '',
    category: parts[1] || '',
    words: parts[2] || '',
    heat: parts[3] || '',
  }
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
