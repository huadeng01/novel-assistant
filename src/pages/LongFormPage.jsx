import { useEffect, useMemo, useRef, useState } from 'react'
import { countWords } from '../lib/utils.js'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
import AssetGraphModal from '../components/AssetGraphModal.jsx'
import AssetModal from '../components/AssetModal.jsx'
import EditAssetModal from '../components/EditAssetModal.jsx'
import { exportDocument, readDocumentFile, READ_ACCEPT, EXPORT_FORMATS } from '../lib/docio.js'
import { analyzeAssetsMessages } from '../lib/prompts.js'
import { parseExpandAssets, parseBookAssets, backfillChapterNos, computeAssetWarnings, parseRelations, revealChapterOf, rumorChapterOf, chapLineNo } from '../lib/parseAssets.js'
// 3a：删死 import——tagForWord/TYPE_BY_LABEL/STATE_LABEL/dashOnly 是 applyStateChange/typeKeyOf 的内部依赖，那两者已收敛进 assets.js，本页不直接引用这 4 个。
//   (L③注：dashOut 曾在此列，后因 applyNew/appendExpand 的名字去重需直接调用，已重新加入 import 并在多处在用——见 :16 与下方 import。)
import { perVolOf, normalizeAsset, saveEditAsset, dashOut } from '../lib/assets.js'
import NewAssetModal from '../components/NewAssetModal.jsx'
import useLongformBook from '../hooks/useLongformBook.js'
import useLongformDraft from '../hooks/useLongformDraft.js'
import useLongformApply from '../hooks/useLongformApply.js'
import useLongformSettlement from '../hooks/useLongformSettlement.js'
// 提示词组装与卷章解析已下沉 lib 单一出处（本页原留 200 行模块级副本 + 156 行 composePrompt useMemo）
import { composeChapterPrompt, expandPrompt, relationPrompt, analyzePrompt, nextVolumePrompt } from '../lib/composeChapterPrompt.js'
import { nextVolumeNoOf, lfDraftKey, HISTORY_MAX } from '../lib/longformPlan.js'
import { box, line, label, genBtn, ghostBtn } from '../components/longform/styles.js'
import ChapterDrawer from '../components/longform/ChapterDrawer.jsx'
import SourceModal from '../components/longform/SourceModal.jsx'
import UpdatesPreviewModal from '../components/longform/UpdatesPreviewModal.jsx'
import NewAssetsPreviewModal from '../components/longform/NewAssetsPreviewModal.jsx'
import OutlineModal from '../components/longform/OutlineModal.jsx'
import HistoryModal from '../components/longform/HistoryModal.jsx'
import SettlementPreviewModal from '../components/longform/SettlementPreviewModal.jsx'

// 长篇写作工作台：中栏写作区 + 可收缩抽屉(章节树) + 弹窗(资产库/图谱/分析原文/编辑资产)。
// 收纳统一为"按钮触发抽屉/弹窗"，按钮样式统一 genBtn/ghostBtn 小按钮，不用全宽长条。
// 样式类名与草稿 key/历史上限的单一出处在 components/longform/styles.js 与 lib/longformPlan.js。

// 结算落库纯函数（applyStateChange/typeKeyOf）已收敛到 assets.js 单一出处、本页 import 复用（其内部依赖 tagForWord/TYPE_BY_LABEL/STATE_LABEL/dashOnly 随之下沉，本页不直接引用）。
//   L③注：dashOut 原也随之内沉，后因 applyNew/appendExpand 名字去重需直接调用已重新 import(见 :16)，非"零调用"。

// 页内不再直发请求，故不需要 apiKey；缺 Key 引导由弹窗承担，onNeedKey 无调用点。父组件 App.jsx 若仍传这两个 prop 会被忽略（可停传，属越界项见报告）。
export default function LongFormPage() {
  const [msg, setMsg] = useState('')
  const bk = useLongformBook({ setMsg })
  const { books, loading, loadError, bookId, setBookId, book, persistBook, deleteAsset, updateAsset, delLink, rebuildLinks, saveGraphPos, handleAssetSubmit, quickCreateAsset } = bk
  // 章纲章名（卷章表第 N 行第 2 列），用作章名缺省，避免章名回落成"第N章"与章号重复
  const planTitleOf = (no) => {
    const line = String((book && book.volumes) || '')
      .split('\n')
      .map((l) => l.trim().replace(/^[｜|]\s*/, ''))
      .find((l) => chapLineNo(l) === no)
    return line ? (line.split(/[｜|]/)[1] || '').trim() : ''
  }
  const draft = useLongformDraft({ bookId, book, planTitleOf, setMsg })
  const {
    chapterNo, setChapterNo, chapterTitle, setChapterTitle, chapterText, setChapterText,
    prevSummary, setPrevSummary, sourceText, setSourceText,
    pendingUpdates, setPendingUpdates, pendingNew, setPendingNew, selUp, setSelUp, selNew, setSelNew,
    pendingState, setPendingState, pendingFlow, setPendingFlow, pendingHook, setPendingHook,
    selState, setSelState, selFlow, setSelFlow, selHook, setSelHook,
    chapterLoadedRef,
  } = draft
  const apply = useLongformApply({ book, persistBook, chapterNo, setMsg, draft })
  const { mergeAnalyzeResult, adoptAnalyze, applyUpdates, applyNew } = apply
  const settle = useLongformSettlement({ book, persistBook, chapterNo, setMsg, draft, mergeAnalyzeResult, runAssetOp: apply.runAssetOp })
  const { adoptSettle, applySettlement, oldStateWord, assetExists, foreshadowStateOf } = settle
  const [bookPickerOpen, setBookPickerOpen] = useState(false)
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
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [settlePromptOpen, setSettlePromptOpen] = useState(false)
  const [settlePreviewOpen, setSettlePreviewOpen] = useState(false)
  const [newAssetOpen, setNewAssetOpen] = useState(false)
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(''), 6000)
    return () => clearTimeout(t)
  }, [msg])

  const chapters = useMemo(() => (book && book.chapters) || [], [book])
  const warnings = useMemo(() => computeAssetWarnings((book && book.assets) || []), [book])
  // 详纲：解析卷章表(book.volumes)的所有章行，供"查看详纲"弹窗纵览全书章表(章号/章名/梗概/节拍/钩子)。
  // 兼容完整表(8列，节拍在第6列)与后段简表(列数少，节拍在第5列)；钩子取末列。
  const volumeChapters = useMemo(() => {
    const out = []
    for (const raw of String((book && book.volumes) || '').split('\n')) {
      const l = raw.trim().replace(/^[｜|]\s*/, '')
      const no = chapLineNo(l)
      if (!no) continue
      const c = l.split(/[｜|]/).map((s) => s.trim())
      out.push({ no, title: c[1] || '', synopsis: c[2] || '', mood: (c.length >= 6 ? c[5] : c[4]) || '', hook: c.length === 8 ? c[7] : '' })
    }
    return out
  }, [book])
  // 已排到的最大章号（卷章表里最后一章），续排下一卷从它的下一章起
  const maxPlanChapter = useMemo(() => volumeChapters.reduce((m, c) => Math.max(m, c.no), 0), [volumeChapters])
  // 后者假设章号连续，有缺口时按钮会指向已存章(点击载入旧章而非新建)、缺口章永远无入口创建。
  const nextChapterToWrite = useMemo(() => {
    const existing = new Set(chapters.map((c) => c.no).filter((n) => Number.isFinite(n)))
    const maxNo = existing.size ? Math.max(...existing) : 0
    for (let n = 1; n <= maxNo + 1; n++) {
      if (!existing.has(n)) return n
    }
    return maxNo + 1
  }, [chapters])
  const nextVolInfo = useMemo(() => {
    const pv = perVolOf(book)
    const start = maxPlanChapter + 1
    const vol = nextVolumeNoOf(book && book.volumes, maxPlanChapter, pv)
    return { start, vol, perVol: pv }
  }, [book, maxPlanChapter])

  const chapterPlan = useMemo(() => {
    if (!book) return ''
    //   详纲(volumeChapters)认得而本章章纲取不到 → 提示词注入「没找到本章行」、章名回落成"第N章"。
    return (
      String(book.volumes || '')
        .split('\n')
        .map((l) => l.trim().replace(/^[｜|]\s*/, ''))
        .find((l) => chapLineNo(l) === chapterNo) || ''
    )
  }, [book, chapterNo])

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

  //   原来只有 loadChapter 有脏检查，rollbackChapter/onAdopt 直写 setChapterText → 未保存的手写正文被静默覆盖（history 只在 saveChapter 压栈，未保存的从未进 history，无处找回）。
  const isChapterDirty = () => {
    //   此窗口编辑区是换书初值/空、与已存章必然不等 → 原会弹无意义 confirm，且用户确认后 loadChapter 的 setChapterNo 又会被随后到达的 restore(:329) 拉回、切换失效。载入完成后再判才有意义。
    if (!chapterLoadedRef.current) return false
    const curSaved = chapters.find((x) => x.no === chapterNo)
    const ne = (a, b) => String(a == null ? '' : a) !== String(b == null ? '' : b)
    // 章名比对基准用"loadChapter 载入时会填的值"(与下方 setChapterTitle 的回退逻辑一致)，避免章名是默认占位'第N章'、载入被回退成 planTitleOf 时"载入即误报脏"
    const loadedTitle = curSaved && curSaved.title && curSaved.title !== `第${chapterNo}章` ? curSaved.title : planTitleOf(chapterNo) || (curSaved ? curSaved.title : '')
    //   ⟹ 未编辑也判脏、每次切章/回滚/采纳弹无意义 confirm。占位章标题是自动派生（非用户手写内容），故这类章**不计标题脏**，正文/摘要才是真判据。
    const placeholderSavedTitle = !!curSaved && (!curSaved.title || curSaved.title === `第${chapterNo}章`)
    const titleDirty = placeholderSavedTitle ? false : ne(chapterTitle, loadedTitle)
    return curSaved
      ? ne(chapterText, curSaved.text) || titleDirty || ne(prevSummary, curSaved.summary)
      : String(chapterText || '').trim() !== '' || String(prevSummary || '').trim() !== '' || ne(chapterTitle, loadedTitle)
  }

  const loadChapter = (no) => {
    // 避免直接覆盖丢未保存内容(草稿是每本书单槽 lf_current:${bookId}，500ms 后会被新章覆盖)。最小改，不做草稿分槽重构。
    if (isChapterDirty() && !window.confirm(`第${chapterNo}章有未保存的改动（正文/章名/摘要），切到第${no}章会丢失。确定切换吗？`)) {
      return
    }
    setChapterNo(no)
    const c = chapters.find((x) => x.no === no)
    const fallback = planTitleOf(no)
    setChapterTitle(c && c.title && c.title !== `第${no}章` ? c.title : fallback || (c ? c.title : ''))
    setChapterText(c ? c.text || '' : '')
    setPrevSummary(c ? c.summary || '' : '')
    setDrawerOpen(false)
    setMsg(c ? `已载入第${no}章` : `新章：第${no}章`)
  }

  // 5.5 当前章的历史版本快照(供"历史版本"弹窗查看/回滚)；旧书 chapters 无 history 字段时为空数组
  const currentHistory = useMemo(() => {
    const c = chapters.find((x) => x.no === chapterNo)
    return (c && c.history) || []
  }, [chapters, chapterNo])

  // 回滚=把历史版本载回编辑区(不直接落库)，用户确认后点"保存本章"生效——保留人在环路，且保存时当前正文会被压入 history。
  const rollbackChapter = (ver) => {
    if (isChapterDirty() && !window.confirm(`第${chapterNo}章有未保存的改动（正文/章名/摘要），回滚到历史版本会丢失当前编辑区内容。确定回滚吗？`)) return
    setChapterText(ver.text || '')
    if (ver.title) setChapterTitle(ver.title)
    setPrevSummary(ver.summary || '')
    setHistoryOpen(false)
    setMsg(`已载回历史版本（${ver.savedAt ? new Date(ver.savedAt).toLocaleString() : '旧版'}），确认后点「保存本章」生效`)
  }

  const composePrompt = useMemo(
    () => composeChapterPrompt({ book, chapters, chapterNo, chapterPlan, buckets, prevSummary, targetWords, perVol }),
    [book, chapters, chapterNo, chapterPlan, buckets, prevSummary, targetWords, perVol],
  )
  // 关闭时返回空串。避免在任意输入框打字触发 LongFormPage 重渲染时反复重拼 MB 级字符串。
  // PromptEditorModal 用 wasOpenRef 只在"由关到开"那刻读 initialPrompt，故打开时算出的值能被正确捕获。
  const analyzePromptText = useMemo(() => (analyzeOpen ? analyzePrompt(book, chapterNo, sourceText) : ''), [analyzeOpen, book, chapterNo, sourceText])
  const expandPromptText = useMemo(() => (expandOpen ? expandPrompt(book) : ''), [expandOpen, book])
  const relationPromptText = useMemo(() => (relationOpen ? relationPrompt(book) : ''), [relationOpen, book])
  const nextVolPromptText = useMemo(() => (nextVolOpen ? nextVolumePrompt(book, nextVolInfo.vol, nextVolInfo.start) : ''), [nextVolOpen, book, nextVolInfo])

  const saveChapter = async () => {
    if (!book) return
    if (chapterSavingRef.current) return
    if (!String(chapterText || '').trim()) {
      setMsg('正文为空，未保存（避免章节树出现空章占位）')
      return
    }
    chapterSavingRef.current = true
    try {
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
      const wordCount = list.reduce((n, c) => n + countWords(c.text), 0)
      await persistBook({ ...book, chapters: list, wordCount })
      //   若不同步，用户「清空章名框→保存」后编辑区仍空、而 loadedTitle 是回退值 ⟹ isChapterDirty 恒真误报「有未保存改动」。text/summary 无回退变换、不必同步。
      setChapterTitle(rec.title)
      setMsg(`第${chapterNo}章已保存${history.length ? `（含 ${history.length} 个历史版本）` : ''}`)
    } finally {
      chapterSavingRef.current = false
    }
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
    //   避免与 maxPlanChapter 漂移(如"21 ｜章名"一处认一处不认)导致续排重复排一章。
    const newMax = String(reply)
      .split('\n')
      .map(chapLineNo)
      .reduce((m, n) => Math.max(m, n || 0), 0)
    setMsg(`已续排第${nextVolInfo.vol}卷：章表排到第${newMax || '?'}章，节拍共${parsed.beats.length}条`)
  }

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
    //   直接落库会把脏结构写进 IDB、被导出备份带走、且不生成派生边。normalizeAsset 迁 state→v2、补默认、按 holder/place 派生边；is_public 死字段显式剔除。
    //   去重键过 dashOut(去《》/首尾空白；L②注：dashOut 不折叠内部空格，与 normName 略有出入，但足以兜住《》/首尾空格差异)：带《》/首尾空格的同名不再漏判成两条重复资产。
    const exist = new Set((book.assets || []).map((a) => dashOut(a.name)).filter(Boolean))
    const freshRaw = []
    add.forEach((a) => {
      const nk = dashOut(a.name)
      if (!nk || exist.has(nk)) return
      exist.add(nk)
      freshRaw.push(a)
    })
    const allNames = new Set([...exist, ...freshRaw.map((a) => dashOut(a.name))])
    const fresh = freshRaw.map((a) => {
      const { is_public: _drop, ...rest } = a // 剔除只写不读的死字段
      const links = (rest.links || []).filter((l) => allNames.has(dashOut(l.to))) // 共现边只留名册内(含本批)目标，避免悬空边
      return normalizeAsset({ ...rest, links }, { idPrefix: 'lf' })
    })
    await persistBook({ ...book, assets: [...(book.assets || []), ...fresh] })
    setExpandOpen(false)
    setMsg(`扩充 ${fresh.length} 个资产（重复 ${add.length - fresh.length} 个已跳过）`)
  }

  const onSourceFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      const content = await readDocumentFile(file)
      if (String(sourceText || '').trim() && String(sourceText) !== String(content) && !window.confirm('导入会替换当前的分析原文（当前未另存的内容将丢失）。确定导入吗？')) return
      setSourceText(content)
    } catch (err) {
      setMsg(err && err.message ? err.message : String(err))
    }
  }

  const exportAll = () => {
    if (!book) return
    if (!chapters.length) {
      setMsg('还没有已保存的章节可导出；先写正文并点「保存本章」，再导出全书。')
      return
    }
    const text = chapters.map((c) => `${c.title}\n\n${c.text || ''}\n`).join('\n')
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
    // controller 只在解析出确定值(非 undefined)时才进白名单：否则 normalizeAsset 会把 `'controller' in src` 判真、
    //   绕过 rebuildDerivedEdges 的 prevCtrl 沿用，把用户没动的既有 controlled_by 边误清空。holder 无此问题(held_by 纯由 holder 派生)。
    const ctrlVal = editDraft.controller !== undefined ? editDraft.controller : editAsset.controller
    const edited = {
      name: editDraft.name,
      type: editDraft.type,
      tier: editDraft.tier !== undefined ? editDraft.tier : editAsset.tier,
      detail: editDraft.detail,
      aliases: editDraft.aliasesStr !== undefined ? editDraft.aliasesStr : editDraft.aliases,
      state: editDraft.state !== undefined ? editDraft.state : editAsset.state,
      //   原白名单漏了 → {...editAsset,...edited} 取旧值，用户改持有者/控制方静默无效(held_by/controlled_by 边不更新)。
      holder: editDraft.holder !== undefined ? editDraft.holder : editAsset.holder,
      ...(ctrlVal !== undefined ? { controller: ctrlVal } : {}),
      ch_reveal: Number(editDraft.ch_reveal) || 0,
      ch_rumor: Number(editDraft.ch_rumor) || 0,
      reveal_volume: Number(editDraft.reveal_volume) || 0,
      rumor_volume: Number(editDraft.rumor_volume) || 0,
      knowers: editDraft.knowersStr !== undefined ? editDraft.knowersStr : editAsset.knowers,
      links: editDraft.links || [],
    }
    updateAsset(editAsset.id, saveEditAsset(editAsset, edited, { idPrefix: 'lf' }))
    setEditAsset(null)
    setEditDraft(null)
    setMsg('资产已更新')
  }

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
        {(pendingUpdates.length > 0 || pendingNew.length > 0 || pendingState.length > 0 || pendingFlow.length > 0 || pendingHook.length > 0) && (
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
            {pendingState.length + pendingFlow.length + pendingHook.length > 0 && (
              <button onClick={() => setSettlePreviewOpen(true)} className={ghostBtn}>
                查看状态结算（{pendingState.length + pendingFlow.length + pendingHook.length}）
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

      <ChapterDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        chapters={chapters}
        chapterNo={chapterNo}
        planTitleOf={planTitleOf}
        nextChapterToWrite={nextChapterToWrite}
        exportFormat={exportFormat}
        setExportFormat={setExportFormat}
        onLoadChapter={loadChapter}
        onExport={exportAll}
      />

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

      <SourceModal
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        sourceText={sourceText}
        setSourceText={setSourceText}
        onFile={onSourceFile}
        onStart={() => {
          setSourceOpen(false)
          setAnalyzeOpen(true)
        }}
      />

      <UpdatesPreviewModal
        open={updatesOpen}
        onClose={() => setUpdatesOpen(false)}
        pendingUpdates={pendingUpdates}
        selUp={selUp}
        setSelUp={setSelUp}
        setPendingUpdates={setPendingUpdates}
        onApply={applyUpdates}
      />

      <NewAssetsPreviewModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        pendingNew={pendingNew}
        selNew={selNew}
        setSelNew={setSelNew}
        setPendingNew={setPendingNew}
        onApply={applyNew}
      />

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
          if (isChapterDirty() && !window.confirm(`第${chapterNo}章有未保存的改动（正文/章名/摘要），采纳生成稿会覆盖当前编辑区内容。确定采纳吗？`)) return
          setChapterText(reply)
          setComposeOpen(false)
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

      <OutlineModal
        open={outlineOpen}
        onClose={() => setOutlineOpen(false)}
        volumeChapters={volumeChapters}
        maxPlanChapter={maxPlanChapter}
        chapterNo={chapterNo}
        onLoadChapter={(no) => {
          loadChapter(no)
          setOutlineOpen(false)
        }}
        onNextVol={() => {
          setOutlineOpen(false)
          setNextVolOpen(true)
        }}
      />

      <PromptEditorModal
        open={nextVolOpen}
        title={`续排第${nextVolInfo.vol}卷 · 第${nextVolInfo.start}章起（提示词可编辑）`}
        initialPrompt={nextVolPromptText}
        onClose={() => setNextVolOpen(false)}
        onAdopt={(reply) => adoptNextVol(reply)}
      />

      {/* 5.5 章节历史版本弹窗：新版在上，逐版可回滚(载回编辑区，确认后保存生效) */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chapterNo={chapterNo}
        currentHistory={currentHistory}
        onRollback={rollbackChapter}
      />

      <PromptEditorModal
        open={settlePromptOpen}
        title={`结算第${chapterNo}章状态（提示词可编辑）`}
        systemPrompt={settlePromptText.system}
        initialPrompt={settlePromptText.user}
        temperature={0.3}
        onClose={() => setSettlePromptOpen(false)}
        onAdopt={(reply) => adoptSettle(reply)}
      />

      <SettlementPreviewModal
        open={settlePreviewOpen}
        onClose={() => setSettlePreviewOpen(false)}
        chapterNo={chapterNo}
        pendingState={pendingState}
        selState={selState}
        setSelState={setSelState}
        setPendingState={setPendingState}
        pendingFlow={pendingFlow}
        selFlow={selFlow}
        setSelFlow={setSelFlow}
        setPendingFlow={setPendingFlow}
        pendingHook={pendingHook}
        selHook={selHook}
        setSelHook={setSelHook}
        setPendingHook={setPendingHook}
        oldStateWord={oldStateWord}
        assetExists={assetExists}
        foreshadowStateOf={foreshadowStateOf}
        onApply={applySettlement}
      />

      <NewAssetModal
        open={newAssetOpen}
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
