// 晋江文学城榜单 adapter
//
// 站内结构（真实，2026-09-14 侦察确认）：晋江 topten.php?orderstr={N}&t=0 通过 orderstr 切换榜单口径，共 20 种榜。
//   ★ 修正：月榜=orderstr=5（原误用 10）；季榜=4、半年榜=6、总分榜=7、字数榜=8、长生殿=9、收入金榜=12、
//     霸王票总榜=13、霸王总榜=14、完结金榜=16、新手金榜=17、完结高分=20、完结全订榜=22、免费强推=1、vip强推=2。
//   均为站内【总榜】（题材分频走 /fenzhan/ 频道页，非 topten 榜单，故不做题材子榜）。
// 页面为 GBK 编码（http 层已自动解码），逐行以 <tr> 列出，各 orderstr 共用同一模板。
// gender：晋江文学城为女频向平台，站内总榜不再按男女频拆分，故整体归【女频】频道。
import { get } from '../http.mjs'

const HOME = 'https://www.jjwxc.net'

// 晋江真实榜单（orderstr 来自站内导航，2026-09-14 侦察确认；★月榜=5，原误用10已修正）
const RANKS = [
  { id: 'month', name: '月榜', order: 5 },
  { id: 'quarter', name: '季榜', order: 4 },
  { id: 'half-year', name: '半年榜', order: 6 },
  { id: 'total', name: '总分榜', order: 7 },
  { id: 'words', name: '字数榜', order: 8 },
  { id: 'changsheng', name: '长生殿', order: 9 },
  { id: 'income-gold', name: '收入金榜', order: 12 },
  { id: 'overlord-ticket', name: '霸王票总榜', order: 13 },
  { id: 'overlord', name: '霸王总榜', order: 14 },
  { id: 'finish-gold', name: '完结金榜', order: 16 },
  { id: 'newbie-gold', name: '新手金榜', order: 17 },
  { id: 'finish-high', name: '完结高分', order: 20 },
  { id: 'finish-fullsub', name: '完结全订榜', order: 22 },
  { id: 'free-rec', name: '免费强推', order: 1 },
  { id: 'vip-rec', name: 'vip强推', order: 2 },
]

export default {
  id: 'jjwxc',
  name: '晋江文学城',
  home: HOME,
  lists: RANKS.map((r) => ({ listId: r.id, listName: r.name, gender: '女频', category: '全部', url: `${HOME}/topten.php?orderstr=${r.order}&t=0` })),
  officialUrlOf: (book) => `${HOME}/onebook.php?novelid=${book.bookId}`,

  async parse(html) {
    const books = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
    let m
    while ((m = trRe.exec(html))) {
      const tr = m[1]
      const idM = tr.match(/onebook\.php\?novelid=(\d+)/)
      if (!idM) continue
      const titleM = tr.match(/href="onebook\.php\?novelid=\d+"[^>]*rel="([^"]*)"[^>]*class="tooltip">([^<]+)<\/a>/)
      const rankM = tr.match(/<td[^>]*>\s*(\d+)\s*<\/td>/)
      const authorM = tr.match(/oneauthor\.php\?authorid=\d+"[^>]*>([^<]+)<\/a>/)
      const typeM = tr.match(/(原创-[^<\s]+)/)
      const statusM = tr.match(/(完结|连载)/)
      const wordsM = tr.match(/align="right">\s*([\d,]+)\s*&nbsp;/)
      const bookId = idM[1]
      const title = unescapeHtml(titleM ? (titleM[2] || titleM[1]) : '')
      if (!title) continue
      books.push({
        rank: rankM ? Number(rankM[1]) : books.length + 1,
        title,
        author: authorM ? unescapeHtml(authorM[1]) : '',
        cover: '',
        intro: '',
        category: typeM ? typeM[1] : '',
        officialUrl: `${HOME}/onebook.php?novelid=${bookId}`,
        extra: {
          status: statusM ? statusM[1] : '',
          wordCount: wordsM ? `${wordsM[1].replace(/,/g, '')}字` : '',
        },
      })
      if (books.length >= 20) break
    }
    return books
  },
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}
