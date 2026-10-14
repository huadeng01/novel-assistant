// 文风活簇——从 longform.js 抽出（暗箱流水线废弃处置 A）。
// 页面层（WizardPage/useLibrary/RevisePage/ContinuePage）真正使用的 longform 部分即此文件。
// longform.js 通过 `export * from './style.js'` re-export，保证既有 import 不断。
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { benchmarkRefOf } from './worldviews/index.js'

// ==================== habits 配额常量 ====================
const HABIT_SKIN_QUOTA = 3
const HABIT_BUDGET = 8
const HABIT_TOTAL_MAX = 12
// 带长度数值区间（「N~M 字」）的 habit 判据：dedupDims 时同维度只留 skin 那一份。
const HABIT_LEN_BAND_RE = /\d+\s*[~～]\s*\d+\s*字/

function habitsOfRec(s) {
  return (Array.isArray(s.habits) ? s.habits : []).map((h) => String(h).trim()).filter(Boolean)
}

// 跨源拼 habits：skin 书取 HABIT_SKIN_QUOTA 条排最前，其余每本按配额各取；forbidden 不在此处（见 blendStyles）。
// opts.genreSkin 命中时 habits 整份取该题材 preset 自己的；opts.dedupDims 为真时借来条目里带长度数值区间的跳过。
function blendHabits(recs, skin, opts = {}) {
  if (opts.genreSkin && skin && skin.bookId === opts.genreSkin) {
    const own = []
    const seenOwn = new Set()
    for (const h of habitsOfRec(skin)) {
      if (own.length >= HABIT_BUDGET) break
      if (seenOwn.has(h)) continue
      seenOwn.add(h)
      own.push(h)
    }
    if (own.length) return own
  }
  const others = recs.filter((s) => s !== skin)
  const quota = Math.max(1, Math.ceil((HABIT_BUDGET - HABIT_SKIN_QUOTA) / Math.max(1, others.length)))
  const out = []
  const seen = new Set()
  const push = (list, k, isSkin) => {
    let taken = 0
    for (const h of list) {
      if (taken >= k || out.length >= HABIT_TOTAL_MAX) return
      if (seen.has(h)) continue
      if (opts.dedupDims && !isSkin && HABIT_LEN_BAND_RE.test(h)) continue
      seen.add(h)
      out.push(h)
      taken++
    }
  }
  push(habitsOfRec(skin), HABIT_SKIN_QUOTA, true)
  for (const s of others) push(habitsOfRec(s), quota, false)
  return out
}

// 多本文风档案融合成一个混合文风：habits 按来源书配额取，forbidden 跨全体档案并集去重，profile/samples 择一（主导嗓音）。
// 主导嗓音优先：skin 池优先取 origin==='user' 子集；无用户书时回退全体（预置档案里按 skinScore 择一）。
export function blendStyles(styleRecs, opts = {}) {
  const recs = (Array.isArray(styleRecs) ? styleRecs : []).filter((s) => s && (s.profile || (Array.isArray(s.habits) && s.habits.length)))
  if (!recs.length) return null
  if (recs.length === 1) return recs[0]
  // 池内选「皮肤最丰富」的源为主：profile 最长（权重×2）→ tie 取 samples 最多 → tie 取首个（确定性）。
  // 🔴【任务A bug1：显式 skinScore 覆盖】档案若带数值字段 skinScore，直接用它、不再按 profile 文案长度现算。
  //   原因（方案文档 §2.3）：presetStyles 的 profile 曾为「去原书指纹」被改写（用户裁定 feedback-style-profile-no-fingerprint），
  //   profile 字数随之变化，而 skinScore=profile×2+samples段数 会让默认主导嗓音被一次纯文案改写静默改掉
  //   ——实测狐狸精（女频后宫，profile 558 字→score 1119）反超普罗之主（408 字→819），导致 8 个未映射题材
  //   （科幻/军事/都市等）+ genre 空路径全被灌女频后宫嗓音。给预置档案写死一个与文案长度解耦的 skinScore，
  //   恢复改写前的既定排序（普罗之主最高），文案再改也不会漂移默认嗓音。用户蒸馏档无此字段→仍按现算口径。
  const skinScore = (s) => (typeof s.skinScore === 'number' && Number.isFinite(s.skinScore)
    ? s.skinScore
    : String(s.profile || '').length * 2 + (Array.isArray(s.samples) ? s.samples.filter((x) => typeof x === 'string' && x.trim()).length : 0))
  const forced = opts.forceSkinBookId ? recs.filter((s) => s.bookId === opts.forceSkinBookId) : []
  const userRecs = recs.filter((s) => s.origin === 'user')
  const skinPool = forced.length ? forced : (userRecs.length ? userRecs : recs)
  let skin = skinPool[0]
  for (let i = 1; i < skinPool.length; i++) if (skinScore(skinPool[i]) > skinScore(skin)) skin = skinPool[i]
  const habits = blendHabits(recs, skin, opts)
  const forbidden = [...new Set(recs.flatMap((s) => (Array.isArray(s.forbidden) ? s.forbidden : []).map((f) => String(f).trim()).filter(Boolean)))]
  const profile = String(skin.profile || '')
  const samples = (Array.isArray(skin.samples) ? skin.samples.filter((x) => typeof x === 'string' && x.trim()) : []).slice(0, 3)
  // metrics/thresholds 跟随主导 skin（与 profile/samples 同源）：skin 已存指纹→沿用；无指纹→用 samples 兜底实时蒸馏；连 samples 都没有→metrics=null，thresholds 回退保守默认。
  const skinBand = skin.metrics ? null : (samples.length ? distillStyleBand(samples.join('\n')) : null)
  const metrics = skin.metrics || (skinBand ? skinBand.metrics : null)
  const thresholds = skin.thresholds || (skinBand ? skinBand.thresholds : metricsToThresholds(metrics))
  const bandReliable = skin.metrics ? !!skin.bandReliable : (skinBand ? skinBand.reliable : false)
  return { bookId: 'blend:' + recs.map((s) => s.bookId).join('+'), origin: 'blend', profile, habits, samples, forbidden, metrics, thresholds, bandReliable, blended: true, skinFrom: skin.bookId || '来源', blendedFrom: recs.map((s) => s.bookId), updatedAt: Date.now() }
}

// 默认文风基调入口：把预置语料（PRESET_STYLES）与用户蒸馏档案在内存合成一个聚合基调，不落库。
export function resolveBaseStyle(userStyles) {
  return blendStyles([...PRESET_STYLES, ...(Array.isArray(userStyles) ? userStyles : [])], { dedupDims: true })
}

// genre → 主导嗓音（skin）的映射。单一出处链：genre ─benchmarkRefOf()→ 语料档案 genreZh ─PRESET_STYLES[].genreZh→ preset bookId。
// 认不出的题材（自定义 / null / 脏数据）返回 matched=false，永不抛错。
export function genreSkinOf(genre, presets = PRESET_STYLES) {
  const g = String(genre == null ? '' : genre).trim()
  const list = Array.isArray(presets) ? presets : []
  if (!g) return { genre: '', genreZh: '', bookId: '', matched: false, note: '未提供题材（genre 为空串/缺失）⟹ 主导嗓音选择不参与题材映射，走既有默认（skinScore 最高者）' }
  const ref = benchmarkRefOf(g)
  if (!ref || !ref.genreZh) {
    return { genre: g, genreZh: '', bookId: '', matched: false, note: `本题材「${g}」在 GENRE_STYLE_TABLE 里没有 benchmark.genreZh（= 六本语料里没有该题材形态的书，或族指向不唯一）⟹ 无对应文风档案` }
  }
  const hit = list.find((s) => s && s.genreZh === ref.genreZh)
  if (!hit || !hit.bookId) {
    return { genre: g, genreZh: ref.genreZh, bookId: '', matched: false, note: `本题材「${g}」对应语料档案 genreZh「${ref.genreZh}」，但传入的档案清单里没有这一本 ⟹ 无对应文风档案` }
  }
  return { genre: g, genreZh: ref.genreZh, bookId: hit.bookId, matched: true, note: `本题材「${g}」→ 语料档案 genreZh「${ref.genreZh}」→ 主导嗓音 ${hit.bookId}《${hit.bookName}》` }
}

// 统一解析「当前生效的文风档案」——把散落的 libStyles.find(styleBookId) 收敛成一处。
//  · styleBookId 命中某档案 → 该书主导 skin，habits 取 3 条排最前，其余各 1 条；此分支刻意完全不看 genre。
//  · styleBookId==='' 或未命中 → 默认预置聚合基调；若传了 genre 且能映射到某本预置档案、且无用户蒸馏档案，那本 preset 顶到主导嗓音位。
// 第三参 genre 缺省 ''；传了就在返回值上多挂一个 genreSkin 留痕对象。
export function resolveStyleRec(styleBookId, libStyles, genre = '') {
  const all = (Array.isArray(libStyles) ? libStyles : []).filter((s) => s && s.bookId)
  const userStyles = all.filter((s) => s.origin === 'user')
  const boundRec = styleBookId ? all.find((s) => s.bookId === styleBookId) : null
  if (boundRec) {
    const seen = new Set()
    const pool = [boundRec, ...PRESET_STYLES, ...userStyles].filter((s) => s && s.bookId && !seen.has(s.bookId) && seen.add(s.bookId))
    return blendStyles(pool, { forceSkinBookId: boundRec.bookId, dedupDims: true }) || boundRec
  }
  const gs = genreSkinOf(genre)
  const useGenreSkin = gs.matched && !userStyles.length ? gs.bookId : ''
  const base = useGenreSkin
    ? blendStyles([...PRESET_STYLES, ...userStyles], { forceSkinBookId: useGenreSkin, genreSkin: useGenreSkin, dedupDims: true })
    : resolveBaseStyle(userStyles)
  const rec = base || {}
  const g = String(genre == null ? '' : genre).trim()
  if (!g) return rec
  const skinFrom = rec.skinFrom || rec.bookId || ''
  const applied = !!useGenreSkin
  const note = applied
    ? gs.note
    : (gs.matched
      ? `本题材「${g}」有对应文风档案 ${gs.bookId}，但池里有 ${userStyles.length} 份用户蒸馏档案 ⟹ 按 blendStyles 的既有设计（用户自带书主导预置基调）不覆盖它；实际主导嗓音 = ${skinFrom}`
      : `${gs.note}；实际回落到默认主导嗓音 = ${skinFrom}`)
  return { ...rec, genreSkin: { genre: g, genreZh: gs.genreZh, bookId: gs.bookId, matched: gs.matched, applied, skinFrom, note } }
}

// 对话动词扫描：检「X说：/X地说：」式扁平归因（AI 高频 tell）。剑来用「道」体系，说道/问道/答道不算穿帮。
// severe=生成端容忍阈：≥severe(默认3) 才判穿帮 over=true。
export function dialogueVerbScan(text, opts = {}) {
  const t = String(text || '')
  const severe = opts.severe != null ? opts.severe : 3
  const shuoRe = /[\u4e00-\u9fa5]{1,3}地?说[：:，,]?\s*[\u201C"\u300C]/g
  const daoRe = /[\u4e00-\u9fa5]{0,4}道[：:，,]?\s*[\u201C"\u300C]/g
  const shuoSamples = t.match(shuoRe) || []
  const daoCount = (t.match(daoRe) || []).length
  return { shuoCount: shuoSamples.length, shuoSamples: [...new Set(shuoSamples)].slice(0, 8), daoCount, over: shuoSamples.length >= severe }
}

export const STYLE_FUNC_WORDS = ['的', '了', '着', '是', '在', '而', '却', '便', '都', '就', '也', '还', '把', '被', '让', '向', '从', '到']
// 参与指纹聚合的数值维度（computeStyleMetrics 的键子集，排除 chars 这类规模量）
export const STYLE_METRIC_KEYS = ['sentMean', 'sentStd', 'longPct', 'paraMedian', 'ultrashortPct', 'comma', 'exclaim', 'question', 'ellipsis', 'emdash', 'shuoRatio', 'daoRatio', 'runOnMax', 'funcWordRatio']
// 各维度中文名（供 UI 漂移面板展示，与 STYLE_METRIC_KEYS 一一对应，单一事实源）
export const STYLE_METRIC_LABELS = { sentMean: '平均句长', sentStd: '句长波动', longPct: '长句占比', paraMedian: '段落中位长', ultrashortPct: '超短段占比', comma: '逗号密度', exclaim: '叹号密度', question: '问号密度', ellipsis: '省略号密度', emdash: '破折号密度', shuoRatio: '「说」引导密度', daoRatio: '「道」引导密度', runOnMax: '最长无停顿串', funcWordRatio: '虚词占比' }

// 单份文本的多维文体计量（点值）。空/纯空白安全返回全零，绝不抛异常。
export function computeStyleMetrics(text) {
  const raw = String(text || '')
  const chars = raw.replace(/\s/g, '').length
  if (!chars) return { chars: 0, sentMean: 0, sentStd: 0, longPct: 0, paraMedian: 0, ultrashortPct: 0, comma: 0, exclaim: 0, question: 0, ellipsis: 0, emdash: 0, shuoRatio: 0, daoRatio: 0, runOnMax: 0, funcWordRatio: 0 }
  const perWan = (n) => +((n / chars) * 10000).toFixed(1)
  // 句：按 。！？… 切，剔过短/过长噪声
  const slens = raw.split(/[。！？…]+/).map((s) => s.replace(/\s/g, '')).filter((s) => s.length > 2 && s.length < 500).map((s) => s.length)
  const sentMean = slens.length ? +(slens.reduce((a, b) => a + b, 0) / slens.length).toFixed(1) : 0
  const sentStd = slens.length > 1 ? +Math.sqrt(slens.reduce((a, b) => a + (b - sentMean) * (b - sentMean), 0) / slens.length).toFixed(1) : 0
  const longPct = slens.length ? +((slens.filter((x) => x >= 40).length / slens.length) * 100).toFixed(1) : 0
  const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 1)
  const plens = paras.map((p) => p.length).sort((a, b) => a - b)
  const paraMedian = plens.length ? plens[Math.floor(plens.length / 2)] : 0
  const ultrashortPct = paras.length ? +((paras.filter((p) => p.length <= 15).length / paras.length) * 100).toFixed(1) : 0
  const isBreak = (ch) => /[。！？；…，、：,.!?;:\s"'‘’“”「」『』()（）《》【】\u2014\-]/.test(ch)
  let runOnMax = 0, run = 0
  for (const ch of raw) { if (isBreak(ch)) { if (run > runOnMax) runOnMax = run; run = 0 } else run++ }
  if (run > runOnMax) runOnMax = run
  const dv = dialogueVerbScan(raw)
  const daoN = (raw.match(/[\u4e00-\u9fa5]{0,4}道[：:，,]?\s*[\u201C"\u300C]/g) || []).length
  const funcN = STYLE_FUNC_WORDS.reduce((a, w) => a + raw.split(w).length - 1, 0)
  return {
    chars, sentMean, sentStd, longPct, paraMedian, ultrashortPct,
    comma: perWan((raw.match(/[，、]/g) || []).length),
    exclaim: perWan((raw.match(/！/g) || []).length),
    question: perWan((raw.match(/？/g) || []).length),
    ellipsis: perWan((raw.match(/……/g) || []).length),
    emdash: perWan((raw.match(/——/g) || []).length),
    shuoRatio: perWan(dv.shuoCount), daoRatio: perWan(daoN),
    runOnMax, funcWordRatio: +((funcN / chars) * 100).toFixed(2),
  }
}

// 指纹 → 本书专属扫描阈值（取代写死的 4/3/60）。metrics 为空时逐项回退保守默认（≈旧剑来口径，零回归）。
export function metricsToThresholds(metrics) {
  const g = (k) => (metrics && metrics[k] && typeof metrics[k].mean === 'number' ? metrics[k].mean : null)
  const emdash = g('emdash'), shuo = g('shuoRatio'), runOn = g('runOnMax')
  const dashMax = emdash != null ? Math.max(2, Math.round((emdash / 10000) * 2000 * 1.5)) : 4
  const dialogueSevere = shuo != null ? (shuo > 20 ? 8 : shuo > 5 ? 5 : 3) : 3
  const runOnMinLen = runOn != null ? Math.max(40, Math.round(runOn * 1.3) + 10) : 60
  return { dashMax, dialogueSevere, runOnMinLen }
}

// 蒸馏增强入口：把采样切窗逐窗算指纹，聚合每维 {mean,std}，并推导 thresholds。
// 返回 { reliable, windowCount, chars, metrics:{key:{mean,std}}, thresholds }。窗口不足（短文本）→ 整体点值、std=0、reliable=false。
export function distillStyleBand(sampleText, opts = {}) {
  const raw = String(sampleText || '')
  const winSize = opts.windowSize || 1200
  const minChars = opts.minChars != null ? opts.minChars : 400
  const totalChars = raw.replace(/\s/g, '').length
  if (!totalChars) return { reliable: false, windowCount: 0, chars: 0, metrics: {}, thresholds: metricsToThresholds(null) }
  // 按段落累积切窗（不切碎句子）
  const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 1)
  const windows = []
  let buf = ''
  for (const p of paras) {
    buf += (buf ? '\n' : '') + p
    if (buf.replace(/\s/g, '').length >= winSize) { windows.push(buf); buf = '' }
  }
  if (buf.replace(/\s/g, '').length >= minChars) windows.push(buf)
  // 窗口 ≥2 才有窗间方差；否则退化为整体单点（std=0）
  const perWin = windows.length >= 2 ? windows.map((w) => computeStyleMetrics(w)) : [computeStyleMetrics(raw)]
  const metrics = {}
  for (const k of STYLE_METRIC_KEYS) {
    const vals = perWin.map((m) => (typeof m[k] === 'number' ? m[k] : 0))
    const mean = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
    const std = vals.length > 1 ? +Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length).toFixed(2) : 0
    metrics[k] = { mean, std }
  }
  const reliable = totalChars >= 1500 && windows.length >= 2
  return { reliable, windowCount: windows.length, chars: totalChars, metrics, thresholds: metricsToThresholds(metrics) }
}
