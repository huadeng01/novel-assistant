// 17K小说网榜单 adapter
//
// ★ 禁用说明：17K /rank/ 有 WAF JS 挑战（返回验证脚本而非榜单 HTML），纯 HTTP 无法获取真实数据。
// 按合规护栏【不破解技术措施 / 不伪造数据】，此平台保持 disabled —— fetch-ranks 会直接输出
// ok:false 占位（error=waf-js-challenge），不发起请求、不编造书目。lists 仅留作结构备用。
import { get } from '../http.mjs'

const HOME = 'https://www.17k.com'

export default {
  id: 'k17',
  name: '17K小说网',
  home: HOME,
  disabled: true,
  disabledReason: 'waf-js-challenge',
  lists: [
    { listId: 'all', listName: '总榜', gender: '全部', category: '全部', url: `${HOME}/rank/` },
  ],
  officialUrlOf: (book) => `${HOME}/book/${book.bookId}.html`,

  async parse() {
    throw new Error('disabled: 17K /rank/ 存在 WAF JS 挑战，纯 HTTP 无法获取真实榜单，保持禁用不抓以避免伪造数据')
  },
}
