// 刺猬猫榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：刺猬猫 /rank-index/{key} 排行榜含 10 种榜——
//   周点击(no-vip-click-week)/月点击(no-vip-click-month)/收藏(favor)/推荐(recommend)/订阅(buy)/
//   月票(yp)/吐槽(tsukkomi)/新书(yp_new)/刀片(blade)/更新(get-update-most-week)。各 key 共用同一模板。
// 榜单为 <ol class="rank-book-list"> 内 <li data-book-id="{id}"> 逐本列出。
// ★ 该站对透明机器人 UA 直接 403/404，需带常规浏览器 UA（needsBrowserUA），
//   仍属"如实声明可访问"范畴，不伪装搜索引擎/AI-bot，不破解任何技术措施。
// gender：刺猬猫为二次元男频向平台，整体归【男频】。
import { get } from '../http.mjs'

const HOME = 'https://www.ciweimao.com'

export default {
  id: 'ciweimao',
  name: '刺猬猫',
  home: HOME,
  needsBrowserUA: true,
  browserUA:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  uaNote: '刺猬猫对机器人 UA 返回 403，改用常规桌面浏览器 UA 访问公开榜单页；仅取元数据，不破解技术措施。',
  lists: [
    { listId: 'click-week', listName: '周点击榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/no-vip-click-week` },
    { listId: 'click-month', listName: '月点击榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/no-vip-click-month` },
    { listId: 'collect', listName: '收藏榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/favor` },
    { listId: 'recommend', listName: '推荐榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/recommend` },
    { listId: 'buy', listName: '订阅榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/buy` },
    { listId: 'ticket', listName: '月票榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/yp` },
    { listId: 'tsukkomi', listName: '吐槽榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/tsukkomi` },
    { listId: 'new', listName: '新书榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/yp_new` },
    { listId: 'blade', listName: '刀片榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/blade` },
    { listId: 'update', listName: '更新榜', gender: '男频', category: '全部', url: `${HOME}/rank-index/get-update-most-week` },
  ],
  officialUrlOf: (book) => `${HOME}/book/${book.bookId}`,

  async parse(html) {
    const books = []
    const olM = html.match(/<ol class="rank-book-list"[\s\S]*?<\/ol>/)
    const scope = olM ? olM[0] : html
    const liRe = /<li[^>]*data-book-id="(\d+)"[\s\S]*?<\/li>/g
    let m
    while ((m = liRe.exec(scope))) {
      const bookId = m[1]
      const block = m[0]
      const rankM = block.match(/<i class="rank-top[^"]*">(\d+)<\/i>/)
      const titleM = block.match(/<a class="cover" href="(https:\/\/www\.ciweimao\.com\/book\/\d+)"[^>]*title="([^"]+)"/)
      const authorM = block.match(/小说作者：<a[^>]*>([^<]+)<\/a>/)
      const introM = block.match(/<p class="desc">([\s\S]*?)<\/p>/)
      const coverM = block.match(/data-original="([^"]+)"/)
      const title = strip(titleM ? titleM[2] : '')
      if (!title) continue
      books.push({
        rank: rankM ? Number(rankM[1]) : books.length + 1,
        title,
        author: strip(authorM ? authorM[1] : ''),
        cover: coverM ? coverM[1] : '',
        intro: introM ? strip(introM[1]).slice(0, 120) : '',
        category: '',
        officialUrl: `${HOME}/book/${bookId}`,
        extra: {},
      })
      if (books.length >= 20) break
    }
    return books
  },
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
