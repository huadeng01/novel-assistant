import { useEffect, useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
import { useLibrary } from '../hooks/useLibrary.js'
import { chatJSON, chatStream, ANTI_REPETITION } from '../lib/llm.js'
import { analyzeMessages, continueMessages, CONTINUE_ANGLES, followupMessages, FOLLOWUP_ANGLES, summarizeMessages, incorporateReviseMessages, chronicleMessages } from '../lib/prompts.js'
import { chunkText, mergeChronicle, normalizeChronicle, pickChronicleForPrompt, chronicleToText, CHRONICLE_CHUNK } from '../lib/chronicle.js'
import { copyText, countWords, mapLimit } from '../lib/utils.js'
import { loadContinueDraft, saveContinueDraft } from '../lib/backup.js'
import { readDocumentFile, baseName, extOf, exportDocument, EXPORT_FORMATS, READ_ACCEPT } from '../lib/docio.js'

// 原文过长时：先给前文做摘要，再拼上尾部原文发给续写
const SUMMARIZE_THRESHOLD = 8000 // 超过这个字数才做前文摘要
const TAIL_LENGTH = 4000 // 尾部原文保留字数（紧接续写处）
const ANALYZE_LIMIT = 60000 // 分析原文的最大截取字数，防止超出上下文窗口
const EXPORT_FORMAT_IDS = EXPORT_FORMATS.map((f) => f.id)





// 分析结果的分块折叠容器：点标题栏展开/收起，chevron 旋转指示状态
function CollapseBlock({ title, icon, badge, open, onToggle, children }) {
  return (
    <div className="rounded-xl border border-white/25 bg-white/5">
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-stone-600">
          {icon && <Ic n={icon} />}
          {title}
          {badge != null && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] text-stone-600">{badge}</span>}
        </span>
        <Ic n="chevron" className={`transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

// 人物卡归一化：AI 分析 / 旧草稿的固定字段 {identity,personality,description} 与新结构 {attrs:[{k,v}]}
// 统一成 { name, attrs:[{k,v}] }；旧字段迁移为「身份 / 性格 / 描述」三个预置键（过滤空值），旧数据不丢。
function normalizeChar(c) {
  if (!c || typeof c !== 'object') return null
  const name = typeof c.name === 'string' ? c.name.trim() : ''
  let attrs
  if (Array.isArray(c.attrs)) {
    attrs = c.attrs
      .map((a) => (a && typeof a === 'object' ? { k: String(a.k ?? ''), v: String(a.v ?? '') } : null))
      .filter((a) => a && (a.k.trim() || a.v.trim()))
  } else {
    attrs = [
      { k: '身份', v: c.identity },
      { k: '性格', v: c.personality },
      { k: '描述', v: c.description },
    ]
      .map((a) => ({ k: a.k, v: typeof a.v === 'string' ? a.v.trim() : '' }))
      .filter((a) => a.v)
  }
  if (!name && !attrs.length) return null
  return { name, attrs }
}

// 拼注入文本：每人一行「姓名：键1：值1；键2：值2」，无名无设定的空人物过滤掉。
function charsToText(chars) {
  if (!Array.isArray(chars)) return ''
  return chars
    .map((c) => {
      const name = c && typeof c.name === 'string' ? c.name.trim() : ''
      const body = (c && Array.isArray(c.attrs) ? c.attrs : [])
        .map((a) => (a && typeof a === 'object' ? { k: String(a.k ?? '').trim(), v: String(a.v ?? '').trim() } : null))
        .filter((a) => a && (a.k || a.v))
        .map((a) => `${a.k}：${a.v}`)
        .join('；')
      if (!name && !body) return ''
      return body ? `${name}：${body}` : name
    })
    .filter(Boolean)
    .join('\n')
}

// 续写页：对已有原文做分析、自定义续写与后续探索，生成结果可纳入原文或导出。
export default function ContinuePage({ apiKey, onNeedKey }) {
  const lib = useLibrary()
  const [text, setText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)
  const [world, setWorld] = useState('')
  const [characters, setCharacters] = useState([])
  const [outline, setOutline] = useState('')
  const [chronicle, setChronicle] = useState([])
  const [chronicleOpen, setChronicleOpen] = useState(false)
  const [chronicleAnalyzing, setChronicleAnalyzing] = useState(false)
  const [chronicleMsg, setChronicleMsg] = useState('')
  const [versions, setVersions] = useState([])
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState('')
  // 5.1：发送前提示词确认（人在环路）。每个 AI 调用点击后先弹窗展示将发送的 system+user，可查看/编辑，确认后才真正发送（保留 jsonMode / 各版本 temperature / ANTI_REPETITION / 并发，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, groups: [{ label, messages }], proceed, meta }
  const [showDialog, setShowDialog] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [chapterNoInput, setChapterNoInput] = useState('')
  const [chapterNameInput, setChapterNameInput] = useState('')
  // 自定义续写的章节标签：填了章号或章名时，生成结果与纳入原文都带上「第N章 章名」
  const chapterLabel = [chapterNoInput ? `第${chapterNoInput}章` : '', chapterNameInput.trim()].filter(Boolean).join(' ')
  const [summarizing, setSummarizing] = useState(false)
  // 后续版本（AI 自动探索 4 种剧情走向）
  const [followupVersions, setFollowupVersions] = useState([])
  const [followupGenerating, setFollowupGenerating] = useState(false)
  const [followupProgress, setFollowupProgress] = useState(0)
  const [newChar, setNewChar] = useState({ name: '' })
  // 原文来源：'paste'（复制粘贴 / 直接输入）| 'file'（导入文件）——决定「纳入原文」提示与导出默认格式
  const [sourceMode, setSourceMode] = useState('paste')
  const [sourceFile, setSourceFile] = useState(null) // { name, base, format }
  // 分析结果分块折叠：各块默认展开
  const [collapsed, setCollapsed] = useState({ world: false, chars: false, outline: false })
  const toggleBlock = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))
  // 导出完整原文
  const [exportFormat, setExportFormat] = useState('txt')
  const [exporting, setExporting] = useState(false)
  const [infoMsg, setInfoMsg] = useState('')
  const [draftSaveError, setDraftSaveError] = useState('')
  // 已纳入原文的版本（按钮反馈）：{ 'v0':true, 'f2':true }
  const [incorporated, setIncorporated] = useState({})
  const fileRef = useRef(null)

  // 阶段1(任务1)：续写页删除文风块——不再做文风选择/蒸馏档案。continueMessages/followupMessages/incorporateReviseMessages 已由 B 侧改为忽略文风参数、
  //   "参照原文风格"并入其 system 提示词(CONTINUE_STYLE_HINT)；原 stylePool(全量池)/effectiveStyle/skinFrom/resolveStyleRec 文风解析链一并移除。

  // ---------- 工作草稿持久化（对标新手写作：意外退出 / 刷新 / 切走再回来，原文与分析结果都还在）----------
  // 存 IndexedDB 的 drafts 库而不是 localStorage：原文可能是整本导入的小说，5MB 配额会直接抛 QuotaExceededError。
  const [hydrated, setHydrated] = useState(false) // 水合完成前不落盘，避免用空状态把上次的草稿覆盖掉
  const [analyzedSnapshot, setAnalyzedSnapshot] = useState('') // 「分析原文」当时依据的那份原文，用来判断分析结果是否已滞后
  const [showClearDialog, setShowClearDialog] = useState(false)
  // 「纳入原文」全屏弹窗：incDraft 是草稿数据（key=版本标识 v0/f2、title=版本名、text=待纳入正文、note=修改想法），
  // incOpen 只管显隐 —— 两者分开是刻意的：关闭弹窗只隐藏，草稿仍留在 IndexedDB 里，
  // 下次点同一版本的「纳入原文」原样恢复（用户手改过的字一个不丢），只有「确定并纳入」或「放弃修改稿」才清掉。
  const [incDraft, setIncDraft] = useState(null)
  const [incOpen, setIncOpen] = useState(false)
  const [incRevising, setIncRevising] = useState(false)
  const [incErr, setIncErr] = useState('')
  const draftRef = useRef(null) // pagehide 兜底 flush 用的最新快照
  const prevBookIdRef = useRef(null)
  const genAbortRef = useRef(null)
  const chronicleAbortRef = useRef(null)
  const mountedRef = useRef(true)
  const copyTimersRef = useRef([])

  // 书库选中态三分支：选中/换书 → 从草稿恢复分析/版本/指令并贴入该书原文；
  // 取消选中（再点一次已选中的书）→ 编辑区清空、草稿冻结保留，再选中时一起恢复。
  useEffect(() => {
    const book = lib.selectedBook
    const pid = prevBookIdRef.current
    prevBookIdRef.current = book ? book.id : null
    if (book && book.id !== pid) {
      loadContinueDraft().then((d) => {
        // 异步恢复期间用户又取消了选中 → 丢弃这次回填，保持空工作区
        if (prevBookIdRef.current !== book.id) return
        if (d) applyDraft(d, false)
        const content = String(book.content || '')
        if (content.trim()) setText(content)
      })
      return
    }
    if (!book && pid) clearWorkspace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.selectedBook])

  // 分析结果是否已过期：纳入原文或手改原文之后，大纲与故事线仍停在旧版本上
  const staleAnalysis = analyzed && analyzedSnapshot !== text
  const busyNow = generating || followupGenerating || summarizing || analyzing || chronicleAnalyzing || incRevising
  const hasContent = !!(
    text || world || outline || characters.length || chronicle.length || instruction || versions.length || followupVersions.length
  )

  const snapshot = () => ({
    text, sourceMode, sourceFile, exportFormat, instruction, chapterNoInput, chapterNameInput, collapsed,
    analyzed, analyzedSnapshot, world, characters, outline, chronicle,
    versions, followupVersions, incorporated,
    incDraft, incOpen,
  })

  // 把草稿填回编辑区。withText=false 时不动原文（选中书时原文以书内容为准）。
  const applyDraft = (d, withText = true) => {
    if (withText) setText(typeof d.text === 'string' ? d.text : '')
    setSourceMode(d.sourceMode === 'file' ? 'file' : 'paste')
    setSourceFile(d.sourceFile || null)
    if (d.exportFormat && EXPORT_FORMAT_IDS.includes(d.exportFormat)) setExportFormat(d.exportFormat)
    setInstruction(typeof d.instruction === 'string' ? d.instruction : '')
    setChapterNoInput(typeof d.chapterNoInput === 'string' ? d.chapterNoInput : '')
    setChapterNameInput(typeof d.chapterNameInput === 'string' ? d.chapterNameInput : '')
    // 旧草稿的 collapsed 可能带已删文风块的 style 死键——恢复时剔掉，否则「全部收起/展开」的判断失真
    if (d.collapsed && typeof d.collapsed === 'object') {
      const { style: _dropStyle, ...restCollapsed } = d.collapsed
      setCollapsed(restCollapsed)
    }
    setAnalyzed(!!d.analyzed)
    setAnalyzedSnapshot(typeof d.analyzedSnapshot === 'string' ? d.analyzedSnapshot : '')
    // 回读归一（与写侧同口径）：修复前落库的毒丸草稿（字段是对象）刷新即回灌、渲染抛错持续崩
    setWorld(typeof d.world === 'string' ? d.world : '')
    setCharacters(Array.isArray(d.characters) ? d.characters.map(normalizeChar).filter(Boolean) : [])
    setOutline(typeof d.outline === 'string' ? d.outline : '')
    setChronicle(normalizeChronicle(d.chronicle || d.timeline))
    setVersions(Array.isArray(d.versions) ? d.versions : [])
    setFollowupVersions(Array.isArray(d.followupVersions) ? d.followupVersions : [])
    setIncorporated(d.incorporated && typeof d.incorporated === 'object' ? d.incorporated : {})
    // 弹窗草稿：上次没点「确定并纳入」就退出的修改稿原样恢复，并直接把弹窗展开到用户眼前
    if (d.incDraft && typeof d.incDraft.text === 'string') {
      setIncDraft({
        key: typeof d.incDraft.key === 'string' ? d.incDraft.key : '',
        title: typeof d.incDraft.title === 'string' ? d.incDraft.title : '',
        text: d.incDraft.text,
        note: typeof d.incDraft.note === 'string' ? d.incDraft.note : '',
      })
      setIncOpen(d.incOpen !== false)
    }
    if (withText && String(d.text || '').trim()) setInfoMsg('已恢复上次的续写草稿：原文、分析结果与已生成的版本都在。')
  }

  // 取消选中：编辑区全部内容清空。草稿不动（未选中时落盘冻结），再选中书时原文与草稿一起恢复。
  const clearWorkspace = () => {
    setText('')
    setSourceMode('paste')
    setSourceFile(null)
    setAnalyzed(false)
    setAnalyzedSnapshot('')
    setWorld('')
    setCharacters([])
    setOutline('')
    setChronicle([])
    setChronicleMsg('')
    setVersions([])
    setFollowupVersions([])
    setIncorporated({})
    setInstruction('')
    setChapterNoInput('')
    setChapterNameInput('')
    setIncDraft(null)
    setIncOpen(false)
    setErr('')
  }

  // 挂载时水合：读回上次的工作草稿（best-effort，读不到就空手开始，绝不阻塞页面）
  useEffect(() => {
    let alive = true
    loadContinueDraft()
      .then((d) => {
        if (!alive || !d) return
        // 取消选中态下刷新：内容应保持空，草稿冻结保留待再选书时恢复
        if (!lib.selectedBook) return
        applyDraft(d)
      })
      .catch(() => {})
      .finally(() => { if (alive) setHydrated(true) })
    return () => { alive = false }
  }, [])

  // 防抖落盘（600ms）：流式生成时逐字 setState 不会把 IndexedDB 写爆，停手后才真正落一次
  useEffect(() => {
    if (!hydrated) return
    // 未选中书时草稿冻结：取消选中清空的内存内容不能落盘覆盖草稿，否则再选书时无从恢复
    if (!lib.selectedBook) return
    draftRef.current = snapshot()
    const t = setTimeout(() => {
      saveContinueDraft(draftRef.current).then((ok) => {
        if (mountedRef.current) setDraftSaveError(ok ? '' : '草稿未能保存到浏览器数据库（可能存储空间不足）；未落库的原文与分析结果刷新后可能丢失，请尽快到「我的」页导出备份。')
      })
    }, 600)
    return () => clearTimeout(t)
  })

  // 关标签页 / 刷新前兜底再写一次（best-effort：IndexedDB 在 pagehide 期间不保证落盘，但多数情况赶得上）
  useEffect(() => {
    const flush = () => { if (draftRef.current) saveContinueDraft(draftRef.current) }
    window.addEventListener('pagehide', flush)
    //   卸载 cleanup 里补一次 flush（读 draftRef 最新快照写盘），对齐 RevisePage / LongFormPage。
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  // 确认弹窗支持 ESC 关闭（与本页「续写设定」弹窗、以及项目里各 drawer 的交互口径一致）
  useEffect(() => {
    if (!showClearDialog) return
    const onKey = (e) => { if (e.key === 'Escape') setShowClearDialog(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showClearDialog])

  // 「纳入原文」全屏弹窗同样支持 ESC 关闭（只隐藏、不清草稿）
  useEffect(() => {
    if (!incOpen || incRevising) return
    const onKey = (e) => { if (e.key === 'Escape') setIncOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [incOpen, incRevising])

  // 失焦即落盘：用户在弹窗里改完字直接切走 / 关窗口，防抖还没触发也能保住这一笔
  useEffect(() => {
    const flush = () => { if (draftRef.current) saveContinueDraft(draftRef.current) }
    window.addEventListener('blur', flush)
    return () => window.removeEventListener('blur', flush)
  }, [])

  //   不再后台白烧额度、也不再对已卸载组件 setState。genAbortRef 在挂载时建一个整个生命周期共用的 controller。
  useEffect(() => {
    mountedRef.current = true
    genAbortRef.current = new AbortController()
    return () => {
      mountedRef.current = false
      genAbortRef.current?.abort()
      chronicleAbortRef.current?.abort()
      copyTimersRef.current.forEach((t) => clearTimeout(t))
      copyTimersRef.current = []
    }
  }, [])

  // 清除内容：原文 + 分析结果 + 续写指令 + 已生成版本全部归零，并删掉浏览器里保存的草稿
  const doClear = async () => {
    setShowClearDialog(false)
    // 只清空原文输入框并取消选中本书；分析结果、续写指令与已生成版本保留在草稿里
    // （未选中期间落盘冻结），再次点击书库里这本书即全部恢复。
    setText('')
    lib.select(null)
    setInfoMsg('已清空原文输入框。分析结果、续写指令与已生成版本都还在，点击书库里的这本书即可恢复。')
  }

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
      //   否则粘贴/已导入的旧原文被静默覆盖（600ms 后草稿也被新文覆盖、无处找回；旧文只在跑过分析时残留 analyzedSnapshot 且无恢复入口）。
      if (String(text || '').trim() && String(text) !== String(content) && !window.confirm('导入会替换当前原文（当前未另存的内容将丢失）。确定导入吗？')) return
      setText(content)
      setSourceMode('file')
      const fmt = extOf(file.name)
      setSourceFile({ name: file.name, base: baseName(file.name), format: fmt })
      if (EXPORT_FORMAT_IDS.includes(fmt)) setExportFormat(fmt) // 导出默认沿用导入格式
    } catch (ex) {
      setErr(ex?.message || '文件读取失败，请重试。')
    }
  }

  // 分析原文：严格只提取原文明确出现的信息，禁止捏造。5.1：点击先弹确认窗展示提示词，确认后走 runAnalyze。
  const analyze = () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    setErr('')
    // 第一档③修：重新分析会用 AI 结果整表覆盖 world/outline/characters（含用户手改的），这些入了草稿、无恢复入口，
    if (world || outline || characters.length || chronicle.length) {
      if (!window.confirm('重新分析会用新的 AI 结果替换当前的世界观 / 大纲 / 人物卡（包括你手动改过的内容），且无法撤销。时间事件账本不受影响，可单独重跑。确定继续吗？')) return
    }
    const truncated = text.length > ANALYZE_LIMIT
    const analyzeText = truncated ? text.slice(0, ANALYZE_LIMIT) : text
    setPromptConfirm({
      title: '分析原文',
      groups: [{ label: '分析提示词', messages: analyzeMessages({ text: analyzeText }) }],
      proceed: runAnalyze,
      meta: { truncated },
    })
  }

  const runAnalyze = async (groups, meta) => {
    setPromptConfirm(null)
    setAnalyzing(true)
    try {
      // 粘贴了原文但没选书 → 用原文自动建一本书并选中，让分析结果与后续「转长篇」有归属；建失败不阻断分析
      if (!lib.selectedBook && text.trim()) {
        try {
          const nb = await lib.createBookFromText(text)
          lib.select(nb.id)
          setInfoMsg(`已用当前原文建档《${nb.name}》并选中。`)
        } catch (e) {
          setErr((e && e.message) || '用原文建档失败；分析仍继续，但结果不会关联到书库里的书。')
        }
      }
      const res = await chatJSON({ apiKey, messages: groups[0].messages, temperature: 0.3, signal: genAbortRef.current?.signal })
      if (!mountedRef.current) return
      //   直接渲染(世界观/大纲/故事线 CollapseBlock)会抛「Objects are not valid as React child」，且随 continue 草稿落 IDB → 刷新持续崩。
      //   字符串字段用 typeof 守卫（对象归空、不显 [object Object]）；characters 已由 normalizeChar 归一（name/attrs 全 String），无需再处理。
      setWorld(typeof res.world_setting === 'string' ? res.world_setting : '')
      setCharacters(Array.isArray(res.characters) ? res.characters.map(normalizeChar).filter(Boolean) : [])
      setOutline(typeof res.outline === 'string' ? res.outline : '')
      setAnalyzed(true)
      setAnalyzedSnapshot(text) // 记住这份分析依据的原文；此后原文再变（纳入续写 / 手动编辑）就能判出分析已滞后
      if (meta.truncated) {
        setErr(`原文较长，已分析前 ${ANALYZE_LIMIT} 字。如需完整分析请拆分原文后重试。`)
      }
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') return
      setErr(e?.message || String(e))
    } finally {
      if (mountedRef.current) setAnalyzing(false)
    }
  }

  // 时间事件账本：原文按每 CHRONICLE_CHUNK 字一段逐段发给 AI，段序拼接 + 跨段去重，保证长原文的时间与事件不遗漏。
  // 时间只记原文明写的（提示词纪律如此），AI 推断的一律不要。分段请求可中断，卸载时统一 abort。
  const runChronicle = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    const chunks = chunkText(text)
    setChronicleAnalyzing(true)
    setChronicleMsg('')
    const ctrl = new AbortController()
    chronicleAbortRef.current = ctrl
    const segments = []
    try {
      for (let i = 0; i < chunks.length; i++) {
        setChronicleMsg(`时间事件账本分析中… 第 ${i + 1}/${chunks.length} 段（每段约 ${CHRONICLE_CHUNK} 字）`)
        const res = await chatJSON({ apiKey, messages: chronicleMessages({ text: chunks[i] }), temperature: 0.2, signal: ctrl.signal })
        if (!mountedRef.current) return
        segments.push(Array.isArray(res && res.entries) ? res.entries : [])
      }
      const merged = mergeChronicle(segments)
      setChronicle(merged)
      setChronicleMsg(`时间事件账本完成：共 ${merged.length} 条记录`)
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') {
        if (segments.length) {
          const merged = mergeChronicle(segments)
          setChronicle(merged)
          setChronicleMsg(`已停止：保留前 ${segments.length} 段的 ${merged.length} 条记录`)
        } else {
          setChronicleMsg('已停止时间事件账本分析')
        }
        return
      }
      setChronicleMsg('账本分析失败：' + (e?.message || String(e)))
    } finally {
      chronicleAbortRef.current = null
      if (mountedRef.current) setChronicleAnalyzing(false)
    }
  }

  // 外部入口：先确认（段数与额度、已有记录会被替换），确认后才开始分析并打开账本弹窗看进度与结果
  const startChronicle = () => {
    if (countWords(text) < 50) {
      setErr('请先粘贴或导入至少几十字的原文。')
      return
    }
    const chunks = chunkText(text)
    const warn = chronicle.length ? `重新分析会替换当前 ${chronicle.length} 条时间事件记录。` : ''
    if (!window.confirm(`${warn}原文 ${countWords(text)} 字，将分 ${chunks.length} 段调用 AI 记录时间与事件（约 ${chunks.length} 次请求）。确定开始吗？`)) return
    setChronicleOpen(true)
    runChronicle()
  }

  // 续写：4 个方向各自独立流式生成，并发 2，从结构上保证内容不雷同。
  // 5.1：点击先（仅原文超长时）跑前文摘要，再弹确认窗展示 4 个方向将发送的提示词，确认后走 runGenerate 并发。
  // 摘要属"前文压缩"预处理、为构造准确的续写提示词必须先跑，故不单独弹窗；4 个主生成提示词都在确认窗里可查看/编辑。
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
    // 原文过长时：先给前文做 AI 摘要，再拼上尾部原文（紧接续写处）
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(Math.max(0, text.length - TAIL_LENGTH - 60000), text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3, signal: genAbortRef.current?.signal })
        summary = sumRes.summary || ''
      } catch {
        // 摘要失败不阻塞续写，降级为仅尾部截断（卸载中断也走这里，下面 mounted 守卫会拦掉后续 setState）
        summary = ''
      } finally {
        if (mountedRef.current) setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    if (!mountedRef.current) return
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '自定义续写（4 个方向并发）',
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 个方向的续写提示词，可查看 / 编辑。' : '',
      groups: CONTINUE_ANGLES.map((a, i) => ({
        label: `版本${i + 1}（${a.title}）`,
        messages: continueMessages({ text: tail, summary, world, characters: charText, outline, chronicle: pickChronicleForPrompt(chronicle), instruction, index: i, forbidden: lib.style?.forbidden }),
      })),
      proceed: runGenerate,
    })
  }

  const runGenerate = async (groups) => {
    setPromptConfirm(null)
    setGenerating(true)
    setVersions([])
    setProgress(0)
    resetIncorporated('v')
    // 两类生成结果互斥显示：开新一类即清掉另一类及其纳入标记，避免同屏堆 8 张卡
    setFollowupVersions([])
    resetIncorporated('f')
    try {
      await mapLimit(
        groups.map((g, i) => ({ g, a: CONTINUE_ANGLES[i], i })),
        2,
        async ({ g, a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              ...ANTI_REPETITION,
              messages: g.messages,
              temperature: a.temp,
              signal: genAbortRef.current?.signal,
              onDelta: (full) => {
                if (!mountedRef.current) return
                setVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full, chapterLabel }
                  return next
                })
              },
            })
            if (!mountedRef.current) return
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content, chapterLabel }
              return next
            })
          } catch (e) {
            if (!mountedRef.current || e?.name === 'AbortError') return // 卸载中断：不写错误版本、不上屏
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e?.message || String(e), chapterLabel }
              return next
            })
          } finally {
            if (mountedRef.current) setProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') return
      setErr(e?.message || String(e))
    } finally {
      if (mountedRef.current) setGenerating(false)
    }
  }

  // 后续版本：AI 自动探索 4 种不同剧情走向（区别于自定义续写：不需要用户指令，在剧情走向上本质不同）。
  // 5.1：点击先（仅原文超长时）跑摘要，再弹确认窗展示 4 个走向提示词，确认后走 runGenerateFollowup 并发。
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
    // 同样支持前文摘要 + 尾部全文
    let summary = ''
    let tail = text
    if (text.length > SUMMARIZE_THRESHOLD) {
      setSummarizing(true)
      const headText = text.slice(Math.max(0, text.length - TAIL_LENGTH - 60000), text.length - TAIL_LENGTH)
      try {
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3, signal: genAbortRef.current?.signal })
        summary = sumRes.summary || ''
      } catch {
        summary = ''
      } finally {
        if (mountedRef.current) setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    if (!mountedRef.current) return
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '探索后续（4 种剧情走向并发）',
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 种走向的提示词，可查看 / 编辑。' : '',
      groups: FOLLOWUP_ANGLES.map((a, i) => ({
        label: `走向${i + 1}（${a.title}）`,
        messages: followupMessages({ text: tail, summary, world, characters: charText, outline, chronicle: pickChronicleForPrompt(chronicle), index: i, forbidden: lib.style?.forbidden }),
      })),
      proceed: runGenerateFollowup,
    })
  }

  const runGenerateFollowup = async (groups) => {
    setPromptConfirm(null)
    setFollowupGenerating(true)
    setFollowupVersions([])
    setFollowupProgress(0)
    resetIncorporated('f')
    // 两类生成结果互斥显示：开新一类即清掉另一类及其纳入标记，避免同屏堆 8 张卡
    setVersions([])
    resetIncorporated('v')
    try {
      await mapLimit(
        groups.map((g, i) => ({ g, a: FOLLOWUP_ANGLES[i], i })),
        2,
        async ({ g, a, i }) => {
          try {
            const content = await chatStream({
              apiKey,
              ...ANTI_REPETITION,
              messages: g.messages,
              temperature: a.temp,
              signal: genAbortRef.current?.signal,
              onDelta: (full) => {
                if (!mountedRef.current) return
                setFollowupVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            if (!mountedRef.current) return
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            if (!mountedRef.current || e?.name === 'AbortError') return
            setFollowupVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e?.message || String(e) }
              return next
            })
          } finally {
            if (mountedRef.current) setFollowupProgress((p) => p + 1)
          }
        },
      )
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') return
      setErr(e?.message || String(e))
    } finally {
      if (mountedRef.current) setFollowupGenerating(false)
    }
  }

  // 人物卡增删改：姓名 + 自定义键值对（attrs）。每次 setCharacters 触发既有防抖落盘，编辑即持久化。
  const addChar = () => {
    if (!newChar.name.trim()) return
    setCharacters([...characters, { name: newChar.name.trim(), attrs: [] }])
    setNewChar({ name: '' })
  }
  const removeChar = (idx) => setCharacters(characters.filter((_, i) => i !== idx))
  const updateCharName = (idx, name) => setCharacters(characters.map((c, i) => (i === idx ? { ...c, name } : c)))
  const addAttr = (idx) =>
    setCharacters(characters.map((c, i) => (i === idx ? { ...c, attrs: [...(c.attrs || []), { k: '', v: '' }] } : c)))
  const removeAttr = (idx, ai) =>
    setCharacters(characters.map((c, i) => (i === idx ? { ...c, attrs: (c.attrs || []).filter((_, j) => j !== ai) } : c)))
  const updateAttr = (idx, ai, patch) =>
    setCharacters(
      characters.map((c, i) =>
        i === idx ? { ...c, attrs: (c.attrs || []).map((a, j) => (j === ai ? { ...a, ...patch } : a)) } : c,
      ),
    )


  const copy = async (t, btn) => {
    //   且裸 setTimeout 改 btn.textContent、卸载不清。对齐 RevisePage：按 ok 显示 + 定时器入 ref 集合、卸载统一清。
    const ok = await copyText(t)
    if (btn) {
      btn.textContent = ok ? '已复制 ✓' : '复制失败✗'
      const tid = setTimeout(() => {
        btn.textContent = '复制'
        copyTimersRef.current = copyTimersRef.current.filter((x) => x !== tid)
      }, 1500)
      copyTimersRef.current.push(tid)
    }
  }

  // 阶段1(任务1)：原 skinFrom / effectiveStyle（文风「皮」三级择一 + resolveStyleRec 混合池）已随文风块整体删除——续写不再解析/注入文风档案，
  //   continueMessages/followupMessages/incorporateReviseMessages 由 B 侧忽略文风参数、"参照原文风格"已并入其 system 提示词。

  // 重新生成时清除对应类型的「已纳入」标记（v=自定义续写，f=探索后续），避免旧标记落到新内容上
  const resetIncorporated = (prefix) =>
    setIncorporated((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(prefix))))

  // 点「纳入原文」不再直接追加，而是先开全屏弹窗让用户过一遍：可直接手改，也可写下想法让模型定向改写，
  // 点「确定并纳入原文」才真正追加到文末。（续写起点由 prompts.js 侧保证以原文结尾为准，不需先重跑「分析原文」。）
  const openIncorporate = (content, key, title, chapterLabel) => {
    if (!content) return
    setIncErr('')
    // 同一版本沿用已存草稿（用户的修改不丢）；换版本则以该版本正文重新起稿，带章节标签时正文前加章节标题行
    setIncDraft((prev) => (prev && prev.key === key ? prev : { key, title: title || '', text: chapterLabel ? `${chapterLabel}\n\n${content}` : content, note: '' }))
    setIncOpen(true)
  }

  // 发送给模型：按用户的想法就地改写弹窗里的正文，只动该动的地方。5.1：先弹确认窗展示改写提示词，确认后走 runReviseIncorporate。
  const reviseIncorporate = () => {
    if (!incDraft) return
    const note = (incDraft.note || '').trim()
    if (!note) {
      setIncErr('先写下你的修改想法，再发送给模型。')
      return
    }
    if (!apiKey) {
      onNeedKey()
      setIncErr('需要先配置 API Key，模型才能动手修改。')
      return
    }
    setIncErr('')
    const before = incDraft.text
    setPromptConfirm({
      title: '按你的想法改写这段',
      groups: [{ label: '改写提示词', messages: incorporateReviseMessages({ context: text.replace(/\s+$/, '').slice(-1200), text: before, note, forbidden: lib.style?.forbidden }) }],
      proceed: runReviseIncorporate,
      meta: { before },
    })
  }

  const runReviseIncorporate = async (groups, meta) => {
    setPromptConfirm(null)
    setIncRevising(true)
    const before = meta.before
    try {
      await chatStream({
        apiKey,
        ...ANTI_REPETITION,
        // 上文语境只取原文结尾一小段：够模型对齐人称/视角/称谓即可，全文进去只会稀释「只改指到的地方」这条约束
        messages: groups[0].messages,
        temperature: 0.4,
        signal: genAbortRef.current?.signal,
        onDelta: (full) => {
          if (mountedRef.current) setIncDraft((p) => (p ? { ...p, text: full } : p))
        },
      })
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') return // 卸载中断：不回滚、不上屏
      setIncDraft((p) => (p ? { ...p, text: before } : p)) // 失败回滚，不留半截稿
      setIncErr(`模型修改失败：${e?.message || e}`)
    } finally {
      if (mountedRef.current) setIncRevising(false)
    }
  }

  // 确定并纳入原文：把弹窗里的正文（模型改过的 / 用户手改过的 / 原样的）追加到原文文末
  const commitIncorporate = () => {
    if (!incDraft) return
    const body = (incDraft.text || '').trim()
    if (!body) {
      setIncErr('正文是空的，没什么可纳入的。')
      return
    }
    const key = incDraft.key
    setText((prev) => (prev ? prev.replace(/\s+$/, '') + '\n\n' + body : body))
    if (key) setIncorporated((m) => ({ ...m, [key]: true }))
    setIncDraft(null)
    setIncOpen(false)
    setIncErr('')
    setInfoMsg(
      sourceMode === 'file'
        ? '已把这段纳入原文（追加到文末）。可以直接继续「自定义续写」或「探索后续版本」，会以纳入后的原文结尾为起点；也可点「导出完整原文」保存更新后的文件。'
        : '已把这段纳入原文（追加到文末）。可以直接继续「自定义续写」或「探索后续版本」，会以纳入后的原文结尾为起点。',
    )
  }

  // 放弃这份修改稿：只丢弹窗里的编辑，原版本正文还在下面的卡片里，随时可以重新起稿
  const discardIncorporate = () => {
    setIncDraft(null)
    setIncOpen(false)
    setIncErr('')
    setInfoMsg('已放弃这份未纳入的修改稿（原版本正文仍在下方卡片里）。')
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
        <div className="space-y-4">
          <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} showStyle={false} />

        </div>

        <div className="min-w-0 space-y-4">
          {/* 原文输入 */}
          <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
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
                <button
                  onClick={() => setShowClearDialog(true)}
                  disabled={!hasContent || busyNow}
                  title="清除原文与本页全部分析结果（会先弹窗确认）"
                  className="min-h-[40px] rounded-full border border-stone-300 px-4 py-2 text-xs font-medium text-stone-500 hover:border-red-200 hover:bg-red-50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-stone-300 disabled:hover:bg-transparent disabled:hover:text-stone-500"
                >
                  <Ic n="ban" /> 清除内容
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
                {analyzing ? 'AI 分析中…' : <><Ic n="search" /> 分析原文</>}
              </button>
              <button
                onClick={startChronicle}
                disabled={!text.trim()}
                className="min-h-[44px] rounded-full border border-white/40 bg-white/15 px-5 py-3 text-sm font-medium text-white hover:bg-white/25 disabled:opacity-50"
              >
                <Ic n="hourglass" /> 时间事件账本（{chronicle.length}）
              </button>
              {staleAnalysis && (
                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
                  <Ic n="alert" /> 原文已变，下面的分析结果停在旧版本——续写会自动以原文结尾为准，不需先重跑分析；想刷新大纲/故事线可再点一次「分析原文」
                </span>
              )}
              <span className="text-xs text-stone-400">结果可编辑、可分块收起</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
            {draftSaveError && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{draftSaveError}</p>}
            {infoMsg && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{infoMsg}</p>}
          </section>

          {/* 分析结果（可编辑 · 分块折叠） */}
          {analyzed && (
            <section className="glass-card space-y-3 rounded-2xl bg-paper p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold"><Ic n="clipboard" /> 原文分析结果（可编辑 · 点标题可收起）</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const anyOpen = Object.values(collapsed).some((v) => !v)
                      setCollapsed({ world: anyOpen, chars: anyOpen, outline: anyOpen })
                    }}
                    className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    {Object.values(collapsed).some((v) => !v) ? '全部收起' : '全部展开'}
                  </button>
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
                        <div key={i} className="relative rounded-xl border border-stone-200 bg-paper p-3">
                          <button
                            onClick={() => removeChar(i)}
                            className="absolute right-2 top-2 z-10 rounded-full px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                          >
                            <Ic n="x" />
                          </button>
                          <input
                            value={c.name || ''}
                            onChange={(e) => updateCharName(i, e.target.value)}
                            placeholder="姓名"
                            className="w-full rounded-lg border border-stone-200 px-2 py-1 pr-7 text-sm font-bold text-ink focus:border-stone-500 focus:outline-none"
                          />
                          <div className="mt-2 space-y-1.5">
                            {(c.attrs || []).map((a, ai) => (
                              <div key={ai} className="flex items-center gap-1.5">
                                <input
                                  value={a.k || ''}
                                  onChange={(e) => updateAttr(i, ai, { k: e.target.value })}
                                  placeholder="设定项"
                                  className="w-20 shrink-0 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                />
                                <input
                                  value={a.v || ''}
                                  onChange={(e) => updateAttr(i, ai, { v: e.target.value })}
                                  placeholder="内容"
                                  className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-xs focus:border-stone-500 focus:outline-none"
                                />
                                <button
                                  onClick={() => removeAttr(i, ai)}
                                  className="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-50"
                                >
                                  <Ic n="x" />
                                </button>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={() => addAttr(i)}
                            className="mt-2 rounded-full border border-stone-300 px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-50"
                          >
                            + 添加设定
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 手动添加人物：先填姓名加入，再在卡片上自由补设定键值 */}
                  <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="mb-2 text-xs font-semibold text-stone-500">手动添加人物</p>
                    <div className="flex gap-2">
                      <input
                        value={newChar.name}
                        onChange={(e) => setNewChar({ name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addChar()
                          }
                        }}
                        placeholder="姓名*"
                        className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
                      />
                      <button
                        onClick={addChar}
                        disabled={!newChar.name.trim()}
                        className="shrink-0 rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                      >
                        + 添加
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-stone-400">添加后可在卡片上自由增删设定键值（如 真实身份 = 皇子），完全自定义。</p>
                  </div>
                  {/* 注入透明：实时显示本次续写将发给模型的人物卡上下文 */}
                  <details className="mt-2 rounded-xl border border-stone-200 bg-paper/60 p-2">
                    <summary className="cursor-pointer text-xs font-semibold text-stone-500">查看本次续写将注入的人物卡上下文</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-stone-50 p-2 text-[11px] leading-relaxed text-stone-600">{charsToText(characters) || '（暂无人物卡内容）'}</pre>
                  </details>
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

            </section>
          )}


          {/* 续写按钮区 */}
          <section className="glass-card rounded-2xl bg-paper p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold"><Ic n="pen" /> 续写</h2>
              <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">续写会参照原文结尾的风格与语境（不再单独分析文风）</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">两个按钮任选：「自定义续写」由你在对话框中指定方向，生成 4 种叙述方式的版本；「探索后续版本」由 AI 自动探索 4 种不同剧情走向（顺势发展 / 意外变故 / 人物抉择 / 伏笔回收）。每个版本独立请求 + 不同 system prompt + 不同温度，结构上保证不雷同。</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowDialog(true)}
                disabled={generating || summarizing || followupGenerating}
                className="min-h-[44px] rounded-full bg-stone-800 px-6 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {summarizing ? '正在摘要前文…' : generating ? `AI 续写中… ${progress}/4` : <><Ic n="pen" /> 自定义续写</>}
              </button>
              <button
                onClick={generateFollowup}
                disabled={followupGenerating || summarizing || generating}
                className="min-h-[44px] rounded-full border-2 border-stone-800 bg-transparent px-6 py-3 text-sm font-medium text-ink hover:bg-stone-100 disabled:opacity-50"
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
                //   非生成态下跳过空洞，避免渲染出只有标题的「空白卡」。保留下标不压缩，incorporated 的 v${i} 对齐不错位。
                if (!v && !generating) return null
                return (
                  <article key={i} className="glass-card flex flex-col rounded-2xl bg-paper shadow-sm">
                    <header className="flex items-center justify-between rounded-t-2xl border-b border-stone-100 px-4 py-3">
                      <h3 className="text-sm font-bold">{v.chapterLabel ? `${v.chapterLabel} · ${a.title}` : a.title}</h3>
                      {v?.content && !v.error && (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => copy(v.content, e.target)}
                            className="min-h-[32px] rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                          >
                            复制
                          </button>
                          <button
                            onClick={() => openIncorporate(v.content, `v${i}`, v.title, v.chapterLabel)}
                            className={`min-h-[32px] rounded-full px-3 py-1 text-xs ${incorporated[`v${i}`] ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}
                          >
                            {incorporated[`v${i}`] ? '已纳入原文 ✓' : '纳入原文'}
                          </button>
                        </div>
                      )}
                    </header>
                    {v?.error ? (
                      <div className="p-4 text-sm text-red-400">生成失败：{v.error}</div>
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
                  if (!v && !followupGenerating) return null
                  return (
                    <article key={i} className="glass-card flex flex-col rounded-2xl bg-paper shadow-sm">
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
                              onClick={() => openIncorporate(v.content, `f${i}`, v.title)}
                              className={`min-h-[32px] rounded-full px-3 py-1 text-xs ${incorporated[`f${i}`] ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}
                            >
                              {incorporated[`f${i}`] ? '已纳入原文 ✓' : '纳入原文'}
                            </button>
                          </div>
                        )}
                      </header>
                      {v?.error ? (
                        <div className="p-4 text-sm text-red-400">生成失败：{v.error}</div>
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
          className="glass-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !generating && setShowDialog(false)}
          role="dialog"
          aria-modal="true"
          aria-label="续写设定"
        >
          <div
            className="glass-modal w-full max-w-lg rounded-2xl bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold"><Ic n="pen" /> 续写设定</h3>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-stone-500" htmlFor="ch-no">章号（可选）</label>
                <input
                  id="ch-no"
                  value={chapterNoInput}
                  onChange={(e) => setChapterNoInput(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="例：13"
                  className="w-24 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-xs text-stone-500" htmlFor="ch-name">章名（可选）</label>
                <input
                  id="ch-name"
                  value={chapterNameInput}
                  onChange={(e) => setChapterNameInput(e.target.value)}
                  placeholder="例：城门下的旧识"
                  className="w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                />
              </div>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              填了章号或章名，生成结果与纳入原文都会带上「第N章 章名」标题；不填则只按方向生成。
            </p>
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
                disabled={generating || wordCount < 50}
                className="min-h-[40px] rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                <Ic n="rocket" /> 开始续写
              </button>
            </div>
            {wordCount < 50 && (
              <p className="mt-2 text-right text-xs text-red-500">请先粘贴或导入至少几十字的原文</p>
            )}
          </div>
        </div>
      )}

      {/* 「纳入原文」全屏弹窗：上半是待纳入正文（可直接手改），下半是修改想法（发给模型做定向改写）。
          弹窗草稿随页面草稿一起存 IndexedDB：改一个字就意外退出，回来还在，并自动重新展开。 */}
      {incOpen && incDraft && (
        <div className="glass-modal-full fixed inset-0 z-50 flex flex-col bg-paper" role="dialog" aria-modal="true" aria-label="纳入原文">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-ink">
                <Ic n="import" /> 纳入原文{incDraft.title ? `：${incDraft.title}` : ''}
              </h2>
              <p className="mt-0.5 truncate text-xs text-stone-500">
                这段会追加到原文文末 · 当前 {countWords(incDraft.text)} 字 · 可以直接改，也可以写下想法让模型改
              </p>
            </div>
            <button
              onClick={() => setIncOpen(false)}
              title="关闭（修改稿留在浏览器里，下次点「纳入原文」还在）"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-200 text-stone-500 hover:bg-stone-50 hover:text-ink"
            >
              <Ic n="x" />
            </button>
          </header>

          {text.trim() && (
            <div className="shrink-0 border-b border-stone-100 bg-stone-50 px-5 py-2 text-xs leading-relaxed text-stone-500">
              <span className="font-medium text-stone-600">接在原文末尾之后：</span>
              …{text.replace(/\s+$/, '').slice(-120)}
            </div>
          )}

          <textarea
            value={incDraft.text}
            onChange={(e) => setIncDraft({ ...incDraft, text: e.target.value })}
            disabled={incRevising}
            spellCheck={false}
            placeholder="待纳入的正文"
            className="glass-input novel-text min-h-0 w-full flex-1 resize-none border-0 bg-paper px-5 py-4 text-base focus:outline-none disabled:opacity-60"
          />

          <div className="shrink-0 border-t border-stone-200 px-5 py-3">
            <label className="text-xs font-medium text-stone-600">你的修改想法</label>
            <div className="mt-1.5 flex items-start gap-2">
              <textarea
                value={incDraft.note}
                onChange={(e) => setIncDraft({ ...incDraft, note: e.target.value })}
                disabled={incRevising}
                rows={2}
                placeholder="例如：结尾那句对话改冷淡一点 / 删掉雨景描写 / 让主角先犹豫再动手"
                className="min-h-[56px] flex-1 resize-y rounded-xl border border-stone-200 bg-paper p-3 text-sm focus:border-stone-500 focus:outline-none disabled:opacity-60"
              />
              <button
                onClick={reviseIncorporate}
                disabled={incRevising || !incDraft.note.trim()}
                className="min-h-[40px] shrink-0 rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Ic n={incRevising ? 'rolling' : 'wand'} /> {incRevising ? '模型修改中…' : '发送给模型修改'}
              </button>
            </div>
            {incErr && <p className="mt-2 text-xs text-red-400">{incErr}</p>}
            <p className="mt-2 text-xs text-stone-400">
              模型只改你指到的地方，其余原样保留；改完仍可继续手改或再发一次想法。关闭弹窗不会丢稿。
            </p>
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-stone-200 px-5 py-3">
            <button
              onClick={discardIncorporate}
              disabled={incRevising}
              className="min-h-[40px] rounded-full px-4 py-2 text-xs text-stone-400 hover:text-red-400 disabled:opacity-40"
            >
              <Ic n="undo" /> 放弃这份修改稿
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIncOpen(false)}
                className="min-h-[40px] rounded-full border border-stone-300 px-5 py-2 text-sm text-stone-600 hover:bg-stone-50"
              >
                先不纳入
              </button>
              <button
                onClick={commitIncorporate}
                disabled={incRevising || !incDraft.text.trim()}
                className="min-h-[40px] rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Ic n="check" /> 确定并纳入原文
              </button>
            </div>
          </footer>
        </div>
      )}

      {/* 清除内容确认弹窗：破坏性操作必须二次确认，支持点遮罩 / ESC 关闭 */}
      {showClearDialog && (
        <div
          className="glass-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowClearDialog(false)}
          role="dialog"
          aria-modal="true"
          aria-label="清除内容确认"
        >
          <div className="glass-modal w-full max-w-md rounded-2xl bg-paper p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold"><Ic n="ban" /> 清除内容</h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              只清空原文输入框（{wordCount} 字）并取消选中本书。分析结果、续写指令与已生成的续写版本都保留在草稿里。
            </p>
            <p className="mt-2 text-xs leading-relaxed text-stone-400">
              想找回原文：点书库里这本书即可连原文带分析结果、版本一起恢复。想彻底删掉浏览器里的草稿：到「我的」页清空数据。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowClearDialog(false)}
                className="min-h-[40px] rounded-full border border-stone-300 px-5 py-2 text-sm text-stone-600 hover:bg-stone-50"
              >
                取消
              </button>
              <button
                onClick={doClear}
                className="min-h-[40px] rounded-full bg-red-600 px-5 py-2 text-sm font-medium text-onaccent hover:bg-red-700"
              >
                <Ic n="ban" /> 确认清除
              </button>
            </div>
          </div>
        </div>
      )}


      {promptConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
          onClick={() => { if (!promptConfirm.edited) setPromptConfirm(null) }}
          role="dialog"
          aria-modal="true"
          aria-label={promptConfirm.title}
        >
          <div className="flex max-h-[88vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词{promptConfirm.edited ? '（已编辑）' : ''}</span>
              <button onClick={() => setPromptConfirm(null)} className="text-stone-400 hover:text-stone-700" aria-label="关闭">✕</button>
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {promptConfirm.note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">{promptConfirm.note}</p>}
              {promptConfirm.groups.map((g, gi) => (
                <div key={gi} className="space-y-2">
                  {promptConfirm.groups.length > 1 && <div className="text-xs font-bold text-stone-700">{g.label}</div>}
                  {g.messages.map((m, mi) => (
                    <div key={mi}>
                      <div className="mb-1 text-[11px] font-medium text-stone-500">{m.role === 'system' ? 'System（角色与规则）' : 'User（本次发送内容）'}</div>
                      <textarea
                        value={m.content}
                        rows={m.role === 'system' ? 5 : 9}
                        onChange={(e) =>
                          setPromptConfirm((p) => {
                            const groups = p.groups.slice()
                            const msgs = groups[gi].messages.slice()
                            msgs[mi] = { ...msgs[mi], content: e.target.value }
                            groups[gi] = { ...groups[gi], messages: msgs }
                            return { ...p, groups, edited: true }
                          })
                        }
                        className="w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-[13px] leading-relaxed focus:border-stone-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <button onClick={() => setPromptConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">取消</button>
              <button onClick={() => promptConfirm.proceed(promptConfirm.groups, promptConfirm.meta)} className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700">确认并发送</button>
            </div>
          </div>
        </div>
      )}

      {/* 时间事件账本弹窗：固定尺寸，内容区原生滚动条上下滑动 */}
      {chronicleOpen && (
        <div className="glass-scrim fixed inset-0 z-[57] flex items-center justify-center p-4" onClick={() => setChronicleOpen(false)} role="dialog" aria-modal="true" aria-label="时间事件账本">
          <div className="glass-modal flex max-h-[80vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/25 px-5 py-3">
              <span className="font-semibold text-ink"><Ic n="hourglass" /> 时间事件账本（{chronicle.length} 条 · 只记原文明写的时间）</span>
              <button onClick={() => setChronicleOpen(false)} className="text-stone-400 hover:text-white" aria-label="关闭">×</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-white/15 px-5 py-2.5">
              <button onClick={startChronicle} disabled={chronicleAnalyzing || !text.trim()} className="rounded-lg bg-red-700 px-3 py-1.5 text-xs text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40">
                {chronicleAnalyzing ? '分析中…' : chronicle.length ? '重新分析账本' : '分析时间事件账本'}
              </button>
              {chronicleAnalyzing && (
                <button onClick={() => chronicleAbortRef.current?.abort()} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100">停止</button>
              )}
              {chronicleMsg && <span className="text-xs text-stone-500">{chronicleMsg}</span>}
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="rounded-xl border border-white/25 bg-white/5 p-4">
              {chronicle.length > 0 ? (
                <div className="relative pl-6">
                  <div className="absolute left-[7px] top-1 bottom-1 w-0.5 bg-stone-300"></div>
                  {chronicle.map((t, i) => (
                    <div key={i} className="relative mb-3 last:mb-0">
                      <div className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-500 shadow"></div>
                      <span className="mb-1 flex flex-wrap items-center gap-1.5">
                        {t.chapter && (
                          <span className="inline-block rounded bg-white/20 px-1.5 py-0.5 text-[11px] font-medium text-white">第{t.chapter}章</span>
                        )}
                        {t.time ? (
                          <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{t.time}</span>
                        ) : (
                          <span className="inline-block rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-400">未标时间</span>
                        )}
                      </span>
                      <p className="mt-0.5 text-sm leading-relaxed text-stone-600">{t.event}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-stone-400">还没有账本记录。点「分析时间事件账本」，按每 {CHRONICLE_CHUNK} 字一段扫全文，把明写的时间与事件逐条记下来。</p>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
