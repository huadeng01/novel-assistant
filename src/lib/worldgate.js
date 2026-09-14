// P1 世界一致性门：地点/势力升一等实体 + 时序门 + 缺席门 + 外貌一致性。
// 对标 tianming/AI-Novel-Writing-Assistant 的实体图谱与一致性校验，但坚持本项目「零 AI、纯前端、确定性、只报警不阻断」哲学。
// 现状缺口：continuity.buildNameIndex 只索引 characters；势力/物件在 validateFacts 里「未建档无 uid」。
// 本模块把 factions/places 升为可匹配的一等实体，并新增三道客观门。
// 叶子模块：只依赖 continuity.js，不依赖 longform.js（避免循环依赖）。
import { ensureCharacterUids, matchEntities } from './continuity.js'

const arr = (x) => (Array.isArray(x) ? x : [])

// 动作/移动动词：缺席门判断「角色不只是被提到名字，而是在现场活动」。
const ACTION_VERB_RE = /(走|跑|冲|闯|站|坐|跪|躺|扑|挥|抬手|转头|回头|点头|摇头|伸手|握|抓|推|拉|拿|举|踏|奔|掠|闪身|停下|抬头|低头|弯腰|伸手|迈步|进来|出去|来到|抵达|现身)/
// 闪回/虚写标记：命中则说明是回忆/梦境而非真实在场，缺席门降级放行（避免误报）。
const FLASHBACK_RE = /(回忆|回想起|想起|曾经|当年|昔日|梦里|梦中|梦见|幻觉|仿佛|似乎|记忆里|脑海中|浮现)/

// ==================== 一等实体索引（characters + factions + places）====================
// 把人物、势力、地点统一成 matchEntities 可消费的 {uid,name,aliases} 形态，返回合并索引。
// uid 口径：优先用已有 uid/id；否则用稳定合成键 `kind:name`（同名同类视为同一实体，跨章稳定）。
// 返回 {entities:[{uid,name,aliases,kind,firstAppearance,ref}], byUid:Map}。entities 可直接喂 matchEntities。
export function buildEntityIndex(project) {
  const proj = project || {}
  const bible = proj.bible || {}
  const entities = []
  const push = (o, kind) => {
    if (!o) return
    const name = String(o.name || '').trim()
    if (!name) return
    const uid = String(o.uid || o.id || `${kind}:${name}`)
    entities.push({
      uid,
      name,
      aliases: arr(o.aliases).map((a) => String(a || '').trim()).filter(Boolean),
      kind,
      firstAppearance: o.firstAppearance != null ? Number(o.firstAppearance) : null,
      ref: o,
    })
  }
  for (const c of ensureCharacterUids(arr(proj.characters))) push(c, 'character')
  for (const f of arr(bible.factions)) push(f, 'faction')
  for (const p of arr(bible.places)) push(p, 'place')
  const byUid = new Map(entities.map((e) => [e.uid, e]))
  return { entities, byUid }
}

// 一等实体清单（供 UI 编辑势力/地点）：分组返回，character 不在这里（已在人物档案管理）。
export function worldEntities(project) {
  const { entities } = buildEntityIndex(project)
  return entities
    .filter((e) => e.kind !== 'character')
    .map((e) => ({ uid: e.uid, name: e.name, aliases: e.aliases, kind: e.kind, firstAppearance: e.firstAppearance }))
}

// 命中证据：把命中位置前后各 12 字带上，作者一眼看出是哪句触发。
function evidence(t, idx, len = 12) {
  const from = Math.max(0, idx - len)
  const to = Math.min(t.length, idx + len)
  return `${from > 0 ? '…' : ''}${t.slice(from, to).replace(/\s+/g, '')}${to < t.length ? '…' : ''}`
}

// ==================== 时序门：实体不得在「登记首次登场章」之前出现 ====================
// 治「配角/势力/地点在读者还没被介绍前就贸然出现」——长篇常见的登场时序错乱。
// 对每个带 firstAppearance 的实体，若本章号 < firstAppearance 却在正文命中 → warning（可能是合理提前铺垫，交作者判断）。
// 返回 {warnings:[{kind,uid,name,entityKind,firstAppearance,chapterNo,evidence}]}。
export function temporalGate(project, chapterNo, text) {
  const t = String(text || '')
  const no = Number(chapterNo) || 0
  const warnings = []
  if (!t || !no) return { warnings }
  const { entities } = buildEntityIndex(project)
  const timed = entities.filter((e) => e.firstAppearance != null && e.firstAppearance > 0)
  if (!timed.length) return { warnings }
  const matches = matchEntities(t, timed)
  const seen = new Set()
  for (const m of matches) {
    const e = timed.find((x) => x.uid === m.uid)
    if (!e || seen.has(m.uid)) continue
    if (no >= e.firstAppearance) continue // 已达/已过登记登场章：合理
    seen.add(m.uid)
    warnings.push({
      kind: '时序门·提前登场',
      uid: m.uid,
      name: e ? e.name : m.canonical,
      entityKind: e ? e.kind : 'unknown',
      firstAppearance: e ? e.firstAppearance : null,
      chapterNo: no,
      evidence: evidence(t, m.start, 12),
    })
  }
  return { warnings }
}

// ==================== 缺席门：已死亡/已离场角色不得在本章「现身活动」====================
// 补 speakerStateScan 之不足：speakerStateScan 只抓「死者/哑巴开口（台词）」，本门抓「缺席者在现场做动作（非台词）」。
// 缺席判定：alive==='dead'，或 departedAt/absentFrom ≤ 本章号（已离场）。
// 命中条件：缺席者名字出现，且 window 字内有动作/移动动词（真在场活动），且非闪回/虚写语境（回忆/梦/幻觉降级放行）。
// 返回 {blockers:[{category,severity,uid,name,where,what,fix_hint}]}。
export function absenceGate(project, chapterNo, text, opts = {}) {
  const t = String(text || '')
  const no = Number(chapterNo) || 0
  const window = opts.window != null ? opts.window : 16
  const blockers = []
  if (!t || !no) return { blockers }
  const chars = ensureCharacterUids(arr(project && project.characters))
  const absent = chars.filter((c) => {
    if (!c || !c.uid) return false
    if (c.alive === 'dead') return true
    const dep = c.departedAt != null ? Number(c.departedAt) : c.absentFrom != null ? Number(c.absentFrom) : null
    return dep != null && no >= dep
  })
  if (!absent.length) return { blockers }
  const matches = matchEntities(t, absent)
  const reported = new Set()
  for (const m of matches) {
    if (reported.has(m.uid)) continue
    const around = t.slice(Math.max(0, m.start - window), Math.min(t.length, m.end + window))
    if (FLASHBACK_RE.test(around)) continue // 回忆/梦境/幻觉：合理虚写，放行
    if (!ACTION_VERB_RE.test(around)) continue // 只提到名字、没在现场活动：放行（避免误报）
    reported.add(m.uid)
    const c = absent.find((x) => x.uid === m.uid)
    const dead = c && c.alive === 'dead'
    blockers.push({
      category: dead ? '物理不可能' : '连续性矛盾',
      severity: 'blocker',
      uid: m.uid,
      name: c ? c.name || m.canonical : m.canonical,
      where: `「${around.replace(/\s+/g, '').slice(0, 18)}…」处`,
      what: dead
        ? `已死亡角色「${c ? c.name : m.canonical}」在第 ${no} 章现身活动（死者复活穿帮，非台词）`
        : `已离场角色「${c ? c.name : m.canonical}」在第 ${no} 章现身活动，但未记录其返回`,
      fix_hint: dead
        ? `删除该角色的动作描写，或明确标注为回忆/幻觉/他人转述；死者不得在现实场景活动。`
        : `若该角色确已返回，请在档案清除 departedAt/absentFrom 或补一条返回事实；否则改写为不在场。`,
    })
  }
  return { blockers }
}

// ==================== 外貌一致性门：同一角色的外貌特征不得前后矛盾 ====================
// 数据：characters[].appearance = [{trait, value}]（如 [{trait:'发色',value:'黑'},{trait:'瞳色',value:'灰'}]）。
// 词典门（低误报）：对可枚举的性状（发色/瞳色），扫正文里「<颜色>发 / <颜色>瞳|眸|眼」，
// 若命中颜色 ≠ 档案登记的 canonical 值 → warning（可能是染/变/光线，交作者判断，不阻断）。
// 返回 {warnings:[{kind,uid,name,trait,canonical,found,evidence}]}。
const COLOR = '黑|白|银|灰|金|红|赤|棕|褐|紫|蓝|青|绿|墨|霜'
const APPEARANCE_LEXICON = {
  发色: new RegExp(`(${COLOR})(发|鬓|长发|短发|秀发)`, 'g'),
  瞳色: new RegExp(`(${COLOR})(瞳|眸|眼睛|眼|瞳孔|双目)`, 'g'),
}
export function appearanceGate(project, chapterNo, text) {
  const t = String(text || '')
  const warnings = []
  if (!t) return { warnings }
  const chars = ensureCharacterUids(arr(project && project.characters))
  for (const c of chars) {
    if (!c || !c.uid) continue
    const app = arr(c.appearance).filter((a) => a && a.trait && APPEARANCE_LEXICON[a.trait])
    if (!app.length) continue
    // 只在该角色出现的章节段落里查（用名字命中位置做粗定位，降低跨角色误报）
    const nameRe = new RegExp([c.name, ...arr(c.aliases)].filter((s) => s && s.length >= 2).map(escRe).join('|'), 'g')
    const spots = []
    let nm
    while ((nm = nameRe.exec(t)) !== null) spots.push(nm.index)
    if (!spots.length) continue
    for (const a of app) {
      const re = APPEARANCE_LEXICON[a.trait]
      re.lastIndex = 0
      let mm
      const canonical = String(a.value || '').trim()
      while ((mm = re.exec(t)) !== null) {
        const found = mm[1]
        if (!canonical || found === canonical) continue
        // 该外貌命中需落在角色名附近（±40 字）才归属该角色，否则可能是别人的发色
        const near = spots.some((s) => Math.abs(s - mm.index) <= 40)
        if (!near) continue
        warnings.push({
          kind: '外貌一致性',
          uid: c.uid,
          name: c.name || '',
          trait: a.trait,
          canonical,
          found,
          evidence: evidence(t, mm.index, 10),
        })
        break // 同一性状同一角色只报一次
      }
    }
  }
  return { warnings }
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 三道门一次性跑（供归档/审核编排调用）：返回 {blockers, warnings}。
// 加法式：project 未提供对应字段（firstAppearance/departedAt/appearance）时，各门自然为空，零回归。
export function worldGateAll(project, chapterNo, text, opts = {}) {
  const blockers = []
  const warnings = []
  for (const b of absenceGate(project, chapterNo, text, opts).blockers) blockers.push(b)
  for (const w of temporalGate(project, chapterNo, text).warnings) warnings.push(w)
  for (const w of appearanceGate(project, chapterNo, text).warnings) warnings.push(w)
  return { blockers, warnings }
}
