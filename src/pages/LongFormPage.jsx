import { useEffect, useRef, useState } from 'react'
import KeyBanner from '../components/KeyBanner.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import ReviewPanel from '../components/ReviewPanel.jsx'
import ChapterRewriter from '../components/ChapterRewriter.jsx'
import Ic from '../components/Ic.jsx'
import { chatStream, chatJSON } from '../lib/llm.js'
import { getAll, put, del } from '../lib/db.js'
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
  GENRES,
  TONES,
} from '../lib/prompts.js'
import { newProject, searchChapters, runPostChapter, applyReport, applyForeshadowPlans, outlineForChapter, outlineMaxChapter, expandKeywords, povStreak, reviewOpportunity, rerunArchive, chronicleContext, restoreChapter, PROTECT_GAP } from '../lib/longform.js'
import { countWords, uid, downloadText } from '../lib/utils.js'

// 长篇一致性系统的交互中枢：
// 章节写作（上下文组装 + 章后档案流水线）、伏笔账本（保护期）、设定与人物活档案、事件级时间线、诊断看板
const SUBTABS = [
  { id: 'chapters', label: '章节写作', icon: 'book' },
  { id: 'foreshadow', label: '伏笔账本', icon: 'hook' },
  { id: 'settings', label: '设定与人物', icon: 'gear' },
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
  // 补跑归档进度（降级补救 / 手改正文后重新建档）
  const [rerunning, setRerunning] = useState('')
  // 细纲续写进度（细纲耗尽/将尽时让 AI 紧接规划下一批）
  const [extending, setExtending] = useState(false)
  // 设定表单（本地编辑，显式保存，避免流式生成时高频写库）
  const [form, setForm] = useState(null)
  const [genBusy, setGenBusy] = useState('')
  const seedFileRef = useRef(null)
  const composerRef = useRef(null)
  const abortRef = useRef(null)
  const [formVersion, setFormVersion] = useState(0)
  // 写作器状态按书隔离持久化：中断/刷新不丢未保存初稿，换书时草稿互不串扰（报告卡含降级提示也一并保留）
  const skipComposerSave = useRef(false)

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
  }, [])

  // 记住当前打开的书，供中断/刷新后自动恢复（删书时同步清理）
  useEffect(() => {
    if (selectedId) localStorage.setItem('na_lf_last', selectedId)
  }, [selectedId])

  const project = projects.find((p) => p.id === selectedId) || null

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
    skipComposerSave.current = true // 本次提交内禁止回写，防止旧书的草稿被写进新书的键里，下次状态变更再正常落盘
    setDraft(saved?.draft || '')
    setDraftTitle(saved?.draftTitle || '')
    setInstruction(saved?.instruction || '')
    setScenePlan(saved?.scenePlan || '')
    setLastReport(saved?.lastReport || null)
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
          JSON.stringify({ draft, draftTitle, instruction, scenePlan, lastReport }),
        )
      } catch {
        /* 快照写失败不影响写作 */
      }
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, draft, draftTitle, instruction, scenePlan, lastReport])

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
      outline: project.outline || '',
      outlineCount: project.outlineCount || 10,
      protagonist: project.protagonist || '',
      characters: project.characters || [],
    })
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
    setDraft('')
    abortRef.current = new AbortController() // 停止按钮用：中止后已生成部分保留在编辑框
    const hadTitle = draftTitle.trim()
    try {
      // 上下文组装：先用轻量 LLM 调用把写作方向扩展成检索词（语义检索近似，失败降级本地分词），
      // 再召回相关前文片段；细纲按需注入（只取本章及后续两章），卷志长时记忆拼接注入，避免百万字时上下文溢出
      const kws = await expandKeywords({ apiKey, instruction, characters: project.characters, world: project.world })
      const passages = searchChapters(project.chapters, kws)
      const longTerm = (project.memory || []).map((m) => m.text).join('\n\n')
      // 视角约束：以主角线为主，非主角视角连续不超过 3~5 章；达上限时本章强制回到主角视角
      const streak = povStreak(project.chapters, project.protagonist)
      let povRule = ''
      if (project.protagonist) {
        if (streak >= 5) povRule = `非主角视角已连续 ${streak} 章，已达上限；本章必须回到主角「${project.protagonist}」的视角。`
        else if (streak >= 3) povRule = `非主角视角已连续 ${streak} 章（上限 3~5 章），本章优先回到主角「${project.protagonist}」的视角；如仍用他人视角，篇幅控制在三分之一以内。`
      }
      const full = await chatStream({
        apiKey,
        messages: longFormDraftMessages({
          chapterNo: nextNo,
          synopsis: project.synopsis,
          world: project.world,
          characters: project.characters,
          outline: outlineForChapter(project.outline, nextNo),
          longTerm,
          rollingSummary: project.rollingSummary,
          prevChapterSummary: lastChapter?.summary || '',
          tail: lastChapter ? lastChapter.content.slice(-2000) : project.synopsis || project.world || '',
          foreshadows: activeHooks,
          storylines: project.storylines || [],
          povRule,
          scenePlan,
          chronicles: chronicleContext(project),
          passages,
          instruction,
        }),
        temperature: 0.9,
        signal: abortRef.current?.signal,
        onDelta: (t) => setDraft(t),
      })
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
        }),
        temperature: 0.5,
      })
      const scenes = Array.isArray(res.scenes) ? res.scenes.filter((s) => s?.summary) : []
      if (!scenes.length) throw new Error('AI 未返回有效场景清单，请重试。')
      setScenePlan(scenes.map((s) => `${s.title ? s.title + '：' : ''}${s.summary}`).join('\n'))
    } catch (e) {
      setErr(e.message)
    } finally {
      setPlanningScene(false)
    }
  }

  // 保存章节并跑章后档案流水线：摘要链 → 滚动摘要 → 状态回写 → 伏笔账本 → 一致性校验
  const saveChapter = async () => {
    if (!apiKey) return onNeedKey()
    if (countWords(draft) < 100) {
      setErr('初稿太短，请先生成或补充内容再保存。')
      return
    }
    setErr('')
    try {
      const rep = await runPostChapter({ apiKey, project, chapterNo: nextNo, text: draft, onStep: setSavingMsg })
      // applyReport 返回拦截信息：保护期内的伏笔被 AI 抢收时不会真的标记回收，而是提示用户
      const { project: next, blocked } = applyReport(project, { chapterNo: nextNo, title: draftTitle.trim(), text: draft }, rep)
      await saveProject(next)
      const report = { ...rep, chapterNo: nextNo, blocked, povStreak: povStreak(next.chapters, next.protagonist) }
      setLastReport(report)
      setDraft('')
      setDraftTitle('')
      setInstruction('')
      setScenePlan('')
      // 保存成功后立即覆盖本书快照（不等 800ms 防抖）：避免刚存完就关页时旧草稿残留，重进误以为未保存；报告卡同步落盘
      try {
        localStorage.setItem(`na_lf_draft_${next.id}`, JSON.stringify({ draft: '', draftTitle: '', instruction: '', scenePlan: '', lastReport: report }))
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
      outline: form.outline,
      outlineCount: form.outlineCount,
      protagonist: form.protagonist,
      characters: form.characters,
    })
    setErr('')
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
  const busy = streaming || !!savingMsg || !!seeding || planning || planningScene || !!rerunning || extending

  // 细纲续航：剩余不足 3 章或已耗尽时提示续写，AI 基于滚动摘要与故事线紧接规划后 15 章，追加进细纲（百万字不断地图）
  const outlineMax = project ? outlineMaxChapter(project.outline) : 0
  const outlineLow = !!project && outlineMax > 0 && outlineMax - nextNo < 3
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

  // 全书导出：按章号拼接标题与正文，下载为 txt（写得出来也要拿得出去）
  const exportBook = () => {
    const sorted = [...project.chapters].sort((a, b) => a.chapterNo - b.chapterNo)
    const txt = sorted.map((c) => `第${c.chapterNo}章 ${c.title || ''}\n\n${c.content}`).join('\n\n\n')
    downloadText(`${project.name || '小说'}.txt`, txt)
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
              <p className="font-bold text-stone-700"><Ic n="chart" /> 档案状态</p>
              <ul className="mt-2 space-y-1.5">
                <li>全书 {totalWords} 字 · {(project.chapters || []).length} 章</li>
                <li>滚动摘要：{project.rollingSummary ? <><Ic n="ok" /> 已维护</> : '—'}</li>
                <li>人物档案：{project.characters.length} 人</li>
                <li>未回收伏笔：{activeHooks.length} 条</li>
                <li>时间线事件：{project.events.length} 条</li>
              </ul>
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
                      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
                        流程：生成场景清单（可编辑）→ 扩写初稿 → 自由修改 → 保存并更新档案（也可跳过清单直接生成）
                      </span>
                    </div>
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
                            {savingMsg || <><Ic n="ok" /> 保存并更新档案（第 {nextNo} 章，{countWords(draft)} 字）</>}
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
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        disabled={streaming}
                        rows={14}
                        className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-4 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
                      />
                    )}
                  </section>

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
                            <ul className="mt-1 list-disc space-y-1 pl-4 leading-relaxed text-red-600">
                              {lastReport.issues.map((it, i) => (
                                <li key={i}>
                                  【{it.type}】{it.description}
                                </li>
                              ))}
                              {lastReport.drift && <li>【大纲偏离】{lastReport.drift}</li>}
                            </ul>
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
                        <button onClick={exportBook} className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50">
                          <Ic n="save" /> 导出全书（.txt）
                        </button>
                      </div>
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
                      <button onClick={saveSettings} disabled={genBusy !== ''} className="rounded-full bg-stone-800 px-5 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
                        <Ic n="save" /> 保存设定
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
                        onClick={() => genField(outlineMessages({ synopsis: form.synopsis, world: form.world, count: form.outlineCount }), 'outline', 0.7)}
                        disabled={genBusy !== '' || !form.world}
                        className="mb-2 rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        {genBusy === 'outline' ? 'AI 编排中…' : form.outline ? '重新生成细纲' : '生成细纲'}
                      </button>
                      <textarea value={form.outline} onChange={(e) => setForm({ ...form, outline: e.target.value })} rows={8} className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none" />
                    </div>
                  </section>

                  {/* 人物活档案 */}
                  <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
                    <h3 className="text-sm font-bold"><Ic n="user" /> 人物档案（{form.characters.length}）</h3>
                    <p className="mt-1 text-xs text-stone-400">「当前状态」由每章保存时自动回写（位置 / 伤势 / 关系等），写新章时注入提示词。</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-stone-50 p-3">
                      <span className="text-xs font-semibold text-stone-500"><Ic n="target" /> 主角（视角约束依据）：</span>
                      <select
                        value={form.protagonist}
                        onChange={(e) => setForm({ ...form, protagonist: e.target.value })}
                        className="rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                      >
                        <option value="">未指定（不启用视角约束）</option>
                        {form.characters.filter((c) => c.name).map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
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
                            <p className="pr-6 text-sm font-bold">{c.name || '未命名'}</p>
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
                          <p className="text-xs font-semibold text-stone-400">{ev.chapter > 0 ? `第 ${ev.chapter} 章` : '前情'}</p>
                          <p className="mt-0.5 text-sm leading-relaxed text-stone-700">{ev.text}</p>
                        </div>
                      ))}
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
    </div>
  )
}
