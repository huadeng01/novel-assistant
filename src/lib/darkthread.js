// #2 暗线追踪台账 + 遗忘预警门
// 对标 novel-distiller「darkthread 暗线进度快照：跨章追踪，N 章未推进预警」、
//      AI-Novel-Writing-Assistant「长线伏笔/支线的一致性漂移消除」。
// 命门：长篇写到几十万字，最容易被作者自己遗忘的不是主线，而是「埋下去的暗线」——
//      一条阴谋 / 身世 / 约定 / 未解之谜埋了几十章没再推进，读者早忘了，回收时显得突兀；
//      或过了预定回收章还悬着，张力被稀释。本模块把暗线登记成台账，做纯前端确定性预警：
//   · 遗忘预警 stale   —— 活跃暗线距上次推进已 ≥ threshold 章（默认 8）：提示「读者可能已遗忘，该点一笔推进了」
//   · 逾期预警 overdue —— 已过 targetResolveChapter 仍未收束：提示「暗线逾期未回收」
// 归档时自动回填：本章正文提及暗线名/别名 → 把 lastAdvancedChapter 推进到本章（advanceThreads，只前进不回退）。
// 叶子模块：不依赖 longform.js（避免循环依赖）。纯前端、零 AI、确定性。

const arr = (x) => (Array.isArray(x) ? x : [])

// 当前进度章号：已归档章节的最大 chapterNo（无章节时退回 memoryUpTo / 0）
export function currentChapterNo(project) {
  const chs = arr(project && project.chapters).filter((c) => c && Number(c.chapterNo) > 0)
  if (chs.length) return Math.max(...chs.map((c) => Number(c.chapterNo)))
  return Number(project && project.memoryUpTo) || 0
}

// 规范化暗线台账：从 project.darkThreads 读，补默认、算 staleGap（距上次推进的章数）。
// 返回每条 {id,name,aliases,premise,plantedChapter,lastAdvancedChapter,status,targetResolveChapter,notes,staleGap,resolved}。
export function assembleThreads(project) {
  const cur = currentChapterNo(project)
  return arr(project && project.darkThreads)
    .filter((t) => t && String(t.name || '').trim())
    .map((t) => {
      const planted = t.plantedChapter != null && t.plantedChapter !== '' ? Number(t.plantedChapter) : null
      const last = t.lastAdvancedChapter != null && t.lastAdvancedChapter !== '' ? Number(t.lastAdvancedChapter) : planted
      const status = t.status || '推进中'
      return {
        id: t.id || '',
        name: String(t.name || '').trim(),
        aliases: arr(t.aliases).map((a) => String(a || '').trim()).filter((a) => a.length >= 2),
        premise: String(t.premise || '').trim(),
        plantedChapter: planted,
        lastAdvancedChapter: last,
        status,
        targetResolveChapter: t.targetResolveChapter != null && t.targetResolveChapter !== '' ? Number(t.targetResolveChapter) : null,
        notes: String(t.notes || '').trim(),
        staleGap: last != null && cur ? Math.max(0, cur - last) : 0,
        resolved: status === '已收束',
      }
    })
}

// 暗线在本章是否被触及：名字 / 别名（≥2 字）命中正文即算「推进过一次」。
export function threadMentionScan(text, thread) {
  const t = String(text || '')
  if (!t || !thread) return null
  const surfaces = [thread.name, ...arr(thread.aliases)].map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
  for (const s of surfaces) if (t.includes(s)) return s
  return null
}

// 归档回填：本章提及的活跃暗线，把 lastAdvancedChapter 推进到本章（只前进不回退，已收束的跳过）。
// 返回更新后的 darkThreads 数组；无变化返回 null（调用方据此决定是否落库，避免无谓写盘）。
export function advanceThreads(project, chapterNo, text) {
  const threads = arr(project && project.darkThreads)
  if (!threads.length) return null
  const no = Number(chapterNo) || 0
  if (!no) return null
  let changed = false
  const next = threads.map((t) => {
    if (!t || !String(t.name || '').trim()) return t
    if (t.status === '已收束') return t
    if (!threadMentionScan(text, { name: t.name, aliases: arr(t.aliases) })) return t
    const last = t.lastAdvancedChapter != null && t.lastAdvancedChapter !== '' ? Number(t.lastAdvancedChapter) : 0
    if (no <= last) return t
    changed = true
    return { ...t, lastAdvancedChapter: no }
  })
  return changed ? next : null
}

// 遗忘 + 逾期预警扫描：返回 {current, threshold, stale[], overdue[], active[], threads[]}。
// stale/overdue 每项在暗线基础上附 {kind, what, fix_hint}，供面板红/黄条与 continuityGate findings 复用。
export function scanDarkThreads(project, opts = {}) {
  const threshold = opts.threshold != null ? Number(opts.threshold) : 8
  const threads = assembleThreads(project)
  const cur = currentChapterNo(project)
  const active = threads.filter((t) => !t.resolved)
  const stale = active
    .filter((t) => t.lastAdvancedChapter != null && t.staleGap >= threshold)
    .map((t) => ({
      ...t,
      kind: '暗线遗忘预警',
      what: `暗线「${t.name}」已 ${t.staleGap} 章未推进（上次第 ${t.lastAdvancedChapter} 章，当前第 ${cur} 章）`,
      fix_hint: '读者可能已遗忘：安排一次「点一笔」推进（一句对话 / 一个细节重申存在感），或确认是否该进入回收。',
    }))
    .sort((a, b) => b.staleGap - a.staleGap)
  const overdue = active
    .filter((t) => t.targetResolveChapter != null && cur >= t.targetResolveChapter)
    .map((t) => ({
      ...t,
      kind: '暗线逾期预警',
      what: `暗线「${t.name}」预定第 ${t.targetResolveChapter} 章回收，现已第 ${cur} 章仍未收束`,
      fix_hint: '逾期悬置会稀释张力：尽快安排回收，或在台账把 targetResolveChapter 顺延并注明理由。',
    }))
    .sort((a, b) => a.targetResolveChapter - b.targetResolveChapter)
  return { current: cur, threshold, stale, overdue, active, threads }
}
