import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { parseAnalyze, computeAssetWarnings, STATE_WORDS_CN } from '../lib/parseAssets.js'
import { normalizeAsset, normalizeState, perVolOf, ASSET_TYPES, ASSET_TYPE_LABEL, STATE_V1_MAP, stateLabel, applyStateChange, typeKeyOf, findAssetByName, applyFlowToRoster, saveEditAsset, duplicateNameGroups } from '../lib/assets.js'
import { useLibrary } from '../hooks/useLibrary.js'
// 阶段1(设计 §7 1.3②)：资产 CRUD / links / 落库统一走 useAssets(提交式落库，缓解 M29 频繁写盘)
import { useAssets } from '../hooks/useAssets.js'
import { chatJSON, chatStream, ANTI_REPETITION } from '../lib/llm.js'
// analyzeAssetsMessages：两页共用的「分析原文 → 资产」提示词(五段产出，含【状态变更】【资产流转】【伏笔推进】)，取代原页内 continueAssetPrompt
import { analyzeMessages, continueMessages, CONTINUE_ANGLES, followupMessages, FOLLOWUP_ANGLES, summarizeMessages, incorporateReviseMessages, analyzeAssetsMessages } from '../lib/prompts.js'
import { copyText, countWords, mapLimit } from '../lib/utils.js'
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
  for (let i = 0; i < s.length; ) {
    let end = Math.min(i + ASSET_CHUNK, s.length)
    // L：别在 UTF-16 代理对中间切断（emoji / 扩展汉字占两个码元）——若段尾正好落在高位代理上，把这一对留给下一段，
    //   否则切出的半截代理对会变乱码，喂给 AI 的原文该处失真。ASSET_CHUNK=15000 远大于 1，end>i 恒成立、不会死循环。
    if (end < s.length) {
      const code = s.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    out.push(s.slice(i, end))
    i = end
  }
  return out
}

// 用户在提示词弹窗里改过 user 段后，第 2..N 段要沿用「改过的提示词」只换原文：
// 按 analyzeAssetsMessages 的锚点「【本段原文】」定位，替换其后到「请对照名册…」之间的原文，尾注保留。
// 锚点被用户删掉时降级为在末尾追加一段带锚点的原文（不把整段提示词丢掉）。
// item35：续写页分析的是整本/粘贴原文的切片（非按章），调 analyzeAssetsMessages 传 unit='段' → 提示词源块头变「【本段原文】」，故本锚点同步改为「本段」（原「本章」会失配、换源失效）。
const SOURCE_ANCHOR = '【本段原文】'
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

// CP1/第12轮b：名字匹配改用 assets.js 单一出处 findAssetByName（findByName 精确 + matchesName 别名/空格容错），
//   原本地副本删除——避免与 B 共享层漂移（applyFlowToRoster 内部也用同一个）。

// CP2：多段回复合并后 parseAnalyze 会产出跨段重复条目（同一资产在多段都被提到）——按 key 去重，避免预览重复行与 hold/rel 重复 push。
const dedupBy = (arr, keyOf) => {
  const seen = new Set()
  const out = []
  ;(arr || []).forEach((it) => {
    const k = keyOf(it)
    if (seen.has(k)) return
    seen.add(k)
    out.push(it)
  })
  return out
}

// A11(去重)：typeKeyOf / applyStateChange 已由 B 抽到 assets.js 作单一出处，本页改 import 复用（原本地定义删除，避免与长篇页两份实现漂移）；tagForWord / TYPE_BY_LABEL 是这两个的内部依赖，随之住在 assets.js，本页不再单独 import。

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
  const [collapsed, setCollapsed] = useState({ world: false, chars: false, outline: false, timeline: false })
  const toggleBlock = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))
  // 导出完整原文
  const [exportFormat, setExportFormat] = useState('txt')
  const [exporting, setExporting] = useState(false)
  const [infoMsg, setInfoMsg] = useState('')
  const [draftSaveError, setDraftSaveError] = useState('') // item12（第十轮）：草稿落 IDB 失败的显式警告（对齐 WizardPage M38 / LongFormPage L-新7），不再静默——否则 IDB 满时用户仍信「刷新不丢」
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
  // H-新1②：5 路生成（runAnalyze / 前文摘要 / runGenerate / runGenerateFollowup / runReviseIncorporate）共用一个中断句柄，
  //   卸载(切页签)时一次性 abort 全部在飞请求；mountedRef 守卫卸载后的 setState。（资产分段分析仍用独立的 assetAbortRef，可页内手动停止）
  const genAbortRef = useRef(null)
  const mountedRef = useRef(true)
  const copyTimersRef = useRef([]) // L1：复制提示的 1.5s 复位定时器集合，卸载时统一清（对齐 RevisePage）

  // 分析结果是否已过期：纳入原文或手改原文之后，大纲与故事线仍停在旧版本上
  const staleAnalysis = analyzed && analyzedSnapshot !== text
  const busyNow = generating || followupGenerating || summarizing || analyzing || assetAnalyzing || incRevising
  // M-1①：hasContent 必须把「已烧 token 的分析半成品」也算进去——pending*(待落库的资产更新/新增/状态/流转) 与 editDraft(资产编辑草稿)
  //   原来不在判据里：不粘原文直接「分析原文」(回落整本 selectedBook.content) 会产出 pending* 但 hasContent=false → 防抖 effect 不落盘 → 刷新全丢重烧，
  //   与 snapshot 的 M1/P1-3 承诺(把 pending*/editDraft 纳入草稿)自相矛盾。有任一非空即算有内容 → 落盘。
  const hasContent = !!(
    text || world || outline || characters.length || timeline.length || instruction || versions.length || followupVersions.length ||
    pendingUpdates.length || pendingNew.length || pendingState.length || pendingFlow.length || editDraft
  )

  const snapshot = () => ({
    text, sourceMode, sourceFile, exportFormat, instruction, collapsed,
    analyzed, analyzedSnapshot, world, characters, outline, timeline,
    versions, followupVersions, incorporated,
    incDraft, incOpen,
    // M1：待落库的分析结果与选中项纳入草稿，刷新不丢（原先漏了 → 刷新后 pending*/sel* 全空、已分析出的资产变更要重跑重烧）
    pendingUpdates, pendingNew, pendingState, pendingFlow,
    selUp, selNew, selState, selFlow,
    // P1-3：资产编辑弹窗的半成品草稿也纳入——改一半刷新原来会整份丢掉（弹窗关、字段回退）
    editDraft,
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
        // L：旧草稿的 collapsed 可能带已删文风块的 style 死键——恢复时剔掉，否则它会让「全部收起/展开」的 anyOpen 判断失真
        if (d.collapsed && typeof d.collapsed === 'object') {
          const { style: _dropStyle, ...restCollapsed } = d.collapsed
          setCollapsed(restCollapsed)
        }
        setAnalyzed(!!d.analyzed)
        setAnalyzedSnapshot(typeof d.analyzedSnapshot === 'string' ? d.analyzedSnapshot : '')
        // 第一档④修：水合回读也归一（与 runAnalyze 写侧 :486-493 同口径）——修复前落库的毒丸草稿(world/outline 是对象、timeline 元素字段是对象)刷新即回灌，
        //   CollapseBlock 渲染 {world}/{outline}/{t.stage}/{t.summary} 抛「Objects are not valid as React child」、每次刷新复现、用户无法自救(草稿一直在)。
        setWorld(typeof d.world === 'string' ? d.world : '')
        setCharacters(Array.isArray(d.characters) ? d.characters.map(normalizeChar).filter(Boolean) : [])
        setOutline(typeof d.outline === 'string' ? d.outline : '')
        setTimeline(
          Array.isArray(d.timeline)
            ? d.timeline.map((t) => (t && typeof t === 'object' ? { ...t, stage: typeof t.stage === 'string' ? t.stage : '', summary: typeof t.summary === 'string' ? t.summary : '' } : null)).filter(Boolean)
            : [],
        )
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
        // P1-3：恢复资产编辑弹窗的半成品草稿（有则弹窗自动重开到用户眼前，与 incDraft 恢复同口径）
        if (d.editDraft && typeof d.editDraft === 'object' && d.editDraft.id) setEditDraft(d.editDraft)
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
    // M-1②（修正上轮 L6 的过度收紧）：总是把最新快照落盘——包括「合法空态」。
    //   上轮 L6 改成「!hasContent 就 draftRef.current=null; return（不写盘）」，结果【手动删空 textarea】(不走"清除内容"按钮、不设 clearedRef)
    //   时旧记录原样留存 → 刷新旧内容复活(M-1b)。空快照落盘是无害的（水合读到空 = 全新开始、不弹"已恢复"），却能覆盖旧记录防复活；
    //   分析半成品(pending*/editDraft)也随 snapshot 一并落盘(M-1a：不粘原文直接分析整本 → 刷新不丢不重烧)。draftRef 恒为快照对象，pagehide/卸载 flush 也照常写。
    draftRef.current = snapshot()
    // item12（第十轮）：检查落盘返回值——saveContinueDraft 失败返 false（backup.js 内部 catch 吞异常），原来忽略 ⟹ IDB 满时用户仍信「刷新不丢」。
    //   对齐 LongFormPage L-新7：防抖落盘失败给显式警告；pagehide/blur 的 flush(:325/:353) 仍 best-effort 不提示（那两种场景页面正在离场，弹提示也看不到）。
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
    // H-新1①：应用内切页签时 App 用 key={tab} 卸载本页，pagehide / blur 都不触发 → 600ms 防抖窗内的最后编辑会整份丢。
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

  // CP3 + H-新1②：卸载即中断——切 tab / 离开续写页后，分段资产分析(assetAbortRef)与 5 路生成(genAbortRef)的在飞请求全部 abort，
  //   不再后台白烧额度、也不再对已卸载组件 setState。genAbortRef 在挂载时建一个整个生命周期共用的 controller。
  useEffect(() => {
    mountedRef.current = true
    genAbortRef.current = new AbortController()
    return () => {
      mountedRef.current = false
      assetAbortRef.current?.abort()
      genAbortRef.current?.abort()
      copyTimersRef.current.forEach((t) => clearTimeout(t)) // L1：清复制提示定时器
      copyTimersRef.current = []
    }
  }, [])

  // 清除内容：原文 + 分析结果 + 续写指令 + 已生成版本全部归零，并删掉浏览器里保存的草稿
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
    // CP4：清除内容要连资产分析的瞬时态一起归零——否则清完还残留上次的分段任务、几个弹窗开着、过滤条停在旧值，
    //   且分析若在跑会继续后台烧额度。这里一并关掉弹窗、清 assetTask、复位过滤、中断在跑的分段循环。
    assetAbortRef.current?.abort()
    setAssetTask(null)
    setAssetAnalyzing(false)
    setUpdatesOpen(false)
    setNewOpen(false)
    setStateOpen(false)
    setAssetPromptOpen(false)
    setAssetFilter('all')
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
      // 必修4（第十一轮·同型 round-10 必修1）：导入覆盖前脏检查——当前原文非空且与将导入内容不同时先 confirm，
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
    // 第一档③修：重新分析会用 AI 结果整表覆盖 world/outline/characters/timeline（含用户手改的），这些入了草稿、无恢复入口，
    //   且 staleAnalysis 提示会主动劝用户"再点一次分析原文"。与必修4(导入覆盖)/存疑1(二次分析)同口径：已有内容时先 confirm（放在烧 token 的分析之前），取消则不分析、不烧额度。
    if (world || outline || characters.length || timeline.length) {
      if (!window.confirm('重新分析会用新的 AI 结果替换当前的世界观 / 大纲 / 人物卡 / 故事线（包括你手动改过的内容），且无法撤销。确定继续吗？')) return
    }
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
      // 用户需求(第一档后续)：粘贴了原文但没选书 → 用原文自动建一本书并选中，让"分析原文 → 资产"有归属(资产 per-book、无书则按钮禁用)。
      //   续写草稿是全局单条(CONTINUE_DRAFT_ID='continue')、不按书存 → 建书+选书不会冲掉本页原文。仅"无选中书"时建(避免重复建档)；建失败不阻断世界观分析。
      if (!lib.selectedBook && text.trim()) {
        try {
          const nb = await lib.createBookFromText(text)
          lib.select(nb.id)
          setAssetMsg(`已用当前原文建档《${nb.name}》并选中——现在可以点「分析原文 → 资产」把资产存进这本书。`)
        } catch (e) {
          setErr((e && e.message) || '用原文建档失败；资产分析需先选中一本书。')
        }
      }
      const res = await chatJSON({ apiKey, messages: groups[0].messages, temperature: 0.3, signal: genAbortRef.current?.signal })
      if (!mountedRef.current) return // H-新1②：已卸载，丢弃结果不上屏
      // 必修6同型横扫：AI 结果字段归一——world_setting/outline/timeline 元素可能是对象/数组（extractJSON 不做类型归一），
      //   直接渲染(世界观/大纲/故事线 CollapseBlock)会抛「Objects are not valid as React child」，且随 continue 草稿落 IDB → 刷新持续崩。
      //   字符串字段用 typeof 守卫（对象归空、不显 [object Object]）；characters 已由 normalizeChar 归一（name/attrs 全 String），无需再处理。
      setWorld(typeof res.world_setting === 'string' ? res.world_setting : '')
      setCharacters(Array.isArray(res.characters) ? res.characters.map(normalizeChar).filter(Boolean) : [])
      setOutline(typeof res.outline === 'string' ? res.outline : '')
      setTimeline(
        Array.isArray(res.timeline)
          ? res.timeline.map((t) => (t && typeof t === 'object' ? { ...t, stage: typeof t.stage === 'string' ? t.stage : '', summary: typeof t.summary === 'string' ? t.summary : '' } : null)).filter(Boolean)
          : [],
      )
      setAnalyzed(true)
      setAnalyzedSnapshot(text) // 记住这份分析依据的原文；此后原文再变（纳入续写 / 手动编辑）就能判出分析已滞后
      if (meta.truncated) {
        setErr(`原文较长，已分析前 ${ANALYZE_LIMIT} 字。如需完整分析请拆分原文后重试。`)
      }
    } catch (e) {
      if (!mountedRef.current || e?.name === 'AbortError') return // H-新1②：卸载中断静默
      setErr(e?.message || String(e))
    } finally {
      if (mountedRef.current) setAnalyzing(false)
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
    if (!mountedRef.current) return // H-新1②：摘要期间切页卸载 → 不再弹确认窗 / setState
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '自定义续写（4 个方向并发）',
      // M2：前文摘要(仅原文超长时)是本步之前跑的不可编辑预处理，在确认窗明示，避免"数万字原文头悄悄直发模型"不透明
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 个方向的续写提示词，可查看 / 编辑。' : '',
      groups: CONTINUE_ANGLES.map((a, i) => ({
        label: `版本${i + 1}（${a.title}）`,
        messages: continueMessages({ text: tail, summary, world, characters: charText, outline, timeline, instruction, index: i, forbidden: lib.style?.forbidden }), // item13：禁用词数据驱动注入(B 已接 forbiddenBlockOf)，来源=当前绑定文风档案 lib.style?.forbidden；空/未绑书即 undefined→forbiddenBlockOf 返回空串、行为同修前
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
              signal: genAbortRef.current?.signal, // H-新1②：卸载时统一 abort
              onDelta: (full) => {
                if (!mountedRef.current) return
                setVersions((prev) => {
                  const next = [...prev]
                  next[i] = { title: a.title, content: full }
                  return next
                })
              },
            })
            if (!mountedRef.current) return
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, content }
              return next
            })
          } catch (e) {
            if (!mountedRef.current || e?.name === 'AbortError') return // 卸载中断：不写错误版本、不上屏
            setVersions((prev) => {
              const next = [...prev]
              next[i] = { title: a.title, error: e?.message || String(e) }
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
    if (!mountedRef.current) return // H-新1②：摘要期间切页卸载 → 不再弹确认窗 / setState
    const charText = charsToText(characters)
    setPromptConfirm({
      title: '探索后续（4 种剧情走向并发）',
      // M2：同自定义续写——前文摘要为不可编辑预处理，在确认窗明示
      note: summary ? '原文较长，已先对前文做了一次摘要压缩（不可编辑的预处理，未单独弹窗）；下面是 4 种走向的提示词，可查看 / 编辑。' : '',
      groups: FOLLOWUP_ANGLES.map((a, i) => ({
        label: `走向${i + 1}（${a.title}）`,
        messages: followupMessages({ text: tail, summary, world, characters: charText, outline, timeline, index: i, forbidden: lib.style?.forbidden }), // item13：同上，禁用词来源 lib.style?.forbidden，空即 0 字
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
              signal: genAbortRef.current?.signal, // H-新1②：卸载时统一 abort
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
    // L1：copyText 返回 true/false（clipboard 不可用且 execCommand 也失败时 false）——原来不看返回值恒显「已复制 ✓」是假成功；
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
      groups: [{ label: '改写提示词', messages: incorporateReviseMessages({ context: text.replace(/\s+$/, '').slice(-1200), text: before, note, forbidden: lib.style?.forbidden }) }], // item13：禁用词来源 lib.style?.forbidden，空即 0 字
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
        signal: genAbortRef.current?.signal, // H-新1②：卸载时统一 abort
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

  // —— 资产库（续写页）：分段分析原文 → 查看勾选落库 → 点击编辑 / 手动新增，存进所选书记录（浏览器缓存）——
  const selectedBook = lib.selectedBook
  // B33：整本 content 的字数是 O(n)（content 可达百万字），原在 JSX(:1337 数据源提示) 里每次渲染重算；用 useMemo 按 content 缓存，切书/改原文才重算。
  const bookWordCount = useMemo(() => countWords(selectedBook?.content || ''), [selectedBook?.content])
  // 阶段1(设计 §7 1.3②)：CRUD / links / 落库统一走 useAssets，不再页内自持 assetsLocal + 每次改动整表写盘。
  //   autoCommitMs=400：连续变更(如透出章逐字输入)合并成一次写盘(缓解 M29)；未选书时 useAssets 只留在本页并提示，不抛错。
  //   落库走 useAssets 默认路径(put('books', {...book, assets})) + onPersisted 里 lib.refresh()，与切书/删书的刷新口径一致。
  const libRefresh = lib.refresh
  const libSyncBook = lib.syncBook
  const onAssetsPersisted = useCallback(
    async (nb) => {
      // P1-6：commit 会透传刚写盘的那本书 nb → 只定点更新内存里这一本，不再整库 getAll+normalize（连续编辑每 400ms 一次全库读会卡）。
      //   切书 flush 等不传 nb 的路径退回全量 refresh，口径不变。
      if (nb && nb.id && libSyncBook) libSyncBook(nb)
      else await libRefresh()
    },
    [libSyncBook, libRefresh],
  )
  // useAssets 的提示接进本页 assetMsg，但吞掉 debounce 落库那句通用「资产已保存」——
  // 否则它会在 400ms 后盖掉刚给出的结算摘要(如「已结算落库：状态变更 3 条…」)。失败提示照常透出。
  const onAssetMsg = useCallback((m) => {
    if (m && m !== '资产已保存') setAssetMsg(m)
  }, [])
  const ua = useAssets({ book: selectedBook, onPersisted: onAssetsPersisted, idPrefix: 'cx', autoCommitMs: 400, onMessage: onAssetMsg })
  const assets = ua.assets
  // L-1：这几处原来每次渲染都重算——大书(百万字)时 chunkSource 复制整本、资产多时 computeAssetWarnings/duplicateNameGroups/filterAssets 全表扫描，
  //   打字/流式生成每帧都跑 → 卡顿；且 assetBook 每渲染新建对象会让 AssetModal 的 useMemo(…,[book]) 失效。全部加 useMemo 稳定引用。
  const assetBook = useMemo(() => ({ ...(selectedBook || {}), assets }), [selectedBook, assets])
  const perVol = perVolOf(assetBook)
  // 侧栏清单跟随分类筛选（与资产库弹窗同一份 filterAssets 判据，含「⚠ 待补全」虚拟类）
  const shownAssets = useMemo(() => ua.filtered(assetFilter), [ua.filtered, assetFilter])
  // L17 消费侧：同书重名组数（duplicateNameGroups 归一名分组，名全唯一→[]）。资产库头部给一行提示，
  //   提醒用户去合并/改名（真正的拦截+二次确认在 NewAssetModal / EditAssetModal 提交时）。
  const dupeGroupCount = useMemo(() => duplicateNameGroups(assets).length, [assets])
  const assetWarnings = useMemo(() => computeAssetWarnings(assets), [assets])
  // L-1：分段数只随原文/整本内容变化，不必每渲染对整本 O(n) 切段（chunkSource 会复制出整段数组，只为取 .length 太浪费）
  const textSegCount = useMemo(() => chunkSource(text).length, [text])
  const bookSegCount = useMemo(() => chunkSource((selectedBook && selectedBook.content) || '').length, [selectedBook])

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
    // 存疑1（第十轮·用户拍板）：重新分析会用新结果整表覆盖 pending*（保留「整本重分析→覆盖」语义，**不改成追加**）——
    //   但覆盖前若上次分析还有未采纳/未落库的结果，先确认，避免静默丢已烧额度的结果。confirm 放在 chunkSource/发送**之前**（烧 token 前），
    //   用户可取消、先去勾选落库上次结果再重分析。（ContinuePage 只有 4 个 pending 数组；hookMoves 仅报数不落库，无 pendingHook。）
    const pendingCount = pendingUpdates.length + pendingNew.length + pendingState.length + pendingFlow.length
    if (pendingCount > 0 && !window.confirm(`上次分析还有 ${pendingCount} 条结果未采纳 / 未落库，重新分析会把它们替换掉。确定继续吗？（可先取消，去勾选落库上次的结果）`)) {
      return
    }
    const chunks = chunkSource(src)
    const msgs = analyzeAssetsMessages({
      roster: assets.map((a) => ({ name: a.name, type: a.type, detail: a.detail })),
      source: chunks[0] || '',
      // item35（统筹裁定·参数化）：续写页分析的是整本/粘贴原文的切片、非按章 → unit='段'（提示词叙述改「本段原文」），
      //   chapterLine 取代原来对续写页谎称的「第 0 章」。用「共 M 段·本段为其中一段」而非「第 N 段」：提示词模板只建一次(段1)，
      //   第 2..N 段由 swapSource 只换原文、不复建模板，写死 N 会对后续段失真；且段号不影响 AI 提取，故用对所有段都成立的措辞。
      unit: '段',
      chapterLine: `【分析范围】整本/粘贴原文，按 ${chunks.length} 段逐段分析（本段为其中一段，非单独一章）；无章号可依据时「生效章/章号」列填 0`,
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
  const runAssetAnalyze = async (firstReply, editedUser, firstInfo) => {
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
    const truncSegs = [] // CP4：被截断的段号（finishInfo.truncated/incomplete）——原来静默并入 full，用户看不出哪段没跑完
    // item23：首段(第1段)在 PromptEditorModal 里生成、不经下面的 i=1..N 循环，其截断状态由 onAdopt 回传的 firstInfo.truncated 携带——
    //   首段被截断/未完整结束时把段号 1 也纳入 truncSegs，否则漏报第1段（modal 的 truncated 已含 finish.truncated||incomplete||abort/timeout 半截）。
    if (firstInfo && firstInfo.truncated) truncSegs.push(1)
    try {
      for (let i = 1; i < chunks.length; i += 1) {
        setAssetMsg(`分析中… 第 ${i + 1}/${chunks.length} 段（每段 ${ASSET_CHUNK} 字）`)
        try {
          // H5：结构化资产提取统一 temperature 0.3（与第 1 段弹窗一致；原第 2..N 段用 chatStream 默认 0.9，口径不一且对结构化提取偏高）
          // H6：传 signal，单段失败/中断不整批废——用已成功段出部分结果
          // CP4：每段与第 1 段弹窗同口径传 maxTokens:16000 + finishInfo，否则后续段走 provider 默认上限、截断了也静默并入 full
          const segFinish = {}
          const r = await chatStream({
            apiKey,
            temperature: 0.3,
            maxTokens: 16000,
            finishInfo: segFinish,
            signal: ctrl.signal,
            messages: [
              { role: 'system', content: task.system },
              { role: 'user', content: swapSource(editedUser || task.user, chunks[i]) },
            ],
          })
          full += `\n${r || ''}`
          doneSegs += 1
          if (segFinish.truncated || segFinish.incomplete) truncSegs.push(i + 1)
        } catch (segErr) {
          stopped =
            segErr?.name === 'AbortError'
              ? `已中断，保留前 ${doneSegs}/${chunks.length} 段结果`
              : `第 ${i + 1} 段失败(${segErr?.message || segErr})，保留前 ${doneSegs}/${chunks.length} 段结果`
          break
        }
      }
      // L：卸载(切页)守卫——assetAbortRef 已在卸载 effect 里 abort，段内 chatStream 抛 AbortError → 内层 catch break 到这里；
      //   若已卸载就不再 parseAnalyze / setPending* / setAssetMsg（React18 下对已卸载 setState 虽是静默 no-op，但为与 5 路生成口径完全统一，显式拦掉）。
      if (!mountedRef.current) return
      const parsed = parseAnalyze(full)
      // CP2：多段合并后同一资产会重复产出——按 key 去重再入预览，避免重复行与 hold/rel 重复 push（口径对齐 LongFormPage mergeSeg）
      const updates = dedupBy(parsed.updates || [], (u) => `${u.name}|${u.info}|${u.state}`)
      const newAssets = dedupBy(parsed.newAssets || [], (n) => `${n.name}`)
      const stateChanges = dedupBy(parsed.stateChanges || [], (s) => `${s.name}|${s.dimKey}|${s.state}|${s.since}`)
      const flows = dedupBy(parsed.flows || [], (f) => `${f.person}|${f.change}|${f.asset}|${f.ch}`)
      setPendingUpdates(updates)
      setPendingNew(newAssets)
      setSelUp(updates.map((_, i) => i))
      setSelNew(newAssets.map((_, i) => i))
      setPendingState(stateChanges)
      setPendingFlow(flows)
      setSelState(stateChanges.map((_, i) => i))
      setSelFlow(flows.map((_, i) => i))
      const segNote =
        chunks.length > 1
          ? `（原文 ${task.total} 字，分 ${chunks.length} 段每段 ${ASSET_CHUNK} 字${stopped ? `，实际完成 ${doneSegs} 段` : '全量分析'}）`
          : `（原文 ${task.total} 字，一段取完）`
      setAssetMsg(
        `${stopped ? stopped + '：' : '分析完成'}${segNote}已有资产更新 ${updates.length} 条、新资产 ${newAssets.length} 条、状态变更 ${stateChanges.length} 条、资产流转 ${flows.length} 条` +
          (parsed.hookMoves && parsed.hookMoves.length ? `；伏笔推进 ${parsed.hookMoves.length} 条（续写页不持有伏笔表，仅报数不落库）` : '') +
          (truncSegs.length ? `。注意：第 ${truncSegs.join('、')} 段回复可能被截断，结果或不全` : '') +
          '。查看勾选后才落库。',
      )
    } catch (ex) {
      if (!mountedRef.current || ex?.name === 'AbortError') return // L：卸载中断静默，不上屏
      setAssetMsg(`分析失败：${ex?.message || String(ex)}`)
    } finally {
      if (mountedRef.current) setAssetAnalyzing(false) // L：卸载后不复位（无意义），仅挂载时解除 analyzing
      assetAbortRef.current = null
    }
  }

  const applyUpdates = () => {
    // M-D2：未选书 / 书已删时不落库——否则内存脏改、commit 失败、pending 被清 + 弹窗关，用户以为已落库、刷新全丢（对齐 LongFormPage 起手守卫）
    if (!selectedBook) {
      setAssetMsg('尚未选定书籍，无法落库。请先在「我的书库」选中或导入一本小说，再落库这些更新。')
      return
    }
    const chosen = pendingUpdates.filter((_, i) => selUp.includes(i))
    // item7（第十轮）：改按「解析出的资产 id」聚合（对齐 LongFormPage:992，比原按名聚合更稳）——
    //   原按名聚合：两个不同名（本名 + 别名）经 findAssetByName 解析到**同一资产**会分成两组，各自基于同一份渲染闭包 a.detail/a.state 计算再 updateAsset，
    //   后一组覆盖前一组（勾 N 条指向同一资产只落最后 1 组）。按 id 聚合后同一资产的多条更新合并、只写一次（detail 顺序追加去重、state 依次演进）。
    const byId = new Map() // assetId -> { asset, ups:[] }
    let skipped = 0 // 第12轮a[2]·M6：名字缺失 / 名册无此资产的更新条数——原来静默丢弃无计数
    chosen.forEach((u) => {
      if (!u || !u.name) {
        skipped += 1
        return
      }
      const a = findAssetByName(assets, u.name) // CP1：容错别名/空格名，不再严格 === 静默跳过
      if (!a) {
        skipped += 1 // 名册无此资产：该条跳过计数
        return
      }
      if (!byId.has(a.id)) byId.set(a.id, { asset: a, ups: [] })
      byId.get(a.id).ups.push(u)
    })
    let doneUp = 0 // 真正写入的资产数（按 id 聚合后每个资产算一次）
    byId.forEach(({ asset: a, ups }) => {
      let detail = String(a.detail || '')
      const st = normalizeState(a.state)
      ups.forEach((u) => {
        // L-2：追加前判重，避免反复合并把同一句堆多遍
        if (u.info && !detail.includes(u.info)) detail = detail ? `${detail}｜${u.info}` : String(u.info)
        // 阶段2(设计 §5 ⑤)：粗状态词并入 plot 维度、原话留 legacy；同一资产多条按顺序演进(后者为最终态)
        const word = String(u.state || '').trim()
        const tag = STATE_V1_MAP[word] || STATE_V1_MAP[word.toLowerCase()]
        if (tag) st.plot = { ...(st.plot || {}), tag }
        if (word) st.legacy = st.legacy || word
      })
      st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: (st.meta && st.meta.sourceCh) || 0 }
      ua.updateAsset(a.id, { detail, state: st }) // item7：每个 id 只调一次（合并后），不再被同名/别名的第二组覆盖
      doneUp += 1
    })
    // M8：只移除已勾选的，未勾选的更新条目保留在池里（对齐「分析原文」路径），不再整体清空
    setPendingUpdates(pendingUpdates.filter((_, i) => !selUp.includes(i)))
    setSelUp([])
    setUpdatesOpen(false)
    // 第12轮a[2]·M6：落库后给摘要反馈——原来只清池 + 关窗、无 setAssetMsg，界面留的是上一条旧提示；
    //   名册无此资产也静默丢、无计数。对齐 applyNew / applyStateSettlement 的「实写 N / 跳过 M」口径。
    setAssetMsg(`已落库更新 ${doneUp} 个资产` + (skipped ? `（${skipped} 条因名字未建档已跳过，可先到资产库建档或核对该资产名）` : ''))
  }
  const applyNew = () => {
    // M-D2：未选书 / 书已删时不落库（同 applyUpdates）
    if (!selectedBook) {
      setAssetMsg('尚未选定书籍，无法落库。请先在「我的书库」选中或导入一本小说，再落库这些新资产。')
      return
    }
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
    // M8：只移除已勾选的，未勾选的新资产条目保留在池里，不再整体清空
    setPendingNew(pendingNew.filter((_, i) => !selNew.includes(i)))
    setSelNew([])
    setNewOpen(false)
  }

  // 状态结算落库（设计 §5 ⑤）：只写用户勾选的条目；不勾选则库里一个字节都不变。系统零判断零拦截。
  const applyStateSettlement = () => {
    // M-D2：未选书 / 书已删时不落库——原来无条件 setAssetMsg「已结算落库」+ 清 pending + 关弹窗，
    //   但 useAssets 未选书时只留内存不落库、commit 也失败 ⟹ 用户以为已落库、pending 已清、刷新全丢（对齐 LongFormPage 起手守卫）
    if (!selectedBook) {
      setAssetMsg('尚未选定书籍，无法结算落库。请先在「我的书库」选中或导入一本小说，再落库这些状态变更与流转。')
      return
    }
    const selSc = pendingState.filter((_, i) => selState.includes(i))
    const selFl = pendingFlow.filter((_, i) => selFlow.includes(i))
    // 第12轮b[1]：结算改调 B 共享层——流转落库走 applyFlowToRoster（与 LongFormPage 单一出处、产出一致：
    //   人物建档/hold、gain 建档不写 ch_reveal、holder+held_by、lose→phys lost、broken/consumed→phys broken、字段级合并全在共享函数里），
    //   名字匹配走 findAssetByName。做法：把状态变更 + 流转都累积到一份工作副本数组上，最后按 id diff 落库（每资产只写一次）。
    const origIds = new Set(assets.map((a) => a.id))
    let working = assets.map((a) => ({ ...a }))
    const touched = new Set() // 被改过的【已建档】资产 id → updateAsset
    const createdIds = new Set() // 本次结算新建的资产 id → addAsset
    // ① 状态变更（增量并入 state，保留 id 与无关维度）
    let doneSc = 0
    let scSkip = 0
    selSc.forEach((sc) => {
      // M4：名字缺失 / dimKey 未识别 → 跳过不落库（预览行已标「维度未识别 · 本条不落库」）
      if (!sc || !sc.name || !sc.dimKey) {
        scSkip += 1
        return
      }
      const a = findAssetByName(working, sc.name)
      if (!a) {
        scSkip += 1 // 名册无此资产
        return
      }
      // L-新1：生效章兜底优先条目自带的 fromCh、再兜底 0——与 A 区 LongFormPage 状态变更段同口径（两页一致）。
      //   注：续写页分析走 chapterNo:0（整本/粘贴原文、非按章），dedupBy 也不打 fromCh，故此处 sc.fromCh 现为 undefined、
      //   表达式等价于原 `sc.since || 0`（无行为变化）；加上是为与长篇页统一、且日后若给续写页状态变更打 fromCh 即自动生效。
      a.state = applyStateChange(a.state, sc, sc.since || sc.fromCh || 0)
      touched.add(a.id)
      doneSc += 1
    })
    // ② 资产流转：逐条累积调 applyFlowToRoster（reducer 口径见 assets.js 注释），新建/命中由共享函数解析
    let doneFl = 0
    let flSkip = 0
    let newItem = 0
    let newPerson = 0
    selFl.forEach((fl) => {
      if (!fl || !fl.asset) {
        flSkip += 1
        return
      }
      const r = applyFlowToRoster(working, fl, { idPrefix: 'cx' })
      working = r.assets
      ;(r.created || []).forEach((c) => {
        createdIds.add(c.id)
        if (c.type === 'person') newPerson += 1
        else newItem += 1
      })
      if (r.personId && origIds.has(r.personId)) touched.add(r.personId)
      if (r.targetId && origIds.has(r.targetId)) touched.add(r.targetId)
      if (r.skipped) flSkip += 1
      else doneFl += 1
    })
    // ③ 落库：新建走 addAsset（已带 id，normalizeAsset 保留）、改过的已建档走 updateAsset（传整条，内部 normalizeAsset 合并）
    const byId = new Map(working.map((a) => [a.id, a]))
    createdIds.forEach((id) => {
      const asset = byId.get(id)
      if (asset) ua.addAsset(asset, { idPrefix: 'cx' })
    })
    touched.forEach((id) => {
      const asset = byId.get(id)
      if (asset) ua.updateAsset(id, asset)
    })
    const createdNote = newItem || newPerson ? `（新入表 ${[newItem ? `${newItem} 个道具` : '', newPerson ? `${newPerson} 个人物` : ''].filter(Boolean).join('、')}）` : ''
    const skips = [
      scSkip > 0 ? `状态变更 ${scSkip} 条跳过(名册无此资产 / 维度未识别)` : '',
      flSkip > 0 ? `流转 ${flSkip} 条跳过(资产对不上 / 动作未识别)` : '',
    ].filter(Boolean)
    setAssetMsg(
      `已结算落库：状态变更 ${doneSc} / 资产流转 ${doneFl}${createdNote}` +
        (skips.length ? `；${skips.join('、')}` : ''),
    )
    // M8：只从池里移除【已勾选】的，未勾选的保留（对齐「分析原文」路径的 filter 保留语义）——原来整体清空会把没勾的一起丢掉
    setPendingState(pendingState.filter((_, i) => !selState.includes(i)))
    setPendingFlow(pendingFlow.filter((_, i) => !selFlow.includes(i)))
    setSelState([])
    setSelFlow([])
    setStateOpen(false)
  }

  // 结算预览的只读辅助：旧值(该维度当前状态的中文说法)，让用户看得见改了什么(设计 §5 ④)
  const oldStateWord = (sc) => {
    const a = findAssetByName(assets, sc.name) // CP1：容错别名/空格名，预览「旧值」不再误显示 (未建档)
    if (!a) return '(未建档)'
    const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
    const dim = sc.dimKey
    // inferred（B区第三路推定的裸词/动词短语，如「前往昆仑」）：ref 不是确定地名，加「在」会变成「在前往昆仑」语病 + 假「已到达」——
    //   与 B区 placePhrase 对 inferred 的处理同口径：不加断言位置的前缀、直接渲染原词。
    if (dim === 'place') return st.place && st.place.ref ? (st.place.inferred ? st.place.ref : `在${st.place.ref}`) : '(未记录)'
    if (dim === 'hold') return `持有 ${(st.hold || []).filter((h) => h.change === 'gain' || !h.change).map((h) => h.name).filter(Boolean).join('、') || '(无)'}`
    const o = st[dim]
    if (!o) return '(未记录)'
    return o.note || (o.tag ? stateLabel(dim, o.tag) : '(未记录)')
  }
  const assetExists = (name) => !!findAssetByName(assets, name) // CP1：容错别名/空格名，与结算落库口径一致

  const updateAsset = (id, patch) => ua.updateAsset(id, patch)
  const deleteAsset = (id) => ua.deleteAsset(id)
  const openEdit = (a) =>
    setEditDraft({
      ...a,
      knowersStr: (a.knowers || []).join('、'),
      aliasesStr: (a.aliases || []).join(', '),
      // P1-12：controller 是「表单临时字段」不落库（normalizeAsset 只把它转成 controlled_by 边、不存字段），
      //   故打开时从已有的 controlled_by 边反推出初值，EditAssetModal 的「控制者」输入框才有内容、保存不丢边。
      controller: a.controller != null ? a.controller : ((a.links || []).find((l) => l.type === 'controlled_by') || {}).to || '',
    })
  const saveEdit = () => {
    if (!editDraft) return
    // 第12轮b[4]：保存改调 B 共享层 saveEditAsset（= normalizeAsset({...orig, ...edited})），与 LongFormPage 单一出处一致。
    //   holder/controller 在 editDraft 里即生效；派生边(held_by/located_in/controlled_by)由 normalizeAsset→rebuildDerivedEdges
    //   按 derived 标记统一重算（strip 旧派生边、保手建边、按最新 holder/place/controller 重建）。
    //   故删掉之前 C 侧手写的 DERIVED_LINK_TYPES 按类型剔除——那会误删用户手建的同类型边，且与 B 的标记机制重复。
    const next = saveEditAsset(
      editDraft,
      {
        aliases: editDraft.aliasesStr != null ? editDraft.aliasesStr : editDraft.aliases,
        knowers: editDraft.knowersStr != null ? editDraft.knowersStr : editDraft.knowers,
        ch_reveal: Number(editDraft.ch_reveal) || 0,
        ch_rumor: Number(editDraft.ch_rumor) || 0,
      },
      { idPrefix: 'cx' },
    )
    updateAsset(editDraft.id, next)
    setEditDraft(null)
  }

  // P1-11：改名撞上名册里另一条已有资产、用户选「合并」时——把当前编辑草稿增量并入命中的那条（mergeAsset 保留其 id，
  //   指向它的关系边不断），再删掉被改名的这条，最终只剩一条，不再出现两条同名。
  const mergeEdit = (draft, hit) => {
    if (!draft || !hit || hit.id === draft.id) return
    // 第12轮b[4]：与 saveEdit 同走 B 共享层 saveEditAsset（单一出处，派生边由 rebuildDerivedEdges 统一重算）
    const next = saveEditAsset(
      draft,
      {
        aliases: draft.aliasesStr != null ? draft.aliasesStr : draft.aliases,
        knowers: draft.knowersStr != null ? draft.knowersStr : draft.knowers,
        ch_reveal: Number(draft.ch_reveal) || 0,
        ch_rumor: Number(draft.ch_rumor) || 0,
      },
      { idPrefix: 'cx' },
    )
    ua.mergeAsset(hit.id, next)
    deleteAsset(draft.id)
    setEditDraft(null)
    setAssetMsg(`已把这条合并进《${hit.name}》（保留其 id 与关系边）`)
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
    if (!name) return { ok: false, msg: '没有名字' }
    // 与 A 区对齐：去掉 force:true、走 addAsset 的查重——同名不静默重复建档（原 force 会绕过查重，别名/归一差异下可能建出重名脏资产）。
    //   「顺便建档」按钮本就只对 isDangling(未建档) 的目标显示，正常流程不会命中查重；命中说明已存在，直接提示、不重复建。
    const r = ua.addAsset(normalizeAsset({ name, type: typeKeyOf(type) || 'person' }, { idPrefix: 'cx' }), { idPrefix: 'cx' })
    if (r && r.ok) setAssetMsg(`已顺便建档《${name}》（只有名字，其余字段可后补）`)
    else if (r && r.reason === 'duplicate') setAssetMsg(`名册里已有「${name}」，未重复建档（关系边会直接指向它）`)
    else setAssetMsg(`「${name}」建档未成功${r && r.msg ? `：${r.msg}` : ''}`)
    return r // M-C：把结果回传给 LinkEditor，建档失败时它不乐观标记「已建档」（回滚提示）
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
              <h3 className="flex items-center gap-2 text-sm font-bold">
                <span>
                  <Ic n="library" /> 资产库（{assets.length}）
                </span>
                {dupeGroupCount > 0 && (
                  <span
                    className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
                    title="同书存在重名资产，关系边与悬空判定会歧义，建议合并或改名（新建 / 改名时也会二次确认）"
                  >
                    {dupeGroupCount} 组重名
                  </span>
                )}
              </h3>
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
                    title={`把本页原文从头到尾每 ${ASSET_CHUNK} 字一段发给 AI，逐段提取资产与状态；发送前可先看/改提示词`}
                    className="rounded-lg bg-red-700 px-3 py-1.5 text-xs text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {assetAnalyzing ? '分析中…' : '分析原文 → 资产'}
                  </button>
                  {/* H6：分段分析可中断——assetAbortRef 的 signal 已传进每段 chatStream，点「停止」即 abort；已跑完的段保留为部分结果(runAssetAnalyze 的 break 分支) */}
                  {assetAnalyzing && (
                    <button
                      onClick={() => assetAbortRef.current?.abort()}
                      className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
                    >
                      停止
                    </button>
                  )}
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
                    ? `数据源：本页原文 ${wordCount} 字，从头到尾每 ${ASSET_CHUNK} 字一段（共 ${textSegCount} 段，不足一段取完）全量分析`
                    : selectedBook && selectedBook.content
                      ? `数据源：本页未粘贴原文，将分析整本《${selectedBook.title || selectedBook.name}》（约 ${bookWordCount} 字、${bookSegCount} 段）——段数多、耗时长、消耗额度大`
                      : '数据源：尚未粘贴 / 导入原文'}
                  {selectedBook ? '' : '；未选书时不落库'}
                </p>
                {!selectedBook && <p className="mt-2 text-xs text-stone-400">先在「我的书库」选中或导入一本小说，资产会存进这本书；<b>或直接在本页粘贴原文后点上方「分析原文」，会自动用原文建档并选中</b>，之后即可「分析原文 → 资产」。</p>}
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
                      setCollapsed({ world: anyOpen, chars: anyOpen, outline: anyOpen, timeline: anyOpen })
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
              total={text.length}
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
                // P2：并发生成时 versions 可能有空洞（next[i]= 先填了高下标），持久化后空洞被 JSON 变成 null；
                //   非生成态下跳过空洞，避免渲染出只有标题的「空白卡」。保留下标不压缩，incorporated 的 v${i} 对齐不错位。
                if (!v && !generating) return null
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
                  // P2：同续写版本——跳过持久化后残留的空洞(null)，非生成态不渲染空白卡；下标不压缩以对齐纳入状态
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
        onAdopt={(reply, prompt, info) => {
          runAssetAnalyze(reply, prompt, info) // item23：透传首段 finish 标志，runAssetAnalyze 据此把第1段纳入 truncSegs
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
        warnings={assetWarnings}
        perVol={perVol}
        filter={assetFilter}
        onFilterChange={setAssetFilter}
      />
      <EditAssetModal
        editDraft={editDraft}
        setEditDraft={setEditDraft}
        onClose={() => setEditDraft(null)}
        onSave={saveEdit}
        onMerge={mergeEdit}
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
        assets={assets}
        perVol={perVol}
        chapterNo={0}
        idPrefix="cx"
        onSubmit={handleAssetSubmit}
        onClose={() => setNewAssetOpen(false)}
        onQuickCreate={quickCreateAsset}
      />
      {updatesOpen && (
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setUpdatesOpen(false)} role="dialog" aria-modal="true" aria-label="已有资产更新">
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
                    {/* L8：AI 返回的状态词若不在这 5 个固定项里，受控 <select> 无匹配 option → 显示空白/首项但真实值仍是原词(显示≠落库)。
                        补一个「原词」兜底 option，保证当前值始终可见、与落库一致（与 LinkEditor TypeSelect 的 M-F 兜底同口径）。 */}
                    {u.state && !STATE_WORDS_CN.includes(u.state) && <option value={u.state}>{u.state}（原词）</option>}
                    {STATE_WORDS_CN.map((s) => (
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
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setNewOpen(false)} role="dialog" aria-modal="true" aria-label="新资产">
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
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4" onClick={() => setStateOpen(false)} role="dialog" aria-modal="true" aria-label="状态结算预览">
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
                    {/* M4：维度未识别(dimKey 缺失)的条目落库时会被跳过，这里提前标红告知，避免用户以为已生效 */}
                    {!sc.dimKey && <span className="rounded bg-red-50 px-1 py-0.5 text-[10px] text-red-600">维度未识别 · 本条不落库</span>}
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
                  <label key={`f${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selFlow.includes(i)} onChange={(e) => setSelFlow(e.target.checked ? [...selFlow, i] : selFlow.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{fl.person}</span>
                    <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-600">{fl.changeRaw || fl.change}</span>
                    {/* 第12轮b·M7：识别不出动作(change 空)时给「动作」下拉让用户改——原来只有红字提示、无可改控件，落库只记原词进 note。
                        决策#1：绝不猜 gain（会把「失去」记成语义反转）。与 LongFormPage 预览控件对齐。 */}
                    {!fl.change && (
                      <span className="flex items-center gap-1 text-red-400">
                        动作未识别，请改
                        <select
                          value=""
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPendingFlow((p) => p.map((x, j) => (j === i ? { ...x, change: e.target.value } : x)))}
                          className="rounded border border-stone-300 bg-paper px-1 py-0.5 text-stone-700"
                          aria-label="流转动作"
                        >
                          <option value="">选择动作</option>
                          {[['gain', '获得'], ['lose', '失去'], ['broken', '损坏'], ['consumed', '消耗'], ['transferred', '易主']].map(([v, lab]) => (
                            <option key={v} value={v}>
                              {lab}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                    <span className="text-stone-700">{fl.asset}</span>
                    {/* 第12轮b·M7：gain 且未建档时给「类型」下拉——原来落库 type 恒 item，灵兽/地点/势力被建成道具。
                        用户选的类型写进 fl.assetType，applyFlowToRoster 建档时 typeKeyOf(fl.assetType) 生效。与 LongFormPage 对齐。
                        决策③消费侧：parseAnalyze 解析出的 fl.assetType 在此【预填】select 初始值——经 typeKeyOf 归一，
                        兼容解析值是 key(person)/中文标签(人物)/同义词三种形态，都能落到 ASSET_TYPES 里对应 option 而不空白；
                        fl.assetType 为空(undefined/'')时回退 item，与 applyFlowToRoster 的 typeKeyOf(fl.assetType||'item') 口径一致。
                        用户 onChange 手选写入的是合法 key，覆盖解析值 → 手选优先级高于解析值(解析值只作初始预填)。 */}
                    {fl.asset && fl.change === 'gain' && !assetExists(fl.asset) && (
                      <span className="flex items-center gap-1 text-amber-700">
                        未建档，落库建为
                        <select
                          value={fl.assetType ? typeKeyOf(fl.assetType) : 'item'}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPendingFlow((p) => p.map((x, j) => (j === i ? { ...x, assetType: e.target.value } : x)))}
                          className="rounded border border-stone-300 bg-paper px-1 py-0.5 text-stone-700"
                          aria-label="新资产类型"
                        >
                          {ASSET_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {ASSET_TYPE_LABEL[t] || t}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                    {fl.asset && (fl.change === 'broken' || fl.change === 'consumed' || fl.change === 'lose') && <span className="text-stone-400">（标注不删）</span>}
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
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
          // M1(P1-16 同口径)：已编辑过提示词则遮罩不响应——避免误点遮罩一下把改过的 4 组提示词全丢。✕ / 取消 仍可关(明确操作)。
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
    </div>
  )
}
