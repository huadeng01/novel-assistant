// P0 角色知识状态 / 秘密知情人列表（悬疑题材命门）
// 对标 oh-story 三层「客观事实 / 角色已知 / 读者已见」、tianming「秘密状态·知情角色列表」。
// 三层模型（每条秘密 secret）：
//   · 客观事实 objective —— 秘密在世界里是否属实：'true'（属实）/ 'partial'（部分）/ 'false'（谣言/误信）/ 'unknown'
//   · 角色已知 knowers  —— 知道这个秘密的角色 uid 列表（谁掌握真相）
//   · 读者已见 readerSeenChapter —— 读者到第几章看见秘密被揭示（null = 尚未揭示）
// 命门门禁 knowerGate：非知情人在台词里说出秘密（不在 knowers 列表却掌握真相）→ blocker（戏剧逻辑穿帮）。
// 叶子模块：只依赖 continuity.js，不依赖 longform.js（避免循环依赖）。纯前端、零 AI、确定性。
import { ensureCharacterUids, matchEntities } from './continuity.js'

const arr = (x) => (Array.isArray(x) ? x : [])

// 说话归因：复用 continuity.speakerStateScan 同款「说话动词 + 引号」正则与「就近前置实体=说话人」口径。
// 捕获组 m[2] = 开引号，用于向后截取台词内容（判断秘密是否泄露在台词里）。
const SPEECH_VERB_RE = /(说道|吼道|问道|答道|叫道|喊道|喝道|笑道|怒道|哭道|叹道|冷笑道|嘶吼道|低语道|嘟囔道|喃喃道|厉声道|沉声道|说|道|吼|问|答|叫|喊|喝|嚷)[：:，,]?\s*(["“「『'])/g
// 开引号 → 闭引号配对表
const QUOTE_PAIR = { '「': '」', '『': '』', '“': '”', '"': '"', "'": "'", '‘': '’' }

function findQuoteClose(t, start, openChar) {
  const close = QUOTE_PAIR[openChar]
  if (!close) return -1
  const i = t.indexOf(close, start)
  return i
}

// 秘密的「识别表面」（codeword）：aliases 为主（≥2 字），无别名时退回 statement 整句。
// 命门口径以别名为准——秘密通常有一个短代号（如「弑师真相」「玉佩藏宝图」「身世」），台词/正文命中代号即视为触及秘密。
function secretSurfaces(s) {
  if (!s) return []
  const out = new Set()
  for (const a of arr(s.aliases)) {
    const v = String(a || '').trim()
    if (v.length >= 2) out.add(v)
  }
  if (!out.size) {
    const st = String(s.statement || '').trim()
    if (st.length >= 4) out.add(st)
  }
  return [...out]
}

function secretHitIn(text, s) {
  const t = String(text || '')
  if (!t) return null
  for (const surf of secretSurfaces(s)) if (t.includes(surf)) return surf
  return null
}

// 规范化秘密清单：从 bible.secrets 读，补默认，解析知情人 uid→name，并算出「在世但不知情」的角色（戏剧反讽的蒙在鼓里方）。
// 返回每条 {id, statement, aliases, objective, note, knowers[uid], knowerNames[], readerSeenChapter, readerSeen, unawareNames[]}。
export function assembleSecrets(project) {
  const chars = ensureCharacterUids(arr(project && project.characters))
  const byUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c]))
  const raw = arr(project && project.bible && project.bible.secrets)
  return raw
    .filter((s) => s && String(s.statement || '').trim())
    .map((s) => {
      const knowers = arr(s.knowers).filter((uid) => byUid.has(uid))
      const knowerNames = knowers.map((uid) => byUid.get(uid).name).filter(Boolean)
      const unaware = chars.filter((c) => c && c.uid && c.alive !== 'dead' && !knowers.includes(c.uid))
      return {
        id: s.id || '',
        statement: String(s.statement || '').trim(),
        aliases: arr(s.aliases).map((a) => String(a || '').trim()).filter((a) => a.length >= 2),
        objective: s.objective || 'unknown',
        note: s.note || '',
        knowers,
        knowerNames,
        readerSeenChapter: s.readerSeenChapter != null ? Number(s.readerSeenChapter) : null,
        readerSeen: s.readerSeenChapter != null,
        unawareNames: unaware.map((c) => c.name).filter(Boolean),
      }
    })
}

// 知情人门（悬疑命门）：定位每处台词归因，若说话人【不在】某秘密的 knowers 列表，却在台词里说出该秘密代号 → blocker。
// 直接治「配角莫名其妙掌握只有主角知道的真相」——悬疑/推理题材最致命的逻辑穿帮。
// ctx = {secrets, characters, chapterNo, window}。返回 {blockers:[{category,severity,uid,name,secretId,where,what,fix_hint}], scanned}。
export function knowerGate(text, ctx = {}) {
  const t = String(text || '')
  const secrets = arr(ctx.secrets).filter((s) => s && String(s.statement || '').trim())
  const chars = ensureCharacterUids(arr(ctx.characters))
  const byUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c]))
  const chapterNo = Number(ctx.chapterNo) || 0
  const window = ctx.window != null ? ctx.window : 12
  const blockers = []
  if (!t || !secrets.length || !chars.length) return { blockers, scanned: 0 }
  const matches = matchEntities(t, chars)
  if (!matches.length) return { blockers, scanned: 0 }
  SPEECH_VERB_RE.lastIndex = 0
  let m
  let scanned = 0
  while ((m = SPEECH_VERB_RE.exec(t)) !== null) {
    const p = m.index
    // 就近前置实体（end 落在 [p-window, p]）= 说话人
    let speaker = null
    for (const e of matches) {
      if (e.end <= p && p - e.end <= window) {
        if (!speaker || e.end > speaker.end) speaker = e
      }
      if (e.start > p) break
    }
    if (!speaker) continue
    const c = byUid.get(speaker.uid)
    if (!c) continue
    scanned++
    // 截取该说话动词后的引号内台词（到配对闭引号，缺配对则取 60 字）
    const contentStart = p + m[0].length
    const closeIdx = findQuoteClose(t, contentStart, m[2])
    const line = t.slice(contentStart, closeIdx < 0 ? Math.min(t.length, contentStart + 60) : closeIdx)
    if (!line) continue
    for (const s of secrets) {
      if (arr(s.knowers).includes(speaker.uid)) continue // 知情人说自己的秘密 = 合理，放行
      const hit = secretHitIn(line, s)
      if (!hit) continue
      const at = chapterNo ? `（第 ${chapterNo} 章）` : ''
      blockers.push({
        category: '知识状态穿帮',
        severity: 'blocker',
        uid: speaker.uid,
        name: c.name || speaker.canonical,
        secretId: s.id || '',
        where: `「${line.slice(0, 14)}…」处`,
        what: `非知情人「${c.name || speaker.canonical}」说出秘密「${String(s.statement || '').slice(0, 20)}」${at}：该角色不在知情人列表，却掌握了真相`,
        fix_hint: `该角色不在秘密「${hit}」的知情人列表中：改写为不知情者的合理反应（疑惑 / 误解 / 试探），或先在档案把该角色加入 knowers 再让其揭示。`,
      })
    }
  }
  return { blockers, scanned }
}

// 读者已见扫描：本章正文/台词里出现了哪些秘密的代号 → 读者至此已看见该秘密被触及。
// 返回被命中的 secret.id 列表（用于归档时自动回填 readerSeenChapter，只认首次揭示章）。
export function readerSeenScan(text, secrets) {
  const t = String(text || '')
  const seen = []
  if (!t) return seen
  for (const s of arr(secrets)) {
    if (!s || !String(s.statement || '').trim()) continue
    if (secretHitIn(t, s)) seen.push(s.id || '')
  }
  return seen.filter(Boolean)
}

// 归档时回填「读者已见」：对尚未记录 readerSeenChapter 的秘密，若本章命中其代号 → 写入 chapterNo（仅首次，不覆盖）。
// 返回更新后的 secrets 数组；无变化返回 null（调用方据此决定是否落库，避免无谓写盘）。
export function applyReaderSeen(project, chapterNo, text) {
  const secrets = arr(project && project.bible && project.bible.secrets)
  if (!secrets.length) return null
  const no = Number(chapterNo) || 0
  if (!no) return null
  const seen = new Set(readerSeenScan(text, secrets))
  if (!seen.size) return null
  let changed = false
  const next = secrets.map((s) => {
    if (!s || s.readerSeenChapter != null) return s
    if (seen.has(s.id || '')) {
      changed = true
      return { ...s, readerSeenChapter: no }
    }
    return s
  })
  return changed ? next : null
}

// 戏剧反讽张力点（写作辅助）：读者已见（readerSeenChapter 有值）但仍有在世角色蒙在鼓里 → 列出知情/不知情双方。
// 供作者主动利用「读者知道、角色不知道」的悬念张力，或反过来检查是否该让某角色知情了。
export function dramaticIrony(project) {
  return assembleSecrets(project)
    .filter((s) => s.readerSeen && s.unawareNames.length)
    .map((s) => ({
      id: s.id,
      statement: s.statement,
      readerSeenChapter: s.readerSeenChapter,
      knowers: s.knowerNames,
      unaware: s.unawareNames,
    }))
}

// 全书知情人门总扫：对每条秘密，扫描【其 readerSeenChapter 之前】的所有章节，找非知情人泄露。
// 只扫已归档章节；返回 [{secretId, statement, chapterNo, title, name, uid, what, fix_hint}]（跨章汇总，供面板红条）。
export function scanAllKnowledgeConflicts(project) {
  const proj = project || {}
  const secrets = assembleSecrets(proj)
  if (!secrets.length) return []
  const chars = ensureCharacterUids(arr(proj.characters))
  const chapters = arr(proj.chapters).filter((c) => c && typeof c.content === 'string' && c.content.length)
  const out = []
  for (const ch of chapters) {
    const no = Number(ch.chapterNo) || 0
    const res = knowerGate(ch.content, { secrets, characters: chars, chapterNo: no })
    for (const b of res.blockers) {
      out.push({
        secretId: b.secretId,
        statement: (secrets.find((s) => s.id === b.secretId) || {}).statement || '',
        chapterNo: no,
        title: ch.title || '',
        name: b.name,
        uid: b.uid,
        what: b.what,
        fix_hint: b.fix_hint,
      })
    }
  }
  out.sort((a, b) => a.chapterNo - b.chapterNo)
  return out
}
