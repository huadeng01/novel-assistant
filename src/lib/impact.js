// 设定变更影响分析（P0）：纯前端、零 AI 的「实体 → 章节」反向索引与受影响章节定位。
// 对标 tianming「改设定 → 重跑校验 → 精确列出受影响章节号 → 一致性调和」：
//   ① 归档时给每章建 refs（出场人物 uid / 触及伏笔 id / 提交事实 id / 命中规则 id），形成反向索引；
//   ② 改设定后反查引用该实体的章节（impactedChapters），并给出命中证据片段；
//   ③ 用现有硬门（speakerStateScan / injuryContradictionScan）对受影响章节重跑（detectSettingConflicts），
//      定位「设定已改、但该章正文仍停留在旧值」的跨章矛盾（死者开口 / 残肢发力）。
// 叶子模块：只 import continuity.js 的纯函数，不 import longform.js（避免循环依赖，与 continuity.js 同约束）。
import { matchEntities, uniqueEntities, speakerStateScan, injuryContradictionScan } from './continuity.js'

const arr = (x) => (Array.isArray(x) ? x : [])
// 别名归一：与 continuity.charAliases 同口径（数组或逗号分隔字符串），本模块自带副本以保持叶子性。
const normAliases = (a) => (Array.isArray(a) ? a : typeof a === 'string' && a.trim() ? a.split(/[,，、]/) : [])
// 残废/缺失标记：与 continuity.LOSS_MARKER 同源（该常量未导出，此处内联同口径子集）。
const LOSS_RE = /(断|失|废|斩|截|缺|没了|不见了|空空)/

// ---------- 反向索引构建 ----------

// 规则命中：世界手册规则块（kind='规则'）与金手指规则（bible.powerRules），
// 其 name / aliases / trigger 任一 ≥2 字子串出现在正文，即视为本章引用了该规则（与 powerRuleAudit 的 trigger 匹配同口径）。
function ruleRefs(text, worldBlocks, powerRules) {
  const t = String(text || '')
  if (!t) return []
  const ids = []
  for (const b of arr(worldBlocks)) {
    if (!b || b.kind !== '规则' || !b.id) continue
    const surfaces = [b.name, ...normAliases(b.aliases)].map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
    if (surfaces.some((s) => t.includes(s))) ids.push(b.id)
  }
  for (const r of arr(powerRules)) {
    if (!r) continue
    const id = r.id || r.name
    if (!id) continue
    const surfaces = [r.name, r.trigger].map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
    if (surfaces.some((s) => t.includes(s))) ids.push(id)
  }
  return [...new Set(ids)]
}

// 单章反向索引（确定性、零 Token）：
//   chars —— 本章出场人物 canonical uid（复用 matchEntities：最长非重叠 + 别名归一 + 同名消歧）
//   foreshadows —— 本章埋设 / 回收的伏笔 id（planted/resolve 章号由归档已知，精确）
//   facts —— 本章提交的受控谓词事实 id（sourceChapter === chapterNo）
//   rules —— 命中本章正文的世界规则块 / 金手指规则 id
export function buildChapterRefs(text, ctx = {}) {
  const chapterNo = Number(ctx.chapterNo) || 0
  const chars = uniqueEntities(matchEntities(String(text || ''), arr(ctx.characters)))
    .map((m) => m.uid)
    .filter(Boolean)
  const foreshadows = arr(ctx.foreshadows)
    .filter((f) => f && f.id && (f.plantedChapter === chapterNo || f.resolveChapter === chapterNo))
    .map((f) => f.id)
  const facts = arr(ctx.facts)
    .filter((f) => f && f.id && f.sourceChapter === chapterNo)
    .map((f) => f.id)
  const rules = ruleRefs(text, ctx.worldBlocks, ctx.bible && ctx.bible.powerRules)
  return { chars, foreshadows, facts, rules }
}

// refs 计算所需上下文：从 project 取齐 buildChapterRefs 需要的字段
function refCtx(project, chapterNo) {
  return {
    characters: project.characters,
    foreshadows: project.foreshadows,
    facts: project.facts,
    worldBlocks: project.worldBlocks,
    bible: project.bible,
    chapterNo,
  }
}

// 为存量书回填全部章节 refs（幂等：已有 refs 的章跳过；force=true 全量重建）。
// 旧书 / 导入分章打开影响分析面板时懒触发；返回新 project（不改入参）。
export function buildAllChapterRefs(project, opts = {}) {
  const chapters = arr(project && project.chapters).map((c) => {
    if (!c) return c
    if (c.refs && !opts.force) return c
    return { ...c, refs: buildChapterRefs(c.content, refCtx(project, c.chapterNo)) }
  })
  return { ...project, chapters }
}

// 归档管线专用：用「最终态 project」为指定章重建 refs。
// 必须在 facts/foreshadows/characters 均提交入库后调用，保证本章提交的 fact id / 伏笔 id 纳入索引。
// 章不存在返回 null（调用方据此跳过回填）。
export function buildRefsFor(project, chapterNo) {
  const ch = arr(project && project.chapters).find((c) => c && c.chapterNo === chapterNo)
  if (!ch) return null
  return buildChapterRefs(ch.content, refCtx(project, chapterNo))
}

// 索引健康度：已建 refs 的章数 / 总章数（供面板提示是否需要回填）
export function refsCoverage(project) {
  const chapters = arr(project && project.chapters)
  const indexed = chapters.filter((c) => c && c.refs).length
  return { total: chapters.length, indexed, missing: chapters.length - indexed }
}

// ---------- 受影响章节定位 ----------

// 命中证据：在章正文里取该实体的一处出现（±pad 字），作者能直接看出是哪一句引用了它
function evidenceFor(project, chapter, change) {
  const t = String((chapter && chapter.content) || '')
  const pad = 12
  const around = (idx, len) => {
    if (idx < 0) return ''
    const from = Math.max(0, idx - pad)
    const to = Math.min(t.length, idx + len + pad)
    return `${from > 0 ? '…' : ''}${t.slice(from, to).replace(/\s+/g, '')}${to < t.length ? '…' : ''}`
  }
  if (change.kind === 'character') {
    const char = arr(project.characters).find((c) => c && c.uid === change.id)
    if (!char) return []
    const m = matchEntities(t, [char])[0]
    return m ? [{ snippet: around(m.start, m.end - m.start), why: `出现「${m.surface}」` }] : []
  }
  if (change.kind === 'rule') {
    const b = arr(project.worldBlocks).find((x) => x && x.id === change.id)
    const r = arr(project.bible && project.bible.powerRules).find((x) => x && (x.id || x.name) === change.id)
    const surfaces = b ? [b.name, ...normAliases(b.aliases)] : r ? [r.name, r.trigger] : []
    for (const s of surfaces) {
      const str = String(s || '').trim()
      if (str.length >= 2) {
        const idx = t.indexOf(str)
        if (idx >= 0) return [{ snippet: around(idx, str.length), why: `触发「${str}」` }]
      }
    }
    return []
  }
  if (change.kind === 'fact') {
    const f = arr(project.facts).find((x) => x && x.id === change.id)
    return f
      ? [{ snippet: `${f.subject || ''}·${f.predicate}：${f.value}`, why: `生效区间 第${f.validFrom}章${f.validTo ? `~第${f.validTo - 1}章` : '起'}` }]
      : []
  }
  if (change.kind === 'foreshadow') {
    const f = arr(project.foreshadows).find((x) => x && x.id === change.id)
    if (!f) return []
    const why =
      f.plantedChapter === chapter.chapterNo ? '本章埋设该伏笔' : f.resolveChapter === chapter.chapterNo ? '本章回收该伏笔' : '关联该伏笔'
    return [{ snippet: String(f.content || ''), why }]
  }
  return []
}

// 反查受影响章节：change = { kind: 'character'|'fact'|'foreshadow'|'rule', id }
// 返回 [{ chapterNo, title, why, indexed, evidence:[{snippet,why}] }]，按章号升序。
// 有 refs 走反向索引（数组命中，极快）；无 refs（旧书未回填）时——
//   indexedOnly=true（概览/徽章路径）跳过未建索引的章，保证 O(章数) 纯数组扫描不触发正则；
//   indexedOnly=false（单选实体路径）降级为按 kind 实时判定，保证未回填也可用。
export function impactedChapters(project, change, opts = {}) {
  const kind = change && change.kind
  const id = change && change.id
  if (!kind || id == null || id === '') return []
  const indexedOnly = !!opts.indexedOnly
  const chapters = arr(project && project.chapters)
  const fact = kind === 'fact' ? arr(project.facts).find((x) => x && x.id === id) : null
  if (kind === 'fact' && !fact) return []
  const charById = (uid) => arr(project.characters).filter((x) => x && x.uid === uid)
  const out = []
  for (const c of chapters) {
    if (!c) continue
    const refs = c.refs
    const indexed = !!refs
    if (!indexed && indexedOnly) continue
    let hit = false
    let why = ''
    if (kind === 'character') {
      hit = indexed ? arr(refs.chars).includes(id) : matchEntities(String(c.content || ''), charById(id)).length > 0
      why = '本章出场'
    } else if (kind === 'rule') {
      hit = indexed ? arr(refs.rules).includes(id) : evidenceFor(project, c, change).length > 0
      why = '本章触发该规则/约束'
    } else if (kind === 'foreshadow') {
      if (indexed) hit = arr(refs.foreshadows).includes(id)
      else {
        const f = arr(project.foreshadows).find((x) => x && x.id === id)
        hit = !!f && (f.plantedChapter === c.chapterNo || f.resolveChapter === c.chapterNo)
      }
      why = '本章埋设/回收该伏笔'
    } else if (kind === 'fact') {
      const inWindow = c.chapterNo >= (fact.validFrom || 0) && (fact.validTo == null || c.chapterNo < fact.validTo)
      const refHit = indexed ? arr(refs.facts).includes(id) : fact.sourceChapter === c.chapterNo
      const subjectHit =
        inWindow && fact.uid
          ? indexed
            ? arr(refs.chars).includes(fact.uid)
            : matchEntities(String(c.content || ''), charById(fact.uid)).length > 0
          : false
      hit = refHit || subjectHit
      why = refHit ? '本章提交该事实' : '本章处于该事实生效区间'
    }
    if (hit) {
      out.push({
        chapterNo: c.chapterNo,
        title: c.title || `第${c.chapterNo}章`,
        why,
        indexed,
        evidence: evidenceFor(project, c, change),
      })
    }
  }
  return out.sort((a, b) => a.chapterNo - b.chapterNo)
}

// ---------- 设定-正文冲突检测（复用现有硬门） ----------

// 该人物当前是否带「限制性受控状态」：只有这些状态会触发 speakerStateScan / injuryContradictionScan 的 blocker
// （死亡 / 濒死 / 不能说话 / 有残废肢体）。用于把全书冲突扫描的开销收敛到真正可能矛盾的人物上。
function hasRestrictiveState(c) {
  if (!c) return false
  if (c.alive === 'dead' || c.alive === 'dying') return true
  if (c.canSpeak === false) return true
  const inj = c.mutableInjuries && typeof c.mutableInjuries === 'object' ? c.mutableInjuries : {}
  return Object.values(inj).some((v) => LOSS_RE.test(String(v || '')))
}

// 对某次人物设定变更做跨章冲突检测：对受影响章节用「当前设定」重跑现有硬门，
// 命中即说明「设定已改，但该章正文仍停留在旧值」（死者开口 / 残肢发力）。零 AI、只报不阻断。
export function detectSettingConflicts(project, change) {
  if (!change || change.kind !== 'character') return [] // P0：确定性冲突检测只覆盖人物受控状态（门禁复用人物状态位）
  const char = arr(project && project.characters).find((c) => c && c.uid === change.id)
  if (!char || !hasRestrictiveState(char)) return []
  const conflicts = []
  for (const ic of impactedChapters(project, change)) {
    const ch = arr(project.chapters).find((c) => c && c.chapterNo === ic.chapterNo)
    if (!ch || !ch.content) continue
    const sp = speakerStateScan(ch.content, [char]).blockers
    const inj = injuryContradictionScan(ch.content, { characters: [char], facts: arr(project.facts), chapterNo: ch.chapterNo }).blockers
    const blockers = [...sp, ...inj]
    if (blockers.length) conflicts.push({ chapterNo: ch.chapterNo, title: ch.title || `第${ch.chapterNo}章`, blockers })
  }
  return conflicts
}

// 全书设定-正文冲突总扫（供面板概览与质检中心徽章）：只扫带限制性状态的人物，且只走已建索引的章（纯数组命中，开销可控）。
// 返回 [{ uid, name, chapterNo, title, blockers }]，按章号升序。
export function scanAllConflicts(project) {
  const chars = arr(project && project.characters).filter(hasRestrictiveState)
  const out = []
  for (const char of chars) {
    if (!char.uid) continue
    for (const ic of impactedChapters(project, { kind: 'character', id: char.uid }, { indexedOnly: true })) {
      const ch = arr(project.chapters).find((c) => c && c.chapterNo === ic.chapterNo)
      if (!ch || !ch.content) continue
      const blockers = [
        ...speakerStateScan(ch.content, [char]).blockers,
        ...injuryContradictionScan(ch.content, { characters: [char], facts: arr(project.facts), chapterNo: ch.chapterNo }).blockers,
      ]
      if (blockers.length) out.push({ uid: char.uid, name: char.name || '', chapterNo: ch.chapterNo, title: ch.title || `第${ch.chapterNo}章`, blockers })
    }
  }
  return out.sort((a, b) => a.chapterNo - b.chapterNo)
}

// 面板可选实体清单：人物（有 uid）/ 世界规则块 / 金手指规则 / 伏笔。
// 每项 { kind, id, label, group, restrictive }。供 ImpactPanel 下拉选择要分析的设定项。
export function impactEntities(project) {
  const out = []
  for (const c of arr(project && project.characters)) {
    if (!c || !c.uid) continue
    out.push({
      kind: 'character',
      id: c.uid,
      label: c.name || '(未命名人物)',
      group: '人物',
      restrictive: hasRestrictiveState(c),
    })
  }
  for (const b of arr(project && project.worldBlocks)) {
    if (!b || b.kind !== '规则' || !b.id) continue
    out.push({ kind: 'rule', id: b.id, label: b.name || '世界规则', group: '世界规则' })
  }
  for (const r of arr(project && project.bible && project.bible.powerRules)) {
    if (!r) continue
    const id = r.id || r.name
    if (!id) continue
    out.push({ kind: 'rule', id, label: r.name || r.id || '金手指规则', group: '金手指规则' })
  }
  for (const f of arr(project && project.foreshadows)) {
    if (!f || !f.id) continue
    out.push({ kind: 'foreshadow', id: f.id, label: (f.content || '').slice(0, 24) || '伏笔', group: '伏笔' })
  }
  return out
}

// ---------- 编辑时设定变更 diff（供黄条提醒） ----------

// 伤残位归一为可比较的字符串（键排序，避免对象字面量顺序差异误报）
const injKey = (c) => {
  const inj = c && c.mutableInjuries && typeof c.mutableInjuries === 'object' ? c.mutableInjuries : {}
  return Object.keys(inj)
    .sort()
    .map((k) => `${k}:${inj[k]}`)
    .join('|')
}

// 比较 prev/next 两个 project，返回有实质影响的设定变更清单（供编辑后黄条提醒）。
// 只关注会改变「受影响章节判定」或「一致性」的字段；其余编辑（大纲/梗概/文风）不触发。
// 新增实体不算「变更」（尚无历史章节引用）；返回 [{ kind, id, label, restrictive? }]。
export function detectSettingDiff(prev, next) {
  const out = []
  if (!prev || !next) return out
  const pChars = new Map(arr(prev.characters).filter((c) => c && c.uid).map((c) => [c.uid, c]))
  for (const c of arr(next.characters)) {
    if (!c || !c.uid) continue
    const p = pChars.get(c.uid)
    if (!p) continue
    const changed =
      String(p.alive || '') !== String(c.alive || '') ||
      (p.canSpeak === false) !== (c.canSpeak === false) ||
      String(p.location || '') !== String(c.location || '') ||
      injKey(p) !== injKey(c) ||
      String(p.status || '') !== String(c.status || '') ||
      String(p.identity || '') !== String(c.identity || '')
    if (changed) out.push({ kind: 'character', id: c.uid, label: c.name || '人物', restrictive: hasRestrictiveState(c) })
  }
  const pBlocks = new Map(arr(prev.worldBlocks).filter((b) => b && b.id).map((b) => [b.id, b]))
  for (const b of arr(next.worldBlocks)) {
    if (!b || b.kind !== '规则' || !b.id) continue
    const p = pBlocks.get(b.id)
    if (p && (String(p.content || '') !== String(b.content || '') || String(p.name || '') !== String(b.name || '')))
      out.push({ kind: 'rule', id: b.id, label: b.name || '世界规则' })
  }
  const pRules = new Map(arr(prev.bible && prev.bible.powerRules).filter((r) => r).map((r) => [r.id || r.name, r]))
  for (const r of arr(next.bible && next.bible.powerRules)) {
    if (!r) continue
    const id = r.id || r.name
    if (!id) continue
    const p = pRules.get(id)
    if (p && (String(p.trigger || '') !== String(r.trigger || '') || String(p.consequence || '') !== String(r.consequence || '')))
      out.push({ kind: 'rule', id, label: r.name || id })
  }
  const pFore = new Map(arr(prev.foreshadows).filter((f) => f && f.id).map((f) => [f.id, f]))
  for (const f of arr(next.foreshadows)) {
    if (!f || !f.id) continue
    const p = pFore.get(f.id)
    if (
      p &&
      (String(p.content || '') !== String(f.content || '') ||
        p.plantedChapter !== f.plantedChapter ||
        p.resolveChapter !== f.resolveChapter ||
        String(p.status || '') !== String(f.status || ''))
    )
      out.push({ kind: 'foreshadow', id: f.id, label: (f.content || '').slice(0, 20) || '伏笔' })
  }
  return out
}

// 汇总一批变更的受影响章号（去重升序），供黄条提醒显示「共影响 N 章」。
export function diffImpact(project, diffs) {
  const set = new Set()
  for (const d of arr(diffs)) {
    if (!d || !d.kind || d.id == null) continue
    for (const ic of impactedChapters(project, { kind: d.kind, id: d.id })) set.add(ic.chapterNo)
  }
  return { chapters: [...set].sort((a, b) => a - b), count: set.size }
}
