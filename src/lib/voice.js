// P0+ 角色声音一致性门（OOC · Out Of Character）
// 对标 novel-distiller「灵魂蒸馏：为每个角色蒸馏思维操作系统，言行从头到尾不崩」、
//      AI-Novel-Writing-Assistant「每批章节完成后…消除后续章节角色一致性漂移」。
// 命门：长篇/群像写到几十万字后，最易崩的不是设定而是「角色声音」——AI 会让谦卑角色自称「本王」、
//      让 A 脱口说出 B 的专属口头禅。本模块把每个角色的【语言签名】登记下来，做纯前端确定性检测：
//   · 台词串味 voiceBleed  —— 说话人台词里出现【别的角色】独占的签名短语（口头禅）
//   · 自称漂移 selfRefDrift —— 说话人台词里用了【别的角色】独占的自称（朕 / 本王 / 贫道 …）
// 独占（exclusive）= 该短语只被一个角色登记；共享词（多角色都登记）与通用代词（我/你/他）一律不报，杜绝误伤。
// 仿拟护栏：台词附近出现「模仿 / 学舌 / 戏仿 / 打趣」等语境 → 降级为提醒而非穿帮（合理的故意模仿）。
// 叶子模块：只依赖 continuity.js，不依赖 longform.js（避免循环依赖）。纯前端、零 AI、确定性、只报警不阻断。
import { ensureCharacterUids, matchEntities } from './continuity.js'

const arr = (x) => (Array.isArray(x) ? x : [])

// 说话归因：复用 knowledge.js 同款「说话动词 + 引号」正则与「就近前置实体 = 说话人」口径（捕获组 m[2] = 开引号）。
const SPEECH_VERB_RE = /(说道|吼道|问道|答道|叫道|喊道|喝道|笑道|怒道|哭道|叹道|冷笑道|嘶吼道|低语道|嘟囔道|喃喃道|厉声道|沉声道|说|道|吼|问|答|叫|喊|喝|嚷)[：:，,]?\s*(["“「『'])/g
// 开引号 → 闭引号配对表
const QUOTE_PAIR = { '「': '」', '『': '』', '“': '”', '"': '"', '‘': '’', "'": "'" }
// 仿拟 / 引用语境护栏：出现这些词说明是「故意模仿某人腔调」，串味属合理写法，降级为提醒
const MIMIC_RE = /(模仿|学舌|戏仿|打趣|调侃|揶揄|学着|拿腔拿调|阴阳怪气|开玩笑|故意.{0,4}[腔调说])/
// 通用第一/第二人称代词：即便只被一个角色登记也【永不】当作专属自称（否则「我」会误伤所有角色）
const GENERIC_SELFREF = ['我', '我们', '你', '你们', '他', '她', '它', '他们', '她们', '自己', '本人']
// 常见专属自称预设（面板快速点选用）
export const SELFREF_PRESETS = ['朕', '孤', '寡人', '本王', '本座', '本尊', '本宫', '臣妾', '本将军', '本官', '贫道', '贫僧', '老朽', '老夫', '老身', '在下', '鄙人', '本帝']

function findQuoteClose(t, start, openChar) {
  const close = QUOTE_PAIR[openChar]
  if (!close) return -1
  return t.indexOf(close, start)
}

// 规范化角色声音签名：从 characters[].voice 读 {catchphrases[], selfRef[], note}，只保留已登记签名的角色。
// 返回 [{uid, name, catchphrases[], selfRef[], note}]（口头禅 ≥2 字，自称过滤通用代词）。
export function assembleVoices(project) {
  const chars = ensureCharacterUids(arr(project && project.characters))
  return chars
    .filter((c) => c && c.uid && c.name)
    .map((c) => {
      const v = c.voice || {}
      return {
        uid: c.uid,
        name: c.name,
        catchphrases: arr(v.catchphrases).map((s) => String(s || '').trim()).filter((s) => s.length >= 2),
        selfRef: arr(v.selfRef).map((s) => String(s || '').trim()).filter((s) => s && !GENERIC_SELFREF.includes(s)),
        note: v.note || '',
      }
    })
    .filter((v) => v.catchphrases.length || v.selfRef.length)
}

// 归因每处台词 → {speakerUid, name, line}（供门禁与蒸馏复用；就近前置实体 = 说话人，与 knowerGate 同口径）。
function attributeQuotes(text, chars, window = 12) {
  const t = String(text || '')
  const out = []
  if (!t) return out
  const matches = matchEntities(t, chars)
  if (!matches.length) return out
  const byUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c]))
  SPEECH_VERB_RE.lastIndex = 0
  let m
  while ((m = SPEECH_VERB_RE.exec(t)) !== null) {
    const p = m.index
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
    const contentStart = p + m[0].length
    const closeIdx = findQuoteClose(t, contentStart, m[2])
    const line = t.slice(contentStart, closeIdx < 0 ? Math.min(t.length, contentStart + 60) : closeIdx)
    if (line) out.push({ uid: speaker.uid, name: c.name || speaker.canonical, line, at: p, closeIdx })
  }
  return out
}

// 声音一致性门（OOC）：定位每处台词归因，检测说话人是否说出【别的角色】的专属签名。
// ctx = {voices, characters, chapterNo, window}。返回 {blockers, warnings, scanned}。
// blockers = 硬穿帮（串味 / 自称漂移）；warnings = 仿拟语境降级项（可能是合理写法）。
export function voiceGate(text, ctx = {}) {
  const t = String(text || '')
  const chars = ensureCharacterUids(arr(ctx.characters))
  const voices = arr(ctx.voices)
  const chapterNo = Number(ctx.chapterNo) || 0
  const window = ctx.window != null ? ctx.window : 12
  const blockers = []
  const warnings = []
  if (!t || !voices.length || !chars.length) return { blockers, warnings, scanned: 0 }

  // 独占签名：某短语被【恰好一个】角色登记 → 只认这种做门禁（共享词/通用代词自动出局，杜绝误伤）
  const cpOwners = new Map()
  const srOwners = new Map()
  for (const v of voices) {
    for (const p of v.catchphrases) cpOwners.set(p, (cpOwners.get(p) || []).concat(v.uid))
    for (const r of v.selfRef) srOwners.set(r, (srOwners.get(r) || []).concat(v.uid))
  }
  const exclCp = [...cpOwners.entries()].filter(([p, u]) => u.length === 1 && p.length >= 2).map(([p, u]) => ({ phrase: p, ownerUid: u[0] }))
  const exclSr = [...srOwners.entries()].filter(([r, u]) => u.length === 1 && !GENERIC_SELFREF.includes(r)).map(([r, u]) => ({ phrase: r, ownerUid: u[0] }))
  if (!exclCp.length && !exclSr.length) return { blockers, warnings, scanned: 0 }

  const nameByUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c.name]))
  const quotes = attributeQuotes(t, chars, window)
  const at = chapterNo ? `（第 ${chapterNo} 章）` : ''
  for (const q of quotes) {
    // 仿拟护栏：说话动词前后一段出现「模仿 / 戏仿」语境 → 本处串味/漂移降级为提醒
    const around = t.slice(Math.max(0, q.at - window * 2), q.closeIdx < 0 ? q.at + 60 : q.closeIdx + window)
    const mimic = MIMIC_RE.test(around)
    const push = (rec) => {
      if (mimic) warnings.push({ severity: 'finding', ...rec, what: `${rec.what}（疑似仿拟语境，已降级为提醒）` })
      else blockers.push({ severity: 'blocker', ...rec })
    }
    for (const { phrase, ownerUid } of exclCp) {
      if (ownerUid === q.uid || !q.line.includes(phrase)) continue
      const oName = nameByUid.get(ownerUid) || '另一角色'
      push({
        category: '角色声音穿帮',
        kind: '台词串味',
        uid: q.uid,
        name: q.name,
        phrase,
        ownerUid,
        ownerName: oName,
        where: `「${q.line.slice(0, 14)}…」处`,
        what: `「${q.name}」的台词里出现了「${oName}」的专属口头禅「${phrase}」${at}：角色声音串味（AI 写久常见的 OOC 漂移）`,
        fix_hint: `「${phrase}」是「${oName}」的专属签名，不该从「${q.name}」口中说出。改写为符合「${q.name}」自己声口的表达；若确为故意模仿，请在旁白点明（如「学着${oName}的腔调」），系统会自动降级为提醒。`,
      })
    }
    for (const { phrase, ownerUid } of exclSr) {
      if (ownerUid === q.uid || !q.line.includes(phrase)) continue
      const oName = nameByUid.get(ownerUid) || '另一角色'
      push({
        category: '角色声音穿帮',
        kind: '自称漂移',
        uid: q.uid,
        name: q.name,
        phrase,
        ownerUid,
        ownerName: oName,
        where: `「${q.line.slice(0, 14)}…」处`,
        what: `「${q.name}」在台词里自称「${phrase}」，而这是「${oName}」的专属自称${at}：身份/声口错乱`,
        fix_hint: `「${phrase}」是「${oName}」的专属自称。把「${q.name}」的自称改回其本人登记的说法（在声音档案里为「${q.name}」补上正确自称），或核对说话人是否张冠李戴。`,
      })
    }
  }
  return { blockers, warnings, scanned: quotes.length }
}

// 全书声音门总扫：逐章跑 voiceGate，聚合 blockers（串味/漂移）与 warnings（仿拟降级），供面板红/黄条。
// 只扫已归档章节；返回 {blockers:[{...rec, chapterNo, title}], warnings:[...]}（按章号升序）。
export function scanAllVoiceConflicts(project) {
  const proj = project || {}
  const voices = assembleVoices(proj)
  if (!voices.length) return { blockers: [], warnings: [] }
  const chars = ensureCharacterUids(arr(proj.characters))
  const chapters = arr(proj.chapters).filter((c) => c && typeof c.content === 'string' && c.content.length)
  const blockers = []
  const warnings = []
  for (const ch of chapters) {
    const no = Number(ch.chapterNo) || 0
    const r = voiceGate(ch.content, { voices, characters: chars, chapterNo: no })
    for (const b of r.blockers) blockers.push({ ...b, chapterNo: no, title: ch.title || '' })
    for (const w of r.warnings) warnings.push({ ...w, chapterNo: no, title: ch.title || '' })
  }
  blockers.sort((a, b) => a.chapterNo - b.chapterNo)
  warnings.sort((a, b) => a.chapterNo - b.chapterNo)
  return { blockers, warnings }
}

// 声音蒸馏（对标 novel-distiller「灵魂蒸馏」的确定性精简版）：从现有正文里为每个角色挖【专属签名短语】候选。
// 口径：归因出每个角色的所有台词行 → 统计 2~6 字 n-gram 在【多少不同台词行】里出现 → 只保留
//   ①出现行数 ≥ minLines、②不出现在任何【其他角色】台词里（专属）、③非标点串 的候选 → 极大化去子串 → 按频次取前 maxN。
// 纯前端、零 AI、按需触发（面板「蒸馏候选」按钮）；结果仅供勾选采纳，不自动写库。
export function distillVoices(project, opts = {}) {
  const minLines = opts.minLines != null ? opts.minLines : 2
  const maxN = opts.maxN != null ? opts.maxN : 6
  const proj = project || {}
  const chars = ensureCharacterUids(arr(proj.characters))
  const byUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c]))
  const chapters = arr(proj.chapters).filter((c) => c && typeof c.content === 'string' && c.content.length)
  // 收集每个角色的台词行
  const linesByUid = new Map()
  for (const ch of chapters) {
    for (const q of attributeQuotes(ch.content, chars)) {
      if (!linesByUid.has(q.uid)) linesByUid.set(q.uid, [])
      linesByUid.get(q.uid).push(q.line)
    }
  }
  const uids = [...linesByUid.keys()]
  const out = []
  // n-gram 只取「纯文字」片段：含任何标点/空白的片段跳过，避免候选带上句号（如「有意思。」）
  const HAS_PUNCT = /[，。！？、：；…·\s「」『』“”‘’"'（）()《》—\-]/
  for (const u of uids) {
    const c = byUid.get(u)
    const lines = linesByUid.get(u) || []
    if (!c || !c.name || lines.length < 2) continue
    // n-gram 频率（按「出现在几行」计，同一行内重复只记一次）
    const freq = new Map()
    for (const line of lines) {
      const seen = new Set()
      for (let n = 2; n <= 6; n++) {
        for (let i = 0; i + n <= line.length; i++) {
          const g = line.slice(i, i + n)
          if (HAS_PUNCT.test(g) || seen.has(g)) continue
          seen.add(g)
          freq.set(g, (freq.get(g) || 0) + 1)
        }
      }
    }
    // 其他角色的台词（专属过滤用）
    const otherLines = uids.filter((x) => x !== u).flatMap((x) => linesByUid.get(x) || [])
    const cands = [...freq.entries()]
      .filter(([g, cnt]) => cnt >= minLines && g.trim().length >= 2)
      .filter(([g]) => !otherLines.some((ol) => ol.includes(g)))
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    // 极大化去子串：cands 已按频次、长度降序，被已保留的更长/等频短语包含的短串丢弃
    const kept = []
    for (const [g, cnt] of cands) {
      if (kept.some(([k]) => k.includes(g))) continue
      kept.push([g, cnt])
      if (kept.length >= maxN) break
    }
    if (kept.length) out.push({ uid: u, name: c.name, candidates: kept.map(([phrase, count]) => ({ phrase, count })) })
  }
  return out
}
