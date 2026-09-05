// 世界观库入口：内置题材世界模板（每题材一个文件，仅世界架构+力量体系，供灵感参考不定死世界）
// + 用户覆盖/自定义题材（localStorage），供灵感生成、新手写作「世界观确认」、长篇写作「世界观」页共用。
// 完整世界观（势力/冲突/底牌含登场时机）由用户选定灵感后在开书流程中由 AI 自动生成，存入书籍圣经，不在本库。
import 玄幻 from './玄幻.js'
import 仙侠 from './仙侠.js'
import 修真 from './修真.js'
import 都市 from './都市.js'
import 现实 from './现实.js'
import 科幻 from './科幻.js'
import 末世 from './末世.js'
import 奇幻 from './奇幻.js'
import 悬疑 from './悬疑.js'
import 推理 from './推理.js'
import 恐怖 from './恐怖.js'
import 言情 from './言情.js'
import 古代言情 from './古代言情.js'
import 历史 from './历史.js'
import 武侠 from './武侠.js'
import 军事 from './军事.js'
import 游戏 from './游戏.js'
import 无限流 from './无限流.js'
import 竞技 from './竞技.js'
import 轻小说 from './轻小说.js'

export const BUILTIN_WORLDVIEWS = { 玄幻, 仙侠, 修真, 都市, 现实, 科幻, 末世, 奇幻, 悬疑, 推理, 恐怖, 言情, 古代言情, 历史, 武侠, 军事, 游戏, 无限流, 竞技, 轻小说 }

const LS_KEY = 'na_worldview_overrides' // 用户修改/新增的题材世界模板（覆盖内置，不污染内置文件；旧版五字段数据只取 world/power，其余忽略）

export const EMPTY_WORLDVIEW = { world: '', power: '' }

function readLS() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeLS(o) {
  localStorage.setItem(LS_KEY, JSON.stringify(o))
}

// 全部题材 = 内置 20 个 + 用户自定义新增
export function allGenres() {
  const custom = Object.keys(readLS()).filter((g) => !BUILTIN_WORLDVIEWS[g])
  return [...Object.keys(BUILTIN_WORLDVIEWS), ...custom]
}

// 取某题材世界模板：用户覆盖优先，否则内置模板（只保留两字段，兼容旧数据）
export function getWorldview(genre) {
  const o = readLS()
  const wv = o[genre] || BUILTIN_WORLDVIEWS[genre] || null
  return wv ? { world: wv.world || '', power: wv.power || '' } : null
}

export function isOverridden(genre) {
  return !!readLS()[genre]
}

export function saveWorldview(genre, wv) {
  const o = readLS()
  o[genre] = wv
  writeLS(o)
}

export function resetWorldview(genre) {
  const o = readLS()
  delete o[genre]
  writeLS(o)
}

// 拼成提示词可用的世界模板文本（注入灵感生成等；定位是参考模板，不是定死的设定）
export function worldviewText(wv) {
  if (!wv) return '（暂无世界模板）'
  return [`世界架构：${wv.world || '（未填）'}`, `力量体系：${wv.power || '（未填）'}`].join('\n')
}
