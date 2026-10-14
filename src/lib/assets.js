// 资产库纯函数层（阶段0 新文件，零引用方也能独立跑）。
// 职责边界：本文件只做「规范化 + 判据 + 口语化注入」三件事，不碰 IndexedDB、不碰 React。
//   · 规范化：normalizeAsset / normalizeState —— 读入口与落库前统一走一遍，旧书 state:'alive' 不会白屏(设计 §4.1)。
//   · 判据：  isAssetWorthSaving / assetFieldCount —— 手动新增「全字段可空、全空不入库」(设计 §3 需求7)。
//   · 注入：  stateToPromptLine —— 结构化状态压成一句人话给 AI，绝不输出 JSON/字段名/tag 英文枚举(设计 §4.4 硬纪律)。
// 契约来源（只读参照，未修改这些文件）：
//   · parseAssets.js: revealChapterOf / rumorChapterOf / LINK_LABEL / buildLinks（英文存储 + 中文显示范式）
//   · LongFormPage.jsx: perVol = book.volOneChapters || Math.max(40, ...beats.chapter_no)
//   · parseAssets.js dash(): '—'/'-'/'无' 视同空；本文件按设计 §3 需求7 扩到 '无主'/'未知'
import { LINK_LABEL, revealChapterOf, rumorChapterOf, buildLinks } from './parseAssets.js'
import { uid } from './utils.js'

// 统一转出，组件只需 import 本文件一处，避免三处显示口径再分叉(设计 §3 需求4「单一真值」)
export { LINK_LABEL, revealChapterOf, rumorChapterOf, buildLinks }

// —— 资产类型（第一版 6 类 + 迭代类型 skill/beast 先留位；设计 §2.1）——
export const ASSET_TYPES = ['person', 'group', 'faction', 'place', 'item', 'skill', 'beast']
export const ASSET_TYPE_LABEL = {
  person: '人物',
  group: '群像',
  faction: '势力',
  place: '地点',
  item: '道具',
  skill: '功法',
  beast: '宠物',
}
// 第一版真正参与筛选/表单的 5 类（skill/beast 只在有数据时才显示按钮，避免空类占位）
export const CORE_TYPES = ['person', 'group', 'faction', 'place', 'item']

// —— 分层 tier（设计 §8 拍板4：激活 tier，S/M/L 决定 token 紧张时的注入优先级）——
// 历史值 'A'/'B' 来自 parseBookAssets / parseExpandAssets，已落库 → 保留不破坏，只在 UI 上归入「未分层」。
export const TIER_LABEL = { S: '主角', M: '配角', L: '龙套', A: '旧档A', B: '旧档B' }
export const TIER_ORDER = ['S', 'M', 'L']
// 注入优先级：token 紧张时按此排序裁剪（数值越小越先注入）
export const TIER_PRIORITY = { S: 0, M: 1, L: 2, A: 3, B: 4 }

// —— 空值口径（与 parseAssets.js 的 dash() 同源，按设计 §3 需求7 扩到「无主/未知」）——
export const EMPTY_TOKENS = ['—', '-', '－', '–', '无', '无主', '未知', '无内容', 'none', 'null', 'n/a', '?', '？']
const isBlankToken = (s) => {
  const t = String(s == null ? '' : s).trim()
  return EMPTY_TOKENS.includes(t) || EMPTY_TOKENS.includes(t.toLowerCase())
}

// 字符串清洗：去 markdown 加粗与书名号（与 parseAssets.js cleanName 同判据）—— 只用于「名字」类字段
export const cleanText = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/^`|`$/g, '').replace(/[《》]/g, '').trim()
// 自由文本清洗：只 trim + 空占位归空，**不去书名号**（detail / note 里可能出现《青竹剑》，删掉会失真）
export const dashOnly = (s) => (isBlankToken(s) ? '' : String(s == null ? '' : s).trim())
// 空占位归零：'—'/'无'/'无主'/'未知' → ''（名字类字段顺带去加粗与书名号）
export const dashOut = (s) => (isBlankToken(s) ? '' : cleanText(s))

// 逗号/顿号/斜杠分隔 → 数组（与 parseAssets.js splitList 同判据），并过滤空占位
export const splitListValue = (v) => {
  if (Array.isArray(v)) return v.map(dashOut).filter(Boolean)
  return String(v == null ? '' : v)
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
export const STATE_DIMS = [...STATE_DIMS_CORE, ...STATE_DIMS_EXTRA]
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
  return out
}

// 持有/关系是数组（保留历史，设计 §4.1 hold 为数组）
const normDimList = (v) => {
  if (v == null) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr
    .map((x) => {
      if (typeof x === 'string') return normDimObj({ name: x })
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
    // 旧字符串一律落进 plot，并把原话留在 legacy（设计 §4.1：保留原字符串不丢）
    base.plot = { tag: STATE_V1_MAP[t] || STATE_V1_MAP[t.toLowerCase()] || 'active' }
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
  // 未知形状：当旧字符串处理，原样留档，不抛错
  base.legacy = cleanText(JSON.stringify(s)).slice(0, 60)
  base.plot = { tag: 'active' }
  return base
}

// 状态是否「有内容」：normalizeState 会给空状态补 plot:null（不是 active），
// 只有用户/AI 真填过维度，或 plot 有非默认 tag / 首末章号，才算有内容。
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
  if (Array.isArray(st.hold) && st.hold.length) return true
  if (Array.isArray(st.rel) && st.rel.length) return true
  return false
}

// ============================================================================
// 状态结算落库用的纯函数（设计 §5，M11① 单一出处）
// 此前 TYPE_BY_LABEL / typeKeyOf / tagForWord / applyStateChange 在 LongFormPage.jsx 与 ContinuePage.jsx
// 各存一份逐字相同的副本（约 50 行），两份漂移会让两页状态结算行为分叉 ⟹ 抽到本文件单一出处，两页改为 import。
// ============================================================================

// 中文类型标签 → 类型 key（ASSET_TYPE_LABEL 的反向表）
export const TYPE_BY_LABEL = Object.entries(ASSET_TYPE_LABEL).reduce((m, [k, v]) => ({ ...m, [v]: k }), {})
export const typeKeyOf = (t) => {
  const s = String(t || '').trim()
  if (ASSET_TYPES.includes(s)) return s
  return TYPE_BY_LABEL[s] || 'person'
}
// AI 状态词(中文)→结构化 tag：STATE_LABEL 是 tag→中文，这里按维度反向查(先精确、再包含)，查不到留空(原话进 note 不丢)
export const tagForWord = (dim, word) => {
  const w = String(word || '').trim()
  if (!w) return ''
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
    // 位置维度的信息在 ref（地点名）：剥掉"在/位于"等前缀取地点，stateToPromptLine 的 placePhrase 靠 ref 渲染
    const ref = dashOut(word.replace(/^(在|位于|到了|移至|身处|身處)/, '')) || note
    st.place = { tag: tag || 'at', ...(ref ? { ref } : {}), ...(since ? { since } : {}) }
  } else if (dim === 'hold') {
    const arr = Array.isArray(st.hold) ? [...st.hold] : []
    arr.push({ name: word || note, change: 'gain', ...(since ? { ch: since } : {}) })
    st.hold = arr
  } else if (dim === 'rel') {
    const arr = Array.isArray(st.rel) ? [...st.rel] : []
    arr.push({ ...(tag ? { tag } : {}), ...(word ? { to: word } : {}), ...(since ? { ch: since } : {}) })
    st.rel = arr
  } else {
    // phys/power/mind/social/plot：tag 命中就用 tag，说明进 note；tag 没命中则把原话塞 note(不丢)
    const noteText = note || (tag ? '' : word)
    st[dim] = { ...(tag ? { tag } : {}), ...(noteText ? { note: noteText } : {}), ...(since ? { since } : {}) }
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
  const since = toInt(l.since_ch)
  if (since) out.since_ch = since
  const status = cleanText(l.status)
  if (status) out.status = status
  const note = dashOnly(l.note)
  if (note) out.note = note
  return out
}

// 悬空边判据（与 computeAssetWarnings 同判据：目标名不在名册即未建档）
export function isDangling(toName, assets) {
  const n = dashOut(toName)
  if (!n) return false
  return !(assets || []).some((a) => a && dashOut(a.name) === n)
}

// ============================================================================
// normalizeAsset：读入口 + 落库前统一走一遍（幂等，不改入参）
// ============================================================================

export const DROPPABLE_FIELDS = ['is_public'] // 设计 §8 拍板4：标记为可删，但破坏性变更需用户确认 → 先不物理删

export function normalizeAsset(a, opts = {}) {
  const src = a && typeof a === 'object' ? a : {}
  const idPrefix = opts.idPrefix || 'mn'
  const type = ASSET_TYPES.includes(cleanText(src.type)) ? cleanText(src.type) : 'person'
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
    updatedAt: Date.now(),
  }
  // is_public：全项目只写不读的死字段。按拍板「标记可删但先不物理删」——原样带过去，等用户确认后再清理。
  if ('is_public' in src) out.is_public = src.is_public
  // 伏笔等非资产表的额外字段（plant_ch / payoff_hint / linked_assets…）不丢弃，原样保留
  Object.keys(src).forEach((k) => {
    if (!(k in out) && k !== 'controller' && k !== 'knowersStr' && k !== 'aliasesStr' && k !== 'stateDraft') out[k] = src[k]
  })

  // links：规范化 + 去重（to+type 相同即视为同一条，与 addLink/mergeRelations 同判据）
  const links = []
  const pushLink = (l) => {
    const nl = normLink(l)
    if (!nl) return
    if (links.some((x) => x.to === nl.to && x.type === nl.type)) return
    links.push(nl)
  }
  ;(Array.isArray(src.links) ? src.links : []).forEach(pushLink)

  // 表单临时字段 → 边：控制方(place)建 controlled_by、持有者(item)建 held_by（设计 §4.2；与 parseAssetTable 同范式）
  const controller = dashOut(src.controller)
  if (controller && controller !== '无主') pushLink({ type: 'controlled_by', to: controller })
  if (out.holder && type === 'item') pushLink({ type: 'held_by', to: out.holder })

  // 人物现所在地点：state.place 与 located_in 边单向同步（改 state 自动 upsert 边；删边不动 state，避免误清 —— 设计 §3 需求6 方案2）
  const pl = out.state && out.state.place
  if (pl && pl.ref && (pl.tag === 'at' || !pl.tag)) pushLink({ type: 'located_in', to: pl.ref, since_ch: pl.since || 0 })

  out.links = links
  return out
}

// ============================================================================
// 需求7 判据：全字段可空、全空不入库
// ============================================================================

// 参与「用户填过内容」计数的字段（设计 §3 需求7 明列 + aliases 因拍板4 激活而计入）
export const COUNTED_FIELDS = ['name', 'detail', 'aliases', 'knowers', 'links', 'state', 'ch_reveal', 'ch_rumor', 'reveal_volume', 'rumor_volume', 'holder', 'controller']
// 不计数：id（系统生成）、type/tier（有默认值，用户没选也算 person/M）、createdAt/updatedAt、is_public（死字段）

export function isFilled(v) {
  if (v == null) return false
  if (typeof v === 'number') return Number.isFinite(v) && v > 0
  if (typeof v === 'string') return !isBlankToken(v) && v.trim() !== ''
  if (Array.isArray(v)) return v.some(isFilled)
  if (typeof v === 'object') {
    // state 走专用判据（默认值不算内容）；其余对象看有没有非空子值
    if ('v' in v && v.v === 2) return stateHasContent(v)
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
  if (book.volOneChapters > 0) return book.volOneChapters
  const beats = Array.isArray(book.beats) ? book.beats : []
  return Math.max(40, ...beats.map((b) => (b && b.chapter_no) || 0))
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
      return h.note ? `${n}：${h.note}` : n
  }
}

const placePhrase = (p) => {
  const ref = p.ref || ''
  const since = p.since ? `（第${p.since}章起）` : ''
  switch (p.tag) {
    case 'moving':
      return `正在赶路${ref ? `往${ref}` : ''}`
    case 'missing':
      return '下落不明'
    case 'imprisoned':
      return `被囚于${ref || '某处'}${since}`
    case 'exiled':
      return `被流放到${ref || '某处'}${since}`
    case 'returned':
      return `已回到${ref || '原处'}${since}`
    case 'at':
    default:
      return ref ? `人在${ref}${since}` : ''
  }
}

// 组装一段；withNote=false 时砍掉自由文本说明，只留状态词（超长降级用）
function stateParts(st, withNote) {
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
  if (phys) {
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

  const plot = st.plot
  if (plot && plot.tag && plot.tag !== 'active') {
    if (plot.tag === 'offstage') parts.push(plot.lastCh ? `已退场（末次出场第${plot.lastCh}章）` : '已退场')
    else if (plot.tag === 'debuted') parts.push(plot.firstCh ? `第${plot.firstCh}章登场` : '已登场')
    else parts.push(stateLabel('plot', plot.tag))
  }

  return parts.filter(Boolean)
}

export function stateToPromptLine(a, opts = {}) {
  const st = a && typeof a === 'object' ? (a.state && a.state.v === 2 ? a.state : normalizeState(a && a.state)) : null
  if (!st || !stateHasContent(st)) return ''
  const prefix = opts.prefix == null ? '现况：' : opts.prefix

  // 道具/宠物的损毁优先说清「不可再用」（拍板5：标注而非剔除）
  const physTag = st.phys && st.phys.tag
  if ((a.type === 'item' || a.type === 'beast') && (physTag === 'broken' || physTag === 'disabled')) {
    const n = dashOnly(st.phys.note)
    return trim(`${prefix}已损毁，不可再用${n ? `（${n}）` : ''}。`)
  }

  let parts = stateParts(st, true)
  if (!parts.length) return ''
  let body = parts.join('，')
  if (body.length > LIMIT - prefix.length - 1) {
    // 超长降级①：砍自由文本说明，只留状态词
    parts = stateParts(st, false).filter(Boolean)
    body = parts.join('，')
  }
  if (!body) return ''
  // 超长降级②：从句尾截断（保留靠前的核心状态），补省略号
  if (body.length > LIMIT - prefix.length - 1) body = cutTail(body, LIMIT - prefix.length - 2)
  return trim(`${prefix}${body}。`)
}

// 资产卡上给人看的现况行（与 stateToPromptLine 同源文本，设计 §6.1）
export const stateToCardLine = (a) => stateToPromptLine(a, { prefix: '' })

// 按 tier 优先级排序（token 紧张时的注入裁剪顺序；设计 §8 拍板4 激活 tier 的落点）
export function sortByTier(assets) {
  return [...(assets || [])].sort((x, y) => (TIER_PRIORITY[x.tier] == null ? 9 : TIER_PRIORITY[x.tier]) - (TIER_PRIORITY[y.tier] == null ? 9 : TIER_PRIORITY[y.tier]))
}

// 名字匹配容错（aliases 激活的用法之一）：去空格/书名号后，主名或别名双向包含即命中
export function matchesName(asset, needle) {
  const norm = (s) => String(s == null ? '' : s).replace(/[\s《》「」]/g, '')
  const n = norm(needle)
  if (!n || !asset) return false
  const cands = [asset.name, ...(asset.aliases || [])].map(norm).filter(Boolean)
  return cands.some((c) => c === n || c.includes(n) || n.includes(c))
}

// 分类计数（AssetFilterBar 用）：含 'all' 与 'missing'（缺透出章的虚拟分类）
export function countByType(assets, perVol = 40) {
  const list = assets || []
  const c = { all: list.length, missing: 0 }
  ASSET_TYPES.forEach((t) => (c[t] = 0))
  list.forEach((a) => {
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
// 现有的 applyNew 是 `.filter(n => n.name && !exist.has(n.name))` —— 重名直接消失，用户不知道为什么少了一条。
// ============================================================================

export function findByName(assets, name) {
  const n = dashOut(name)
  if (!n) return null
  return (assets || []).find((a) => a && dashOut(a.name) === n) || null
}

// 把表单草稿合并进已有资产：草稿里「用户填过的字段」覆盖旧值，detail 用 ｜ 追加（与 applyUpdates 同范式，不吞旧内容），
// links 去重合并，state 按维度合并（草稿有值的维度覆盖，旧维度不清空 —— inkos 原则②：增量更新而非重建）。
export function mergeAssetDraft(existing, draft, opts = {}) {
  const base = normalizeAsset(existing, opts)
  const add = normalizeAsset(draft, { ...opts, idPrefix: opts.idPrefix || 'mn' })
  const keepId = base.id // 合并保留已有 id，不新建（否则 links 里指向它的引用全断）
  const merged = { ...base, id: keepId, updatedAt: Date.now() }
  ;['name', 'type', 'tier', 'holder', 'ch_reveal', 'ch_rumor', 'reveal_volume', 'rumor_volume'].forEach((k) => {
    if (isFilled(add[k])) merged[k] = add[k]
  })
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
        if (!hold.some((x) => x.name === h.name && x.change === h.change && x.ch === h.ch)) hold.push(h)
      })
      st.hold = hold
    }
    if (Array.isArray(ns.rel) && ns.rel.length) {
      const rel = [...(Array.isArray(st.rel) ? st.rel : [])]
      ns.rel.forEach((r) => {
        if (!rel.some((x) => x.to === r.to && x.tag === r.tag && x.ch === r.ch)) rel.push(r)
      })
      st.rel = rel
    }
    st.legacy = st.legacy || ns.legacy || ''
    st.meta = ns.meta || st.meta
    merged.state = st
  }
  return merged
}
