// 长篇一致性系统：章后档案更新流水线 + 本地关键词检索
// 核心思想：模型每次只看到精心组装的小上下文，连贯性由这套外部档案保证
import { chatJSON } from './llm.js'
import { uid, countWords } from './utils.js'
import {
  chapterSummaryMessages,
  rollingSummaryMessages,
  stateUpdateMessages,
  foreshadowMessages,
  consistencyCheckMessages,
  volumeMemoryMessages,
  storylineUpdateMessages,
  searchExpandMessages,
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
    outline: '',
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
    review: { usedCount: 0, current: null }, // 审核机会计数 + 当前审核结果（持久化，刷新不丢）
  }
}

// 中文/阿拉伯数字章号归一（细纲按需注入用）；解析失败返回 NaN
const CN_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
export function cnToNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (!s) return NaN
  if (s.length === 1) return s in CN_DIGITS ? CN_DIGITS[s] : NaN
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

// 简单本地检索：把已写章节切块，按关键词命中次数打分，返回相关片段（纯前端，不依赖 embedding 服务）
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
// 只有滚动摘要与卷志依赖本章摘要故在第二波；每路独立容错，单路失败不阻塞存档，只降级
// 每一步独立容错，单步失败不阻塞存档，只降级
export async function runPostChapter({ apiKey, project, chapterNo, text, onStep }) {
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

  onStep?.('1/2 五路并行归档：章节摘要 / 人物状态 / 伏笔 / 一致性校验 / 故事线…')
  // 五路互不依赖（都只读 project + 本章正文），并发后归档耗时从“六次串行”降到约“两波往返”；
  // 一致性校验只注入本章细纲窗口，长细纲不再全量进上下文；单路失败只降级不阻塞
  const summaryP = chatJSON({ apiKey, messages: chapterSummaryMessages({ text }), temperature: 0.3 }).then((r) => r.summary || '')
  const stateP = chatJSON({ apiKey, messages: stateUpdateMessages({ characters: project.characters, text }), temperature: 0.2 })
  const hookP = chatJSON({ apiKey, messages: foreshadowMessages({ active, text }), temperature: 0.2 })
  const checkP = chatJSON({
    apiKey,
    messages: consistencyCheckMessages({
      world: project.world,
      characters: project.characters,
      outline: outlineForChapter(project.outline, chapterNo),
      foreshadows: active,
      text,
    }),
    temperature: 0.2,
  })
  const storyP = chatJSON({ apiKey, messages: storylineUpdateMessages({ storylines: project.storylines, text }), temperature: 0.2 })

  const [sR, stR, hR, cR, slR] = await Promise.allSettled([summaryP, stateP, hookP, checkP, storyP])
  if (sR.status === 'fulfilled') report.summary = sR.value
  else report.degraded.push('章节摘要')
  if (stR.status === 'fulfilled') {
    const res = stR.value
    report.updates = Array.isArray(res.character_updates) ? res.character_updates : []
    report.newCharacters = Array.isArray(res.new_characters) ? res.new_characters : []
    report.events = Array.isArray(res.events) ? res.events : []
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

  // 第二波：滚动摘要（依赖本章摘要）与满卷卷志（依赖本章摘要）互不依赖，继续并发收尾
  onStep?.('2/2 收尾：滚动摘要与卷志归档…')
  const pending = pendingVolumeChapters(project, chapterNo, report.summary)
  const rollP = report.summary
    ? chatJSON({
        apiKey,
        messages: rollingSummaryMessages({ prevSummary: project.rollingSummary, chapterSummary: report.summary }),
        temperature: 0.3,
      }).then(
        (r) => r.summary || '',
        () => '',
      )
    : Promise.resolve('')
  const volP = pending?.length
    ? chatJSON({ apiKey, messages: volumeMemoryMessages({ chapters: pending }), temperature: 0.3 }).catch(() => null)
    : Promise.resolve(null)
  const [roll, vol] = await Promise.all([rollP, volP])
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

  // 事件级时间线追加
  next.events = [...(project.events || []), ...report.events.filter(Boolean).map((t) => ({ chapter: chapterNo, text: t }))]

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

  // 事件：同章同文案去重后再追加
  const evSet = new Set((project.events || []).filter((e) => e.chapter === chapterNo).map((e) => e.text))
  next.events = [...project.events, ...report.events.filter((t) => t && !evSet.has(t)).map((t) => ({ chapter: chapterNo, text: t }))]

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

// 编年史注入：每人物取最早 3 条（出身/关键起点）+ 最近 8 条（近期发展），控制总量避免撞爆上下文
export function chronicleContext(project, maxChars = 3000) {
  const lines = []
  let total = 0
  for (const c of project.characters || []) {
    const entries = project.chronicles?.[c.name] || []
    if (!entries.length) continue
    const head = entries.slice(0, 3)
    const tail = entries.slice(-8)
    const merged = [...head, ...tail.filter((e) => !head.includes(e))]
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
  }
}

// 审核结果落库：消耗一次机会，建议绑定章号（过滤掉章号非法或缺修改提示词的条目）
export function applyReview(project, result) {
  const next = { ...project }
  const chs = project.chapters || []
  next.review = {
    usedCount: (project.review?.usedCount || 0) + 1,
    current: {
      at: Date.now(),
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
