// 世界观库入口：内置题材世界模板（每题材一个文件，八字段结构化，供灵感参考不定死世界）
// + 用户覆盖/自定义题材（localStorage），供灵感生成、新手写作「世界观确认」、长篇写作「世界观」页共用。
// 完整世界观（势力/冲突/底牌含登场时机）由用户选定灵感后在开书流程中由 AI 自动生成，存入书籍圣经，不在本库；
// 本库的 factions/geography 等字段只给「该题材通常长什么样」的类型学参考，不是某本书的具体设定。
// 注入分两档（见 worldviewText）：brief 给灵感选题（维持低权重参考定位、不膨胀），full 给圣经生成。
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

const LS_KEY = 'na_worldview_overrides' // 用户修改/新增的题材世界模板（覆盖内置，不污染内置文件；旧版数据缺字段按空串降级，见 getWorldview）

// 题材模板的八字段清单——本文件是 WorldviewEditor（渲染表单）与 worldviewText（拼装注入文本）的唯一事实源，
// 两处都从这里读，避免字段清单在 UI 与提示词之间漂移（漏字段会让某维度的设定永远进不了上下文）。
// min/max 是字数目标区间（按 20 个内置模板的实际字数分布校准，内置模板全部落在区间内）：
// 只用于编辑器提示与写作时的自我校准，不做硬校验、不阻断保存。
export const WORLDVIEW_FIELDS = [
  { key: 'world', label: '世界架构', min: 140, max: 240, rows: 4, placeholder: '世界构成、层级、舞台格局、驱动世界运转的核心稀缺物…（模板参考，非定死设定）' },
  { key: 'power', label: '力量体系', min: 150, max: 265, rows: 4, placeholder: '阶位/境界阶梯（逐级列名）、获取途径、突破门槛、天花板与代价…（公认框架，具体细节留给本书）' },
  { key: 'factions', label: '势力格局', min: 160, max: 230, rows: 4, placeholder: '该题材典型的 4~6 类势力与常见对立轴（给类型与立场逻辑，不给具体名字）' },
  { key: 'geography', label: '地理与舞台分层', min: 130, max: 210, rows: 3, placeholder: '开局之地 → 中期舞台 → 终局舞台的三级空间阶梯（供世界地图分层参考）' },
  { key: 'taboo', label: '禁忌与代价', min: 130, max: 205, rows: 3, placeholder: '世界硬规则、不可触碰的红线、能力的代价与反噬' },
  { key: 'tropes', label: '高频套路清单', min: 68, max: 125, rows: 3, placeholder: '该题材最容易撞车的 4~6 种开局/金手指/冲突，供灵感生成主动规避' },
  { key: 'antiTropes', label: '反套路切口', min: 125, max: 195, rows: 3, placeholder: '与高频套路对应的差异化方向，供灵感选题分头落点' },
  { key: 'motifs', label: '意象与专名词库', min: 60, max: 125, rows: 2, placeholder: '顿号分隔的标志性意象、器物、场所类型词（是词库不是句子）' },
]

export const EMPTY_WORLDVIEW = Object.fromEntries(WORLDVIEW_FIELDS.map((f) => [f.key, '']))

// 注入档位：brief = 世界架构 + 力量体系 + 意象词库（灵感选题用，约 400~620 字，维持「低权重参考」定位）；
// full = 八字段带小标题全拼（新手写作 Step1 圣经生成用，约 1100~1600 字，让 AI 有足够维度可对齐）。
const BRIEF_KEYS = ['world', 'power', 'motifs']

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

// 取某题材世界模板：用户覆盖优先，否则内置模板。
// 以 EMPTY_WORLDVIEW 打底再展开源数据：旧版 localStorage 只有 world/power 两字段，其余六字段自动降级为空串
// （编辑器显示为可补填的空框、拼装注入时按空跳过），不报错也不丢用户已存的内容。
export function getWorldview(genre) {
  const o = readLS()
  const src = o[genre] || BUILTIN_WORLDVIEWS[genre]
  if (!src) return null
  return { ...EMPTY_WORLDVIEW, ...src }
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
// level='brief'：只拼世界架构 + 力量体系 + 意象词库；level='full'：八字段带小标题全拼。
// 空字段整块跳过（不输出空标题），因此旧数据在 full 档下等同于旧的 brief 输出。
export function worldviewText(wv, level = 'brief') {
  if (!wv) return '（暂无世界模板）'
  const keys = level === 'full' ? WORLDVIEW_FIELDS.map((f) => f.key) : BRIEF_KEYS
  const labelOf = (k) => WORLDVIEW_FIELDS.find((f) => f.key === k)?.label || k
  const lines = keys.filter((k) => String(wv[k] || '').trim()).map((k) => `${labelOf(k)}：${String(wv[k]).trim()}`)
  return lines.length ? lines.join('\n') : '（暂无世界模板）'
}

// 套路对照块：只输出「高频套路清单 + 反套路切口」，供灵感生成把「反套路」从模型的自由发挥变成照单规避。
// 两字段都为空（旧数据/自定义题材未填）时返回空串，调用方据此降级回原有措辞。
export function worldviewTropeBlock(wv) {
  if (!wv) return ''
  const tropes = String(wv.tropes || '').trim()
  const anti = String(wv.antiTropes || '').trim()
  if (!tropes && !anti) return ''
  const parts = []
  if (tropes) parts.push(`【该题材高频套路（下列一个都不得出现，换皮改名也不行）】\n${tropes}`)
  if (anti) parts.push(`【可用的反套路切口（本批选题须分头落在这些方向上）】\n${anti}`)
  return parts.join('\n\n')
}
