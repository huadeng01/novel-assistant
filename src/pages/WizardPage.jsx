// 新手写作（六步圣经流程）：初始提问 → 小说圣经 → 全书梗概（四层伏笔）→ 卷结构 → 幕结构 → 章名骨架+第1卷细纲 → 对账成书
// 设计要点：
// 1. 真相隔离——圣经真相层（truth）永不进写作上下文，只有线索（clues）可露出；真相仅供审核对照；
// 2. 人物只保留 1~3 个用户固定的"锚点"，不生成全套班底，其余人物由写作归档自然生长（防早露）；
// 3. 四层伏笔（短/中/长/终极）登记时即锚定回收卷，成书时换算为回收章硬边界（根治只有短埋点）；
// 4. 每步独立可编辑、可锁定（锁定项重新生成时不覆盖），进度整体持久化，刷新可续跑。
import { useEffect, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import InspirationModal from '../components/InspirationModal.jsx'
import WorldviewEditor from '../components/WorldviewEditor.jsx'
import { isOverridden, getWorldview, worldviewText, allGenres } from '../lib/worldviews/index.js'
import { chatStream, chatJSON } from '../lib/llm.js'
import {
  GENRES,
  bibleRationalizeMessages,
  bibleFromImportMessages,
  bookWorldviewMessages,
  fullSynopsisMessages,
  volumesPlanMessages,
  actsPlanMessages,
  chapterSkeletonMessages,
  volumeSkeletonMessages,
  volumeOutlineMessages,
} from '../lib/prompts.js'
import { countWords, uid } from '../lib/utils.js'
import { loadWizardState, saveWizardState } from '../lib/backup.js'
import { put } from '../lib/db.js'
import { newProject, BIBLE_TRUTH_KINDS, splitChapters, archiveImportedChapter, cnToNumber, RHYTHM_TEMPLATES, resampleWeights, chaptersByRhythm, volumeRole, ACT_RATIO_GUIDE, renumberPart, parseSkeleton, bibleJsonWithRetry, fallbackVolumeEmotion } from '../lib/longform.js'

const STATE_VERSION = 4
const STEPS = [
  { id: 0, label: '初始提问' },
  { id: 1, label: '小说圣经' },
  { id: 2, label: '全书梗概' },
  { id: 3, label: '卷结构' },
  { id: 4, label: '幕结构' },
  { id: 5, label: '章名与细纲' },
  { id: 6, label: '对账成书' },
]
const TIERS = ['短', '中', '长', '终极']
const TIER_DESC = { 短: '10~20 章回收：日常爽点、小反转', 中: '50~80 章回收：卷中反转、配角秘密', 长: '150~250 章回收：身世、金手指、幕后黑手', 终极: '终卷回收：全书最大秘密，只露蛛丝马迹' }

const DEFAULT_STATE = {
  version: STATE_VERSION,
  step: 0,
  brief: '',
  genre: GENRES[0],
  bookName: '',
  totalWords: 100, // 万字
  volumeCount: 6,
  chapterWords: 2000,
  bible: null, // {fixes, world, powerRules[], truths[…], anchors[…], mapLayers[…], factions[{id,name,desc,rumor,unlockVolume,locked}], conflicts[{id,name,desc,startVolume,endVolume,locked}], locks:{world,powerRules}}
  importText: '',
  importedChapters: [], // [{no,title,text}] 分章预览/已确认
  mainline: '',
  subplots: [],
  foreshadows: [], // {id,content,tier,relatedChars,plannedVolume,hints[{chapter,clue}]}
  rhythm: '快头肥中快尾', // 分卷节奏模板（不均分：开卷短而密/腹地长/收割快）
  volumes: [], // {volumeNo,name,theme,conflict,gain,strategy,endHook,length,startChapter,arc,acts,forbiddenForeshadowIds[]}
  skeleton: '',
  chapterSkeleton: [], // [{chapterNo,title,task}]
  outline: '',
}

// 四幕 → 兼容 parseVolumeArc 的 arc 文本（幕名含起/发展/冲突/落幕，可被弧线坐标系正确归类）
const actsToArc = (acts) => (acts || []).map((a) => `${a.act}(第${a.start}-${a.end}章)`).join('→')

export default function WizardPage({ apiKey, onNeedKey, onOpenLongForm }) {
  const [st, setSt] = useState(() => {
    const saved = loadWizardState()
    // 旧版向导状态格式不兼容时重置（v3 为圣经流程）
    return saved && saved.version === STATE_VERSION ? { ...DEFAULT_STATE, ...saved } : { ...DEFAULT_STATE }
  })
  const [busy, setBusy] = useState('') // 非空 = 生成中的进度文案
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState('')
  const [showInspire, setShowInspire] = useState(false)

  // 进度整体持久化（防抖，避免流式生成时逐字写 localStorage）
  useEffect(() => {
    const t = setTimeout(() => saveWizardState(st), 800)
    return () => clearTimeout(t)
  }, [st])

  const patch = (p) => setSt((s) => ({ ...s, ...p }))
  const patchBible = (p) => setSt((s) => ({ ...s, bible: { ...s.bible, ...p } }))

  // ---------- Step 1 圣经 ----------
  const emptyBible = () => ({ fixes: [], world: '', powerRules: [], truths: BIBLE_TRUTH_KINDS.map((k) => ({ id: uid(), kind: k, truth: '', clues: [], locked: false })), anchors: [], mapLayers: [], factions: [], conflicts: [], locks: { world: false, powerRules: false } })

  // 把 AI 产出并入圣经：锁定项一律保留旧值（用户改过并锁定的内容不被覆盖）
  const mergeBible = (old, res) => {
    const b = old || emptyBible()
    const next = { ...b }
    if (!b.locks?.world) next.world = String(res.world || b.world || '')
    if (!b.locks?.powerRules && Array.isArray(res.power_rules) && res.power_rules.length) next.powerRules = res.power_rules.filter(Boolean).map(String)
    if (Array.isArray(res.fixes) && res.fixes.length) next.fixes = res.fixes.map(String)
    if (Array.isArray(res.anchors)) {
      next.anchors = res.anchors
        .filter((a) => a?.name)
        .map((a) => {
          const oldA = (b.anchors || []).find((x) => x.name === a.name)
          if (oldA?.locked) return oldA
          return { id: oldA?.id || uid(), name: String(a.name), aliases: Array.isArray(a.aliases) ? a.aliases.map(String).filter(Boolean) : [], identity: String(a.identity || ''), secret: String(a.secret || ''), locked: false }
        })
    }
    if (Array.isArray(res.truths)) {
      next.truths = BIBLE_TRUTH_KINDS.map((kind) => {
        const oldT = (b.truths || []).find((t) => t.kind === kind)
        if (oldT?.locked) return oldT
        const t = res.truths.find((x) => x?.kind === kind) || {}
        return { id: oldT?.id || uid(), kind, truth: String(t.truth || ''), clues: Array.isArray(t.clues) ? t.clues.map(String).filter(Boolean) : [], locked: false }
      })
    }
    // 地图分层：同名层保留锁定项；truth 层永不进写作上下文（传闻级隔离，同终极真相机制）
    if (Array.isArray(res.map_layers)) {
      next.mapLayers = res.map_layers
        .filter((m) => m?.name)
        .map((m, i) => {
          const oldM = (b.mapLayers || []).find((x) => x.name === m.name)
          if (oldM?.locked) return oldM
          return { id: oldM?.id || uid(), name: String(m.name), summary: String(m.summary || ''), rumor: String(m.rumor || ''), truth: String(m.truth || ''), unlockVolume: Number(m.unlock_volume) || i + 1, locked: false }
        })
    }
    // 完整世界观成型（选定灵感后自动生成）：势力盘含登场卷+传闻隔离、冲突线含阶段区间；同名锁定项保留旧值（同地图分层机制）
    if (Array.isArray(res.factions)) {
      next.factions = res.factions
        .filter((f) => f?.name)
        .map((f) => {
          const oldF = (b.factions || []).find((x) => x.name === f.name)
          if (oldF?.locked) return oldF
          return { id: oldF?.id || uid(), name: String(f.name), desc: String(f.desc || ''), rumor: String(f.rumor || ''), unlockVolume: Number(f.unlock_volume) || 1, locked: false }
        })
    }
    if (Array.isArray(res.conflicts)) {
      next.conflicts = res.conflicts
        .filter((c) => c?.name)
        .map((c) => {
          const oldC = (b.conflicts || []).find((x) => x.name === c.name)
          if (oldC?.locked) return oldC
          return { id: oldC?.id || uid(), name: String(c.name), desc: String(c.desc || ''), startVolume: Number(c.start_volume) || 1, endVolume: Number(c.end_volume) || 0, locked: false }
        })
    }
    return next
  }

  const genBible = async () => {
    if (!apiKey) return onNeedKey()
    if (st.brief.trim().length < 10) return setErr('请先在第一步填写初始提问（含固定人设、固定背景与修补诉求）。')
    setErr('')
    setBusy('AI 正在修补逻辑漏洞并搭建圣经…')
    try {
      const res = await bibleJsonWithRetry({ apiKey, messages: bibleRationalizeMessages({ brief: st.brief, truthKinds: BIBLE_TRUTH_KINDS }) })
      const merged = mergeBible(st.bible, res)
      // 自动串接：圣经完成后立即生成本书完整世界观（势力盘/冲突线含登场时机，防提前透支）；失败不阻塞圣经主流程，可在本页手动重生成圣经补上
      setBusy('正在为这本书生成完整世界观（势力盘与冲突线登场时机）…')
      try {
        const wvRes = await chatJSON({
          apiKey,
          messages: bookWorldviewMessages({ template: worldviewText(getWorldview(st.genre)), brief: st.brief, bible: merged, volumeCount: st.volumeCount }),
          temperature: 0.7,
        })
        patch({ bible: mergeBible(merged, wvRes), step: 1 })
      } catch {
        patch({ bible: merged, step: 1 })
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  // 导入已有章节：分章预览 → 可选由导入内容反推圣经
  const previewImport = () => {
    const parts = splitChapters(st.importText)
    if (!parts.length) return setErr('导入内容为空。')
    setErr('')
    patch({ importedChapters: parts, step: 1 })
  }

  const genBibleFromImport = async () => {
    if (!apiKey) return onNeedKey()
    if (!st.importedChapters.length) return setErr('请先粘贴既有正文并点击「分章预览」。')
    setErr('')
    setBusy('AI 正在从既有章节反推圣经草稿…')
    try {
      const text = st.importedChapters.map((c) => `【第${c.no}章 ${c.title}】\n${c.text}`).join('\n\n').slice(0, 60000)
      const res = await bibleJsonWithRetry({ apiKey, messages: bibleFromImportMessages({ text, truthKinds: BIBLE_TRUTH_KINDS }), temperature: 0.5 })
      const merged = mergeBible(st.bible, res)
      // 导入路径同样自动成型完整世界观（失败不阻塞）
      setBusy('正在为这本书生成完整世界观（势力盘与冲突线登场时机）…')
      try {
        const wvRes = await chatJSON({
          apiKey,
          messages: bookWorldviewMessages({ template: worldviewText(getWorldview(st.genre)), brief: st.brief, bible: merged, volumeCount: st.volumeCount }),
          temperature: 0.7,
        })
        patch({ bible: mergeBible(merged, wvRes) })
      } catch {
        patch({ bible: merged })
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  // ---------- Step 2 全书梗概 ----------
  const genSynopsis = async () => {
    if (!apiKey) return onNeedKey()
    if (!st.bible?.world) return setErr('请先生成小说圣经。')
    setErr('')
    setBusy('AI 正在撰写全书全景大纲（主线/副线/四层伏笔）…')
    try {
      const res = await chatJSON({
        apiKey,
        messages: fullSynopsisMessages({ bible: st.bible, brief: st.brief, totalWords: st.totalWords * 10000, volumeCount: st.volumeCount, chapterWords: st.chapterWords }),
        temperature: 0.7,
      })
      patch({
        mainline: String(res.mainline || ''),
        subplots: Array.isArray(res.subplots) ? res.subplots.filter((s) => s?.name).map((s) => ({ id: uid(), name: String(s.name), theme: String(s.theme || ''), startVolume: Number(s.start_volume) || 1, endVolume: Number(s.end_volume) || st.volumeCount })) : [],
        foreshadows: Array.isArray(res.foreshadows)
          ? res.foreshadows
              .filter((f) => f?.content)
              .map((f) => ({
                id: uid(),
                content: String(f.content),
                tier: TIERS.includes(f.tier) ? f.tier : '短',
                relatedChars: Array.isArray(f.related_chars) ? f.related_chars.map(String) : [],
                plannedVolume: Number(f.planned_volume) || st.volumeCount,
                hints: Array.isArray(f.hints) ? f.hints.filter((h) => h?.clue).map((h) => ({ chapter: Number(h.chapter) || 0, clue: String(h.clue) })) : [],
              }))
          : [],
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  const patchHook = (id, p) => patch({ foreshadows: st.foreshadows.map((f) => (f.id === id ? { ...f, ...p } : f)) })
  const addHook = () => patch({ foreshadows: [...st.foreshadows, { id: uid(), content: '', tier: '短', relatedChars: [], plannedVolume: 1, hints: [] }] })

  // ---------- Step 3 卷结构 ----------
  const totalChapters = Math.max(1, Math.round((st.totalWords * 10000) / st.chapterWords))
  const volumeLength = Math.max(5, Math.round(totalChapters / Math.max(1, st.volumeCount)))
  // 节奏模板 → 各卷章数（模板与卷数不同时等比重采样适配，形状保持不降级均分）；卷角色供四幕拆幕与提示词侧重使用
  const rhythmWeights = resampleWeights(RHYTHM_TEMPLATES[st.rhythm], st.volumeCount)
  const rhythmLengths = chaptersByRhythm(totalChapters, rhythmWeights)
  const rhythmRoles = rhythmWeights.map((_, i) => volumeRole(i + 1, rhythmWeights))

  // 切换节奏模板：已有卷结构时按新节奏重算各卷章数与起始章（卷名/主舞台等编辑成果保留）
  const applyRhythm = (id) => {
    const w = resampleWeights(RHYTHM_TEMPLATES[id], st.volumeCount)
    const lens = chaptersByRhythm(totalChapters, w)
    const vols = st.volumes.map((v, i) => ({ ...v, length: lens[i] || v.length }))
    let startNo = 1
    for (const v of vols) {
      v.startChapter = startNo
      startNo += v.length
    }
    patch({ rhythm: id, volumes: vols })
  }

  const genVolumes = async () => {
    if (!apiKey) return onNeedKey()
    if (!st.mainline) return setErr('请先生成全书梗概。')
    setErr('')
    setBusy(`AI 正在按「${st.rhythm}」节奏切分 ${st.volumeCount} 卷结构…`)
    try {
      const res = await chatJSON({ apiKey, messages: volumesPlanMessages({ bible: st.bible, mainline: st.mainline, volumeCount: st.volumeCount, lengths: rhythmLengths, roles: rhythmRoles, genre: st.genre }), temperature: 0.7 })
      const vols = (Array.isArray(res.volumes) ? res.volumes : [])
        .filter((v) => v?.name)
        .map((v, i) => ({
          volumeNo: Number(v.volume_no) || i + 1,
          name: String(v.name),
          theme: String(v.theme || ''),
          conflict: String(v.conflict || ''),
          arcStory: String(v.arc_story || ''),
          gain: String(v.gain || ''),
          location: String(v.location || ''),
          unlockLayer: Number(v.unlock_layer) || 0,
          strategy: String(v.strategy || ''),
          endHook: String(v.end_hook || ''),
          emotion: String(v.emotion || ''),
          length: rhythmLengths[i] || volumeLength,
          arc: '',
          acts: [],
          forbiddenForeshadowIds: [],
        }))
        .sort((a, b) => a.volumeNo - b.volumeNo)
      // 情感走向兜底：AI 未给的卷从题材×基调库按卷号轮转补（跳过已用，卷间不重复）
      const usedEmotions = []
      for (const v of vols) {
        if (v.emotion) { usedEmotions.push(v.emotion); continue }
        v.emotion = fallbackVolumeEmotion({ genre: st.genre, volumeNo: v.volumeNo, used: usedEmotions })
        if (v.emotion) usedEmotions.push(v.emotion)
      }
      // 卷档案确认后：计算 startChapter 并把四层伏笔的回收卷锚定为回收章硬边界
      let start = 1
      for (const v of vols) {
        v.startChapter = start
        start += v.length
      }
      patch({ volumes: vols })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  const patchVol = (no, p) => patch({ volumes: st.volumes.map((v) => (v.volumeNo === no ? { ...v, ...p } : v)) })

  // ---------- Step 4 幕结构 ----------
  const genActs = async (vol) => {
    if (!apiKey) return onNeedKey()
    setErr('')
    const role = volumeRole(vol.volumeNo, rhythmWeights)
    setBusy(`AI 正在按「${role}」角色拆解第 ${vol.volumeNo} 卷四幕结构…`)
    try {
      const res = await chatJSON({ apiKey, messages: actsPlanMessages({ volume: vol, mainline: st.mainline, role, ratioGuide: ACT_RATIO_GUIDE[role] }), temperature: 0.6 })
      const acts = (Array.isArray(res.acts) ? res.acts : [])
        .filter((a) => a?.act && Number.isFinite(Number(a.start)) && Number.isFinite(Number(a.end)))
        .map((a) => ({ act: String(a.act), start: Number(a.start), end: Number(a.end), goal: String(a.goal || '') }))
      if (!acts.length) throw new Error('AI 未返回有效幕结构，请重试。')
      patchVol(vol.volumeNo, { acts, arc: actsToArc(acts) })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  // 四幕手工微调（区间/目标均可改，改后同步弧线与起承转合坐标）
  const patchAct = (no, i, p) => {
    const vol = st.volumes.find((x) => x.volumeNo === no)
    if (!vol) return
    const acts = vol.acts.map((a, j) => (j === i ? { ...a, ...p } : a))
    patchVol(no, { acts, arc: actsToArc(acts) })
  }

  // ---------- Step 5 章名骨架 + 第 1 卷细纲 ----------
  const runStream = async (messages, field, temperature) => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setBusy('AI 生成中…')
    patch({ [field]: '' })
    try {
      await chatStream({ apiKey, messages, temperature, onDelta: (full) => patch({ [field]: full }) })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  // 分卷生成骨架：每次请求只负责一卷的章数区间（根治千章级一次性生成时模型压缩完剧情后用填充章凑数）；
  // 无卷结构时降级为全书一次性生成（旧路径）；中途失败时已生成的卷保留可继续编辑/重生成
  const genSkeleton = async () => {
    if (!st.volumes.length) {
      await runStream(chapterSkeletonMessages({ bible: st.bible, mainline: st.mainline, volumes: st.volumes, volumeLength }), 'skeleton', 0.7)
      return
    }
    if (!apiKey) return onNeedKey()
    setErr('')
    patch({ skeleton: '' })
    const parts = []
    try {
      for (let i = 0; i < st.volumes.length; i++) {
        const v = st.volumes[i]
        setBusy(`AI 正在分卷生成章骨架（${i + 1}/${st.volumes.length}）第 ${v.volumeNo} 卷…`)
        const actsText = (v.acts || []).length
          ? v.acts.map((a) => `${a.act}=第${v.startChapter + a.start - 1}-${v.startChapter + a.end - 1}章`).join('；')
          : ''
        // 上一卷末尾 3 章章行交给下一卷开头接住，保证跨卷衔接不断
        const prevTail = parts.length ? parts[parts.length - 1].split('\n').filter(Boolean).slice(-3).join('\n') : ''
        const full = await chatStream({
          apiKey,
          messages: volumeSkeletonMessages({ bible: st.bible, mainline: st.mainline, volume: v, volumeCount: st.volumeCount, prevTail, actsText }),
          temperature: 0.7,
        })
        parts.push(renumberPart(String(full).trim(), v.startChapter))
        patch({ skeleton: parts.join('\n\n') })
      }
    } catch (e) {
      setErr(e.message)
      if (parts.length) patch({ skeleton: parts.join('\n\n') })
    } finally {
      setBusy('')
    }
  }

  // 骨架崩坏检测：重复章名占比过高或缺任务的章行过多 = 疑似填充内容，提醒重新生成（只预警不阻断，用户可自行判断）
  const skeletonWarning = (() => {
    const list = st.chapterSkeleton
    if (list.length < 20) return ''
    const seen = new Set()
    let dup = 0
    for (const c of list) {
      const t = (c.title || '').trim()
      if (seen.has(t)) dup++
      else seen.add(t)
    }
    const noTask = list.filter((c) => !(c.task || '').trim()).length
    if (dup / list.length > 0.08 || noTask / list.length > 0.1) {
      return `检测到骨架疑似填充：重复章名 ${dup} 处、缺任务 ${noTask} 章，建议重新生成对应卷。`
    }
    return ''
  })()
  // 骨架文本变化时同步解析结构化章表（成书时用）
  useEffect(() => {
    const parsed = parseSkeleton(st.skeleton)
    if (parsed.length && JSON.stringify(parsed) !== JSON.stringify(st.chapterSkeleton)) {
      patch({ chapterSkeleton: parsed })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.skeleton])

  const genVol1Outline = async () => {
    const vol = st.volumes[0]
    const arcText = vol?.acts?.length ? `第1卷（第1-${vol.length}章，章号为卷内坐标）：${['起', '承', '转', '合'].map((p, i) => (vol.acts[i] ? `${p}=第${vol.acts[i].start}-${vol.acts[i].end}章` : '')).filter(Boolean).join('；')}` : ''
    await runStream(volumeOutlineMessages({ skeleton: st.skeleton, volume: vol, bible: st.bible, chapterCount: vol?.length || volumeLength, arcText }), 'outline', 0.7)
  }

  // ---------- Step 6 对账成书 ----------
  // 伏笔回收章锚定（与引擎层 anchorForeshadowResolve 同规则，此处独立计算供对账单展示，成书时由引擎统一锚定）
  const resolveChapterOf = (f) => {
    if (f.tier === '终极') {
      const last = st.volumes[st.volumes.length - 1]
      return last ? last.startChapter : '—'
    }
    const v = st.volumes.find((x) => x.volumeNo === f.plannedVolume)
    if (!v) return '—'
    return v.startChapter + Math.max(0, Math.floor((v.length || 20) * 0.7) - 1)
  }

  const canNext = {
    0: st.brief.trim().length >= 10,
    1: !!st.bible?.world,
    2: !!st.mainline,
    3: st.volumes.length > 0,
    4: st.volumes.length > 0 && st.volumes.every((v) => v.arc),
    5: !!st.outline,
    6: false,
  }[st.step]

  const createBook = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setCreating('组装书稿档案…')
    try {
      const b = st.bible || emptyBible()
      const proj = newProject(st.bookName.trim() || `${b.anchors[0]?.name || '圣经'}开书`)
      proj.idea = st.brief
      proj.genre = st.genre
      proj.chapterWords = st.chapterWords
      proj.synopsis = st.mainline
      proj.world = b.world
      // 力量体系绝对规则 → 世界手册规则块（写作时永不省略注入）
      proj.worldBlocks = (b.powerRules || []).map((r, i) => ({ id: uid(), name: `绝对规则${i + 1}`, aliases: '', kind: '规则', content: r }))
      // 人物锚点 → 人物档案（秘密留在圣经真相层，不进人物卡防早露）；aliases 必须存数组（设定页/状态回写按数组处理，存字符串曾导致渲染白屏）
      proj.characters = (b.anchors || []).map((a) => ({ name: a.name, aliases: Array.isArray(a.aliases) ? a.aliases.map(String).filter(Boolean) : [], identity: a.identity, personality: '', description: '', status: '' }))
      proj.protagonist = b.anchors[0]?.name || ''
      proj.bible = b
      // 卷档案补 id（列表渲染的 key 与 patchVolume 都按 id 寻址；向导态的卷没有 id，成书时统一补齐）
      proj.volumes = st.volumes.map((v) => ({ ...v, id: v.id || uid(), emotion: '' }))
      proj.outline = st.outline
      proj.chapterSkeleton = st.chapterSkeleton
      proj.storylines = st.subplots.map((s) => ({ name: s.name, type: '支线', progress: s.theme, lastChapter: 0 }))
      // 四层伏笔入帐：回收卷 → 回收章锚点换算成保护期硬边界（成书时统一锚定）
      proj.foreshadows = st.foreshadows
        .filter((f) => f.content.trim())
        .map((f) => ({
          id: f.id,
          content: f.content,
          relatedChars: f.relatedChars,
          importance: f.tier === '短' ? '支线' : '主线',
          tier: f.tier,
          plannedVolume: f.plannedVolume,
          hints: f.hints,
          plantedChapter: 0,
          minResolveChapter: 0,
          status: '未回收',
          resolveChapter: null,
        }))
      // 回收章锚定（引擎层规则：终极锚终卷、其余按回收卷中后段与分层下限）
      const anchored = { ...proj }
      anchored.foreshadows = proj.foreshadows.map((f) => {
        const base = 1
        if (f.tier === '终极') {
          const last = anchored.volumes[anchored.volumes.length - 1]
          return { ...f, minResolveChapter: last ? Math.max(base + 20, last.startChapter) : base + 150, resolveAnchored: true }
        }
        const gap = { 短: 10, 中: 50, 长: 150 }[f.tier] ?? 10
        const v = anchored.volumes.find((x) => x.volumeNo === f.plannedVolume)
        const min = v ? Math.max(base + gap, v.startChapter + Math.max(0, Math.floor((v.length || 20) * 0.7) - 1)) : base + gap
        return { ...f, minResolveChapter: min, resolveAnchored: true }
      })
      // 导入章节逐章入库 + 轻量归档（摘要 + 伏笔检测），章号从 1 连续
      let cur = anchored
      for (let i = 0; i < st.importedChapters.length; i++) {
        const c = st.importedChapters[i]
        setCreating(`归档导入章节 ${i + 1}/${st.importedChapters.length}…`)
        const { project: next } = await archiveImportedChapter({ apiKey, project: cur, chapterNo: i + 1, title: c.title || `第${i + 1}章`, text: c.text })
        cur = next
      }
      const lastCh = cur.chapters[cur.chapters.length - 1]
      if (lastCh?.summary) cur.rollingSummary = lastCh.summary
      cur.updatedAt = Date.now()
      await put('projects', cur)
      localStorage.setItem('na_open_project', cur.id)
      // 成书后保留向导进度（不清空）：导入长篇写作后仍可回新手写作修改初始提问/圣经等，再次点成书会新建一本书
      onOpenLongForm && onOpenLongForm()
    } catch (e) {
      setErr(e.message)
    } finally {
      setCreating('')
    }
  }

  const { step, bible } = st
  const inputCls = 'w-full rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none'
  const btnCls = 'rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50'

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}

      {/* 步骤条 */}
      <nav className="flex gap-2 overflow-x-auto rounded-2xl bg-[#fbf8ef] p-3 shadow-sm">
        {STEPS.map((s) => (
          <button
            key={s.id}
            onClick={() => !busy && !creating && patch({ step: s.id })}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors ${step === s.id ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-100'}`}
          >
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${step === s.id ? 'bg-[#fbf8ef]/20' : 'bg-stone-200'}`}>{s.id}</span>
            {s.label}
          </button>
        ))}
      </nav>

      {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}
      {busy && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{busy}</p>}

      {/* Step 0 初始提问 */}
      {step === 0 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold"><Ic n="bulb" /> 初始提问：固定项 + 修补诉求</h2>
            <button
              onClick={() => setShowInspire(true)}
              className="flex shrink-0 items-center gap-1 rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
              title="联网热梗 + AI 构思 5 个开局选题"
            >
              <Ic n="sparkle" /> 灵感
            </button>
          </div>
          <p className="text-xs leading-relaxed text-stone-400">
            写清三件事：① 固定人设（不许 AI 改的人物）；② 固定背景（题材与核心设定）；③ 想让 AI 修补的逻辑漏洞或合理化诉求。AI 会先修补漏洞，再产出小说圣经。
          </p>
          <textarea
            value={st.brief}
            onChange={(e) => patch({ brief: e.target.value })}
            placeholder={'例如：我想写一部末日中期的小说。主角江辰，父母离世，只有一个生病的妹妹，每天要出城捡取材料换取面包和药品，还会被守卫克扣。\n固定人设：江辰、病弱妹妹、双亲亡故；固定背景：末日中期、底层拾荒求生。\n请帮我把故事合理化：为什么必须出城、为什么会被克扣、为什么不能反抗或换营地…'}
            rows={7}
            className={`${inputCls} resize-y`}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold text-stone-500">书名（可留空）</p>
              <input value={st.bookName} onChange={(e) => patch({ bookName: e.target.value })} placeholder="未命名长篇" className={inputCls} />
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-stone-500">题材</p>
              {/* 用 allGenres 而非 GENRES：含用户在世界观库自建的题材，否则灵感弹窗选中的自定义题材在下拉里显示不出来 */}
              <select value={st.genre} onChange={(e) => patch({ genre: e.target.value })} className={inputCls}>
                {allGenres().map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-stone-500">目标总字数（万字）</p>
              <input
                type="number"
                min={10}
                max={500}
                value={st.totalWords}
                onChange={(e) => patch({ totalWords: e.target.value === '' ? '' : Number(e.target.value) })}
                onBlur={() => patch({ totalWords: Math.min(500, Math.max(10, Number(st.totalWords) || 100)) })}
                className={inputCls}
              />
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-stone-500">卷数（默认六卷，可改）</p>
              <input
                type="number"
                min={2}
                max={20}
                value={st.volumeCount}
                onChange={(e) => patch({ volumeCount: e.target.value === '' ? '' : Number(e.target.value) })}
                onBlur={() => patch({ volumeCount: Math.min(20, Math.max(2, Number(st.volumeCount) || 6)) })}
                className={inputCls}
              />
            </div>
          </div>
          {/* 世界模板确认：仅供灵感低权重参考，不定死世界；选定灵感后由开书流程自动生成本书完整世界观（圣经页可审阅）。修改保存到本机题材库，与长篇写作「世界观」页共用 */}
          <details className="rounded-xl border border-stone-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-stone-600">
              <Ic n="globe" /> 世界模板：「{st.genre}」{isOverridden(st.genre) ? '（你改过的版本）' : '（内置模板）'} — 展开查看/编辑
            </summary>
            <div className="mt-3">
              <WorldviewEditor key={st.genre} genre={st.genre} />
              <p className="mt-2 text-xs text-stone-400">模板仅供灵感参考不定死世界；选定灵感后，完整世界观（势力/冲突含登场时机）会在生成圣经时自动成型，到圣经页审阅。</p>
            </div>
          </details>
          <p className="text-xs text-stone-400">推导：约 {totalChapters} 章 × 每章 {st.chapterWords} 字，每卷约 {volumeLength} 章。</p>
          <div className="flex flex-wrap gap-3">
            <button onClick={genBible} disabled={!!busy || st.brief.trim().length < 10} className={btnCls}>
              {busy ? 'AI 修补中…' : bible?.world ? '重新合理化（锁定项保留）' : 'AI 合理化修补并生成圣经'}
            </button>
          </div>
          {showInspire && (
            <InspirationModal
              genre={st.genre}
              apiKey={apiKey}
              onPick={(brief, genre) => {
                // 选题与题材一同绑定：灵感弹窗内选的题材同步到向导，后续圣经/世界观/分卷都按这个题材走
                patch({ brief, genre })
                setShowInspire(false)
              }}
              onClose={() => setShowInspire(false)}
            />
          )}

          {/* 可选：已有章节导入 */}
          <details className="rounded-xl border border-stone-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-stone-600"><Ic n="import" /> 我已有部分章节（可选：分章导入，并可由内容反推圣经）</summary>
            <textarea value={st.importText} onChange={(e) => patch({ importText: e.target.value })} placeholder={'粘贴已有正文，带「第N章」章头可自动分章…'} rows={6} className={`${inputCls} novel-text mt-3 resize-y`} />
            <button onClick={previewImport} disabled={!!busy || countWords(st.importText) < 50} className="mt-2 rounded-full border border-stone-300 px-4 py-2 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
              分章预览
            </button>
            {st.importedChapters.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-xs text-emerald-700">已识别 {st.importedChapters.length} 章，成书时将逐章归档入帐。</p>
                <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-stone-500">
                  {st.importedChapters.map((c) => (
                    <li key={c.no}>第{c.no}章 {c.title || '（无标题）'} · {countWords(c.text)} 字</li>
                  ))}
                </ul>
                <button onClick={genBibleFromImport} disabled={!!busy} className="rounded-full border border-stone-300 px-4 py-2 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                  由导入内容生成/补全圣经
                </button>
              </div>
            )}
          </details>
        </section>
      )}

      {/* Step 1 小说圣经 */}
      {step === 1 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold"><Ic n="globe" /> 小说圣经 · 永久不变设定</h2>
            <button onClick={genBible} disabled={!!busy || st.brief.trim().length < 10} className="rounded-full border border-stone-300 px-4 py-2 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
              {busy || '重新合理化修补（锁定项保留）'}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-stone-400">
            真相层（右侧红字区）永不进入写作上下文——写作时 AI 只能看到线索；真相仅供审稿对照。改好的内容点「锁定」，重新生成时不会被覆盖。
          </p>
          {!bible ? (
            <p className="rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-500">还没有圣经。回到上一步填写初始提问并点击「AI 合理化修补并生成圣经」，或用已有章节反推。</p>
          ) : (
            <>
              {bible.fixes?.length > 0 && (
                <details className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <summary className="cursor-pointer text-xs font-semibold text-amber-800">AI 修补了这些逻辑漏洞（审阅）</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-800">
                    {bible.fixes.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-stone-500">合理化后的世界观（闭环解释所有"为什么"）</p>
                  <button onClick={() => patchBible({ locks: { ...bible.locks, world: !bible.locks?.world } })} className={`rounded-full px-3 py-1 text-xs ${bible.locks?.world ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>
                    {bible.locks?.world ? '已锁定' : '锁定'}
                  </button>
                </div>
                <textarea value={bible.world} onChange={(e) => patchBible({ world: e.target.value })} disabled={!!busy} rows={6} className={`${inputCls} novel-text resize-y`} />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-stone-500">力量体系绝对规则（永不改动，写作时永不省略注入）</p>
                  <button onClick={() => patchBible({ locks: { ...bible.locks, powerRules: !bible.locks?.powerRules } })} className={`rounded-full px-3 py-1 text-xs ${bible.locks?.powerRules ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>
                    {bible.locks?.powerRules ? '已锁定' : '锁定'}
                  </button>
                </div>
                {(bible.powerRules || []).map((r, i) => (
                  <div key={i} className="mb-1 flex gap-2">
                    <input value={r} onChange={(e) => patchBible({ powerRules: bible.powerRules.map((x, j) => (j === i ? e.target.value : x)) })} className={inputCls} />
                    <button onClick={() => patchBible({ powerRules: bible.powerRules.filter((_, j) => j !== i) })} className="shrink-0 rounded-full border border-stone-200 px-3 text-xs text-stone-400 hover:bg-stone-50">删除</button>
                  </div>
                ))}
                <button onClick={() => patchBible({ powerRules: [...(bible.powerRules || []), ''] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加规则</button>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">人物锚点（只放你固定的人物；其余人物写作中自然生长，防止 AI 过早亮出全部角色）</p>
                {(bible.anchors || []).map((a) => (
                  <div key={a.id} className="mb-2 rounded-xl border border-stone-200 p-3">
                    <div className="flex flex-wrap gap-2">
                      <input value={a.name} onChange={(e) => patchBible({ anchors: bible.anchors.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)) })} placeholder="姓名" className="w-28 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <input value={(a.aliases || []).join('，')} onChange={(e) => patchBible({ anchors: bible.anchors.map((x) => (x.id === a.id ? { ...x, aliases: e.target.value.split(/[,，、]/).filter(Boolean) } : x)) })} placeholder="别称（逗号分隔）" className="w-40 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <input value={a.identity} onChange={(e) => patchBible({ anchors: bible.anchors.map((x) => (x.id === a.id ? { ...x, identity: e.target.value } : x)) })} placeholder="一句话定位" className="min-w-40 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <button onClick={() => patchBible({ anchors: bible.anchors.map((x) => (x.id === a.id ? { ...x, locked: !x.locked } : x)) })} className={`rounded-full px-3 py-1 text-xs ${a.locked ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>{a.locked ? '已锁定' : '锁定'}</button>
                    </div>
                    <input value={a.secret} onChange={(e) => patchBible({ anchors: bible.anchors.map((x) => (x.id === a.id ? { ...x, secret: e.target.value } : x)) })} placeholder="该人物的隐藏秘密（分层埋藏，可留空）" className={`${inputCls} mt-2`} />
                  </div>
                ))}
                <button onClick={() => patchBible({ anchors: [...(bible.anchors || []), { id: uid(), name: '', aliases: [], identity: '', secret: '', locked: false }] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加锚点人物</button>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">四项终极真相（真相层永不进写作上下文；线索层写作时可露出）</p>
                {(bible.truths || []).map((t) => (
                  <div key={t.id} className="mb-3 rounded-xl border border-red-200/70 bg-red-50/40 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-red-800">{t.kind}</p>
                      <button onClick={() => patchBible({ truths: bible.truths.map((x) => (x.id === t.id ? { ...x, locked: !x.locked } : x)) })} className={`rounded-full px-3 py-1 text-xs ${t.locked ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>{t.locked ? '已锁定' : '锁定'}</button>
                    </div>
                    <textarea value={t.truth} onChange={(e) => patchBible({ truths: bible.truths.map((x) => (x.id === t.id ? { ...x, truth: e.target.value } : x)) })} placeholder="完整真相（大结局才揭露）" rows={2} className={`${inputCls} mt-2 resize-y`} />
                    <p className="mt-2 text-xs font-semibold text-stone-500">前期可露出的蛛丝马迹（每行一条，写作时只允许露这些）</p>
                    <textarea
                      value={(t.clues || []).join('\n')}
                      onChange={(e) => patchBible({ truths: bible.truths.map((x) => (x.id === t.id ? { ...x, clues: e.target.value.split('\n').filter(Boolean) } : x)) })}
                      placeholder={'线索1\n线索2'}
                      rows={2}
                      className={`${inputCls} mt-1 resize-y`}
                    />
                  </div>
                ))}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">世界地图分层（传闻级隔离：已解锁层可展开，下一层只能以传闻提及，更高层与真相栏永不进写作上下文）</p>
                {(bible.mapLayers || []).map((m, idx) => (
                  <div key={m.id} className="mb-3 rounded-xl border border-emerald-200/70 bg-emerald-50/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-stone-400">第{idx + 1}层</span>
                      <input value={m.name} onChange={(e) => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)) })} placeholder="区域名（8字内）" className="w-36 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <label className="text-xs text-stone-500">解锁卷</label>
                      <select value={m.unlockVolume} onChange={(e) => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, unlockVolume: Number(e.target.value) } : x)) })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                        {Array.from({ length: st.volumeCount }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>第{n}卷</option>
                        ))}
                      </select>
                      <button onClick={() => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, locked: !x.locked } : x)) })} className={`rounded-full px-3 py-1 text-xs ${m.locked ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>{m.locked ? '已锁定' : '锁定'}</button>
                      <button onClick={() => patchBible({ mapLayers: bible.mapLayers.filter((x) => x.id !== m.id) })} className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-400 hover:bg-stone-50">删除</button>
                    </div>
                    <input value={m.summary} onChange={(e) => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, summary: e.target.value } : x)) })} placeholder="该层正式设定（解锁后写作可展开）" className={`${inputCls} mt-2`} />
                    <input value={m.rumor} onChange={(e) => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, rumor: e.target.value } : x)) })} placeholder="前期传闻（未解锁时只允许以传闻形式流传，30字内）" className={`${inputCls} mt-1`} />
                    <input value={m.truth} onChange={(e) => patchBible({ mapLayers: bible.mapLayers.map((x) => (x.id === m.id ? { ...x, truth: e.target.value } : x)) })} placeholder="深层秘密（真相栏：永不进写作上下文，仅供审核对照，可留空）" className={`${inputCls} mt-1 text-red-800`} />
                  </div>
                ))}
                <button onClick={() => patchBible({ mapLayers: [...(bible.mapLayers || []), { id: uid(), name: '', summary: '', rumor: '', truth: '', unlockVolume: (bible.mapLayers || []).length + 1, locked: false }] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加地图层</button>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">世界势力盘（选定灵感后自动生成；登场卷之前写作层只见传闻一句，防 AI 提前透支新世界）</p>
                {(bible.factions || []).map((f) => (
                  <div key={f.id} className="mb-2 rounded-xl border border-sky-200/70 bg-sky-50/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <input value={f.name} onChange={(e) => patchBible({ factions: bible.factions.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)) })} placeholder="势力名（8字内）" className="w-36 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <label className="text-xs text-stone-500">登场卷</label>
                      <select value={f.unlockVolume} onChange={(e) => patchBible({ factions: bible.factions.map((x) => (x.id === f.id ? { ...x, unlockVolume: Number(e.target.value) } : x)) })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                        {Array.from({ length: st.volumeCount }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>第{n}卷</option>
                        ))}
                      </select>
                      <button onClick={() => patchBible({ factions: bible.factions.map((x) => (x.id === f.id ? { ...x, locked: !x.locked } : x)) })} className={`rounded-full px-3 py-1 text-xs ${f.locked ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>{f.locked ? '已锁定' : '锁定'}</button>
                      <button onClick={() => patchBible({ factions: bible.factions.filter((x) => x.id !== f.id) })} className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-400 hover:bg-stone-50">删除</button>
                    </div>
                    <input value={f.desc} onChange={(e) => patchBible({ factions: bible.factions.map((x) => (x.id === f.id ? { ...x, desc: e.target.value } : x)) })} placeholder="定位、立场、与主角初始关系（登场后写作可展开）" className={`${inputCls} mt-2`} />
                    <input value={f.rumor} onChange={(e) => patchBible({ factions: bible.factions.map((x) => (x.id === f.id ? { ...x, rumor: e.target.value } : x)) })} placeholder="登场前传闻（不含实情，写作层只见这一句，30字内）" className={`${inputCls} mt-1`} />
                  </div>
                ))}
                <button onClick={() => patchBible({ factions: [...(bible.factions || []), { id: uid(), name: '', desc: '', rumor: '', unlockVolume: 1, locked: false }] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加势力</button>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-stone-500">主要冲突线（阶段控制：start 卷之前完全不进写作上下文，防后期冲突提前引爆）</p>
                {(bible.conflicts || []).map((c) => (
                  <div key={c.id} className="mb-2 rounded-xl border border-violet-200/70 bg-violet-50/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <input value={c.name} onChange={(e) => patchBible({ conflicts: bible.conflicts.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)) })} placeholder="冲突线名（8字内）" className="w-36 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                      <label className="text-xs text-stone-500">第</label>
                      <select value={c.startVolume} onChange={(e) => patchBible({ conflicts: bible.conflicts.map((x) => (x.id === c.id ? { ...x, startVolume: Number(e.target.value) } : x)) })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                        {Array.from({ length: st.volumeCount }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                      <label className="text-xs text-stone-500">~</label>
                      <select value={c.endVolume || st.volumeCount} onChange={(e) => patchBible({ conflicts: bible.conflicts.map((x) => (x.id === c.id ? { ...x, endVolume: Number(e.target.value) } : x)) })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                        {Array.from({ length: st.volumeCount }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                      <label className="text-xs text-stone-500">卷</label>
                      <button onClick={() => patchBible({ conflicts: bible.conflicts.map((x) => (x.id === c.id ? { ...x, locked: !x.locked } : x)) })} className={`rounded-full px-3 py-1 text-xs ${c.locked ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}>{c.locked ? '已锁定' : '锁定'}</button>
                      <button onClick={() => patchBible({ conflicts: bible.conflicts.filter((x) => x.id !== c.id) })} className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-400 hover:bg-stone-50">删除</button>
                    </div>
                    <input value={c.desc} onChange={(e) => patchBible({ conflicts: bible.conflicts.map((x) => (x.id === c.id ? { ...x, desc: e.target.value } : x)) })} placeholder="冲突内涵（贯穿全书的主要矛盾，非单卷事件）" className={`${inputCls} mt-2`} />
                  </div>
                ))}
                <button onClick={() => patchBible({ conflicts: [...(bible.conflicts || []), { id: uid(), name: '', desc: '', startVolume: 1, endVolume: st.volumeCount, locked: false }] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加冲突线</button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Step 2 全书梗概 */}
      {step === 2 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold"><Ic n="map" /> 全书总故事线（主线里程碑 + 副线 + 四层伏笔）</h2>
            <button onClick={genSynopsis} disabled={!!busy || !st.bible?.world} className={btnCls}>{busy || (st.mainline ? '重新生成梗概' : '生成全书梗概')}</button>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold text-stone-500">主线：开局 → 重大里程碑（带章号锚点）→ 大结局形态</p>
            <textarea value={st.mainline} onChange={(e) => patch({ mainline: e.target.value })} disabled={!!busy} rows={10} className={`${inputCls} novel-text resize-y`} />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold text-stone-500">副线（0~3 条，全程贯穿；开书即登记入故事线档案）</p>
            {st.subplots.map((s) => (
              <div key={s.id} className="mb-1 flex flex-wrap gap-2">
                <input value={s.name} onChange={(e) => patch({ subplots: st.subplots.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)) })} placeholder="副线名" className="w-28 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                <input value={s.theme} onChange={(e) => patch({ subplots: st.subplots.map((x) => (x.id === s.id ? { ...x, theme: e.target.value } : x)) })} placeholder="主题" className="min-w-40 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                <span className="flex items-center text-xs text-stone-400">第 {s.startVolume}~{s.endVolume} 卷</span>
                <button onClick={() => patch({ subplots: st.subplots.filter((x) => x.id !== s.id) })} className="rounded-full border border-stone-200 px-3 text-xs text-stone-400 hover:bg-stone-50">删除</button>
              </div>
            ))}
            <button onClick={() => patch({ subplots: [...st.subplots, { id: uid(), name: '', theme: '', startVolume: 1, endVolume: st.volumeCount }] })} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 添加副线</button>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold text-stone-500">四层伏笔登记（每条锚定回收卷——这是长埋点能存在的根本）</p>
            {st.foreshadows.map((f) => (
              <div key={f.id} className="mb-2 rounded-xl border border-stone-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select value={f.tier} onChange={(e) => patchHook(f.id, { tier: e.target.value })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                    {TIERS.map((t) => (
                      <option key={t} value={t}>{t}线</option>
                    ))}
                  </select>
                  <select value={f.plannedVolume} onChange={(e) => patchHook(f.id, { plannedVolume: Number(e.target.value) })} className="rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                    {Array.from({ length: st.volumeCount }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{f.tier === '终极' && n === st.volumeCount ? `终卷（第${n}卷）` : `第${n}卷回收`}</option>
                    ))}
                  </select>
                  <button onClick={() => patch({ foreshadows: st.foreshadows.filter((x) => x.id !== f.id) })} className="ml-auto rounded-full border border-stone-200 px-3 text-xs text-stone-400 hover:bg-stone-50">删除</button>
                </div>
                <p className="mt-1 text-[11px] text-stone-400">{TIER_DESC[f.tier]}</p>
                <input value={f.content} onChange={(e) => patchHook(f.id, { content: e.target.value })} placeholder="伏笔内容" className={`${inputCls} mt-1`} />
                {f.hints?.length > 0 && (
                  <p className="mt-1 text-xs text-stone-500">线索露出计划：{f.hints.map((h) => `约第${h.chapter}章露「${h.clue}」`).join('；')}</p>
                )}
              </div>
            ))}
            <button onClick={addHook} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">+ 手动登记伏笔</button>
          </div>
        </section>
      )}

      {/* Step 3 卷结构 */}
      {step === 3 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold"><Ic n="mountain" /> 卷结构（{st.volumeCount} 卷 · 节奏：{st.rhythm}）</h2>
            <button onClick={genVolumes} disabled={!!busy || !st.mainline} className={btnCls}>{busy || (st.volumes.length ? '重新切分卷结构' : 'AI 切分卷结构')}</button>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-stone-500">分卷节奏（不均分：短卷短而密快入局/快回收，长卷承载地图深耕与伏笔发酵）</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(RHYTHM_TEMPLATES).map(([name, w]) => (
                <button
                  key={name}
                  onClick={() => applyRhythm(name)}
                  className={`rounded-full px-4 py-1.5 text-xs ${st.rhythm === name ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500 hover:bg-stone-50'}`}
                >
                  {name}（{w.join('-')}）
                </button>
              ))}
            </div>
            {st.volumes.length > 0 && <p className="mt-1 text-[11px] text-stone-400">当前各卷章数：{st.volumes.map((v) => `第${v.volumeNo}卷${v.length}章`).join('、')}；切换模板会重算章数，卷名与编辑内容保留</p>}
          </div>
          {st.volumes.length === 0 && <p className="rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-500">还没有卷结构，点击上方按钮生成，或先回上一步完成梗概。</p>}
          {st.volumes.map((v) => (
            <div key={v.volumeNo} className="rounded-xl border border-stone-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold">第{v.volumeNo}卷</p>
                <input value={v.name} onChange={(e) => patchVol(v.volumeNo, { name: e.target.value })} placeholder="卷名" className="w-32 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
                <span className="text-xs text-stone-400">第{v.startChapter}~{v.startChapter + v.length - 1}章</span>
                <label className="ml-auto text-xs text-stone-500">计划章数</label>
                <input type="number" min={5} value={v.length} onChange={(e) => patchVol(v.volumeNo, { length: Math.max(5, Number(e.target.value) || v.length) })} className="w-20 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
              </div>
              <textarea
                value={v.arcStory || ''}
                onChange={(e) => patchVol(v.volumeNo, { arcStory: e.target.value })}
                placeholder="本卷故事（本卷限定的具体事件：新对手/新局面/明确目标，在本卷内起承转合完整解决——长篇不单故事化的关键）"
                rows={2}
                className={`${inputCls} mt-2 resize-y border-sky-200 bg-sky-50/40`}
              />
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input value={v.theme} onChange={(e) => patchVol(v.volumeNo, { theme: e.target.value })} placeholder="本卷核心主题" className={inputCls} />
                <input value={v.conflict} onChange={(e) => patchVol(v.volumeNo, { conflict: e.target.value })} placeholder="本卷核心冲突" className={inputCls} />
                <input value={v.gain} onChange={(e) => patchVol(v.volumeNo, { gain: e.target.value })} placeholder="主角本卷收获" className={inputCls} />
                <input value={v.endHook} onChange={(e) => patchVol(v.volumeNo, { endHook: e.target.value })} placeholder="卷末大悬念（留给下一卷）" className={inputCls} />
                <input value={v.location || ''} onChange={(e) => patchVol(v.volumeNo, { location: e.target.value })} placeholder="本卷主舞台（具体地名，随卷递进）" className={inputCls} />
                <div className="flex items-center gap-2">
                  <label className="shrink-0 text-xs text-stone-500">解锁地图层</label>
                  <select value={v.unlockLayer || 0} onChange={(e) => patchVol(v.volumeNo, { unlockLayer: Number(e.target.value) })} className="flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                    <option value={0}>未设置</option>
                    {(bible?.mapLayers || []).map((m, i) => (
                      <option key={m.id} value={i + 1}>第{i + 1}层 {m.name || '未命名'}</option>
                    ))}
                  </select>
                </div>
              </div>
              <textarea value={v.strategy} onChange={(e) => patchVol(v.volumeNo, { strategy: e.target.value })} placeholder="本卷战略" rows={2} className={`${inputCls} mt-2 resize-y`} />
              {/* 情感走向：生成卷结构时 AI 已按本卷故事走向逐卷生成；不满意可手改或从题材×基调库换一个（跳过其他卷已用的） */}
              <div className="mt-2 flex items-center gap-2">
                <input value={v.emotion || ''} onChange={(e) => patchVol(v.volumeNo, { emotion: e.target.value })} placeholder="本卷情感走向（如：压抑→憋屈→爆发→短暂喘息）" className={inputCls} />
                <button
                  onClick={() => patchVol(v.volumeNo, { emotion: fallbackVolumeEmotion({ genre: st.genre, volumeNo: v.volumeNo + st.volumes.length, used: st.volumes.filter((x) => x.volumeNo !== v.volumeNo).map((x) => x.emotion) }) })}
                  className="shrink-0 rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
                >
                  换一个
                </button>
              </div>
              <div className="mt-2">
                <p className="text-xs font-semibold text-stone-500">本卷绝对不回收的长线伏笔（勾选后写作提示词硬禁回收）</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {st.foreshadows.filter((f) => f.tier !== '短' && f.content).map((f) => {
                    const on = (v.forbiddenForeshadowIds || []).includes(f.id)
                    return (
                      <button
                        key={f.id}
                        onClick={() => patchVol(v.volumeNo, { forbiddenForeshadowIds: on ? v.forbiddenForeshadowIds.filter((x) => x !== f.id) : [...(v.forbiddenForeshadowIds || []), f.id] })}
                        className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500'}`}
                      >
                        [{f.tier}] {f.content.slice(0, 18)}{f.content.length > 18 ? '…' : ''}
                      </button>
                    )
                  })}
                  {!st.foreshadows.some((f) => f.tier !== '短' && f.content) && <span className="text-xs text-stone-400">（暂无中长线伏笔，先在上一步登记）</span>}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Step 4 幕结构 */}
      {step === 4 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <h2 className="text-base font-bold"><Ic n="film" /> 卷内四幕：起幕 → 发展幕 → 冲突幕 → 高潮落幕</h2>
          <p className="text-xs text-stone-400">每卷按其叙事角色（开卷/腹地深耕/扩张过渡/收割）给不同比例参考，禁止每卷同构均分；区间与目标可手工微调，章头起承转合标签按此对齐。</p>
          {st.volumes.map((v) => (
            <div key={v.volumeNo} className="rounded-xl border border-stone-200 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">第{v.volumeNo}卷《{v.name || '未命名'}》<span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-normal text-stone-500">{volumeRole(v.volumeNo, rhythmWeights)}·{v.length}章</span></p>
                <button onClick={() => genActs(v)} disabled={!!busy} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                  {busy ? '生成中…' : v.acts.length ? '重新拆幕' : 'AI 拆四幕'}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-stone-400">比例参考：{ACT_RATIO_GUIDE[volumeRole(v.volumeNo, rhythmWeights)] || ''}（可合理偏离）</p>
              {v.acts.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {v.acts.map((a, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
                      <span className="w-16 shrink-0 font-semibold">{a.act}</span>
                      <span className="text-xs text-stone-400">卷内</span>
                      <input type="number" min={1} max={v.length} value={a.start} onChange={(e) => patchAct(v.volumeNo, i, { start: Math.max(1, Number(e.target.value) || a.start) })} className="w-16 rounded-lg border border-stone-200 px-2 py-1 text-sm" />
                      <span className="text-xs text-stone-400">~</span>
                      <input type="number" min={1} max={v.length} value={a.end} onChange={(e) => patchAct(v.volumeNo, i, { end: Math.min(v.length, Number(e.target.value) || a.end) })} className="w-16 rounded-lg border border-stone-200 px-2 py-1 text-sm" />
                      <span className="text-xs text-stone-400">章</span>
                      <input value={a.goal} onChange={(e) => patchAct(v.volumeNo, i, { goal: e.target.value })} placeholder="本幕目标" className="min-w-40 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-sm" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-stone-400">未拆幕（该卷将按默认弧线缩放定位）</p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* Step 5 章名骨架 + 第 1 卷细纲 */}
      {step === 5 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <h2 className="text-base font-bold"><Ic n="notepad" /> 全书章名骨架 + 第 1 卷完整细纲</h2>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-stone-500">全书章名骨架（每章一行：章名 + 唯一剧情任务；仅作方向锚点，进卷再细化）</p>
              <button onClick={genSkeleton} disabled={!!busy || !st.mainline} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                {busy ? '生成中…' : st.skeleton ? '重新生成骨架' : 'AI 生成全书章名骨架'}
              </button>
            </div>
            <textarea value={st.skeleton} onChange={(e) => patch({ skeleton: e.target.value })} disabled={!!busy} rows={10} placeholder={'第1章 章名｜任务：本章唯一要完成的一件事\n第2章 …'} className={`${inputCls} novel-text resize-y`} />
            {st.chapterSkeleton.length > 0 && <p className="mt-1 text-xs text-emerald-700">已解析 {st.chapterSkeleton.length} 章骨架（按卷分次生成，每卷只展开本卷剧情）。</p>}
            {skeletonWarning && <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{skeletonWarning}</p>}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-stone-500">第 1 卷完整细纲（覆盖第 1~{st.volumes[0]?.length || volumeLength} 章，含起承转合定位）</p>
              <button onClick={genVol1Outline} disabled={!!busy || !st.skeleton} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                {busy ? '生成中…' : st.outline ? '重新生成第1卷细纲' : 'AI 展开第 1 卷细纲'}
              </button>
            </div>
            <textarea value={st.outline} onChange={(e) => patch({ outline: e.target.value })} disabled={!!busy} rows={12} className={`${inputCls} novel-text resize-y`} />
            <p className="mt-1 text-xs text-stone-400">后续卷细纲在长篇写作页按"细纲将尽时滚动续写"生成，不提前锁死。</p>
          </div>
        </section>
      )}

      {/* Step 6 对账成书 */}
      {step === 6 && (
        <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
          <h2 className="text-base font-bold"><Ic n="ok" /> 开写前对账（结构化渲染，零 AI 调用——检查的和写的是同一份事实）</h2>

          <div>
            <p className="mb-2 text-xs font-semibold text-stone-500">伏笔闭环表（埋设 → 线索露出 → 回收章锚点；肉眼查断头伏笔）</p>
            <div className="overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-100 text-stone-500">
                  <tr>
                    <th className="px-3 py-2">伏笔</th>
                    <th className="px-3 py-2">层级</th>
                    <th className="px-3 py-2">回收卷</th>
                    <th className="px-3 py-2">回收章锚点</th>
                    <th className="px-3 py-2">线索计划</th>
                  </tr>
                </thead>
                <tbody>
                  {st.foreshadows.filter((f) => f.content).map((f) => (
                    <tr key={f.id} className="border-t border-stone-100">
                      <td className="px-3 py-2">{f.content}</td>
                      <td className="whitespace-nowrap px-3 py-2">{f.tier}线</td>
                      <td className="px-3 py-2">第{f.plannedVolume}卷</td>
                      <td className="px-3 py-2">约第{resolveChapterOf(f)}章起可回收</td>
                      <td className="px-3 py-2">{f.hints?.length ? f.hints.map((h) => `第${h.chapter}章`).join('、') : f.tier === '短' ? '（短线无需）' : <span className="text-red-500">缺线索计划</span>}</td>
                    </tr>
                  ))}
                  {!st.foreshadows.some((f) => f.content) && (
                    <tr><td colSpan={5} className="px-3 py-3 text-center text-stone-400">还没有伏笔</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-stone-500">卷结构总览</p>
            <ul className="space-y-1 text-sm text-stone-600">
              {st.volumes.map((v) => (
                <li key={v.volumeNo}>
                  第{v.volumeNo}卷《{v.name}》第{v.startChapter}~{v.startChapter + v.length - 1}章：{v.theme || '（无主题）'}；卷末悬念：{v.endHook || '（无）'}{v.arc ? `；弧线：${v.arc}` : ''}
                  {v.arcStory ? <span className="mt-0.5 block text-xs text-stone-500">本卷故事：{v.arcStory}</span> : null}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-stone-500">
            成书内容：圣经（真相隔离）· 力量规则入世界手册 · 锚点人物入档案 · {st.foreshadows.filter((f) => f.content).length} 条伏笔入帐（回收章硬边界）· {st.volumes.length} 卷档案 · {st.chapterSkeleton.length} 章骨架 · 第 1 卷细纲
            {st.importedChapters.length > 0 ? ` · ${st.importedChapters.length} 章导入正文（逐章归档）` : ''}
          </p>
          <button onClick={createBook} disabled={!!creating || !canNextBook(st)} className={btnCls}>
            {creating || '确认无误，一键成书 → 进入长篇写作'}
          </button>
        </section>
      )}

      {/* 上一步 / 下一步 */}
      <div className="flex justify-between">
        <button onClick={() => patch({ step: Math.max(0, step - 1) })} disabled={step === 0 || !!busy || !!creating} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-600 hover:bg-[#fbf8ef] disabled:opacity-40">
          ← 上一步
        </button>
        {step < 6 && (
          <button onClick={() => patch({ step: step + 1 })} disabled={!canNext || !!busy || !!creating} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40">
            下一步 →
          </button>
        )}
      </div>
    </div>
  )
}

// 成书前置条件：圣经世界观 + 主线 + 卷结构 + 第 1 卷细纲
function canNextBook(st) {
  return !!st.bible?.world && !!st.mainline && st.volumes.length > 0 && !!st.outline
}
