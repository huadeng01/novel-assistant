// 汇总导出全部平台 adapter（顺序 = 前端展示顺序，按平台主流程度/用户体量排序）。
// 每个 adapter 的 lists 已带 gender（男频/女频/全部），fetch-ranks 会把 gender/category 透传进 ranks.json。
import fanqie from './fanqie.mjs'
import qimao from './qimao.mjs'
import qqbook from './qqbook.mjs'
import jjwxc from './jjwxc.mjs'
import xxsy from './xxsy.mjs'
import zongheng from './zongheng.mjs'
import ciweimao from './ciweimao.mjs'
import tadu from './tadu.mjs'
import shuqi from './shuqi.mjs'
import k17 from './k17.mjs'

export const adapters = [
  fanqie,
  qimao,
  qqbook,
  jjwxc,
  xxsy,
  zongheng,
  ciweimao,
  tadu,
  shuqi,
  k17,
]

export default adapters
