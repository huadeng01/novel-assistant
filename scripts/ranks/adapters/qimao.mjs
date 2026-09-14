// 七猫小说榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：七猫排行榜分【男频 /paihang/boy/*】与【女频 /paihang/girl/*】两大频道，
// 每个频道下含 6 个榜单：大热榜(hot/date) / 热度月榜(hot/month) / 新书榜(new) / 完结榜(over) / 收藏榜(collect) / 更新榜(update)。
// ★ 七猫 /paihang/ 只按「榜单类型 × 男女频」建榜；题材分类（都市/玄幻奇幻/历史…）指向 /shuku/a-{catId}-… 书库页（非榜单），故不做题材子榜（避免虚构榜单）。
// 榜单页为 SSR HTML，逐本以 <li class="rank-list-item"> 列出，直接正则抽取，无需字体解密。各榜单类型共用同一模板。
// gender 标签：boy→男频，girl→女频（供前端频道过滤）。
import { get } from '../http.mjs'

// 按频道生成 6 个真实榜单配置
function listsFor(key, genderLabel) {
  return [
    { listId: `${key}-hot-day`, listName: '大热榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/hot/date/` },
    { listId: `${key}-hot-month`, listName: '热度月榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/hot/month/` },
    { listId: `${key}-new`, listName: '新书榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/new/date/` },
    { listId: `${key}-over`, listName: '完结榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/over/date/` },
    { listId: `${key}-collect`, listName: '收藏榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/collect/date/` },
    { listId: `${key}-update`, listName: '更新榜', gender: genderLabel, category: '全部', url: `https://www.qimao.com/paihang/${key}/update/date/` },
  ]
}

export default {
  id: 'qimao',
  name: '七猫小说',
  home: 'https://www.qimao.com',
  lists: [...listsFor('boy', '男频'), ...listsFor('girl', '女频')],
  officialUrlOf: (book) => `https://www.qimao.com/shuku/${book.bookId}/`,

  async parse(html) {
    const books = []
    const liRe = /<li class="rank-list-item"[^>]*>[\s\S]*?<\/li>/g
    let m
    let order = 0
    while ((m = liRe.exec(html))) {
      const block = m[0]
      order++
      const idM = block.match(/href="https:\/\/www\.qimao\.com\/shuku\/(\d+)\//)
      const titleM = block.match(/class="s-book-title"[^>]*>([^<]+)<\/a>/)
      const coverM = block.match(/<img[^>]*src="([^"]+)"/)
      const rankM = block.match(/<span class="rank-number[^"]*"[^>]*>(\d+)/)
      const authorM = block.match(/<span class="s-book-info[\s\S]*?<a[^>]*>([^<]+)<\/a>/)
      const title = titleM ? strip(titleM[1]) : ''
      if (!title) continue
      const bookId = idM ? idM[1] : ''
      books.push({
        rank: rankM ? Number(rankM[1]) : order,
        title,
        author: authorM ? strip(authorM[1]) : '',
        cover: coverM ? coverM[1] : '',
        intro: '',
        category: '',
        officialUrl: bookId ? `https://www.qimao.com/shuku/${bookId}/` : '',
        extra: {},
      })
      if (books.length >= 20) break
    }
    return books
  },
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
}
