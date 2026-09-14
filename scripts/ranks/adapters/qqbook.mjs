// QQ阅读榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：QQ阅读排行榜分【男频 male-*】【女频 female-*】【出版 publish-*】三频道。
// 男/女频各含 5 榜：热门榜(sell) / 新书榜(new) / 免费榜(free) / 完结榜(finish) / 封神榜(god)；出版频道含 热门榜(sell)/新书榜(new)/新知榜(knowledge)。
// cycle-1 表示周期（上架30天内）。榜单页 SSR，每本以 <div class="book-large rank-book"> 分块，各榜共用同一模板。
// ★ 题材分类（同人/诸天/幻修…）指向 /book-cate/… 书库页（非榜单），故不做题材子榜。
// gender 标签：male→男频，female→女频，publish→全部（出版不分男女频）。
import { get } from '../http.mjs'

function listsFor(key, genderLabel) {
  const base = 'https://book.qq.com/book-rank'
  return [
    { listId: `${key}-sell`, listName: '热门榜', gender: genderLabel, category: '全部', url: `${base}/${key}-sell/cycle-1` },
    { listId: `${key}-new`, listName: '新书榜', gender: genderLabel, category: '全部', url: `${base}/${key}-new/cycle-1` },
    { listId: `${key}-free`, listName: '免费榜', gender: genderLabel, category: '全部', url: `${base}/${key}-free/cycle-1` },
    { listId: `${key}-finish`, listName: '完结榜', gender: genderLabel, category: '全部', url: `${base}/${key}-finish/cycle-1` },
    { listId: `${key}-god`, listName: '封神榜', gender: genderLabel, category: '全部', url: `${base}/${key}-god/cycle-1` },
  ]
}

// 出版频道（不分男女频，归「全部」）
function publishLists() {
  const base = 'https://book.qq.com/book-rank'
  return [
    { listId: 'publish-sell', listName: '出版热门榜', gender: '全部', category: '出版', url: `${base}/publish-sell/cycle-1` },
    { listId: 'publish-new', listName: '出版新书榜', gender: '全部', category: '出版', url: `${base}/publish-new/cycle-1` },
    { listId: 'publish-knowledge', listName: '出版新知榜', gender: '全部', category: '出版', url: `${base}/publish-knowledge/cycle-1` },
  ]
}

export default {
  id: 'qqbook',
  name: 'QQ阅读',
  home: 'https://book.qq.com',
  lists: [...listsFor('male', '男频'), ...listsFor('female', '女频'), ...publishLists()],
  officialUrlOf: (book) => `https://book.qq.com/book-detail/${book.bookId}`,

  async parse(html) {
    const books = []
    const re = /<div class="book-large rank-book"([\s\S]*?)(?=<div class="book-large rank-book|class="pagination|class="rank-cycle|<footer|<\/body>)/g
    let m
    let order = 0
    while ((m = re.exec(html))) {
      const block = m[1]
      order++
      const idM = block.match(/book-detail\/(\d+)/)
      const titleM = block.match(/<h4 class="title[^"]*"[^>]*>([^<]+)<\/h4>/)
      const authorM = block.match(/book-writer\/\d+"[^>]*>([^<]+)<\/a>/)
      const cateM = block.match(/book-cate\/[^"]*"[^>]*>([^<]+)<\/a>/)
      const statusM = block.match(/<p class="other"[\s\S]*?<span[^>]*>·([^<]+)<\/span>/)
      const introM = block.match(/<p class="intro"[^>]*>([\s\S]*?)<\/p>/)
      const title = titleM ? strip(titleM[1]) : ''
      if (!title) continue
      const bookId = idM ? idM[1] : ''
      books.push({
        rank: order,
        title,
        author: authorM ? strip(authorM[1]) : '',
        cover: '',
        intro: introM ? strip(introM[1]).slice(0, 120) : '',
        category: cateM ? strip(cateM[1]) : '',
        officialUrl: bookId ? `https://book.qq.com/book-detail/${bookId}` : '',
        extra: { status: statusM ? strip(statusM[1]) : '' },
      })
      if (books.length >= 20) break
    }
    return books
  },
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
