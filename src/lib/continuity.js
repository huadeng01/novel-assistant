// 连贯性硬约束系统（移植自 NarraCat「写时硬约束」三机制，纯前端零依赖 · 叶子模块）
// 设计原则：本模块不 import longform.js（避免循环依赖），只暴露纯函数；由 longform.js/prompts.js 接线消费。
// 三机制：① canonical 人物 UID + entity-match（最长非重叠实体匹配 + 说话者状态门）
//         ② 受控谓词事实库（双时态）+ 写时校验（validateFact / commitFacts）
//         ③ continuity-editor 式 5 类客观错误硬门控 + 伏笔终局必收
// 证据锚：NarraCat ADR-0012（uid 是 canonical 身份、随机 UUID 不由名字派生）、
//         handlers/entity-match.ts（最长非重叠 + canonical 去重）、CONTEXT.md 术语「受控谓词/双层审校」。

// ==================== 机制一：canonical 人物 UID + entity-match ====================

// uid 铸造：随机、一次分配永不变、【不从名字派生】。
// 纠偏说明：交接提示词原写「由 name+aliases 确定性哈希铸造」，但其自身验收要求「两个同名『干瘦老头』分配不同 uid」——
// 名字哈希会让同名角色撞成同一 uid，直接违背验收。故采纳 NarraCat ADR-0012：随机 UUID v4，铸造权唯一、LLM 不得编造。
// 纯前端安全上下文（localhost/https）下 crypto.randomUUID 可用；非安全上下文降级到手写随机（仍不与名字相关）。
export function mintUid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* 降级 */
  }
  const hex = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 32; i++) {
    s += hex[Math.floor(Math.random() * 16)]
    if (i === 7 || i === 11 || i === 15 || i === 19) s += '-'
  }
  return s
}

// 别名归一：aliases 可能是数组（手动登记）或逗号分隔字符串（成书/导入写入），统一转去空数组。
// 与 longform.js 的 aliasesOf 同口径（本模块自带副本以保持叶子性，避免循环 import）。
export function charAliases(c) {
  if (Array.isArray(c?.aliases)) return c.aliases.map((a) => String(a).trim()).filter(Boolean)
  if (typeof c?.aliases === 'string' && c.aliases.trim()) return c.aliases.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  return []
}

// 缺 uid 的人物补铸（迁移既有档案 / 新人物入档时调用）：一次分配永不变，已有 uid 原样保留。
// 返回新数组（不改入参），每项确保有非空 uid。
export function ensureCharacterUids(characters) {
  return (Array.isArray(characters) ? characters : []).map((c) => {
    if (!c || typeof c !== 'object') return c
    if (c.uid) return c
    return { ...c, uid: mintUid() }
  })
}

// 受控状态位默认值：alive（alive/dying/dead）、canSpeak（bool）、location、mutableInjuries（部位→状态）。
// 只在字段缺失时补默认，不覆盖作者/归档已写入的值。
export function withStateBits(c) {
  if (!c || typeof c !== 'object') return c
  const out = { ...c }
  if (!out.uid) out.uid = mintUid()
  if (!('alive' in out)) out.alive = 'alive'
  if (!('canSpeak' in out)) out.canSpeak = true
  if (!('location' in out)) out.location = ''
  if (!out.mutableInjuries || typeof out.mutableInjuries !== 'object') out.mutableInjuries = {}
  return out
}

// 构建实体名索引（entity-match 预备阶段）：把每个人物的本名 + 别名摊平成 {surface, uid, canonical} 条目，
// 按 surface 字符长度【降序】排序（长名先扫，短名不得占据长名已占的 span）；单字名（<minLen）不参与，误匹配率过高。
// 同一 surface 映射到多个 uid（两个同名角色）→ 记入 ambiguousSurfaces，匹配结果标 ambiguous=true（字符串无法独断归属）。
export function buildNameIndex(characters, minLen = 2) {
  const chars = ensureCharacterUids(characters)
  const entries = []
  const surfaceUids = new Map()
  for (const c of chars) {
    if (!c || !c.uid) continue
    const canonical = String(c.name || '').trim()
    const surfaces = new Set()
    if (canonical) surfaces.add(canonical)
    for (const a of charAliases(c)) surfaces.add(a)
    for (const s of surfaces) {
      if (s.length < minLen) continue
      entries.push({ surface: s, uid: c.uid, canonical: canonical || s })
      if (!surfaceUids.has(s)) surfaceUids.set(s, new Set())
      surfaceUids.get(s).add(c.uid)
    }
  }
  entries.sort((a, b) => b.surface.length - a.surface.length)
  const ambiguousSurfaces = new Set()
  for (const [s, uids] of surfaceUids) if (uids.size > 1) ambiguousSurfaces.add(s)
  return { entries, ambiguousSurfaces }
}

// 最长非重叠实体匹配（移植 NarraCat entity-match.ts）：返回正文中所有被识别实体的出现，
// 每条 {uid, canonical, surface, start, end, ambiguous}，按 start 升序。
// 算法：长名先扫并占据 [start,end) 的字符（occupied），短名再扫到重叠位置时整段作废——
//   故「林晚晴」不被「林晚」误命中、「洗髓阁管事」不被「管事」误命中；短名在其它未占据位置仍可独立命中。
// from = idx + 1（非 idx + surface.length）：同名多次出现都要扫到；occupied「整段全空才占」防跨边界插入。
export function matchEntities(text, characters, opts = {}) {
  const t = String(text || '')
  const minLen = opts.minLen != null ? opts.minLen : 2
  if (!t) return []
  const { entries, ambiguousSurfaces } = buildNameIndex(characters, minLen)
  if (!entries.length) return []
  const occupied = new Array(t.length).fill(false)
  const matches = []
  for (const e of entries) {
    const L = e.surface.length
    let from = 0
    let idx
    while ((idx = t.indexOf(e.surface, from)) !== -1) {
      let free = true
      for (let k = idx; k < idx + L; k++) {
        if (occupied[k]) {
          free = false
          break
        }
      }
      if (free) {
        for (let k = idx; k < idx + L; k++) occupied[k] = true
        matches.push({
          uid: e.uid,
          canonical: e.canonical,
          surface: e.surface,
          start: idx,
          end: idx + L,
          ambiguous: ambiguousSurfaces.has(e.surface),
        })
      }
      from = idx + 1
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  return matches
}

// 按 uid 去重的实体清单（首见优先，长名天然先入表）：供「本章出场人物」统计。
export function uniqueEntities(matches) {
  const byUid = new Map()
  for (const m of matches || []) if (!byUid.has(m.uid)) byUid.set(m.uid, m)
  return [...byUid.values()]
}

// 说话动词（含「道」体系与强动作归因）：用于定位「谁说了这句台词」。
// 说道/问道/答道 属正常归因；吼道/嘶吼/喝道 等强动作也纳入——死者或哑巴无论用哪个动词开口都判 blocker。
const SPEECH_VERB_RE = /(说道|吼道|问道|答道|叫道|喊道|喝道|笑道|怒道|哭道|叹道|冷笑道|嘶吼道|低语道|嘟囔道|喃喃道|厉声道|沉声道|说|道|吼|问|答|叫|喊|喝|嚷)[：:，,]?\s*[\u201C"\u300C\u2018']/g

// 说话者状态门（机制一验收核心）：定位每处「说话归因」，用 entity-match 解析说话实体 uid，
// 若该 uid 命中 alive==='dead'（死者开口）或 canSpeak===false（哑巴开口）→ 判 blocker。
// 说话者解析：对每个「动词+引号」位置 p，取其前方 window 字内、end≤p 且离 p 最近的实体为说话者。
// 返回 {blockers:[{category,severity,uid,name,where,what,fix_hint}], scanned}。
export function speakerStateScan(text, characters, opts = {}) {
  const t = String(text || '')
  const window = opts.window != null ? opts.window : 12
  const chars = ensureCharacterUids(characters)
  const byUid = new Map(chars.filter((c) => c && c.uid).map((c) => [c.uid, c]))
  const matches = matchEntities(t, chars, opts)
  const blockers = []
  if (!t || !matches.length) return { blockers, scanned: 0 }
  SPEECH_VERB_RE.lastIndex = 0
  let m
  let scanned = 0
  while ((m = SPEECH_VERB_RE.exec(t)) !== null) {
    const p = m.index // 动词起点
    // 找 p 前方最近的实体（其 end 落在 [p-window, p] 内）作为说话者
    let speaker = null
    for (const e of matches) {
      if (e.end <= p && p - e.end <= window) {
        if (!speaker || e.end > speaker.end) speaker = e
      }
      if (e.start > p) break
    }
    if (!speaker) continue
    scanned++
    const c = byUid.get(speaker.uid)
    if (!c) continue
    const dead = c.alive === 'dead'
    const mute = c.canSpeak === false
    if (!dead && !mute) continue
    const snippet = t.slice(Math.max(0, p - 6), p + 10).replace(/\s+/g, '')
    blockers.push({
      category: dead ? '物理不可能' : '连续性矛盾',
      severity: 'blocker',
      uid: speaker.uid,
      name: c.name || speaker.canonical,
      where: `「${snippet}…」处`,
      what: dead
        ? `已死亡角色「${c.name || speaker.canonical}」在本章开口说话（死者复活穿帮）`
        : `被设定为不能说话（canSpeak=false）的角色「${c.name || speaker.canonical}」在本章开口`,
      fix_hint: dead
        ? `删除或改写该句台词：死者不得开口；若确需「声音」，改为他人转述、回忆闪回或明确标注为幻觉/梦境。`
        : `该角色不能说话，把台词改为动作/神态/他人代述，或先在档案解除 canSpeak=false 限制。`,
    })
  }
  return { blockers, scanned }
}

// ==================== 机制二：受控谓词事实库（双时态）+ 写时校验 ====================

// 受控谓词闭合表（12 项，移植 NarraCat memory-extraction.json）：写时校验 predicate 必须 ∈ 本表或 x- 前缀扩展。
// 反义（CONTEXT.md「受控谓词」_Avoid_）：free-text predicate / 本体引擎 / 知识图谱引擎——不升级成本体引擎。
export const FACT_PREDICATES = [
  'identity', // 身份
  'location', // 位置
  'possession', // 持有
  'goal', // 目标
  'injury', // 伤势
  'ability', // 能力
  'status', // 状态
  'secret', // 秘密
  'reputation', // 声望
  'oath', // 誓约
  'debt', // 债务
  'relationship', // 关系（subject 用「A|B」字典序归一）
]
// 记忆消费锁谓词：把「某份记忆被用作代价」记为一条 x-consumed 事实（value=记忆签名），再次消费同签名 → 冲突报错。
// 直接治「野猫/饴糖/烤火被吃两次」——同一记忆不得二次消费。
export const CONSUMED_PREDICATE = 'x-consumed'

function isExtensionPredicate(p) {
  return typeof p === 'string' && /^x-[\u4e00-\u9fffa-z0-9_]+$/i.test(p)
}
function isKnownPredicate(p) {
  return FACT_PREDICATES.includes(p) || isExtensionPredicate(p) || p === CONSUMED_PREDICATE
}

// 实际值描述（NarraCat describeActual 同款）：类型前缀 + 截断，供 errors[].actual，防错误响应炸上下文。
function describeActual(v) {
  if (v === undefined) return 'missing'
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  let s
  try {
    s = JSON.stringify(v)
  } catch {
    s = String(v)
  }
  if (s == null) s = String(v)
  if (s.length > 120) s = s.slice(0, 120) + '…'
  return `${t}: ${s}`
}

// 主语解析到 uid（NarraCat 非对称读写：写侧收 name，读侧 uid-first）：给了 uid 用 uid；只给 name 则用别名归一解析。
function resolveSubjectUid(fact, characters) {
  if (fact && fact.uid) return fact.uid
  const nm = String((fact && (fact.subject != null ? fact.subject : fact.name)) || '').trim()
  if (!nm) return null
  const chars = Array.isArray(characters) ? characters : []
  const hit = chars.find((c) => c && (String(c.name || '').trim() === nm || charAliases(c).includes(nm)))
  return hit && hit.uid ? hit.uid : null
}

// 写时校验（无 ajv 的轻量 mini-validator，仿 NarraCat writers.ts 字段级 errors+hint 自修正）。
// 逐条校验 fact 草稿：predicate 闭合表 / value 非空 / 主体可识别 / 双时态合法 / 记忆消费锁。
// errors 阻断该条（走自修正回路），warnings 只回执不阻断（扩展谓词、未建档主体=势力/物件等）。
// 返回 {valid, errors:[{field,expected,actual,hint}], warnings:[{field,message}]}。
export function validateFacts(incoming, ctx = {}) {
  const list = Array.isArray(incoming) ? incoming : []
  const characters = Array.isArray(ctx.characters) ? ctx.characters : []
  const existing = Array.isArray(ctx.existingFacts) ? ctx.existingFacts : []
  const errors = []
  const warnings = []
  list.forEach((f, i) => {
    const at = (field) => `facts.${i}.${field}`
    if (!f || typeof f !== 'object') {
      errors.push({ field: `facts.${i}`, expected: 'object', actual: describeActual(f), hint: '每条 fact 必须是对象 {subject/uid, predicate, value, change_type}' })
      return
    }
    const pred = f.predicate
    if (!pred) {
      errors.push({ field: at('predicate'), expected: `enum ${JSON.stringify(FACT_PREDICATES)} 或 x- 前缀扩展`, actual: 'missing', hint: `必填 predicate 缺失：取 [${FACT_PREDICATES.join(', ')}] 之一，或 x-<自定义短名> 扩展` })
    } else if (!isKnownPredicate(pred)) {
      errors.push({ field: at('predicate'), expected: `enum ${JSON.stringify(FACT_PREDICATES)} 或 x- 前缀`, actual: describeActual(pred), hint: `predicate「${pred}」不在受控谓词闭合表：取 [${FACT_PREDICATES.join(', ')}] 之一；确需扩展用 x- 前缀（如 x-${pred}）` })
    } else if (isExtensionPredicate(pred)) {
      warnings.push({ field: at('predicate'), message: `使用扩展谓词「${pred}」（非 12 受控谓词），已放行但记录在案` })
    }
    const val = f.value != null ? f.value : f.object
    if (val == null || String(val).trim() === '') {
      errors.push({ field: at('value'), expected: 'non-empty string', actual: describeActual(val), hint: 'value 必填且非空：一句话具体事实，含关键数字/部位/归属，不要凑字' })
    }
    const subjUid = resolveSubjectUid(f, characters)
    const subjName = String((f.subject != null ? f.subject : f.name) || '').trim()
    if (!subjUid && !subjName) {
      errors.push({ field: at('subject'), expected: 'subject 或 uid 至少其一', actual: 'missing', hint: 'fact 需指明主体：填 subject（人物/势力/物件名）或 uid' })
    } else if (!subjUid && subjName && pred === 'relationship') {
      warnings.push({ field: at('subject'), message: `关系事实主体「${subjName}」未在人物名单建档，该条将被跳过（关系两端都需建档）` })
    } else if (!subjUid && subjName) {
      warnings.push({ field: at('subject'), message: `主体「${subjName}」未建档（可能是势力/物件），照常入库但无 uid` })
    }
    // 记忆消费锁：x-consumed 同一签名二次消费 → 冲突 error
    if (pred === CONSUMED_PREDICATE) {
      const sig = String(val || '').trim()
      const dup = existing.some((e) => e && e.predicate === CONSUMED_PREDICATE && String(e.value || '').trim() === sig && (e.validTo == null))
      if (dup) {
        errors.push({ field: at('value'), expected: '未被消费过的记忆签名', actual: describeActual(sig), hint: `记忆「${sig}」已作为代价被消费过（x-consumed 锁生效）：同一记忆不得二次消费，请改用新的代价，或先撤销前次消费` })
      }
    }
    if (f.validFrom != null && !(Number(f.validFrom) >= 1)) {
      errors.push({ field: at('validFrom'), expected: 'integer ≥1', actual: describeActual(f.validFrom), hint: 'validFrom 若填写须为 ≥1 的章号（生效章）' })
    }
  })
  return { valid: errors.length === 0, errors, warnings }
}

// 双时态事实提交（事务性，移植 NarraCat facts 失效链）：新值不覆盖旧值，而是关闭旧区间（写 validTo）再立新条。
// 逐条处理：校验失败的条跳过（记 rejected，含字段级 errors 供自修正），通过的入库；消费锁冲突条被拒。
// changeType：new（新事实）/ update（关闭同键 active 旧值 + 立新值）/ invalidate（仅关闭旧值不立新值）。
// 返回 {facts:新数组, applied, rejected:[{index,fact,errors}], errors, warnings}。
export function commitFacts(existingFacts, incoming, chapterNo, opts = {}) {
  const ch = Number(chapterNo) || 0
  const facts = (Array.isArray(existingFacts) ? existingFacts : []).map((f) => ({ ...f }))
  const characters = Array.isArray(opts.characters) ? opts.characters : []
  const { errors, warnings } = validateFacts(incoming, { characters, existingFacts: facts, chapterNo: ch })
  const list = Array.isArray(incoming) ? incoming : []
  let applied = 0
  const rejected = []
  list.forEach((f, i) => {
    const own = errors.filter((e) => e.field === `facts.${i}` || e.field.startsWith(`facts.${i}.`))
    if (own.length) {
      rejected.push({ index: i, fact: f, errors: own })
      return
    }
    const pred = f.predicate
    const val = String(f.value != null ? f.value : f.object || '').trim()
    const subjUid = resolveSubjectUid(f, characters)
    const subjName = String((f.subject != null ? f.subject : f.name) || '').trim()
    const changeType = f.changeType || f.change_type || 'new'
    const upsertKey = f.upsertKey || f.upsert_key || null
    const findActive = () => {
      const cand = facts.filter(
        (e) =>
          e &&
          e.validTo == null &&
          e.predicate === pred &&
          (upsertKey ? e.id === upsertKey : subjUid ? e.uid === subjUid : (e.subject || '') === subjName),
      )
      cand.sort((a, b) => (b.validFrom || 0) - (a.validFrom || 0))
      return cand[0] || null
    }
    if (changeType === 'invalidate') {
      const old = findActive()
      if (old) {
        old.validTo = ch
        old.invalidatedBy = null
        applied++
      } else warnings.push({ field: `facts.${i}`, message: 'invalidate 未命中：没有可失效的旧值，已跳过' })
      return
    }
    let prevId = null
    if (changeType === 'update') {
      const old = findActive()
      if (old) {
        old.validTo = ch
        prevId = old.id
      } else warnings.push({ field: `facts.${i}`, message: 'update 未命中旧值：按新事实入库' })
    }
    const resolvedName = subjName || (subjUid ? (characters.find((c) => c && c.uid === subjUid) || {}).name || '' : '')
    const nf = {
      id: mintUid(),
      uid: subjUid || null,
      subject: resolvedName,
      predicate: pred,
      value: val,
      validFrom: ch,
      validTo: null,
      sourceChapter: ch,
    }
    if (prevId) nf.invalidatedPrev = prevId
    facts.push(nf)
    applied++
  })
  return { facts, applied, rejected, errors, warnings }
}

// 读某章有效的事实（双时态生效区间）：validFrom ≤ ch 且（validTo 为空 或 validTo > ch）。
// 可按 predicate 过滤（单个或数组）。供写作上下文注入与门控检测消费。
export function factsAt(facts, chapterNo, opts = {}) {
  const ch = Number(chapterNo) || 0
  const list = Array.isArray(facts) ? facts : []
  const pf = opts.predicate ? (Array.isArray(opts.predicate) ? opts.predicate : [opts.predicate]) : null
  return list.filter((f) => {
    if (!f) return false
    if (f.validFrom != null && f.validFrom > ch) return false
    if (f.validTo != null && f.validTo <= ch) return false
    if (pf && !pf.includes(f.predicate)) return false
    return true
  })
}

// 肢体家族：同一家族的成员共享「是否可用」——左臂断了，左手/左掌也不能发力（伤势部位矛盾检测用）。
const LIMB_FAMILY = {
  左臂: 'left-arm', 左手臂: 'left-arm', 左胳膊: 'left-arm', 左手: 'left-arm', 左掌: 'left-arm', 左腕: 'left-arm',
  右臂: 'right-arm', 右手臂: 'right-arm', 右胳膊: 'right-arm', 右手: 'right-arm', 右掌: 'right-arm', 右腕: 'right-arm',
  左腿: 'left-leg', 左小腿: 'left-leg', 左脚: 'left-leg', 左足: 'left-leg',
  右腿: 'right-leg', 右小腿: 'right-leg', 右脚: 'right-leg', 右足: 'right-leg',
}
const LOSS_MARKER = /(断|失|废|斩|截|缺|断茬|齐肘|齐腕|不见了|没了|空空|无)/
const LIMB_ACTION_VERB = '(攥|握|抓|挥|举|抬|撑|推|拉|按|捏|拎|提|执|持|抚|拍|指|弹|搓|扼|掐|扣|戳)'

// 伤势部位矛盾 / 物理不可能门（机制二验收②）：从 characters[].mutableInjuries 与 injury 事实收集「已残废/缺失的肢体」，
// 若正文让同家族肢体完成需其健全的动作（如左臂断茬却「左手五指攥笔」）→ 判 blocker。
export function injuryContradictionScan(text, ctx = {}) {
  const t = String(text || '')
  if (!t) return { blockers: [] }
  const characters = Array.isArray(ctx.characters) ? ctx.characters : []
  const facts = Array.isArray(ctx.facts) ? ctx.facts : []
  const ch = ctx.chapterNo != null ? ctx.chapterNo : Number.MAX_SAFE_INTEGER
  const severed = []
  for (const c of characters) {
    if (!c) continue
    const inj = c.mutableInjuries && typeof c.mutableInjuries === 'object' ? c.mutableInjuries : {}
    for (const part of Object.keys(inj)) {
      const fam = LIMB_FAMILY[part]
      if (fam && LOSS_MARKER.test(String(inj[part]))) severed.push({ uid: c.uid || null, name: c.name || '', part, family: fam, evidence: `${part}=${inj[part]}` })
    }
  }
  for (const f of factsAt(facts, ch, { predicate: 'injury' })) {
    const v = String(f.value || '')
    for (const part of Object.keys(LIMB_FAMILY)) {
      if (v.includes(part) && LOSS_MARKER.test(v)) severed.push({ uid: f.uid || null, name: f.subject || '', part, family: LIMB_FAMILY[part], evidence: v })
    }
  }
  const blockers = []
  const seen = new Set()
  for (const s of severed) {
    for (const member of Object.keys(LIMB_FAMILY)) {
      if (LIMB_FAMILY[member] !== s.family) continue
      const re = new RegExp(member + '[^。，；！？\n]{0,4}' + LIMB_ACTION_VERB, 'g')
      const m = re.exec(t)
      if (!m) continue
      const key = s.uid + '|' + member
      if (seen.has(key)) continue
      seen.add(key)
      const snippet = t.slice(Math.max(0, m.index - 4), m.index + m[0].length + 4).replace(/\s+/g, '')
      blockers.push({
        category: '物理不可能',
        severity: 'blocker',
        uid: s.uid,
        name: s.name,
        where: `「${snippet}…」处`,
        what: `角色「${s.name}」的${s.evidence}（已残废/缺失），正文却让同侧肢体「${member}」完成动作「${m[0]}」（伤势部位矛盾/物理不可能）`,
        fix_hint: `删除或改写该动作：${s.part}已废，不能再用${member}发力；改用另一侧肢体、他人协助，或明确标注为幻觉/回忆。`,
      })
    }
  }
  return { blockers }
}

// 金手指规则结构化审计（机制二）：bible.powerRules[] 每条带受控字段 {id,name,trigger,consequence,mustPayoff,payoffDone}。
// 逐章检测：正文触发了某规则的 trigger 却无对应 consequence（如「镇钥见天日」却无后果）→ 设定违背 blocker。
export function powerRuleAudit(text, powerRules) {
  const t = String(text || '')
  const rules = Array.isArray(powerRules) ? powerRules : []
  const blockers = []
  if (!t) return { blockers }
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue
    const trigger = String(r.trigger || '').trim()
    const consequence = String(r.consequence || '').trim()
    if (!trigger || !t.includes(trigger)) continue
    if (consequence && !t.includes(consequence)) {
      blockers.push({
        category: '设定违背',
        severity: 'blocker',
        ruleId: r.id || r.name || '',
        where: `「…${trigger}…」处`,
        what: `触发金手指规则「${r.name || r.id || trigger}」（${trigger}）却未写出对应后果（${consequence}），违反受控设定（金手指不得黑箱）`,
        fix_hint: `补上该规则的后果「${consequence}」，或删除触发描写「${trigger}」；金手指规则为硬约束，触发必付代价。`,
      })
    }
  }
  return { blockers }
}

// 未兑现的金手指 payoff（mustPayoff=true 但 payoffDone≠true）：结局门用（机制二验收③ / 机制三断更防护）。
export function unpaidPowerRules(powerRules) {
  return (Array.isArray(powerRules) ? powerRules : []).filter((r) => r && r.mustPayoff === true && r.payoffDone !== true)
}

// ==================== 机制三：continuity-editor 式 5 类客观错误硬门控 + 伏笔终局必收 ====================

// 跨章 verbatim 复读检测（机制三）：新章 vs 上一章全文的 n-gram 指纹比对，命中 ≥minLen 字逐字重复 → blocker。
// 把 dedupeChapterTail（仅章尾）升级为跨章逐字比对，治 ch2/3、ch8/9、ch22/23、ch40/41 复读。
// 算法（O(n) 滑窗指纹，避开 O(n×m) LCS）：上一章所有 gram 字滑窗入指纹集，扫新章连续命中窗口的最长 run。
export function crossChapterDupScan(newText, prevText, opts = {}) {
  const minLen = opts.minLen != null ? opts.minLen : 50
  const gram = opts.gram != null ? opts.gram : 20
  const a = String(newText || '').replace(/\s+/g, '')
  const b = String(prevText || '').replace(/\s+/g, '')
  if (a.length < gram || b.length < gram) return { blockers: [], maxDup: 0, dupText: '' }
  const fingerprints = new Set()
  for (let i = 0; i + gram <= b.length; i++) fingerprints.add(b.slice(i, i + gram))
  let bestStart = -1
  let bestRun = 0
  let runStart = -1
  let run = 0
  for (let i = 0; i + gram <= a.length; i++) {
    if (fingerprints.has(a.slice(i, i + gram))) {
      if (runStart < 0) runStart = i
      run++
    } else {
      if (run > bestRun) {
        bestRun = run
        bestStart = runStart
      }
      runStart = -1
      run = 0
    }
  }
  if (run > bestRun) {
    bestRun = run
    bestStart = runStart
  }
  const dupLen = bestRun > 0 ? bestRun + gram - 1 : 0
  if (dupLen >= minLen && bestStart >= 0) {
    const dupText = a.slice(bestStart, bestStart + dupLen)
    const exact = b.includes(dupText)
    return {
      blockers: [
        {
          category: '连续性矛盾',
          severity: 'blocker',
          where: `本章与上一章存在 ${dupLen} 字逐字重复段`,
          what: `跨章 verbatim 复读：与上一章有连续 ${dupLen} 字${exact ? '完全相同' : '高度重合'}（复读机事故，非有意排比/回环）`,
          fix_hint: `删除或改写这段与上一章逐字重复的内容（「${dupText.slice(0, 30)}…」），改为推进新剧情，不得整段复读上一章。`,
          dupLen,
        },
      ],
      maxDup: dupLen,
      dupText,
    }
  }
  return { blockers: [], maxDup: dupLen, dupText: dupLen >= gram && bestStart >= 0 ? a.slice(bestStart, bestStart + dupLen) : '' }
}

// run-on 巨段扫描（机制三）：单段字数 > maxLen → finding（强制分段）。治第11章1段5871字。
// 与 runOnResidualScan（句内无标点长串）互补：本项管「整段过长」，severity=finding（不阻断，但强制提示分段）。
export function runOnParagraphScan(text, opts = {}) {
  const maxLen = opts.maxLen != null ? opts.maxLen : 1200
  const paras = String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const findings = []
  let maxParaLen = 0
  for (const p of paras) {
    const len = p.replace(/\s+/g, '').length
    if (len > maxParaLen) maxParaLen = len
    if (len > maxLen) {
      findings.push({
        category: 'run-on巨段',
        severity: 'finding',
        where: `某段 ${len} 字`,
        what: `单段 ${len} 字超过阈值 ${maxLen}（run-on 巨段，阅读疲劳）`,
        fix_hint: `把这段 ${len} 字拆成多个自然段（按动作/对话/场景切换断段），每段建议 ≤${maxLen} 字。`,
        len,
      })
    }
  }
  return { findings, maxParaLen }
}

// 伏笔终局必收门（机制三验收②）：进入最终卷/结局章前，扫描所有 status≠已回收的伏笔 + 未兑现金手指 payoff，
// 未闭合 → 阻断结局生成并输出「待收清单」。治帷帽客/铜钱/爷爷身份/剥离残卷烂尾 + 金手指 payoff 断更。
export function foreshadowEndgameGate(project, opts = {}) {
  const proj = project || {}
  const foreshadows = Array.isArray(proj.foreshadows) ? proj.foreshadows : []
  const powerRules = proj.bible && Array.isArray(proj.bible.powerRules) ? proj.bible.powerRules : Array.isArray(opts.powerRules) ? opts.powerRules : []
  const unresolved = foreshadows.filter((f) => f && f.status !== '已回收')
  const unpaid = unpaidPowerRules(powerRules)
  const dueList = [
    ...unresolved.map((f) => ({ kind: 'foreshadow', id: f.id, content: f.content, plantedChapter: f.plantedChapter || null, status: f.status || '未回收', importance: f.importance || '', tier: f.tier || '' })),
    ...unpaid.map((r) => ({ kind: 'powerRule', id: r.id || r.name || '', content: `金手指规则「${r.name || r.id}」的 payoff（mustPayoff）尚未兑现`, mustPayoff: true })),
  ]
  const blocked = dueList.length > 0
  return {
    blocked,
    dueList,
    unresolvedCount: unresolved.length,
    unpaidRuleCount: unpaid.length,
    reason: blocked
      ? `进入结局前存在 ${dueList.length} 项未闭合（${unresolved.length} 条未回收伏笔 + ${unpaid.length} 条未兑现金手指规则），必须先收束再写最终章`
      : '所有伏笔与金手指 payoff 已闭合，可写结局',
  }
}

// 收束规划（机制三断更防护，仿 outline-architect 的 must_deliver）：列出所有开放线（伏笔 + 人物生死 + 核心悬念 + 金手指 payoff），
// 为每条安排 payoff beat，全部闭合才允许写最后一章。治 L996 高潮断更。
export function closurePlan(project, opts = {}) {
  const proj = project || {}
  const gate = foreshadowEndgameGate(proj, opts)
  const characters = Array.isArray(proj.characters) ? proj.characters : []
  const dyingChars = characters
    .filter((c) => c && c.alive === 'dying')
    .map((c) => ({ kind: 'character', id: c.uid || c.name, content: `角色「${c.name}」处于 dying 状态，生死线需收束` }))
  const openStorylines = (Array.isArray(proj.storylines) ? proj.storylines : [])
    .filter((s) => s && s.progress && !/完结|收束|已了结|已回收/.test(String(s.progress)))
    .map((s) => ({ kind: 'storyline', id: s.name, content: `故事线「${s.name}」(${s.type})未收束：${s.progress}` }))
  const beats = [...gate.dueList, ...dyingChars, ...openStorylines]
  return {
    open: beats,
    allClosed: beats.length === 0,
    count: beats.length,
    message:
      beats.length === 0
        ? '所有开放线已闭合，可写最终章'
        : `收束规划：${beats.length} 条开放线需各安排 payoff beat 后才允许写最后一章（伏笔 ${gate.unresolvedCount} / 金手指 ${gate.unpaidRuleCount} / 生死 ${dyingChars.length} / 故事线 ${openStorylines.length}）`,
  }
}

// 审校报告组装（移植 NarraCat review-report.json）：verdict 由代码按 blocker 数量硬算，【不由 LLM 自由裁量】。
// verdict = blockers.length>0 ? 'fail' : 'pass'；ok = 无 blocker。blockers 阻断入库，findings/notes 只回执不阻断。
export function assembleReview(input = {}) {
  const blockers = Array.isArray(input.blockers) ? input.blockers : []
  const findings = Array.isArray(input.findings) ? input.findings : []
  const notes = Array.isArray(input.notes) ? input.notes : []
  return {
    ok: blockers.length === 0,
    verdict: blockers.length > 0 ? 'fail' : 'pass',
    blockers,
    findings,
    notes,
    counts: { blockers: blockers.length, findings: findings.length, notes: notes.length },
  }
}
