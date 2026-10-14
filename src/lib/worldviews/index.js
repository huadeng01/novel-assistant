// 暗箱流水线废弃处置 A：worldviews 原含 BUILTIN_WORLDVIEWS / 20 题材模板 / worldviewText /
// chapterParties / scenesForChapter / genreStyleOf / projectStyleOf 等，均只被废弃的
// longform/continuity/threads 消费，已删除；对 threads.js 的 import 一并切断。
// 因第 5.3 节 genre 增强要激活 genreSkinOf → benchmarkRefOf，此处拆分保留题材→基准书形态参照的
// 单一出处：GENRE_STYLE_TABLE + benchmarkRefOf。
//
// 🔴【文风层修复·任务A bug2：paraBandFor 已恢复】paraBandFor 曾在本处置里被连带删除且无人登记，
//   而它是「段长数字」的唯一出处（min = round(apl×2/3)、max = round(apl×4/3)）。删除后
//   presetStyles.js 注释与 profile/habits 里「每段字数带宽以写作端那条段长硬要求为准」成了悬空指代
//   （写作端再无数字可指）。现按方案 E 第①步把它连同 PARA_BAND_MIN_RATIO / PARA_BAND_MAX_RATIO
//   一并恢复到此文件（原出处），逐字对齐 novel-local worldviews/index.js 的实现（约 11 行纯算术）。
//   ✅ 已接线：LongFormPage 用 `paraBandFor(avgParaLenFor(book))` 渲染「每段写到约 N~M 字再断行」；
//     avgParaLenFor(见文件末)从题材档/绑定文风指纹推真实段长，未配时 paraBandFor 回落默认档 30。
//
// benchmark 字段 = 题材 → 基准书形态参照的单一出处（不在别处另设第二张表）。
// direct: true  = 这本基准书的题材就是本内置题材；缺省 = 仅「同族形态参照」。
// 无 benchmark 字段 = 六本语料里没有该题材形态的书，或族指向不唯一 → 诚实标为无参照，不硬贴。
const GENRE_STYLE_TABLE = {
  仙侠: { chapterWords: 10000, avgParaLen: 48, evidence: '章字数 p10·p50·p90 = 5296·9440·17166；段长 39.9·48.7·59.5', benchmark: { genreZh: '仙侠', direct: true } },
  历史: { chapterWords: 4300, avgParaLen: 30, evidence: '' },
  // 🔴【文风层收尾·prometheus 删除的连带处理】恐怖/悬疑/推理 原映射 benchmark.genreZh='蒸汽朋克怪谈'（= preset:prometheus《普罗之主》）。
  //   prometheus 整份档案已删除（合成范例替代逐字原文改造），「蒸汽朋克怪谈」这一 genreZh 在 PRESET_STYLES 里已无对应档案。
  //   故移除这 3 题材的 benchmark 字段 ⟹ benchmarkRefOf 返回 null ⟹ genreSkinOf matched=false ⟹ 回落到默认主导嗓音
  //   （skinScore 最高者 = preset:perfect 玄幻），与历史/都市/科幻等 8 个未映射题材同路；「实际回落到谁」的留痕由 genreSkinOf/resolveStyleRec 的 note 自动生成。
  //   evidence 里的怪谈形态实测数据保留（供章字数/段长参照，不依赖 benchmark）。
  恐怖: { chapterWords: 4300, avgParaLen: 30, evidence: '怪谈形态：章字数 3304·4295·7505；段长 23.5·28.4·34.0（原基准书 preset:prometheus 已删 → 回落默认主导嗓音）' },
  悬疑: { chapterWords: 4300, avgParaLen: 30, evidence: '同怪谈族（未单独实测）（原基准书 preset:prometheus 已删 → 回落默认主导嗓音）' },
  推理: { chapterWords: 3200, avgParaLen: 30, evidence: '（原基准书 preset:prometheus 已删 → 回落默认主导嗓音）' },
  玄幻: { chapterWords: 3200, avgParaLen: 38, evidence: '章字数 2890·3203·3862；段长 31.1·36.2·39.8', benchmark: { genreZh: '玄幻', direct: true } },
  修真: { chapterWords: 3200, avgParaLen: 38, evidence: '同玄幻族（未单独实测）', benchmark: { genreZh: '玄幻' } },
  奇幻: { chapterWords: 3200, avgParaLen: 38, evidence: '同玄幻族（未单独实测）', benchmark: { genreZh: '玄幻' } },
  武侠: { chapterWords: 3200, avgParaLen: 38, evidence: '同玄幻族（未单独实测）', benchmark: { genreZh: '玄幻' } },
  无限流: { chapterWords: 3200, avgParaLen: 30, evidence: '同题材唯一样本被判「不合格」（节选本，实解析 119 章）：章字数 2094·2332·3862 出自该失真样本，不得作实测依据。本档 3200 字 / 段长 30 沿用同族归档默认值（非实测）。', benchmark: { genreZh: '无限流', direct: true } },
  都市: { chapterWords: 3200, avgParaLen: 30, evidence: '' },
  现实: { chapterWords: 3200, avgParaLen: 30, evidence: '' },
  科幻: { chapterWords: 3200, avgParaLen: 30, evidence: '' },
  末世: { chapterWords: 3200, avgParaLen: 30, evidence: '' },
  军事: { chapterWords: 3200, avgParaLen: 30, evidence: '' },
  言情: { chapterWords: 2000, avgParaLen: 38, evidence: '女频形态：章字数 1670·1992·2186；段长 28.9·35.5·40.8', benchmark: { genreZh: '女频综影视/后宫' } },
  古代言情: { chapterWords: 2000, avgParaLen: 38, evidence: '同女频族（未单独实测）', benchmark: { genreZh: '女频综影视/后宫' } },
  轻小说: { chapterWords: 2000, avgParaLen: 30, evidence: '' },
  游戏: { chapterWords: 2000, avgParaLen: 38, evidence: '系统流形态：章字数 2069·2092·2137；段长 35.5·41.8·50.1', benchmark: { genreZh: '全民/系统流' } },
  竞技: { chapterWords: 2000, avgParaLen: 30, evidence: '' },
}

// 题材 → 基准书形态参照。认不出的题材（自定义 / null / 脏数据）返回 null，永不抛错。
// 只负责「映射」这一件事；参照书是否合格由语料档案 profiles.json 判定，不在这里复制一份。
export function benchmarkRefOf(genre) {
  const g = String(genre == null ? '' : genre).trim()
  const hit = Object.prototype.hasOwnProperty.call(GENRE_STYLE_TABLE, g) ? GENRE_STYLE_TABLE[g] : null
  if (!hit || !hit.benchmark || !hit.benchmark.genreZh) return null
  return { genre: g, genreZh: hit.benchmark.genreZh, direct: hit.benchmark.direct === true }
}

// ==================== 段长数字唯一出处（paraBandFor，任务A bug2 恢复）====================
// avgParaLen（本书/本题材的平均段长目标）→ 写作端喂给模型的段长带宽 { minPara, maxPara }。
// 系数与 novel-local worldviews/index.js 逐字一致：下沿 2/3、上沿 4/3（T-paraband-caliber 标定 v2）。
// 缺字段/非法值一律回退默认档 30（= novel-local DEFAULT_GENRE_STYLE.avgParaLen，也是 GENRE_STYLE_TABLE
//   里 8 个未映射题材共用的 avgParaLen），不抛错。这是全项目段长数字的唯一出处，别处不得再写第二个数。
export const PARA_BAND_MIN_RATIO = 2 / 3
export const PARA_BAND_MAX_RATIO = 4 / 3
export const PARA_BAND_DEFAULT_AVG_PARA_LEN = 30

export function paraBandFor(avgParaLen) {
  const n = Number(avgParaLen)
  const target = Number.isFinite(n) && n > 0 ? n : PARA_BAND_DEFAULT_AVG_PARA_LEN
  const minPara = Math.max(8, Math.round(target * PARA_BAND_MIN_RATIO))
  const maxPara = Math.max(minPara + 4, Math.round(target * PARA_BAND_MAX_RATIO))
  return { minPara, maxPara, target, defaulted: !(Number.isFinite(n) && n > 0) }
}

// B-H3：从 book 推导真实 avgParaLen（段长目标），供 LongFormPage 的 paraBandFor 消费（此前恒传 book.avgParaLen=undefined → 段长恒默认档）。
// 确定性推导、无写入点也能算，优先级：
//   ① book.avgParaLen 显式值（若将来建书/绑书时落了值）；
//   ② 绑定文风的蒸馏指纹 styleMetrics.paraMedian.mean —— 该书**真实**段长中位数（最准，兼容 styleMetrics 是 metrics 对象或整份 band 两种形状）；
//   ③ 题材默认档 GENRE_STYLE_TABLE[book.genre].avgParaLen；
//   ④ 都拿不到 → 返回 undefined，paraBandFor 自动回落默认档 30（不抛错）。
export function avgParaLenFor(book) {
  const b = book || {}
  const explicit = Number(b.avgParaLen)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const sm = b.styleMetrics || {}
  const metrics = sm.paraMedian ? sm : (sm.metrics || {})
  const pm = metrics.paraMedian
  const pmMean = pm && typeof pm === 'object' ? Number(pm.mean) : Number(pm)
  if (Number.isFinite(pmMean) && pmMean > 0) return Math.round(pmMean)
  const g = String(b.genre == null ? '' : b.genre).trim()
  if (g && Object.prototype.hasOwnProperty.call(GENRE_STYLE_TABLE, g)) {
    const gv = Number(GENRE_STYLE_TABLE[g].avgParaLen)
    if (Number.isFinite(gv) && gv > 0) return gv
  }
  return undefined
}
