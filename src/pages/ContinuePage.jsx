import { useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatJSON, chatStream, ANTI_REPETITION } from '../lib/llm.js'
import { analyzeMessages, continueMessages, CONTINUE_ANGLES, followupMessages, FOLLOWUP_ANGLES, summarizeMessages, continueStyleMessages } from '../lib/prompts.js'
import { copyText, countWords, mapLimit, uid } from '../lib/utils.js'
import { put } from '../lib/db.js'
import { newProject, blendStyles } from '../lib/longform.js'
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { readDocumentFile, baseName, extOf, exportDocument, EXPORT_FORMATS, READ_ACCEPT } from '../lib/docio.js'

// 原文过长时：先给前文做摘要，再拼上尾部原文发给续写
const SUMMARIZE_THRESHOLD = 8000 // 超过这个字数才做前文摘要
const TAIL_LENGTH = 4000 // 尾部原文保留字数（紧接续写处）
const ANALYZE_LIMIT = 60000 // 分析原文的最大截取字数，防止超出上下文窗口
const STYLE_ANALYZE_LIMIT = 40000 // 文风分析：就粘贴的全部文字整体分析，仅超长时按此上限截断（绝不做 7 段抽样）
const EXPORT_FORMAT_IDS = EXPORT_FORMATS.map((f) => f.id)

// 分析结果的分块折叠容器：点标题栏展开/收起，chevron 旋转指示状态
function CollapseBlock({ title, icon, badge, open, onToggle, children }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white/60">
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-stone-600">
          {icon && <Ic n={icon} />}
          {title}
          {badge != null && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">{badge}</span>}
        </span>
        <Ic n="chevron" className={`transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

export default function ContinuePage({ apiKey, onNeedKey, onOpenLongForm }) {
  const lib = useLibrary()
  const [text, setText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)
  const [world, setWorld] = useState('')
  const [characters, setCharacters] = useState([])
  const [outline, setOutline] = useState('')
  const [timeline, setTimeline] = useState([])
  const [versions, setVersions] = useState([])
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState('')
  const [showDialog, setShowDialog] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  // 后续版本（AI 自动探索 4 种剧情走向）
  const [followupVersions, setFollowupVersions] = useState([])
  const [followupGenerating, setFollowupGenerating] = useState(false)
  const [followupProgress, setFollowupProgress] = useState(0)
  const [newChar, setNewChar] = useState({ name: '', identity: '', personality: '', description: '' })
  // 原文文风分析（就粘贴的全部文字整体分析，区别于书库抽样）
  const [styleProfile, setStyleProfile] = useState('')
  const [styleHabits, setStyleHabits] = useState([])
  const [styleSamples, setStyleSamples] = useState([])
  const [styleAnalyzing, setStyleAnalyzing] = useState(false)
  const [styleAnalyzed, setStyleAnalyzed] = useState(false)
  // 原文来源：'paste'（复制粘贴 / 直接输入）| 'file'（导入文件）——决定「纳入原文」提示与导出默认格式
  const [sourceMode, setSourceMode] = useState('paste')
  const [sourceFile, setSourceFile] = useState(null) // { name, base, format }
  // 分析结果分块折叠：各块默认展开
  const [collapsed, setCollapsed] = useState({ world: false, chars: false, outline: false, timeline: false, style: false })
  const toggleBlock = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))
  // 导出完整原文
  const [exportFormat, setExportFormat] = useState('txt')
  const [exporting, setExporting] = useState(false)
  const [infoMsg, setInfoMsg] = useState('')
  // 已纳入原文的版本（按钮反馈）：{ 'v0':true, 'f2':true }
  const [incorporated, setIncorporated] = useState({})
  const fileRef = useRef(null)

  // 导入本地文件（.txt / .md / .docx），平板走系统文件选择器；.doc 老式二进制会抛错提示转存
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr('')
    try {
      const content = await readDocumentFile(file)
      if (countWords(content) < 20) {
        setErr('文件内容太少，请选择有一定篇幅的小说文件。')
        return
      }
      setText(content)
      setSourceMode('file')
      const fmt = extOf(file.name)
      setSourceFile({ name: file.name, base: baseName(file.name), format: fmt })
      if (EXPORT_FORMAT_IDS.includes(fmt)) setExportFormat(fmt) // 导出默认沿用导入格式
    } catch (ex) {
      setErr(ex?.message || '文件读取失败，请重试。')
    }
  }

  // 分析原文：严格只提取原文明确出现的信息，禁止捏造
  const analyze = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    setErr('')
    setAnalyzing(true)
    const truncated = text.length > ANALYZE_LIMIT
    const analyzeText = truncated ? text.slice(0, ANALYZE_LIMIT) : text
    try {
      const res = await chatJSON({ apiKey, messages: analyzeMessages({ text: analyzeText }), temperature: 0.3 })
      setWorld(res.world_setting || '')
      setCharacters(Array.isArray(res.characters) ? res.characters : [])
      setOutline(res.outline || '')
      setTimeline(Array.isArray(res.timeline) ? res.timeline : [])
      setAnalyzed(true)
      if (truncated) {
        setErr(`原文较长，已分析前 ${ANALYZE_LIMIT} 字。如需完整分析请拆分原文后重试。`)
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setAnalyzing(false)
    }
  }

  // 分析文风：就粘贴/导入的【全部原文】整体提炼笔触（不抽样），作为续写的「皮」
  const analyzeStyle = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    setErr('')
    setInfoMsg('')
    setStyleAnalyzing(true)
    const truncated = text.length > STYLE_ANALYZE_LIMIT
    const styleText = truncated ? text.slice(0, STYLE_ANALYZE_LIMIT) : text
    try {
      const res = await chatJSON({ apiKey, messages: continueStyleMessages({ text: styleText }), temperature: 0.3 })
      setStyleProfile(res.style_profile || '')
      setStyleHabits(Array.isArray(res.habits) ? res.habits : [])
      setStyleSamples(Array.isArray(res.samples) ? res.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [])
      setStyleAnalyzed(true)
      if (truncated) setInfoMsg(`原文较长，文风分析已就前 ${STYLE_ANALYZE_LIMIT} 字整体提炼（未做抽样，区别于书库的 7 段采样）。`)
    } catch (e) {
      setErr(e.message)
    } finally {
      setStyleAnalyzing(false)
    }
  }

  // 续写：4 个方向各自独立流式生成，并发 2，从结构上保证内容不雷同
  const generate = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入原文。')
      return
    }
    setErr('')
    setGenerating(true)
    setVersions([])
    setProgress(0)
    resetIncorporated('v')
    const { style, habits, forbidden } = effectiveStyle()
    // 原文过长时：先给前文做 AI 摘要，再拼上尾部原文（紧接续写处）
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(Math.max(0, text.length - TAIL_LENGTH - 60000), text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3 })
        summary = sumRes.summary || ''
      } catch {
        // 摘要失败不阻塞续写，降级为仅尾部截断
        summary = ''
      } finally {
        setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    const charText = characters
      .map((c) => `${c.name || ''}：${[c.identity, c.personality, c.description].filter(Boolean).join('，')}`)
      .filter(Boolean)
      .join('\n')
    try {
      await mapLimit(
        CONTINUE_ANGLES.map((a, i) => ({ a, i })),
        2,
        async ({ a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              ...ANTI_REPETITION,
              messages: continueMessages({ text: tail, summary, world, characters: charText, outline, timeline, style, habits, forbidden, instruction, index: i }),
              temperature: a.temp,
              onDelta: (full) => {
                setVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e.message }
              return next
            })
          } finally {
            setProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenerating(false)
    }
  }

  // 后续版本：AI 自动探索 4 种不同剧情走向（区别于自定义续写：不需要用户指令，在剧情走向上本质不同）
  const generateFollowup = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入原文。')
      return
    }
    setErr('')
    setFollowupGenerating(true)
    setFollowupVersions([])
    setFollowupProgress(0)
    resetIncorporated('f')
    const { style, habits, forbidden } = effectiveStyle()
    // 同样支持前文摘要 + 尾部全文
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(Math.max(0, text.length - TAIL_LENGTH - 60000), text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3 })
        summary = sumRes.summary || ''
      } catch {
        summary = ''
      } finally {
        setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    const charText = characters
      .map((c) => `${c.name || ''}：${[c.identity, c.personality, c.description].filter(Boolean).join('，')}`)
      .filter(Boolean)
      .join('\n')
    try {
      await mapLimit(
        FOLLOWUP_ANGLES.map((a, i) => ({ a, i })),
        2,
        async ({ a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              ...ANTI_REPETITION,
              messages: followupMessages({ text: tail, summary, world, characters: charText, outline, timeline, style, habits, forbidden, index: i }),
              temperature: a.temp,
              onDelta: (full) => {
                setFollowupVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e.message }
              return next
            })
          } finally {
            setFollowupProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      setErr(e.message)
    } finally {
      setFollowupGenerating(false)
    }
  }

  // 人物卡手动增删
  const addChar = () => {
    if (!newChar.name.trim()) return
    setCharacters([...characters, { ...newChar }])
    setNewChar({ name: '', identity: '', personality: '', description: '' })
  }
  const removeChar = (idx) => setCharacters(characters.filter((_, i) => i !== idx))

  // 把分析结果与原文一键转入长篇写作：人物卡升级为人物档案，后续由一致性档案接手连载
  const migrateToLongForm = async () => {
    if (!text) return
    const proj = newProject(`续写导入 ${new Date().toLocaleDateString()}`)
    proj.world = world
    proj.outline = outline
    proj.characters = characters
      .filter((c) => c?.name)
      .map((c) => ({ name: c.name, aliases: [], identity: c.identity || '', personality: c.personality || '', description: c.description || '', status: '' }))
    proj.events = timeline.map((t) => ({ chapter: 0, text: `${t.stage}：${t.summary}` }))
    proj.chapters = [
      {
        id: uid(),
        chapterNo: 1,
        title: '既有正文',
        content: text,
        wordCount: countWords(text),
        summary: '',
        issueCount: 0,
        createdAt: Date.now(),
      },
    ]
    await put('projects', proj)
    localStorage.setItem('na_open_project', proj.id)
    onOpenLongForm && onOpenLongForm()
  }

  const copy = async (t, btn) => {
    await copyText(t)
    if (btn) {
      btn.textContent = '已复制 ✓'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
  }

  // 当前生效的文风「皮」来源（三级优先级，effectiveStyle 与右上角文案共用，保证显示与注入一致）：
  //   'source' = 续写页「分析文风」得到的原文文风（最高）｜'lib' = 书库选中并分析过的书｜'preset' = 都没有，回退系统内置六本规则集。
  const skinFrom = (styleAnalyzed && styleProfile) ? 'source' : (lib.style?.profile ? 'lib' : 'preset')

  // 续写生效的文风 ——「皮」按 skinFrom 三级择一主导嗓音，「骨」恒为系统内置六本规则集（PRESET_STYLES）habits/forbidden 并集：
  //   有皮（原文 / 书库）→ forceSkinBookId 锁定该皮，六本 + 皮自身 habits 合并作骨；
  //   无皮 → 六本规则集聚合兜底（blendStyles 从六本择一主导嗓音、habits 并集作骨）。
  const effectiveStyle = () => {
    const sourceRec = (skinFrom === 'source')
      ? { bookId: 'continue:source', origin: 'user', profile: styleProfile, habits: styleHabits, samples: styleSamples, forbidden: lib.style?.forbidden || [] } // 书库自定义禁用词始终叠加
      : null
    const skinRec = sourceRec || (skinFrom === 'lib' ? lib.style : null)
    if (skinRec) {
      const blended = blendStyles([skinRec, ...PRESET_STYLES], { forceSkinBookId: skinRec.bookId }) || skinRec
      return { style: blended.profile, habits: blended.habits, forbidden: blended.forbidden }
    }
    const base = blendStyles(PRESET_STYLES) // 第三级兜底：系统内置六本规则集
    return { style: base?.profile, habits: base?.habits, forbidden: base?.forbidden }
  }

  // 重新生成时清除对应类型的「已纳入」标记（v=自定义续写，f=探索后续），避免旧标记落到新内容上
  const resetIncorporated = (prefix) =>
    setIncorporated((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(prefix))))

  // 纳入原文：把某个续写版本追加到「原文」文末。generate/generateFollowup 都实时读取 text，
  // 所以纳入后再次「自定义续写 / 探索后续」自然基于纳入后的新原文（满足“探索的是新纳入原文的版本”）。
  const incorporate = (content, key) => {
    if (!content) return
    setText((prev) => (prev ? prev.replace(/\s+$/, '') + '\n\n' + content : content))
    if (key) setIncorporated((m) => ({ ...m, [key]: true }))
    setInfoMsg(
      sourceMode === 'file'
        ? '已把该版本纳入原文（追加到文末）。再次续写 / 探索后续会基于纳入后的新原文；可在下方「导出完整原文」保存更新后的文件。'
        : '已把该版本纳入原文（追加到文末）。再次续写 / 探索后续会基于纳入后的新原文。',
    )
  }

  // 导出完整原文的文件名基：文件来源用导入名，粘贴来源用首个非空行（截 20 字），都为空则「续写原文」。
  // 实际导出名由 buildExportName 追加「-续写全文」后缀，确保与导入文件名不同。
  const exportBase = () => {
    if (sourceMode === 'file' && sourceFile?.base) return sourceFile.base
    const first = text.split(/\n/).map((s) => s.trim()).find(Boolean) || ''
    return first.slice(0, 20) || '续写原文'
  }

  const doExport = async () => {
    if (!text) {
      setErr('没有可导出的原文。')
      return
    }
    setErr('')
    setExporting(true)
    try {
      await exportDocument(exportBase(), text, exportFormat)
    } catch (e) {
      setErr('导出失败：' + (e?.message || e))
    } finally {
      setExporting(false)
    }
  }

  const wordCount = countWords(text)

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} />

        <div className="min-w-0 space-y-4">
          {/* 原文输入 */}
          <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold"><Ic n="book" /> 粘贴或导入要续写的原文</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">{wordCount} 字</span>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="min-h-[40px] rounded-full border border-stone-300 px-4 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50"
                >
                  导入文件
                </button>
                <input ref={fileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onFile} />
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setSourceMode('paste') }}
              placeholder="把需要续写的小说原文粘贴到这里，或点右上角导入 .txt / .md / .docx 文件…"
              rows={8}
              className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-4 text-base focus:border-stone-500 focus:outline-none"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={analyze}
                disabled={analyzing}
                className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {analyzing ? 'AI 分析中…' : <><Ic n="search" /> 分析原文（世界观 / 人物 / 大纲 / 故事线）</>}
              </button>
              <button
                onClick={analyzeStyle}
                disabled={styleAnalyzing}
                className="min-h-[44px] rounded-full border-2 border-stone-800 bg-transparent px-6 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
              >
                {styleAnalyzing ? 'AI 分析文风中…' : <><Ic n="wand" /> 分析文风（笔触 / 句式 / 节奏）</>}
              </button>
              <span className="text-xs text-stone-400">结果可编辑、可分块收起；文风就粘贴的全部文字整体分析（不抽样）</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
            {infoMsg && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{infoMsg}</p>}
          </section>

          {/* 分析结果（可编辑 · 分块折叠） */}
          {(analyzed || styleAnalyzed) && (
            <section className="space-y-3 rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold"><Ic n="clipboard" /> 原文分析结果（可编辑 · 点标题可收起）</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const anyOpen = Object.values(collapsed).some((v) => !v)
                      setCollapsed({ world: anyOpen, chars: anyOpen, outline: anyOpen, timeline: anyOpen, style: anyOpen })
                    }}
                    className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    {Object.values(collapsed).some((v) => !v) ? '全部收起' : '全部展开'}
                  </button>
                  {analyzed && (
                    <button
                      onClick={migrateToLongForm}
                      className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
                    >
                      <Ic n="mountain" /> 转入长篇写作
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-stone-400">留空的项 = 原文未明确提及，AI 未捏造</p>

              {/* 世界观 */}
              {analyzed && (
                <CollapseBlock title="世界观设定" icon="globe" open={!collapsed.world} onToggle={() => toggleBlock('world')}>
                  <textarea
                    value={world}
                    onChange={(e) => setWorld(e.target.value)}
                    placeholder="原文未明确提及世界观设定，可手动补充…"
                    rows={3}
                    className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                  />
                </CollapseBlock>
              )}

              {/* 人物卡 */}
              {analyzed && (
                <CollapseBlock title="人物卡" icon="user" badge={characters.length} open={!collapsed.chars} onToggle={() => toggleBlock('chars')}>
                  {characters.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-stone-300 p-3 text-xs text-stone-400">原文未分析出明确人物，可在下方手动添加。</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {characters.map((c, i) => (
                        <div key={i} className="relative rounded-xl border border-stone-200 bg-white p-3">
                          <button
                            onClick={() => removeChar(i)}
                            className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                          >
                            <Ic n="x" />
                          </button>
                          <p className="pr-6 text-sm font-bold text-stone-800">{c.name || '未命名'}</p>
                          {c.identity && <p className="mt-0.5 text-xs text-stone-600">身份：{c.identity}</p>}
                          {c.personality && <p className="mt-0.5 text-xs text-stone-600">性格：{c.personality}</p>}
                          {c.description && <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{c.description}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 手动添加人物 */}
                  <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="mb-2 text-xs font-semibold text-stone-500">手动添加人物</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        value={newChar.name}
                        onChange={(e) => setNewChar({ ...newChar, name: e.target.value })}
                        placeholder="姓名*"
                        className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <input
                        value={newChar.identity}
                        onChange={(e) => setNewChar({ ...newChar, identity: e.target.value })}
                        placeholder="身份 / 职业"
                        className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <input
                        value={newChar.personality}
                        onChange={(e) => setNewChar({ ...newChar, personality: e.target.value })}
                        placeholder="性格"
                        className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <input
                        value={newChar.description}
                        onChange={(e) => setNewChar({ ...newChar, description: e.target.value })}
                        placeholder="其他描述"
                        className="rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                    </div>
                    <button
                      onClick={addChar}
                      disabled={!newChar.name.trim()}
                      className="mt-2 min-h-[36px] rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                    >
                      + 添加人物
                    </button>
                  </div>
                </CollapseBlock>
              )}

              {/* 大纲 */}
              {analyzed && (
                <CollapseBlock title="故事大纲" icon="map" open={!collapsed.outline} onToggle={() => toggleBlock('outline')}>
                  <textarea
                    value={outline}
                    onChange={(e) => setOutline(e.target.value)}
                    placeholder="原文未明确梳理出大纲，可手动补充…"
                    rows={3}
                    className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
                  />
                </CollapseBlock>
              )}

              {/* 故事线时间线（文字为主，阶段名非真实时间） */}
              {analyzed && timeline.length > 0 && (
                <CollapseBlock title="故事线梳理（基于原文已发生情节，非真实时间）" icon="hourglass" open={!collapsed.timeline} onToggle={() => toggleBlock('timeline')}>
                  <div className="relative pl-6">
                    <div className="absolute left-[7px] top-1 bottom-1 w-0.5 bg-stone-300"></div>
                    {timeline.map((t, i) => (
                      <div key={i} className="relative mb-4 last:mb-0">
                        <div className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-500 shadow"></div>
                        <p className="text-sm font-semibold text-stone-800">{t.stage || `阶段${i + 1}`}</p>
                        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">{t.summary}</p>
                      </div>
                    ))}
                  </div>
                </CollapseBlock>
              )}

              {/* 文风（就粘贴的全部原文整体分析，不抽样） */}
              {styleAnalyzed && (
                <CollapseBlock title="文风分析（笔触 / 句式 / 节奏，就全部原文提炼）" icon="style" open={!collapsed.style} onToggle={() => toggleBlock('style')}>
                  <textarea
                    value={styleProfile}
                    onChange={(e) => setStyleProfile(e.target.value)}
                    placeholder="文风档案（可编辑）…"
                    rows={6}
                    className="novel-text w-full resize-y rounded-xl border border-stone-200 p-3 text-sm leading-relaxed focus:border-stone-500 focus:outline-none"
                  />
                  {styleHabits.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1.5 text-xs font-semibold text-stone-500">可执行模仿清单（{styleHabits.length}）</p>
                      <ul className="space-y-1">
                        {styleHabits.map((h, i) => (
                          <li key={i} className="rounded-lg bg-stone-50 px-3 py-1.5 text-xs leading-relaxed text-stone-600">{i + 1}. {h}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="mt-2 text-xs leading-relaxed text-stone-400">此文风作为续写的「皮」（主导笔触），与内置 6 种混合文风规则集（骨）融合；左侧书库若选了参考书，仍以原文文风优先。</p>
                </CollapseBlock>
              )}
            </section>
          )}

          {/* 诊断看板：梳理现有故事线与节奏（含伏笔是否收太早），在续写前先看一眼 */}
          {text && (
            <DiagnosePanel
              apiKey={apiKey}
              text={text.length > 16000 ? text.slice(-16000) : text}
              context={[
                world && `【世界观】${world.slice(0, 500)}`,
                outline && `【大纲】${outline.slice(0, 800)}`,
                timeline.length > 0 && `【已有故事线】${timeline.map((t) => `${t.stage}：${t.summary}`).join('；')}`,
              ]
                .filter(Boolean)
                .join('\n')}
              disabled={analyzing || generating || followupGenerating}
              cacheKey={`na_diag_cont_${text.length}_${text.slice(0, 16)}`}
            />
          )}

          {/* 续写按钮区 */}
          <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold"><Ic n="pen" /> 续写</h2>
              {skinFrom === 'source' ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">将贴合你分析的原文文风（六本规则集为骨）</span>
              ) : skinFrom === 'lib' ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">将贴合《{lib.selectedBook?.name || '所选小说'}》文风（六本规则集为骨）</span>
              ) : (
                <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">将套用系统内置六本规则集（点「分析文风」可更贴合你的原文）</span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">两个按钮任选：「自定义续写」由你在对话框中指定方向，生成 4 种叙述方式的版本；「探索后续版本」由 AI 自动探索 4 种不同剧情走向（顺势发展 / 意外变故 / 人物抉择 / 伏笔回收）。每个版本独立请求 + 不同 system prompt + 不同温度，结构上保证不雷同。</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowDialog(true)}
                disabled={generating || summarizing || followupGenerating}
                className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {summarizing && generating ? '正在摘要前文…' : generating ? `AI 续写中… ${progress}/4` : <><Ic n="pen" /> 自定义续写</>}
              </button>
              <button
                onClick={generateFollowup}
                disabled={followupGenerating || summarizing || generating}
                className="min-h-[44px] rounded-full border-2 border-stone-800 bg-transparent px-6 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50"
              >
                {followupGenerating ? `探索后续中… ${followupProgress}/4` : <><Ic n="wand" /> 探索后续版本</>}
              </button>
              {(generating || summarizing || followupGenerating) && (
                <div className="flex items-center gap-2 text-sm text-stone-500">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                  {summarizing ? '原文较长，正在给前文做摘要…' : generating ? '正在生成自定义续写版本，可边看边等…' : '正在探索后续剧情走向，可边看边等…'}
                </div>
              )}
            </div>
            {/* 导出完整原文（含已纳入的续写版本）：txt / md / doc / docx 四格式，文件名与导入名不同 */}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3">
              <span className="text-xs font-semibold text-stone-600"><Ic n="save" /> 导出完整原文</span>
              <select
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value)}
                className="min-h-[36px] rounded-lg border border-stone-200 px-2 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}（.{f.ext}）</option>
                ))}
              </select>
              <button
                onClick={doExport}
                disabled={exporting || !text}
                className="min-h-[36px] rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {exporting ? '导出中…' : <><Ic n="save" /> 导出（.{exportFormat}）</>}
              </button>
              <span className="text-xs text-stone-400">导出「纳入续写后」的完整原文，文件名追加「-续写全文」，与导入名不同</span>
            </div>
          </section>

          {/* 四个续写版本卡片 */}
          {(generating || versions.length > 0) && (
            <section className="grid gap-4 sm:grid-cols-2">
              {CONTINUE_ANGLES.map((a, i) => {
                const v = versions[i]
                return (
                  <article key={i} className="flex flex-col rounded-2xl bg-[#fbf8ef] shadow-sm">
                    <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                      <h3 className="text-sm font-bold">{a.title}</h3>
                      {v?.content && !v.error && (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => copy(v.content, e.target)}
                            className="min-h-[32px] rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                          >
                            复制
                          </button>
                          <button
                            onClick={() => incorporate(v.content, `v${i}`)}
                            className={`min-h-[32px] rounded-full px-3 py-1 text-xs ${incorporated[`v${i}`] ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}
                          >
                            {incorporated[`v${i}`] ? '已纳入原文 ✓' : '纳入原文'}
                          </button>
                        </div>
                      )}
                    </header>
                    {v?.error ? (
                      <div className="p-4 text-sm text-red-600">生成失败：{v.error}</div>
                    ) : v?.content ? (
                      <div className="novel-text max-h-[420px] space-y-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
                        {v.content.split(/\n+/).filter((s) => s.trim()).map((para, pi) => (
                          <p key={pi} className="indent-[2em]">{para.trim()}</p>
                        ))}
                      </div>
                    ) : generating ? (
                      <div className="flex items-center gap-2 p-4 text-sm text-stone-400">
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                        等待生成…
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </section>
          )}

          {/* 后续版本卡片（AI 自动探索 4 种剧情走向，区别于自定义续写） */}
          {(followupGenerating || followupVersions.length > 0) && (
            <section className="space-y-3">
              <h3 className="text-sm font-bold text-stone-700"><Ic n="wand" /> 后续版本（AI 自动探索 4 种剧情走向）</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {FOLLOWUP_ANGLES.map((a, i) => {
                  const v = followupVersions[i]
                  return (
                    <article key={i} className="flex flex-col rounded-2xl bg-[#fbf8ef] shadow-sm">
                      <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                        <h3 className="text-sm font-bold">{a.title}</h3>
                        {v?.content && !v.error && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={(e) => copy(v.content, e.target)}
                              className="min-h-[32px] rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                            >
                              复制
                            </button>
                            <button
                              onClick={() => incorporate(v.content, `f${i}`)}
                              className={`min-h-[32px] rounded-full px-3 py-1 text-xs ${incorporated[`f${i}`] ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}
                            >
                              {incorporated[`f${i}`] ? '已纳入原文 ✓' : '纳入原文'}
                            </button>
                          </div>
                        )}
                      </header>
                      {v?.error ? (
                        <div className="p-4 text-sm text-red-600">生成失败：{v.error}</div>
                      ) : v?.content ? (
                        <div className="novel-text max-h-[420px] space-y-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
                          {v.content.split(/\n+/).filter((s) => s.trim()).map((para, pi) => (
                            <p key={pi} className="indent-[2em]">{para.trim()}</p>
                          ))}
                        </div>
                      ) : followupGenerating ? (
                        <div className="flex items-center gap-2 p-4 text-sm text-stone-400">
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"></span>
                          等待生成…
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 续写设定对话框 */}
      {showDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !generating && setShowDialog(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-[#fbf8ef] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold"><Ic n="pen" /> 续写设定</h3>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              告诉 AI 你希望故事如何发展，例如：接下来主角发现了一个秘密 / 节奏加快 / 引入新冲突 / 让某人物出场 / 场景切换到某处… 不填则 AI 自由发挥。
            </p>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="输入你的续写需求或方向指令（可选）…"
              rows={5}
              className="novel-text mt-3 w-full resize-y rounded-xl border border-stone-200 p-3 text-sm focus:border-stone-500 focus:outline-none"
            />
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-stone-500">将同时生成 4 个不同版本（自然续写 / 换种写法 / 细节丰富 / 大胆发挥），通过不同温度和叙述要求保证内容各异</span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowDialog(false)}
                disabled={generating}
                className="min-h-[40px] rounded-full border border-stone-300 px-5 py-2 text-sm text-stone-600 hover:bg-stone-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowDialog(false)
                  generate()
                }}
                disabled={generating || countWords(text) < 50}
                className="min-h-[40px] rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                <Ic n="rocket" /> 开始续写
              </button>
            </div>
            {countWords(text) < 50 && (
              <p className="mt-2 text-right text-xs text-red-500">请先粘贴或导入至少几十字的原文</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
