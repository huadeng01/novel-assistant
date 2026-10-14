import { useCallback, useEffect, useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import KeyBanner from '../components/KeyBanner.jsx'
import Library from '../components/Library.jsx'
import DiagnosePanel from '../components/DiagnosePanel.jsx'
import AssetModal from '../components/AssetModal.jsx'
import EditAssetModal from '../components/EditAssetModal.jsx'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
// 阶段1(设计 §6.2 / §7 1.3③④)：侧栏挂 AssetFilterBar(分类按钮，点了直接开弹窗并预选) + NewAssetModal(手动建档)
import AssetFilterBar from '../components/AssetFilterBar.jsx'
import NewAssetModal from '../components/NewAssetModal.jsx'
// buildLinks 不再直接用：useAssets.addAsset 内部只对「新条目」跑共现建边(不整表重建，避免覆盖用户手改的边，设计 §4.2)
import { parseAnalyze, computeAssetWarnings } from '../lib/parseAssets.js'
import { normalizeAsset, normalizeState, perVolOf, ASSET_TYPES, ASSET_TYPE_LABEL, STATE_V1_MAP, STATE_LABEL, stateLabel, dashOut, dashOnly, applyStateChange, typeKeyOf } from '../lib/assets.js'
import { useLibrary } from '../hooks/useLibrary.js'
// 阶段1(设计 §7 1.3②)：资产 CRUD / links / 落库统一走 useAssets(提交式落库，缓解 M29 频繁写盘)
import { useAssets } from '../hooks/useAssets.js'
import { chatJSON, chatStream, ANTI_REPETITION } from '../lib/llm.js'
// analyzeAssetsMessages：两页共用的「分析原文 → 资产」提示词(五段产出，含【状态变更】【资产流转】【伏笔推进】)，取代原页内 continueAssetPrompt
import { analyzeMessages, continueMessages, CONTINUE_ANGLES, followupMessages, FOLLOWUP_ANGLES, summarizeMessages, incorporateReviseMessages, analyzeAssetsMessages } from '../lib/prompts.js'
import { copyText, countWords, mapLimit, uid } from '../lib/utils.js'
// put 不再直接用：资产落库由 useAssets 内部完成（阶段1 接线后本页没有别的直写 books 的路径）
import { loadContinueDraft, saveContinueDraft, clearContinueDraft } from '../lib/backup.js'
import { readDocumentFile, baseName, extOf, exportDocument, EXPORT_FORMATS, READ_ACCEPT } from '../lib/docio.js'

// 原文过长时：先给前文做摘要，再拼上尾部原文发给续写
const SUMMARIZE_THRESHOLD = 8000 // 超过这个字数才做前文摘要
const TAIL_LENGTH = 4000 // 尾部原文保留字数（紧接续写处）
const ANALYZE_LIMIT = 60000 // 分析原文的最大截取字数，防止超出上下文窗口
// 阶段1(设计 §7 1.3 / 需求2)：资产分析改「分段全量」——从头到尾每段 ASSET_CHUNK 字、不足一段取完，逐段发给 AI 后合并解析。
// 原实现只取前 20000 字(后半本书的资产永远提不出来)，且提示词是页内私有的一份(与长篇页不同源)。
const ASSET_CHUNK = 15000
const EXPORT_FORMAT_IDS = EXPORT_FORMATS.map((f) => f.id)

// —— 分段分析（阶段1 · 需求2）：把原文从头到尾按 ASSET_CHUNK 切段，不足一段取完 ——
const chunkSource = (src) => {
  const s = String(src || '')
  if (!s) return []
  const out = []
  for (let i = 0; i < s.length; i += ASSET_CHUNK) out.push(s.slice(i, i + ASSET_CHUNK))
  return out
}

// 用户在提示词弹窗里改过 user 段后，第 2..N 段要沿用「改过的提示词」只换原文：
// 按 analyzeAssetsMessages 的锚点「【本章原文】」定位，替换其后到「请对照名册…」之间的原文，尾注保留。
// 锚点被用户删掉时降级为在末尾追加一段带锚点的原文（不把整段提示词丢掉）。
const SOURCE_ANCHOR = '【本章原文】'
const swapSource = (userText, chunk) => {
  const t = String(userText || '')
  const i = t.indexOf(SOURCE_ANCHOR)
  if (i < 0) return `${t}\n\n${SOURCE_ANCHOR}\n${chunk}`
  const head = t.slice(0, i + SOURCE_ANCHOR.length)
  const rest = t.slice(i + SOURCE_ANCHOR.length)
  const j = rest.lastIndexOf('请对照名册')
  const tail = j >= 0 ? `\n\n${rest.slice(j)}` : ''
  return `${head}\n${chunk}${tail}`
}

// A11(去重)：TYPE_BY_LABEL / typeKeyOf / tagForWord / applyStateChange 已由 B 抽到 assets.js 作单一出处，本页改 import 复用（原 62-106 的本地定义删除，避免与长篇页两份实现漂移）。

// 分析结果的分块折叠容器：点标题栏展开/收起，chevron 旋转指示状态
function CollapseBlock({ title, icon, badge, open, onToggle, children }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-paper/60">
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

// 取人物某个设定键的值（转长篇档案时还原 identity / personality 用）。
function attrVal(c, key) {
  if (!c || !Array.isArray(c.attrs)) return ''
  const hit = c.attrs.find((a) => a && a.k === key)
  return hit ? String(hit.v ?? '') : ''
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

export default function ContinuePage({ apiKey, onNeedKey }) {
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
  // 5.1：发送前提示词确认（人在环路）。每个 AI 调用点击后先弹窗展示将发送的 system+user，可查看/编辑，确认后才真正发送（保留 jsonMode / 各版本 temperature / ANTI_REPETITION / 并发，质量参数不变）。
  const [promptConfirm, setPromptConfirm] = useState(null) // { title, groups: [{ label, messages }], proceed, meta }
  const [showDialog, setShowDialog] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  // 后续版本（AI 自动探索 4 种剧情走向）
  const [followupVersions, setFollowupVersions] = useState([])
  const [followupGenerating, setFollowupGenerating] = useState(false)
  const [followupProgress, setFollowupProgress] = useState(0)
  const [newChar, setNewChar] = useState({ name: '' })
  // 原文来源：'paste'（复制粘贴 / 直接输入）| 'file'（导入文件）——决定「纳入原文」提示与导出默认格式
  const [sourceMode, setSourceMode] = useState('paste')
  const [sourceFile, setSourceFile] = useState(null) // { name, base, format }
  // 资产库（续写页）：对导入/粘贴原文分析资产，存进所选书的记录（浏览器缓存），可编辑可收起查看
  const [assetListOpen, setAssetListOpen] = useState(false)
  const [assetOpen, setAssetOpen] = useState(false)
  const [editDraft, setEditDraft] = useState(null)
  const [pendingUpdates, setPendingUpdates] = useState([])
  const [pendingNew, setPendingNew] = useState([])
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [assetAnalyzing, setAssetAnalyzing] = useState(false)
  const [assetMsg, setAssetMsg] = useState('')
  const [selUp, setSelUp] = useState([])
  const [selNew, setSelNew] = useState([])
  const [assetPromptOpen, setAssetPromptOpen] = useState(false)
  // 分段分析的本次任务：{ system, user, chunks, total }——打开提示词弹窗那一刻算好并冻结(弹窗只读初始值，避免边打字边重算大字符串)
  const [assetTask, setAssetTask] = useState(null)
  // 阶段1(设计 §6.2)：侧栏分类按钮的预选值；点了直接开资产库弹窗并落在该分类
  const [assetFilter, setAssetFilter] = useState('all')
  // 阶段1(设计 §6.2 / 需求3、7)：手动新增资产弹窗
  const [newAssetOpen, setNewAssetOpen] = useState(false)
  // 阶段2(设计 §5)：【状态变更】【资产流转】两段产出的待落库列表与勾选下标(默认全选=现有行为)；预览弹窗开关
  const [pendingState, setPendingState] = useState([])
  const [selState, setSelState] = useState([])
  const [pendingFlow, setPendingFlow] = useState([])
  const [selFlow, setSelFlow] = useState([])
  const [stateOpen, setStateOpen] = useState(false)
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

  // ==================== M1（任务B）：文风池与改写页统一为「全量池」====================
  // 阶段1(任务1)：续写页删除文风块——不再做文风选择/蒸馏档案。continueMessages/followupMessages/incorporateReviseMessages 已由 B 侧改为忽略文风参数、
  //   "参照原文风格"并入其 system 提示词(CONTINUE_STYLE_HINT)；原 stylePool(全量池)/effectiveStyle/skinFrom/resolveStyleRec 文风解析链一并移除。
  //   5.3 genre 在续写页不再消费(Library 的题材下拉仍供改写页 RevisePage 使用)；M1 混合池一致性随文风块删除而消解(续写页不再解析文风)。

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
  const clearedRef = useRef(false) // 点过「清除内容」：吃掉紧随其后的那一次自动落盘，让本地记录真的被删掉
  const assetAbortRef = useRef(null) // H6：资产分段分析的中断句柄（分段循环可被用户中断，不整批空跑）

  // 分析结果是否已过期：纳入原文或手改原文之后，大纲与故事线仍停在旧版本上
  const staleAnalysis = analyzed && analyzedSnapshot !== text
  const busyNow = generating || followupGenerating || summarizing || analyzing || assetAnalyzing || incRevising
  const hasContent = !!(text || world || outline || characters.length || timeline.length || instruction || versions.length || followupVersions.length)

  const snapshot = () => ({
    text, sourceMode, sourceFile, exportFormat, instruction, collapsed,
    analyzed, analyzedSnapshot, world, characters, outline, timeline,
    versions, followupVersions, incorporated,
    incDraft, incOpen,
    // M1：待落库的分析结果与选中项纳入草稿，刷新不丢（原先漏了 → 刷新后 pending*/sel* 全空、已分析出的资产变更要重跑重烧）
    pendingUpdates, pendingNew, pendingState, pendingFlow,
    selUp, selNew, selState, selFlow,
  })

  // 挂载时水合：读回上次的工作草稿（best-effort，读不到就空手开始，绝不阻塞页面）
  useEffect(() => {
    let alive = true
    loadContinueDraft()
      .then((d) => {
        if (!alive || !d) return
        setText(typeof d.text === 'string' ? d.text : '')
        setSourceMode(d.sourceMode === 'file' ? 'file' : 'paste')
        setSourceFile(d.sourceFile || null)
        if (d.exportFormat && EXPORT_FORMAT_IDS.includes(d.exportFormat)) setExportFormat(d.exportFormat)
        setInstruction(typeof d.instruction === 'string' ? d.instruction : '')
        if (d.collapsed && typeof d.collapsed === 'object') setCollapsed(d.collapsed)
        setAnalyzed(!!d.analyzed)
        setAnalyzedSnapshot(typeof d.analyzedSnapshot === 'string' ? d.analyzedSnapshot : '')
        setWorld(d.world || '')
        setCharacters(Array.isArray(d.characters) ? d.characters.map(normalizeChar).filter(Boolean) : [])
        setOutline(d.outline || '')
        setTimeline(Array.isArray(d.timeline) ? d.timeline : [])
        setVersions(Array.isArray(d.versions) ? d.versions : [])
        setFollowupVersions(Array.isArray(d.followupVersions) ? d.followupVersions : [])
        setIncorporated(d.incorporated && typeof d.incorporated === 'object' ? d.incorporated : {})
        // M1：恢复待落库的分析结果与选中项（与 snapshot 对称），刷新后不必重跑分析重烧额度
        setPendingUpdates(Array.isArray(d.pendingUpdates) ? d.pendingUpdates : [])
        setPendingNew(Array.isArray(d.pendingNew) ? d.pendingNew : [])
        setPendingState(Array.isArray(d.pendingState) ? d.pendingState : [])
        setPendingFlow(Array.isArray(d.pendingFlow) ? d.pendingFlow : [])
        setSelUp(Array.isArray(d.selUp) ? d.selUp : [])
        setSelNew(Array.isArray(d.selNew) ? d.selNew : [])
        setSelState(Array.isArray(d.selState) ? d.selState : [])
        setSelFlow(Array.isArray(d.selFlow) ? d.selFlow : [])
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
        if (String(d.text || '').trim()) setInfoMsg('已恢复上次的续写草稿：原文、分析结果与已生成的版本都在。')
      })
      .catch(() => {})
      .finally(() => { if (alive) setHydrated(true) })
    return () => { alive = false }
  }, [])

  // 防抖落盘（600ms）：流式生成时逐字 setState 不会把 IndexedDB 写爆，停手后才真正落一次
  useEffect(() => {
    if (!hydrated) return
    if (clearedRef.current) { clearedRef.current = false; return }
    draftRef.current = snapshot()
    const t = setTimeout(() => saveContinueDraft(draftRef.current), 600)
    return () => clearTimeout(t)
  })

  // 关标签页 / 刷新前兜底再写一次（best-effort：IndexedDB 在 pagehide 期间不保证落盘，但多数情况赶得上）
  useEffect(() => {
    const flush = () => { if (draftRef.current) saveContinueDraft(draftRef.current) }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
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

  // 清除内容：原文 + 分析结果 + 文风档案 + 续写指令 + 已生成版本全部归零，并删掉浏览器里保存的草稿
  const doClear = async () => {
    clearedRef.current = hasContent // 本来就没内容时不置位，免得白吃掉下一次正常落盘
    draftRef.current = null
    setShowClearDialog(false)
    setText('')
    setSourceMode('paste')
    setSourceFile(null)
    setInstruction('')
    setNewChar({ name: '' })
    setAnalyzed(false)
    setAnalyzedSnapshot('')
    setWorld('')
    setCharacters([])
    setOutline('')
    setTimeline([])
    // H1：原先此处调用 setStyleAnalyzed/setStyleProfile/setStyleHabits/setStyleSamples，但这些 state 已随文风块删除
    //   → 点「清除内容」会抛 ReferenceError 并中断在 clearContinueDraft() 之前(草稿删不掉、刷新回灌)。已移除这 4 行。
    setVersions([])
    setFollowupVersions([])
    setIncorporated({})
    setIncDraft(null)
    setIncOpen(false)
    setIncErr('')
    setProgress(0)
    setFollowupProgress(0)
    // M2：一并清空待落库的分析结果与资产编辑态，避免「清除内容」后残留 pending*/选中项/提示/编辑草稿
    setPendingUpdates([])
    setPendingNew([])
    setPendingState([])
    setPendingFlow([])
    setSelUp([])
    setSelNew([])
    setSelState([])
    setSelFlow([])
    setAssetMsg('')
    setEditDraft(null)
    setErr('')
    await clearContinueDraft()
    setInfoMsg('已清除本页内容与浏览器里保存的草稿。')
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
    const truncated = text.length > ANALYZE_LIMIT
    const analyzeText = truncated ? text.slice(0, ANALYZE_LIMIT) : text
    setPromptConfirm({
      title: '分析原文（世界观 / 人物 / 大纲 / 故事线）',
      groups: [{ label: '分析提示词', messages: analyzeMessages({ text: analyzeText }) }],
      proceed: runAnalyze,
      meta: { truncated },
    })
  }

  const runAnalyze = async (groups, meta) => {
    setPromptConfirm(null)
    setAnalyzing(true)
    try {
      const res = await chatJSON({ apiKey, messages: groups[0].messages, temperature: 0.3 })
      setWorld(res.world_setting || '')
      setCharacters(Array.isArray(res.characters) ? res.characters.map(normalizeChar).filter(Boolean) : [])
      setOutline(res.outline || '')
      setTimeline(Array.isArray(res.timeline) ? res.timeline : [])
      setAnalyzed(true)
      setAnalyzedSnapshot(text) // 记住这份分析依据的原文；此后原文再变（纳入续写 / 手动编辑）就能判出分析已滞后
      if (meta.truncated) {
        setErr(`原文较长，已分析前 ${ANALYZE_LIMIT} 字。如需完整分析请拆分原文后重试。`)
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setAnalyzing(false)
    }
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
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '自定义续写（4 个方向并发）',
      // M2：前文摘要(仅原文超长时)是本步之前跑的不可编辑预处理，在确认窗明示，避免"数万字原文头悄悄直发模型"不透明
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 个方向的续写提示词，可查看 / 编辑。' : '',
      groups: CONTINUE_ANGLES.map((a, i) => ({
        label: `版本${i + 1}（${a.title}）`,
        messages: continueMessages({ text: tail, summary, world, characters: charText, outline, timeline, instruction, index: i }),
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
        const sumRes = await chatJSON({ apiKey, messages: summarizeMessages({ text: headText }), temperature: 0.3 })
        summary = sumRes.summary || ''
      } catch {
        summary = ''
      } finally {
        setSummarizing(false)
      }
      tail = text.slice(text.length - TAIL_LENGTH)
    }
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '探索后续（4 种剧情走向并发）',
      // M2：同自定义续写——前文摘要为不可编辑预处理，在确认窗明示
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 种走向的提示词，可查看 / 编辑。' : '',
      groups: FOLLOWUP_ANGLES.map((a, i) => ({
        label: `走向${i + 1}（${a.title}）`,
        messages: followupMessages({ text: tail, summary, world, characters: charText, outline, timeline, index: i }),
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
    await copyText(t)
    if (btn) {
      btn.textContent = '已复制 ✓'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
  }

  // 阶段1(任务1)：原 skinFrom / effectiveStyle（文风「皮」三级择一 + resolveStyleRec 混合池）已随文风块整体删除——续写不再解析/注入文风档案，
  //   continueMessages/followupMessages/incorporateReviseMessages 由 B 侧忽略文风参数、"参照原文风格"已并入其 system 提示词。

  // 重新生成时清除对应类型的「已纳入」标记（v=自定义续写，f=探索后续），避免旧标记落到新内容上
  const resetIncorporated = (prefix) =>
    setIncorporated((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(prefix))))

  // 点「纳入原文」不再直接追加，而是先开全屏弹窗让用户过一遍：可直接手改，也可写下想法让模型定向改写，
  // 点「确定并纳入原文」才真正追加到文末。（续写起点由 prompts.js 侧保证以原文结尾为准，不需先重跑「分析原文」。）
  const openIncorporate = (content, key, title) => {
    if (!content) return
    setIncErr('')
    // 同一版本沿用已存草稿（用户的修改不丢）；换版本则以该版本正文重新起稿
    setIncDraft((prev) => (prev && prev.key === key ? prev : { key, title: title || '', text: content, note: '' }))
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
      groups: [{ label: '改写提示词', messages: incorporateReviseMessages({ context: text.replace(/\s+$/, '').slice(-1200), text: before, note }) }],
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
        onDelta: (full) => setIncDraft((p) => (p ? { ...p, text: full } : p)),
      })
    } catch (e) {
      setIncDraft((p) => (p ? { ...p, text: before } : p)) // 失败回滚，不留半截稿
      setIncErr(`模型修改失败：${e?.message || e}`)
    } finally {
      setIncRevising(false)
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

  // —— 资产库（续写页）：分段分析原文 → 查看勾选落库 → 点击编辑 / 手动新增，存进所选书记录（浏览器缓存）——
  const selectedBook = lib.selectedBook
  // 阶段1(设计 §7 1.3②)：CRUD / links / 落库统一走 useAssets，不再页内自持 assetsLocal + 每次改动整表写盘。
  //   autoCommitMs=400：连续变更(如透出章逐字输入)合并成一次写盘(缓解 M29)；未选书时 useAssets 只留在本页并提示，不抛错。
  //   落库走 useAssets 默认路径(put('books', {...book, assets})) + onPersisted 里 lib.refresh()，与切书/删书的刷新口径一致。
  const libRefresh = lib.refresh
  const onAssetsPersisted = useCallback(async () => {
    await libRefresh()
  }, [libRefresh])
  // useAssets 的提示接进本页 assetMsg，但吞掉 debounce 落库那句通用「资产已保存」——
  // 否则它会在 400ms 后盖掉刚给出的结算摘要(如「已结算落库：状态变更 3 条…」)。失败提示照常透出。
  const onAssetMsg = useCallback((m) => {
    if (m && m !== '资产已保存') setAssetMsg(m)
  }, [])
  const ua = useAssets({ book: selectedBook, onPersisted: onAssetsPersisted, idPrefix: 'cx', autoCommitMs: 400, onMessage: onAssetMsg })
  const assets = ua.assets
  const assetBook = { ...(selectedBook || {}), assets }
  const perVol = perVolOf(assetBook)
  // 侧栏清单跟随分类筛选（与资产库弹窗同一份 filterAssets 判据，含「⚠ 待补全」虚拟类）
  const shownAssets = ua.filtered(assetFilter)

  // 打开「分析原文 → 资产」提示词弹窗：这一刻冻结分段与提示词(共 N 段、每段 ASSET_CHUNK 字、不足一段取完)。
  // 提示词改用两页共用的 analyzeAssetsMessages(五段产出：已有资产更新/新资产/状态变更/资产流转/伏笔推进)。
  const openAssetPrompt = () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    const src = text || (selectedBook && selectedBook.content) || ''
    if (!src.trim()) {
      setAssetMsg('先粘贴或导入原文再分析资产')
      return
    }
    const chunks = chunkSource(src)
    const msgs = analyzeAssetsMessages({
      roster: assets.map((a) => ({ name: a.name, type: a.type, detail: a.detail })),
      source: chunks[0] || '',
      chapterNo: 0,
    })
    setAssetTask({
      system: (msgs[0] && msgs[0].content) || '',
      user: (msgs[1] && msgs[1].content) || '',
      chunks,
      total: src.length,
    })
    setAssetPromptOpen(true)
  }

  // 采纳弹窗里那段(第 1 段)的回复，再把第 2..N 段依次发出去(沿用用户改过的提示词，只换原文)，最后合并解析一次。
  // 人在环路：每段都用同一份用户可见/可改的提示词；系统只解析与记录，不判断不拦截(设计 §5)。
  const runAssetAnalyze = async (firstReply, editedUser) => {
    const task = assetTask
    if (!task) return
    const chunks = task.chunks || []
    setAssetPromptOpen(false)
    setAssetAnalyzing(true)
    const ctrl = new AbortController()
    assetAbortRef.current = ctrl // H6：可中断
    let full = String(firstReply || '')
    let doneSegs = 1 // 第 1 段(弹窗里已生成)计入已完成
    let stopped = ''
    try {
      for (let i = 1; i < chunks.length; i += 1) {
        setAssetMsg(`分析中… 第 ${i + 1}/${chunks.length} 段（每段 ${ASSET_CHUNK} 字）`)
        try {
          // H5：结构化资产提取统一 temperature 0.3（与第 1 段弹窗一致；原第 2..N 段用 chatStream 默认 0.9，口径不一且对结构化提取偏高）
          // H6：传 signal，单段失败/中断不整批废——用已成功段出部分结果
          const r = await chatStream({
            apiKey,
            temperature: 0.3,
            signal: ctrl.signal,
            messages: [
              { role: 'system', content: task.system },
              { role: 'user', content: swapSource(editedUser || task.user, chunks[i]) },
            ],
          })
          full += `\n${r || ''}`
          doneSegs += 1
        } catch (segErr) {
          stopped =
            segErr?.name === 'AbortError'
              ? `已中断，保留前 ${doneSegs}/${chunks.length} 段结果`
              : `第 ${i + 1} 段失败(${segErr?.message || segErr})，保留前 ${doneSegs}/${chunks.length} 段结果`
          break
        }
      }
      const parsed = parseAnalyze(full)
      setPendingUpdates(parsed.updates || [])
      setPendingNew(parsed.newAssets || [])
      setSelUp((parsed.updates || []).map((_, i) => i))
      setSelNew((parsed.newAssets || []).map((_, i) => i))
      setPendingState(parsed.stateChanges || [])
      setPendingFlow(parsed.flows || [])
      setSelState((parsed.stateChanges || []).map((_, i) => i))
      setSelFlow((parsed.flows || []).map((_, i) => i))
      const segNote =
        chunks.length > 1
          ? `（原文 ${task.total} 字，分 ${chunks.length} 段每段 ${ASSET_CHUNK} 字${stopped ? `，实际完成 ${doneSegs} 段` : '全量分析'}）`
          : `（原文 ${task.total} 字，一段取完）`
      setAssetMsg(
        `${stopped ? stopped + '：' : '分析完成'}${segNote}已有资产更新 ${parsed.updates.length} 条、新资产 ${parsed.newAssets.length} 条、状态变更 ${parsed.stateChanges.length} 条、资产流转 ${parsed.flows.length} 条` +
          (parsed.hookMoves && parsed.hookMoves.length ? `；伏笔推进 ${parsed.hookMoves.length} 条（续写页不持有伏笔表，仅报数不落库）` : '') +
          '。查看勾选后才落库。',
      )
    } catch (ex) {
      setAssetMsg(`分析失败：${ex.message}`)
    } finally {
      setAssetAnalyzing(false)
      assetAbortRef.current = null
    }
  }

  const applyUpdates = () => {
    const chosen = pendingUpdates.filter((_, i) => selUp.includes(i))
    // H2：同名资产的多条更新先按名聚合（detail 顺序追加去重、state 依次演进），每个资产只写一次；
    //   原实现对每条更新都基于同一份渲染闭包 a.detail/a.state 计算再 updateAsset，后一条覆盖前一条 → 勾 N 条同名只落最后 1 条。
    const byName = new Map()
    chosen.forEach((u) => {
      if (!u || !u.name) return
      if (!byName.has(u.name)) byName.set(u.name, [])
      byName.get(u.name).push(u)
    })
    byName.forEach((ups, name) => {
      const a = assets.find((x) => x.name === name)
      if (!a) return
      let detail = String(a.detail || '')
      const st = normalizeState(a.state)
      ups.forEach((u) => {
        // L-2：追加前判重，避免反复合并把同一句堆多遍
        if (u.info && !detail.includes(u.info)) detail = detail ? `${detail}｜${u.info}` : String(u.info)
        // 阶段2(设计 §5 ⑤)：粗状态词并入 plot 维度、原话留 legacy；同名多条按顺序演进(后者为最终态)
        const word = String(u.state || '').trim()
        const tag = STATE_V1_MAP[word] || STATE_V1_MAP[word.toLowerCase()]
        if (tag) st.plot = { ...(st.plot || {}), tag }
        if (word) st.legacy = st.legacy || word
      })
      st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: (st.meta && st.meta.sourceCh) || 0 }
      ua.updateAsset(a.id, { detail, state: st })
    })
    setPendingUpdates([])
    setSelUp([])
    setUpdatesOpen(false)
  }
  const applyNew = () => {
    const chosen = pendingNew.filter((_, i) => selNew.includes(i))
    let added = 0
    let skipped = 0
    chosen.forEach((n) => {
      if (!n.name) {
        skipped += 1
        return
      }
      // 走 useAssets.addAsset：内部过 normalizeAsset(v2 state / 中文类型归一) + 只对新条目跑共现建边 + 重名不静默丢弃
      const r = ua.addAsset(
        { name: n.name, type: typeKeyOf(n.type), detail: n.desc || '', ch_reveal: Number(n.reveal) || 0 },
        { idPrefix: 'cx' },
      )
      if (r && r.ok) added += 1
      else skipped += 1
    })
    setAssetMsg(`已落库新资产 ${added} 个${skipped ? `（重名 / 无名 ${skipped} 个已跳过，重名可在「+ 新增资产」里选合并）` : ''}`)
    setPendingNew([])
    setSelNew([])
    setNewOpen(false)
  }

  // 状态结算落库（设计 §5 ⑤）：只写用户勾选的条目；不勾选则库里一个字节都不变。系统零判断零拦截。
  const applyStateSettlement = () => {
    const selSc = pendingState.filter((_, i) => selState.includes(i))
    // H3：同名资产的多条状态变更先按名聚合、依次 applyStateChange 累积，每个资产只写一次；
    //   原实现每条都基于同一份渲染闭包 a.state → 后条覆盖前条，多维度/多条变更只留最后一条。
    const scByName = new Map()
    selSc.forEach((sc) => {
      if (!sc || !sc.name) return
      if (!scByName.has(sc.name)) scByName.set(sc.name, [])
      scByName.get(sc.name).push(sc)
    })
    scByName.forEach((scs, name) => {
      const a = assets.find((x) => x.name === name)
      if (!a) return
      let st = a.state
      scs.forEach((sc) => {
        st = applyStateChange(st, sc, sc.since || 0)
      })
      ua.updateAsset(a.id, { state: st })
    })
    // 资产流转：人物侧记一条 hold；获得且未建档 → 顺便建最小资产(需求7)；损毁/消耗/丢失 → 标注不删(拍板5)
    const selFl = pendingFlow.filter((_, i) => selFlow.includes(i))
    let newItem = 0
    selFl.forEach((fl) => {
      if (!fl.asset) return
      const person = assets.find((x) => x.name === fl.person)
      if (person) {
        const st = normalizeState(person.state)
        const hold = Array.isArray(st.hold) ? [...st.hold] : []
        if (!hold.some((h) => h.name === fl.asset && h.change === fl.change && h.ch === fl.ch)) hold.push({ name: fl.asset, change: fl.change || 'gain', ch: fl.ch || 0 })
        st.hold = hold
        st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: fl.ch || 0 }
        ua.updateAsset(person.id, { state: st })
      }
      const target = assets.find((x) => x.name === fl.asset)
      if (!target && fl.change === 'gain') {
        const r = ua.addAsset({ name: fl.asset, type: 'item', ch_reveal: fl.ch || 0 }, { idPrefix: 'cx' })
        if (r && r.ok) newItem += 1
      } else if (target && (fl.change === 'broken' || fl.change === 'consumed' || fl.change === 'lose')) {
        const st = normalizeState(target.state)
        const noteWord = fl.changeRaw || (fl.change === 'consumed' ? '已消耗' : fl.change === 'lose' ? '已丢失' : '已损毁')
        st.phys = { tag: 'broken', note: noteWord, ...(fl.ch ? { since: fl.ch } : {}) }
        st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: fl.ch || 0 }
        ua.updateAsset(target.id, { state: st })
      }
    })
    setAssetMsg(`已结算落库：状态变更 ${selSc.length} 条 / 资产流转 ${selFl.length} 条${newItem ? `（新入表 ${newItem} 个道具）` : ''}`)
    setPendingState([])
    setPendingFlow([])
    setSelState([])
    setSelFlow([])
    setStateOpen(false)
  }

  // 结算预览的只读辅助：旧值(该维度当前状态的中文说法)，让用户看得见改了什么(设计 §5 ④)
  const oldStateWord = (sc) => {
    const a = assets.find((x) => x.name === sc.name)
    if (!a) return '(未建档)'
    const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
    const dim = sc.dimKey
    if (dim === 'place') return st.place && st.place.ref ? `在${st.place.ref}` : '(未记录)'
    if (dim === 'hold') return `持有 ${(st.hold || []).filter((h) => h.change === 'gain' || !h.change).map((h) => h.name).filter(Boolean).join('、') || '(无)'}`
    const o = st[dim]
    if (!o) return '(未记录)'
    return o.note || (o.tag ? stateLabel(dim, o.tag) : '(未记录)')
  }
  const assetExists = (name) => assets.some((a) => a.name === name)

  const updateAsset = (id, patch) => ua.updateAsset(id, patch)
  const deleteAsset = (id) => ua.deleteAsset(id)
  const openEdit = (a) => setEditDraft({ ...a, knowersStr: (a.knowers || []).join('、'), aliasesStr: (a.aliases || []).join(', ') })
  const saveEdit = () => {
    if (!editDraft) return
    // 阶段1(设计 §6.2)：保存走 normalizeAsset，白名单补齐 state/aliases/tier/卷号/holder
    //   （原白名单只有 name/type/detail/章号/knowers/links，EditAssetModal 新增的 StatePanel 状态、分层 tier、别名 aliases 会存不进去）
    const next = normalizeAsset({
      ...editDraft,
      aliases: editDraft.aliasesStr != null ? editDraft.aliasesStr : editDraft.aliases,
      knowers: editDraft.knowersStr != null ? editDraft.knowersStr : editDraft.knowers,
      ch_reveal: Number(editDraft.ch_reveal) || 0,
      ch_rumor: Number(editDraft.ch_rumor) || 0,
    })
    updateAsset(editDraft.id, next)
    setEditDraft(null)
  }

  // 阶段1(设计 §6.2 / 需求3、7)：手动新增资产。onSubmit(asset, info)：asset 已由 NewAssetModal 过 normalizeAsset(带 id/links/state v2)
  const handleAssetSubmit = (asset, info) => {
    if (!asset) {
      if (info && info.reason) setAssetMsg(info.reason)
      return
    }
    if (info && info.mode === 'merge' && info.mergedFrom) {
      ua.updateAsset(info.mergedFrom, asset)
      setAssetMsg(`已合并进《${asset.name}》`)
      return
    }
    // force：重名时用户已明确选「仍新增」；否则 addAsset 会因重名返回 duplicate
    const r = ua.addAsset(asset, { idPrefix: 'cx', force: !!(info && info.force) })
    if (r && r.ok) setAssetMsg(`已新增资产《${asset.name}》`)
    else if (r && r.reason === 'duplicate') setAssetMsg(`名册里已有《${asset.name}》，未重复入库（可在编辑里合并）`)
    else if (r && r.msg) setAssetMsg(r.msg)
  }
  // LinkEditor / StatePanel「顺便建档」：建一条最小资产(只有名字+类型)，符合"人在环路 + 不阻断"
  const quickCreateAsset = ({ name, type }) => {
    if (!name) return
    const r = ua.addAsset(normalizeAsset({ name, type: typeKeyOf(type) || 'person' }, { idPrefix: 'cx' }), { idPrefix: 'cx', force: true })
    setAssetMsg(r && r.ok ? `已顺便建档《${name}》（只有名字，其余字段可后补）` : `「${name}」建档未成功${r && r.msg ? `：${r.msg}` : ''}`)
  }

  return (
    <div>
      {!apiKey && <KeyBanner onNeedKey={onNeedKey} />}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Library lib={lib} apiKey={apiKey} onNeedKey={onNeedKey} showStyle={false} />

          {/* 资产库：我的书库下方，样式同款卡片，可收起；点清单条目即编辑 */}
          <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold"><Ic n="library" /> 资产库（{assets.length}）</h3>
              <button onClick={() => setAssetListOpen((o) => !o)} className="rounded-full px-3 py-1 text-xs text-stone-500 hover:bg-stone-100">
                {assetListOpen ? '收起' : '展开'}
              </button>
            </div>
            {assetListOpen && (
              <>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={openAssetPrompt}
                    disabled={!selectedBook || assetAnalyzing}
                    title="把本页原文从头到尾每 15000 字一段发给 AI，逐段提取资产与状态；发送前可先看/改提示词"
                    className="rounded-lg bg-red-700 px-3 py-1.5 text-xs text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {assetAnalyzing ? '分析中…' : '分析原文 → 资产'}
                  </button>
                  <button onClick={() => setAssetOpen(true)} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100">
                    查看资产库
                  </button>
                  <button
                    onClick={() => setNewAssetOpen(true)}
                    disabled={!selectedBook}
                    title="手动新增一个资产（所有字段可空，全空不入库）"
                    className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + 新增资产
                  </button>
                  {pendingUpdates.length > 0 && (
                    <button onClick={() => setUpdatesOpen(true)} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100">
                      查看已有资产更新（{pendingUpdates.length}）
                    </button>
                  )}
                  {pendingNew.length > 0 && (
                    <button onClick={() => setNewOpen(true)} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100">
                      查看新资产（{pendingNew.length}）
                    </button>
                  )}
                  {pendingState.length + pendingFlow.length > 0 && (
                    <button onClick={() => setStateOpen(true)} className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100">
                      查看状态结算（{pendingState.length + pendingFlow.length}）
                    </button>
                  )}
                </div>
                {/* 阶段1(设计 §6.2)：侧栏一行分类按钮——点了直接开资产库弹窗并预选该分类 */}
                <div className="mt-2">
                  <AssetFilterBar
                    value={assetFilter}
                    onChange={(k) => {
                      setAssetFilter(k)
                      setAssetOpen(true)
                    }}
                    counts={ua.counts}
                    perVol={perVol}
                    size="xs"
                  />
                </div>
                {/* H4：数据源明示——本页 text 为空时 openAssetPrompt 会回落到整本 selectedBook.content 分段分析(可能几十段/几十次调用、烧额度)，
                    必须在 UI 说清，不能显示"尚未粘贴"却暗地里分析整本书 */}
                <p className="mt-2 text-[11px] leading-relaxed text-stone-400">
                  {wordCount
                    ? `数据源：本页原文 ${wordCount} 字，从头到尾每 ${ASSET_CHUNK} 字一段（共 ${Math.ceil(wordCount / ASSET_CHUNK)} 段，不足一段取完）全量分析`
                    : selectedBook && selectedBook.content
                      ? `数据源：本页未粘贴原文，将分析整本《${selectedBook.title || selectedBook.name}》（约 ${countWords(selectedBook.content)} 字、${Math.ceil(String(selectedBook.content).length / ASSET_CHUNK)} 段）——段数多、耗时长、消耗额度大`
                      : '数据源：尚未粘贴 / 导入原文'}
                  {selectedBook ? '' : '；未选书时不落库'}
                </p>
                {!selectedBook && <p className="mt-2 text-xs text-stone-400">先在「我的书库」选中或导入一本小说，资产会存进这本书。</p>}
                {assetMsg && <p className="mt-2 text-xs text-stone-500">{assetMsg}</p>}
                <ul className="mt-2 space-y-1">
                  {shownAssets.slice(0, 12).map((a) => (
                    <li key={a.id}>
                      <button onClick={() => openEdit(a)} className="block w-full rounded-lg border border-stone-200 px-3 py-1.5 text-left text-xs text-stone-700 hover:bg-stone-50">
                        {a.name} <span className="text-stone-400">({ASSET_TYPE_LABEL[a.type] || a.type})</span>
                      </button>
                    </li>
                  ))}
                  {shownAssets.length > 12 && <li className="px-3 text-[11px] text-stone-400">还有 {shownAssets.length - 12} 条，点「查看资产库」看全部</li>}
                  {!shownAssets.length && (
                    <li className="rounded-xl border border-dashed border-stone-300 p-3 text-center text-xs text-stone-400">
                      {assets.length ? '该分类下暂无资产，换个分类或点「+ 新增资产」' : '还没有资产，点「分析原文 → 资产」从原文提取，或「+ 新增资产」手动建档'}
                    </li>
                  )}
                </ul>
              </>
            )}
          </section>
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
                {analyzing ? 'AI 分析中…' : <><Ic n="search" /> 分析原文（世界观 / 人物 / 大纲 / 故事线）</>}
              </button>
              {staleAnalysis && (
                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
                  <Ic n="alert" /> 原文已变，下面的分析结果停在旧版本——续写会自动以原文结尾为准，不需先重跑分析；想刷新大纲/故事线可再点一次「分析原文」
                </span>
              )}
              <span className="text-xs text-stone-400">结果可编辑、可分块收起</span>
            </div>
            {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
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
                      setCollapsed({ world: anyOpen, chars: anyOpen, outline: anyOpen, timeline: anyOpen, style: anyOpen })
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

              {/* 故事线时间线（文字为主，阶段名非真实时间） */}
              {analyzed && timeline.length > 0 && (
                <CollapseBlock title="故事线梳理（基于原文已发生情节，非真实时间）" icon="hourglass" open={!collapsed.timeline} onToggle={() => toggleBlock('timeline')}>
                  <div className="relative pl-6">
                    <div className="absolute left-[7px] top-1 bottom-1 w-0.5 bg-stone-300"></div>
                    {timeline.map((t, i) => (
                      <div key={i} className="relative mb-4 last:mb-0">
                        <div className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-500 shadow"></div>
                        <p className="text-sm font-semibold text-ink">{t.stage || `阶段${i + 1}`}</p>
                        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">{t.summary}</p>
                      </div>
                    ))}
                  </div>
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
              cacheKey={`na_diag_cont_${text.length}_${text.slice(-16)}`}
            />
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
                            onClick={() => openIncorporate(v.content, `v${i}`, v.title)}
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
        >
          <div
            className="glass-modal w-full max-w-lg rounded-2xl bg-paper p-6 shadow-xl"
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
              将清空本页的原文（{wordCount} 字）、分析结果、续写指令与已生成的续写版本，并删掉浏览器里保存的草稿。
            </p>
            <p className="mt-2 text-xs leading-relaxed text-stone-400">
              此操作不可撤销。如果还想留一份，先点下方「导出完整原文」把全文存成文件。
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

      {/* 阶段1(需求2 / 设计 §5)：提示词改用两页共用的 analyzeAssetsMessages(system+user 两段)。
          弹窗里发送的是第 1 段；采纳后第 2..N 段沿用同一份(可被你改过的)提示词只换原文，逐段发完再合并解析。 */}
      <PromptEditorModal
        open={assetPromptOpen}
        title={`分析原文 → 资产（第 1/${(assetTask && assetTask.chunks.length) || 1} 段 · 提示词可编辑）`}
        systemPrompt={(assetTask && assetTask.system) || ''}
        initialPrompt={(assetTask && assetTask.user) || ''}
        temperature={0.3}
        onClose={() => setAssetPromptOpen(false)}
        onAdopt={(reply, prompt) => {
          runAssetAnalyze(reply, prompt)
        }}
      />

      <AssetModal
        open={assetOpen}
        onClose={() => setAssetOpen(false)}
        book={assetBook}
        onUpdateAsset={updateAsset}
        onDeleteAsset={deleteAsset}
        onEditAsset={openEdit}
        onAddAsset={() => setNewAssetOpen(true)}
        warnings={computeAssetWarnings(assets)}
        perVol={perVol}
        filter={assetFilter}
        onFilterChange={setAssetFilter}
      />
      <EditAssetModal
        editDraft={editDraft}
        setEditDraft={setEditDraft}
        onClose={() => setEditDraft(null)}
        onSave={saveEdit}
        onDelete={() => {
          deleteAsset(editDraft.id)
          setEditDraft(null)
        }}
        perVol={perVol}
        assets={assets}
        chapterNo={0}
        onQuickCreate={quickCreateAsset}
      />
      {/* 阶段1(需求3、7)：手动新增资产——全字段可空、全空不入库、重名给「合并 / 仍新增」 */}
      <NewAssetModal
        open={newAssetOpen}
        mode="create"
        assets={assets}
        perVol={perVol}
        chapterNo={0}
        idPrefix="cx"
        onSubmit={handleAssetSubmit}
        onClose={() => setNewAssetOpen(false)}
        onQuickCreate={quickCreateAsset}
      />
      {updatesOpen && (
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setUpdatesOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-stone-200 px-5 py-3 font-semibold">已有资产更新（{pendingUpdates.length}）</div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {pendingUpdates.map((u, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selUp.includes(i)}
                    onChange={(e) => setSelUp(e.target.checked ? [...selUp, i] : selUp.filter((x) => x !== i))}
                  />
                  <span className="font-medium">{u.name}</span>
                  <span className="flex-1 text-stone-500">{u.info}</span>
                  {/* 阶段1(设计 §7 1.3⑥)：状态从只读文本改成可改的 <select>，对齐长篇页——AI 提取错了用户能就地改，而不是只能整条不勾 */}
                  <select
                    value={u.state}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPendingUpdates((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))}
                    className="rounded border border-stone-300 bg-paper px-1 py-0.5"
                  >
                    {['活跃', '死亡', '毁坏', '隐藏', '升迁'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {!pendingUpdates.length && <div className="text-xs text-stone-400">无待落库更新</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <button onClick={() => setUpdatesOpen(false)} className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100">取消</button>
              <button onClick={applyUpdates} className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600">落库更新</button>
            </div>
          </div>
        </div>
      )}
      {newOpen && (
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setNewOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-stone-200 px-5 py-3 font-semibold">新资产（{pendingNew.length}）</div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {pendingNew.map((n, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selNew.includes(i)}
                    onChange={(e) => setSelNew(e.target.checked ? [...selNew, i] : selNew.filter((x) => x !== i))}
                  />
                  <span className="rounded bg-stone-100 px-1 py-0.5 text-stone-600">{ASSET_TYPE_LABEL[typeKeyOf(n.type)] || n.type}</span>
                  <span className="font-medium">{n.name}</span>
                  <span className="flex-1 text-stone-500">{n.desc}</span>
                  <span className="text-stone-400">透出章 {n.reveal || 0}</span>
                </label>
              ))}
              {!pendingNew.length && <div className="text-xs text-stone-400">无待落库新资产</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <button onClick={() => setNewOpen(false)} className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100">取消</button>
              <button onClick={applyNew} className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600">落库新资产</button>
            </div>
          </div>
        </div>
      )}
      {/* 阶段2(设计 §5 ④)：状态结算预览——【状态变更】显示 旧值 → 新值，【资产流转】未建档的资产名旁标「顺便建档」。
          默认全选，取消勾选即不落库；系统不做任何一致性判断、不阻断、不标红拦截。 */}
      {stateOpen && (
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setStateOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">状态结算预览（勾选后落库）</span>
              <button onClick={() => setStateOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              <div className="space-y-2">
                <div className="text-xs font-bold text-stone-700">状态变更（{pendingState.length}）</div>
                {pendingState.map((sc, i) => (
                  <label key={`s${i}`} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selState.includes(i)} onChange={(e) => setSelState(e.target.checked ? [...selState, i] : selState.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{sc.name}</span>
                    <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-600">{sc.dim}</span>
                    <span className="text-stone-400">{oldStateWord(sc)}</span>
                    <span className="text-stone-400">→</span>
                    <input
                      value={sc.state}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingState((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))}
                      className="w-24 rounded border border-stone-300 bg-paper px-1 py-0.5"
                    />
                    <span className="flex-1 text-stone-500">{sc.note}</span>
                    <span className="text-stone-400">{sc.since ? `第${sc.since}章起` : ''}</span>
                  </label>
                ))}
                {!pendingState.length && <div className="text-xs text-stone-400">本次没有【状态变更】产出</div>}
              </div>
              <div className="space-y-2">
                <div className="text-xs font-bold text-stone-700">资产流转（{pendingFlow.length}）</div>
                {pendingFlow.map((fl, i) => (
                  <label key={`f${i}`} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selFlow.includes(i)} onChange={(e) => setSelFlow(e.target.checked ? [...selFlow, i] : selFlow.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{fl.person}</span>
                    <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-600">{fl.changeRaw || fl.change}</span>
                    <span className="text-stone-700">{fl.asset}</span>
                    {/* 未建档的流转目标：勾选落库时会顺便建一条最小资产(只有名字+类型)，符合需求7 与"不阻断" */}
                    {!assetExists(fl.asset) && <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">未建档 · 勾选即顺便建档</span>}
                    <span className="flex-1" />
                    <span className="text-stone-400">{fl.ch ? `第${fl.ch}章` : ''}</span>
                  </label>
                ))}
                {!pendingFlow.length && <div className="text-xs text-stone-400">本次没有【资产流转】产出</div>}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <span className="mr-auto text-xs text-stone-400">系统只记录你勾选的内容，不判断对错、不拦截</span>
              <button
                onClick={() => {
                  setSelState(pendingState.map((_, i) => i))
                  setSelFlow(pendingFlow.map((_, i) => i))
                }}
                className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
              >
                全选
              </button>
              <button
                onClick={() => {
                  setSelState([])
                  setSelFlow([])
                }}
                className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
                disabled={!selState.length && !selFlow.length}
              >
                清空
              </button>
              <button onClick={applyStateSettlement} disabled={!selState.length && !selFlow.length} className="rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40">
                落库选中（{selState.length + selFlow.length}）
              </button>
              <button onClick={() => setStateOpen(false)} className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {promptConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" onClick={() => setPromptConfirm(null)}>
          <div className="flex max-h-[88vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">{promptConfirm.title} · 发送前可查看 / 编辑提示词</span>
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
                            return { ...p, groups }
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
    </div>
  )
}
