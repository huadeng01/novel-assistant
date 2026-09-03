import { useEffect, useMemo, useRef, useState } from 'react'
import KeyBanner from '../components/KeyBanner.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import ReviewPanel from '../components/ReviewPanel.jsx'
import ChapterRewriter from '../components/ChapterRewriter.jsx'
import DiscussionPanel from '../components/DiscussionPanel.jsx'
import Ic from '../components/Ic.jsx'
import { chatStream, chatJSON, embeddingEnabled } from '../lib/llm.js'
import { getAll, getById, put, del } from '../lib/db.js'
import {
  analyzeMessages,
  synopsisMessages,
  worldMessages,
  outlineMessages,
  summarizeMessages,
  longFormDraftMessages,
  chapterTitleMessages,
  foreshadowPlanMessages,
  scenePlanMessages,
  outlineExtendMessages,
  bookAnalyzeMessages,
  directorAnglesMessages,
  directorCastMessages,
  sampleNovel,
  segmentRewriteMessages,
  SEGMENT_MODES,
  GENRES,
  TONES,
  TEMPLATE_RULES,
} from '../lib/prompts.js'
import { newProject, searchChapters, semanticPassages, runPostChapter, applyReport, applyForeshadowPlans, outlineForChapter, outlineMaxChapter, outlinePositionFor, expandKeywords, povStreak, reviewOpportunity, rerunArchive, chronicleContext, restoreChapter, loadArchiveCheckpoint, clearArchiveCheckpoint, buildWorldBlockText, splitWorldToBlocks, activeStyleRules, trialWrite, referenceContext, needNewVolume, currentVolume, volumeStrategyText, planVolume, arcTextForRange, refSimilarityReport, aiFlavorScan, hookCheck, properNounScan, settlementReport, exportBookText, PROTECT_GAP } from '../lib/longform.js'
import { countWords, uid, downloadText } from '../lib/utils.js'

// 长篇一致性系统的交互中枢：
// 章节写作（上下文组装 + 章后档案流水线）、伏笔账本（保护期）、设定与人物活档案、事件级时间线、诊断看板
const SUBTABS = [
  { id: 'chapters', label: '章节写作', icon: 'book' },
  { id: 'foreshadow', label: '伏笔账本', icon: 'hook' },
  { id: 'settings', label: '设定与人物', icon: 'gear' },
  { id: 'analysis', label: '拆书工作台', icon: 'search' },
  { id: 'timeline', label: '时间线', icon: 'hourglass' },
  { id: 'dashboard', label: '质检中心', icon: 'doctor' },
]

const OVERDUE_CHAPTERS = 20 // 伏笔埋设超过这么多章仍未回收时提醒

export default function LongFormPage({ apiKey, glmKey, onNeedKey }) {
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [subtab, setSubtab] = useState('chapters')
  const [err, setErr] = useState('')
  const [newName, setNewName] = useState('')

  // 章节写作状态
  const [instruction, setInstruction] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [savingMsg, setSavingMsg] = useState('')
  const [lastReport, setLastReport] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  // 导入已有文本开局
  const [seedText, setSeedText] = useState('')
  const [seeding, setSeeding] = useState('')
  // 伏笔手动登记
  const [newHook, setNewHook] = useState({ content: '', importance: '主线' })
  // 两段式写作：本章场景清单（第一步规划、用户确认后再扩写，防 AI 进程过快跳过应展开的场景）
  const [scenePlan, setScenePlan] = useState('')
  const [planningScene, setPlanningScene] = useState(false)
  // 本章出场人物（场景清单阶段由 AI 圈定，用户可点按调整）；非空时初稿只注入这些人的档案，空则全量注入（旧行为）
  const [sceneChars, setSceneChars] = useState([])
  // 本章涉及地点（场景清单阶段由 AI 输出）：世界手册块选择性注入的主路依据；世界手册块拆分进度
  const [sceneLocs, setSceneLocs] = useState([])
  const [splittingWorld, setSplittingWorld] = useState(false)
  // 卷结构：AI 规划新卷进度（手动建档；自动断卷在连写循环内自动完成）
  const [planningVol, setPlanningVol] = useState(false)
  // 开书导演模式：方向候选清单、链路生成进度与文案（选方向后链式生成梗概/世界观/人物/细纲/卷战略，逐段可改）
  const [dirAngles, setDirAngles] = useState([])
  const [dirRunning, setDirRunning] = useState(false)
  const [dirMsg, setDirMsg] = useState('')
  // 防照搬算法兜底：人物与绑定参考作品功能位的相似度报告（null = 未检测；[] = 已检测无命中）
  const [simReport, setSimReport] = useState(null)
  // 写法引擎：书库与文风档案清单（供绑定下拉）、试写状态、自定义规则输入
  const [libBooks, setLibBooks] = useState([])
  const [libStyles, setLibStyles] = useState([])
  const [trialText, setTrialText] = useState('')
  const [trialing, setTrialing] = useState(false)
  const [newRule, setNewRule] = useState({ name: '', text: '' })
  // 拆书工作台：全局参考资产清单、待拆书目选择、拆解进度；绑定字段在书（refAnalysisId），资产全局共享，写别的书互不影响。
  const [analyses, setAnalyses] = useState([])
  const [analysisBookId, setAnalysisBookId] = useState('')
  const [analyzing, setAnalyzing] = useState('')
  // 整本自动连写：目标剩余章数、运行状态、循环内停止信号；待确认提案（自动模式遇到剧情分支暂停等拍板）
  const [autoCount, setAutoCount] = useState(3)
  const [autoStatus, setAutoStatus] = useState('')
  const autoStopRef = useRef(false)
  const [pendingDecision, setPendingDecision] = useState(null)
  const [decisionInput, setDecisionInput] = useState('')
  const [autoDoneMsg, setAutoDoneMsg] = useState('')
  // 归档检查点：保存章节途中被刷新/中断时，重进可从断点续跑，不必重跑全部请求
  // 补跑归档进度（降级补救 / 手改正文后重新建档）
  const [rerunning, setRerunning] = useState('')
  const [archiveCp, setArchiveCp] = useState(null)
  // 细纲续写进度（细纲耗尽/将尽时让 AI 紧接规划下一批）
  const [extending, setExtending] = useState(false)
  // 保存设定反馈：短时效提示，避免点击后无感知（实际持久化不变）
  const [settingsSaved, setSettingsSaved] = useState(false)
  // 设定表单（本地编辑，显式保存，避免流式生成时高频写库）
  const [form, setForm] = useState(null)
  const [genBusy, setGenBusy] = useState('')
  const seedFileRef = useRef(null)
  const composerRef = useRef(null)
  const abortRef = useRef(null)
  const [formVersion, setFormVersion] = useState(0)
  // 写作器状态按书隔离持久化：中断/刷新不丢未保存初稿，换书时草稿互不串扰（报告卡含降级提示也一并保留）
  const skipComposerSave = useRef(false)
  // 段级选中改写：编辑器内选中一段 → 按模式改写 → 预览后替换回原位（选中区段只在选中时出现）
  const [sel, setSel] = useState(null)
  const [segMode, setSegMode] = useState('polish')
  const [segReq, setSegReq] = useState('')
  const [segResult, setSegResult] = useState('')
  const [segBusy, setSegBusy] = useState(false)
  const segAbortRef = useRef(null)
  const draftTaRef = useRef(null)
  // 候选稿：生成另一版时当前稿自动入版本区，可载入/删除/对比（最多 3 版，随草稿快照持久化）
  const [versions, setVersions] = useState([])
  // 编辑器增强：章内搜索跳转 + 光标记忆（光标位置随草稿快照一起恢复）
  const [findStr, setFindStr] = useState('')
  // 剧情讨论面板（悬浮，绑定本书档案）
  const [discOpen, setDiscOpen] = useState(false)
  // 成书导出选项（卷分隔 / TXT 与 Markdown）
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState('txt')
  const [exportVols, setExportVols] = useState(true)
  const [showStats, setShowStats] = useState(false)

  useEffect(() => {
    getAll('projects').then((list) => {
      list.sort((a, b) => b.updatedAt - a.updatedAt)
      setProjects(list)
      setLoading(false)
      // 从新手写作迁移过来时自动选中新项目；普通刷新/中断后重进则恢复上次打开的书，无需手动查找
      const open = localStorage.getItem('na_open_project')
      const last = localStorage.getItem('na_lf_last')
      if (open && list.some((p) => p.id === open)) setSelectedId(open)
      else if (last && list.some((p) => p.id === last)) setSelectedId(last)
      localStorage.removeItem('na_open_project')
    })
    // 写法引擎：加载书库与已有文风档案（只留分析过文风的），供设定页绑定下拉选择；绑定后书级可随时切换或解绑。
    getAll('books').then(setLibBooks)
    getAll('styles').then((list) => setLibStyles(list.filter((s) => s && s.profile)))
    getAll('analyses').then((list) => setAnalyses(list.sort((a, b) => b.createdAt - a.createdAt)))
  }, [])

  // 记住当前打开的书，供中断/刷新后自动恢复（删书时同步清理）
  useEffect(() => {
    if (selectedId) localStorage.setItem('na_lf_last', selectedId)
  }, [selectedId])

  const project = projects.find((p) => p.id === selectedId) || null

  // AI 味输出层验证：草稿实时扫描（纯前端正则零费用）；禁词 = 预设禁词表 + 绑定文风的自定义禁用词；只报警不阻断。
  // 注意：依赖 form/libStyles/draft/project，必须放在四者声明之后（const 暂时性死区；project 在此行上方才声明）
  const boundStyleRec = libStyles.find((s) => s.bookId === (form?.styleBookId ?? project?.styleBookId)) || {}
  const flavorHits = useMemo(() => (draft.trim() ? aiFlavorScan(draft, boundStyleRec.forbidden || []) : []), [draft, boundStyleRec.forbidden])
  // 章末钩子检查 / 专名错字扫描 / 完稿对账 / 写作统计：纯前端计算零费用，只提醒不阻断
  const hookResult = useMemo(() => (draft.trim() ? hookCheck(draft) : null), [draft])
  const nounHits = useMemo(() => (draft.trim() && project ? properNounScan(draft, project.characters || []) : []), [draft, project])
  const settlement = useMemo(() => (project ? settlementReport(project) : null), [project])
  const stats = useMemo(() => {
    if (!project) return null
    const chs = project.chapters || []
    const total = chs.reduce((acc, c) => acc + (c.wordCount || 0), 0)
    const perDay = {}
    for (const c of chs) {
      const d = new Date(c.createdAt || 0)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      perDay[key] = (perDay[key] || 0) + (c.wordCount || 0)
    }
    const recent = Object.entries(perDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7).reverse()
    return { total, avg: chs.length ? Math.round(total / chs.length) : 0, recent }
  }, [project])

  // 切换书时：从该书的本地快照恢复写作器状态（草稿/标题/方向/场景清单/报告卡），不会把上一本书的草稿带过来；
  // 若当前正在流式生成则跳过切换恢复，避免中途打断写入半截内容（此时换书建议等生成完成）
  useEffect(() => {
    if (streaming || savingMsg) return
    let saved = null
    if (selectedId) {
      try {
        saved = JSON.parse(localStorage.getItem(`na_lf_draft_${selectedId}`))
      } catch {
        saved = null
      }
    }
    skipComposerSave.current = true // 本次提交内禁止回写，防止旧书的草稿被写进新书的键里，下次状态变更再正常落盘。
    setDraft(saved?.draft || '')
    setDraftTitle(saved?.draftTitle || '')
    setInstruction(saved?.instruction || '')
    setScenePlan(saved?.scenePlan || '')
    setSceneChars(Array.isArray(saved?.sceneChars) ? saved.sceneChars : [])
    setSceneLocs(Array.isArray(saved?.sceneLocs) ? saved.sceneLocs : [])
    setLastReport(saved?.lastReport || null)
    // 待确认提案也入快照：自动连写暂停等拍板时刷新页面不丢决策（决策后自动续跑剩余章数）
    setPendingDecision(saved?.pendingDecision || null)
    setVersions(Array.isArray(saved?.versions) ? saved.versions : [])
    setSel(null)
    setSegResult('')
    setFindStr('')
    // 光标记忆：恢复上次编辑位置（等草稿写入 DOM 后再定位）
    if (Number.isFinite(saved?.cursor) && saved?.draft) {
      requestAnimationFrame(() => draftTaRef.current?.setSelectionRange(saved.cursor, saved.cursor))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // 写作器防抖落盘（800ms）：刷新/中断后可恢复到最近一次编辑状态；保存章节后状态清空会自动覆盖旧快照
  useEffect(() => {
    if (!selectedId) return
    if (skipComposerSave.current) {
      skipComposerSave.current = false
      return
    }
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          `na_lf_draft_${selectedId}`,
          JSON.stringify({ draft, draftTitle, instruction, scenePlan, sceneChars, sceneLocs, lastReport, pendingDecision, versions, cursor: draftTaRef.current?.selectionStart ?? 0 }),
        )
      } catch {
        /* 快照写失败不影响写作 */
      }
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, draft, draftTitle, instruction, scenePlan, sceneChars, sceneLocs, lastReport, versions])

  // 重进时检查归档检查点：上次保存章节途中被刷新/中断的话，提示从断点续跑（只补未完成的步骤）
  useEffect(() => {
    setArchiveCp(project ? loadArchiveCheckpoint(project.id) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  // 切换项目、或项目被导入开局等外部写入后，同步设定表单（防止旧表单覆盖新档案）
  useEffect(() => {
    if (!project) {
      setForm(null)
      return
    }
    setForm({
      idea: project.idea || '',
      genre: project.genre || GENRES[0],
      tone: project.tone || TONES[0],
      synopsis: project.synopsis || '',
      world: project.world || '',
      worldBlocks: project.worldBlocks || [],
      outline: project.outline || '',
      outlineCount: project.outlineCount || 10,
      protagonist: project.protagonist || '',
      characters: project.characters || [],
      styleBookId: project.styleBookId || '',
      ruleIds: project.ruleIds ?? null,
      customRules: project.customRules || [],
      refAnalysisId: project.refAnalysisId || '',
      volumes: project.volumes || [],
      volumeLength: project.volumeLength ?? 20,
    })
    setSimReport(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, formVersion])

  const saveProject = async (next) => {
    await put('projects', next)
    setProjects((prev) => {
      const i = prev.findIndex((p) => p.id === next.id)
      const list = i >= 0 ? prev.map((p) => (p.id === next.id ? next : p)) : [next, ...prev]
      return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    })
  }

  const updateProject = (patch) => {
    if (!project) return
    saveProject({ ...project, ...patch, updatedAt: Date.now() })
  }

  const createProject = async () => {
    const name = newName.trim() || `未命名 ${new Date().toLocaleDateString()}`
    const p = newProject(name)
    await saveProject(p)
    setSelectedId(p.id)
    setNewName('')
  }

  const removeProject = async (id) => {
    await del('projects', id)
    localStorage.removeItem(`na_lf_draft_${id}`)
    if (localStorage.getItem('na_lf_last') === id) localStorage.removeItem('na_lf_last')
    setProjects((prev) => prev.filter((p) => p.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  // ---------- 章节写作 ----------
  const nextNo = project ? (project.chapters || []).reduce((m, c) => Math.max(m, c.chapterNo), 0) + 1 : 1
  const lastChapter = project && project.chapters.length ? project.chapters[project.chapters.length - 1] : null
  const activeHooks = project ? (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及') : []

  const generateDraft = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setLastReport(null)
    setStreaming(true)
    if (draft.trim()) stashVersion() // 当前稿先入版本区，重新生成不覆盖旧稿
    setDraft('')
    abortRef.current = new AbortController() // 停止按钮用：中止后已生成部分保留在编辑框
    const hadTitle = draftTitle.trim()
    try {
      // 上下文组装：前文召回优先走向量语义召回（「我的」页启用智谱 Embedding-3 且有智谱 Key 时），
      // 不可用/未启用则走轻量 LLM 扩词 + 本地关键词检索（方案 A，零额外费用）；
      // 细纲按需注入（只取本章及后续两章），卷志长时记忆拼接注入，避免百万字时上下文溢出
      let passages = null
      if (embeddingEnabled() && glmKey) {
        try {
          const sem = await semanticPassages({ glmKey, chapters: project.chapters, instruction })
          passages = sem.passages
          // 向量缓存落盘（只对新增章节补向量化，成本极低）；失败不阻塞写作。
          if (sem.changed) saveProject({ ...project, chapters: sem.chapters })
        } catch {
          passages = null // 向量服务不可用，降级回关键词检索
        }
      }
      if (!passages) {
        const kws = await expandKeywords({ apiKey, instruction, characters: project.characters, world: project.world })
        passages = searchChapters(project.chapters, kws)
      }
      const longTerm = (project.memory || []).map((m) => m.text).join('\n\n')
      // 视角约束：以主角线为主，非主角视角连续不超过 3~5 章；达上限时本章强制回到主角视角
      const streak = povStreak(project.chapters, project.protagonist)
      let povRule = ''
      if (project.protagonist) {
        if (streak >= 5) povRule = `非主角视角已连续 ${streak} 章，已达上限；本章必须回到主角「${project.protagonist}」的视角。`
        else if (streak >= 3) povRule = `非主角视角已连续 ${streak} 章（上限 3~5 章），本章优先回到主角「${project.protagonist}」的视角；如仍用他人视角，篇幅控制在三分之一以内。`
      }
      // 成文参数（逐场景扩写与单次生成共用）；取表单实时值，未保存的设定编辑也立即生效
      const styleRecNow = libStyles.find((s) => s.bookId === (form?.styleBookId ?? project.styleBookId)) || {}
      const draftArgs = {
        chapterNo: nextNo,
        synopsis: project.synopsis,
        world: project.world,
        worldBlockText: buildWorldBlockText(project, { locations: sceneLocs, fallbackText: `${instruction}\n${lastChapter?.summary || ''}` }),
        characters: project.characters,
        participants: sceneChars.length ? sceneChars : null,
        outline: outlineForChapter(project.outline, nextNo),
        longTerm,
        rollingSummary: project.rollingSummary,
        prevChapterSummary: lastChapter?.summary || '',
        tail: lastChapter ? lastChapter.content.slice(-2000) : project.synopsis || project.world || '',
        foreshadows: activeHooks,
        storylines: project.storylines || [],
        povRule,
        scenePlan,
        chronicles: chronicleContext(project, 3000, sceneChars.length ? sceneChars : null),
        passages,
        instruction,
        // 写法引擎：本书绑定的文风档案 + 范例（few-shot）+ 反模板规则（未绑定则不注入文风）
        style: styleRecNow.profile || '',
        forbidden: styleRecNow.forbidden || [],
        samples: styleRecNow.samples || [],
        rules: activeStyleRules({ ...project, ruleIds: form?.ruleIds ?? project.ruleIds, customRules: form?.customRules ?? project.customRules }),
        // 卷结构：本章所属卷的战略（卷档案未启用时为空不注入；卷末才允许落在卷级钩子上）
        volumeStrategy: volumeStrategyText(project, nextNo),
        // 起承转合定位：细纲章头标签（旧细纲无标签时为空不注入）
        chapterPosition: outlinePositionFor(project.outline, nextNo),
        // 拆书工作台：绑定的参考资产只注入结构层叙事功能（不含原作专名），附硬约束防照搬；未绑定则为空不注入。
        reference: referenceContext(analyses.find((a) => a.id === (form?.refAnalysisId ?? project.refAnalysisId))),
      }
      // 逐场景扩写：场景清单 ≥2 个时每场景一次请求（600~900 字），根治单次生成后段压缩；无场景清单退回单次生成（旧行为）
      const scenes = String(scenePlan || '').split('\n').map((s) => s.trim()).filter(Boolean)
      let full = ''
      if (scenes.length >= 2) {
        let base = ''
        for (let i = 0; i < scenes.length; i++) {
          const piece = await chatStream({
            apiKey,
            messages: longFormDraftMessages({ ...draftArgs, scenePlan: scenes[i], upcoming: scenes.slice(i + 1).join('\n'), multiScene: true, withTitle: i === 0, tail: base ? base.slice(-2000) : draftArgs.tail }),
            temperature: 0.9,
            signal: abortRef.current?.signal,
            onDelta: (t) => setDraft(base + t),
          })
          base += (base ? '\n\n' : '') + String(piece).trim()
        }
        full = base
      } else {
        full = await chatStream({
          apiKey,
          messages: longFormDraftMessages(draftArgs),
          temperature: 0.9,
          signal: abortRef.current?.signal,
          onDelta: (t) => setDraft(t),
        })
      }
      // 标题：优先从初稿第一行解析（提示词已约定第一行为标题，零额外请求）；解析不出才降级单独调 AI 起标题
      if (full) {
        const lines = full.split('\n')
        const firstIdx = lines.findIndex((l) => l.trim())
        const firstLine = firstIdx >= 0 ? lines[firstIdx].trim() : ''
        let autoTitle = ''
        if (firstLine) {
          const m = firstLine.match(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[：:\s]*(.*)$/)
          if (m) autoTitle = m[1].trim()
          else if (firstLine.length <= 20 && !/[。！？!?…，,]$/.test(firstLine)) autoTitle = firstLine
        }
        if (autoTitle && firstIdx >= 0) {
          // 把标题行从正文中剥离，标题填入标题输入框（仍可修改）
          setDraft(lines.slice(firstIdx + 1).join('\n').replace(/^\s+/, ''))
          if (!hadTitle) setDraftTitle(autoTitle)
        } else if (!hadTitle) {
          try {
            const t = (await chatJSON({ apiKey, messages: chapterTitleMessages({ text: full }), temperature: 0.5 })).title
            if (t) setDraftTitle(t)
          } catch {
            /* 标题生成失败不阻塞写作 */
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') setErr('已停止生成。已生成的部分保留在下方编辑框，可继续修改或重新生成。')
      else setErr(e.message)
    } finally {
      abortRef.current = null
      setStreaming(false)
    }
  }

  // ---------- 候选稿：当前稿存入版本区（最多 3 版），生成另一版时自动触发 ----------
  const stashVersion = () => {
    setVersions((prev) => [...prev, { title: draftTitle, text: draft, at: Date.now() }].slice(-3))
  }

  // ---------- 段级选中改写：选中草稿中的一段，按模式改写后预览替换 ----------
  const onDraftSelect = (e) => {
    const t = e.target
    const s = t.selectionStart
    const en = t.selectionEnd
    if (s !== en && en - s >= 8) setSel({ start: s, end: en, text: t.value.slice(s, en) })
    else setSel(null)
  }

  const runSegmentRewrite = async () => {
    if (!apiKey) return onNeedKey()
    if (!sel || sel.text.trim().length < 8) return
    setErr('')
    setSegBusy(true)
    setSegResult('')
    segAbortRef.current = new AbortController()
    try {
      const styleRecNow = libStyles.find((s) => s.bookId === (form?.styleBookId ?? project.styleBookId)) || {}
      const res = await chatStream({
        apiKey,
        messages: segmentRewriteMessages({
          mode: segMode,
          text: sel.text,
          before: draft.slice(Math.max(0, sel.start - 300), sel.start),
          after: draft.slice(sel.end, sel.end + 300),
          requirement: segReq,
          style: styleRecNow.profile || '',
          forbidden: styleRecNow.forbidden || [],
          samples: styleRecNow.samples || [],
          rules: activeStyleRules({ ...project, ruleIds: form?.ruleIds ?? project.ruleIds, customRules: form?.customRules ?? project.customRules }),
        }),
        temperature: 0.8,
        signal: segAbortRef.current.signal,
        onDelta: setSegResult,
      })
      setSegResult(res)
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message)
    } finally {
      segAbortRef.current = null
      setSegBusy(false)
    }
  }

  // 采用改写结果：替换选中区段（以发起时的坐标为准），并自动重扫
  const applySegResult = () => {
    if (!sel || !segResult) return
    const next = draft.slice(0, sel.start) + segResult.trim() + draft.slice(sel.end)
    setDraft(next)
    setSel(null)
    setSegResult('')
  }

  // ---------- 编辑器增强：章内搜索跳转（命中后选中并滚动到位置） ----------
  const jumpFind = () => {
    const t = draftTaRef.current
    if (!t || !findStr) return
    const v = draft
    const from = (t.selectionEnd || 0) === (t.selectionStart || 0) ? t.selectionStart : t.selectionEnd
    let idx = v.indexOf(findStr, from)
    if (idx < 0) idx = v.indexOf(findStr) // 回绕到开头
    if (idx < 0) return setErr(`草稿中没有找到"${findStr}"。`)
    setErr('')
    t.focus()
    t.setSelectionRange(idx, idx + findStr.length)
    const before = v.slice(0, idx)
    const line = before.split('\n').length - 1
    const style = getComputedStyle(t)
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6
    t.scrollTop = Math.max(0, line * lh - t.clientHeight / 2)
  }

  // ---------- 整本自动连写（纯逻辑：手动流程不受影响，显式传参避免闭包旧值） ----------
  // 从初稿输出解析标题行（与初稿协议一致：第一行为标题）
  const stripTitle = (full) => {
    const lines = String(full).split('\n')
    const firstIdx = lines.findIndex((l) => l.trim())
    if (firstIdx < 0) return { title: '', text: String(full) }
    const firstLine = lines[firstIdx].trim()
    let title = ''
    const m = firstLine.match(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[：:\s]*(.*)$/)
    if (m) title = m[1].trim()
    else if (firstLine.length <= 20 && !/[。！？!?…，,]$/.test(firstLine)) title = firstLine
    return title ? { title, text: lines.slice(firstIdx + 1).join('\n').replace(/^\s+/, '') } : { title: '', text: String(full) }
  }

  // 生成一章的完整链路：场景清单（顺带产出待确认提案）→ 前文召回 → 扩写初稿；不碰写作器 UI 状态。
  const generateChapterBody = async ({ proj, chapterNo, dir = '', onDelta }) => {
    let sceneText = ''
    let chars = []
    let locs = []
    let proposals = []
    const streak0 = povStreak(proj.chapters, proj.protagonist)
    let povShort = ''
    if (proj.protagonist) {
      if (streak0 >= 5) povShort = `非主角视角已连续 ${streak0} 章达上限，本章必须回到主角「${proj.protagonist}」的视角。`
      else if (streak0 >= 3) povShort = `优先回到主角「${proj.protagonist}」的视角。`
    }
    try {
      const res = await chatJSON({
        apiKey,
        messages: scenePlanMessages({
          chapterNo,
          synopsis: proj.synopsis,
          outline: outlineForChapter(proj.outline, chapterNo),
          rollingSummary: proj.rollingSummary,
          prevChapterSummary: proj.chapters[proj.chapters.length - 1]?.summary || '',
          storylines: proj.storylines || [],
          foreshadows: (proj.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
          povRule: povShort,
          instruction: dir,
          characters: proj.characters,
          chapterPosition: outlinePositionFor(proj.outline, chapterNo),
        }),
        temperature: 0.5,
      })
      const scenes = Array.isArray(res.scenes) ? res.scenes.filter((s) => s?.summary) : []
      if (scenes.length) {
        sceneText = scenes.map((s) => `${s.title ? s.title + '：' : ''}${s.summary}`).join('\n')
        locs = Array.isArray(res.locations) ? res.locations.map((s) => String(s).trim()).filter(Boolean) : []
        const roster = (proj.characters || []).map((c) => c.name)
        chars = Array.isArray(res.participants) ? [...new Set(res.participants.filter((n) => roster.includes(n)))] : []
        proposals = Array.isArray(res.proposals) ? res.proposals.filter((p) => p?.question && Array.isArray(p.options) && p.options.length) : []
      }
    } catch {
      /* 场景清单失败不阻塞：降级直接按细纲写 */
    }
    let passages = null
    if (embeddingEnabled() && glmKey) {
      try {
        const sem = await semanticPassages({ glmKey, chapters: proj.chapters, instruction: dir })
        passages = sem.passages
        if (sem.changed) saveProject({ ...proj, chapters: sem.chapters })
      } catch {
        passages = null
      }
    }
    if (!passages) {
      const kws = await expandKeywords({ apiKey, instruction: dir, characters: proj.characters, world: proj.world })
      passages = searchChapters(proj.chapters, kws)
    }
    const lastCh = proj.chapters[proj.chapters.length - 1] || null
    const hooks = (proj.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
    const streak = povStreak(proj.chapters, proj.protagonist)
    let povRule = ''
    if (proj.protagonist) {
      if (streak >= 5) povRule = `非主角视角已连续 ${streak} 章，已达上限；本章必须回到主角「${proj.protagonist}」的视角。`
      else if (streak >= 3) povRule = `非主角视角已连续 ${streak} 章（上限 3~5 章），本章优先回到主角「${proj.protagonist}」的视角；如仍用他人视角，篇幅控制在三分之一以内。`
    }
    const styleRec = libStyles.find((s) => s.bookId === proj.styleBookId) || {}
    const draftArgs = {
      chapterNo,
      synopsis: proj.synopsis,
      world: proj.world,
      worldBlockText: buildWorldBlockText(proj, { locations: locs, fallbackText: `${dir}\n${lastCh?.summary || ''}` }),
      characters: proj.characters,
      participants: chars.length ? chars : null,
      outline: outlineForChapter(proj.outline, chapterNo),
      longTerm: (proj.memory || []).map((m) => m.text).join('\n\n'),
      rollingSummary: proj.rollingSummary,
      prevChapterSummary: lastCh?.summary || '',
      tail: lastCh ? lastCh.content.slice(-2000) : proj.synopsis || proj.world || '',
      foreshadows: hooks,
      storylines: proj.storylines || [],
      povRule,
      scenePlan: sceneText,
      chronicles: chronicleContext(proj, 3000, chars.length ? chars : null),
      passages,
      instruction: dir,
      style: styleRec.profile || '',
      forbidden: styleRec.forbidden || [],
      samples: styleRec.samples || [],
      rules: activeStyleRules(proj),
      volumeStrategy: volumeStrategyText(proj, chapterNo),
      chapterPosition: outlinePositionFor(proj.outline, chapterNo),
      reference: referenceContext(analyses.find((a) => a.id === proj.refAnalysisId)),
    }
    // 逐场景扩写（与手动路径同机制）：场景 ≥2 个时每场景一次请求，根治后段压缩；无场景清单退回单次生成
    const scenes = String(sceneText || '').split('\n').map((s) => s.trim()).filter(Boolean)
    let full = ''
    if (scenes.length >= 2) {
      let base = ''
      for (let i = 0; i < scenes.length; i++) {
        const piece = await chatStream({
          apiKey,
          messages: longFormDraftMessages({ ...draftArgs, scenePlan: scenes[i], upcoming: scenes.slice(i + 1).join('\n'), multiScene: true, withTitle: i === 0, tail: base ? base.slice(-2000) : draftArgs.tail }),
          temperature: 0.9,
          onDelta: onDelta ? (t) => onDelta(base + t) : undefined,
        })
        base += (base ? '\n\n' : '') + String(piece).trim()
      }
      full = base
    } else {
      full = await chatStream({ apiKey, messages: longFormDraftMessages(draftArgs), temperature: 0.9, onDelta })
    }
    let { title, text } = stripTitle(full)
    if (!title) {
      try {
        title = (await chatJSON({ apiKey, messages: chapterTitleMessages({ text: full }), temperature: 0.5 })).title || ''
      } catch {
        /* 标题生成失败不阻塞 */
      }
    }
    if (countWords(text) < 100) throw new Error(`第 ${chapterNo} 章生成过短（${countWords(text)} 字），疑似异常`)
    return { text, title, proposals }
  }

  // 保存一章并跑章后档案流水线，返回新书对象供循环接棒（检查点照常逐步落盘，中断可续跑）
  const saveChapterText = async ({ proj, chapterNo, text, title }) => {
    const rep = await runPostChapter({
      apiKey,
      project: proj,
      chapterNo,
      text,
      title,
      checkpointId: proj.id,
      policy: proj.qualityPolicy === 'strict' ? 'strict' : 'fast',
      onStep: setSavingMsg,
    })
    const { project: next } = applyReport(proj, { chapterNo, title, text }, rep)
    await saveProject(next)
    clearArchiveCheckpoint(proj.id)
    setArchiveCp(null)
    return next
  }

  // 自动连写循环：场景清单 → 初稿 → 存档 → 下一章；暂停条件：
  // 待确认提案 / 细纲将尽 / 生成或存档报错 / 用户停止 / 达到目标章数。已完成的章都已安全落库。
  const autoContinue = async (remaining, startInstruction = '') => {
    let cur = await getById('projects', project.id)
    let left = remaining
    let dir = startInstruction
    try {
      while (left > 0) {
        if (autoStopRef.current) {
          setAutoStatus('')
          return
        }
        const no = (cur.chapters || []).reduce((m, c) => Math.max(m, c.chapterNo), 0) + 1
        const maxNo = outlineMaxChapter(cur.outline)
        if (maxNo && no > maxNo - 2) {
          setAutoStatus('')
          setErr('自动连写已暂停：细纲将尽。请先点「续写细纲」规划下一批，再重新启动自动连写。')
          return
        }
        setAutoStatus(`自动连写中：剩余 ${left} 章（正在写第 ${no} 章）`)
        // 自动断卷：卷档案已启用且本章超出末卷范围时，先 AI 规划新卷并落库，再带着卷战略继续写；未建档则不干预（卷结构是可选能力）
        if (needNewVolume(cur, no)) {
          setAutoStatus(`自动断卷中：正在 AI 规划第 ${(cur.volumes || []).length + 1} 卷战略…`)
          const vol = await planVolume({ apiKey, project: cur, startChapter: no })
          cur = { ...cur, volumes: [...(cur.volumes || []), vol] }
          await saveProject(cur)
        }
        const gen = await generateChapterBody({ proj: cur, chapterNo: no, dir, onDelta: (t) => setDraft(t) })
        if (gen.proposals.length) {
          // 遇到需要拍板的剧情分支：已生成的初稿保留在编辑框，暂停等用户决策（决策后自动续跑）
          setPendingDecision({ chapterNo: no, proposals: gen.proposals, remaining: left })
          setDraft(gen.text)
          setDraftTitle(gen.title)
          setAutoStatus(`自动连写暂停：第 ${no} 章遇到待确认的剧情分支`)
          return
        }
        cur = await saveChapterText({ proj: cur, chapterNo: no, text: gen.text, title: gen.title })
        setDraft('')
        setDraftTitle('')
        dir = ''
        left -= 1
      }
      setAutoStatus('')
      setErr('')
      setAutoDoneMsg(`已自动连写 ${remaining} 章，每章均走完整档案流水线（摘要/状态/伏笔/校验），可在章节列表回看。`)
    } catch (e) {
      setAutoStatus('')
      setErr(`自动连写已停止：${e.message}。已完成的章节均已安全存档，可检查后再启动自动连写继续。`)
    }
  }

  const startAuto = () => {
    if (!apiKey) return onNeedKey()
    const n = Math.min(10, Math.max(1, Number(autoCount) || 1))
    setAutoCount(n)
    setErr('')
    setAutoDoneMsg('')
    setLastReport(null)
    autoStopRef.current = false
    autoContinue(n)
  }

  // 提案拍板：自动模式下把决策并入本章方向并继续剩余章数；手动模式下只把决策写进写作方向输入框，后续照常手动操作。
  const decideProposal = (choice) => {
    const cur = pendingDecision
    if (!cur) return
    setPendingDecision(null)
    setDecisionInput('')
    if (cur.remaining) {
      setDraft('')
      setDraftTitle('')
      autoStopRef.current = false
      autoContinue(cur.remaining, `${choice}（本章必须按此方向推进）`)
    } else {
      setInstruction((prev) => (prev ? `${prev}；${choice}` : choice))
    }
  }

  // 两段式写作第一步：先规划本章 3~5 个场景，用户可编辑确认，再扩写正文（根治"进程太快/跳过场景"）
  const planScenes = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setPlanningScene(true)
    try {
      const streak = povStreak(project.chapters, project.protagonist)
      let povRule = ''
      if (project.protagonist) {
        if (streak >= 5) povRule = `非主角视角已连续 ${streak} 章，已达上限；本章必须回到主角「${project.protagonist}」的视角。`
        else if (streak >= 3) povRule = `优先回到主角「${project.protagonist}」的视角。`
      }
      const res = await chatJSON({
        apiKey,
        messages: scenePlanMessages({
          chapterNo: nextNo,
          synopsis: project.synopsis,
          outline: outlineForChapter(project.outline, nextNo),
          rollingSummary: project.rollingSummary,
          prevChapterSummary: lastChapter?.summary || '',
          storylines: project.storylines || [],
          foreshadows: activeHooks,
          povRule,
          instruction,
          characters: project.characters,
          chapterPosition: outlinePositionFor(project.outline, nextNo),
        }),
        temperature: 0.5,
      })
      const scenes = Array.isArray(res.scenes) ? res.scenes.filter((s) => s?.summary) : []
      if (!scenes.length) throw new Error('AI 未返回有效场景清单，请重试。')
      setScenePlan(scenes.map((s) => `${s.title ? s.title + '：' : ''}${s.summary}`).join('\n'))
      // 本章涉及地点：世界手册块选择性注入的主路依据（AI 定）
      setSceneLocs(Array.isArray(res.locations) ? res.locations.map((s) => String(s).trim()).filter(Boolean) : [])
      // AI 顺带圈定本章出场人物（只保留名单内姓名）；用户可在下方点按调整，初稿据此按需注入人物档案。
      const roster = project.characters.map((c) => c.name)
      setSceneChars(Array.isArray(res.participants) ? [...new Set(res.participants.filter((n) => roster.includes(n)))] : [])
      // 待确认提案：本章存在重大剧情分支时弹决策卡（手动模式拍板后写进写作方向；自动模式由循环处理）
      const props = Array.isArray(res.proposals) ? res.proposals.filter((p) => p?.question && Array.isArray(p.options) && p.options.length) : []
      if (props.length) setPendingDecision({ chapterNo: nextNo, proposals: props })
    } catch (e) {
      setErr(e.message)
    } finally {
      setPlanningScene(false)
    }
  }

  // 保存章节并跑章后档案流水线：摘要链 → 滚动摘要 → 状态回写 → 伏笔账本 → 一致性校验；
  // 开启检查点（checkpointId）：每完成一路归档落盘一次，途中刷新/中断可断点续跑；质量策略由书页设置决定（质量优先时失败自动重试一次）
  const saveChapter = async () => {
    if (!apiKey) return onNeedKey()
    if (countWords(draft) < 100) {
      setErr('初稿太短，请先生成或补充内容再保存。')
      return
    }
    setErr('')
    try {
      const rep = await runPostChapter({
        apiKey,
        project,
        chapterNo: nextNo,
        text: draft,
        title: draftTitle.trim(),
        checkpointId: project.id,
        policy: project.qualityPolicy === 'strict' ? 'strict' : 'fast',
        onStep: setSavingMsg,
      })
      // applyReport 返回拦截信息：保护期内的伏笔被 AI 抢收时不会真的标记回收，而是提示用户。
      const { project: next, blocked } = applyReport(project, { chapterNo: nextNo, title: draftTitle.trim(), text: draft }, rep)
      await saveProject(next)
      clearArchiveCheckpoint(project.id) // 落库成功，检查点使命完成。
      setArchiveCp(null)
      const report = { ...rep, chapterNo: nextNo, blocked, povStreak: povStreak(next.chapters, next.protagonist) }
      setLastReport(report)
      setDraft('')
      setDraftTitle('')
      setInstruction('')
      setScenePlan('')
      setSceneChars([])
      setSceneLocs([])
      // 保存成功后立即覆盖本书快照（不等 800ms 防抖）：避免刚存完就关页时旧草稿残留，重进误以为未保存；报告卡同步落盘。
      try {
        localStorage.setItem(`na_lf_draft_${next.id}`, JSON.stringify({ draft: '', draftTitle: '', instruction: '', scenePlan: '', sceneChars: [], sceneLocs: [], lastReport: report, versions: [] }))
      } catch {
        /* 快照写失败不影响写作 */
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setSavingMsg('')
    }
  }
  
  // 断点续跑：用检查点里已完成的步骤结果 + 重跑缺失部分，应用后落库（草稿快照同步清空，避免重复保存）
  const resumeArchive = async () => {
    if (!apiKey) return onNeedKey()
    const cp = archiveCp
    if (!cp || !project) return
    // 防御：该章已入库（极端情况下检查点未及时清理），直接丢弃检查点。
    if ((project.chapters || []).some((c) => c.chapterNo === cp.chapterNo)) {
      clearArchiveCheckpoint(project.id)
      setArchiveCp(null)
      return
    }
    setErr('')
    try {
      const rep = await runPostChapter({
        apiKey,
        project,
        chapterNo: cp.chapterNo,
        text: cp.text,
        title: cp.title || '',
        lanes: cp.lanes || {},
        checkpointId: project.id,
        policy: project.qualityPolicy === 'strict' ? 'strict' : 'fast',
        onStep: setSavingMsg,
      })
      const { project: next, blocked } = applyReport(project, { chapterNo: cp.chapterNo, title: cp.title || '', text: cp.text }, rep)
      await saveProject(next)
      clearArchiveCheckpoint(project.id)
      setArchiveCp(null)
      const report = { ...rep, chapterNo: cp.chapterNo, blocked, povStreak: povStreak(next.chapters, next.protagonist) }
      setLastReport(report)
      setDraft('')
      setDraftTitle('')
      setInstruction('')
      setScenePlan('')
      setSceneChars([])
      setSceneLocs([])
      try {
        localStorage.setItem(`na_lf_draft_${next.id}`, JSON.stringify({ draft: '', draftTitle: '', instruction: '', scenePlan: '', sceneChars: [], sceneLocs: [], lastReport: report, versions: [] }))
      } catch {
        /* 快照写失败不影响写作 */
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setSavingMsg('')
    }
  }

  // 导入已有长文开局：分析设定 + 首章入库 + 初始滚动摘要
  const seedFromText = async () => {
    if (!apiKey) return onNeedKey()
    if (countWords(seedText) < 200) {
      setErr('请先粘贴或导入至少几百字的已有正文。')
      return
    }
    setErr('')
    setSeeding('1/3 分析原文的世界观、人物与故事线…')
    try {
      const res = await chatJSON({ apiKey, messages: analyzeMessages({ text: seedText.slice(0, 60000) }), temperature: 0.3 })
      const characters = Array.isArray(res.characters)
        ? res.characters.filter((c) => c?.name).map((c) => ({ ...c, description: c.description || '', status: '' }))
        : []
      const events = Array.isArray(res.timeline) ? res.timeline.map((t) => ({ chapter: 0, text: `${t.stage}：${t.summary}` })) : []
      setSeeding('2/3 生成初始滚动摘要…')
      let summary = ''
      try {
        summary = (await chatJSON({ apiKey, messages: summarizeMessages({ text: seedText.slice(-12000) }), temperature: 0.3 })).summary || ''
      } catch {
        /* 摘要失败不阻塞导入 */
      }
      setSeeding('3/3 写入档案…')
      await saveProject({
        ...project,
        world: res.world_setting || project.world,
        outline: res.outline || project.outline,
        characters,
        events: [...project.events, ...events],
        rollingSummary: summary,
        chapters: [
          ...project.chapters,
          {
            id: uid(),
            chapterNo: 1,
            title: '既有正文',
            content: seedText,
            wordCount: countWords(seedText),
            summary,
            issueCount: 0,
            createdAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      })
      setSeedText('')
      setFormVersion((v) => v + 1)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSeeding('')
    }
  }

  // ---------- 设定生成（流式写入本地表单，保存时才落库） ----------
  const genField = async (messages, field, temperature) => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setGenBusy(field)
    setForm((f) => ({ ...f, [field]: '' }))
    try {
      await chatStream({ apiKey, messages, temperature, onDelta: (full) => setForm((f) => ({ ...f, [field]: full })) })
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenBusy('')
    }
  }

  const saveSettings = () => {
    if (!project || !form) return
    updateProject({
      idea: form.idea,
      genre: form.genre,
      tone: form.tone,
      synopsis: form.synopsis,
      world: form.world,
      worldBlocks: form.worldBlocks,
      outline: form.outline,
      outlineCount: form.outlineCount,
      protagonist: form.protagonist,
      characters: form.characters,
      styleBookId: form.styleBookId,
      ruleIds: form.ruleIds,
      customRules: form.customRules,
      refAnalysisId: form.refAnalysisId,
      volumes: form.volumes,
      volumeLength: form.volumeLength,
    })
    // 防照搬算法兜底：保存设定后自动检测人物与绑定参考作品功能位的相似度（未绑定则不检测）
    const boundRef = analyses.find((a) => a.id === form.refAnalysisId)
    setSimReport(boundRef ? refSimilarityReport({ characters: form.characters, analysis: boundRef }) : null)
    setErr('')
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2500)
  }

  // ---------- 世界手册结构化块 ----------
  const addWorldBlock = () => {
    setForm((f) => ({ ...f, worldBlocks: [...f.worldBlocks, { id: uid(), name: '', aliases: '', kind: '设定', content: '' }] }))
  }
  const patchWorldBlock = (id, patch) => {
    setForm((f) => ({ ...f, worldBlocks: f.worldBlocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))
  }
  // AI 拆块：把自由文本世界观拆成结构化块（覆盖现有块）；拆完点「保存设定」生效，写作时按本章地点选择性注入、规则块永不省略。
  const splitWorld = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setSplittingWorld(true)
    try {
      const blocks = await splitWorldToBlocks({ apiKey, world: form.world })
      if (!blocks.length) throw new Error('AI 未能拆出世界手册块，请检查世界观文本后重试。')
      setForm((f) => ({ ...f, worldBlocks: blocks }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setSplittingWorld(false)
    }
  }

  // ---------- 卷结构：显式卷档案，写作注入本卷战略；自动连写超出末卷范围时自动断卷 ----------
  const patchVolume = (id, patch) => {
    setForm((f) => ({ ...f, volumes: f.volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)) }))
  }
  // AI 规划下一卷：从下一章接棒；卷档案未启用时第一次点击即启用（第 1 卷从第 1 章或已有章节后接棒）。规划结果立即落库（自动连写读的是库内数据），不等保存设定。
  const planNextVol = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setPlanningVol(true)
    try {
      const vols = form.volumes || []
      const last = vols[vols.length - 1]
      const maxNo = (project.chapters || []).reduce((m, c) => Math.max(m, c.chapterNo), 0)
      if (last && !last.length) return setErr('末卷为开放式（计划章数 0），会一直承接后续章节；如需断卷请先给它填计划章数。')
      if (last && last.startChapter + last.length - 1 > maxNo) return setErr(`第 ${last.volumeNo} 卷尚未写完（计划到第 ${last.startChapter + last.length - 1} 章），无需规划新卷。`)
      const start = last ? last.startChapter + last.length : Math.max(1, maxNo + 1)
      const vol = await planVolume({ apiKey, project: { ...project, volumes: vols, volumeLength: form.volumeLength ?? 20 }, startChapter: start })
      const volumes = [...vols, vol]
      setForm((f) => ({ ...f, volumes }))
      updateProject({ volumes })
    } catch (e) {
      setErr(e.message)
    } finally {
      setPlanningVol(false)
    }
  }

  // ---------- 开书导演模式：一句话灵感 → 方向候选（拍板）→ 链式生成全套开书资产 ----------
  const directorAngles = async () => {
    if (!apiKey) return onNeedKey()
    if (form.idea.trim().length < 5) return setErr('先写一句话灵感（至少 5 个字），再生成开书方向。')
    setErr('')
    setDirAngles([])
    setDirRunning(true)
    setDirMsg('AI 正在策划开书方向…')
    try {
      const res = await chatJSON({ apiKey, messages: directorAnglesMessages({ idea: form.idea.trim() }), temperature: 0.9 })
      const angles = Array.isArray(res.angles) ? res.angles.filter((a) => a?.pitch).slice(0, 3) : []
      if (!angles.length) throw new Error('AI 未能给出方向候选，请重试。')
      setDirAngles(angles)
      setDirMsg('选一个开书方向，AI 将链式生成全套开书资产（逐段可改）')
    } catch (e) {
      setErr(e.message)
    } finally {
      setDirRunning(false)
    }
  }

  // 选定方向后链式生成：梗概 → 世界观 → 人物班底 → 第 1 卷战略 → 前 10 章细纲（带卷弧线坐标）；
  // 全部填入表单逐段可改，确认后一次落库；中途失败已生成部分保留，可手动接力。
  const runDirector = async (angle) => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setDirRunning(true)
    try {
      const idea2 = `${form.idea.trim()}（选定方向：${angle.pitch}）`
      const genre = GENRES.includes(angle.genre) ? angle.genre : form.genre
      const tone = TONES.includes(angle.tone) ? angle.tone : form.tone
      // 逐步落库：每步生成完立即写入已生成的全部字段，中途刷新/失败不丢已完成部分（不再只在最后一步落库）
      const aiTitle = angle.title || ''
      // 书名保护：用户已起名时绝不静默覆盖，AI 起的是"作品名候选"；仅书名为空或默认值时才采用。
      const patch = { idea: form.idea, genre, tone }
      if (!String(project.name || '').trim() || project.name === '未命名') patch.name = aiTitle || project.name
      const commit = () => saveProject({ ...project, ...patch, updatedAt: Date.now() })
      setDirMsg('1/5 生成故事梗概…')
      const synopsis = await chatStream({ apiKey, messages: synopsisMessages({ idea: idea2, genre, tone }), temperature: 0.9 })
      patch.synopsis = synopsis
      setForm((f) => ({ ...f, genre, tone, synopsis }))
      await commit()
      setDirMsg('2/5 生成世界观…')
      const world = await chatStream({ apiKey, messages: worldMessages({ synopsis }), temperature: 0.8 })
      patch.world = world
      setForm((f) => ({ ...f, world }))
      await commit()
      setDirMsg('3/5 生成人物班底…')
      const cast = await chatJSON({ apiKey, messages: directorCastMessages({ synopsis, world }), temperature: 0.7 })
      const characters = (Array.isArray(cast.characters) ? cast.characters : [])
        .filter((c) => c?.name)
        .slice(0, 8)
        .map((c) => ({ name: String(c.name), aliases: [], identity: c.identity || '', personality: c.personality || '', description: c.description || '', status: '' }))
      patch.characters = characters
      patch.protagonist = characters[0]?.name || ''
      setForm((f) => ({ ...f, characters, protagonist: characters[0]?.name || '' }))
      await commit()
      setDirMsg('4/5 规划第 1 卷战略…')
      const vol = await planVolume({ apiKey, project: { ...project, ...patch, volumes: [] }, startChapter: 1 })
      patch.volumes = [vol]
      setForm((f) => ({ ...f, volumes: [vol] }))
      await commit()
      setDirMsg('5/5 生成前 10 章细纲（对齐卷弧线）…')
      const volumeContext = arcTextForRange({ ...project, ...patch }, 1, 10)
      const outline = await chatStream({ apiKey, messages: outlineMessages({ synopsis, world, count: 10, volumeContext }), temperature: 0.7 })
      patch.outline = outline
      patch.outlineCount = 10
      setForm((f) => ({ ...f, outline, outlineCount: 10 }))
      await commit()
      setDirAngles([])
      // 防照搬算法兜底：AI 生成的人物班底立即与绑定参考作品功能位比对（命中在结果卡列出提醒重写）
      const boundRef = analyses.find((a) => a.id === project.refAnalysisId)
      setSimReport(boundRef ? refSimilarityReport({ characters, analysis: boundRef }) : null)
      setDirMsg(`导演模式完成：《${patch.name || project.name}》全套开书资产已就位，可逐段审阅修改后直接开写。${aiTitle && patch.name !== aiTitle ? `（AI 建议的作品名《${aiTitle}》未覆盖你的书名，如需用请在书名处自行修改）` : ''}`)
    } catch (e) {
      setDirMsg('')
      setErr(`导演链路中断：${e.message}。可检查已有内容后手动接力各步生成按钮。`)
    } finally {
      setDirRunning(false)
    }
  }

  // ---------- 写法引擎：反模板规则勾选 / 自定义规则 / 试写 ----------
  const ruleOn = (id) => form.ruleIds == null || form.ruleIds.includes(id)
  const toggleRule = (id) => {
    const cur = form.ruleIds == null ? TEMPLATE_RULES.map((r) => r.id) : [...form.ruleIds]
    setForm({ ...form, ruleIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }
  const addCustomRule = () => {
    const name = newRule.name.trim()
    const text = newRule.text.trim()
    if (!text) return
    setForm({ ...form, customRules: [...form.customRules, { id: uid(), name: name || '自定义规则', text }] })
    setNewRule({ name: '', text: '' })
  }
  // 试写：用表单里未保存的编辑（勾选/自定义/绑定）预览效果，避免改完还得先保存才能验证。
  const runTrial = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setTrialing(true)
    setTrialText('')
    try {
      const styleRec = libStyles.find((s) => s.bookId === form.styleBookId) || null
      const text = await trialWrite({ apiKey, project: { ...project, ruleIds: form.ruleIds, customRules: form.customRules }, styleRec })
      setTrialText(text || '')
    } catch (e) {
      setErr(e.message)
    } finally {
      setTrialing(false)
    }
  }

  // ---------- 拆书工作台：拆书 / 资产维护 / 绑定 ----------
  // 拆书：采样全书 → AI 拆出叙事功能资产（强制去专名）→ 存全局资产库；默认绑定到当前打开的书（可随时切换/解绑）。
  const analyzeBook = async () => {
    if (!apiKey) return onNeedKey()
    const book = libBooks.find((b) => b.id === analysisBookId)
    if (!book) return
    setErr('')
    setAnalyzing(book.name)
    try {
      const res = await chatJSON({ apiKey, messages: bookAnalyzeMessages(sampleNovel(book.content)), temperature: 0.3 })
      if (!res.work_function && !(res.character_functions || []).length) throw new Error('AI 未返回有效拆解结果，请重试。')
      const rec = {
        id: uid(),
        name: book.name,
        bookId: book.id,
        createdAt: Date.now(),
        work_function: res.work_function || '',
        character_functions: Array.isArray(res.character_functions) ? res.character_functions : [],
        pacing_patterns: Array.isArray(res.pacing_patterns) ? res.pacing_patterns : [],
        techniques: Array.isArray(res.techniques) ? res.techniques : [],
      }
      await put('analyses', rec)
      setAnalyses((prev) => [rec, ...prev])
      // 默认绑定到当前书；写其他书时在各自设定页切换绑定，互不影响
      if (project) {
        updateProject({ refAnalysisId: rec.id })
        setForm((f) => (f ? { ...f, refAnalysisId: rec.id } : f))
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setAnalyzing('')
    }
  }
  const removeAnalysis = async (id) => {
    await del('analyses', id)
    setAnalyses((prev) => prev.filter((a) => a.id !== id))
    // 当前书绑定的资产被删时同步解绑，避免指向不存在资产。
    if (project?.refAnalysisId === id) {
      updateProject({ refAnalysisId: '' })
      setForm((f) => (f ? { ...f, refAnalysisId: '' } : f))
    }
  }

  // ---------- 伏笔账本 ----------
  const addHook = () => {
    if (!project || !newHook.content.trim()) return
    const planted = Math.max(0, nextNo - 1)
    updateProject({
      foreshadows: [
        ...project.foreshadows,
        {
          id: uid(),
          content: newHook.content.trim(),
          relatedChars: [],
          importance: newHook.importance,
          plantedChapter: planted,
          minResolveChapter: planted + (PROTECT_GAP[newHook.importance] || 5),
          status: '未回收',
          resolveChapter: null,
        },
      ],
    })
    setNewHook({ content: '', importance: '主线' })
  }
  const setHookStatus = (id, status) => {
    updateProject({
      foreshadows: project.foreshadows.map((f) =>
        f.id === id ? { ...f, status, resolveChapter: status === '已回收' ? Math.max(0, nextNo - 1) : null } : f,
      ),
    })
  }

  // 伏笔节奏规划：让 AI 为未回收伏笔规划发酵期，写回保护期（只延长不缩短），防止伏笔被抢收
  const [planning, setPlanning] = useState(false)
  const planPace = async () => {
    if (!apiKey) return onNeedKey()
    if (!activeHooks.length) return
    setErr('')
    setPlanning(true)
    try {
      const res = await chatJSON({
        apiKey,
        messages: foreshadowPlanMessages({ currentChapter: Math.max(0, nextNo - 1), active: activeHooks }),
        temperature: 0.3,
      })
      saveProject(applyForeshadowPlans(project, Array.isArray(res.plans) ? res.plans : []))
    } catch (e) {
      setErr(e.message)
    } finally {
      setPlanning(false)
    }
  }

  // 诊断看板的输入：用各章摘要链 + 最新章节尾部组装（百万字也能诊断，不吃上下文）
  const diagnoseText = project
    ? [
        ...(project.chapters || []).map((c) => `第${c.chapterNo}章 ${c.title}：${c.summary || c.content.slice(0, 200)}`),
        lastChapter ? `最新章节结尾：${lastChapter.content.slice(-3000)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''
  const diagnoseContext = project
    ? [project.synopsis && `【故事梗概】${project.synopsis.slice(0, 500)}`, activeHooks.length && `【未回收伏笔】${activeHooks.map((f) => f.content).join('；')}`]
        .filter(Boolean)
        .join('\n')
    : ''

  const totalWords = project ? (project.chapters || []).reduce((s, c) => s + c.wordCount, 0) : 0
  const chip = (active) =>
    `rounded-full px-3.5 py-2 text-sm transition-colors ${active ? 'bg-stone-800 text-white' : 'border border-stone-200 text-stone-600 hover:bg-stone-50'}`
  const busy = streaming || !!savingMsg || !!seeding || planning || planningScene || !!rerunning || extending || !!autoStatus

  // 细纲续航：剩余不足 3 章或已耗尽时提示续写，AI 基于滚动摘要与故事线紧接规划后 15 章，追加进细纲（百万字不断地图）
  const outlineMax = project ? outlineMaxChapter(project.outline) : 0
  const outlineLow = !!project && outlineMax > 0 && outlineMax - nextNo < 3
  // 总览聚合：下一章定位/卷归属/伏笔回收窗口/资产就绪度（纯前端计算，零请求）
  const nextPos = project ? outlinePositionFor(project.outline, nextNo) : ''
  const nextVol = project ? currentVolume(project, nextNo) : null
  const hooksReady = project ? activeHooks.filter((f) => !f.minResolveChapter || f.minResolveChapter <= nextNo).length : 0
  const boundStyle = libStyles.find((s) => s.bookId === (form?.styleBookId ?? project?.styleBookId)) || null
  const assetReady = project ? [project.synopsis, project.world, project.characters.length, outlineMax > 0, boundStyle, (project.volumes || []).length].filter(Boolean).length : 0
  const extendOutline = async () => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setExtending(true)
    try {
      const full = await chatStream({
        apiKey,
        messages: outlineExtendMessages({
          fromChapter: outlineMax + 1,
          count: 15,
          synopsis: project.synopsis,
          rollingSummary: project.rollingSummary,
          storylines: project.storylines || [],
          outlineTail: project.outline.slice(-1500),
          volumeContext: arcTextForRange(project, outlineMax + 1, outlineMax + 15),
        }),
        temperature: 0.7,
      })
      if (countWords(full) < 50) throw new Error('AI 未返回有效细纲，请重试。')
      await saveProject({ ...project, outline: `${project.outline}\n\n${full.trim()}`, updatedAt: Date.now() })
      setFormVersion((v) => v + 1)
    } catch (e) {
      setErr(e.message)
    } finally {
      setExtending(false)
    }
  }

  // 恢复替换前的原稿（一键重写不满意时的后悔药，替换前原稿已自动存进章节快照）
  const restorePrev = async (chapterNo) => {
    if (!window.confirm(`确定把第 ${chapterNo} 章恢复为替换前的原稿吗？当前重写版将被丢弃。`)) return
    await saveProject(restoreChapter(project, chapterNo))
  }

  // 补跑归档：对已保存章节重跑章后流水线（降级补救 / 手改正文后重新建档）
  const rerunChapter = async (chapterNo) => {
    if (!apiKey) return onNeedKey()
    setErr('')
    setRerunning(`正在重新归档第 ${chapterNo} 章…`)
    try {
      const { project: next } = await rerunArchive({ apiKey, project, chapterNo, onStep: setRerunning })
      await saveProject(next)
    } catch (e) {
      setErr(e.message)
    } finally {
      setRerunning('')
    }
  }

  // 成书导出：卷分隔可选、TXT / Markdown 双格式（卷档案的卷名与卷号终于用在了成书里）
  const exportBook = () => {
    const ext = exportFormat === 'md' ? 'md' : 'txt'
    downloadText(`${project.name || '小说'}.${ext}`, exportBookText(project, { format: exportFormat, withVolumes: exportVols }))
    setExportOpen(false)
  }

  // 审核机会：写满 5 章解锁，质检中心页签上点亮提示；另有未处理的修改建议时也点亮提醒
  const reviewOpp = project ? reviewOpportunity(project) : null
  const pendingFix = !!project?.review?.current && !project.review.current.dismissed && project.review.current.suggestions.length > 0

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* 项目侧边栏 */}
        <div className="space-y-4">
          <section className="rounded-2xl bg-[#fbf8ef] p-4 shadow-sm">
            <h3 className="text-sm font-bold"><Ic n="library" /> 我的长篇项目</h3>
            <p className="mt-2 text-xs leading-relaxed text-stone-400">
              每本书独立维护设定、章节摘要链、伏笔账本与时间线，让 AI 在有限上下文里保持剧情统一。
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && createProject()}
                placeholder="新书名…"
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
              />
              <button onClick={createProject} disabled={busy} title={busy ? '生成/归档进行中，完成后再换书或新建，避免草稿串书' : ''} className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs text-white hover:bg-stone-700 disabled:opacity-50">
                + 新建
              </button>
            </div>
            <ul className="mt-3 space-y-2">
              {loading && <li className="text-xs text-stone-400">加载中…</li>}
              {!loading && projects.length === 0 && <li className="rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">还没有项目，先新建一本书</li>}
              {projects.map((p) => (
                <li
                  key={p.id}
                  onClick={() => {
                    if (busy) return // 生成/归档进行中禁止换书：流式草稿会被防抖写进新书快照，导致两本书内容串扰；报告卡同理，等完成后再切即可恢复
                    setSelectedId(p.id)
                    setErr('')
                    setLastReport(null)
                  }}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-sm transition-colors ${busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${
                    selectedId === p.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 hover:bg-stone-50'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className={`text-xs ${selectedId === p.id ? 'text-stone-300' : 'text-stone-400'}`}>
                      {(p.chapters || []).length} 章 · {(p.chapters || []).reduce((s, c) => s + c.wordCount, 0)} 字
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      window.confirm(`确定删除《${p.name}》及其全部档案吗？`) && removeProject(p.id)
                    }}
                    className={`ml-2 shrink-0 rounded-full px-2 py-1 text-xs ${selectedId === p.id ? 'text-stone-200 hover:bg-stone-700 hover:text-red-200' : 'text-stone-400 hover:bg-stone-100 hover:text-red-600'}`}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {project && (
            <section className="rounded-2xl bg-[#fbf8ef] p-4 text-xs text-stone-500 shadow-sm">
              <p className="font-bold text-stone-700"><Ic n="chart" /> 总览</p>
              <ul className="mt-2 space-y-1.5">
                <li>全书 {totalWords} 字 · {(project.chapters || []).length} 章</li>
                <li>滚动摘要：{project.rollingSummary ? <><Ic n="ok" /> 已维护</> : '—'}</li>
                <li>时间线事件：{project.events.length} 条</li>
                <li>
                  未回收伏笔：{activeHooks.length} 条
                  {hooksReady > 0 && <span className="ml-1 text-amber-600">（{hooksReady} 条已到回收窗口）</span>}
                </li>
                <li>资产就绪度：{assetReady}/6（梗概·世界观·人物·细纲·文风·卷档案）</li>
              </ul>
              {/* 下一章建议：定位标签 + 细纲覆盖 + 卷归属，开写前一眼看清坐标 */}
              <div className="mt-3 border-t border-stone-200/70 pt-2.5">
                <p className="font-medium text-stone-600">
                  下一章：第 {nextNo} 章{nextPos && <span className="ml-1.5 rounded bg-stone-200 px-1.5 py-0.5 font-semibold text-stone-700">{nextPos}</span>}
                </p>
                <p className="mt-1 leading-relaxed">
                  细纲{outlineMax === 0 ? '未建档' : outlineMax < nextNo ? '已耗尽，建议先续写细纲' : `规划到第 ${outlineMax} 章`}；{nextVol ? `属第${nextVol.volumeNo}卷《${nextVol.name}》` : needNewVolume(project, nextNo) ? `将开新卷（第${(project.volumes || []).length + 1}卷）` : '未启用卷档案'}
                </p>
              </div>
            </section>
          )}
        </div>

        {/* 主区域 */}
        <div className="min-w-0 space-y-4">
          {!project ? (
            <section className="rounded-2xl bg-[#fbf8ef] p-10 text-center shadow-sm">
              <p className="text-4xl text-stone-300"><Ic n="mountain" /></p>
              <p className="mt-3 text-sm font-medium text-stone-600">新建或选择一本书，开始长篇写作</p>
              <p className="mt-2 text-xs text-stone-400">
                每章保存时自动更新：章节摘要链、全书滚动摘要、人物状态、伏笔账本、时间线，并做一致性校验。
              </p>
            </section>
          ) : (
            <>
              <nav className="flex gap-2 overflow-x-auto rounded-2xl bg-[#fbf8ef] p-3 shadow-sm">
                {SUBTABS.map((t) => (
                  <button key={t.id} onClick={() => setSubtab(t.id)} className={`relative shrink-0 ${chip(subtab === t.id)}`}>
                    <Ic n={t.icon} /> {t.label}
                    {t.id === 'dashboard' && (reviewOpp?.available || pendingFix) && (
                      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500" />
                    )}
                  </button>
                ))}
                <span className="ml-auto hidden items-center pr-2 text-xs text-stone-400 sm:flex">《{project.name}》</span>
              </nav>

              {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}

              {/* 归档检查点：上次保存章节途中被刷新/中断，从断点续跑（只补未完成的步骤，不重跑全部请求） */}
              {archiveCp && !busy && (
                <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm text-amber-800">
                    <Ic n="timer" /> 第 {archiveCp.chapterNo} 章的档案更新上次被中断（已完成 {Object.keys(archiveCp.lanes || {}).length} 步），可从断点继续，不必重跑全部。
                  </p>
                  <div className="flex gap-2">
                    <button onClick={resumeArchive} className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700">
                      继续归档
                    </button>
                    <button
                      onClick={() => {
                        clearArchiveCheckpoint(project.id)
                        setArchiveCp(null)
                      }}
                      className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
                    >
                      放弃（初稿仍在下方编辑框）
                    </button>
                  </div>
                </section>
              )}

              {/* ============ 章节写作 ============ */}
              {subtab === 'chapters' && (
                <div className="space-y-4">
                  {/* 细纲续航提醒：剩余不足 3 章或已耗尽时引导续写，避免 AI 失去剧情地图 */}
                  {outlineLow && (
                    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-sm text-amber-800">
                        <Ic n="map" /> 细纲{outlineMax < nextNo ? '已耗尽' : `只剩 ${outlineMax - nextNo + 1} 章`}（规划到第 {outlineMax} 章，当前要写第 {nextNo} 章），建议续写下一阶段细纲。
                      </p>
                      <button
                        onClick={extendOutline}
                        disabled={busy || !apiKey}
                        className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                      >
                        {extending ? 'AI 规划中…' : <><Ic n="sparkle" /> 续写细纲（紧接规划后 15 章）</>}
                      </button>
                    </section>
                  )}
                  {/* 无章节时：导入已有文本开局 */}
                  {project.chapters.length === 0 && (
                    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                      <h2 className="text-base font-bold"><Ic n="import" /> 用已有正文开局（可选）</h2>
                      <p className="mt-1 text-xs leading-relaxed text-stone-400">
                        粘贴或导入已经写好的正文：AI 会自动分析世界观、人物、故事线，生成初始滚动摘要，并从结尾处继续写新章节。全新开书可跳过此步，先去「设定与人物」生成梗概与细纲。
                      </p>
                      <div className="mt-3 flex justify-end">
                        <button onClick={() => seedFileRef.current?.click()} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50">
                          导入 .txt / .md
                        </button>
                        <input
                          ref={seedFileRef}
                          type="file"
                          accept=".txt,.md"
                          className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (f) setSeedText(await f.text())
                          }}
                        />
                      </div>
                      <textarea
                        value={seedText}
                        onChange={(e) => setSeedText(e.target.value)}
                        placeholder="粘贴已有正文…"
                        rows={6}
                        className="novel-text mt-2 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <button
                        onClick={seedFromText}
                        disabled={busy || countWords(seedText) < 200}
                        className="mt-2 min-h-[40px] rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                      >
                        {seeding || '分析并导入为起始章节'}
                      </button>
                    </section>
                  )}

                  {/* 滚动摘要展示 */}
                  {project.rollingSummary && (
                    <details className="rounded-2xl bg-[#fbf8ef] p-4 shadow-sm">
                      <summary className="cursor-pointer text-xs font-semibold text-stone-500"><Ic n="rolling" /> 全书滚动摘要（每次保存章节后自动更新，写新章时自动注入）</summary>
                      <p className="novel-text mt-2 text-sm leading-relaxed text-stone-600 whitespace-pre-wrap">{project.rollingSummary}</p>
                    </details>
                  )}

                  {/* 写作器 */}
                  <section ref={composerRef} className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-base font-bold"><Ic n="pen" /> 撰写第 {nextNo} 章</h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
                          流程：生成场景清单（可编辑）→ 扩写初稿 → 自由修改 → 保存并更新档案（也可跳过清单直接生成）
                        </span>
                        <button
                          onClick={() => setDiscOpen(!discOpen)}
                          title="绑定本书世界观/梗概/人物/伏笔的自由对话：推演剧情走向，AI 只给选项不替你拍板"
                          className={`rounded-full px-4 py-1 text-xs font-medium ${discOpen ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-600 hover:bg-stone-100'}`}
                        >
                          <Ic n="chat" /> {discOpen ? '关闭剧情讨论' : '剧情讨论'}
                        </button>
                      </div>
                    </div>
                    {/* 显式质量策略：连续推进（默认，快）与质量优先（失败重试一次、发现问题先提醒处理），按书持久化 */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                      <span className="font-semibold">质量策略</span>
                      <div className="flex items-center rounded-full border border-stone-200 p-0.5">
                        <button
                          onClick={() => updateProject({ qualityPolicy: 'fast' })}
                          disabled={busy}
                          title="归档某步失败直接跳过（可补跑），不打断写作节奏"
                          className={`rounded-full px-3 py-1 transition-colors ${project.qualityPolicy !== 'strict' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
                        >
                          连续推进
                        </button>
                        <button
                          onClick={() => updateProject({ qualityPolicy: 'strict' })}
                          disabled={busy}
                          title="归档某步失败自动重试一次；校验发现问题时醒目提醒，建议处理后再写下一章"
                          className={`rounded-full px-3 py-1 transition-colors ${project.qualityPolicy === 'strict' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
                        >
                          质量优先
                        </button>
                      </div>
                      <span className="text-stone-400">{project.qualityPolicy === 'strict' ? '失败自动重试一次，先修再写' : '降级不阻塞，事后可补跑'}</span>
                    </div>
                    {/* 整本自动连写：每章照走完整链路；遇待确认提案/细纲将尽/报错会暂停等人处理，已写的章都已落库 */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-500">
                      <span className="font-semibold text-stone-600"><Ic n="rocket" /> 自动连写</span>
                      {autoStatus ? (
                        <>
                          <span className="flex items-center gap-1 font-medium text-stone-700">
                            <Ic n="hourglass" /> {autoStatus}
                          </span>
                          <button
                            onClick={() => {
                              autoStopRef.current = true
                            }}
                            className="rounded-full border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            <Ic n="stop" /> 停止自动连写（当前章写完即停）
                          </button>
                        </>
                      ) : (
                        <>
                          <span>连续写</span>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={autoCount}
                            onChange={(e) => setAutoCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                            disabled={busy}
                            className="w-14 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                          />
                          <span>章（每章照走场景清单→初稿→档案流水线；遇剧情分支提案会暂停等你拍板）</span>
                          <button onClick={startAuto} disabled={busy || !apiKey} className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
                            <Ic n="rocket" /> 开始自动连写
                          </button>
                        </>
                      )}
                    </div>
                    {autoDoneMsg && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{autoDoneMsg}</p>}
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      placeholder={`章节标题（生成初稿后自动填写，可修改；保存时缺省为"第${nextNo}章"）`}
                      className="mt-3 w-full rounded-xl border border-stone-200 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none"
                    />
                    <textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="本章方向（可选）：例如 主角在拍卖会遭遇伏击，神秘人第二次出手…（也会作为检索关键词召回相关前文）"
                      rows={2}
                      className="novel-text mt-2 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                    />
                    {/* 两段式写作：先规划场景清单，确认后再扩写，防止 AI 进程过快跳过应展开的场景 */}
                    <div className="mt-3 rounded-xl border border-dashed border-stone-300 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold text-stone-500"><Ic n="scene" /> 场景清单（推荐）</p>
                        <span className="text-xs text-stone-400">先让 AI 规划本章 3~5 个场景，你确认后再逐场景扩写，不会跳过过程</span>
                        {scenePlan ? (
                          <>
                            <button onClick={planScenes} disabled={busy} className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                              {planningScene ? '规划中…' : '重新规划'}
                            </button>
                            <button onClick={() => setScenePlan('')} disabled={busy || streaming} className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50">
                              清除
                            </button>
                          </>
                        ) : (
                          <button onClick={planScenes} disabled={busy} className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-200 disabled:opacity-50">
                            {planningScene ? 'AI 规划中…' : '生成本章场景清单'}
                          </button>
                        )}
                      </div>
                      {scenePlan && (
                        <>
                          <textarea
                            value={scenePlan}
                            onChange={(e) => setScenePlan(e.target.value)}
                            disabled={streaming}
                            rows={4}
                            className="novel-text mt-2 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                          />
                          <p className="mt-1 text-xs text-stone-400">每行一个场景，可直接编辑、增删；扩写时将逐场景展开。</p>
                        </>
                      )}
                      {/* 本章参与者筛选：勾选的人物才把完整档案与编年史注入初稿上下文，其余一行带过并禁止出场；全部不勾则回退全量注入 */}
                      {project.characters.length > 0 && (
                        <div className="mt-3 rounded-xl bg-stone-50 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-semibold text-stone-500"><Ic n="user" /> 本章出场人物</p>
                            <span className="text-xs text-stone-400">{sceneChars.length ? `已勾选 ${sceneChars.length} 人，其余人物不进上下文` : '全部注入（生成场景清单后会自动勾选，可点按调整）'}</span>
                            {sceneChars.length > 0 && (
                              <button onClick={() => setSceneChars([])} disabled={streaming} className="rounded-full border border-stone-300 px-2.5 py-0.5 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-50">
                                清空勾选（=全部注入）
                              </button>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {project.characters.map((c, ci) => {
                              const on = sceneChars.includes(c.name)
                              return (
                                <button
                                  key={`${c.name || '未命名'}-${ci}`}
                                  onClick={() => setSceneChars(on ? sceneChars.filter((n) => n !== c.name) : [...sceneChars, c.name])}
                                  disabled={streaming}
                                  className={`rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-50 ${on ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-500 hover:bg-stone-100'}`}
                                >
                                  {c.name || '未命名'}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        onClick={generateDraft}
                        disabled={busy}
                        className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                      >
                        {streaming ? 'AI 撰写中…' : scenePlan ? '按场景清单扩写初稿' : '直接生成初稿'}
                      </button>
                      {draft && !streaming && (
                        <>
                          <button
                            onClick={saveChapter}
                            disabled={busy}
                            className="min-h-[44px] rounded-full border-2 border-stone-800 px-6 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
                          >
                            {savingMsg || <><Ic n="ok" /> 保存并更新档案（第 {nextNo} 章，{countWords(stripTitle(draft).text)} 字）</>}
                          </button>
                          <button onClick={() => setDraft('')} disabled={busy} className="text-xs text-stone-400 underline hover:text-stone-600">
                            丢弃初稿
                          </button>
                        </>
                      )}
                      {busy && (
                        <span className="flex items-center gap-2 text-sm text-stone-500">
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                          {savingMsg || seeding || '正在生成…'}
                        </span>
                      )}
                      {streaming && (
                        <button
                          onClick={() => abortRef.current?.abort()}
                          className="rounded-full border border-red-300 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          <Ic n="stop" /> 停止生成
                        </button>
                      )}
                    </div>
                    {draft && (
                      <textarea
                        ref={draftTaRef}
                        onSelect={onDraftSelect}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        disabled={streaming}
                        rows={14}
                        className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                      />
                    )}
                    {/* 段级选中改写：草稿里选中 ≥8 字即弹出工具条，选模式流式改写，预览确认后替换选中区 */}
                    {sel && (
                      <div className="mt-2 rounded-xl border border-stone-300 bg-stone-50 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-stone-600"><Ic n="pencil" /> 段级改写（已选中 {sel.text.length} 字）</span>
                          {SEGMENT_MODES.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => setSegMode(m.id)}
                              title={m.desc}
                              className={`rounded-full px-3 py-1 transition-colors ${segMode === m.id ? 'bg-stone-800 text-white' : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-100'}`}
                            >
                              {m.name}
                            </button>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            value={segReq}
                            onChange={(e) => setSegReq(e.target.value)}
                            placeholder="附加要求（可选）：例如 增加肢体冲突的细节、改成慢节奏…"
                            className="min-w-52 flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                          />
                          <button onClick={runSegmentRewrite} disabled={segBusy || !apiKey} className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
                            {segBusy ? '改写中…' : <><Ic n="sparkle" /> 按「{SEGMENT_MODES.find((m) => m.id === segMode)?.name}」改写</>}
                          </button>
                          {segBusy && (
                            <button onClick={() => segAbortRef.current?.abort()} className="rounded-full border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50">
                              <Ic n="stop" /> 停止
                            </button>
                          )}
                          <button onClick={() => { setSel(null); setSegResult('') }} className="text-xs text-stone-400 underline hover:text-stone-600">取消</button>
                        </div>
                        {segResult && (
                          <>
                            <div className="novel-text mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs leading-relaxed text-stone-700">{segResult}</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button onClick={applySegResult} className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
                                <Ic n="ok" /> 采用并替换选中段
                              </button>
                              <button onClick={() => setSegResult('')} className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-500 hover:bg-stone-100">放弃这版</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {/* 章内搜索跳转：快速定位到草稿里某句话（回车或点击跳转，到末尾自动回绕） */}
                    {draft && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          value={findStr}
                          onChange={(e) => setFindStr(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && jumpFind()}
                          placeholder="章内搜索：输入要跳转定位的原文…"
                          className="min-w-52 flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                        />
                        <button onClick={jumpFind} disabled={!findStr} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50">
                          <Ic n="search" /> 跳转
                        </button>
                      </div>
                    )}
                    {/* 场景候选稿：重新生成时当前稿自动暂存（最多 3 版），也可手动存入；载入前当前稿先入候选，不丢稿 */}
                    {draft && (
                      <div className="mt-2 rounded-xl border border-dashed border-stone-300 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-stone-500"><Ic n="doc" /> 候选稿（{versions.length}/3）</span>
                          <button onClick={stashVersion} disabled={busy} className="rounded-full border border-stone-300 px-3 py-1 text-stone-600 hover:bg-stone-100 disabled:opacity-50">
                            存入当前稿
                          </button>
                          <span className="text-stone-400">重新生成初稿时当前稿自动暂存，可载入任一版本对比挑选</span>
                        </div>
                        {versions.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {versions.map((v, i) => (
                              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs text-stone-600">
                                <span className="font-medium">版本 {i + 1}</span>
                                <span className="text-stone-400">{countWords(v.text)} 字 · {new Date(v.at).toLocaleTimeString()}</span>
                                {v.title && <span className="max-w-40 truncate text-stone-400">《{v.title}》</span>}
                                <button
                                  onClick={() => { stashVersion(); setDraft(v.text); setDraftTitle(v.title || ''); setVersions((prev) => prev.filter((_, j) => j !== i)) }}
                                  className="ml-auto rounded-full border border-stone-300 px-2.5 py-0.5 text-stone-600 hover:bg-stone-100"
                                >
                                  载入（当前稿入候选）
                                </button>
                                <button onClick={() => setVersions((prev) => prev.filter((_, j) => j !== i))} className="text-stone-400 hover:text-red-500">
                                  <Ic n="x" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* AI 味输出层验证：草稿实时扫描命中展示（纯前端零费用，只报警不阻断；规则不再只靠模型自觉） */}
                    {flavorHits.length > 0 && (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
                        <p className="font-semibold">
                          <Ic n="alert" /> AI 味扫描：命中 {flavorHits.length} 类套路表达，建议改写后再保存（保存章节时可先用「章节重写」或手动修改）
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {flavorHits.map((h, i) => (
                            <span key={i} className="rounded-full border border-amber-200 bg-white px-2.5 py-0.5 text-amber-700">
                              {h.type === '结构' ? h.name : h.word}
                              {h.count > 1 ? ` ×${h.count}` : ''}
                            </span>
                          ))}
                        </div>
                        <p className="mt-1 text-amber-700">扫描范围：预设禁词表 + 绑定文风的自定义禁用词 + 结构模式（过渡句/时间速写/解说式心理）。</p>
                      </div>
                    )}
                    {/* 章末钩子检查：结尾平铺直叙时提醒（不强制），鼓励落在悬念/反转/未解问题上 */}
                    {hookResult && !hookResult.ok && (
                      <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">
                        <p><Ic n="hook" /> <span className="font-semibold">章末钩子提醒：</span>{hookResult.reason}</p>
                      </div>
                    )}
                    {/* 专名一致性扫描：与已登记人名只差一个字的疑似错字（出现 ≥2 次才报，纯前端零费用） */}
                    {nounHits.length > 0 && (
                      <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs leading-relaxed text-orange-800">
                        <p className="font-semibold"><Ic n="alert" /> 专名疑似错字：以下写法与已登记人名只差一个字</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {nounHits.map((h, i) => (
                            <span key={i} className="rounded-full border border-orange-200 bg-white px-2.5 py-0.5 text-orange-700">
                              「{h.candidate}」疑为「{h.likely}」×{h.count}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* 待确认提案决策卡：自动连写遇到剧情分支暂停于此；手动生成场景清单时也可能产出 */}
                  {pendingDecision && (
                    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
                      <h3 className="text-sm font-bold text-amber-800">
                        <Ic n="alert" /> 第 {pendingDecision.chapterNo} 章遇到待确认的剧情分支
                      </h3>
                      <div className="mt-2 space-y-3">
                        {pendingDecision.proposals.map((p, i) => (
                          <div key={i}>
                            <p className="text-sm text-stone-700">{p.question}</p>
                            <div className="mt-1.5 flex flex-wrap gap-2">
                              {p.options.map((o, oi) => (
                                <button key={oi} onClick={() => decideProposal(o)} disabled={!!autoStatus} className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-50">
                                  {o}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <input
                          value={decisionInput}
                          onChange={(e) => setDecisionInput(e.target.value)}
                          placeholder="或输入你自己的方向…"
                          className="min-w-52 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                        />
                        <button
                          onClick={() => decisionInput.trim() && decideProposal(decisionInput.trim())}
                          disabled={!decisionInput.trim() || !!autoStatus}
                          className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                        >
                          拍板{pendingDecision.remaining ? '并继续自动连写' : '并写入写作方向'}
                        </button>
                        <button
                          onClick={() => {
                            setPendingDecision(null)
                            setDecisionInput('')
                          }}
                          className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-500 hover:bg-stone-100"
                        >
                          忽略（AI 自行决定）
                        </button>
                      </div>
                    </section>
                  )}

                  {/* 上次保存的档案更新报告 */}
                  {lastReport && (
                    <section className="rounded-2xl border border-stone-200 bg-[#fbf8ef] p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-bold"><Ic n="box" /> 档案已更新（下一章的上下文将自动包含本章摘要、人物状态与伏笔）</h3>
                        <button
                          onClick={() => {
                            composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            generateDraft()
                          }}
                          disabled={busy}
                          className="rounded-full bg-stone-800 px-5 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                        >
                          <Ic n="pen" /> 直接开始写第 {nextNo} 章（如需指定方向，先在上方填写「本章方向」再手动点生成初稿）
                        </button>
                      </div>
                      <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
                        <div className="rounded-xl bg-stone-50 p-3">
                          <p className="font-semibold text-stone-500">本章摘要</p>
                          <p className="mt-1 leading-relaxed text-stone-600">{lastReport.summary || '（未生成）'}</p>
                        </div>
                        <div className="rounded-xl bg-stone-50 p-3">
                          <p className="font-semibold text-stone-500">状态与时间线</p>
                          <p className="mt-1 leading-relaxed text-stone-600">
                            {lastReport.updates.length > 0 && `状态回写 ${lastReport.updates.length} 人；`}
                            {lastReport.newCharacters.length > 0 && `新人物入档 ${lastReport.newCharacters.length} 人；`}
                            时间线新增 {lastReport.events.length} 条事件
                          </p>
                        </div>
                        <div className="rounded-xl bg-stone-50 p-3">
                          <p className="font-semibold text-stone-500">伏笔账本</p>
                          <p className="mt-1 leading-relaxed text-stone-600">
                            新登记 {lastReport.newForeshadows.length} 条，回收 {lastReport.resolved.length} 条，推进 {lastReport.mentioned.length} 条
                          </p>
                        </div>
                        {lastReport.blocked?.length > 0 && (
                          <div className="rounded-xl bg-amber-50 p-3 sm:col-span-2">
                            <p className="font-semibold text-amber-700"><Ic n="shield" /> 抢收拦截（{lastReport.blocked.length}）</p>
                            <ul className="mt-1 list-disc space-y-1 pl-4 leading-relaxed text-amber-800">
                              {lastReport.blocked.map((f) => (
                                <li key={f.id}>
                                  「{f.content.slice(0, 40)}」仍在保护期内（第 {f.minResolveChapter} 章前禁止回收），本次未标记回收，建议后续章节继续铺垫。
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {lastReport.degraded?.length > 0 && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 p-3 sm:col-span-2">
                            <p className="text-amber-800"><Ic n="alert" /> 归档降级：{lastReport.degraded.join('、')} 本次失败被跳过，账本可能缺失，补跑可找回。</p>
                            <button
                              onClick={() => rerunChapter(lastReport.chapterNo)}
                              disabled={busy}
                              className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                            >
                              {!!rerunning ? rerunning : `补跑第 ${lastReport.chapterNo} 章归档`}
                            </button>
                          </div>
                        )}
                        {reviewOpp?.available && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 p-3 sm:col-span-2">
                            <p className="text-amber-800"><Ic n="search" /> 已解锁一次章节审核机会（GLM 审核最近 5 章连贯性），不处理也不影响继续写作。</p>
                            <button onClick={() => setSubtab('dashboard')} className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700">
                              去审核 →
                            </button>
                          </div>
                        )}
                        {lastReport.volumeMemory && (
                          <div className="rounded-xl bg-sky-50 p-3 sm:col-span-2">
                            <p className="font-semibold text-sky-700"><Ic n="scroll" /> 卷志已归档（长时记忆）</p>
                            <p className="mt-1 leading-relaxed text-sky-800">前 {lastReport.volumeUpTo} 章已压缩为不可变卷志，写后续章节时自动注入，防止早期剧情被遗忘。</p>
                          </div>
                        )}
                        {lastReport.povStreak >= 3 && (
                          <div className="rounded-xl bg-amber-50 p-3 sm:col-span-2">
                            <p className="font-semibold text-amber-700"><Ic n="film" /> 视角提醒</p>
                            <p className="mt-1 leading-relaxed text-amber-800">
                              本章视角：{lastReport.pov || '未识别'}。非主角视角已连续 {lastReport.povStreak} 章（上限 3~5 章），
                              {lastReport.povStreak >= 5 ? '下一章将强制回到主角视角。' : '建议尽快回到主角线，避免读者疏离。'}
                            </p>
                          </div>
                        )}
                        <div className={`rounded-xl p-3 ${lastReport.issues.length || lastReport.drift ? 'bg-red-50' : 'bg-emerald-50'}`}>
                          <p className={`font-semibold ${lastReport.issues.length || lastReport.drift ? 'text-red-600' : 'text-emerald-700'}`}>一致性校验</p>
                          {lastReport.issues.length === 0 && !lastReport.drift ? (
                            <p className="mt-1 leading-relaxed text-emerald-700">未发现问题，与设定、人物状态和大纲一致。</p>
                          ) : (
                            <>
                              <ul className="mt-1 list-disc space-y-1 pl-4 leading-relaxed text-red-600">
                                {lastReport.issues.map((it, i) => (
                                  <li key={i}>
                                    【{it.type}】{it.description}
                                  </li>
                                ))}
                                {lastReport.drift && <li>【大纲偏离】{lastReport.drift}</li>}
                              </ul>
                              {project.qualityPolicy === 'strict' && (
                                <p className="mt-1.5 text-xs text-red-500">质量优先模式：建议先在下方章节列表里对存疑章节一键重写，再写下一章。</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </section>
                  )}

                  {/* 章节列表（摘要链） */}
                  {project.chapters.length > 0 && (
                    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-bold"><Ic n="library" /> 已写章节（{project.chapters.length}）</h3>
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => setShowStats(!showStats)} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50">
                            <Ic n="chart" /> 写作统计
                          </button>
                          <button onClick={() => setExportOpen(!exportOpen)} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50">
                            <Ic n="save" /> 导出全书
                          </button>
                        </div>
                      </div>
                      {/* 写作统计：总字数/章均/近 7 天产量，纯前端计算零请求 */}
                      {showStats && stats && (
                        <div className="mt-3 rounded-xl border border-stone-200 bg-white p-4">
                          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                            <div><p className="text-lg font-bold text-stone-800">{stats.total}</p><p className="text-xs text-stone-400">总字数</p></div>
                            <div><p className="text-lg font-bold text-stone-800">{project.chapters.length}</p><p className="text-xs text-stone-400">章节数</p></div>
                            <div><p className="text-lg font-bold text-stone-800">{stats.avg}</p><p className="text-xs text-stone-400">章均字数</p></div>
                            <div><p className="text-lg font-bold text-stone-800">{stats.recent.reduce((acc, r) => acc + r[1], 0)}</p><p className="text-xs text-stone-400">近 7 个写作日字数</p></div>
                          </div>
                          {stats.recent.length > 0 && (
                            <div className="mt-3 space-y-1">
                              {stats.recent.map(([d, w]) => (
                                <div key={d} className="flex items-center gap-2 text-xs text-stone-500">
                                  <span className="w-20 shrink-0">{d}</span>
                                  <div className="h-2 rounded-full bg-stone-800" style={{ width: `${Math.max(2, (w / Math.max(...stats.recent.map((r) => r[1]))) * 60)}%` }}></div>
                                  <span>{w} 字</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {/* 导出选项：TXT / Markdown 双格式 + 卷分隔开关（卷头按卷档案 startChapter 插入） */}
                      {exportOpen && (
                        <div className="mt-3 rounded-xl border border-stone-200 bg-white p-4">
                          <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
                            <label className="flex items-center gap-1.5">
                              格式
                              <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} className="rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none">
                                <option value="txt">TXT</option>
                                <option value="md">Markdown</option>
                              </select>
                            </label>
                            <label className="flex items-center gap-1.5">
                              <input type="checkbox" checked={exportVols} onChange={(e) => setExportVols(e.target.checked)} />
                              按卷插入卷头分隔
                            </label>
                            <button
                              onClick={() => { exportBook(); setExportOpen(false) }}
                              className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
                            >
                              <Ic n="save" /> 导出（.{exportFormat}）
                            </button>
                          </div>
                        </div>
                      )}
                      <ul className="mt-3 space-y-2">
                        {[...project.chapters].reverse().map((c) => (
                          <li key={c.id} className="rounded-xl border border-stone-200 p-3">
                            <button onClick={() => setExpandedId(expandedId === c.id ? null : c.id)} className="flex w-full items-center justify-between text-left">
                              <span className="text-sm font-medium">
                                第{c.chapterNo}章 {c.title?.replace(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[\s:：]*/, '') || ''}
                              </span>
                              <span className="flex items-center gap-2 text-xs text-stone-400">
                                {c.wordCount} 字
                                {c.pov && <span>POV {c.pov}</span>}
                                {c.issueCount > 0 && <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-600">{c.issueCount} 处存疑</span>}
                                {expandedId === c.id ? '收起' : '展开'}
                              </span>
                            </button>
                            {expandedId === c.id && (
                              <div className="mt-2 min-w-0 space-y-2 border-t border-stone-100 pt-2">
                                {c.summary && <p className="text-xs leading-relaxed text-stone-500"><Ic n="notepad" /> 摘要：{c.summary}</p>}
                                {c.issues?.length > 0 && (
                                  <div className="rounded-lg bg-red-50 p-3">
                                    <p className="text-xs font-semibold text-red-600"><Ic n="alert" /> 一致性问题（{c.issues.length}，持久保存）</p>
                                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-red-600">
                                      {c.issues.map((it, i) => (
                                        <li key={i}>
                                          【{it.type}】{it.description}
                                        </li>
                                      ))}
                                    </ul>
                                    <div className="mt-2">
                                      <ChapterRewriter
                                        project={project}
                                        saveProject={saveProject}
                                        apiKey={apiKey}
                                        chapterNo={c.chapterNo}
                                        fixPrompt={`请修正本章存在的以下一致性问题，其余内容尽量保持原样：${c.issues.map((it, i) => `${i + 1}.【${it.type}】${it.description}`).join('；')}`}
                                        label="一键重写修复问题"
                                        disabled={busy || !apiKey}
                                      />
                                    </div>
                                  </div>
                                )}
                                <div className="novel-text max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-600">{c.content}</div>
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    onClick={() => rerunChapter(c.chapterNo)}
                                    disabled={busy || !apiKey}
                                    className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-500 hover:bg-stone-50 disabled:opacity-50"
                                  >
                                    {!!rerunning ? rerunning : <><Ic n="rerun" /> 重新建档本章（手动修改正文后刷新摘要/伏笔/时间线）</>}
                                  </button>
                                  {c.prev && (
                                    <button
                                      onClick={() => restorePrev(c.chapterNo)}
                                      disabled={busy}
                                      className="rounded-full border border-amber-200 px-3 py-1 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                                    >
                                      <Ic n="undo" /> 恢复替换前的原稿（{c.prev.wordCount} 字）
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              )}

              {/* ============ 伏笔账本 ============ */}
              {subtab === 'foreshadow' && (
                <div className="space-y-4">
                  {/* 完稿对账：决定"这卷怎么收"之前的总账（超期伏笔 / 休眠支线 / 失联人物），纯前端计算零请求 */}
                  {settlement && settlement.current > 0 && (
                    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                      <h2 className="text-base font-bold"><Ic n="clipboard" /> 完稿对账（当前至第 {settlement.current} 章）</h2>
                      <p className="mt-1 text-xs leading-relaxed text-stone-400">
                        收卷前先对账：埋设超 20 章未回收的伏笔、超 10 章未推进的支线、超 15 章无经历沉淀的人物——收卷章该优先处理谁，一目了然。
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <div className={`rounded-xl border p-3 ${settlement.overdueHooks.length ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-white'}`}>
                          <p className="text-xs font-semibold text-stone-600"><Ic n="hook" /> 超期伏笔（{settlement.overdueHooks.length}）</p>
                          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-stone-600">
                            {settlement.overdueHooks.slice(0, 5).map((f, i) => (
                              <li key={i}>· 埋于第 {f.plantedChapter} 章：{f.content}</li>
                            ))}
                            {!settlement.overdueHooks.length && <li className="text-stone-400">无，健康</li>}
                          </ul>
                        </div>
                        <div className={`rounded-xl border p-3 ${settlement.staleStorylines.length ? 'border-amber-200 bg-amber-50' : 'border-stone-200 bg-white'}`}>
                          <p className="text-xs font-semibold text-stone-600"><Ic n="thread" /> 休眠支线（{settlement.staleStorylines.length}）</p>
                          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-stone-600">
                            {settlement.staleStorylines.slice(0, 5).map((s, i) => (
                              <li key={i}>· {s.name}（最近推进：第 {s.lastChapter} 章）</li>
                            ))}
                            {!settlement.staleStorylines.length && <li className="text-stone-400">无，健康</li>}
                          </ul>
                        </div>
                        <div className={`rounded-xl border p-3 ${settlement.dormantChars.length ? 'border-amber-200 bg-amber-50' : 'border-stone-200 bg-white'}`}>
                          <p className="text-xs font-semibold text-stone-600"><Ic n="user" /> 失联人物（{settlement.dormantChars.length}）</p>
                          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-stone-600">
                            {settlement.dormantChars.slice(0, 5).map((c, i) => (
                              <li key={i}>· {c.name}（超 15 章无经历沉淀）</li>
                            ))}
                            {!settlement.dormantChars.length && <li className="text-stone-400">无，健康</li>}
                          </ul>
                        </div>
                      </div>
                    </section>
                  )}
                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h2 className="text-base font-bold"><Ic n="hook" /> 伏笔账本</h2>
                    <p className="mt-1 text-xs leading-relaxed text-stone-400">
                      每章保存时自动登记新伏笔、检测回收；新伏笔自带保护期（主线埋后 {PROTECT_GAP['主线']} 章、支线 {PROTECT_GAP['支线']} 章内禁止回收），写新章时保护期会注入提示词，AI 抢收会被拦截。埋设超过 {OVERDUE_CHAPTERS} 章未回收会提醒催更。
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input
                        value={newHook.content}
                        onChange={(e) => setNewHook({ ...newHook, content: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && addHook()}
                        placeholder="手动登记伏笔，例如：老道士留下的半块玉佩…"
                        className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <select
                        value={newHook.importance}
                        onChange={(e) => setNewHook({ ...newHook, importance: e.target.value })}
                        className="rounded-lg border border-stone-200 px-2 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      >
                        <option>主线</option>
                        <option>支线</option>
                      </select>
                      <button onClick={addHook} disabled={!newHook.content.trim()} className="rounded-lg bg-stone-800 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50">
                        + 登记
                      </button>
                      {activeHooks.length > 0 && (
                        <button
                          onClick={planPace}
                          disabled={busy}
                          className="rounded-lg border-2 border-stone-800 px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
                        >
                          {planning ? 'AI 规划中…' : <><Ic n="target" /> 规划伏笔节奏（AI 排发酵期，防抢收）</>}
                        </button>
                      )}
                    </div>
                  </section>

                  {['未回收', '已提及', '已回收', '已废弃'].map((status) => {
                    const list = project.foreshadows.filter((f) => f.status === status)
                    if (!list.length) return null
                    return (
                      <section key={status} className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                        <h3 className="text-sm font-bold">
                          {status}（{list.length}）
                        </h3>
                        <ul className="mt-3 space-y-2">
                          {list.map((f) => {
                            const overdue = (status === '未回收' || status === '已提及') && nextNo - (f.plantedChapter || 0) > OVERDUE_CHAPTERS
                            return (
                              <li key={f.id} className={`rounded-xl border p-3 ${overdue ? 'border-amber-300 bg-amber-50' : 'border-stone-200'}`}>
                                <p className="text-sm leading-relaxed text-stone-700">{f.content}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-400">
                                  <span className={`rounded-full px-2 py-0.5 ${f.importance === '主线' ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600'}`}>{f.importance}</span>
                                  {f.plantedChapter > 0 && <span>埋于第 {f.plantedChapter} 章</span>}
                                  {(status === '未回收' || status === '已提及') && f.minResolveChapter > nextNo && (
                                    <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-700"><Ic n="shield" /> 保护期：第 {f.minResolveChapter} 章前只铺垫不回收</span>
                                  )}
                                  {f.planAdvice && <span className="text-sky-700">规划：{f.planAdvice}</span>}
                                  {f.resolveChapter > 0 && <span>回收于第 {f.resolveChapter} 章</span>}
                                  {f.relatedChars?.length > 0 && <span>相关：{f.relatedChars.join('、')}</span>}
                                  {overdue && <span className="font-medium text-amber-700"><Ic n="alert" /> 已埋 {nextNo - f.plantedChapter} 章，建议尽快安排回收</span>}
                                  <span className="ml-auto flex gap-2">
                                    {(status === '未回收' || status === '已提及') && (
                                      <>
                                        <button onClick={() => setHookStatus(f.id, '已回收')} className="text-emerald-600 underline hover:text-emerald-700">
                                          标记回收
                                        </button>
                                        <button onClick={() => setHookStatus(f.id, '已废弃')} className="text-stone-400 underline hover:text-stone-600">
                                          废弃
                                        </button>
                                      </>
                                    )}
                                    {status === '已回收' && (
                                      <button onClick={() => setHookStatus(f.id, '未回收')} className="text-stone-400 underline hover:text-stone-600">
                                        改回未回收
                                      </button>
                                    )}
                                  </span>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </section>
                    )
                  })}
                  {project.foreshadows.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-xs text-stone-400">账本还是空的：保存章节时 AI 会自动登记，也可以手动添加。</p>
                  )}
                </div>
              )}

              {/* ============ 设定与人物 ============ */}
              {subtab === 'settings' && form && (
                <div className="space-y-4">
                  <section className="space-y-4 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h2 className="text-base font-bold"><Ic n="gear" /> 全书设定（活档案）</h2>
                      <button onClick={saveSettings} disabled={genBusy !== ''} className={`rounded-full px-5 py-2 text-xs font-medium text-white disabled:opacity-50 ${settingsSaved ? 'bg-emerald-600' : 'bg-stone-800 hover:bg-stone-700'}`}>
                        <Ic n={settingsSaved ? 'ok' : 'save'} /> {settingsSaved ? '已保存' : '保存设定'}
                      </button>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="bulb" /> 一句话创意</p>
                      <textarea value={form.idea} onChange={(e) => setForm({ ...form, idea: e.target.value })} rows={2} placeholder="例如：一个外卖员意外捡到能预知死亡的手机…" className="w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none" />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {GENRES.map((g) => (
                          <button key={g} onClick={() => setForm({ ...form, genre: g })} className={chip(form.genre === g)}>
                            {g}
                          </button>
                        ))}
                        <span className="mx-1 text-stone-300">|</span>
                        {TONES.map((t) => (
                          <button key={t} onClick={() => setForm({ ...form, tone: t })} className={chip(form.tone === t)}>
                            {t}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => genField(synopsisMessages({ idea: form.idea, genre: form.genre, tone: form.tone }), 'synopsis', 0.9)}
                        disabled={genBusy !== '' || form.idea.trim().length < 5}
                        className="mt-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        {genBusy === 'synopsis' ? 'AI 扩写中…' : form.synopsis ? '重新生成梗概' : '生成故事梗概'}
                      </button>
                    </div>

                    {/* 开书导演模式：一句话灵感 → 3 个方向候选（拍板）→ 链式生成全套开书资产，逐段可改 */}
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="scene" /> 开书导演（一句话灵感一键生成全套开书资产，逐段可改）</p>
                      <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={directorAngles}
                            disabled={dirRunning || form.idea.trim().length < 5}
                            className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                          >
                            {dirRunning && !dirAngles.length ? 'AI 策划中…' : <><Ic n="sparkle" /> {dirAngles.length ? '换一批方向' : '生成 3 个开书方向'}</>}
                          </button>
                          {dirMsg && <span className="text-xs text-stone-500">{dirMsg}</span>}
                        </div>
                        {dirAngles.length > 0 && (
                          <div className="grid gap-2 sm:grid-cols-3">
                            {dirAngles.map((a, i) => (
                              <button
                                key={i}
                                onClick={() => runDirector(a)}
                                disabled={dirRunning}
                                className="rounded-xl border border-stone-200 bg-white p-3 text-left transition-colors hover:border-stone-400 disabled:opacity-50"
                              >
                                <p className="text-sm font-bold text-stone-800">《{a.title}》</p>
                                <p className="mt-0.5 text-xs text-stone-400">{a.genre} · {a.tone}</p>
                                <p className="mt-1.5 text-xs leading-relaxed text-stone-600">{a.pitch}</p>
                                <p className="mt-2 text-xs font-medium text-stone-500">选这个方向开书 →</p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="doc" /> 故事梗概</p>
                      <textarea value={form.synopsis} onChange={(e) => setForm({ ...form, synopsis: e.target.value })} rows={5} className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none" />
                    </div>

                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="globe" /> 世界观设定</p>
                      <button
                        onClick={() => genField(worldMessages({ synopsis: form.synopsis }), 'world', 0.8)}
                        disabled={genBusy !== '' || !form.synopsis}
                        className="mb-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        {genBusy === 'world' ? 'AI 构建中…' : form.world ? '重新生成世界观' : '生成世界观'}
                      </button>
                      <textarea value={form.world} onChange={(e) => setForm({ ...form, world: e.target.value })} rows={6} className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none" />
                    </div>

                    {/* 世界手册结构化块：按块维护，写作时按本章地点选择性注入；「规则」类块永不省略 */}
                    <div>
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-stone-500"><Ic n="map" /> 世界手册（结构化块：按本章地点选择性注入，「规则」块永不省略）</p>
                        <div className="flex gap-2">
                          {form.world && (
                            <button
                              onClick={splitWorld}
                              disabled={splittingWorld || genBusy !== ''}
                              className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                            >
                              {splittingWorld ? 'AI 拆分中…' : 'AI 拆世界观为块（覆盖现有块）'}
                            </button>
                          )}
                          <button onClick={addWorldBlock} className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50">
                            + 新增块
                          </button>
                        </div>
                      </div>
                      {form.worldBlocks.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-stone-200 p-3 text-xs text-stone-400">
                          暂无块。可让 AI 把上方世界观自动拆成块，或手动新增；不设块时写作按全量世界观文本注入（旧行为）。
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {form.worldBlocks.map((b) => (
                            <div key={b.id} className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                <input
                                  value={b.name}
                                  onChange={(e) => patchWorldBlock(b.id, { name: e.target.value })}
                                  placeholder="块名"
                                  className="w-32 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                />
                                <input
                                  value={b.aliases}
                                  onChange={(e) => patchWorldBlock(b.id, { aliases: e.target.value })}
                                  placeholder="别名（逗号分隔，可空）"
                                  className="w-40 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                />
                                <select
                                  value={b.kind}
                                  onChange={(e) => patchWorldBlock(b.id, { kind: e.target.value })}
                                  className="rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                >
                                  <option value="设定">设定</option>
                                  <option value="规则">规则（永不省略）</option>
                                </select>
                                <button
                                  onClick={() => setForm((f) => ({ ...f, worldBlocks: f.worldBlocks.filter((x) => x.id !== b.id) }))}
                                  className="ml-auto rounded-lg px-2 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-red-600"
                                >
                                  删除
                                </button>
                              </div>
                              <textarea
                                value={b.content}
                                onChange={(e) => patchWorldBlock(b.id, { content: e.target.value })}
                                rows={3}
                                className="novel-text w-full resize-y rounded-lg border border-stone-200 p-2 text-xs focus:border-stone-500 focus:outline-none"
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold text-stone-500"><Ic n="map" /> 全书细纲（章节写作的约束依据，用于大纲偏离检测）</p>
                        <span className="flex items-center gap-1 text-xs text-stone-400">
                          前
                          <input
                            type="number"
                            min={3}
                            max={50}
                            value={form.outlineCount}
                            onChange={(e) => setForm({ ...form, outlineCount: Math.max(3, Math.min(50, Number(e.target.value) || 10)) })}
                            className="w-14 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                          />
                          章
                        </span>
                      </div>
                      <button
                        onClick={() => genField(outlineMessages({ synopsis: form.synopsis, world: form.world, count: form.outlineCount, volumeContext: arcTextForRange({ volumes: form.volumes, volumeLength: form.volumeLength }, 1, form.outlineCount) }), 'outline', 0.7)}
                        disabled={genBusy !== '' || !form.world}
                        className="mb-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        {genBusy === 'outline' ? 'AI 编排中…' : form.outline ? '重新生成细纲' : '生成细纲'}
                      </button>
                      <textarea value={form.outline} onChange={(e) => setForm({ ...form, outline: e.target.value })} rows={8} className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none" />
                    </div>

                    {/* 写法引擎：文风绑定 + 反模板规则勾选 + 自定义规则 + 试写（初稿与重写均自动套用） */}
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="style" /> 写法引擎（文风绑定 + 反模板规则，初稿与章节重写均自动套用）</p>
                      <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-stone-600">文风档案</span>
                          <select
                            value={form.styleBookId}
                            onChange={(e) => setForm({ ...form, styleBookId: e.target.value })}
                            className="rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                          >
                            <option value="">不绑定（写作不注入文风）</option>
                            {libStyles.map((s) => (
                              <option key={s.bookId} value={s.bookId}>
                                {libBooks.find((b) => b.id === s.bookId)?.name || '未知书目'}
                              </option>
                            ))}
                          </select>
                          <span className="text-stone-400">在「改写润色」导入小说并分析文风后，可在此绑定给本书；随时可切换或解绑</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-stone-600">参考作品</span>
                          <select
                            value={form.refAnalysisId}
                            onChange={(e) => setForm({ ...form, refAnalysisId: e.target.value })}
                            className="rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                          >
                            <option value="">不借鉴（写作不注入参考）</option>
                            {analyses.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <span className="text-stone-400">来自「拆书工作台」的全局资产；只借鉴结构层叙事功能，防照搬；每本书独立绑定互不影响</span>
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-semibold text-stone-600">反模板感规则（点击开关，勾选的注入写作）</p>
                          <div className="flex flex-wrap gap-1.5">
                            {TEMPLATE_RULES.map((r) => (
                              <button
                                key={r.id}
                                title={r.text}
                                onClick={() => toggleRule(r.id)}
                                className={`rounded-full px-3 py-1 text-xs transition-colors ${ruleOn(r.id) ? 'bg-stone-800 text-white' : 'border border-stone-300 text-stone-400 hover:bg-stone-100'}`}
                              >
                                {r.name}
                              </button>
                            ))}
                            {(form.customRules || []).map((r) => (
                              <span key={r.id} title={r.text} className="flex items-center gap-1 rounded-full bg-stone-800 px-3 py-1 text-xs text-white">
                                {r.name}
                                <button onClick={() => setForm({ ...form, customRules: form.customRules.filter((x) => x.id !== r.id) })} className="text-stone-400 hover:text-red-300">
                                  <Ic n="x" />
                                </button>
                              </span>
                            ))}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <input
                              value={newRule.name}
                              onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                              placeholder="规则名（可空）"
                              className="w-28 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                            />
                            <input
                              value={newRule.text}
                              onChange={(e) => setNewRule({ ...newRule, text: e.target.value })}
                              placeholder="自定义规则内容，如：禁止用「心中一沉」表达震惊"
                              className="min-w-52 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                            />
                            <button onClick={addCustomRule} disabled={!newRule.text.trim()} className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-50">
                              添加规则
                            </button>
                          </div>
                        </div>
                        <div>
                          <button
                            onClick={runTrial}
                            disabled={trialing}
                            className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                          >
                            {trialing ? 'AI 试写中…' : <><Ic n="pen" /> 试写一段（约 300 字，验证当前写法效果）</>}
                          </button>
                          {trialText && <div className="novel-text mt-2 whitespace-pre-wrap rounded-xl border border-stone-200 bg-white p-3 text-xs leading-relaxed text-stone-700">{trialText}</div>}
                        </div>
                      </div>
                    </div>
                    {/* 卷结构：显式卷档案 + 卷战略，写作时注入本章所属卷的战略；自动连写超出末卷范围时自动断卷规划新卷 */}
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-stone-500"><Ic n="scroll" /> 卷结构（卷档案 + 卷战略，可选启用；不建档则写作不注入卷战略）</p>
                      <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
                        {(form.volumes || []).map((v) => (
                          <div key={v.id} className="rounded-xl border border-stone-200 bg-white p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="shrink-0 text-xs font-bold text-stone-700">第 {v.volumeNo} 卷</span>
                              <input
                                value={v.name}
                                onChange={(e) => patchVolume(v.id, { name: e.target.value })}
                                placeholder="卷名"
                                className="w-36 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                              />
                              <span className="text-xs text-stone-400">第 {v.startChapter} 章起</span>
                              <label className="flex items-center gap-1 text-xs text-stone-400">
                                计划
                                <input
                                  type="number"
                                  min={0}
                                  value={v.length}
                                  onChange={(e) => patchVolume(v.id, { length: Math.max(0, Number(e.target.value) || 0) })}
                                  className="w-16 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                />
                                章{v.length === 0 ? '（开放式，不断卷）' : ''}
                              </label>
                              <button
                                onClick={() => setForm((f) => ({ ...f, volumes: f.volumes.filter((x) => x.id !== v.id) }))}
                                className="ml-auto rounded-full px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                              >
                                <Ic n="x" />
                              </button>
                            </div>
                            <textarea
                              value={v.strategy}
                              onChange={(e) => patchVolume(v.id, { strategy: e.target.value })}
                              rows={3}
                              placeholder="卷战略：本卷目标 / 主线推进到哪 / 卷末钩子"
                              className="mt-2 w-full resize-y rounded-lg border border-stone-200 p-2 text-xs leading-relaxed focus:border-stone-500 focus:outline-none"
                            />
                            {/* 结构化弧线：起承转合结构（带章节范围）+ 情感走向，写作时随卷战略一并注入 */}
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className="text-xs text-stone-400">
                                起承转合结构（带章节范围）
                                <input
                                  value={v.arc || ''}
                                  onChange={(e) => patchVolume(v.id, { arc: e.target.value })}
                                  placeholder="铺垫(第1-5章)→发展(第6-12章)→高潮(第13-17章)→收束(第18-20章)"
                                  className="mt-1 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                                />
                              </label>
                              <label className="text-xs text-stone-400">
                                情感走向
                                <input
                                  value={v.emotion || ''}
                                  onChange={(e) => patchVolume(v.id, { emotion: e.target.value })}
                                  placeholder="压抑→憋屈→爆发→短暂喘息"
                                  className="mt-1 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                                />
                              </label>
                            </div>
                          </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-1 text-xs text-stone-400">
                            每卷计划
                            <input
                              type="number"
                              min={1}
                              value={form.volumeLength ?? 20}
                              onChange={(e) => setForm({ ...form, volumeLength: Math.max(1, Number(e.target.value) || 20) })}
                              className="w-16 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                            />
                            章（新建卷与自动断卷都用此值）
                          </label>
                          <button onClick={planNextVol} disabled={planningVol} className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
                            {planningVol ? 'AI 规划新卷中…' : <><Ic n="sparkle" /> AI 规划下一卷（卷名 + 卷战略）</>}
                          </button>
                          <span className="text-xs text-stone-400">卷战略在写本章时注入；自动连写超出末卷范围会自动断卷规划新卷；改完点「保存设定」生效</span>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* 人物活档案 */}
                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h3 className="text-sm font-bold"><Ic n="user" /> 人物档案（{form.characters.length}）</h3>
                    <p className="mt-1 text-xs text-stone-400">「当前状态」由每章保存时自动回写（位置 / 伤势 / 关系等），写新章时注入提示词。</p>
                    {/* 防照搬算法兜底：人物特点与参考作品功能位的文本相似度（纯前端，零费用）；只报可疑项不阻断 */}
                    {project.refAnalysisId && (
                      <button
                        onClick={() => setSimReport(refSimilarityReport({ characters: form.characters, analysis: analyses.find((a) => a.id === project.refAnalysisId) }))}
                        className="mt-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                      >
                        <Ic n="shield" /> 检测与参考作品的人物相似度（防照搬）
                      </button>
                    )}
                    {simReport && (
                      simReport.length ? (
                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
                          <p className="font-semibold"><Ic n="alert" /> 发现 {simReport.length} 处与参考作品高相似的人物特点，建议重写避免照搬：</p>
                          <ul className="mt-1 list-disc pl-5">
                            {simReport.slice(0, 6).map((h, i) => (
                              <li key={i}>
                                「{h.name}」与参考作品功能位「{h.slot}」{h.soft ? '存在字词层重合（疑似，请人工确认）' : `相似度 ${h.score}%`}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-amber-700">保留叙事功能、更换具体设定（身份/性格/动机换一套），可重新检测直到无命中。</p>
                        </div>
                      ) : (
                        <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
                          <Ic n="ok" /> 已检测：当前人物与参考作品功能位无高相似特点。
                        </div>
                      )
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-stone-50 p-3">
                      <span className="text-xs font-semibold text-stone-500"><Ic n="target" /> 主角（视角约束依据）：</span>
                      <select
                        value={form.protagonist}
                        onChange={(e) => setForm({ ...form, protagonist: e.target.value })}
                        className="rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                      >
                        <option value="">未指定（不启用视角约束）</option>
                        {/* 选项 value 按姓名匹配，重名选项无意义，先去重再渲染（也避免 duplicate key 警告） */}
                        {[...new Set(form.characters.map((c) => c.name).filter(Boolean))].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-stone-400">以主角线为主；非主角视角连续 3 章提醒、5 章强制回归，且篇幅应更短</span>
                    </div>
                    {form.characters.length > 0 && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {form.characters.map((c, i) => (
                          <div key={i} className="relative rounded-xl border border-stone-200 bg-white p-3">
                            <button
                              onClick={() => setForm({ ...form, characters: form.characters.filter((_, j) => j !== i) })}
                              className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                            >
                              <Ic n="x" />
                            </button>
                            <input
                              value={c.name}
                              onChange={(e) => setForm({ ...form, characters: form.characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                              placeholder="姓名（必填，状态回写与出场筛选按此匹配）"
                              className="w-full rounded-lg border border-stone-100 bg-transparent px-2 py-1 text-sm font-bold focus:border-stone-400 focus:outline-none"
                            />
                            <input
                              value={(c.aliases || []).join('、')}
                              onChange={(e) =>
                                setForm({ ...form, characters: form.characters.map((x, j) => (j === i ? { ...x, aliases: e.target.value.split(/[、，,]/).map((s) => s.trim()).filter(Boolean) } : x)) })
                              }
                              placeholder="别名（可选，多个用顿号分隔，用于状态回写归一）"
                              className="mt-1 w-full rounded-lg border border-stone-100 px-2 py-1 text-xs focus:border-stone-400 focus:outline-none"
                            />
                            {c.identity && <p className="mt-0.5 text-xs text-stone-600">身份：{c.identity}</p>}
                            {c.personality && <p className="mt-0.5 text-xs text-stone-600">性格：{c.personality}</p>}
                            {c.description && <p className="mt-0.5 text-xs text-stone-500">{c.description}</p>}
                            <p className="mt-1 text-xs text-emerald-700">{c.status ? `当前状态：${c.status}` : '当前状态：暂无记录'}</p>
                            {(project.chronicles?.[c.name] || []).length > 0 && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700">
                                  <Ic n="scroll" /> 编年史（{project.chronicles[c.name].length} 条，每章自动沉淀，写新章时注入防矛盾）
                                </summary>
                                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                                  {project.chronicles[c.name].map((e, j) => (
                                    <li key={j} className="text-xs leading-relaxed text-stone-500">
                                      第{e.chapter}章：{e.text}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => setForm({ ...form, characters: [...form.characters, { name: '', aliases: [], identity: '', personality: '', description: '', status: '' }] })}
                      className="mt-3 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                    >
                      + 添加人物
                    </button>
                  </section>
                </div>
              )}

              {/* ============ 时间线 ============ */}
              {subtab === 'timeline' && (
                <div className="space-y-4">
                  {/* 故事线面板：主线/支线进展随每章自动回写，写新章时注入提示词 */}
                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h2 className="text-base font-bold"><Ic n="thread" /> 故事线面板（{(project.storylines || []).length}）</h2>
                    <p className="mt-1 text-xs text-stone-400">每章保存时自动检测本章推进了哪些故事线、是否新开支线；写新章时注入提示词，约束 AI 只推进不擅自完结。</p>
                    {(project.storylines || []).length === 0 ? (
                      <p className="mt-3 rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">暂无故事线，保存第一个章节后自动梳理。</p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {(project.storylines || []).map((s) => (
                          <li key={s.name} className="rounded-xl border border-stone-200 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-stone-700">{s.name}</span>
                              <span className={`rounded-full px-2 py-0.5 text-xs ${s.type === '主线' ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600'}`}>{s.type}</span>
                              {s.lastChapter > 0 && <span className="text-xs text-stone-400">最近推进：第 {s.lastChapter} 章</span>}
                            </div>
                            {s.progress && <p className="mt-1 text-xs leading-relaxed text-stone-600">{s.progress}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                  <h2 className="text-base font-bold"><Ic n="hourglass" /> 事件级时间线</h2>
                  <p className="mt-1 text-xs text-stone-400">每章保存时自动追加本章关键事件；导入既有正文时由故事线梳理生成。</p>
                  {project.events.length === 0 ? (
                    <p className="mt-4 rounded-xl border border-dashed border-stone-300 p-6 text-center text-xs text-stone-400">暂无事件，保存第一个章节后自动生成。</p>
                  ) : (
                    <div className="relative mt-4 pl-6">
                      <div className="absolute bottom-1 left-[7px] top-1 w-0.5 bg-stone-300"></div>
                      {project.events.map((ev, i) => (
                        <div key={i} className="relative mb-4 last:mb-0">
                          <div className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-500 shadow"></div>
                          <p className="text-xs font-semibold text-stone-400">
                            {ev.chapter > 0 ? `第 ${ev.chapter} 章` : '前情'}
                            {ev.time ? <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 font-normal text-stone-500">{ev.time}</span> : null}
                          </p>
                          <p className="mt-0.5 text-sm leading-relaxed text-stone-700">{ev.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  </section>
                </div>
              )}
              {/* ============ 拆书工作台：拆出全局参考资产，书级可切换绑定，去专名防照搬 ============ */}
              {subtab === 'analysis' && (
                <div className="space-y-4">
                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h3 className="text-sm font-bold"><Ic n="search" /> 拆书工作台</h3>
                    <p className="mt-1 text-xs leading-relaxed text-stone-400">
                      先在「改写润色」导入参考小说进书库，AI 会把它拆成功能位、关系模式、爽点推进模式等叙事功能资产。拆解产物不含原作任何专名（分析阶段强制去除），写作时只注入结构层功能——看不到的东西抄不走，且注入时明令禁止复用与谐音改写。拆完默认绑定当前书，写其他书时在各自设定页切换，互不影响。
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <select
                        value={analysisBookId}
                        onChange={(e) => setAnalysisBookId(e.target.value)}
                        className="rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                      >
                        <option value="">选择要拆的书（来自书库）</option>
                        {libBooks.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={analyzeBook}
                        disabled={!analysisBookId || !!analyzing}
                        className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        {!!analyzing ? `拆解「${analyzing}」中…` : <><Ic n="wand" /> 开始拆解</>}
                      </button>
                      {!libBooks.length && <span className="text-stone-400">书库为空，请先在「改写润色」页导入参考小说</span>}
                    </div>
                  </section>

                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h3 className="text-sm font-bold"><Ic n="box" /> 参考资产（{analyses.length}）</h3>
                    {analyses.length === 0 ? (
                      <p className="mt-2 text-xs text-stone-400">还没有拆解资产。选一本你想借鉴的参考小说开始拆解。</p>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {analyses.map((a) => {
                          const bound = project.refAnalysisId === a.id
                          const bindTo = (id) => {
                            updateProject({ refAnalysisId: id })
                            setForm((f) => (f ? { ...f, refAnalysisId: id } : f))
                          }
                          return (
                            <div key={a.id} className={`rounded-xl border p-4 ${bound ? 'border-stone-400 bg-stone-50' : 'border-stone-200'}`}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold">{a.name}</span>
                                <span className="text-xs text-stone-400">{new Date(a.createdAt).toLocaleDateString()}</span>
                                {bound && <span className="rounded-full bg-stone-800 px-2 py-0.5 text-xs text-white">已绑定本书</span>}
                                <div className="ml-auto flex gap-2">
                                  {bound ? (
                                    <button onClick={() => bindTo('')} className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-100">
                                      解绑
                                    </button>
                                  ) : (
                                    <button onClick={() => bindTo(a.id)} className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50">
                                      绑定本书
                                    </button>
                                  )}
                                  <button onClick={() => removeAnalysis(a.id)} className="rounded-lg px-2 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-red-600">
                                    删除
                                  </button>
                                </div>
                              </div>
                              {a.work_function && <p className="mt-2 text-xs leading-relaxed text-stone-600">{a.work_function}</p>}
                              {!!a.character_functions?.length && (
                                <div className="mt-2">
                                  <p className="text-xs font-semibold text-stone-500">人物功能位</p>
                                  <ul className="mt-1 space-y-0.5 text-xs text-stone-500">
                                    {a.character_functions.map((c, i) => (
                                      <li key={i}>
                                        - {c.slot || '功能位'}：{c.relation || ''}；弧线：{c.arc || ''}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {!!a.pacing_patterns?.length && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {a.pacing_patterns.map((p, i) => (
                                    <span key={i} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                                      {p}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {!!a.techniques?.length && (
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-xs text-stone-500">值得借鉴的写法（{a.techniques.length}）</summary>
                                  <ul className="mt-1 space-y-0.5 text-xs text-stone-500">
                                    {a.techniques.map((t, i) => (
                                      <li key={i}>- {t}</li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </section>
                </div>
              )}
              {/* ============ 质检中心：章节审核（GLM）+ 全局诊断（DeepSeek）+ 卷志长时记忆 ============ */}
              {subtab === 'dashboard' && (
                <div className="space-y-4">
                  <ReviewPanel project={project} saveProject={saveProject} apiKey={apiKey} glmKey={glmKey} onNeedGlmKey={onNeedKey} busy={busy} />
                  <DiagnosePanel apiKey={apiKey} text={diagnoseText} context={diagnoseContext} disabled={busy} cacheKey={`na_diag_${project.id}_${project.chapters.length}`} />
                  {project.memory?.length > 0 && (
                    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                      <h3 className="text-sm font-bold"><Ic n="scroll" /> 卷级长时记忆（{project.memory.length} 卷）</h3>
                      <p className="mt-1 text-xs text-stone-400">每 20 章自动把章节摘要链压缩成不可变卷志，写新章时自动注入，防止早期剧情被遗忘。</p>
                      <div className="mt-3 space-y-2">
                        {project.memory.map((m, i) => {
                          const from = i > 0 ? project.memory[i - 1].upTo + 1 : 1
                          return (
                            <details key={i} className="rounded-xl border border-stone-200 p-3">
                              <summary className="cursor-pointer text-xs font-medium text-stone-600">第 {from}~{m.upTo} 章卷志</summary>
                              <p className="novel-text mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-600">{m.text}</p>
                            </details>
                          )
                        })}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {/* 剧情讨论面板：绑定本书上下文的自由对话，悬浮固定布局，记录随书落库 */}
      {discOpen && project && (
        <DiscussionPanel project={project} saveProject={saveProject} apiKey={apiKey} onNeedKey={onNeedKey} onClose={() => setDiscOpen(false)} />
      )}
    </div>
  )
}
