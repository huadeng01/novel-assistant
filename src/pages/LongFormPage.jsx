import { useEffect, useMemo, useRef, useState } from 'react'
import { getAll, getById, put } from '../lib/db.js'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
import AssetGraphModal from '../components/AssetGraphModal.jsx'
import AssetModal from '../components/AssetModal.jsx'
import EditAssetModal from '../components/EditAssetModal.jsx'
import { exportDocument, readDocumentFile, READ_ACCEPT, EXPORT_FORMATS } from '../lib/docio.js'
import { LANG_RULE, sanitizeHabits, analyzeAssetsMessages } from '../lib/prompts.js'
// LF-4：移除死 import（parseAssetTable/digestLines/LINK_LABEL 全文未用）；LF-1：移除 chatStream（分析原文改用弹窗已生成的 reply，不再页内直发第二次请求）
import { parseExpandAssets, parseBookAssets, backfillChapterNos, computeAssetWarnings, parseRelations, parseAnalyze, buildLinks, revealChapterOf, rumorChapterOf } from '../lib/parseAssets.js'
// 资产库阶段2：paraBandFor(段长带宽，worldviews 单一出处) + assets.js 纯函数层(状态口语化注入/规范化/perVol 单一出处/新增资产判据)
// B-H3：worldviews 用 namespace 导入——paraBandFor 已确定存在；avgParaLenFor(book) 由 B 本轮导出(从题材 GENRE_STYLE_TABLE 或绑定文风 metrics 推真值)，
// 用运行时探测接入(namespace 不会因缺具名导出而崩 build)：B 导出后自动生效，未导出则回退 book.avgParaLen。
import * as worldviews from '../lib/worldviews/index.js'
import { stateToPromptLine, perVolOf, normalizeState, normalizeAsset, splitListValue, ASSET_TYPES, ASSET_TYPE_LABEL, STATE_V1_MAP, STATE_LABEL, stateLabel, dashOut, dashOnly, applyStateChange, typeKeyOf, tagForWord, TYPE_BY_LABEL } from '../lib/assets.js'
import NewAssetModal from '../components/NewAssetModal.jsx'

const { paraBandFor } = worldviews

// 长篇写作工作台：中栏写作区 + 可收缩抽屉(章节树) + 弹窗(资产库/图谱/分析原文/编辑资产)。
// 收纳统一为"按钮触发抽屉/弹窗"，按钮样式统一 genBtn/ghostBtn 小按钮，不用全宽长条。
const box = 'w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 text-sm leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const line = 'rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const label = 'mb-1 block text-xs font-medium text-stone-500'
const genBtn = 'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40'
const ghostBtn = 'rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:bg-stone-100'
// 长篇页编辑草稿在 drafts store 的 id：按 bookId 分槽（lf_current:${bookId}），每本书一条，存最后编辑的那一章，防切页签/刷新丢失（H11）。
// LF-2：原单槽 lf_current 在切书时会被新书草稿覆盖 → 旧书未保存正文丢失；分槽后各书草稿互不覆盖，切回原书能恢复。
const lfDraftKey = (bookId) => `lf_current:${bookId}`
// 5.5 章节版本历史：每章最多保留的旧正文快照数，超出丢弃最旧的一版
const HISTORY_MAX = 5

// 结算落库纯函数（TYPE_BY_LABEL/typeKeyOf/tagForWord/applyStateChange）已收敛到 assets.js 单一出处、本页 import 复用。
// A11：曾在 LongFormPage 与 ContinuePage 各存一份、口径靠注释维系一致，是回归高发点 ⟹ 去重到 assets.js。

const expandPrompt = (book) => {
  const namesOf = (t) => ((book && book.assets) || []).filter((a) => a.type === t).map((a) => a.name).join('、') || '(无)'
  return [
    '你是设定扩充编辑。基于下面的故事框架与已建档名册，批量补充次要资产，让资产表更丰富。每行用｜分隔字段，通篇用｜分列行呈现。',
    LANG_RULE,
    '硬约束：控制方/所属地域/持有者/出处指向已有实体时，从下面名册里选准确名字，名册外的一律填"无主"或"未知"；新势力先进【次要势力】段建档再引用。',
    '【次要人物】至少8至20个，每行：姓名｜身份一句｜与主线关系一句｜高光事件一句｜透出卷',
    '【地点】至少10至30个，每行：地点名｜所属地域(须是名册地点或框架地域)｜功能一句｜控制方(须是名册势力/人物或"无主")｜透出卷',
    '【道具】至少5至15个，每行：道具名｜持有者(须是名册人物或"无主")｜功能一句｜出处(须是名册地点)｜透出卷',
    '【次要势力】3-8方，每行：势力名｜立场+资源｜与主角关系｜功能位｜透出卷',
    '只输出以上四段｜分列行。',
    '',
    '故事框架(创作简报)：',
    (book && book.brief) || '(无)',
    '',
    '已建档人物名册：',
    namesOf('person'),
    '',
    '已建档势力名册：',
    namesOf('faction'),
    '',
    '已建档地点名册：',
    namesOf('place'),
    '',
    '已建档道具名册：',
    namesOf('item'),
  ].join('\n')
}

const relationPrompt = (book) =>
  [
    '你是关系网编辑。下面名册是本书已建档的全部资产名字。关系边只建立在名册名字之间，名册外的名字留在名册之外。',
    '每行一条边：资产A名｜关系｜资产B名。关系用中文词：持有/位于/隶属/控制/受控于/出处/盟友/敌对/亲属/对手/关联/统领。',
    '产出人物间关系边(盟友/敌对/亲属/对手)至少10条，并补全明显缺失的人物-道具/人物-地点/势力-地点绑定边。',
    '只输出边行。',
    '',
    '资产名册：',
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})`).join('、'),
  ].join('\n')

const analyzePrompt = (book, chapterNo, sourceText) =>
  [
    '你是设定分析编辑。读下面的原文片段，对照已建档资产名册，产出两类信息。每行用｜分隔，通篇用｜分列行呈现。',
    LANG_RULE,
    '【已有资产更新】原文里已建档资产的新信息或状态变化，每行：资产名(须用名册准确名字)｜更新内容一句｜新状态(活跃/死亡/毁坏/隐藏/升迁)',
    '【新资产】原文里出现但未建档的人物/地点/道具/势力，每行：类型(person/place/item/faction)｜名字｜描述一句｜透出章',
    '只输出以上两段｜分列行；某段没有内容时，段下写"无"。',
    '',
    `本章章号：${chapterNo}`,
    '',
    '已建档资产名册：',
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})`).join('、') || '(无)',
    '',
    '原文：',
    sourceText,
  ].join('\n')

// 续排下一卷的排章纪律（与新手写作第7/8步同源：按资产表透出卷登场，不为凑数提前拉后面的资产）
const NEXT_VOL_RULES = [
  '回溯锚：本章首次透出的资产，其透出卷早于或等于本卷；透出卷晚于本卷的资产以传闻出现，或留到其透出卷再登场。',
  '资产登场以资产表标明的透出卷为准，只排入透出卷早于或等于本卷的资产；不为凑数提前拉后面才透出的资产登场。',
  '每章任务各有分工；按事件密度排章；每章都推进主线、塑造人物、兑现爽点其中之一，只列有实际内容的章。',
]

// 从大纲提取指定卷的【分卷结构表】本卷行 + 【每卷事件节点】(vol.x) —— 续排下一卷的粗粒度依据
const outlineNodesOfVol = (outline, vol) => {
  const keep = []
  let inStruct = false
  let inNodes = false
  for (const raw of String(outline || '').split('\n')) {
    const l = raw.trim()
    if (l.includes('【分卷结构表】')) { inStruct = true; inNodes = false; continue }
    if (l.includes('【每卷事件节点】')) { inNodes = true; inStruct = false; continue }
    if (l.startsWith('【') || /^#{1,3} /.test(l)) { inStruct = false; inNodes = false; continue }
    if (!l) continue
    if (inStruct && (l.startsWith(`${vol}｜`) || l.startsWith(`${vol}|`))) keep.push(l)
    if (inNodes && new RegExp(`^${vol}\\s*[.．]`).test(l)) keep.push(l)
  }
  return keep.join('\n')
}

// 卷章表末3章（续排时承接结尾钩子与人物处境）
const volumesTail3 = (volumes) =>
  String(volumes || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[｜|]/.test(l))
    .slice(-3)
    .join('\n')

// 卷号数字解析（LF-6，覆盖阿拉伯与中文 1–99）
const cnVolNo = (s) => {
  const t = String(s || '').trim()
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10)
  if (!/^[一二三四五六七八九十]+$/.test(t)) return 0
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const shi = t.indexOf('十')
  if (shi < 0) return d[t] || 0
  const tens = shi === 0 ? 1 : d[t[shi - 1]] || 0
  const ones = shi === t.length - 1 ? 0 : d[t[shi + 1]] || 0
  return tens * 10 + ones
}

// LF-6：续排卷号从卷章表的"第N卷…章节"标题实际解析(取最大卷号+1)，不再用"已排最大章 ÷ 卷一章数"反推。
// 各卷章数不等时除法会算错卷号并喂错卷大纲(如卷一30章、排到70章时 ceil(70/30)+1=4，实际应是卷三)。
// 卷标题解析不到时回落到旧的除法估算，保持可用。
const nextVolumeNoOf = (volumes, maxPlanChapter, pv) => {
  let maxVol = 0
  const re = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*卷[^】\n]*章节/g
  const text = String(volumes || '')
  let m
  while ((m = re.exec(text))) {
    const n = cnVolNo(m[1])
    if (n > maxVol) maxVol = n
  }
  if (maxVol > 0) return maxVol + 1
  return maxPlanChapter > 0 ? Math.ceil(maxPlanChapter / (pv || 40)) + 1 : 2
}

// 续排下一卷章表：从 startChapter 起排第 nextVol 卷，基于大纲本卷节点 + 已建档资产 + 前卷末3章承接
const nextVolumePrompt = (book, nextVol, startChapter) => {
  const perVol = perVolOf(book) // A5：统一走 assets.js perVolOf 单一出处(与组件内 perVol/图谱同源)，不再各处自算卷一章数
  const assetList =
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})｜透出章${revealChapterOf(a, perVol) || '—'}`).join('\n') || '(无)'
  return [
    `你是分卷结构编辑。第1至${startChapter - 1}章已排定（卷一至卷${nextVol - 1}）。现在排第${nextVol}卷：从第${startChapter}章起至本卷末，并产出资产章号回填清单。`,
    LANG_RULE,
    `【第${nextVol}卷章节】逐章列出第${startChapter}章至本卷末章，每章一行：章号｜章名｜本章故事梗概(150至250字，讲完本章从开场到结尾钩子的完整故事；含对峙或谈判的章写清一轮来回台词谁对谁说了什么；梗概内一律用逗号句号，把｜分隔符留给字段之间)｜本章视角人物(写人物名)｜本章首次透出的资产(人物/地点/势力名)｜情绪节拍(主情绪+强度1-5+主爽点类型+触发事件)｜出场人物(用准确名字，逗号分隔)｜结尾钩子+类型。`,
    '【资产章号回填】把本卷新登场资产的透出卷/传闻卷细化为透出章/传闻章，每行：资产名｜透出章｜传闻章，本卷登场的资产一条不漏。',
    ...NEXT_VOL_RULES,
    '',
    `第${nextVol}卷大纲（分卷结构表本卷行 + 本卷事件节点）：`,
    outlineNodesOfVol(book && book.outline, nextVol) || '(大纲未找到本卷节点，按主线自由推进)',
    '',
    '已建档资产清单（名字｜类型｜透出章）：',
    assetList,
    '',
    '前卷末3章（承接结尾钩子与人物处境）：',
    volumesTail3(book && book.volumes) || '(无)',
  ].join('\n')
}


// LF-5：移除未使用的 apiKey/onNeedKey prop——本页所有 LLM 调用都走 PromptEditorModal（弹窗内部自查 writerConfig().key 并提示去设 Key），
// 页内不再直发请求，故不需要 apiKey；缺 Key 引导由弹窗承担，onNeedKey 无调用点。父组件 App.jsx 若仍传这两个 prop 会被忽略（可停传，属越界项见报告）。
export default function LongFormPage() {
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true) // M43：区分"加载中/读取失败/确实没书"，避免把故障说成空书库诱导重复建书
  const [loadError, setLoadError] = useState('')
  const [bookId, setBookId] = useState('')
  const [bookPickerOpen, setBookPickerOpen] = useState(false)
  const [chapterNo, setChapterNo] = useState(1)
  const [chapterTitle, setChapterTitle] = useState('')
  const [chapterText, setChapterText] = useState('')
  // LF-3：prevSummary 实为"本章摘要"(历史命名遗留)——saveChapter 存进 chapter.summary、loadChapter 载入本章时读回；
  // 上一章前情由 composePrompt 的 prevTail(上章正文末尾800字)自动承担，不依赖此字段。
  const [prevSummary, setPrevSummary] = useState('')
  const [targetWords, setTargetWords] = useState('2500')
  const [exportFormat, setExportFormat] = useState('txt')
  const [composeOpen, setComposeOpen] = useState(false)
  const [assetOpen, setAssetOpen] = useState(false)
  const [expandOpen, setExpandOpen] = useState(false)
  const [relationOpen, setRelationOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [nextVolOpen, setNextVolOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editAsset, setEditAsset] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [analyzeOpen, setAnalyzeOpen] = useState(false)
  const [sourceText, setSourceText] = useState('')
  const [pendingUpdates, setPendingUpdates] = useState([])
  const [pendingNew, setPendingNew] = useState([])
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [selUp, setSelUp] = useState([])
  const [selNew, setSelNew] = useState([])
  // B6 结算本章状态：提示词弹窗 + 预览弹窗开关；三段产出(状态变更/资产流转/伏笔推进)各自的待落库列表与勾选下标
  const [settlePromptOpen, setSettlePromptOpen] = useState(false)
  const [settlePreviewOpen, setSettlePreviewOpen] = useState(false)
  const [pendingState, setPendingState] = useState([])
  const [pendingFlow, setPendingFlow] = useState([])
  const [pendingHook, setPendingHook] = useState([])
  const [selState, setSelState] = useState([])
  const [selFlow, setSelFlow] = useState([])
  const [selHook, setSelHook] = useState([])
  // B7 手动新增资产弹窗（接阶段0 的 NewAssetModal）
  const [newAssetOpen, setNewAssetOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const sourceFileRef = useRef(null)
  // A2：镜像最新 book 的 ref，供即发即忘的资产 CRUD 基于"最新 book"而非陈旧闭包快照更新，杜绝快速连改的 lost update(M29)
  const bookRef = useRef(null)

  const book = books.find((b) => b.id === bookId) || null
  useEffect(() => {
    bookRef.current = book
  }, [book])

  // 换书：先清上一本残留(H10)，再恢复本书未保存的编辑草稿(H11)，无草稿则载入第1章
  useEffect(() => {
    setSourceText('')
    setPendingUpdates([])
    setPendingNew([])
    setSelUp([])
    setSelNew([])
    // B6：换书一并清结算待落库(H10 同源)，防 A 书结算结果落到 B 书
    setPendingState([])
    setPendingFlow([])
    setPendingHook([])
    setSelState([])
    setSelFlow([])
    setSelHook([])
    setMsg('')
    let alive = true
    getById('drafts', lfDraftKey(bookId))
      .then((d) => {
        if (!alive) return
        if (d && bookId && d.bookId === bookId) {
          setChapterNo(d.chapterNo || 1)
          setChapterText(d.chapterText || '')
          setChapterTitle(d.chapterTitle || '')
          setPrevSummary(d.prevSummary || '')
        } else {
          const first = ((book && book.chapters) || []).find((c) => c.no === 1)
          setChapterNo(1)
          setChapterText(first ? first.text || '' : '')
          setChapterTitle(first && first.title && first.title !== '第1章' ? first.title : planTitleOf(1) || (first ? first.title : ''))
          setPrevSummary(first ? first.summary || '' : '')
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])
  // 当前编辑草稿持久化(H11)：防切页签/刷新丢未保存正文；正文可能很大，存 IndexedDB drafts（单条 lf_current）
  useEffect(() => {
    if (!bookId) return
    const t = setTimeout(() => {
      put('drafts', { id: lfDraftKey(bookId), bookId, chapterNo, chapterText, prevSummary, chapterTitle, updatedAt: Date.now() }).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [bookId, chapterNo, chapterText, prevSummary, chapterTitle])
  const chapters = useMemo(() => (book && book.chapters) || [], [book])
  const warnings = useMemo(() => computeAssetWarnings((book && book.assets) || []), [book])
  // 详纲：解析卷章表(book.volumes)的所有章行，供"查看详纲"弹窗纵览全书章表(章号/章名/梗概/节拍/钩子)。
  // 兼容完整表(8列，节拍在第6列)与后段简表(列数少，节拍在第5列)；钩子取末列。
  const volumeChapters = useMemo(() => {
    const out = []
    for (const raw of String((book && book.volumes) || '').split('\n')) {
      const l = raw.trim().replace(/^[｜|]\s*/, '')
      if (!/^\d+[｜|]/.test(l)) continue
      const c = l.split(/[｜|]/).map((s) => s.trim())
      const no = Number(c[0])
      if (!no) continue
      out.push({ no, title: c[1] || '', synopsis: c[2] || '', mood: (c.length >= 6 ? c[5] : c[4]) || '', hook: c.length >= 8 ? c[c.length - 1] : '' }) // M42：仅完整表(8列)末列才是钩子；简表(5列)末列是情绪节拍，不能当钩子重复显示
    }
    return out
  }, [book])
  // 已排到的最大章号（卷章表里最后一章），续排下一卷从它的下一章起
  const maxPlanChapter = useMemo(() => volumeChapters.reduce((m, c) => Math.max(m, c.no), 0), [volumeChapters])
  // M44："+写下一章"的目标章号取"已存章号集合的第一个缺口"(存了1,2,4→3)，而非 chapters.length+1。
  // 后者假设章号连续，有缺口时按钮会指向已存章(点击载入旧章而非新建)、缺口章永远无入口创建。
  const nextChapterToWrite = useMemo(() => {
    const existing = new Set(chapters.map((c) => c.no).filter((n) => Number.isFinite(n)))
    const maxNo = existing.size ? Math.max(...existing) : 0
    for (let n = 1; n <= maxNo + 1; n++) {
      if (!existing.has(n)) return n
    }
    return maxNo + 1
  }, [chapters])
  // 续排下一卷的卷号与起始章号：起始章=已排最大章+1；卷号从卷章表"第N卷…章节"标题解析(LF-6)，不再用章数除法反推
  const nextVolInfo = useMemo(() => {
    const pv = perVolOf(book) // A5：统一走 perVolOf 单一出处
    const start = maxPlanChapter + 1
    const vol = nextVolumeNoOf(book && book.volumes, maxPlanChapter, pv)
    return { start, vol, perVol: pv }
  }, [book, maxPlanChapter])

  useEffect(() => {
    let alive = true
    setLoading(true)
    getAll('books')
      .then((bs) => {
        if (!alive) return
        setBooks(bs || [])
        setLoadError('')
        if (bs && bs.length) {
          // 续写页"转长篇"会留下要打开的书号，优先选中它
          const want = localStorage.getItem('na_open_book')
          localStorage.removeItem('na_open_book')
          setBookId((cur) => cur || (want && bs.some((b) => b.id === want) ? want : bs[0].id))
        }
      })
      .catch((e) => {
        // M43：读取失败(数据库被 blocked/事务中止)不能静默当空书库，否则用户会去重复建书
        if (!alive) return
        setLoadError(e && e.message ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const chapterPlan = useMemo(() => {
    if (!book) return ''
    return (
      String(book.volumes || '')
        .split('\n')
        .map((l) => l.trim().replace(/^[｜|]\s*/, ''))
        .find((l) => l.startsWith(chapterNo + '｜') || l.startsWith(chapterNo + '|') || l.startsWith('第' + chapterNo + '章')) || ''
    )
  }, [book, chapterNo])

  // B3(需求4)：perVol 统一走 assets.js 的 perVolOf(单一出处)，与图谱/资产库/续写页同源，不再各处各写一套换算
  const perVol = useMemo(() => perVolOf(book), [book])

  const buckets = useMemo(() => {
    const allow = []
    const rumor = []
    const ban = []
    ;((book && book.assets) || []).forEach((a) => {
      const rc = revealChapterOf(a, perVol)
      const mc = rumorChapterOf(a, perVol)
      if (rc > 0 && rc <= chapterNo) allow.push(a)
      else if (mc > 0 && mc <= chapterNo) rumor.push(a)
      else ban.push(a)
    })
    return { allow, rumor, ban }
  }, [book, chapterNo, perVol])

  // 章纲章名（卷章表第 N 行第 2 列），用作章名缺省，避免章名回落成"第N章"与章号重复
  const planTitleOf = (no) => {
    const line = String((book && book.volumes) || '')
      .split('\n')
      .map((l) => l.trim().replace(/^[｜|]\s*/, ''))
      .find((l) => l.startsWith(no + '｜') || l.startsWith(no + '|') || l.startsWith('第' + no + '章'))
    return line ? (line.split(/[｜|]/)[1] || '').trim() : ''
  }

  const loadChapter = (no) => {
    setChapterNo(no)
    const c = chapters.find((x) => x.no === no)
    const fallback = planTitleOf(no)
    setChapterTitle(c && c.title && c.title !== `第${no}章` ? c.title : fallback || (c ? c.title : ''))
    setChapterText(c ? c.text : '')
    setPrevSummary(c ? c.summary || '' : '')
    setDrawerOpen(false)
    setMsg(c ? `已载入第${no}章` : `新章：第${no}章`)
  }

  // 5.5 当前章的历史版本快照(供"历史版本"弹窗查看/回滚)；旧书 chapters 无 history 字段时为空数组
  const currentHistory = useMemo(() => {
    const c = chapters.find((x) => x.no === chapterNo)
    return (c && c.history) || []
  }, [chapters, chapterNo])

  // 回滚=把历史版本载回编辑区(不直接落库)，用户确认后点"保存本章"生效——保留人在环路，
  // 且保存时当前正文会被压入 history，回滚不会丢任何版本。
  const rollbackChapter = (ver) => {
    setChapterText(ver.text || '')
    if (ver.title) setChapterTitle(ver.title)
    setPrevSummary(ver.summary || '')
    setHistoryOpen(false)
    setMsg(`已载回历史版本（${ver.savedAt ? new Date(ver.savedAt).toLocaleString() : '旧版'}），确认后点「保存本章」生效`)
  }

  const composePrompt = useMemo(() => {
    if (!book) return ''
    const prev = chapters.find((c) => c.no === chapterNo - 1)
    // 前情从段落边界切，避免半句开头误导衔接
    const tailCut = prev ? String(prev.text || '').slice(-800) : ''
    const prevTail = tailCut && tailCut.indexOf('\n') > 0 ? tailCut.slice(tailCut.indexOf('\n') + 1) : tailCut
    const beat = (book.beats || []).find((b) => b.chapter_no === chapterNo)
    // 章纲点名制：只注入本章章纲点名的资产(reveal_assets+cast)，避免整卷资产堆进单章提示词；
    // 无章纲行时回退扫章纲原文；其余已透出资产仍属 allow(防提前透出检查不变)，只是不注入。
    const beatNames = beat
      ? [
          ...String(beat.reveal_assets || '').split(/[,，、/]/).map((s) => s.trim()).filter(Boolean),
          ...(beat.cast || []),
          ...(beat.pov ? [beat.pov] : []),
        ]
      : []
    // 名字匹配容错(H9)：去空格/书名号后双向包含即命中，避免 AI 在 reveal_assets 里加增饰或换分隔符就一个都匹配不上
    const normName = (s) => String(s || '').replace(/[\s《》「」]/g, '')
    const beatNamesNorm = beatNames.map(normName).filter(Boolean)
    const planText = String(chapterPlan || '')
    const matchBeat = (a) => {
      const an = normName(a.name)
      return !!an && beatNamesNorm.some((bn) => bn === an || bn.includes(an) || an.includes(bn))
    }
    let injectedAllow = buckets.allow.filter((a) => matchBeat(a) || (!beat && planText.includes(a.name)))
    // 回退(H9)：有节拍但一个都没匹配上(名字漂移)时，退回"章纲原文出现资产名"判据，避免本章零资产可用只能凭空编
    if (!injectedAllow.length) injectedAllow = buckets.allow.filter((a) => a.name && planText.includes(a.name))
    // 详情截到 80 字内的最后一个完整字段边界，避免截出半截括号
    const cutDetail = (s) => {
      const t = String(s || '').slice(0, 80)
      if (String(s || '').length <= 80) return t
      const i = t.lastIndexOf('｜')
      return (i > 40 ? t.slice(0, i) : t) + '…'
    }
    // B1(设计§4.4)：本章点名资产在 detail 后拼一行口语化「现况」(stateToPromptLine)——只 injectedAllow 注入，rumor/ban 不注入(防剧透)；
    // stateToPromptLine 只输出有值维度、不出现字段名/英文枚举/JSON，空状态返回空串(不拼)。
    const allowText = injectedAllow
      .map((a) => {
        const base = `${a.name}(${a.type})：${cutDetail(a.detail)}`
        const st = stateToPromptLine(a)
        return st ? `${base}\n  ${st}` : base
      })
      .join('\n')
    // 章纲提及制：rumor 只注入本章章纲(梗概/钩子)里实际出现的传闻资产，避免整卷传闻名单堆进单章诱导加戏
    const injectedRumor = buckets.rumor.filter((a) => String(chapterPlan || '').includes(a.name))
    const rumorText = injectedRumor.map((a) => `${a.name}(仅传闻)`).join('\n')
    // 整章调度块：本章地点/在场人物/上一章末尾在场者，防人物瞬移与凭空出场
    const stagePlaces = injectedAllow.filter((a) => a.type === 'place').map((a) => a.name)
    const stageCast = [...new Set(injectedAllow.filter((a) => a.type === 'person' || a.type === 'group').map((a) => a.name))]
    const prevPresent = prevTail ? (book.assets || []).filter((a) => (a.type === 'person' || a.type === 'group') && prevTail.includes(a.name)).map((a) => a.name) : []
    // B2(需求6方案3)：人物现位置取自结构化 state.place（不再只靠章纲点名/上一章文本扫描），把"跨章连续：人物位置沿用"从口号变数据。
    // 只查「本章在场 ∪ 上一章在场」的人物，避免对全表逐个 normalizeState。
    const assetByName = new Map((book.assets || []).map((a) => [a.name, a]))
    const personLocs = [...new Set([...stageCast, ...prevPresent])]
      .map((nm) => {
        const a = assetByName.get(nm)
        if (!a) return ''
        const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
        return st.place && st.place.ref ? `${nm}在${st.place.ref}` : ''
      })
      .filter(Boolean)
    // A(方案E第1层收尾)：段长带宽来自 worldviews 的 paraBandFor（全项目段长数字唯一出处，下沿2/3上沿4/3）；
    // B-H3：目标段长优先取 B 的 avgParaLenFor(book)(题材/文风真值)，未导出时回退 book.avgParaLen(当前恒空→paraBandFor 自动用默认档30)。
    const band = paraBandFor(typeof worldviews.avgParaLenFor === 'function' ? worldviews.avgParaLenFor(book) : book && book.avgParaLen)
    // 章纲注入前剥掉内部记号：出场人物列的 P01 式编号、情绪列的 +3+ 强度记号
    const planClean = String(chapterPlan || '')
      .replace(/｜\s*P\d+(?:\s*,\s*P\d+)*\s*(?=｜)/g, '')
      .replace(/\+(\d)\+/g, '，强度$1，')
    // 5.2 伏笔注入：foreshadows 已落库(plant_volume/payoff_volume/plant_ch/rumor_ch)但成文提示词从不消费(存了不读)。
    // 这里筛出本章相关的伏笔：①活跃伏笔=已埋设(埋设章≤本章)且回收卷未到或正在本卷；②本卷应回收=payoff_volume 命中当前卷。
    // 埋设章优先用回填的 plant_ch，否则按 plant_volume 换算；回收只有卷级 payoff_volume，故"应回收"按当前卷判定。
    const fsList = (book && book.foreshadows) || []
    const curVol = perVol > 0 ? Math.ceil(chapterNo / perVol) : 0
    const plantChOf = (f) => (f.plant_ch > 0 ? f.plant_ch : f.plant_volume > 0 ? (f.plant_volume - 1) * perVol + 1 : 0)
    const fsLine = (f) => `- ${f.title || '(无名)'}：${String(f.desc || '').slice(0, 60)}`
    const activeFs = fsList.filter((f) => {
      // 结算(设计§4.6)会把已回收/已撤稿的伏笔置 resolved/superseded → 不再当活跃伏笔注入(否则回收后还提示"勿提前泄底"自相矛盾)
      if (f.state === 'resolved' || f.state === 'superseded') return false
      const pc = plantChOf(f)
      const planted = pc > 0 ? pc <= chapterNo : f.plant_volume > 0 && f.plant_volume <= curVol
      const notPaid = f.payoff_volume > 0 ? curVol <= f.payoff_volume : true
      return planted && notPaid
    })
    const dueFs = activeFs.filter((f) => f.payoff_volume > 0 && curVol > 0 && f.payoff_volume === curVol)
    const dueLines = dueFs.slice(0, 5).map(fsLine)
    const activeLines = activeFs
      .filter((f) => !dueFs.includes(f))
      .slice(0, 8)
      .map(fsLine)
    const foreshadowBlock =
      dueLines.length || activeLines.length
        ? [
            '伏笔衔接：',
            dueLines.length ? `本卷应回收的伏笔(时机合适就在本章兑现，别拖过本卷)：\n${dueLines.join('\n')}` : '',
            activeLines.length ? `仍在埋设/延续中的活跃伏笔(可呼应、可加深，勿提前泄底)：\n${activeLines.join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : ''
    return [
      `你是本书的执笔写手。写第${chapterNo}章正文。`,
      LANG_RULE,
      '本章章纲：',
      planClean || '(卷章表里没找到本章行，按主线自由推进一小步)',
      '本章点名资产：',
      allowText || '(无)',
      '本章仅传闻资产：',
      rumorText || '(无)',
      '上一章末尾(前情)：',
      prevTail || '(首章无)',
      '本场调度：',
      `本章地点：${stagePlaces.join('、') || '(章纲场景内)'}`,
      `本章在场人物：${stageCast.join('、') || '(无)'}`,
      `上一章末尾在场：${prevPresent.join('、') || '(首章无)'}`,
      `人物当前位置(据资产状态，跨章沿用、勿瞬移)：${personLocs.join('、') || '(未记录)'}`,
      '本章摘要：',
      prevSummary || '(无)',
      '本章节拍：',
      beat ? `主情绪与爽点：${beat.mood_raw || ''}｜视角人物 ${beat.pov || ''}` : '(无)',
      ...(foreshadowBlock ? [foreshadowBlock] : []),
      '文风档案：',
      // 档案是 AI 产物，可能自带否定句；注入前把"禁绝…"换成正向陈述
      String(book.styleProfile || '').replace(/禁绝[^。；\n]*说法/g, '叙述与对白的说法一律长在本书世界观里') || '(无)',
      '文风习惯(照着这几条落笔)：',
      sanitizeHabits(book.styleHabits || []).habits.slice(0, 3).join('\n') || '(无)',
      '文风范例(真书摘录：学句长、分段、对话与描写的度；范例的单句段密度高于本书目标，只学句长不学断段；范例里的人物地名情节器物留在范例内；范例里的比喻密度是原书特例，正文一个场景至多一个)：',
      (book.styleSamples || []).slice(0, 2).join('\n---\n') || '(无)',
      '',
      '写作纪律：只写章纲与可用资产支撑的内容；素材不足以支撑目标字数时写短、写实；设定/人物/场景一律取自素材；只写已透出的资产；章纲台词事件展开成的来回对话属章纲支撑范围。',
      '呈现方式：世界观与设定通过人物行动、对话与后果带出；叙述者讲课式的整段设定说明整段删除。',
      '跨章连续：上一章已写的人物位置、生死、去向本章沿用；改写须有当章动作支撑；章纲没写的冲突留到下一章。',
      '场景描写：环境与感官描写只作当下的一两句即时反应，一段写完即回到人物行动。',
      `目标字数：${targetWords}字。`,
      '',
      '落笔上限：单句独立成段尽量少用，能合并进邻段就合并，一个场景至多一个比喻；单句成段每章至多五处，只留给点睛收束。',
      `段落节奏：每段写到约${band.minPara}~${band.maxPara}字再断行（本书目标段长约${band.target}字${band.defaulted ? '，未配题材档、用默认档' : ''}）；既不通篇单句成段，也不整屏不断行。`,
      // 对话要求由代码判断：章纲含对峙/谈判词，或章纲里出现两个以上已建档人物名（不依赖章表出场列，旧书该列可能是编号）
      /对峙|谈判|叫阵|质问|讨价|劝降|审问/.test(String(chapterPlan || '')) ||
      ((book.assets || []).filter((a) => (a.type === 'person' || a.type === 'group') && String(chapterPlan || '').includes(a.name)).length >= 2)
        ? '对话：本章含对峙或多人在场场景，把章纲里的台词事件展开成来回对话，轮数按章纲台词事件自然展开、至少一轮一问一答，带潜台词与分寸。'
        : '对话：本章为独角戏或单人行动场景，对话可缺省，用动作与感官推进。',
      '输出前自查：数一遍单句成段与比喻，单句成段超过五处把多余的合并进邻段，比喻超过场景数删到每场景一个；再数来回对话，该有对话的场景补齐。',
      '直接输出本章正文，输出内容只有正文本身。',
    ].join('\n')
  }, [book, chapters, chapterNo, chapterPlan, buckets, prevSummary, targetWords, perVol])

  // M33：4 个弹窗提示词惰性 memo——只在对应弹窗打开时才拼大文本(analyzePrompt 含整本原文、其余遍历全资产)，
  // 关闭时返回空串。避免在任意输入框打字触发 LongFormPage 重渲染时反复重拼 MB 级字符串。
  // PromptEditorModal 用 wasOpenRef 只在"由关到开"那刻读 initialPrompt，故打开时算出的值能被正确捕获。
  const analyzePromptText = useMemo(() => (analyzeOpen ? analyzePrompt(book, chapterNo, sourceText) : ''), [analyzeOpen, book, chapterNo, sourceText])
  const expandPromptText = useMemo(() => (expandOpen ? expandPrompt(book) : ''), [expandOpen, book])
  const relationPromptText = useMemo(() => (relationOpen ? relationPrompt(book) : ''), [relationOpen, book])
  const nextVolPromptText = useMemo(() => (nextVolOpen ? nextVolumePrompt(book, nextVolInfo.vol, nextVolInfo.start) : ''), [nextVolOpen, book, nextVolInfo])

  const persistBook = async (nb) => {
    try {
      await put('books', nb)
      setBooks((bs) => bs.map((b) => (b.id === nb.id ? nb : b)))
    } catch (e) {
      // M28：写库失败(配额不足/事务中止)必须明确提示，不能静默——否则删资产/改资产/存图布局"看起来成功、实际没存"，刷新后回旧状态
      setMsg('保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）')
    }
  }

  // A2：基于"最新 book"的原子更新——乐观更新 bookRef+state 再落库。快速连改(删资产A又删B/连续拖拽/LinkEditor 连改边)时，
  // 每次都基于上一次的结果(bookRef.current)构造，不再各自用陈旧闭包 book 覆盖前一次写(lost update/M29)。updater 返回 falsy 或原值则不写。
  const mutateBook = async (updater) => {
    const cur = bookRef.current
    if (!cur) return
    const nb = updater(cur)
    if (!nb || nb === cur) return
    bookRef.current = nb // 乐观：后续连改立即基于最新，杜绝丢更新
    setBooks((bs) => bs.map((b) => (b.id === nb.id ? nb : b)))
    try {
      await put('books', nb)
    } catch (e) {
      setMsg('保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）')
    }
  }

  const saveChapter = async () => {
    if (!book) return
    if (!String(chapterText || '').trim()) {
      setMsg('正文为空，未保存（避免章节树出现空章占位）')
      return
    }
    const list = [...chapters]
    const i = list.findIndex((c) => c.no === chapterNo)
    const old = i >= 0 ? list[i] : null
    // 5.5 版本历史：覆盖已有章前，把旧正文/章名/摘要压入 history[](保留最近 HISTORY_MAX 版)，供查看与回滚。
    // 仅当旧正文非空且与新正文不同才存快照，避免重复保存同一内容堆叠无意义版本；旧书 chapters 无 history 字段时从空数组起。
    const prevHistory = (old && old.history) || []
    const history =
      old && String(old.text || '').trim() && old.text !== chapterText
        ? [...prevHistory, { text: old.text, title: old.title || '', summary: old.summary || '', savedAt: old.updatedAt || Date.now() }].slice(-HISTORY_MAX)
        : prevHistory
    const rec = { no: chapterNo, title: chapterTitle || planTitleOf(chapterNo) || `第${chapterNo}章`, text: chapterText, summary: prevSummary, history, updatedAt: Date.now() }
    if (i >= 0) list[i] = rec
    else list.push(rec)
    list.sort((a, b) => a.no - b.no)
    await persistBook({ ...book, chapters: list })
    setMsg(`第${chapterNo}章已保存${history.length ? `（含 ${history.length} 个历史版本）` : ''}`)
  }

  // 续排下一卷采纳：新章表追加进 volumes、重解析全部节拍、把回填章号写回现有资产/伏笔，落库。
  // 资产仍以资产表为准（不被 parseBookAssets 的顺带解析覆盖），只用它重算 beats 并回填新章号。
  const adoptNextVol = async (reply) => {
    setNextVolOpen(false)
    if (!book || !String(reply || '').trim()) {
      setMsg('续排回复为空，未追加')
      return
    }
    const newVolumes = `${book.volumes || ''}\n${reply}`
    const parsed = parseBookAssets({ volumes: newVolumes })
    const assets = ((book.assets) || []).map((a) => ({ ...a }))
    const foreshadows = ((book.foreshadows) || []).map((f) => ({ ...f }))
    backfillChapterNos(assets, foreshadows, newVolumes)
    await persistBook({ ...book, volumes: newVolumes, beats: parsed.beats, assets, foreshadows })
    const newMax = String(reply)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+[｜|]/.test(l))
      .map((l) => Number(l.split(/[｜|]/)[0]))
      .reduce((m, n) => Math.max(m, n || 0), 0)
    setMsg(`已续排第${nextVolInfo.vol}卷：章表排到第${newMax || '?'}章，节拍共${parsed.beats.length}条`)
  }

  // A2：以下即发即忘的资产 CRUD 改用 mutateBook(基于最新 book 乐观更新)，杜绝快速连改的 lost update(M29)。
  const deleteAsset = (id) => mutateBook((b) => ({ ...b, assets: (b.assets || []).filter((a) => a.id !== id) }))

  const updateAsset = (id, patch) => mutateBook((b) => ({ ...b, assets: (b.assets || []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }))

  // 加边改由 AssetGraphModal 内的 LinkEditor 承载(受控 links→onUpdateAsset)，其 addRow 已含 to+type 去重(原 addLink 的 M48 判据)，故不再单列 addLink。
  // A6：删边按稳定标识(toName+type)匹配而非 linkIdx 下标——rebuildLinks/增删边使 links 重排后下标会删错边(与 AssetGraphModal confirmEdge 存的标识对应)。
  const delLink = (assetId, toName, type) =>
    mutateBook((b) => ({
      ...b,
      assets: (b.assets || []).map((a) => (a.id === assetId ? { ...a, links: (a.links || []).filter((l) => !(l.to === toName && l.type === type)) } : a)),
    }))

  const rebuildLinks = () => {
    mutateBook((b) => ({ ...b, assets: buildLinks((b.assets || []).map((a) => ({ ...a, links: [] }))) }))
    setMsg('已按名字共现重建绑定边')
  }

  // 合并已存布局(H14)：只更新本次拖动的节点，保留其他节点已保存的坐标，避免整张图被一次拖动覆盖钉死
  const saveGraphPos = (pos) => mutateBook((b) => ({ ...b, graphPos: { ...(b.graphPos || {}), ...pos } }))

  const mergeRelations = async (reply) => {
    if (!book) return
    const edges = parseRelations(reply)
    const names = new Set((book.assets || []).map((a) => a.name))
    let added = 0
    let dangling = 0
    const assets = (book.assets || []).map((a) => {
      const links = [...(a.links || [])]
      edges.forEach((e) => {
        if (e.from !== a.name) return
        if (!names.has(e.to)) {
          dangling += 1
          return
        }
        if (!links.some((l) => l.to === e.to && l.type === e.type)) {
          links.push({ type: e.type, to: e.to })
          added += 1
        }
      })
      return { ...a, links }
    })
    await persistBook({ ...book, assets })
    setRelationOpen(false)
    setMsg(`关系网新增 ${added} 条边，名册外悬空 ${dangling} 条已丢弃`)
  }

  const appendExpand = async (reply) => {
    if (!book) return
    const add = parseExpandAssets(reply)
    const exist = new Set((book.assets || []).map((a) => a.name))
    const fresh = add.filter((a) => !exist.has(a.name))
    const allNames = new Set([...exist, ...fresh.map((a) => a.name)])
    fresh.forEach((a) => {
      a.links = (a.links || []).filter((l) => allNames.has(l.to))
    })
    await persistBook({ ...book, assets: [...(book.assets || []), ...fresh] })
    setExpandOpen(false)
    setMsg(`扩充 ${fresh.length} 个资产（重复 ${add.length - fresh.length} 个已跳过）`)
  }

  // LF-1：分析原文不再页内直发第二次请求。提示词弹窗里用户点「发送」已生成 reply 并审核，
  // 采纳时直接解析该 reply 落库预览——"审核的回复=落库的回复"，避免 onAdopt 丢弃 reply 又发一次
  // （双重 LLM 调用、双倍额度、且第二次结果可能与用户审核的那次不一致）。
  // M31：①追加而非替换——分析第4章时第3章未落库的预览不再被静默丢弃，每条打上来源章号(fromCh)供弹窗分辨；
  //      ②默认不全选——避免一次误点「落库选中」把全部 AI 输出写进资产库，改由弹窗里的「全选」按钮显式勾选；
  //      ③追加时按名字去重(同名新资产/同内容更新只留一条)，防同一章重复分析后落库出重复资产。
  const adoptAnalyze = (reply) => {
    const { updates, newAssets } = parseAnalyze(reply || '')
    const ch = chapterNo
    const hadPending = pendingUpdates.length > 0 || pendingNew.length > 0
    const upSeen = new Set(pendingUpdates.map((u) => `${u.name}｜${u.info}｜${u.state}`))
    const mergedUp = [...pendingUpdates]
    let dupUp = 0
    updates.forEach((u) => {
      const k = `${u.name}｜${u.info}｜${u.state}`
      if (upSeen.has(k)) {
        dupUp += 1
        return
      }
      upSeen.add(k)
      mergedUp.push({ ...u, fromCh: ch })
    })
    const newSeen = new Set([...pendingNew.map((n) => n.name), ...(((book && book.assets) || []).map((a) => a.name))])
    const mergedNew = [...pendingNew]
    let dupNew = 0
    newAssets.forEach((n) => {
      if (!n.name || newSeen.has(n.name)) {
        dupNew += 1
        return
      }
      newSeen.add(n.name)
      mergedNew.push({ ...n, fromCh: ch })
    })
    setPendingUpdates(mergedUp)
    setPendingNew(mergedNew)
    // M31：不清空已有勾选(追加在末尾，旧下标不变)，新条目默认未勾选
    const dupNote = dupUp + dupNew > 0 ? `；重复 ${dupUp + dupNew} 条已跳过` : ''
    setMsg(
      `分析完成：本次新增待落库 更新 ${updates.length - dupUp} 条 / 新资产 ${newAssets.length - dupNew} 个${dupNote}${
        hadPending ? `；已与上次未落库结果合并（现共 更新 ${mergedUp.length} 条 / 新资产 ${mergedNew.length} 个）` : ''
      }，请勾选后落库`
    )
  }

  const onSourceFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      setSourceText(await readDocumentFile(file))
    } catch (err) {
      setMsg(err && err.message ? err.message : String(err))
    }
  }

  const applyUpdates = async () => {
    if (!book) return
    const ups = pendingUpdates.filter((_, i) => selUp.includes(i))
    const assets = (book.assets || []).map((a) => {
      // M31：追加模式下同一资产可能有多条(来自不同章)更新，全部按顺序合并；原实现 find 只取第一条，其余静默丢弃
      const us = ups.filter((x) => x.name === a.name)
      if (!us.length) return a
      // LF-7：a.detail 可能为 undefined，模板直接拼接会产出 "undefined｜…" 脏字；用 filter(Boolean) 跳过空段
      // B4：state 写结构化 v2（原来直接写中文字符串）——把粗状态词(活跃/死亡/…)并入 plot 维度，其它维度原样保留(增量更新不重建，inkos 原则②)
      const st = normalizeState(a.state)
      const word = us[us.length - 1].state
      const tag = STATE_V1_MAP[word] || STATE_V1_MAP[String(word || '').toLowerCase()]
      if (tag) st.plot = { ...(st.plot || {}), tag }
      if (word) st.legacy = st.legacy || word
      st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: chapterNo }
      return { ...a, detail: [a.detail, ...us.map((u) => u.info)].filter(Boolean).join('｜'), state: st }
    })
    await persistBook({ ...book, assets })
    setPendingUpdates((p) => p.filter((_, i) => !selUp.includes(i)))
    setUpdatesOpen(false)
    setSelUp([])
    setMsg(`已落库 ${ups.length} 条资产更新`)
  }

  const applyNew = async () => {
    if (!book) return
    const news = pendingNew.filter((_, i) => selNew.includes(i))
    // M31：追加模式下待落库列表里可能出现同名新资产(重复分析同一章/多章提到同一角色)，
    // 只按库内已有名字过滤会让同名条目各生成一个 id 落库成重复资产 → 这里连库内与本次选中一起按名字去重
    const seen = new Set((book.assets || []).map((a) => a.name))
    const add = []
    let skipped = 0
    news.forEach((n) => {
      if (!n.name || seen.has(n.name)) {
        skipped += 1
        return
      }
      seen.add(n.name)
      add.push({
        id: `na_${Date.now().toString(36)}_${add.length}`,
        // 结算/分析回复里的类型是中文词(人物/地点/…)，落库前归一成英文枚举(typeKeyOf)，否则分类筛选与图谱着色对不上
        type: typeKeyOf(n.type),
        name: n.name,
        detail: n.desc,
        aliases: [],
        tier: 'B',
        is_public: false,
        state: 'alive',
        ch_reveal: n.reveal || n.fromCh || chapterNo,
        ch_rumor: 0,
        knowers: [],
        links: [],
      })
    })
    await persistBook({ ...book, assets: [...(book.assets || []), ...add] })
    setPendingNew((p) => p.filter((_, i) => !selNew.includes(i)))
    setNewOpen(false)
    setSelNew([])
    setMsg(`已落库 ${add.length} 个新资产${skipped ? `（重复/无名 ${skipped} 个已跳过）` : ''}`)
  }

  const exportAll = () => {
    if (!book) return
    const text = chapters.map((c) => `${c.title}\n\n${c.text}\n`).join('\n')
    // L14：①exportDocument 是 async(docx 路径 await import('docx') 可能失败)，不 catch 会产生未处理 rejection、导出失败时界面无提示；
    //      ②导出的是已落库章节，当前编辑区若有未保存改动则不含它，先提示避免用户以为导出了最新全文
    const cur = chapters.find((c) => c.no === chapterNo)
    const dirty = String(chapterText || '').trim() && String(chapterText || '') !== String((cur && cur.text) || '')
    exportDocument(book.title, text, exportFormat, { suffix: '全文' })
      .then(() => {
        if (dirty) setMsg(`已导出全书（注意：第${chapterNo}章有未保存改动，未包含在导出文件里，先「保存本章」再导出可含最新正文）`)
      })
      .catch((e) => setMsg('导出失败：' + (e && e.message ? e.message : String(e))))
  }

  const openEdit = (a) => {
    setEditAsset(a)
    setEditDraft({ ...a, knowersStr: (a.knowers || []).join('、') })
  }
  const saveEdit = () => {
    if (!editAsset || !editDraft) return
    updateAsset(editAsset.id, {
      name: editDraft.name,
      type: editDraft.type,
      // B5：白名单补 tier/aliases/state——EditAssetModal(C 文件)加了 StatePanel/分层/别名后，这些字段回写时不再被 saveEdit 丢弃。
      // !== undefined 兜底：弹窗尚未提供某字段时保留原值不被覆盖；state 过 normalizeState 保证落库是 v2(幂等，旧书字符串也会被规范化)。
      tier: editDraft.tier !== undefined ? editDraft.tier : editAsset.tier,
      detail: editDraft.detail,
      aliases: splitListValue(editDraft.aliasesStr !== undefined ? editDraft.aliasesStr : editDraft.aliases),
      state: normalizeState(editDraft.state !== undefined ? editDraft.state : editAsset.state),
      ch_reveal: Number(editDraft.ch_reveal) || 0,
      ch_rumor: Number(editDraft.ch_rumor) || 0,
      knowers: String(editDraft.knowersStr || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      links: editDraft.links || [],
    })
    setEditAsset(null)
    setEditDraft(null)
    setMsg('资产已更新')
  }

  // ==================== B6 结算本章状态（设计§5，人在环路、系统零判断零拦截）====================
  // 提示词惰性 memo：只在结算弹窗打开时才算（analyzeAssetsMessages 返回 [system,user] 两条，对应弹窗的 systemPrompt+initialPrompt）
  const settlePromptText = useMemo(() => {
    if (!settlePromptOpen || !book) return { system: '', user: '' }
    const msgs = analyzeAssetsMessages({
      roster: (book.assets || []).map((a) => ({ name: a.name, type: a.type, detail: a.detail })),
      source: chapterText,
      chapterNo,
    })
    return { system: (msgs[0] && msgs[0].content) || '', user: (msgs[1] && msgs[1].content) || '' }
  }, [settlePromptOpen, book, chapterText, chapterNo])

  // 采纳结算回复：parseAnalyze 解析五段。stateChanges/flows/hookMoves 进结算预览；updates/newAssets 复用「分析原文」待落库列表。
  // A3：三段改「追加+去重」(与 adoptAnalyze 同口径)，未落库再结算别章不再覆盖丢上一份；每条打来源章号 fromCh。
  //     新增条目默认勾选(保留 B6「默认全选」语义，结算预览是审核门控且自动打开，与分析原文 M31 的默认不选场景不同)。
  const adoptSettle = (reply) => {
    const { updates, newAssets, stateChanges, flows, hookMoves } = parseAnalyze(reply || '')
    setSettlePromptOpen(false)
    const ch = chapterNo
    const mergeSeg = (prevArr, prevSel, incoming, keyOf) => {
      const seen = new Set(prevArr.map(keyOf))
      const merged = [...prevArr]
      const sel = [...prevSel]
      incoming.forEach((it) => {
        const k = keyOf(it)
        if (seen.has(k)) return
        seen.add(k)
        sel.push(merged.length) // 新增条目默认勾选
        merged.push({ ...it, fromCh: ch })
      })
      return { merged, sel }
    }
    const sc = mergeSeg(pendingState, selState, stateChanges, (s) => `${s.name}|${s.dimKey}|${s.state}|${s.since}`)
    const fl = mergeSeg(pendingFlow, selFlow, flows, (f) => `${f.person}|${f.change}|${f.asset}|${f.ch}`)
    const hk = mergeSeg(pendingHook, selHook, hookMoves, (h) => `${h.title}|${h.move}|${h.ch}`)
    setPendingState(sc.merged)
    setSelState(sc.sel)
    setPendingFlow(fl.merged)
    setSelFlow(fl.sel)
    setPendingHook(hk.merged)
    setSelHook(hk.sel)
    if (updates.length || newAssets.length) adoptAnalyze(reply)
    setSettlePreviewOpen(true)
    setMsg(
      `结算解析完成：本次 状态变更 ${stateChanges.length} / 资产流转 ${flows.length} / 伏笔推进 ${hookMoves.length}` +
        (updates.length || newAssets.length ? `；另有 更新 ${updates.length} / 新资产 ${newAssets.length} 已并入上方待落库` : '') +
        '，请勾选后落库'
    )
  }

  // 落库选中：一次性合并三段产出后 persistBook（不逐条写盘）。
  const applySettlement = async () => {
    if (!book) return
    const assets = (book.assets || []).map((a) => ({ ...a }))
    const foreshadows = (book.foreshadows || []).map((f) => ({ ...f }))
    const idxByName = {}
    assets.forEach((a, i) => {
      if (!(a.name in idxByName)) idxByName[a.name] = i
    })
    // ① 状态变更：增量并入 state（保留 id 与无关维度，inkos 原则②）。A4：doneSc 只数真正写入的(名册无此资产则跳过)
    const selSc = pendingState.filter((_, i) => selState.includes(i))
    let doneSc = 0
    selSc.forEach((sc) => {
      const i = idxByName[sc.name]
      if (i == null) return
      assets[i] = { ...assets[i], state: applyStateChange(assets[i].state, sc, chapterNo) }
      doneSc += 1
    })
    // ② 资产流转：人物 hold 追加一条；获得且未建档→入表(A7：type 取预览里用户可改的 assetType，默认 item)；损毁/消耗/丢失→标注不删(拍板5)
    const selFl = pendingFlow.filter((_, i) => selFlow.includes(i))
    let newItemCount = 0
    let doneFl = 0
    selFl.forEach((fl) => {
      const ch = fl.ch || chapterNo
      let touched = false
      const pi = idxByName[fl.person]
      if (pi != null && fl.asset) {
        const st = normalizeState(assets[pi].state)
        const hold = Array.isArray(st.hold) ? [...st.hold] : []
        if (!hold.some((h) => h.name === fl.asset && h.change === fl.change && h.ch === ch)) hold.push({ name: fl.asset, change: fl.change || 'gain', ch })
        st.hold = hold
        st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: ch }
        assets[pi] = { ...assets[pi], state: st }
        touched = true
      }
      const ai = idxByName[fl.asset]
      if (fl.change === 'gain' && ai == null && fl.asset) {
        assets.push(normalizeAsset({ name: fl.asset, type: typeKeyOf(fl.assetType || 'item'), ch_reveal: ch }, { idPrefix: 'lf' }))
        idxByName[fl.asset] = assets.length - 1
        newItemCount += 1
        touched = true
      } else if (ai != null && (fl.change === 'broken' || fl.change === 'consumed' || fl.change === 'lose')) {
        const st = normalizeState(assets[ai].state)
        const noteWord = fl.changeRaw || (fl.change === 'consumed' ? '已消耗' : fl.change === 'lose' ? '已丢失' : '已损毁')
        st.phys = { tag: 'broken', note: noteWord, ...(fl.ch ? { since: fl.ch } : {}) }
        st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: ch }
        assets[ai] = { ...assets[ai], state: st }
        touched = true
      }
      if (touched) doneFl += 1
    })
    // ③ 伏笔推进：planted→advanced/resolved/deferred/superseded；mention 不改 state(设计§4.6：仅提及不算推进)。A4：doneHk 只数真改的
    const selHk = pendingHook.filter((_, i) => selHook.includes(i))
    let doneHk = 0
    selHk.forEach((hm) => {
      const f = foreshadows.find((x) => x.title === hm.title)
      if (!f || !hm.move || hm.move === 'mention') return
      f.state = hm.move
      if (hm.move === 'advanced' || hm.move === 'resolved') f.lastAdvancedChapter = hm.ch || chapterNo
      if (hm.move === 'resolved' && hm.note) f.payoff_hint = hm.note
      doneHk += 1
    })
    await persistBook({ ...book, assets, foreshadows })
    setPendingState([])
    setPendingFlow([])
    setPendingHook([])
    setSelState([])
    setSelFlow([])
    setSelHook([])
    setSettlePreviewOpen(false)
    // A4：报「实际写入数」；勾选但被跳过的(名册无此资产/伏笔、仅提及伏笔)单独提示，计数不再≠实写
    const skips = [
      selSc.length - doneSc > 0 ? `状态变更 ${selSc.length - doneSc} 条跳过(名册无此资产)` : '',
      selFl.length - doneFl > 0 ? `流转 ${selFl.length - doneFl} 条跳过(人物/资产对不上)` : '',
      selHk.length - doneHk > 0 ? `伏笔 ${selHk.length - doneHk} 条跳过(未入库或仅提及)` : '',
    ].filter(Boolean)
    setMsg(
      `已结算落库：状态变更 ${doneSc} / 资产流转 ${doneFl}${newItemCount ? `（新入表 ${newItemCount}）` : ''} / 伏笔 ${doneHk}` + (skips.length ? `；${skips.join('、')}` : '')
    )
  }

  // 结算预览的只读辅助：旧值(该维度当前状态中文)、资产是否已建档、伏笔当前 state
  const oldStateWord = (sc) => {
    const a = ((book && book.assets) || []).find((x) => x.name === sc.name)
    if (!a) return '(新资产)'
    const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
    const dim = sc.dimKey
    if (dim === 'place') return st.place && st.place.ref ? `在${st.place.ref}` : '(未记录)'
    if (dim === 'hold') return `持有 ${(st.hold || []).filter((h) => h.change === 'gain' || !h.change).map((h) => h.name).filter(Boolean).join('、') || '(无)'}`
    const o = st[dim]
    if (!o) return '(未记录)'
    return o.note || (o.tag ? stateLabel(dim, o.tag) : '(未记录)')
  }
  const assetExists = (name) => ((book && book.assets) || []).some((a) => a.name === name)
  const foreshadowStateOf = (title) => (((book && book.foreshadows) || []).find((f) => f.title === title) || {}).state || '未入库'

  // ==================== B7 手动新增资产（NewAssetModal）====================
  // onSubmit(asset, info)：asset 已由 NewAssetModal 过 normalizeAsset(带 id/links/state v2)。create/force→追加；merge→按 mergedFrom 替换(保留 id)；empty→只提示
  const handleAssetSubmit = async (asset, info) => {
    if (!book) return
    if (!asset) {
      if (info && info.reason) setMsg(info.reason)
      return
    }
    if (info && info.mode === 'merge' && info.mergedFrom) {
      await persistBook({ ...book, assets: (book.assets || []).map((a) => (a.id === info.mergedFrom ? asset : a)) })
      setMsg(`已合并进《${asset.name}》`)
    } else {
      await persistBook({ ...book, assets: [...(book.assets || []), asset] })
      setMsg(`已新增资产《${asset.name}》`)
    }
    // 不整表 buildLinks：避免覆盖用户手改的边(设计§4.2)；新资产的显式边由 normalizeAsset 从表单/controller/holder/state.place 生成
  }
  // LinkEditor「顺便建档」/结算未建档道具：建一条最小资产(只有名字+类型)，符合"人在环路+不阻断"
  const quickCreateAsset = async ({ name, type }) => {
    if (!book || !name) return
    const minimal = normalizeAsset({ name, type: type || 'person' }, { idPrefix: 'lf' })
    await persistBook({ ...book, assets: [...(book.assets || []), minimal] })
    setMsg(`已顺便建档《${name}》（只有名字，其余字段可后补）`)
  }

  // M43：加载中 / 读取失败 / 确实没书，三态分别给文案——故障不再被说成"空书库"
  if (loading) {
    return <div className="p-8 text-sm text-stone-500">正在加载书库…</div>
  }
  if (loadError) {
    return (
      <div className="space-y-2 p-8 text-sm">
        <p className="text-red-600">书库读取失败：{loadError}</p>
        <p className="text-stone-500">请刷新重试；若另有标签页开着本应用，先关闭它再刷新（数据库升级可能被占用）。</p>
      </div>
    )
  }
  if (!books.length) {
    return <div className="p-8 text-sm text-stone-500">书库还没有书。先到「新手写作」搭框架并落库成书。</div>
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-stone-200 bg-paper p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">第{chapterNo}章</h3>
          <div className="relative">
            <button onClick={() => setBookPickerOpen((o) => !o)} className={ghostBtn} aria-expanded={bookPickerOpen}>
              {book ? book.title : '选择书'} {bookPickerOpen ? '▴' : '▾'}
            </button>
            {bookPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 flex max-h-72 w-60 flex-col gap-1 overflow-y-auto rounded-xl border border-stone-200 bg-paper p-2 shadow-lg">
                {books.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      setBookId(b.id)
                      setBookPickerOpen(false)
                    }}
                    className={`rounded-lg px-3 py-1.5 text-left text-sm ${b.id === bookId ? 'bg-stone-800 font-medium text-white' : 'text-stone-700 hover:bg-stone-100'}`}
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setDrawerOpen(true)} className={ghostBtn}>
            章节（{chapters.length}）
          </button>
          <button onClick={() => setOutlineOpen(true)} className={ghostBtn}>
            查看详纲（{volumeChapters.length}）
          </button>
          <button onClick={() => setAssetOpen(true)} className={ghostBtn}>
            资产库（{((book && book.assets) || []).length}）
          </button>
          <button onClick={() => setNewAssetOpen(true)} className={ghostBtn} title="手动新增一个资产（所有字段可空，全空不入库）">
            +新增资产
          </button>
          <button onClick={() => setGraphOpen(true)} className={ghostBtn}>
            关系图谱
          </button>
          <button onClick={() => setSourceOpen(true)} className={ghostBtn}>
            分析原文
          </button>
          <input value={chapterTitle} onChange={(e) => setChapterTitle(e.target.value)} placeholder="章名" className={`${line} max-w-[140px]`} />
          <label className="text-xs text-stone-500">目标字数</label>
          <input value={targetWords} onChange={(e) => setTargetWords(e.target.value.replace(/[^0-9]/g, ''))} className={`${line} max-w-[70px]`} />
          <button onClick={() => setComposeOpen(true)} className={genBtn}>
            组装本章提示词
          </button>
          <button onClick={saveChapter} className={ghostBtn}>
            保存本章
          </button>
          <button
            onClick={() => setSettlePromptOpen(true)}
            disabled={!String(chapterText || '').trim()}
            className={`${ghostBtn} disabled:cursor-not-allowed disabled:opacity-40`}
            title="据本章正文提取资产状态变更/流转/伏笔推进，勾选后落库（不自动触发，人在环路）"
          >
            结算本章状态
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            disabled={!currentHistory.length}
            className={`${ghostBtn} disabled:cursor-not-allowed disabled:opacity-40`}
            title={currentHistory.length ? `查看本章 ${currentHistory.length} 个历史版本` : '本章暂无历史版本（保存覆盖旧正文后自动留存）'}
          >
            历史版本（{currentHistory.length}）
          </button>
        </div>
        {(pendingUpdates.length > 0 || pendingNew.length > 0) && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {pendingUpdates.length > 0 && (
              <button onClick={() => setUpdatesOpen(true)} className={ghostBtn}>
                查看已有资产更新（{pendingUpdates.length}）
              </button>
            )}
            {pendingNew.length > 0 && (
              <button onClick={() => setNewOpen(true)} className={ghostBtn}>
                查看新资产（{pendingNew.length}）
              </button>
            )}
            <span className="text-xs text-stone-500">分析结果需查看勾选后才落库（默认不勾选；多次分析会累加，未落库的不丢）</span>
          </div>
        )}
        <div className="mb-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs text-stone-600">
          本章章纲：{chapterPlan || '(卷章表没找到第' + chapterNo + '章行，将按主线自由推进)'}　｜　可用资产{buckets.allow.length}个／传闻{buckets.rumor.length}个／未透出{buckets.ban.length}个
          {warnings.length > 0 && <span className="ml-2 text-red-400">关系网警告{warnings.length}条</span>}
          {msg && <span className="ml-2 text-stone-500">{msg}</span>}
        </div>
        <label className={label}>本章摘要（可手改，带入本章提示词）</label>
        <textarea value={prevSummary} onChange={(e) => setPrevSummary(e.target.value)} rows={2} className={`${box} mb-3`} placeholder="本章要达成什么的一句话概要；上一章前情已自动取正文末尾800字带入提示词，无需在此重复" />
        <textarea value={chapterText} onChange={(e) => setChapterText(e.target.value)} rows={18} className={box} placeholder="本章正文（弹窗生成后采纳到这里，可手改）" />
      </section>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setDrawerOpen(false)}>
          <aside className="h-full w-72 overflow-y-auto border-r border-stone-200 bg-paper p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">章节树</h3>
              <button onClick={() => setDrawerOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="收起">
                ×
              </button>
            </div>
            <div className="space-y-1">
              {chapters.map((c) => (
                <button
                  key={c.no}
                  onClick={() => loadChapter(c.no)}
                  className={`block w-full rounded px-2 py-1 text-left text-xs ${c.no === chapterNo ? 'bg-stone-100 font-medium text-ink' : 'text-stone-600 hover:bg-stone-50'}`}
                >
                  第{c.no}章 {c.title === `第${c.no}章` ? planTitleOf(c.no) || '（未命名）' : c.title}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => loadChapter(nextChapterToWrite)} className={ghostBtn}>
                +写第{nextChapterToWrite}章
              </button>
              <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} className={line} title="导出格式">
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <button onClick={exportAll} className={ghostBtn}>
                导出全书
              </button>
            </div>
          </aside>
        </div>
      )}

      <AssetModal
        open={assetOpen}
        onClose={() => setAssetOpen(false)}
        book={book}
        onUpdateAsset={updateAsset}
        onDeleteAsset={deleteAsset}
        onEditAsset={openEdit}
        onExpandOpen={() => setExpandOpen(true)}
        onRelationOpen={() => setRelationOpen(true)}
        onAddAsset={() => setNewAssetOpen(true)}
        warnings={warnings}
        perVol={perVol}
      />

      <EditAssetModal
        editDraft={editDraft}
        setEditDraft={setEditDraft}
        perVol={perVol}
        onClose={() => {
          setEditAsset(null)
          setEditDraft(null)
        }}
        onSave={saveEdit}
        onDelete={() => {
          deleteAsset(editDraft.id)
          setEditAsset(null)
          setEditDraft(null)
        }}
        // 阶段1(设计 §7 1.2)：把名册/章号/顺便建档传给 EditAssetModal——LinkEditor 的目标下拉、StatePanel 的地点下拉
        //   都要靠 assets 才有候选(不传则只能手填)，onQuickCreate 让名册外目标一键建最小资产
        assets={(book && book.assets) || []}
        chapterNo={chapterNo}
        onQuickCreate={quickCreateAsset}
      />


      <PromptEditorModal
        open={analyzeOpen}
        title="分析原文 → 资产（提示词可编辑）"
        initialPrompt={analyzePromptText}
        temperature={0.3}
        onClose={() => setAnalyzeOpen(false)}
        onAdopt={(reply) => {
          setAnalyzeOpen(false)
          adoptAnalyze(reply)
        }}
      />

      {sourceOpen && (
        <div className="fixed inset-0 z-[56] flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[86vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl">
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">分析原文 → 资产更新/新资产</span>
              <button onClick={() => setSourceOpen(false)} className="text-stone-400 hover:text-stone-600">
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-2 flex gap-2">
                <button onClick={() => sourceFileRef.current && sourceFileRef.current.click()} className={ghostBtn}>
                  导入原文文件
                </button>
                <input ref={sourceFileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onSourceFile} />
              </div>
              <textarea value={sourceText} onChange={(e) => setSourceText(e.target.value)} rows={12} className={box} placeholder="粘贴或导入已写章节/参考原文，点「开始分析」产出已有资产更新+新资产两组预览。" />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <button
                onClick={() => {
                  setSourceOpen(false)
                  setAnalyzeOpen(true)
                }}
                disabled={!sourceText.trim()}
                className={genBtn}
              >
                开始分析
              </button>
              <button onClick={() => setSourceOpen(false)} className={ghostBtn}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {updatesOpen && (
        <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={() => setUpdatesOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">已有资产更新预览（勾选后落库）</span>
              <button onClick={() => setUpdatesOpen(false)} className="text-stone-400 hover:text-stone-600">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {pendingUpdates.map((u, i) => (
                <label key={i} className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                  <input type="checkbox" checked={selUp.includes(i)} onChange={(e) => setSelUp(e.target.checked ? [...selUp, i] : selUp.filter((x) => x !== i))} className="mt-0.5" />
                  {/* M31：追加模式下列表可能混着多章的分析结果，标出来源章便于分辨 */}
                  {u.fromCh ? <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-600">第{u.fromCh}章</span> : null}
                  <span className="font-medium text-ink">{u.name}</span>
                  <span className="flex-1 text-stone-600">{u.info}</span>
                  <select value={u.state} onChange={(e) => setPendingUpdates((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} className="rounded border border-stone-300 bg-paper px-1 py-0.5">
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
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              {/* M31：默认不全选，改由这里显式「全选」；旁边给「清空」便于重选 */}
              <span className="mr-auto text-xs text-stone-400">默认不勾选，逐条确认后再落库</span>
              <button onClick={() => setSelUp(pendingUpdates.map((_, i) => i))} className={ghostBtn} disabled={!pendingUpdates.length}>
                全选
              </button>
              <button onClick={() => setSelUp([])} className={ghostBtn} disabled={!selUp.length}>
                清空
              </button>
              <button onClick={applyUpdates} disabled={!selUp.length} className={genBtn}>
                落库选中（{selUp.length}）
              </button>
              <button onClick={() => setUpdatesOpen(false)} className={ghostBtn}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {newOpen && (
        <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={() => setNewOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">新资产预览（勾选后落库）</span>
              <button onClick={() => setNewOpen(false)} className="text-stone-400 hover:text-stone-600">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {pendingNew.map((n, i) => (
                <label key={i} className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                  <input type="checkbox" checked={selNew.includes(i)} onChange={(e) => setSelNew(e.target.checked ? [...selNew, i] : selNew.filter((x) => x !== i))} className="mt-0.5" />
                  <span className="rounded bg-stone-100 px-1 py-0.5 text-stone-600">{n.type}</span>
                  <span className="font-medium text-ink">{n.name}</span>
                  <span className="flex-1 text-stone-600">{n.desc}</span>
                  {/* M31：追加模式下列表可能混着多章的分析结果，标出来源章便于分辨 */}
                  {n.fromCh ? <span className="rounded bg-stone-200 px-1 py-0.5 text-stone-500">来源第{n.fromCh}章</span> : null}
                  <span className="text-stone-500">透出章</span>
                  <input type="number" value={n.reveal || n.fromCh || 0} onChange={(e) => setPendingNew((p) => p.map((x, j) => (j === i ? { ...x, reveal: Number(e.target.value) || 0 } : x)))} className="w-14 rounded border border-stone-300 bg-paper px-1 py-0.5" />
                </label>
              ))}
              {!pendingNew.length && <div className="text-xs text-stone-400">无待落库新资产</div>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              {/* M31：默认不全选，改由这里显式「全选」；旁边给「清空」便于重选 */}
              <span className="mr-auto text-xs text-stone-400">默认不勾选，逐条确认后再落库</span>
              <button onClick={() => setSelNew(pendingNew.map((_, i) => i))} className={ghostBtn} disabled={!pendingNew.length}>
                全选
              </button>
              <button onClick={() => setSelNew([])} className={ghostBtn} disabled={!selNew.length}>
                清空
              </button>
              <button onClick={applyNew} disabled={!selNew.length} className={genBtn}>
                落库选中（{selNew.length}）
              </button>
              <button onClick={() => setNewOpen(false)} className={ghostBtn}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 条件挂载(H13)：只在打开图谱时才挂载，避免 140 轮 O(n²) 力导向布局在弹窗从未打开时也在长篇页加载即跑、阻塞主线程 */}
      {graphOpen && (
        <AssetGraphModal
          open={graphOpen}
          onClose={() => setGraphOpen(false)}
          book={book}
          onUpdateAsset={updateAsset}
          onDeleteAsset={deleteAsset}
          onDelLink={delLink}
          onSavePos={saveGraphPos}
          onRebuildLinks={rebuildLinks}
          onAddAsset={quickCreateAsset}
        />
      )}
      <PromptEditorModal
        open={expandOpen}
        title="扩充资产（次要人物/地点/道具/势力，提示词可编辑）"
        initialPrompt={expandPromptText}
        onClose={() => setExpandOpen(false)}
        onAdopt={appendExpand}
      />
      <PromptEditorModal
        open={relationOpen}
        title="关系网绑定（封闭名册建边，提示词可编辑）"
        initialPrompt={relationPromptText}
        onClose={() => setRelationOpen(false)}
        onAdopt={mergeRelations}
      />
      <PromptEditorModal
        open={composeOpen}
        title={`第${chapterNo}章 · 提示词组装（可编辑）`}
        initialPrompt={composePrompt}
        thinking
        onClose={() => setComposeOpen(false)}
        onAdopt={(reply) => {
          setChapterText(reply)
          setComposeOpen(false)
          // 防剧透门(M45)：①名字≥2字才做包含匹配，避免单字资产名(李/京/城)命中"行李/李白"误报；
          // ②ban 里用 revealChapterOf 区分"明确未透出"(有透出章且晚于本章→真泄漏)与"透出信息缺失"
          //   (revealChapterOf===0，即 ch_reveal=0 且 reveal_volume=0→不参与检测，单独提示去资产库补全)。
          const text = String(reply || '')
          const futureBan = buckets.ban.filter((a) => revealChapterOf(a, perVol) > 0)
          const missingBan = buckets.ban.filter((a) => revealChapterOf(a, perVol) === 0)
          const leak = futureBan.map((a) => a.name).filter((n) => n && n.length >= 2 && text.includes(n))
          const msgs = [
            leak.length
              ? `防剧透门：正文提及未透出资产 ${leak.slice(0, 5).join('、')}${leak.length > 5 ? ' 等' : ''}，请修改正文或调整其透出章`
              : `第${chapterNo}章正文已采纳`,
          ]
          if (missingBan.length) msgs.push(`另有 ${missingBan.length} 个资产缺透出章，请先在资产库补全（这些资产暂不参与防剧透检测）`)
          setMsg(msgs.join('；'))
        }}
      />

      {outlineOpen && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4" onClick={() => setOutlineOpen(false)}>
          <div className="flex max-h-[86vh] w-[min(820px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">全书详纲（{volumeChapters.length} 章 · 已排到第 {maxPlanChapter} 章）</span>
              <button onClick={() => setOutlineOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {volumeChapters.length === 0 && <p className="text-sm text-stone-400">卷章表里还没有章行；先在新手写作排章，或点下方「续排下一卷」。</p>}
              {volumeChapters.map((c) => (
                <button
                  key={c.no}
                  onClick={() => {
                    loadChapter(c.no)
                    setOutlineOpen(false)
                  }}
                  className={`block w-full rounded-lg border px-3 py-2 text-left ${c.no === chapterNo ? 'border-red-300 bg-red-50' : 'border-stone-200 bg-stone-50 hover:border-stone-300'}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">第{c.no}章 · {c.title || '（未命名）'}</span>
                    {c.mood && <span className="shrink-0 text-xs text-stone-400">{c.mood.length > 22 ? c.mood.slice(0, 22) + '…' : c.mood}</span>}
                  </div>
                  {c.synopsis && <p className="mt-1 text-xs leading-relaxed text-stone-500">{c.synopsis.length > 120 ? c.synopsis.slice(0, 120) + '…' : c.synopsis}</p>}
                  {c.hook && c.hook !== c.title && <p className="mt-1 text-xs text-stone-400">钩子：{c.hook.length > 44 ? c.hook.slice(0, 44) + '…' : c.hook}</p>}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-stone-200 px-5 py-3">
              <span className="text-xs text-stone-400">点任意章跳过去写</span>
              <button onClick={() => { setOutlineOpen(false); setNextVolOpen(true) }} className={genBtn}>
                续排下一卷章表
              </button>
            </div>
          </div>
        </div>
      )}

      <PromptEditorModal
        open={nextVolOpen}
        title={`续排第${nextVolInfo.vol}卷 · 第${nextVolInfo.start}章起（提示词可编辑）`}
        initialPrompt={nextVolPromptText}
        onClose={() => setNextVolOpen(false)}
        onAdopt={(reply) => adoptNextVol(reply)}
      />

      {/* 5.5 章节历史版本弹窗：新版在上，逐版可回滚(载回编辑区，确认后保存生效) */}
      {historyOpen && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/50 p-4" onClick={() => setHistoryOpen(false)}>
          <div className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">第{chapterNo}章 · 历史版本（{currentHistory.length}）</span>
              <button onClick={() => setHistoryOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
              {currentHistory.length === 0 && (
                <p className="text-sm text-stone-400">本章暂无历史版本。每次「保存本章」覆盖旧正文时，旧版会自动存进来（最多保留 {HISTORY_MAX} 版）。</p>
              )}
              {[...currentHistory].reverse().map((v, idx) => {
                const key = currentHistory.length - 1 - idx
                const body = String(v.text || '')
                return (
                  <div key={key} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs text-stone-500">
                        {v.savedAt ? new Date(v.savedAt).toLocaleString() : '旧版'} · {body.length} 字{v.title ? ` · ${v.title}` : ''}
                      </span>
                      <button onClick={() => rollbackChapter(v)} className="shrink-0 rounded-lg border border-stone-300 bg-paper px-3 py-1 text-xs text-stone-700 hover:bg-stone-100">
                        回滚到此版
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-stone-600">
                      {body.slice(0, 200)}
                      {body.length > 200 ? '…' : ''}
                    </p>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <span className="mr-auto text-xs text-stone-400">回滚=载回编辑区，确认后点「保存本章」生效（当前正文会存入历史，不丢）</span>
              <button onClick={() => setHistoryOpen(false)} className={ghostBtn}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* B6 结算本章状态：提示词弹窗（system+user 两段，来自 analyzeAssetsMessages），采纳后进预览勾选 */}
      <PromptEditorModal
        open={settlePromptOpen}
        title={`结算第${chapterNo}章状态（提示词可编辑）`}
        systemPrompt={settlePromptText.system}
        initialPrompt={settlePromptText.user}
        temperature={0.3}
        onClose={() => setSettlePromptOpen(false)}
        onAdopt={(reply) => adoptSettle(reply)}
      />

      {/* B6 结算预览：状态变更(旧值→新值,可改状态词)/资产流转/伏笔推进，默认全选、逐条可取消，落库选中才写 */}
      {settlePreviewOpen && (
        <div className="fixed inset-0 z-[57] flex items-center justify-center bg-black/50 p-4" onClick={() => setSettlePreviewOpen(false)}>
          <div className="flex max-h-[86vh] w-[min(720px,95vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
              <span className="font-semibold text-ink">结算第{chapterNo}章 · 预览勾选后落库</span>
              <button onClick={() => setSettlePreviewOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <section>
                <h4 className="mb-1 text-xs font-semibold text-stone-500">状态变更（{pendingState.length}）</h4>
                {pendingState.map((sc, i) => (
                  <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selState.includes(i)} onChange={(e) => setSelState(e.target.checked ? [...selState, i] : selState.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{sc.name}</span>
                    <span className="rounded bg-stone-200 px-1 text-stone-600">{sc.dim || sc.dimKey}</span>
                    <span className="text-stone-400">{oldStateWord(sc)} →</span>
                    <input value={sc.state} onClick={(e) => e.stopPropagation()} onChange={(e) => setPendingState((p) => p.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} className="w-24 rounded border border-stone-300 bg-paper px-1 py-0.5" aria-label="新状态词" />
                    {sc.note && <span className="text-stone-500">{sc.note}</span>}
                    {sc.since ? <span className="text-stone-400">@第{sc.since}章</span> : null}
                  </label>
                ))}
                {!pendingState.length && <div className="text-xs text-stone-400">本章无状态变更</div>}
              </section>
              <section>
                <h4 className="mb-1 text-xs font-semibold text-stone-500">资产流转（{pendingFlow.length}）</h4>
                {pendingFlow.map((fl, i) => (
                  <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selFlow.includes(i)} onChange={(e) => setSelFlow(e.target.checked ? [...selFlow, i] : selFlow.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{fl.person}</span>
                    <span className="rounded bg-stone-200 px-1 text-stone-600">{fl.changeRaw || fl.change}</span>
                    <span className="text-stone-700">{fl.asset}</span>
                    {fl.asset && fl.change === 'gain' && !assetExists(fl.asset) && (
                      <span className="flex items-center gap-1 text-red-400">
                        未建档，落库建为
                        {/* A7：gain 未建档时类型不再硬编码 item——让用户在预览里改（默认 item），落库按此 type 建最小资产 */}
                        <select
                          value={fl.assetType || 'item'}
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
                    {fl.ch ? <span className="text-stone-400">@第{fl.ch}章</span> : null}
                  </label>
                ))}
                {!pendingFlow.length && <div className="text-xs text-stone-400">本章无资产流转</div>}
              </section>
              <section>
                <h4 className="mb-1 text-xs font-semibold text-stone-500">伏笔推进（{pendingHook.length}）</h4>
                {pendingHook.map((hm, i) => (
                  <label key={i} className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2 text-xs">
                    <input type="checkbox" checked={selHook.includes(i)} onChange={(e) => setSelHook(e.target.checked ? [...selHook, i] : selHook.filter((x) => x !== i))} />
                    <span className="font-medium text-ink">{hm.title}</span>
                    <span className="rounded bg-stone-200 px-1 text-stone-600">{hm.moveRaw || hm.move}</span>
                    <span className="text-stone-400">
                      {foreshadowStateOf(hm.title)} → {hm.move === 'mention' ? '(仅提及，不改状态)' : hm.move}
                    </span>
                    {hm.note && <span className="text-stone-500">{hm.note}</span>}
                  </label>
                ))}
                {!pendingHook.length && <div className="text-xs text-stone-400">本章无伏笔推进</div>}
              </section>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <span className="mr-auto text-xs text-stone-400">默认全选，可逐条取消/改状态词；不点落库则库里一个字节都不变（系统不判断、不拦截）</span>
              <button onClick={applySettlement} disabled={!selState.length && !selFlow.length && !selHook.length} className={genBtn}>
                落库选中（{selState.length + selFlow.length + selHook.length}）
              </button>
              <button onClick={() => setSettlePreviewOpen(false)} className={ghostBtn}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* B7 手动新增资产（阶段0 NewAssetModal，全字段可空、全空不入库、重名给合并/仍新增） */}
      <NewAssetModal
        open={newAssetOpen}
        mode="create"
        assets={(book && book.assets) || []}
        perVol={perVol}
        chapterNo={chapterNo}
        idPrefix="lf"
        onSubmit={handleAssetSubmit}
        onClose={() => setNewAssetOpen(false)}
        onQuickCreate={quickCreateAsset}
      />
    </div>
  )
}
