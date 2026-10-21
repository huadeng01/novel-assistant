// 资产库纯函数层（阶段0 新文件，零引用方也能独立跑）。
// 职责边界：本文件只做「规范化 + 判据 + 口语化注入」三件事，不碰 IndexedDB、不碰 React。
//   · 规范化：normalizeAsset / normalizeState —— 读入口与落库前统一走一遍，旧书 state:'alive' 不会白屏(设计 §4.1)。
//   · 判据：  isAssetWorthSaving / assetFieldCount —— 手动新增「全字段可空、全空不入库」(设计 §3 需求7)。
//   · 注入：  stateToPromptLine —— 结构化状态压成一句人话给 AI，绝不输出 JSON/字段名/tag 英文枚举(设计 §4.4 硬纪律)。
// 契约来源（只读参照，未修改这些文件）：
//   · parseAssets.js: revealChapterOf / rumorChapterOf / LINK_LABEL / buildLinks（英文存储 + 中文显示范式）
//   · LongFormPage.jsx: perVol = book.volOneChapters || Math.max(40, ...beats.chapter_no)
//   · parseAssets.js dash(): '—'/'-'/'无' 视同空（窄占位）；B26 起 EMPTY_TOKENS 宽占位表(含无主/未知，设计 §3 需求7)与 cleanText/dashOnly/dashOut/isBlankToken 均下沉 parseAssets.js 单一出处，本文件 import 复用、re-export dashOut
import { LINK_LABEL, revealChapterOf, rumorChapterOf, buildLinks, matchesName, findByName, findAssetByName, normName, isBlankToken, cleanText, dashOnly, dashOut } from './parseAssets.js'
import { uid } from './utils.js'

// 统一转出，组件只需 import 本文件一处，避免三处显示口径再分叉(设计 §3 需求4「单一真值」)
// 决策1+5：matchesName/findByName/findAssetByName 的**实现已下沉到 parseAssets.js**（名字归一与其 dash 同判据、严格匹配单一出处），此处 re-export 保持 A/C 的 `from '../lib/assets.js'` 不断。
// B26：dashOut 的实现也下沉到 parseAssets.js（与 cleanText/dashOnly/isBlankToken/EMPTY_TOKENS 同处）；dashOut 有外部消费方(LinkEditor/AssetGraphModal/AssetModal/LongFormPage)，故此处 re-export 保持 `from '../lib/assets.js'` 不断。
//   cleanText/dashOnly/isBlankToken 仅本文件内部使用（无外部消费方）→ 只 import 不 re-export（B28：收敛过度 export）。
export { LINK_LABEL, revealChapterOf, rumorChapterOf, buildLinks, matchesName, findByName, findAssetByName, dashOut }

// —— 资产类型（第一版 6 类 + 迭代类型 skill/beast 先留位；设计 §2.1）——
export const ASSET_TYPES = ['person', 'group', 'faction', 'place', 'item', 'skill', 'beast']
export const ASSET_TYPE_LABEL = {
  person: '人物',
  group: '群像',
  faction: '势力',
  place: '地点',
  item: '道具',
  skill: '功法',
  beast: '灵兽',
}
// 第一版真正参与筛选/表单的 5 类（skill/beast 只在有数据时才显示按钮，避免空类占位）
export const CORE_TYPES = ['person', 'group', 'faction', 'place', 'item']

// —— 分层 tier（设计 §8 拍板4：激活 tier，S/M/L 用于 UI 分层显示）——
// 历史值 'A'/'B' 来自 parseBookAssets / parseExpandAssets，已落库 → 保留不破坏，只在 UI 上归入「未分层」。
// item9(档3)：原 TIER_PRIORITY（token 紧张时的注入优先级裁剪表）已删——唯一消费方 sortByTier 上轮已删、全库零消费，注入优先级裁剪功能未落地。
export const TIER_LABEL = { S: '主角', M: '配角', L: '龙套', A: '旧档A', B: '旧档B' }
export const TIER_ORDER = ['S', 'M', 'L']

// —— 空值/清洗判据（B26：EMPTY_TOKENS / isBlankToken / cleanText / dashOnly / dashOut 已下沉 parseAssets.js 单一出处，本文件顶部 import 复用）——
//   dashOut 因有外部消费方已在顶部 re-export；cleanText/dashOnly/isBlankToken 仅本文件内部用（B28：不再从本文件 export）。
//   订正：cleanText 与 parseAssets.cleanName **不同判据**（cleanName 另剥行首【…】段头）；dashOut 与 normName 也不同（宽占位表 vs 窄 dash、是否折叠内部空白/「」）——详见 parseAssets.js 内注释。

// 逗号/顿号/斜杠分隔 → 数组（与 parseAssets.js splitList 同判据），并过滤空占位
export const splitListValue = (v) => {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map(dashOut).filter(Boolean) // L(尾批)：数组分支只吃字符串项——对象项经 dashOut→cleanText→String 会变 '[object Object]' 混进列表
  // item8：只吃字符串——0/false/null/对象等此前被 String() 成 '0'/'false'/'[object Object]' 混进列表（splitListValue(0) 返回 ['0']）
  if (typeof v !== 'string') return []
  return v
    .split(/[,，、/]/)
    .map(dashOut)
    .filter(Boolean)
}

const toInt = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
// 卷号合理区间 0–99，超出视为列漂移/误输 → 0（与 parseAssets.js safeVolume 同判据）
const safeVolume = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 99 ? Math.floor(n) : 0
}

// ============================================================================
// 状态体系（设计 §4.1）：state 从单字符串升级为 8 维度结构化对象
// ============================================================================

// 旧字符串 → v2 tag 映射（设计 §4.1 原文照抄；一律落进 plot 维度，原字符串保留在 legacy 不丢）
export const STATE_V1_MAP = {
  alive: 'active',
  dead: 'dead',
  destroyed: 'broken',
  broken: 'broken',
  hidden: 'hidden',
  promoted: 'promoted',
  活跃: 'active',
  死亡: 'dead',
  毁坏: 'broken',
  隐藏: 'hidden',
  升迁: 'promoted',
}

// 维度清单：core = 第一版默认展开的 5 维，extra = 折叠的 3 维（设计 §2.2 取舍）
export const STATE_DIMS_CORE = ['phys', 'power', 'place', 'hold', 'plot']
export const STATE_DIMS_EXTRA = ['mind', 'social', 'rel']
const STATE_DIMS = [...STATE_DIMS_CORE, ...STATE_DIMS_EXTRA] // B28：仅本文件内部用（stateLabel/stateHasContent），去 export
export const STATE_DIM_LABEL = {
  phys: '生理',
  power: '修为',
  place: '位置',
  hold: '持有',
  plot: '剧情',
  mind: '心理',
  social: '身份社会',
  rel: '关系',
}

// tag → 中文口语词（存储保持英文枚举，与 LINK_LABEL 同范式）。
// 词表按维度分组：同一个 'dead' 在生理与剧情里语义不同，不能共用一张平表。
export const STATE_LABEL = {
  phys: {
    healthy: '无恙',
    injured: '受伤',
    poisoned: '中毒',
    disabled: '残废',
    unconscious: '昏迷',
    dead: '死亡',
    revived: '复活',
    sick: '染病',
    // item12(档3)：lost 与 broken/disabled 区分——「丢失/遗失」是失其所在（可能找回），broken/disabled 是损毁不可再用。
    //   此前 phys 无 lost，C 区把 note 词「丢失」误归 broken ⟹ stateToPromptLine 输出「已损毁不可再用」，语义反了（丢失≠损毁）。
    lost: '丢失',
    // 尾批②：consumed（消耗，如丹药服尽）独立于 broken（损毁）——此前借 broken 会让「已消耗」显示成「已损毁，不可再用」，语义偏差。
    consumed: '已消耗',
    // L#6：phys 补 broken 键——此前 phys 无 broken，stateLabel('phys','broken') 跨维借 hold.broken='损坏'，致 person 的 phys.tag=broken 渲染「损坏」而 item 走前导渲染「已损毁，不可再用」，同 tag 两套人话。补键统一词根为「损毁」。
    broken: '损毁',
  },
  power: {
    realm: '境界',
    breaking_through: '突破中',
    seclusion: '闭关',
    exited: '出关',
    qi_deviation: '走火入魔',
    crippled: '功力被废',
    awakened: '觉醒',
    depleted: '灵力耗尽',
  },
  mind: {
    angry: '愤怒',
    afraid: '恐惧',
    despair: '绝望',
    resolve: '决意',
    corrupted: '心魔侵染',
    enlightened: '顿悟',
    grieving: '悲痛',
  },
  social: {
    rank: '身份地位',
    faction: '归属',
    promoted: '升迁',
    demoted: '贬黜',
    wanted: '被通缉',
    fugitive: '逃亡',
    hidden: '隐姓埋名',
    allied: '结盟',
    broken: '决裂',
    married: '婚配',
    reputation: '声望',
  },
  place: {
    at: '在某地',
    moving: '移动中',
    missing: '下落不明',
    imprisoned: '被囚',
    exiled: '流放',
    returned: '归来',
  },
  hold: {
    gain: '获得',
    lose: '失去',
    broken: '损坏',
    consumed: '消耗',
    transferred: '易主',
  },
  rel: {
    ally: '盟友',
    enemy: '敌对',
    master: '师徒(师)',
    disciple: '师徒(徒)',
    lover: '情缘',
    foe: '宿敌',
    reconciled: '和解',
    betrayed: '背叛',
  },
  // plot 除 §2.2 的叙事 tag 外，还要接住 STATE_V1_MAP 的迁移值(active/broken/hidden/promoted)，
  // 否则旧书 state:'毁坏' 迁到 plot.tag='broken' 后 UI 显示成英文枚举。
  plot: {
    debuted: '已登场',
    active: '活跃中',
    offstage: '已退场',
    dead: '死亡',
    returned: '回归',
    broken: '毁坏',
    hidden: '隐藏',
    promoted: '升迁',
    hook_planted: '埋下伏笔',
    hook_paid: '回收伏笔',
    secret_exposed: '秘密曝光',
  },
}

// 下拉选项：每维度前置一个「未设定」空值（全字段可空纪律，设计 §3 需求7）
export const stateOptions = (dim) => [{ value: '', label: '未设定' }, ...Object.entries(STATE_LABEL[dim] || {}).map(([value, label]) => ({ value, label }))]

// 单维度中文词；查不到时退回全局扫描（跨维度兜底，避免 UI 出现英文枚举），再退回原值
export function stateLabel(dim, tag) {
  const t = String(tag == null ? '' : tag).trim()
  if (!t) return ''
  if (STATE_LABEL[dim] && STATE_LABEL[dim][t]) return STATE_LABEL[dim][t]
  for (const d of STATE_DIMS) if (STATE_LABEL[d][t]) return STATE_LABEL[d][t]
  return t
}

const emptyState = () => ({
  v: 2,
  phys: null,
  power: null,
  mind: null,
  social: null,
  place: null,
  hold: [],
  rel: null,
  plot: null,
  meta: null,
  legacy: '',
})

// 单维度对象补全：{ tag, note, since, ref, firstCh, lastCh, to, ch }
const normDimObj = (o) => {
  if (o == null || typeof o !== 'object') return null
  const tag = cleanText(o.tag)
  const note = dashOnly(o.note)
  const ref = dashOut(o.ref)
  const to = dashOut(o.to)
  const since = toInt(o.since)
  const ch = toInt(o.ch)
  const firstCh = toInt(o.firstCh)
  const lastCh = toInt(o.lastCh)
  if (!tag && !note && !ref && !to && !since && !ch && !firstCh && !lastCh) return null
  const out = {}
  if (tag) out.tag = tag
  if (note) out.note = note
  if (ref) out.ref = ref
  if (to) out.to = to
  if (since) out.since = since
  if (ch) out.ch = ch
  if (firstCh) out.firstCh = firstCh
  if (lastCh) out.lastCh = lastCh
  // 🔴第三轮追加：保留 inferred（B#1 第三路给 place 打的「推定地名/动词短语」标记）——此前白名单漏了它，而 normalizeState 每次读/写库都过 normDimObj
  //   ⟹ inferred 首次落库/读库往返即被剥离 ⟹ placePhrase(if p.inferred)、rebuildDerivedEdges(!pl.inferred) 永远读不到，B#1 持久化后全失效（语病/垃圾边/假警告复活）。
  //   inferred 只是 ref 的修饰词、不单独构成「有内容」，故不动上面 null 判据（ref 在时 !ref 已保住该维度）。
  if (o.inferred) out.inferred = true
  return out
}

// 持有/关系是数组（保留历史，设计 §4.1 hold 为数组）
const normDimList = (v) => {
  if (v == null) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr
    .map((x) => {
      // H1：字符串项（如 hold:['青竹剑'] / rel:['李四']）此前误走 normDimObj({name:x})，而 normDimObj 不读 name 字段 ⟹ 恒返 null、整项被静默清空。
      //   字符串项就是「名字」，直接归一成 {name}。
      if (typeof x === 'string') { const n = dashOut(x); return n ? { name: n } : null }
      if (!x || typeof x !== 'object') return null
      const name = dashOut(x.name)
      const change = cleanText(x.change)
      const tag = cleanText(x.tag)
      const note = dashOnly(x.note)
      const to = dashOut(x.to)
      const ch = toInt(x.ch)
      if (!name && !change && !tag && !note && !to && !ch) return null
      const out = {}
      if (name) out.name = name
      if (change) out.change = change
      if (tag) out.tag = tag
      if (to) out.to = to
      if (note) out.note = note
      if (ch) out.ch = ch
      return out
    })
    .filter(Boolean)
}

// normalizeState：v1 字符串 / null / v2 对象 → 统一 v2 形状（缺 key 补全，不做批量迁移写库）
export function normalizeState(s) {
  const base = emptyState()
  if (s == null || s === '') return base
  if (typeof s === 'string') {
    const t = s.trim()
    if (!t) return base
    // 决策#7 缺口：映射得到才落 plot.tag；映射不到（旧书/手填「重伤」等）**不兜底 'active'**（否则 UI 显示「活跃中」误导），
    //   plot 留 null、原词只进 legacy（保留不丢，由用户在 UI 里显式选状态）。
    const mapped = STATE_V1_MAP[t] || STATE_V1_MAP[t.toLowerCase()]
    if (mapped) base.plot = { tag: mapped }
    base.legacy = t
    return base
  }
  if (typeof s !== 'object') return base
  if (s.v === 2 || s.phys || s.power || s.place || s.hold || s.plot || s.mind || s.social || s.rel) {
    base.phys = normDimObj(s.phys)
    base.power = normDimObj(s.power)
    base.mind = normDimObj(s.mind)
    base.social = normDimObj(s.social)
    base.place = normDimObj(s.place)
    base.hold = normDimList(s.hold)
    base.rel = normDimList(s.rel)
    base.plot = normDimObj(s.plot)
    base.legacy = cleanText(s.legacy)
    if (s.meta && typeof s.meta === 'object') {
      base.meta = {
        updatedAt: Number(s.meta.updatedAt) || 0,
        updatedBy: cleanText(s.meta.updatedBy) || 'user',
        sourceCh: toInt(s.meta.sourceCh),
      }
    }
    return base
  }
  // 未知形状：当旧字符串处理，原样留档，不抛错；决策#7 同口径——不兜底 plot.tag='active'（留 null，避免误显示「活跃中」）
  base.legacy = cleanText(JSON.stringify(s)).slice(0, 60)
  return base
}

// 状态是否「有内容」：normalizeState 会给空状态补 plot:null（不是 active），
// 只有用户/AI 真填过维度，或 plot 有非默认 tag / 首末章号，才算有内容。
// item13：legacy 里的「人话」状态词——v1 字符串状态（如旧书 state:'重伤'）经 normalizeState 迁移后，未映射的词只留在 legacy。
//   未知形状迁移留下的 legacy 是 JSON.stringify 的串（噪声），用「是否以 { 或 [ 开头」区分，只认人话词。
const humanLegacy = (st) => {
  const lg = String((st && st.legacy) || '').trim()
  if (!lg || /^[{[]/.test(lg)) return ''
  // lib-M1(档4)：legacy 若是 STATE_V1_MAP 映射为 plot.tag='active' 的默认词（活跃/alive）不算「人话状态内容」——
  //   parseAssets mk() 默认给 state:'活跃'，迁移后 legacy='活跃'+plot.tag='active'，此前被当内容 ⟹ 每个解析资产都注入「现况：活跃。」纯 token 噪声（地点/道具「活跃」无意义）。
  //   与 stateHasContent「plot.tag='active' 单独不算内容」同口径：active 是默认落点，不是用户真填的状态。
  if (STATE_V1_MAP[lg] === 'active' || STATE_V1_MAP[lg.toLowerCase()] === 'active') return ''
  return lg
}

// 这个判据直接决定需求7「全空不入库」是否成立——若把默认值算成内容，空表单也会被判为有内容。
export function stateHasContent(st) {
  if (!st || typeof st !== 'object') return false
  for (const d of ['phys', 'power', 'mind', 'social', 'place', 'plot']) {
    const o = st[d]
    if (!o || typeof o !== 'object') continue
    // plot.tag='active' 是 v1 迁移的默认落点，单独有它不算「用户填过」
    if (d === 'plot' && o.tag === 'active' && !o.firstCh && !o.lastCh && !o.note) continue
    return true
  }
  // 决策#2 副作用根治：空壳条目不算内容——rel 的信息主体是对象名(to)，无 to 的行零信息（StatePanel rel seed 默认 tag='ally'
  //   时，空壳若算内容会入库并注入垃圾「现况：盟友。」）；hold 同理要求 name 非空（无物品名的流转行零信息）。
  //   与 C 分工：C 保留 StatePanel 本地草稿的空行（修「+关系变更按钮发闷」），B 区这里保证持久化时空 to/name 的行不算内容、不入库。
  if (Array.isArray(st.hold) && st.hold.some((h) => h && (h.name || '').trim())) return true
  if (Array.isArray(st.rel) && st.rel.some((r) => r && ((r.to || r.name || '').trim() || dashOnly(r.note)))) return true // lib-M3+尾批L：rel 原词进 note、或字符串项归一的 name（无 to）也算内容，否则 AI 关系词 / rel:['李四'] 不注入；空壳 {tag,to:''} 无 note/name 仍排除
  // item13：各维度全空、但 legacy 有人话状态词（v1 旧书迁移来的）也算有内容，否则旧书状态会被判空、既不入库也不注入
  if (humanLegacy(st)) return true
  return false
}

// ============================================================================
// 状态结算落库用的纯函数（设计 §5，M11① 单一出处）
// 此前 TYPE_BY_LABEL / typeKeyOf / tagForWord / applyStateChange 在 LongFormPage.jsx 与 ContinuePage.jsx
// 各存一份逐字相同的副本（约 50 行），两份漂移会让两页状态结算行为分叉 ⟹ 抽到本文件单一出处，两页改为 import。
// ============================================================================

// 中文类型标签 → 类型 key（ASSET_TYPE_LABEL 的反向表）
const TYPE_BY_LABEL = Object.entries(ASSET_TYPE_LABEL).reduce((m, [k, v]) => ({ ...m, [v]: k }), {}) // B28：仅 typeKeyOf 内部用，去 export
// 决策#5：类型同义词归一表——AI 分析资产时常带出「门派/法宝/妖兽」等非标准类型词，靠词表兜底到 7 类 key，
//   而不是全回落 person。这是全项目唯一的「类型词→key」归一出处：parseAnalyze 的 newAssets.type 是原始词，
//   由各页 typeKeyOf(n.type) 消费（ContinuePage:894 等），不在 parseAssets 里另立第二份（parseAssets→assets 会成环）。
export const TYPE_SYNONYMS = {
  faction: ['门派', '宗门', '宗派', '组织', '帮派'],
  item: ['物品', '宝物', '法宝', '兵器', '丹药', '器物', '装备'],
  beast: ['妖兽', '灵兽', '坐骑', '契约兽', '神兽', '宠物'], // 「宠物」是 beast 的旧显示标签，统一为「灵兽」后降级为同义词兜底（老书/AI 仍可能写宠物）
  skill: ['技能', '神通', '招式', '法术'],
  person: ['角色', '主角', '配角', '龙套'],
  // item5：place 补中心语「山脉」、group 补「团/队」——中文复合词中心语在末尾，缺这些词时「灵兽山脉/主角团」的中心语无从命中
  place: ['场所', '区域', '场景', '地盘', '山脉'],
  group: ['团体', '群体', '团伙', '团', '队'],
}
export const typeKeyOf = (t) => {
  const raw = String(t || '').trim()
  if (!raw) return 'person'
  const low = raw.toLowerCase()
  if (ASSET_TYPES.includes(low)) return low // 英文 key（person/place/…）：toLowerCase 归一
  if (TYPE_BY_LABEL[raw]) return TYPE_BY_LABEL[raw] // 标准中文标签（人物/势力/地点/道具/群像/功法/灵兽）
  for (const [key, words] of Object.entries(TYPE_SYNONYMS)) if (words.includes(raw)) return key // 同义词精确
  // item5：同义词包含改为「最右命中优先、同位取最长」——中文复合词中心语在末尾：
  //   「主角团」中心是团→group（此前首个命中「主角」误判 person）、「灵兽山脉」中心是山脉→place（此前误判 beast）。
  //   coordinator 提的「最长匹配」不解决本例：主角(2)>团(1)、灵兽与山脉同为2，最长仍取到修饰语；故按中心语位置取最右。
  let best = null
  for (const [key, words] of Object.entries(TYPE_SYNONYMS)) {
    for (const w of words) {
      const idx = raw.lastIndexOf(w)
      if (idx === -1) continue
      if (!best || idx > best.idx || (idx === best.idx && w.length > best.len)) best = { key, idx, len: w.length }
    }
  }
  if (best) return best.key
  return 'person'
}
// item12(档3)：状态词同义归一——「遗失/失窃/被盗」与「丢失」同义，但 STATE_LABEL 一个 tag 只挂一个 label，靠这张表先并到 lost 的 label「丢失」再查。
const STATE_WORD_ALIAS = { 遗失: '丢失', 失窃: '丢失', 被盗: '丢失', 失踪: '下落不明', 失联: '下落不明' }
// AI 状态词(中文)→结构化 tag：STATE_LABEL 是 tag→中文，这里按维度反向查(先精确、再包含)，查不到留空(原话进 note 不丢)
const tagForWord = (dim, word) => { // B28：仅 applyStateChange 等内部用（LongFormPage/ContinuePage 已收敛不再单独 import），去 export
  const w0 = String(word || '').trim()
  if (!w0) return ''
  const w = STATE_WORD_ALIAS[w0] || w0 // item12：遗失/失窃/被盗 → 丢失，使其命中 phys.lost
  const table = STATE_LABEL[dim] || {}
  for (const [tag, label] of Object.entries(table)) if (label === w) return tag
  for (const [tag, label] of Object.entries(table)) if (w.includes(label) || label.includes(w)) return tag
  return ''
}
// 把一条【状态变更】{dimKey,state,note,since} 增量并入资产 state(v2)：只动该维度，其它维度与 id 原样保留(inkos 原则②增量更新不重建)。
// 系统只记录 AI 提取+用户勾选的结果，不判断对错(设计§5 红线)。
export const applyStateChange = (curState, sc, ch) => {
  const st = normalizeState(curState)
  const dim = sc && sc.dimKey
  if (!dim) return st
  const since = sc.since || ch || 0
  const word = String(sc.state || '').trim()
  const note = dashOnly(sc.note)
  const tag = tagForWord(dim, word)
  if (dim === 'place') {
    const old = normDimObj(st.place) || {}
    // M-E1+H1+B#1：扩位置动词前缀表（在/位于/到了/移至/身处 + 被囚于/被流放到/回到/被困于…）；ref 优先取剥掉前缀后的地点名。
    //   三路：①剥掉前缀(hasLoc)→确定地名 ref（tag=命中或 at，无 inferred，placePhrase 渲染「人在X」+ 建 located_in）；
    //         ②纯状态词(tag 命中且剥不掉，如失踪→missing)→ref=''（走 tag 文案「下落不明」）；
    //         ③🔴B#1 裸词/动词短语(tag 未命中且剥不掉，如「前往昆仑」「躲在柴房」，也含裸地名「青冥山」)→ref=词本身但打 inferred:true、tag **不强设 at**。
    //   inferred 的意义（一次治三症状）：placePhrase 不加「人在」(避免「人在前往昆仑」语病 + 假「已到达」)、rebuildDerivedEdges 不建 located_in(避免垃圾边)、computeAssetWarnings 不报假悬空。
    const stripped = dashOut(word.replace(/^(?:已|又|刚)?\s*(?:被囚于|被囚在|被囚|囚于|被流放到|流放至|流放到|流放|被关押于|被关在|关押于|关在|被困于|被困在|困于|困在|藏于|藏身于|藏身|隐匿于|回到了|回到|返回到|返回|来到|到了|移至|移往|迁至|迁往|身处|身處|驻于|驻在|居于|住在|落脚于|在|位于)/, ''))
    const hasLoc = !!stripped && stripped !== word
    const inferred = !hasLoc && !tag && !!dashOut(word) // 第三路：剥不掉前缀、tag 也未命中 ⟹ 推定（可能是地名，也可能是动词短语）
    const ref = hasLoc ? stripped : (tag ? '' : dashOut(word))
    // C1根①+M1：第三路推定 → tag 置空（**不继承 old.tag**，否则旧「被囚于天牢」imprisoned + 新裸词「前往昆仑」会拼成「被囚于前往昆仑」）、打 inferred；
    //   非推定（剥到确定地名 / 纯状态词 tag 命中）→ 显式清掉可能残留的旧 inferred（M1：只加不清会让二次位置更新「前往昆仑→在青冥山」后 inferred 残留、注入丢「人在」、located_in 不建）。
    // 必修1（第十一轮·node 坐实）：hasLoc（剥到确定地名）时 'at' 必须**优先于 old.tag**——原 `tag || old.tag || (hasLoc?'at':'')` 在「在X/到了X/回到X」这类
    //   tagForWord 不命中（STATE_LABEL.place 的 label 是「在某地」非「在」）却剥到确定地名时，会继承旧 tag：移动中→在青冥山 得 moving「正在赶路往青冥山」（已到达却写赶路）、
    //   失踪→在青冥山 得 missing「下落不明」（新地名被吞、AI 以为仍失踪）、被囚于天牢→在青冥山 得 imprisoned「被囚于青冥山」（假断言），且 tag≠at ⟹ located_in 边不建。
    //   改为 `tag || (hasLoc?'at':'') || old.tag || ''`：剥到确定地名即判「人在该地」；word=''（空状态词更新）时 hasLoc=false ⟹ 仍保留 old.tag（assets.test:82 的 state:'' 保留 imprisoned 不回归）。
    const nextTag = inferred ? '' : (tag || (hasLoc ? 'at' : '') || old.tag || '')
    const noteText = note // 只取 sc.note（裸词已进 ref，不再塞 note 致 placePhrase 丢渲染）
    const place = { ...old, ...(ref ? { ref } : {}), ...(noteText ? { note: noteText } : {}), ...(since ? { since } : {}) }
    if (nextTag) place.tag = nextTag; else delete place.tag
    // 审计轮6 修正(冲突1 方案b)：inferred 跟随「当前 ref 是不是推定短语」——
    //   ①本次第三路推定 → inferred:true；②本次剥到确定地名(hasLoc，ref 被替换) → 清除 inferred；
    //   ③本次纯状态词(tag 命中、ref='' 继承旧 ref) → **沿用旧 inferred**（旧 ref 未变、其推定性不变）。
    //   此前(第七轮)非推定即无条件 delete inferred，会让「前往昆仑(推定) → 失踪(纯状态词)」变成 {tag:missing,ref:前往昆仑,无inferred} ⟹ placePhrase 渲染「人在前往昆仑」语病 + 建垃圾 located_in + 假悬空警告（B#1 三症状复活）。
    if (inferred) place.inferred = true
    else if (hasLoc) delete place.inferred
    else if (old.inferred) place.inferred = true
    else delete place.inferred
    st.place = place
  } else if (dim === 'hold') {
    const arr = Array.isArray(st.hold) ? [...st.hold] : []
    // 决策#1：change 不再硬编码 'gain'（那会把「失去玄铁令」记成 gain=语义反转、显示成"手里有"）。
    //   持有变更本应走【资产流转】段（flows 已带正确 change，页面直接建 hold 条目）；万一仍收到 dim=hold 的状态变更：
    //   change 优先取调用方显式 sc.change，否则从状态词反查 tagForWord('hold',词)（失去→lose/消耗→consumed/损坏→broken/易主→transferred）；
    //   都判不出就不猜——change 留空、状态词原样进 note，由用户在 UI 选正确流转动作（人在环路，不静默反转语义）。
    const change = cleanText(sc.change) || tagForWord('hold', word)
    // item7：change 命中后从 name 剥掉该动词前缀（「失去玄铁令」→「玄铁令」），与 flows 的干净 asset 名一致、可去重，
    //   注入时也不会出现「失去玄铁令丢了」这种动词重复。
    const changeLabel = change ? STATE_LABEL.hold[change] || '' : ''
    let nm = dashOnly(word)
    if (changeLabel && nm.startsWith(changeLabel)) nm = nm.slice(changeLabel.length).trim()
    nm = nm || note
    const entry = { ...(nm ? { name: nm } : {}), ...(change ? { change } : {}), ...(since ? { ch: since } : {}) }
    // L(尾批)：change 命中也并入 sc.note（此前只 !change 时写 note ⟹ 用户/AI 给的持有变更说明在 change 命中时被丢；holdPhrase 按 change 出固定文案，note 仍要存供 UI）；判不出 change 时原词留痕、绝不猜 gain
    const holdNote = note || (change ? '' : word)
    if (holdNote) entry.note = holdNote
    arr.push(entry)
    st.hold = arr
  } else if (dim === 'rel') {
    const arr = Array.isArray(st.rel) ? [...st.rel] : []
    // lib-M3(档4)：整条状态词（如「与李四结盟」）此前写进 to（关系对象名）⟹ stateToPromptLine 拼「与{to}相关」得「与与李四结盟相关」语病。
    //   改为：tag 尽力命中（盟友/敌对…），原词进 note 不塞 to；stateToPromptLine rel 无 to 时直接渲染 note（「与李四结盟」通顺）。
    //   用户手选 rel（StatePanel 直接给 {tag, to:人名}）不走此分支，仍渲染「与{to}为{word}」——两种来源都通顺。
    const relNote = note || word
    arr.push({ ...(tag ? { tag } : {}), ...(relNote ? { note: relNote } : {}), ...(since ? { ch: since } : {}) })
    st.rel = arr
  } else {
    // phys/power/mind/social/plot：tag 命中就用 tag，说明进 note；tag 没命中则把原话塞 note(不丢)
    const noteText = note || (tag ? '' : word)
    // H3：字段级合并（normDimObj 保留已有 firstCh/lastCh/note 等），不整体替换 —— plot 改一次不应丢 firstCh/lastCh（「增量更新不重建」红线）
    st[dim] = { ...(normDimObj(st[dim]) || {}), ...(tag ? { tag } : {}), ...(noteText ? { note: noteText } : {}), ...(since ? { since } : {}) }
  }
  st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: since }
  return st
}

// ============================================================================
// 关系边（设计 §3 需求5/6：不新增枚举，改「按源类型分组可见」）
// ============================================================================

// 按源资产类型过滤可选关系类型（复用 parseAssets.js LINK_LABEL 已存在的 13 种，不新增枚举）
export const LINK_BY_TYPE = {
  person: ['located_in', 'belongs_to', 'holds', 'ally', 'enemy', 'kin', 'rival', 'related'],
  place: ['controlled_by', 'found_at', 'related'],
  faction: ['controls', 'belongs_to', 'leads', 'ally', 'enemy', 'related'],
  item: ['held_by', 'found_at', 'related'],
  group: ['belongs_to', 'related', 'leads'],
  skill: ['belongs_to', 'related'],
  beast: ['held_by', 'belongs_to', 'related'],
}
// 关系类型的「分组」中文名：用户看到的是「地点/势力/道具/人际」分组，而不是 13 个平铺枚举(设计 §3 需求6)
export const LINK_GROUP = {
  located_in: '地点',
  controlled_by: '地点',
  controls: '地点',
  found_at: '地点',
  belongs_to: '势力',
  leads: '势力',
  holds: '道具',
  held_by: '道具',
  ally: '人际',
  enemy: '人际',
  kin: '人际',
  rival: '人际',
  related: '其他',
}
export const LINK_GROUP_ORDER = ['地点', '势力', '道具', '人际', '其他']

// 某源类型可选的关系类型（未知类型退回全量，不阻断）
export function linkTypesFor(fromType) {
  const list = LINK_BY_TYPE[fromType]
  if (list && list.length) return list
  return Object.keys(LINK_LABEL)
}

// 按分组组织，供 <optgroup> 渲染：[{ group:'地点', items:[{value,label}] }]
export function linkGroupsFor(fromType) {
  const types = linkTypesFor(fromType)
  const map = new Map()
  types.forEach((t) => {
    const g = LINK_GROUP[t] || '其他'
    if (!map.has(g)) map.set(g, [])
    map.get(g).push({ value: t, label: LINK_LABEL[t] || t })
  })
  return LINK_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g) }))
}

// 关系类型 → 建议的目标资产类型（「顺便建档」时用，设计 §3 需求5）
export const LINK_TARGET_TYPE = {
  located_in: 'place',
  found_at: 'place',
  controlled_by: 'faction',
  controls: 'place',
  belongs_to: 'faction',
  leads: 'person',
  holds: 'item',
  held_by: 'person',
  ally: 'person',
  enemy: 'person',
  kin: 'person',
  rival: 'person',
  related: 'person',
}

// 单条边规范化：{ type, to, since_ch, status, note }（since_ch/status/note 为设计 §2.1 新增，可空）
function normLink(l) {
  if (!l || typeof l !== 'object') return null
  const to = dashOut(l.to)
  const type = cleanText(l.type)
  if (!to || !type) return null
  const out = { type, to }
  if (l.derived === true) out.derived = true // 派生边标记：rebuildDerivedEdges 据此区分「系统派生」与「用户手建」，必须过 normLink 存活
  const since = toInt(l.since_ch)
  if (since) out.since_ch = since
  const status = cleanText(l.status)
  if (status) out.status = status
  const note = dashOnly(l.note)
  if (note) out.note = note
  return out
}

// 悬空边判据（与 computeAssetWarnings 同判据：目标名不在名册即未建档）
// 决策5：改用下沉的 findAssetByName（认别名/《》/空格归一 + 严格相等），修此前只比 dashOut(a.name) 精确主名、别名边误报悬空的口径
export function isDangling(toName, assets) {
  if (!dashOut(toName)) return false
  return !findAssetByName(assets, toName)
}

// ============================================================================
// 派生边（held_by/located_in/controlled_by）：从 holder / state.place / controller 单向生成的镜像边，语义上「当前值」唯一。
// derived:true 标记区分「系统派生」与「用户在图谱手建」——一处同解两个相反的 bug：
//   · lib-M2：mergeAssetDraft 曾剔光全部这三类边（连手建的一起）⟹ 用户手加边一次合并即永久丢；
//   · LongFormPage-M3：saveEdit 曾不剥旧派生边 ⟹ 改 state.place A→B 后 located_in→A 与 →B 并存。
// 统一口径：strip 只删 derived:true 的、保留手建的（无标记），再按当前字段重算派生边（打 derived 标记）。纯变换、不改入参、幂等。
// 存量迁移已落地在 normalizeAsset（见下方「存量派生边迁移」注释）：本函数本身不改判据，仍只认 derived:true —— 直接调它的手工边一律保留。
// ============================================================================
const DERIVED_LINK_TYPES = ['held_by', 'located_in', 'controlled_by'] // B28：仅 rebuildDerivedEdges/normalizeAsset 内部用（ContinuePage 手写副本已删），去 export

// 按资产当前 holder/state.place/controller 重算派生边（每条 derived:true），保留所有手建边。
// controlled_by 的来源：controller 不落库（normalizeAsset 排除它），故优先级 opts.controller（本次显式传入，含清空=''）> a.controller > 现有 derived controlled_by 边的 to（沿用，避免 strip 后丢失）。
export function rebuildDerivedEdges(asset, opts = {}) {
  const a = asset && typeof asset === 'object' ? asset : {}
  const all = Array.isArray(a.links) ? a.links : []
  const links = all.filter((l) => l && l.derived !== true) // 手建边（无 derived 标记）原样保留
  const allowed = LINK_BY_TYPE[a.type] || []
  const push = (type, to, extra) => {
    // M-E4：派生边必须在该类型的 LINK_BY_TYPE 白名单内，否则图谱出现该类型下拉里根本不存在的边（如 item/beast 派生 located_in、person/item 派生 controlled_by）
    if (!allowed.includes(type)) return
    const n = dashOut(to)
    if (!n || links.some((x) => x.type === type && x.to === n)) return
    links.push({ type, to: n, derived: true, ...(extra || {}) })
  }
  const prevCtrl = (all.find((l) => l && l.derived === true && l.type === 'controlled_by') || {}).to
  push('controlled_by', 'controller' in opts ? opts.controller : (a.controller !== undefined ? a.controller : prevCtrl))
  // 尾批(A候选2)：beast 与 item 同派生 held_by——LINK_BY_TYPE.beast 含 held_by、stateToPromptLine 的损毁/丢失/消耗句均按 item||beast 同口径，
  //   此前只 item 派生 ⟹ 灵兽设持有者后 holder 字段存了但 held_by 边不生成=EditAssetModal 承诺「自动生成被持有边」落空(假成功)。
  if (a.type === 'item' || a.type === 'beast') push('held_by', a.holder)
  const pl = a.state && a.state.place
  // B#1：inferred 的 place（第三路推定的裸词/动词短语，如「前往昆仑」）不建 located_in，避免垃圾边 + computeAssetWarnings 报用户无法修的假悬空警告
  if (pl && pl.ref && !pl.inferred && (pl.tag === 'at' || !pl.tag)) push('located_in', pl.ref, { since_ch: pl.since || 0 })
  return { ...a, links }
}

// ============================================================================
// normalizeAsset：读入口 + 落库前统一走一遍（幂等，不改入参）
// ============================================================================

export function normalizeAsset(a, opts = {}) {
  const src = a && typeof a === 'object' ? a : {}
  const idPrefix = opts.idPrefix || 'mn'
  // item12：type 走 typeKeyOf 归一（单一出处自愈）——此前只认精确 ASSET_TYPES key、否则默认 person，
  //   调用方若漏掉 typeKeyOf（直接喂「地点」「门派」等中文/同义词）会静默错类成 person。typeKeyOf 已含标准标签+同义词+英文小写归一。
  const type = typeKeyOf(cleanText(src.type))
  const rawTier = cleanText(src.tier).toUpperCase()
  // tier 只认 S/M/L/A/B：person/group 缺省给 M（配角），其余类型保留历史值不硬塞分层
  const tier = TIER_LABEL[rawTier] ? rawTier : type === 'person' || type === 'group' ? 'M' : rawTier || ''

  const out = {
    id: cleanText(src.id) || `${idPrefix}_${uid()}`,
    type,
    name: cleanText(src.name),
    tier,
    detail: dashOnly(src.detail),
    // aliases 激活（设计 §8 拍板4）：名字匹配容错用，逗号分隔字符串与数组都吃
    aliases: splitListValue(src.aliases),
    knowers: splitListValue(src.knowers),
    ch_reveal: toInt(src.ch_reveal),
    ch_rumor: toInt(src.ch_rumor),
    reveal_volume: safeVolume(src.reveal_volume),
    rumor_volume: safeVolume(src.rumor_volume),
    holder: dashOut(src.holder),
    state: normalizeState(src.state),
    links: [],
    createdAt: Number(src.createdAt) || Date.now(),
    // M10：不再无条件重置为 Date.now()——normalizeAsset 是读入口（每次取 book 都跑），无条件刷新会让 updatedAt 恒等于「最近读取时刻」，
    //   备份导出时资产 updatedAt 失真为导出时刻。改为沿用原值、缺失才落当前时间（与上一行 createdAt 同口径）。
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
  // is_public：全项目只写不读的死字段。按拍板「标记可删但先不物理删」——原样带过去，等用户确认后再清理。
  if ('is_public' in src) out.is_public = src.is_public
  // 伏笔等非资产表的额外字段（plant_ch / payoff_hint / linked_assets…）不丢弃，原样保留
  Object.keys(src).forEach((k) => {
    if (!(k in out) && k !== 'controller' && k !== 'knowersStr' && k !== 'aliasesStr' && k !== 'stateDraft') out[k] = src[k]
  })

  // links：手建边（无 derived 标记）规范化保留；旧派生边（derived:true）strip 掉，交给 rebuildDerivedEdges 按当前字段重算。
  // —— 存量派生边迁移（用户拍板方案a：存量三类边当系统派生处理）——
  // 本功能上线前落库的 held_by/located_in/controlled_by 没有 derived 标记 ⟹ 读入时被当「手建」保留 ⟹
  //   用户改 holder/place 后旧边与新生成的派生边并存（图谱重复边）。这里把「与当前字段对得上」的无标记三类边
  //   认定为上一轮系统派生的存量数据，不当手建保留（rebuildDerivedEdges 会按同一字段原样重算并补上 derived:true，
  //   下次落库即自愈、边本身不丢）。
  // ⚠ 取舍（用户已接受）：用户真手建、且目标恰好等于当前 holder/place/controller 的这三类边也会被当派生，
  //   下次 holder/place 变动时被 strip 清掉——手建这三类边罕见，且被清掉的正是与派生边重复的那一条。
  // ⚠ 为什么只迁移「字段对得上」的、不把无标记三类边一律当派生：buildLinks 的名字共现边（person→place 的 located_in、
  //   item→person 的 held_by）与 parseRelations 的关系网步边都**没有**对应的 holder/state.place 字段，
  //   一律补标记会让它们在下次落库时被 strip 掉、图谱边静默消失（比重复边代价高，且关系网步是批量产这类边的常规入口）。
  const srcLinks = Array.isArray(src.links) ? src.links : []
  // controlled_by：controller 不落库（normalizeAsset 排除它），故优先级 src.controller（本次显式传入，含清空=''）
  //   > 已有 derived controlled_by 的 to > 已有**无标记** controlled_by 的 to（存量迁移：老数据的控制方只存在这条边里，
  //   不沿用就会在首次迁移时丢掉地点的控制方）。
  const prevCtrlMarked = (srcLinks.find((l) => l && l.derived === true && l.type === 'controlled_by') || {}).to
  const prevCtrlLegacy = (srcLinks.find((l) => l && l.derived !== true && l.type === 'controlled_by') || {}).to
  const ctrlValue = 'controller' in src ? src.controller : (prevCtrlMarked !== undefined ? prevCtrlMarked : prevCtrlLegacy)
  // 判据：这条无标记三类边是否就是「按当前字段本该派生出的那一条」（与 rebuildDerivedEdges 的生成条件逐条对齐）
  const isLegacyDerived = (nl) => {
    if (nl.type === 'controlled_by') return !!dashOut(ctrlValue) && dashOut(ctrlValue) === nl.to
    if (nl.type === 'held_by') return (out.type === 'item' || out.type === 'beast') && !!dashOut(out.holder) && dashOut(out.holder) === nl.to
    if (nl.type === 'located_in') {
      const pl = out.state && out.state.place
      // M2：inferred 的 place 不由 rebuildDerivedEdges 建 located_in，故其 ref 对应的无标记边是**用户手建**的、不能当存量派生边 strip（否则手建边被静默删、又无重建补偿）
      return !!(pl && pl.ref && !pl.inferred && (pl.tag === 'at' || !pl.tag) && dashOut(pl.ref) === nl.to)
    }
    return false
  }
  const manual = []
  const pushManual = (l) => {
    const nl = normLink(l)
    if (!nl || manual.some((x) => x.to === nl.to && x.type === nl.type)) return
    manual.push(nl)
  }
  srcLinks.forEach((l) => {
    if (!l || l.derived === true) return // 旧派生边：strip，按当前字段重算
    if (DERIVED_LINK_TYPES.includes(cleanText(l.type)) && isLegacyDerived({ type: cleanText(l.type), to: dashOut(l.to) })) return // 存量派生边：同样交给重算
    pushManual(l)
  })
  out.links = manual
  // 派生边（controlled_by/held_by/located_in）统一走 rebuildDerivedEdges 重算并打 derived 标记——单一出处，与 mergeAssetDraft/saveEditAsset/applyFlowToAsset 同口径。
  out.links = rebuildDerivedEdges(out, { controller: ctrlValue }).links
  return out
}

// ============================================================================
// 需求7 判据：全字段可空、全空不入库
// ============================================================================

// 参与「用户填过内容」计数的字段（设计 §3 需求7 明列 + aliases 因拍板4 激活而计入）
const COUNTED_FIELDS = ['name', 'detail', 'aliases', 'knowers', 'links', 'state', 'ch_reveal', 'ch_rumor', 'reveal_volume', 'rumor_volume', 'holder', 'controller'] // B28：仅 assetFieldCount 内部用，去 export
// 不计数：id（系统生成）、type/tier（有默认值，用户没选也算 person/M）、createdAt/updatedAt、is_public（死字段）

export function isFilled(v) {
  if (v == null) return false
  if (typeof v === 'number') return Number.isFinite(v) && v > 0
  if (typeof v === 'string') return !isBlankToken(v) && v.trim() !== ''
  if (Array.isArray(v)) return v.some(isFilled)
  if (typeof v === 'object') {
    // state 走专用判据（默认值不算内容）；其余对象看有没有非空子值
    // item9：state 对象未必带 v:2 标记（旧书 / 裸 {plot:{...}}）——含任一状态维度键也走 stateHasContent，
    //   否则 {plot:{tag:'active'}}（v1 迁移默认落点）会被 Object.values 递归判成有内容（active 是空状态默认值，不算填过）。
    if (('v' in v && v.v === 2) || STATE_DIMS.some((d) => d in v)) return stateHasContent(v)
    return Object.values(v).some(isFilled)
  }
  return Boolean(v)
}

export function assetFieldCount(draft) {
  if (!draft || typeof draft !== 'object') return 0
  return COUNTED_FIELDS.filter((k) => isFilled(draft[k])).length
}

export function isAssetWorthSaving(draft) {
  return assetFieldCount(draft) >= 1
}

// ============================================================================
// perVol：透出章/传闻章「按卷估算」的每卷章数（单一出处，设计 §3 需求4 第2步）
// ============================================================================

export function perVolOf(book) {
  if (!book) return 40
  // item7：volOneChapters 可能是字符串（表单/脏数据 '30'）——'30'>0 为真会原样返回字符串 '30'，下游按数字用会出错；Number 归一 + 取整
  const vol1 = Number(book.volOneChapters)
  if (Number.isFinite(vol1) && vol1 > 0) return Math.floor(vol1)
  const beats = Array.isArray(book.beats) ? book.beats : []
  // L(尾批)：不用 Math.max(40, ...spread)——beats 逾 ~12 万条时展开实参超调用栈上限抛 RangeError；改循环求最大章号
  let maxCh = 40
  for (const b of beats) { const n = Number(b && b.chapter_no) || 0; if (n > maxCh) maxCh = n }
  return maxCh
}

// 透出/传闻章的统一显示口径（设计 §3 需求4 第1步的 chapterFieldOf，阶段0 先落在新文件里，
// 等 B 对话把它挪进 parseAssets.js 时删这份即可 —— 组件只认这个返回形状）
export function chapterFieldOf(a, perVol = 40, kind = 'reveal') {
  const raw = kind === 'rumor' ? Number(a && a.ch_rumor) || 0 : Number(a && a.ch_reveal) || 0
  const derived = kind === 'rumor' ? rumorChapterOf(a, perVol) : revealChapterOf(a, perVol)
  return {
    value: raw > 0 ? raw : '', // 输入框绑定原始值：未指定就是空白，不再显示 0（清掉第三套口径）
    derived: derived || 0, // 按卷估算值（H5：每卷等章数的粗映射，必须明示是估算）
    explicit: raw > 0, // 是否已有精确章号
    volume: kind === 'rumor' ? Number(a && a.rumor_volume) || 0 : Number(a && a.reveal_volume) || 0,
  }
}

// 缺透出章：不参与防剧透检测的那批（设计 §3 需求4 第5步「⚠ 待补全」虚拟分类的判据）
export const isMissingReveal = (a, perVol = 40) => revealChapterOf(a, perVol) === 0

// ============================================================================
// stateToPromptLine：给 AI 的一句人话（设计 §4.4）
// 纪律：只输出有值维度；不出现 tag 英文枚举 / 字段名 / JSON；上限 60 字，超出砍说明保状态词。
// ============================================================================

const LIMIT = 60
// 句尾截断：砍到 n 字，去掉截断处残留的逗号，并砍掉被截半的括号补充（不留半个「（第999章起」），末尾补省略号
const cutTail = (s, n) => {
  let t = String(s == null ? '' : s).slice(0, Math.max(0, n))
  const i = t.lastIndexOf('（')
  if (i >= 0 && t.indexOf('）', i) < 0) t = t.slice(0, i)
  return t.replace(/[，、：]+$/, '') + '…'
}
// 硬上限兜底：任何组装结果超过 60 字一律截断（token 纪律，设计 §4.4）
const trim = (s) => {
  const t = String(s == null ? '' : s)
  return t.length > LIMIT ? cutTail(t.replace(/。$/, ''), LIMIT - 1) : t
}

// 持有变更的口语说法（拍板5：损毁道具用「标注」而非剔除，AI 才知道为什么主角不用它）
const holdPhrase = (h) => {
  const n = h.name || '某物'
  const ch = h.ch ? `第${h.ch}章` : ''
  switch (h.change) {
    case 'gain':
      return `手里有${n}`
    case 'consumed':
      return `${n}${ch ? `已在${ch}` : '已'}用掉`
    case 'broken':
      return `${n}已损毁不可再用`
    case 'lose':
      return `${n}${ch ? `在${ch}` : '已'}丢了`
    case 'transferred':
      return `${n}已易主`
    default:
      // item8：name 与 note 相同（判不出 change 时原词同时进了 name 和 note）只输出一次，避免「得到残图：得到残图」重复串
      return h.note && h.note !== n ? `${n}：${h.note}` : n
  }
}

const placePhrase = (p) => {
  const ref = p.ref || ''
  const note = dashOnly(p.note) // B#2：全分支无 ref 时用 note 替「某处」，让 AI 看见 parseAnalyze【状态变更】第4列写进 note 的地点
  const since = p.since ? `（第${p.since}章起）` : ''
  // item4（第十轮）：inferred（第三路推定短语，如「前往昆仑」）+ **实质状态 tag**（missing/imprisoned/exiled/returned）时并列渲染。
  //   round-8「纯状态词沿用旧 inferred」(本文件 :435) 会让「前往昆仑(inferred) → 失踪(纯状态词)」得 {tag:'missing',ref:'前往昆仑',inferred:true}，
  //   下面 `if(p.inferred) return ref` 早返回只吐「前往昆仑」、**吞掉「下落不明」**→ AI 读到假「已到达」（B#1 想消除的语义换个形态复活，node 复现坐实）。
  //   但也不能把 inferred ref 塞进 tag 短语（会复活「被囚于前往昆仑」语病，C1根②/L1 所治）→ 状态词 +「此前疑似：<推定短语>」并列，既不语病也不丢状态词。
  //   仅 missing/imprisoned/exiled/returned 这四个「纯状态、不含确定地名」的 tag 走此路；at/moving 等仍走下面纯 inferred 分支（渲染原词，行为不变）。
  const INFERRED_AWARE_TAG = { missing: '下落不明', imprisoned: '被囚', exiled: '被流放', returned: '已归来' }
  if (p.inferred && INFERRED_AWARE_TAG[p.tag]) {
    const ctx = ref || note
    return `${INFERRED_AWARE_TAG[p.tag]}${ctx ? `（此前疑似：${ctx}）` : ''}${since}`
  }
  // C1根②/L1：inferred（第三路推定的裸词/动词短语）在**任何 tag 分支之前**直接渲染原词、不加位置断言前缀——
  //   否则旧 tag 残留时会拼出「被囚于前往昆仑」(imprisoned)、「正在赶路往前往昆仑」(moving) 等语病。
  if (p.inferred) return `${ref || note}${since}`
  switch (p.tag) {
    case 'moving':
      return `正在赶路${ref ? `往${ref}` : (note ? `往${note}` : '')}`
    case 'missing':
      return '下落不明'
    case 'imprisoned':
      return `被囚于${ref || note || '某处'}${since}`
    case 'exiled':
      return `被流放到${ref || note || '某处'}${since}`
    case 'returned':
      return `已回到${ref || note || '原处'}${since}`
    case 'at':
    default:
      // H1+B#2：无 ref 但有 note（AI 只给位置说明、无标准状态词）时兜底渲染 note，不再注入空串丢地点信息
      return ref ? `人在${ref}${since}` : (note ? `${note}${since}` : '')
  }
}

// 组装一段；withNote=false 时砍掉自由文本说明，只留状态词（超长降级用）；skipPhys=true 跳过 phys 维度（决策4：phys 已被 stateToPromptLine 损毁/丢失/消耗前导短语表达，避免重复）
function stateParts(st, withNote, skipPhys) {
  const parts = []
  const note = (o) => (withNote ? dashOnly(o && o.note) : '')

  const power = st.power
  if (power) {
    const n = note(power)
    // tag='realm' 的信息量全在说明里（境界名），说明被砍掉时整段不输出，避免「修为未记境界名」这种废话占 token
    if (power.tag === 'realm') {
      if (n) parts.push(n)
    } else if (power.tag) parts.push(n ? `${stateLabel('power', power.tag)}（${n}）` : stateLabel('power', power.tag))
    else if (n) parts.push(n)
  }

  const phys = st.phys
  if (phys && !skipPhys) {
    const n = note(phys)
    const word = phys.tag ? stateLabel('phys', phys.tag) : ''
    // 说明里通常已含语义（「左臂中毒未解」），有说明就用说明，避免「受伤，左臂中毒未解」这种重复
    parts.push(n || word)
  }

  const mind = st.mind
  if (mind) {
    const n = note(mind)
    const word = mind.tag ? stateLabel('mind', mind.tag) : ''
    parts.push(word && n && word !== n ? `${word}（${n}）` : n || word)
  }

  const social = st.social
  if (social) {
    const n = note(social)
    const word = social.tag ? stateLabel('social', social.tag) : ''
    parts.push(word && n && word !== n ? `${word}：${n}` : n || word)
  }

  if (st.place) {
    const p = placePhrase(st.place)
    if (p) parts.push(p)
  }

  const hold = Array.isArray(st.hold) ? st.hold : []
  if (hold.length) {
    // token 控制：只说最近 3 条流转（后发生的更重要）
    hold
      .slice(-3)
      .map(holdPhrase)
      .filter(Boolean)
      .forEach((s) => parts.push(s))
  }

  // 决策#2：关系(rel)此前只存不注入=半成品，补进现况行（如「与李四为盟友」）。token 控制：只说最近 3 条。
  const rel = Array.isArray(st.rel) ? st.rel : []
  if (rel.length) {
    rel
      .slice(-3)
      .map((r) => {
        const word = r.tag ? stateLabel('rel', r.tag) : ''
        const to = dashOnly(r.to) || dashOnly(r.name) // L(尾批)：rel 字符串项经 normDimList 归一成 {name}（对象名），无 to 时认 name，否则 {name:'李四'} 既不注入也不算内容=半成品
        const n = note(r)
        let s = to && word ? `与${to}为${word}` : to ? `与${to}相关` : word
        if (n && s && !s.includes(n)) s = `${s}（${n}）`
        else if (n && !s) s = n
        return s
      })
      .filter(Boolean)
      .forEach((s) => parts.push(s))
  }

  const plot = st.plot
  if (plot && plot.tag && plot.tag !== 'active') {
    if (plot.tag === 'offstage') parts.push(plot.lastCh ? `已退场（末次出场第${plot.lastCh}章）` : '已退场')
    else if (plot.tag === 'debuted') parts.push(plot.firstCh ? `第${plot.firstCh}章登场` : '已登场')
    else parts.push(stateLabel('plot', plot.tag))
  }

  return parts.filter(Boolean)
}

// 决策4 前导短语（道具/灵兽的损毁/丢失/消耗，排最前）；withNote=false 时砍掉 phys.note（超长降级①用，与 stateParts 同口径）。
// M3：抽成 helper 让降级① 能按 withNote=false **重算 lead**——此前 lead 是带 note 的旧串、降级① 只重算 stateParts ⟹ 前导路径降级① 恒 no-op、直落降级② cutTail 把 lead 之后的位置/关系整段砍掉。
const leadOf = (a, st, withNote) => {
  const physTag = st.phys && st.phys.tag
  if (a.type !== 'item' && a.type !== 'beast') return { lead: '', skipPhys: false }
  const n = withNote ? dashOnly(st.phys.note) : ''
  if (physTag === 'broken' || physTag === 'disabled') return { lead: `已损毁，不可再用${n ? `（${n}）` : ''}`, skipPhys: true }
  if (physTag === 'lost') return { lead: `已丢失${n ? `（${n}）` : ''}`, skipPhys: true }
  if (physTag === 'consumed') return { lead: `已消耗，不可再用${n ? `（${n}）` : ''}`, skipPhys: true }
  return { lead: '', skipPhys: false }
}

export function stateToPromptLine(a, opts = {}) {
  const st = a && typeof a === 'object' ? (a.state && a.state.v === 2 ? a.state : normalizeState(a && a.state)) : null
  if (!st || !stateHasContent(st)) return ''
  const prefix = opts.prefix == null ? '现况：' : opts.prefix

  // 决策4：道具/灵兽的损毁/丢失/消耗短语**排最前**、不 early-return，其余维度(place/hold/rel/plot…)照常走 stateParts 注入（phys 已由前导表达 ⟹ skipPhys 避免重复）。
  const { lead, skipPhys } = leadOf(a, st, true)
  let parts = stateParts(st, true, skipPhys)
  if (lead) parts = [lead, ...parts]
  if (!parts.length) {
    // item13：各维度都渲染不出内容、但 legacy 有人话状态词（v1 旧书 state:'重伤' 迁移来的）→ 注入它，
    //   否则旧书状态 AI 完全看不到（此前 legacy 只存不注入=半成品）。未知形状迁移的 JSON 串 legacy 已被 humanLegacy 滤掉。
    const lg = humanLegacy(st)
    if (!lg) return ''
    parts = [lg]
  }
  let body = parts.join('，')
  if (body.length > LIMIT - prefix.length - 1) {
    // 超长降级①：砍自由文本说明只留状态词——M3：lead 也按 withNote=false **重算**（此前复用带 note 旧串 ⟹ 前导路径降级① 恒 no-op、直落 cutTail 把 lead 之后的位置/关系整段砍掉）
    const withNoteBody = body // M-E2：留存降级前（带 note）的正文
    const dg = leadOf(a, st, false)
    parts = stateParts(st, false, dg.skipPhys).filter(Boolean)
    if (dg.lead) parts = [dg.lead, ...parts]
    body = parts.join('，')
    // M-E2：砍 note 后整条空了（该资产只有 note、无状态词）→ 退回带 note 的原文交给下面截断，
    //   此前直接落 `if(!body) return ''` ⟹ stateHasContent 为真却注入空串，AI 完全看不到该资产状态。
    if (!body) body = withNoteBody
  }
  if (!body) return ''
  // 超长降级②：从句尾截断（保留靠前的核心状态），补省略号
  if (body.length > LIMIT - prefix.length - 1) body = cutTail(body, LIMIT - prefix.length - 2)
  return trim(`${prefix}${body}。`)
}

// 资产卡上给人看的现况行（与 stateToPromptLine 同源文本，设计 §6.1）
export const stateToCardLine = (a) => stateToPromptLine(a, { prefix: '' })

// matchesName 已下沉到 parseAssets.js（决策1+5：严格匹配单一出处、去掉双向 includes 松匹配），本文件顶部 re-export。

// 分类计数（AssetFilterBar 用）：含 'all' 与 'missing'（缺透出章的虚拟分类）
export function countByType(assets, perVol = 40) {
  const list = assets || []
  const c = { all: list.length, missing: 0 }
  ASSET_TYPES.forEach((t) => (c[t] = 0))
  list.forEach((a) => {
    if (!a) return // item6：数组里的 null/undefined 项此前 a.type 直接抛 TypeError（countByType([null]) 崩）
    if (c[a.type] == null) c[a.type] = 0
    c[a.type] += 1
    if (isMissingReveal(a, perVol)) c.missing += 1
  })
  return c
}

// 按 AssetFilterBar 的选中值过滤（'all' / 类型 / 'missing' 虚拟分类）
export function filterAssets(assets, filter = 'all', perVol = 40) {
  const list = assets || []
  if (!filter || filter === 'all') return list
  if (filter === 'missing') return list.filter((a) => isMissingReveal(a, perVol))
  return list.filter((a) => a && a.type === filter)
}

// ============================================================================
// 重名处理（设计 §3 需求7 第3点）：不自动合并、不静默丢弃，给用户「合并 / 仍新增」两个按钮。
// findByName / findAssetByName 已下沉到 parseAssets.js（决策1+5：严格匹配单一出处），本文件顶部 re-export。
// ============================================================================

// 同书重名组（L17 producer，C 区消费做 UI 拦截/警告）：按归一名分组，返回同名多于一个的组 [{ name, ids:[...] }]；名全唯一时返回 []。空名跳过（不算重名）。
//   L#3：归一改用 parseAssets.normName（与 findAssetByName 同一口径）——此前用 dashOut，二者对内部空白/「」/行首【】处理不同，
//   会致「陆 沉」与「陆沉」结算时 findAssetByName 恒命中靠前那条、这里却不报重名（口径分裂、用户看不到重名警告）。
export function duplicateNameGroups(assets) {
  const map = new Map()
  for (const a of Array.isArray(assets) ? assets : []) {
    if (!a) continue
    const n = normName(a.name)
    if (!n) continue
    if (!map.has(n)) map.set(n, [])
    map.get(n).push(a.id)
  }
  const groups = []
  for (const [name, ids] of map) if (ids.length > 1) groups.push({ name, ids })
  return groups
}

// 把表单草稿合并进已有资产：草稿里「用户填过的字段」覆盖旧值，detail 用 ｜ 追加（与 applyUpdates 同范式，不吞旧内容），
// links 去重合并，state 按维度合并（草稿有值的维度覆盖，旧维度不清空 —— inkos 原则②：增量更新而非重建）。
export function mergeAssetDraft(existing, draft, opts = {}) {
  const base = normalizeAsset(existing, opts)
  const add = normalizeAsset(draft, { ...opts, idPrefix: opts.idPrefix || 'mn' })
  const keepId = base.id // 合并保留已有 id，不新建（否则 links 里指向它的引用全断）
  const merged = { ...base, id: keepId, updatedAt: Date.now() }
  ;['name', 'holder', 'ch_reveal', 'ch_rumor', 'reveal_volume', 'rumor_volume'].forEach((k) => {
    if (isFilled(add[k])) merged[k] = add[k]
  })
  // H2：type/tier 不能判归一后的 add —— normalizeAsset 恒给默认 type='person'/tier='M'，isFilled(add.type) 恒真 ⟹ 无条件把已有资产覆盖成默认
  //   （「青云山」地点会变 person、主角 tier S 降 M）。改判 draft 的**原始**字段：用户显式填了才覆盖，否则保留已有值。
  if (draft && isFilled(draft.type)) merged.type = add.type
  if (draft && isFilled(draft.tier)) merged.tier = add.tier
  // detail：两边都有且不同 → 追加（判重，避免反复合并把同一句堆多遍，与 applyUpdates 的 L-2 判重同思路）
  if (isFilled(add.detail)) {
    const b = String(base.detail || '')
    merged.detail = b && !b.includes(add.detail) ? `${b}｜${add.detail}` : b || add.detail
  }
  ;['aliases', 'knowers'].forEach((k) => {
    const s = new Set([...(base[k] || []), ...(add[k] || [])])
    merged[k] = [...s]
  })
  const links = [...(base.links || [])]
  ;(add.links || []).forEach((l) => {
    if (!links.some((x) => x.to === l.to && x.type === l.type)) links.push(l)
  })
  merged.links = links
  // state：维度级增量合并
  const st = normalizeState(base.state)
  const ns = normalizeState(add.state)
  if (stateHasContent(ns)) {
    ;['phys', 'power', 'mind', 'social', 'place', 'plot'].forEach((d) => {
      if (ns[d]) st[d] = ns[d]
    })
    if (Array.isArray(ns.hold) && ns.hold.length) {
      const hold = [...(Array.isArray(st.hold) ? st.hold : [])]
      ns.hold.forEach((h) => {
        // 必修2（第十一轮·同型 item17）：去重键纳入 note——hold 是「持有变更事件」，同 name+change+ch 但不同 note（如「失去玄铁令·被夺走」vs「失去玄铁令·典当于当铺」）
        //   是两条不同事件，原键 name+change+ch 会让第二条静默丢。与 rel(:1055) 同口径；加 note 只多保留、不误删，对完全相同项仍幂等。
        if (!hold.some((x) => x.name === h.name && x.change === h.change && x.ch === h.ch && x.note === h.note)) hold.push(h)
      })
      st.hold = hold
    }
    if (Array.isArray(ns.rel) && ns.rel.length) {
      const rel = [...(Array.isArray(st.rel) ? st.rel : [])]
      ns.rel.forEach((r) => {
        // item17：去重键纳入 note——applyStateChange 产的 rel 是 {tag,note,ch}、to=undefined，
        //   原键 to+tag+ch 会让「同章同 tag 不同 note」的第二条静默丢（to/tag/ch 全等）。加 note 后只多保留、不误删，且对完全相同项仍幂等。
        if (!rel.some((x) => x.to === r.to && x.tag === r.tag && x.ch === r.ch && x.note === r.note)) rel.push(r)
      })
      st.rel = rel
    }
    st.legacy = st.legacy || ns.legacy || ''
    st.meta = ns.meta || st.meta
    merged.state = st
  }
  // 派生边（item3/4 + 档4 lib-M2）：统一走 rebuildDerivedEdges——只 strip derived:true 的旧派生边、保留用户手建边（修 lib-M2：此前 filter 剔光全部三类边连手建的一起丢），
  //   再按 merged 的最终 type/holder/state.place 重算（修 item4/LongFormPage-M3：place 旧地→新地后 located_in 单条不堆积）。
  //   controlled_by：draft 显式带 controller 键（含清空 ''）则用之，否则 rebuildDerivedEdges 从 merged.links 现有派生 controlled_by 沿用。
  merged.links = rebuildDerivedEdges(merged, draft && 'controller' in draft ? { controller: draft.controller } : {}).links
  return merged
}

// ============================================================================
// 档4 共享层：编辑保存 + 结算落库的纯变换（LongFormPage / ContinuePage 共用，消除两页并行实现漂移）
// 全部纯函数、不含 put/setBooks——两页各自的写路径（LongFormPage.mutateBook / ContinuePage.useAssets.updateAsset）自行持久化。
// ============================================================================

// phys 维度字段级合并（保 firstCh/lastCh/既有字段），只覆盖传入的 tag/note/since——与 applyStateChange 的合并红线一致，绝不整体替换。
// 注：本函数是**内部 helper**（applyFlowToAsset 调用），现无外部消费方；虽在「档4 共享层」段内，但不像 saveEditAsset/applyFlowToAsset 那样被两页直接 import。
export function mergePhysDim(prevPhys, patch = {}) {
  const out = { ...(prevPhys && typeof prevPhys === 'object' ? prevPhys : {}) }
  if (patch.tag) out.tag = patch.tag
  if (patch.note) out.note = patch.note
  if (patch.since) out.since = patch.since
  return out
}

// 编辑保存：原资产 + 表单编辑字段 → 规范化资产（供两页 updateAsset / put 落库）。
// 全量合并（editedFields 覆盖 orig），故 holder/controller 只要在 editedFields 里就生效——修 LongFormPage 白名单漏这两项 ⟹ 改持有者/控制方静默无效。
// 派生边经 normalizeAsset→rebuildDerivedEdges 统一处理（strip 旧 derived、保手建、按最新 holder/place/controller 重算），修 place A→B 双 located_in。
// opts：{ idPrefix }（透传 normalizeAsset）。
export function saveEditAsset(origAsset, editedFields, opts = {}) {
  const a = normalizeAsset({ ...(origAsset || {}), ...(editedFields || {}) }, opts)
  a.updatedAt = Date.now() // M-E5：编辑保存必须刷 updatedAt——normalizeAsset 沿用原值(M10)，否则长篇页编辑资产后「最近编辑」不动、与 mergeAssetDraft(:968 显式 Date.now) 分叉
  return a
}

// flow（资产流转）落到**已建档**资产 → 更新后的资产（纯变换；未建档由调用方先建再调，两页建档策略不同故不并入本函数）。
// flow = { person, change, asset, ch, changeRaw? }，change ∈ gain|transferred|lose|broken|consumed|''。与 ContinuePage 结算口径一致：
//   · gain/transferred：holder = flow.person（rebuildDerivedEdges 随之生成/更新 held_by 边）；
//   · lose：phys.tag='lost'（丢失≠损毁）；consumed：phys.tag='consumed'（已消耗，独立 tag）；broken：phys.tag='broken'（已损毁）；
//   · phys 字段级合并（保 firstCh/lastCh），note 取 flow.changeRaw，否则按动作给准确中文（已丢失/已损毁/已消耗）。
//   · 与 C 区现状一致：lose/broken **不清 holder**（保留「最后持有者」）、gain/transferred **不动 phys**；若要改这两个语义先与统筹确认。
// opts：{ idPrefix, controller }（controller 透传 rebuildDerivedEdges）。
export function applyFlowToAsset(asset, flow, opts = {}) {
  const a = normalizeAsset(asset, opts)
  const fl = flow || {}
  const change = fl.change || ''
  const ch = fl.ch || 0
  if (change === 'gain' || change === 'transferred') {
    // M-E3：fl.person 经 dashOut 归一后为空（AI 写「无主/—/无」）视为无主、**不清空** holder——此前 if(fl.person) 对 '—' 为真、dashOut 得 '' 反把旧持有者抹掉、held_by 边被 strip
    const p = dashOut(fl.person)
    if (p) a.holder = p
  } else if (change === 'lose' || change === 'broken' || change === 'consumed') {
    // 尾批②：consumed 现有独立 phys tag（不再借 broken）——lose→lost、consumed→consumed、broken→broken，三者显示文案各异（已丢失/已消耗/已损毁）
    const tag = change === 'lose' ? 'lost' : change === 'consumed' ? 'consumed' : 'broken'
    const st = normalizeState(a.state)
    // note 只在 AI 给了原词(changeRaw)时留痕；默认动作词不写 note——stateToPromptLine 固定文案(已丢失/已消耗/已损毁不可再用)已表达，否则得「已丢失（已丢失）」重复。
    const noteText = dashOnly(fl.changeRaw)
    st.phys = mergePhysDim(st.phys, { tag, ...(noteText ? { note: noteText } : {}), since: ch })
    st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: ch }
    a.state = st
  }
  return rebuildDerivedEdges(a, 'controller' in opts ? { controller: opts.controller } : {})
}

// 一条【资产流转】flow 作用到整个名册 → 新名册（纯变换、不含 put；两页遍历 flows 时逐条累积调用：assets = flows.reduce((acc,fl)=>applyFlowToRoster(acc,fl,opts).assets, assets)）。
// 统一 D6-D10，以 ContinuePage 现有正确行为为准（LongFormPage 的 D7/D8/D9 bug 一并修正）：
//   · D10：名字用 findAssetByName（精确 + 别名容错），不再严格全等漏配。
//   · D9：person 未建档 → 建最小 person（不静默丢整条流转）；人物侧在 person.state.hold 追加 {name,change,ch,note?}（决策#1：change 不猜 gain，空则原词进 note）。
//   · D6：asset 已建档 → 走 applyFlowToAsset（gain/transferred→holder+held_by；lose→phys lost；broken/consumed→phys broken）。
//   · D7/D8：asset 未建档且 change==='gain' → 建最小资产（类型取 typeKeyOf(fl.assetType||'item')，AI 标了「灵兽」就建 beast），holder=person（生成 held_by）、**不写 ch_reveal**（流转章≠透出章，留 0 由用户补）。
// flow = { person, change, asset, ch, changeRaw?, assetType? }（assetType 由 parseAnalyze 从【资产流转】的类型列解析：中文规范词如「灵兽」，
//   经 typeKeyOf 归一成 beast；AI 没标类型时为 undefined ⟹ 兜底 item）。
// 返回 { assets, created:[{name,type,id}], personId, targetId, skipped }。opts：{ idPrefix, controller }。
export function applyFlowToRoster(assets, flow, opts = {}) {
  const list = Array.isArray(assets) ? assets.slice() : []
  const fl = flow || {}
  const idPrefix = opts.idPrefix || 'mn'
  const change = fl.change || ''
  const ch = fl.ch || 0
  const assetName = dashOut(fl.asset)
  const personName = dashOut(fl.person)
  const created = []
  const replaceAt = (id, next) => { const i = list.findIndex((a) => a && a.id === id); if (i >= 0) list[i] = next }

  // 1) person：解析或建最小档（D9）
  let personId = null
  if (personName) {
    const found = findAssetByName(list, personName)
    if (found) personId = found.id
    else {
      const np = normalizeAsset({ name: personName, type: 'person' }, { idPrefix })
      list.push(np); created.push({ name: personName, type: 'person', id: np.id }); personId = np.id
    }
    // 2) 人物侧 hold 记录（决策#1：change 空则原词进 note，绝不猜 gain）
    if (assetName) {
      const p = list.find((a) => a && a.id === personId)
      const st = normalizeState(p.state)
      const hold = Array.isArray(st.hold) ? [...st.hold] : []
      const rec = { name: assetName, change, ch }
      if (!change) rec.note = fl.changeRaw || ''
      // 必修2同型横扫（第十一轮）：与 mergeAssetDraft hold 去重(:1048)同口径——去重键纳入 note。
      //   change 空时 rec.note=changeRaw，同 name+空change+ch 但不同 changeRaw 是两条不同流转，原键会静默丢第二条；change 非空时 rec.note=undefined，两侧 undefined 相等、退化为原 name+change+ch 去重（行为不变）。
      if (!hold.some((h) => h.name === rec.name && h.change === rec.change && h.ch === rec.ch && h.note === rec.note)) hold.push(rec)
      st.hold = hold
      st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: ch }
      replaceAt(personId, { ...p, state: st }) // hold 不产生派生边，只换 state、不重算 links
    }
  }

  // 3) asset：已建档→applyFlowToAsset；未建档+gain→建最小 item（D7 不写 ch_reveal、D8 holder=person）；未建档+非gain→不建、记 skipped
  let targetId = null
  let skipped = ''
  const existing = assetName ? findAssetByName(list, assetName) : null
  if (existing) {
    targetId = existing.id
    replaceAt(targetId, applyFlowToAsset(existing, fl, opts))
  } else if (assetName && change === 'gain') {
    const na = normalizeAsset({ name: assetName, type: typeKeyOf(fl.assetType || 'item'), holder: personName || '' }, { idPrefix })
    list.push(na); created.push({ name: assetName, type: na.type, id: na.id }); targetId = na.id
  } else if (assetName) {
    skipped = `资产「${assetName}」未建档且流转动作非获得（${change || '未识别'}），不新建`
  }
  return { assets: list, created, personId, targetId, skipped }
}
