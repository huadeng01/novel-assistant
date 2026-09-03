// 长篇一致性系统：章后档案更新流水线 + 本地关键词检索
// 核心思想：模型每次只看到精心组装的小上下文，连贯性由这套外部档案保证
import { chatJSON, chatStream, glmEmbed, cosine } from './llm.js'
import { uid, countWords } from './utils.js'
import {
  chapterSummaryMessages,
  rollingSummaryMessages,
  stateUpdateMessages,
  foreshadowMessages,
  consistencyCheckMessages,
  volumeMemoryMessages,
  volumePlanMessages,
  storylineUpdateMessages,
  searchExpandMessages,
  worldSplitMessages,
  styleTrialMessages,
  TEMPLATE_RULES,
} from './prompts.js'

// 每 20 章压缩一卷"卷志"进入长时记忆，防止早期剧情被滚动摘要遗忘
export const VOLUME_SIZE = 20
// 伏笔默认保护期（埋设后最早允许回收的章距）：主线更长，支线也要发酵
export const PROTECT_GAP = { 主线: 8, 支线: 5 }
// 章节审核：每写满 5 章解锁一次审核机会（GLM 审核剧情连贯性，只查硬性矛盾不挑刺）
export const REVIEW_WINDOW = 5

// 创建新书项目（长篇写作的持久化实体：设定 + 章节 + 摘要 + 伏笔 + 时间线归属同一本书）
export function newProject(name) {
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    idea: '',
    genre: '玄幻',
    synopsis: '',
    world: '',
    worldBlocks: [], // 世界手册结构化块 [{id, name, aliases, kind, content}]；kind='规则' 永不省略；非空时按章选择性注入替代全量 world
    outline: '',
    volumes: [], // 显式卷档案 [{id, volumeNo, name, strategy, startChapter, length}]；写作时注入本卷战略，自动连写超出末卷范围时自动断卷规划新卷
    volumeLength: 20, // 断卷时每卷默认计划章数（卷结构区可改；0 = 开放式）
    protagonist: '', // 主角姓名（视角约束的依据，在设定页选择）
    rollingSummary: '', // 全书滚动摘要（随每章滚动更新）
    memory: [], // 卷级长时记忆 [{text, upTo}]，不可变，随写作沉淀
    memoryUpTo: 0, // 已压入卷志的章数
    storylines: [], // {name, type, progress, lastChapter} 持久化故事线档案（进展随每章回写）
    characters: [], // {name, aliases, identity, personality, description, status}
    chapters: [], // {id, chapterNo, title, content, wordCount, summary, pov, issueCount, createdAt}
    foreshadows: [], // {id, content, relatedChars, importance, plantedChapter, minResolveChapter, status, resolveChapter}
    events: [], // {chapter, text} 事件级时间线
    chronicles: {}, // 人物编年史 {姓名: [{chapter, text}]}，每章自动追加，写新章时按需注入，防百万字时遗忘早期经历
    styleBookId: '', // 绑定的文风档案所属书库书籍 id（写法引擎）；空 = 不绑定，写作不注入文风
    ruleIds: null, // 启用的反模板规则 id 列表；null = 全部预设默认启用（见 activeStyleRules）
    customRules: [], // 自定义反模板规则 [{id, name, text}]，与预设并列注入
    refAnalysisId: '', // 绑定的参考作品拆书资产 id（全局资产、书级可切换/解绑）；空 = 不借鉴
    review: { usedCount: 0, current: null }, // 审核机会计数 + 当前审核结果（持久化，刷新不丢）
  }
}

// 中文/阿拉伯数字章号归一（细纲按需注入用）；解析失败返回 NaN
const CN_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
export function cnToNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (!s) return NaN
  if (s.length === 1) return s === '十' ? 10 : s in CN_DIGITS ? CN_DIGITS[s] : NaN
  let result = 0
  if (s.includes('百')) {
    const [head, tail] = s.split('百')
    if (!(head in CN_DIGITS)) return NaN
    result = CN_DIGITS[head] * 100
    return tail ? result + cnToNumber(tail) : result
  }
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    result = (a ? (a in CN_DIGITS ? CN_DIGITS[a] : NaN) : 1) * 10 + (b ? (b in CN_DIGITS ? CN_DIGITS[b] : 0) : 0)
    return result
  }
  for (const ch of s) {
    if (!(ch in CN_DIGITS)) return NaN
    result = result * 10 + CN_DIGITS[ch]
  }
  return result
}

// 把细纲按「第N章」拆段，返回章头位置列表（按需注入与耗尽检测共用）
function outlineHeads(outline) {
  const heads = []
  String(outline || '')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章/)
      if (m) {
        const no = cnToNumber(m[1])
        if (Number.isFinite(no)) heads.push({ index: i, no })
      }
    })
  return heads
}

// 细纲覆盖到的最大章号（无可识别章头返回 0，供耗尽检测提示续写细纲）
export function outlineMaxChapter(outline) {
  const heads = outlineHeads(outline)
  return heads.length ? Math.max(...heads.map((h) => h.no)) : 0
}

// 细纲按需注入：把细纲按"第N章"拆段，只取本章及后续 windowSize 章，避免百万字细纲全量进上下文
export function outlineForChapter(outline, chapterNo, windowSize = 3) {
  if (!outline) return ''
  const lines = String(outline).split('\n')
  const heads = outlineHeads(outline)
  if (!heads.length) return outline // 没有可识别章号，降级全量注入（短细纲场景）
  const kept = heads.filter((h) => h.no >= chapterNo && h.no < chapterNo + windowSize)
  // 细纲未覆盖本章（耗尽或断档）：返回空而不是全量，防止长细纲撞爆上下文；由界面提示续写细纲
  if (!kept.length) return ''
  return kept
    .map((h, i) => {
      const end = i + 1 < kept.length ? kept[i + 1].index : lines.length
      return lines.slice(h.index, end).join('\n')
    })
    .join('\n\n')
}

// 章头起承转合定位标签解析：细纲章头行格式「第N章【X】标题」，返回 起/承/转/合/过渡 或空（旧细纲无标签时不注入）
export function outlinePositionFor(outline, chapterNo) {
  for (const line of String(outline || '').split('\n')) {
    const m = line.match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章\s*【\s*(起|承|转|合|过渡)\s*】/)
    if (m && cnToNumber(m[1]) === chapterNo) return m[2]
  }
  return ''
}

// 卷结构：判定某章属于哪一卷（按 startChapter + length 切段）；未建档返回 null。
// 末卷 length 为 0 视为开放式（不断卷），最后一卷兜底承接后续所有章节。
export function currentVolume(project, chapterNo) {
  const vols = project.volumes || []
  if (!vols.length) return null
  for (const v of vols) {
    const end = v.length ? v.startChapter + v.length - 1 : Infinity
    if (chapterNo >= v.startChapter && chapterNo <= end) return v
  }
  const last = vols[vols.length - 1]
  return chapterNo >= last.startChapter ? last : null
}

// 是否需要断卷开新卷：仅当卷档案已启用（至少一卷）且下一章超出末卷范围时为真；
// 末卷开放式（length=0）永不自动断卷。
export function needNewVolume(project, chapterNo) {
  const vols = project.volumes || []
  if (!vols.length) return false
  const last = vols[vols.length - 1]
  return last.length ? chapterNo > last.startChapter + last.length - 1 : false
}

// 本章注入用的卷战略文本（无卷档案或无战略时为空不注入）；结构化字段（起承转合结构/情感走向）存在时一并渲染，旧卷只有 strategy 字段时向后兼容。
export function volumeStrategyText(project, chapterNo) {
  const v = currentVolume(project, chapterNo)
  if (!v || !v.strategy) return ''
  const parts = [`第${v.volumeNo}卷《${v.name}》`, v.strategy]
  if (v.arc) parts.push(`起承转合结构：${v.arc}`)
  if (v.emotion) parts.push(`情感走向：${v.emotion}`)
  return parts.join('\n')
}

// ---------- 卷级弧线坐标系：起承转合定位标签以「本章在本卷弧线中的位置」为准 ----------
// 无卷档案/无 arc 时的默认弧线（20 章基准：起1-5/承6-12/转13-17/合18-20），按本卷计划章数等比缩放
const ARC_WEIGHTS = [
  { pos: '起', end: 0.25 },
  { pos: '承', end: 0.6 },
  { pos: '转', end: 0.85 },
  { pos: '合', end: 1 },
]

// 自由文本 arc 的阶段名 → 定位标签映射（命中关键词即归类，否则按出现顺序兜底到 起/承/转/合）
const ARC_POS_KEYWORDS = [
  { pos: '起', kws: ['起', '铺垫', '开局', '开篇', '蓄势'] },
  { pos: '承', kws: ['承', '发展', '推进', '发酵'] },
  { pos: '转', kws: ['转', '高潮', '爆发', '反转', '冲突'] },
  { pos: '合', kws: ['合', '收束', '收尾', '兑现', '结局'] },
]
const posOfStage = (name, index) => {
  for (const p of ARC_POS_KEYWORDS) if (p.kws.some((k) => name.includes(k))) return p.pos
  return ARC_WEIGHTS[Math.min(index, 3)].pos
}

// 解析卷档案的自由文本 arc（如「铺垫(第1-5章)→发展(第6-12章)」），抽出各阶段章节范围；
// 章号为卷内相对坐标（从 1 起）；无法解析出 ≥2 段时返回 null，由调用方降级到默认弧线。
export function parseVolumeArc(arc) {
  const segs = []
  const re = /([^()（）\s→—\->,，;；]{1,10})\s*[（(]([^)）]{2,26})[)）]/g
  let m
  while ((m = re.exec(String(arc || '')))) {
    const rm = m[2].match(/(\d+)\s*[-—~至到]\s*(\d+)/)
    if (!rm) continue
    const s = Number(rm[1])
    const e = Number(rm[2])
    if (s >= 1 && e >= s) segs.push({ name: m[1], start: s, end: e })
  }
  return segs.length >= 2 ? segs : null
}

// 卷内章节范围 [from, to] 的弧线坐标：优先卷档案 arc 的结构化范围，否则默认弧线按长度缩放；
// length<=0（开放式）按 20 章基准。返回 [{pos, start, end}]（卷内相对章号）。
export function arcRanges(volume, from, to) {
  const parsed = parseVolumeArc(volume?.arc)
  if (parsed) {
    return parsed.map((seg, i) => ({ pos: posOfStage(seg.name, i), start: seg.start, end: seg.end }))
  }
  const L = Math.max(to - from + 1, volume?.length > 0 ? volume.length : 20)
  const ranges = []
  let prevEnd = 0
  for (const w of ARC_WEIGHTS) {
    if (prevEnd >= L) break // 极短卷：章数不够四段时只保留有效段，不产生倒挂区间
    const end = Math.min(L, Math.max(prevEnd + 1, Math.round(L * w.end)))
    ranges.push({ pos: w.pos, start: prevEnd + 1, end })
    prevEnd = end
  }
  return ranges
}

// 卷弧线坐标的提示词文本：供细纲生成/续写注入，使定位标签与卷结构全链路对齐；无可定位卷时返回空。
export function arcTextForRange(project, from, to) {
  if (!from || to < from) return ''
  const vols = project?.volumes || []
  if (!vols.length) {
    const ranges = arcRanges({ length: project?.volumeLength || 20 }, from, to)
    return `未建档卷，按默认弧线（随计划章数缩放）：${ranges.map((r) => `${r.pos}=第${r.start}-${r.end}章`).join('；')}`
  }
  const parts = []
  for (let n = from; n <= to; n++) {
    const v = currentVolume(project, n)
    if (!v || parts.some((p) => p.v === v)) continue
    const end = v.length ? v.startChapter + v.length - 1 : to
    const segFrom = Math.max(from, v.startChapter)
    const segTo = Math.min(to, end)
    const ranges = arcRanges(v, segFrom, segTo)
      .map((r) => `${r.pos}=第${r.start}-${r.end}章`)
      .join('；')
    const arcNote = v.arc && !parseVolumeArc(v.arc) ? `（卷弧线：${v.arc}）` : ''
    parts.push({ v, text: `第${v.volumeNo}卷《${v.name}》（第${v.startChapter}-${end === Infinity ? '…' : end}章，章号为卷内坐标）：${ranges}${arcNote}` })
  }
  return parts.map((p) => p.text).join('\n')
}

// AI 规划新卷：基于梗概/细纲开头/滚动摘要/故事线生成卷名与卷战略（手动建档与自动断卷共用）
export async function planVolume({ apiKey, project, startChapter }) {
  const volumeNo = (project.volumes || []).length + 1
  const res = await chatJSON({
    apiKey,
    messages: volumePlanMessages({
      volumeNo,
      synopsis: project.synopsis,
      outline: outlineForChapter(project.outline, startChapter, 8),
      rollingSummary: project.rollingSummary,
      storylines: project.storylines || [],
    }),
    temperature: 0.5,
  })
  if (!res.strategy) throw new Error('AI 未能生成卷战略，请重试。')
  return {
    id: uid(),
    volumeNo,
    name: String(res.title || `第${volumeNo}卷`).slice(0, 20),
    strategy: String(res.strategy),
    arc: String(res.arc || ''),
    emotion: String(res.emotion || ''),
    startChapter,
    length: project.volumeLength || 20,
  }
}

// ---------- AI 味输出层验证：事后扫描（纯前端正则，零费用；规则不再只靠模型自觉） ----------
// 禁词表与提示词层 NO_AI_FLAVOR_RULE 保持一致并扩充；只报警不阻断，由作者判断。
export const AI_FLAVOR_WORDS = [
  '宛如', '犹如', '恰似', '仿佛画卷', '空气仿佛凝固', '空气凝固', '如诗如画', '意味深长',
  '嘴角勾起', '嘴角扬起', '眸光微闪', '眸光', '眼神闪过', '眼底闪过', '眸中闪过', '不禁', '不由得',
  '心中暗想', '心中五味杂陈', '一丝不易察觉',
]
// 结构层模式：过渡句/时间速写/解说式心理，是 AI 网文的高频骨架（命中附示例，供作者确认）
export const AI_FLAVOR_PATTERNS = [
  { name: '过渡句（与此同时/另一边）', regex: /与此同时|另一边[，,]|话说两头/ },
  { name: '时间速写（转眼/时间飞逝）', regex: /时间(?:飞快|飞逝|如白驹过隙)|转眼间?[，,]|不知不觉间/ },
  { name: '解说式心理（他意识到/明白了）', regex: /[他她][们]?(?:终于|这才|突然|瞬间)?(?:意识到|明白了|懂得了)[，,]/ },
]

// 扫描正文的 AI 味命中：禁词（含用户自定义禁用词）+ 结构模式；返回 [{type, word, count, name?}]
export function aiFlavorScan(text, extraForbidden = []) {
  if (!text) return []
  const hits = []
  const custom = new Set(extraForbidden || [])
  const wordHits = []
  for (const w of [...new Set([...AI_FLAVOR_WORDS, ...custom])]) {
    if (!w) continue
    const count = text.split(w).length - 1
    if (count > 0) wordHits.push({ type: custom.has(w) ? '自定义禁词' : '禁词', word: w, count })
  }
  // 去冗余：短词被同一文本中更长的命中词包含且次数相同时只留长词（如"眸光微闪"与"眸光"）
  wordHits.sort((a, b) => b.word.length - a.word.length)
  for (const h of wordHits) {
    const covered = hits.some((k) => k.type !== '结构' && k.word.includes(h.word) && k.count === h.count)
    if (!covered) hits.push(h)
  }
  for (const p of AI_FLAVOR_PATTERNS) {
    const m = String(text).match(new RegExp(p.regex.source, 'g'))
    if (m && m.length) hits.push({ type: '结构', word: m[0], count: m.length, name: p.name })
  }
  return hits
}

// 简单本地检索：把已写章节切块，按关键词命中次数打分，返回相关片段（纯前端，不 依赖 embedding 服务）
export function searchChapters(chapters, keywords, topN = 3, chunkSize = 400) {
  const kws = [...new Set((keywords || []).filter(Boolean))]
  if (!kws.length || !(chapters || []).length) return []
  const scored = []
  for (const ch of chapters) {
    const text = ch.content || ''
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize)
      let score = 0
      for (const k of kws) if (chunk.includes(k)) score += 1
      if (score > 0) scored.push({ chapterNo: ch.chapterNo, title: ch.title, text: chunk, score })
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topN)
}

// 正文切块（块级语义召回用）：按段落聚合成约 size 字的块，段落过长时硬切；
// 切块是确定性的——同样的正文永远切出同样的块，向量缓存因此可按"块数+字数"签名判失效。
export function chunkText(text, size = 400) {
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const chunks = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > size) {
      chunks.push(cur)
      cur = ''
    }
    if (p.length > size) {
      if (cur) {
        chunks.push(cur)
        cur = ''
      }
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size))
      continue
    }
    cur += (cur ? '\n' : '') + p
  }
  if (cur) chunks.push(cur)
  return chunks
}

// 块缓存签名：正文变化（手改/重写）后向量自动失效重建，不会拿旧向量召错片段
const chunkSig = (c) => `${chunkText(c.content).length}:${c.content.length}`

// 可选向量召回（「我的」页启用智谱 Embedding-3 后生效）：按写作指令与正文块的语义相似度取回前文片段；
// 向量按 400 字正文块粒度缓存进 chapter.chunkEmbed（随书持久化，只对新增/变更章节补向量化）；
// 命中块会带上前一块做上下文，防止片段拦腰截断。服务不可用时抛错，由调用方降级回关键词检索。
export async function semanticPassages({ glmKey, chapters, instruction, topN = 4, chunkSize = 400 }) {
  const all = chapters || []
  const list = all.filter((c) => c && c.content)
  if (!list.length || !(instruction || '').trim()) return { passages: [], chapters: all, changed: false }
  let changed = false
  const vecByChapter = {}
  const todo = []
  for (const c of list) {
    const chunks = chunkText(c.content, chunkSize)
    if (!chunks.length) continue
    const cached = c.chunkEmbed
    if (Array.isArray(cached?.vecs) && cached.sig === `${chunks.length}:${c.content.length}` && cached.vecs.length === chunks.length) {
      vecByChapter[c.id] = { chunks, vecs: cached.vecs }
    } else {
      todo.push({ c, chunks })
    }
  }
  // 跨章合并分批（单请求最多 64 条），避免每章一次请求
  const flat = []
  for (const t of todo) t.chunks.forEach((ch, idx) => flat.push({ t, idx, text: ch.slice(0, 3000) }))
  for (let i = 0; i < flat.length; i += 64) {
    const batch = flat.slice(i, i + 64)
    const vecs = await glmEmbed({ apiKey: glmKey, texts: batch.map((b) => b.text) })
    batch.forEach((b, j) => {
      if (!vecByChapter[b.t.c.id]) vecByChapter[b.t.c.id] = { chunks: b.t.chunks, vecs: new Array(b.t.chunks.length) }
      vecByChapter[b.t.c.id].vecs[b.idx] = vecs[j]
    })
    changed = true
  }
  const next = changed
    ? all.map((c) =>
        vecByChapter[c.id] && todo.some((t) => t.c.id === c.id)
          ? { ...c, embed: undefined, chunkEmbed: { sig: chunkSig(c), vecs: vecByChapter[c.id].vecs } }
          : c,
      )
    : all
  const [q] = await glmEmbed({ apiKey: glmKey, texts: [instruction.slice(0, 3000)] })
  const scored = []
  for (const c of list) {
    const v = vecByChapter[c.id]
    if (!v) continue
    v.vecs.forEach((vec, idx) => {
      if (vec) scored.push({ c, idx, score: cosine(q, vec) })
    })
  }
  scored.sort((a, b) => b.score - a.score)
  // 同章命中块去重（一章最多留 2 块），取 topN 块；每块带上前一块保证语境完整
  const picked = []
  const perChapter = {}
  for (const s of scored) {
    if (picked.length >= topN) break
    if (picked.some((x) => x.c.id === s.c.id && Math.abs(x.idx - s.idx) <= 1)) continue
    perChapter[s.c.id] = (perChapter[s.c.id] || 0) + 1
    if (perChapter[s.c.id] > 2) continue
    picked.push(s)
  }
  const passages = picked.map(({ c, idx }) => {
    const v = vecByChapter[c.id]
    const text = (idx > 0 ? v.chunks[idx - 1] + '\n' : '') + v.chunks[idx]
    return { title: `第 ${c.chapterNo} 章 ${c.title || ''}（片段 ${idx + 1}/${v.chunks.length}）`, text }
  })
  return { passages, chapters: next, changed }
}

// 从本章写作指令 + 人物名单（含别名）提取检索关键词；
// 中文指令缺少空格分词，对长词额外切 2 字滑窗补充召回
export function keywordsOf(instruction, characters) {
  const names = []
  for (const c of characters || []) {
    if (c.name) names.push(c.name)
    if (Array.isArray(c.aliases)) names.push(...c.aliases.filter(Boolean))
  }
  const words = (instruction || '')
    .split(/[\s,，。、;；:：!！?？\n"'“”‘’（）()【】]+/)
    .filter((w) => w.length >= 2)
  const grams = []
  for (const w of words) {
    if (w.length > 4) {
      for (let i = 0; i + 2 <= w.length && grams.length < 12; i += 2) grams.push(w.slice(i, i + 2))
    }
  }
  return [...new Set([...names, ...words, ...grams])].slice(0, 24)
}

// 语义检索近似：先用一次轻量 LLM 调用把写作方向扩展成检索词（人物/地点/物品/事件），
// 再叠加本地分词，失败时降级为纯本地关键词（不阻塞写作）
export async function expandKeywords({ apiKey, instruction, characters, world }) {
  const base = keywordsOf(instruction, characters)
  try {
    const res = await chatJSON({ apiKey, messages: searchExpandMessages({ instruction, characters, world }), temperature: 0.2 })
    const extra = Array.isArray(res.keywords) ? res.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 12) : []
    return [...new Set([...base, ...extra])]
  } catch {
    return base
  }
}

// 尾部连续非主角视角的章数（视角约束用）；未设主角或章节无 POV 记录时不计入连续段
export function povStreak(chapters, protagonist) {
  if (!protagonist) return 0
  let n = 0
  for (let i = (chapters || []).length - 1; i >= 0; i--) {
    const pov = (chapters[i].pov || '').trim()
    if (!pov || pov === '全知' || pov === protagonist) break
    n++
  }
  return n
}

// 保存本章后是否到了一卷的末尾，需要把这一卷压缩成卷志（返回待压缩章节，含本章摘要）
function pendingVolumeChapters(project, currentChapterNo, currentSummary) {
  const writtenAfter = (project.chapters || []).length + 1
  const upTo = project.memoryUpTo || 0
  if (writtenAfter < upTo + VOLUME_SIZE) return null
  const archived = (project.chapters || []).slice(upTo).map((c) => ({ chapterNo: c.chapterNo, title: c.title, summary: c.summary }))
  archived.push({ chapterNo: currentChapterNo, title: '', summary: currentSummary })
  return archived
}

// 章后档案更新流水线（并行版）：摘要 / 状态回写 / 伏笔 / 一致性校验 / 故事线五路并发，
// 只有滚动摘要与卷志依赖本章摘要故在第二波；每路独立容错，单路失败不阻塞存档，只降级。
// 检查点：传 checkpointId（书 id）时每完成一路就落盘一次，刷新/中断后可从断点续跑（见 loadArchiveCheckpoint）；
// lanes：续跑时带上已完成的步骤结果，只重跑缺失部分；
// policy：质量策略，'strict'（质量优先）时单路失败自动重试一次，'fast'（连续推进）失败直接降级不回头。
export async function runPostChapter({ apiKey, project, chapterNo, text, onStep, checkpointId = null, title = '', lanes = null, policy = 'fast' }) {
  const report = {
    summary: '',
    rolling: project.rollingSummary || '',
    updates: [],
    newCharacters: [],
    events: [],
    pov: '',
    newForeshadows: [],
    resolved: [],
    mentioned: [],
    issues: [],
    drift: '',
    storylines: [],
    volumeMemory: '',
    volumeUpTo: 0,
    degraded: [], // 本次降级跳过的归档步骤（提示用户补跑，避免账本静默缺失）
  }
  const active = (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
  const done = lanes || {}
  const cpLanes = { ...done }
  const startedAt = Date.now()
  // 检查点落盘：整份检查点很小（正文 + 各路结果），每次整体重写即可，无需增量合并。
  const cpSave = () => {
    if (!checkpointId) return
    try {
      localStorage.setItem(`na_lf_archive_${checkpointId}`, JSON.stringify({ chapterNo, title, text, startedAt, lanes: cpLanes }))
    } catch {
      /* 检查点写失败不阻塞归档，最多丢失续跑能力 */
    }
  }
  if (checkpointId && !lanes) cpSave()
  // 单路执行器：已完成（续跑）直接返回；质量优先失败重试一次；成功后写入检查点。
  const lane = (name, fn) => {
    if (done[name] !== undefined) return Promise.resolve(done[name])
    const attempt = async () => {
      try {
        return await fn()
      } catch (e) {
        if (policy === 'strict') return await fn()
        throw e
      }
    }
    return attempt().then((v) => {
      cpLanes[name] = v
      cpSave()
      return v
    })
  }

  onStep?.(lanes ? '续跑归档：补全中断的步骤…' : '1/2 五路并行归档：章节摘要 / 人物状态 / 伏笔 / 一致性校验 / 故事线…')
  // 五路互不依赖（都只读 project + 本章正文），并发后归档耗时从“六次串行”降到约“两波往返”；
  // 一致性校验只注入本章细纲窗口，长细纲不再全量进上下文；单路失败只降级不阻塞
  const summaryP = lane('summary', async () => (await chatJSON({ apiKey, messages: chapterSummaryMessages({ text }), temperature: 0.3 })).summary || '')
  const stateP = lane('state', () => chatJSON({ apiKey, messages: stateUpdateMessages({ characters: project.characters, text }), temperature: 0.2 }))
  const hookP = lane('hook', () => chatJSON({ apiKey, messages: foreshadowMessages({ active, text }), temperature: 0.2 }))
  const checkP = lane('check', () =>
    chatJSON({
      apiKey,
      messages: consistencyCheckMessages({
        world: project.world,
        characters: project.characters,
        outline: outlineForChapter(project.outline, chapterNo),
        foreshadows: active,
        text,
      }),
      temperature: 0.2,
    }),
  )
  const storyP = lane('story', () => chatJSON({ apiKey, messages: storylineUpdateMessages({ storylines: project.storylines, text }), temperature: 0.2 }))

  const [sR, stR, hR, cR, slR] = await Promise.allSettled([summaryP, stateP, hookP, checkP, storyP])
  if (sR.status === 'fulfilled') report.summary = sR.value
  else report.degraded.push('章节摘要')
  if (stR.status === 'fulfilled') {
    const res = stR.value
    report.updates = Array.isArray(res.character_updates) ? res.character_updates : []
    report.newCharacters = Array.isArray(res.new_characters) ? res.new_characters : []
    report.events = Array.isArray(res.events)
      ? res.events
          .map((ev) =>
            typeof ev === 'string'
              ? { text: ev, time: '' }
              : ev?.text
                ? { text: String(ev.text), time: String(ev.time || '').trim() }
                : null,
          )
          .filter(Boolean)
      : []
    report.pov = typeof res.pov === 'string' ? res.pov.trim() : ''
  } else report.degraded.push('状态回写')
  if (hR.status === 'fulfilled') {
    const res = hR.value
    report.newForeshadows = Array.isArray(res.new_foreshadows) ? res.new_foreshadows : []
    report.resolved = Array.isArray(res.resolved) ? res.resolved : []
    report.mentioned = Array.isArray(res.mentioned) ? res.mentioned : []
  } else report.degraded.push('伏笔检测')
  if (cR.status === 'fulfilled') {
    const res = cR.value
    report.issues = Array.isArray(res.issues) ? res.issues : []
    report.drift = res.outline_drift || ''
  } else report.degraded.push('一致性校验')
  if (slR.status === 'fulfilled') {
    report.storylines = Array.isArray(slR.value.storylines) ? slR.value.storylines : []
  } else report.degraded.push('故事线回写')

  // 第二波：滚动摘要（依赖本章摘要）与满卷卷志（依赖本章摘要）互不依赖，继续并发收尾；同样走检查点。
  onStep?.(lanes ? '续跑收尾：滚动摘要与卷志归档…' : '2/2 收尾：滚动摘要与卷志归档…')
  const pending = pendingVolumeChapters(project, chapterNo, report.summary)
  const rollP = report.summary ? lane('rolling', async () => (await chatJSON({
    apiKey,
    messages: rollingSummaryMessages({ prevSummary: project.rollingSummary, chapterSummary: report.summary }),
    temperature: 0.3,
  })).summary || '') : Promise.resolve('')
  const volP = pending?.length ? lane('volume', () => chatJSON({ apiKey, messages: volumeMemoryMessages({ chapters: pending }), temperature: 0.3 })) : Promise.resolve(null)
  const [rollR, volR] = await Promise.allSettled([rollP, volP])
  const roll = rollR.status === 'fulfilled' ? rollR.value : ''
  const vol = volR.status === 'fulfilled' ? volR.value : null
  if (report.summary) report.rolling = roll || project.rollingSummary || report.summary
  if (vol?.memory) {
    report.volumeMemory = vol.memory
    report.volumeUpTo = (project.memoryUpTo || 0) + pending.length
  } else if (pending?.length) {
    /* 卷志失败降级跳过，下一卷再补 */
    report.degraded.push('卷志归档')
  }

  return report
}

// 归档检查点：保存章节前开启、每完成一路归档落盘一次，刷新/中断后可从断点续跑，不必重跑全部请求。
export function loadArchiveCheckpoint(projectId) {
  try {
    return JSON.parse(localStorage.getItem(`na_lf_archive_${projectId}`))
  } catch {
    return null
  }
}

export function clearArchiveCheckpoint(projectId) {
  localStorage.removeItem(`na_lf_archive_${projectId}`)
}

// 把档案报告应用到项目，返回 { project, blocked }；blocked 为保护期内被拦截回收的伏笔（抢收拦截）
export function applyReport(project, { chapterNo, title, text }, report) {
  const next = { ...project }

  // 章节入库（含本章摘要、叙事视角与校验问题明细，形成章节摘要链；问题明细持久化供后续查看与定向重写）
  next.chapters = [
    ...(project.chapters || []),
    {
      id: uid(),
      chapterNo,
      title: title || `第${chapterNo}章`,
      content: text,
      wordCount: countWords(text),
      summary: report.summary,
      pov: report.pov || '',
      issueCount: report.issues.length,
      issues: report.issues,
      createdAt: Date.now(),
    },
  ]
  next.rollingSummary = report.rolling || report.summary || project.rollingSummary

  // 卷志沉淀进长时记忆（不可变，只增不改）
  if (report.volumeMemory) {
    next.memory = [...(project.memory || []), { text: report.volumeMemory, upTo: report.volumeUpTo }]
    next.memoryUpTo = report.volumeUpTo
  }

  // 故事线档案合并：同名沿用（只更新进展与最近章节），新名称登记入档
  const slMap = new Map((project.storylines || []).map((s) => [s.name, s]))
  for (const su of report.storylines || []) {
    if (!su?.name) continue
    const exist = slMap.get(su.name)
    slMap.set(su.name, {
      name: su.name,
      type: exist?.type || (su.type === '主线' ? '主线' : '支线'),
      progress: su.progress || exist?.progress || '',
      lastChapter: chapterNo,
    })
  }
  next.storylines = [...slMap.values()]

  // 人物状态回写：按姓名或别名匹配（别名归一），状态只保留最近三条变化，避免无限膨胀；
  // 同时把每条变化追加进该人物的编年史（全量保留，百万字时早期经历不丢）
  const characters = [...(project.characters || [])]
  const chronicles = { ...(project.chronicles || {}) }
  for (const u of report.updates) {
    if (!u || !u.name || !u.change) continue
    const uname = String(u.name).trim()
    const i = characters.findIndex(
      (c) => (c.name || '').trim() === uname || (c.aliases || []).some((a) => String(a).trim() === uname),
    )
    if (i >= 0) {
      const segs = [...(characters[i].status || '').split('；').filter(Boolean), u.change].slice(-3)
      characters[i] = { ...characters[i], status: segs.join('；') }
      const canon = characters[i].name
      const list = chronicles[canon] || []
      if (!list.some((e) => e.chapter === chapterNo && e.text === u.change)) {
        chronicles[canon] = [...list, { chapter: chapterNo, text: u.change }]
      }
    }
  }
  // 新出场的重要人物自动入档
  for (const nc of report.newCharacters) {
    if (nc?.name && !characters.some((c) => c.name === nc.name)) {
      characters.push({
        name: nc.name,
        aliases: [],
        identity: nc.identity || '',
        personality: nc.personality || '',
        description: '',
        status: '',
      })
    }
  }
  next.characters = characters
  next.chronicles = chronicles

  // 事件级时间线追加（含故事内时间；旧数据无 time 字段时按空处理）
  next.events = [...(project.events || []), ...report.events.filter((ev) => ev?.text).map((ev) => ({ chapter: chapterNo, text: ev.text, time: ev.time || '' }))]

  // 伏笔账本更新：抢收拦截（保护期内不允许回收）+ 状态流转 + 新伏笔登记（默认保护期）
  const blocked = []
  let foreshadows = (project.foreshadows || []).map((f) => {
    if (report.resolved.includes(f.id)) {
      if (f.minResolveChapter && chapterNo < f.minResolveChapter) {
        blocked.push(f) // 保护期未过：不回收，保持原状态，由界面提示用户
        return f
      }
      return { ...f, status: '已回收', resolveChapter: chapterNo }
    }
    if (report.mentioned.includes(f.id)) return { ...f, status: '已提及' }
    return f
  })
  for (const nf of report.newForeshadows) {
    if (!nf?.content) continue
    const importance = nf.importance === '支线' ? '支线' : '主线'
    foreshadows.push({
      id: uid(),
      content: nf.content,
      relatedChars: Array.isArray(nf.related_chars) ? nf.related_chars : [],
      importance,
      plantedChapter: chapterNo,
      minResolveChapter: chapterNo + (PROTECT_GAP[importance] || 5),
      status: '未回收',
      resolveChapter: null,
    })
  }
  next.foreshadows = foreshadows

  next.updatedAt = Date.now()
  return { project: next, blocked }
}

// 补跑归档：对已保存章节重跑章后流水线并幂等合并（状态行去重 / 事件去重 / 新伏笔按内容去重），
// 用于归档降级后的补救与用户手动改完正文后的重新建档；滚动摘要只在重跑最新章时更新，避免污染后文进度
export function reapplyReport(project, chapterNo, report) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo
      ? {
          ...c,
          summary: report.summary || c.summary,
          pov: report.pov || c.pov,
          issueCount: report.issues.length,
          issues: report.issues,
        }
      : c,
  )
  const maxNo = (project.chapters || []).reduce((m, c) => Math.max(m, c.chapterNo), 0)
  if (chapterNo === maxNo && report.rolling) next.rollingSummary = report.rolling

  // 状态与编年史：重复行跳过，避免补跑产生重复记录（编年史按章覆盖同条）
  const characters = [...(project.characters || [])]
  const chronicles = { ...(project.chronicles || {}) }
  for (const u of report.updates) {
    if (!u?.name || !u.change) continue
    const uname = String(u.name).trim()
    const i = characters.findIndex(
      (c) => (c.name || '').trim() === uname || (c.aliases || []).some((a) => String(a).trim() === uname),
    )
    if (i < 0) continue
    const segs = [...(characters[i].status || '').split('；').filter(Boolean)]
    if (!segs.includes(u.change)) {
      characters[i] = { ...characters[i], status: [...segs, u.change].slice(-3).join('；') }
    }
    const canon = characters[i].name
    const list = chronicles[canon] || []
    if (!list.some((e) => e.chapter === chapterNo && e.text === u.change)) {
      chronicles[canon] = [...list, { chapter: chapterNo, text: u.change }]
    }
  }
  next.characters = characters
  next.chronicles = chronicles

  // 事件：同章同文案去重后再追加（含故事内时间）
  const evSet = new Set((project.events || []).filter((e) => e.chapter === chapterNo).map((e) => e.text))
  next.events = [...project.events, ...report.events.filter((ev) => ev?.text && !evSet.has(ev.text)).map((ev) => ({ chapter: chapterNo, text: ev.text, time: ev.time || '' }))]

  // 伏笔：回收/提及流转（同样拦截抢收）；新伏笔按内容去重，避免补跑重复登记（保护期从本章重算）
  const blocked = []
  let foreshadows = (project.foreshadows || []).map((f) => {
    if (report.resolved.includes(f.id)) {
      if (f.minResolveChapter && chapterNo < f.minResolveChapter) {
        blocked.push(f)
        return f
      }
      return { ...f, status: '已回收', resolveChapter: f.resolveChapter || chapterNo }
    }
    if (report.mentioned.includes(f.id) && f.status === '未回收') return { ...f, status: '已提及' }
    return f
  })
  for (const nf of report.newForeshadows) {
    if (!nf?.content) continue
    if (foreshadows.some((f) => f.content === nf.content)) continue
    const importance = nf.importance === '支线' ? '支线' : '主线'
    foreshadows.push({
      id: uid(),
      content: nf.content,
      relatedChars: Array.isArray(nf.related_chars) ? nf.related_chars : [],
      importance,
      plantedChapter: chapterNo,
      minResolveChapter: chapterNo + (PROTECT_GAP[importance] || 5),
      status: '未回收',
      resolveChapter: null,
    })
  }
  next.foreshadows = foreshadows

  // 故事线：同名合并（幂等）
  const slMap = new Map((project.storylines || []).map((s) => [s.name, s]))
  for (const su of report.storylines || []) {
    if (!su?.name) continue
    const exist = slMap.get(su.name)
    slMap.set(su.name, {
      name: su.name,
      type: exist?.type || (su.type === '主线' ? '主线' : '支线'),
      progress: su.progress || exist?.progress || '',
      lastChapter: Math.max(chapterNo, exist?.lastChapter || 0),
    })
  }
  next.storylines = [...slMap.values()]

  next.updatedAt = Date.now()
  return { project: next, blocked }
}

// 对指定章节补跑完整归档流水线（降级补救 / 手改正文后重新建档），返回 { project, blocked, report }
export async function rerunArchive({ apiKey, project, chapterNo, onStep }) {
  const ch = (project.chapters || []).find((c) => c.chapterNo === chapterNo)
  if (!ch) throw new Error(`未找到第 ${chapterNo} 章`)
  const report = await runPostChapter({ apiKey, project, chapterNo, text: ch.content, onStep })
  const { project: next, blocked } = reapplyReport(project, chapterNo, report)
  return { project: next, blocked, report }
}

// ---------- 拆书工作台：参考资产 → 写作上下文 ----------
// 只拼结构层信息（功能位/关系模式/弧线/节奏模式）；资产本身不含原作专名，注入时再加硬约束防照搬。
export function referenceContext(analysis, maxChars = 2500) {
  if (!analysis) return ''
  const parts = []
  if (analysis.work_function) parts.push(`叙事功能：${analysis.work_function}`)
  if (analysis.character_functions?.length) parts.push('人物功能位：\n' + analysis.character_functions.map((c) => `- ${c.slot || '功能位'}：${c.relation || ''}；弧线：${c.arc || ''}`).join('\n'))
  if (analysis.pacing_patterns?.length) parts.push('爽点推进模式：\n' + analysis.pacing_patterns.map((p) => `- ${p}`).join('\n'))
  if (analysis.techniques?.length) parts.push('可借鉴写法：\n' + analysis.techniques.map((t) => `- ${t}`).join('\n'))
  const text = parts.join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

// ---------- 防照搬算法兜底：新人物与参考作品资产相似度检测 ----------
// 参考资产在拆书时已强制去掉专名（看不到的抄不走），所以这里检测的是"特点层"：
// 人物设定文本与参考作品人物功能位（关系模式 + 弧线）的文本重合度。
// 字符二元组 Dice 系数：纯前端零费用，对中文短文本稳定；同文=1，无关文本一般 <0.15。
// 局限：只能抓字面级照搬；换词改写后二元组几乎不重合，改用单字频分布兼顾词汇层重合。
export function bigramDice(a, b) {
  const gramsOf = (s) => {
    const t = String(s || '').replace(/\s+/g, '')
    const m = new Map()
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const A = gramsOf(a)
  const B = gramsOf(b)
  if (!A.size || !B.size) return 0
  let ta = 0
  let tb = 0
  let inter = 0
  for (const [g, c] of A) {
    ta += c
    inter += 2 * Math.min(c, B.get(g) || 0)
  }
  for (const c of B.values()) tb += c
  return inter / (ta + tb)
}

// 单字频分布 Dice（去标点）：比二元组宽松，能抓"换词但共用大量字词"的词汇层重合，但对短文本误报偏高。
export function unigramDice(a, b) {
  const charsOf = (s) => {
    const t = String(s || '').replace(/[\s，。、；：！？（）《》「」“”…—,.:;!?()"'-]/g, '')
    const m = new Map()
    for (const ch of t) m.set(ch, (m.get(ch) || 0) + 1)
    return m
  }
  const A = charsOf(a)
  const B = charsOf(b)
  if (!A.size || !B.size) return 0
  let ta = 0
  let tb = 0
  let inter = 0
  for (const [g, c] of A) {
    ta += c
    inter += 2 * Math.min(c, B.get(g) || 0)
  }
  for (const c of B.values()) tb += c
  return inter / (ta + tb)
}

// 人物与参考作品功能位的相似度报告：二元组主检（字面级），单字频副检（词汇级）作疑似补充；
// 未绑定参考资产或无功能位时返回空。只报可疑项不阻断，命中后由作者判断是巧合还是照搬。
export function refSimilarityReport({ characters, analysis, threshold = 0.3, softThreshold = 0.3 }) {
  if (!analysis || !Array.isArray(analysis.character_functions) || !analysis.character_functions.length) return []
  const hits = []
  for (const c of characters || []) {
    const left = [c.identity, c.personality, c.description].filter(Boolean).join(' ')
    if (!left) continue
    for (const f of analysis.character_functions) {
      const right = [f.slot, f.relation, f.arc].filter(Boolean).join(' ')
      const hard = bigramDice(left, right)
      if (hard >= threshold) hits.push({ name: c.name || '未命名人物', slot: f.slot || '未命名功能位', score: Math.round(hard * 100), soft: false })
      else if (unigramDice(left, right) >= softThreshold) hits.push({ name: c.name || '未命名人物', slot: f.slot || '未命名功能位', score: Math.round(hard * 100), soft: true })
    }
  }
  return hits.sort((x, y) => (x.soft === y.soft ? y.score - x.score : x.soft ? 1 : -1))
}

// ---------- 写法引擎 v1：反模板规则聚合 ----------
// ruleIds 为 null 时全部预设默认启用；否则只启用勾选的；自定义规则永远追加。
export function activeStyleRules(project) {
  const presets = project.ruleIds == null ? TEMPLATE_RULES : TEMPLATE_RULES.filter((r) => (project.ruleIds || []).includes(r.id))
  return [...presets, ...(project.customRules || [])]
}

// 试写：用当前文风绑定与反模板规则写一段约 300 字的小片段，供用户验证写法效果再正式开写。
export async function trialWrite({ apiKey, project, styleRec }) {
  return chatStream({
    apiKey,
    messages: styleTrialMessages({
      synopsis: project.synopsis,
      style: styleRec?.profile || '',
      forbidden: styleRec?.forbidden || [],
      rules: activeStyleRules(project),
      samples: styleRec?.samples || [],
    }),
    temperature: 0.9,
  })
}

// ---------- 世界手册结构化（块级编辑 + 三层选择性注入） ----------
// 块结构：{id, name, aliases(逗号分隔别名), kind('规则'|'设定'), content}
// 三层选块：① 场景清单返回的 locations 精确匹配块名/别名（AI 定，主路）；
// ② 未跑场景清单时用「本章方向 + 上一章摘要」做确定性文本匹配（兜底）；
// ③ kind='规则' 的块永远全量注入（硬保底，设定红线不允许选择性遗忘）。
export function buildWorldBlockText(project, { locations = [], fallbackText = '', maxChars = 6000 } = {}) {
  const blocks = project.worldBlocks || []
  if (!blocks.length) return ''
  const hit = new Set()
  const fmt = (b) => `【${b.name}${b.aliases ? `（${b.aliases}）` : ''}】\n${b.content}`
  const parts = []
  let total = 0
  // ③ 规则块永不省略（超长时截断内容也不整块丢弃）
  for (const b of blocks) {
    if (b.kind !== '规则') continue
    const text = fmt(b)
    parts.push(total + text.length > maxChars ? text.slice(0, Math.max(0, maxChars - total)) + '…' : text)
    total += text.length
    hit.add(b.id)
  }
  // ① 场景地点匹配（块名/别名包含地点名，或地点名包含块名）
  const matchHit = (s) => {
    for (const b of blocks) {
      if (hit.has(b.id)) continue
      const names = [b.name, ...(b.aliases || '').split(/[,，、]/)].filter(Boolean)
      if (names.some((n) => s.includes(n) || n.includes(s))) hit.add(b.id)
    }
  }
  for (const loc of locations || []) if (loc) matchHit(String(loc).trim())
  // ② 兜底：无地点清单时对方向+前章摘要做文本包含匹配（块内容过长时只按名称匹配，避免全文遍历）
  if (fallbackText) {
    for (const b of blocks) {
      if (hit.has(b.id)) continue
      const names = [b.name, ...(b.aliases || '').split(/[,，、]/)].filter(Boolean)
      if (names.some((n) => fallbackText.includes(n)) || (b.content.length < 800 && b.content.split('\n').some((ln) => ln.trim().length > 4 && fallbackText.includes(ln.trim())))) hit.add(b.id)
    }
  }
  for (const b of blocks) {
    if (hit.has(b.id) && b.kind !== '规则') {
      const text = fmt(b)
      if (total + text.length <= maxChars) {
        parts.push(text)
        total += text.length
      }
    }
  }
  return parts.join('\n\n')
}

// 让 AI 把整段自由文本世界观拆成结构化块（一次性转换，用户之后按块维护）
export async function splitWorldToBlocks({ apiKey, world }) {
  const res = await chatJSON({
    apiKey,
    messages: worldSplitMessages({ world }),
    temperature: 0.2,
  })
  const blocks = Array.isArray(res.blocks) ? res.blocks : []
  return blocks
    .filter((b) => b && b.name && b.content)
    .map((b) => ({ id: uid(), name: String(b.name).slice(0, 30), aliases: b.aliases || '', kind: b.kind === '规则' ? '规则' : '设定', content: String(b.content) }))
}

// 编年史注入：每人物取最早 3 条（出身/关键起点）+ 最近 8 条（近期发展），控制总量避免撞爆上下文；
// onlyNames 给定出场人物名单时只注入这些人的编年史（本章参与者筛选，进一步省上下文）。
export function chronicleContext(project, maxChars = 3000, onlyNames = null) {
  const only = Array.isArray(onlyNames) && onlyNames.length ? new Set(onlyNames) : null
  const lines = []
  let total = 0
  for (const c of project.characters || []) {
    if (only && !only.has(c.name)) continue
    const entries = project.chronicles?.[c.name] || []
    if (!entries.length) continue
    const head = entries.slice(0, 3)
    const tail = entries.slice(-8)
    // 中段均匀采样最多 4 条：写到百章后中期关键经历不再掉进注入黑洞
    const midSrc = entries.slice(3, Math.max(3, entries.length - 8))
    const mid = []
    if (midSrc.length) {
      const step = midSrc.length / Math.min(4, midSrc.length)
      for (let i = 0; i < Math.min(4, midSrc.length); i++) mid.push(midSrc[Math.floor(i * step)])
    }
    const merged = [...head, ...mid, ...tail].filter((e, i, arr) => arr.indexOf(e) === i)
    const line = `- ${c.name}：` + merged.map((e) => `第${e.chapter}章 ${e.text}`).join('；')
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

// 应用伏笔节奏规划结果：只延长保护期，不缩短（防止规划反而导致抢收）
export function applyForeshadowPlans(project, plans) {
  const next = { ...project }
  next.foreshadows = (project.foreshadows || []).map((f) => {
    const p = (plans || []).find((x) => String(x.id) === String(f.id))
    if (!p || !Number.isFinite(Number(p.min_resolve_chapter))) return f
    return {
      ...f,
      minResolveChapter: Math.max(f.minResolveChapter || 0, Math.floor(Number(p.min_resolve_chapter))),
      planAdvice: p.advice || f.planAdvice || '',
    }
  })
  next.updatedAt = Date.now()
  return next
}

// ---------- 11. 章末钩子检查（纯前端启发式，零费用）：网文每章结尾必须留下悬念/期待 ----------
// 强信号：悬念标点收尾、钩子关键词、对话戛然而止；无任何信号且平铺句号收尾判为偏弱（只提醒不阻断）。
export function hookCheck(text) {
  const tail = String(text || '').replace(/\s+$/, '').slice(-220)
  if (!tail) return { ok: true, reason: '' }
  const lastChar = tail.slice(-1)
  const lastLine = tail.split(/\n/).filter(Boolean).pop() || ''
  const suspenseWords = /却|竟然|竟|突然|猛地|不对|等等|可是|然而|就在这时|话音未落|下一秒|变故|异变|心头一(紧|沉|凛)/
  if ('？?…'.includes(lastChar) || lastChar === '—') return { ok: true, reason: '以悬念标点收尾' }
  if (suspenseWords.test(tail.slice(-80))) return { ok: true, reason: '结尾带悬念词' }
  if (/[」』”"』」]$/.test(lastLine) && /[？?…—]$|[，,]$/.test(lastLine.slice(0, -1))) return { ok: true, reason: '对话戛然而止' }
  if ('！!'.includes(lastChar)) return { ok: true, reason: '强情绪收尾' }
  return { ok: false, reason: '结尾平铺直叙（句号收束、无悬念词、无断句），建议落在悬念、反转预告或未解的问题上' }
}

// ---------- 6. 专名一致性扫描（纯前端零费用）：抓"林峰/林锋"式错字变体 ----------
// 思路：对每个人名/别名，在正文里找同长度、只差一个字的串，且与所有已知专名都不是同一个词；
// 出现 ≥2 次才报（偶发单字重合噪音太大）。只扫草稿级文本，百万字全文请分章使用。
export function properNounScan(text, characters = [], minLength = 2) {
  const t = String(text || '')
  if (t.length < 50) return []
  const known = new Set()
  for (const c of characters || []) {
    if (c.name) known.add(String(c.name).trim())
    for (const a of c.aliases || []) if (a) known.add(String(a).trim())
  }
  const names = [...known].filter((n) => n.length >= minLength)
  if (!names.length) return []
  const dist1 = (a, b) => {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false
    return diff === 1
  }
  const hits = new Map()
  for (const name of names) {
    const L = name.length
    for (let i = 0; i + L <= t.length; i++) {
      const sub = t.slice(i, i + L)
      if (known.has(sub)) continue
      if (!/^[\u4e00-\u9fa5]+$/.test(sub)) continue
      if (!dist1(sub, name)) continue
      const key = `${sub}=>${name}`
      if (!hits.has(key)) hits.set(key, { candidate: sub, likely: name, count: 0 })
      hits.get(key).count += 1
      i += L - 1
    }
  }
  return [...hits.values()].filter((h) => h.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10)
}

// ---------- 9. 完稿对账：决定"这卷怎么收"之前的一页总账 ----------
// 超期伏笔（埋设超 20 章未收）/ 休眠支线（超 10 章未推进）/ 失联人物（超 15 章无经历沉淀），纯前端计算零请求。
export function settlementReport(project, overdueChapters = 20) {
  const chs = project.chapters || []
  const current = chs.reduce((m, c) => Math.max(m, c.chapterNo), 0)
  const active = (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
  const overdueHooks = active.filter((f) => (f.plantedChapter || 0) > 0 && current - f.plantedChapter > overdueChapters)
  const staleStorylines = (project.storylines || []).filter((s) => s.type !== '主线' && s.lastChapter > 0 && current - s.lastChapter > 10)
  const dormantChars = (project.characters || []).filter((c) => {
    const entries = project.chronicles?.[c.name] || []
    return entries.length > 0 && current - entries[entries.length - 1].chapter > 15
  })
  return { current, overdueHooks, staleStorylines, dormantChars }
}

// ---------- 10. 抽章交叉审核：随机抽 2 个早期章 + 最近 3 章送审，专查跨窗口矛盾 ----------
// 与常规五章审核共用审核机会与落库协议（applyReview），只在输入组装上不同。
export function buildCrossReviewInput(project) {
  const chs = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  if (chs.length < 6) return null // 章节太少时没有"跨窗口"可言
  const recent = chs.slice(-3)
  const earliestRecent = recent[0].chapterNo
  // 候选池 = 最近窗口之前的章节（且至少写过摘要），均匀抽 2 章：一章靠前、一章靠中
  const pool = chs.filter((c) => c.chapterNo < earliestRecent - 1)
  if (!pool.length) return null
  const samples = [...new Set([pool[Math.floor(pool.length * 0.2)], pool[Math.floor(pool.length * 0.7)]])].filter(Boolean)
  const window = [...samples, ...recent].sort((a, b) => a.chapterNo - b.chapterNo)
  const startNo = window[0].chapterNo
  const endNo = window[window.length - 1].chapterNo
  const timeline = (project.events || [])
    .filter((e) => e.chapter >= startNo - 5 && e.chapter <= endNo)
    .slice(-150)
    .map((e) => `第${e.chapter}章${e.time ? `（${e.time}）` : ''}：${e.text}`)
    .join('\n')
  return {
    world: project.world,
    timeline,
    rollingSummary: project.rollingSummary,
    characters: project.characters,
    foreshadows: (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
    beforeSummary: chs.filter((c) => c.chapterNo < startNo).slice(-6).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).join('\n'),
    chapters: window,
    positions: window.map((c) => ({ chapterNo: c.chapterNo, position: '' })),
    cross: true,
    sampled: samples.map((c) => c.chapterNo),
  }
}

// ---------- 12. 成书导出增强：卷分隔 / TXT 与 Markdown 双格式（写得出来也要拿得出去） ----------
// 卷分隔按卷档案 startChapter 在对应章节前插入卷头；未建档卷则整本直出。
export function exportBookText(project, { format = 'txt', withVolumes = true } = {}) {
  const sorted = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  const vols = withVolumes ? [...(project.volumes || [])].sort((a, b) => a.startChapter - b.startChapter) : []
  const volFor = (no) => vols.find((v) => no === v.startChapter)
  const lines = []
  if (format === 'md') lines.push(`# ${project.name || '未命名'}`)
  let lastVolId = null
  for (const c of sorted) {
    const v = volFor(c.chapterNo)
    if (v && v.id !== lastVolId) {
      lastVolId = v.id
      lines.push('', format === 'md' ? `## 第${v.volumeNo}卷 ${v.name || ''}` : `═══════ 第${v.volumeNo}卷 ${v.name || ''} ═══════`)
    }
    const head = `第${c.chapterNo}章 ${(c.title || '').replace(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[\s:：]*/, '')}`.trim()
    lines.push('', format === 'md' ? `### ${head}` : head, '', c.content)
  }
  return lines.join('\n').replace(/^\n+/, '')
}

// ---------- 章节审核模块 ----------
// 审核机会：每写满 5 章解锁一次，一次性（执行审核即消耗）；未用时不阻塞写作，可累积
export function reviewOpportunity(project) {
  const written = (project.chapters || []).length
  const unlocked = Math.floor(written / REVIEW_WINDOW)
  const used = project.review?.usedCount || 0
  return {
    written,
    unlocked,
    available: written >= REVIEW_WINDOW && unlocked > used,
    toNext: written < REVIEW_WINDOW ? REVIEW_WINDOW - written : unlocked <= used ? REVIEW_WINDOW - (written % REVIEW_WINDOW || 0) : 0,
  }
}

// 组装审核输入：最近 5 章全文 + 严格约束上下文（世界观 / 时间线 / 人物状态 / 伏笔 / 窗口前剧情摘要）；
// 时间线只取审核窗口附近的事件（窗口前 10 章作衔接参照），百万字时不再全量注入撞爆上下文
export function buildReviewInput(project) {
  const chs = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  const window = chs.slice(-REVIEW_WINDOW)
  const before = chs.slice(0, -REVIEW_WINDOW)
  const startNo = window.length ? window[0].chapterNo : 1
  const endNo = window.length ? window[window.length - 1].chapterNo : startNo
  // 只注入「窗口前 10 章 ~ 窗口末章」区间内的事件，上下都有界，百万字时不再全量注入撞爆上下文
  const timeline = (project.events || [])
    .filter((e) => e.chapter >= startNo - 10 && e.chapter <= endNo)
    .slice(-150)
    .map((e) => `第${e.chapter}章：${e.text}`)
    .join('\n')
  return {
    world: project.world,
    timeline,
    rollingSummary: project.rollingSummary,
    characters: project.characters,
    foreshadows: (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
    beforeSummary: before.slice(-8).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).join('\n'),
    chapters: window,
    // 各章起承转合定位（供结构错位检查；旧细纲无标签时为空，审核自动跳过该项）
    positions: window.map((c) => ({ chapterNo: c.chapterNo, position: outlinePositionFor(project.outline, c.chapterNo) })),
  }
}

// 审核结果落库：消耗一次机会，建议绑定章号（过滤掉章号非法或缺修改提示词的条目）
export function applyReview(project, result, kind = 'window') {
  const next = { ...project }
  const chs = project.chapters || []
  next.review = {
    usedCount: (project.review?.usedCount || 0) + 1,
    current: {
      at: Date.now(),
      kind,
      windowEnd: chs.length ? chs[chs.length - 1].chapterNo : 0,
      pass: !!result.pass,
      analysis: result.analysis || '',
      suggestions: (Array.isArray(result.suggestions) ? result.suggestions : [])
        .filter((s) => Number.isFinite(Number(s.chapter_no)) && s.fix_prompt)
        .map((s) => ({ chapterNo: Number(s.chapter_no), problem: s.problem || '', fixPrompt: s.fix_prompt || '' })),
      fixed: [],
      dismissed: false,
    },
  }
  next.updatedAt = Date.now()
  return next
}

// 放弃本次审核建议：清空建议展示但不阻塞写作（安全阀）；保留历史记录供回看结论
export function dismissReview(project) {
  if (!project.review?.current) return project
  const next = { ...project }
  next.review = { ...project.review, current: { ...project.review.current, dismissed: true } }
  next.updatedAt = Date.now()
  return next
}

// 用重写结果替换已保存章节的正文（派生数据同步更新），并标记该章已修复；摘要/视角由 meta 提供（无则保留旧值）；
// 替换前把原稿整版快照存进 prev（只保最近一版），重写不满意时可一键恢复，永远不弄丢用户的字
export function replaceChapter(project, chapterNo, { title, text }, meta = {}) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo
      ? {
          ...c,
          prev: { title: c.title, content: c.content, wordCount: c.wordCount, summary: c.summary, pov: c.pov },
          title: title || c.title,
          content: text,
          wordCount: countWords(text),
          summary: meta.summary !== undefined ? meta.summary : c.summary,
          pov: meta.pov !== undefined ? meta.pov : c.pov,
        }
      : c,
  )
  const cur = next.review?.current
  if (cur && !cur.fixed.includes(chapterNo)) {
    next.review = { ...next.review, current: { ...cur, fixed: [...cur.fixed, chapterNo] } }
  }
  next.updatedAt = Date.now()
  return next
}

// 恢复替换前的原稿：把 prev 快照回写正文与派生数据（问题明细一并清空，因为那是旧版本的校验结果）；无快照时不动
export function restoreChapter(project, chapterNo) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo && c.prev
      ? {
          ...c,
          title: c.prev.title,
          content: c.prev.content,
          wordCount: c.prev.wordCount,
          summary: c.prev.summary,
          pov: c.prev.pov,
          issues: [],
          issueCount: 0,
          prev: undefined,
        }
      : c,
  )
  next.updatedAt = Date.now()
  return next
}

// 重写后刷新派生档案：重新生成该章摘要与叙事视角（两次轻量请求，各自容错）
export async function refreshChapterMeta({ apiKey, project, text, onStep }) {
  const meta = {}
  onStep?.('更新章节摘要…')
  try {
    meta.summary = (await chatJSON({ apiKey, messages: chapterSummaryMessages({ text }), temperature: 0.3 })).summary || ''
  } catch {
    /* 摘要失败降级跳过，保留旧摘要 */
  }
  onStep?.('重新识别叙事视角…')
  try {
    const res = await chatJSON({ apiKey, messages: stateUpdateMessages({ characters: project.characters, text }), temperature: 0.2 })
    if (typeof res.pov === 'string' && res.pov.trim()) meta.pov = res.pov.trim()
  } catch {
    /* 视角识别失败降级跳过 */
  }
  return meta
}
