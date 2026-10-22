import { useEffect, useRef, useState } from 'react'
import { getById, put } from '../lib/db.js'
import { lfDraftKey } from '../lib/longformPlan.js'

// 长篇页编辑草稿域：当前章四态(章号/章名/正文/摘要) + 分析原文 + 两族落库预览列表(更新/新资产/状态/流转/伏笔)与勾选，
// 统一做「换书恢复 / 500ms 防抖持久化 / 离场 flush」三件事，防切页签、刷新、换书丢未保存内容。
// 落库预览列表放在这里是因为它们的持久化与恢复归属草稿；落库 hook 通过 draft 对象读写它们。
export default function useLongformDraft({ bookId, book, planTitleOf, setMsg }) {
  const [chapterNo, setChapterNo] = useState(1)
  const [chapterTitle, setChapterTitle] = useState('')
  const [chapterText, setChapterText] = useState('')
  // 上一章前情由 composePrompt 的 prevTail(上章正文末尾800字)自动承担，不依赖此字段。
  const [prevSummary, setPrevSummary] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [pendingUpdates, setPendingUpdates] = useState([])
  const [pendingNew, setPendingNew] = useState([])
  const [selUp, setSelUp] = useState([])
  const [selNew, setSelNew] = useState([])
  const [pendingState, setPendingState] = useState([])
  const [pendingFlow, setPendingFlow] = useState([])
  const [pendingHook, setPendingHook] = useState([])
  const [selState, setSelState] = useState([])
  const [selFlow, setSelFlow] = useState([])
  const [selHook, setSelHook] = useState([])
  const chapterLoadedRef = useRef(false)
  //   换书 effect 据此在切走前 flush 一次，堵住"输入后 500ms 内换书→pending 存盘被 cleanup 取消→最近输入静默丢失"的 debounce 竞态。
  const pendingDraftRef = useRef(null)

  useEffect(() => {
    //   其 cleanup 只 clearTimeout、不写盘，最近输入会静默丢失。pendingDraftRef 带的是旧书 bookId 与内容，写回旧书草稿槽 lf_current:旧id，不会串到新书。
    //   (本 effect 声明在持久化 effect 之前，故其 setup 先跑；此时 pendingDraftRef 仍是旧书内容，持久化 effect 的 cleanup 不会清它)
    if (pendingDraftRef.current) {
      put('drafts', pendingDraftRef.current).catch(() => {})
      pendingDraftRef.current = null
    }
    setSourceText('')
    setPendingUpdates([])
    setPendingNew([])
    setSelUp([])
    setSelNew([])
    setPendingState([])
    setPendingFlow([])
    setPendingHook([])
    setSelState([])
    setSelFlow([])
    setSelHook([])
    setMsg('')
    // 被下方持久化 effect 写进新书草稿槽(lf_current:新书id)，甚至点「保存本章」把旧书正文落成新书的章(H 级数据损坏)。
    setChapterNo(1)
    setChapterText('')
    setChapterTitle('')
    setPrevSummary('')
    chapterLoadedRef.current = false
    let alive = true
    getById('drafts', lfDraftKey(bookId))
      .then((d) => {
        if (!alive) return
        if (d && bookId && d.bookId === bookId) {
          setChapterNo(d.chapterNo || 1)
          setChapterText(d.chapterText || '')
          setChapterTitle(d.chapterTitle || '')
          setPrevSummary(d.prevSummary || '')
          setSourceText(typeof d.sourceText === 'string' ? d.sourceText : '')
          setPendingUpdates(Array.isArray(d.pendingUpdates) ? d.pendingUpdates : [])
          setPendingNew(Array.isArray(d.pendingNew) ? d.pendingNew : [])
          setPendingState(Array.isArray(d.pendingState) ? d.pendingState : [])
          setPendingFlow(Array.isArray(d.pendingFlow) ? d.pendingFlow : [])
          setPendingHook(Array.isArray(d.pendingHook) ? d.pendingHook : [])
          setSelUp(Array.isArray(d.selUp) ? d.selUp : [])
          setSelNew(Array.isArray(d.selNew) ? d.selNew : [])
          setSelState(Array.isArray(d.selState) ? d.selState : [])
          setSelFlow(Array.isArray(d.selFlow) ? d.selFlow : [])
          setSelHook(Array.isArray(d.selHook) ? d.selHook : [])
        } else {
          const first = ((book && book.chapters) || []).find((c) => c.no === 1)
          setChapterNo(1)
          setChapterText(first ? first.text || '' : '')
          setChapterTitle(first && first.title && first.title !== '第1章' ? first.title : planTitleOf(1) || (first ? first.title : ''))
          setPrevSummary(first ? first.summary || '' : '')
        }
      })
      .catch(() => {
      })
      .finally(() => {
        if (alive) chapterLoadedRef.current = true // 载入结束(成败都)才放行持久化 effect 写盘
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  //   而 UI 文案「未落库的不丢」在刷新场景就是假承诺；纳入后刷新不必重跑分析重烧额度，且每本书各自一槽互不串。
  useEffect(() => {
    if (!bookId) return
    if (!chapterLoadedRef.current) return
    const payload = {
      id: lfDraftKey(bookId),
      bookId,
      chapterNo,
      chapterText,
      prevSummary,
      chapterTitle,
      sourceText,
      pendingUpdates,
      pendingNew,
      pendingState,
      pendingFlow,
      pendingHook,
      selUp,
      selNew,
      selState,
      selFlow,
      selHook,
      updatedAt: Date.now(),
    }
    pendingDraftRef.current = payload
    const t = setTimeout(() => {
      //   (pagehide/卸载时的 flush 仍 best-effort 不提示：那两种场景页面正在离场，弹提示也看不到。)
      put('drafts', payload).catch(() =>
        setMsg('草稿未能保存到浏览器数据库（可能存储空间不足）；未落库内容刷新后可能丢失，请尽快「保存本章」或到「我的」页导出备份。')
      )
      pendingDraftRef.current = null // 已尝试落盘，换书/卸载无需再 flush(失败重试无益、已明示用户)
    }, 500)
    return () => clearTimeout(t)
  }, [bookId, chapterNo, chapterText, prevSummary, chapterTitle, sourceText, pendingUpdates, pendingNew, pendingState, pendingFlow, pendingHook, selUp, selNew, selState, selFlow, selHook])

  //   切页签走 React cleanup(App 用 key={tab} 卸载本页)；但刷新/关标签**不走 React cleanup**，必须另挂 pagehide 才兜得住(与 ContinuePage/RevisePage 同口径)。
  //   刻意不放持久化 effect 的 cleanup 里：deps 每次按键都变→cleanup 每次都跑→会变成每键写盘、废掉 500ms debounce。空 deps 保证监听只挂一次。
  //   注：IndexedDB 在 pagehide 期间不保证落盘(best-effort，多数赶得上)，与另两页一致。
  useEffect(() => {
    const flush = () => {
      if (pendingDraftRef.current) {
        put('drafts', pendingDraftRef.current).catch(() => {})
        pendingDraftRef.current = null
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush() // 卸载(切页签)时立即补写，兜住防抖窗口内的最后编辑
    }
  }, [])

  return {
    chapterNo, setChapterNo,
    chapterTitle, setChapterTitle,
    chapterText, setChapterText,
    prevSummary, setPrevSummary,
    sourceText, setSourceText,
    pendingUpdates, setPendingUpdates,
    pendingNew, setPendingNew,
    selUp, setSelUp,
    selNew, setSelNew,
    pendingState, setPendingState,
    pendingFlow, setPendingFlow,
    pendingHook, setPendingHook,
    selState, setSelState,
    selFlow, setSelFlow,
    selHook, setSelHook,
    chapterLoadedRef,
  }
}
