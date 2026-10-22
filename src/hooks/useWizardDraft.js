import { useEffect, useRef, useState } from 'react'
import { put, getById, del } from '../lib/db.js'
import { WIZARD_LS_KEY } from '../lib/backup.js'

// 新手写作向导的草稿域：9 步全部产物字段(21 个) + 已落库书引用 + 写盘错误/载入标志，
// 以及「400ms 防抖写盘 / 卸载与 pagehide flush / 首屏用户输入哨兵 / IndexedDB 覆盖恢复」四个 effect 与清空草稿。
// localStorage 存不含原文样本的轻载荷(首屏快、超配额不中断数据库落盘)，IndexedDB 存全量(原文样本可能整本)。

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(WIZARD_LS_KEY) || 'null') || {}
  } catch {
    return {}
  }
}

function writeWizardDraft(payload, setErr) {
  const { styleSourceText: _omit, ...lightPayload } = payload
  try {
    localStorage.setItem(WIZARD_LS_KEY, JSON.stringify(lightPayload))
  } catch {
    /* 小容量存储超配额时跳过，数据库那份仍在 */
  }
  return put('drafts', { id: WIZARD_LS_KEY, updatedAt: Date.now(), ...payload })
    .then(() => setErr(''))
    .catch(() =>
      setErr('草稿未能保存到浏览器数据库（可能存储空间不足）；请尽快「落库成书」或到「我的」页导出备份，否则刷新后未落库内容可能丢失。')
    )
}

// 第一档④修：clarifyQuestions 归一抽成模块级 helper，供 adoptClarify(写侧) 与两处回读(localStorage 初值 / IDB restore)共用——
//   ClarifyModal 直接渲染 q.question / o.label / o.description，修复前落库的毒丸(字段是对象/数组)刷新即回灌、渲染抛「Objects are not valid as React child」持续崩、只能清空逃生。
//   过滤无效项 + 逐字段 typeof 归一(对象归空、不显 [object Object])；读回旧毒丸也归一成安全空串。写侧/读回侧共用一份，防口径漂移。
export function sanitizeClarifyQuestions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.questions) ? raw.questions : []
  return list
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, 10)
    .map((q) => ({
      ...q,
      question: typeof q.question === 'string' ? q.question : '',
      options: q.options.map((o) =>
        o && typeof o === 'object'
          ? { ...o, label: typeof o.label === 'string' ? o.label : '', description: typeof o.description === 'string' ? o.description : '' }
          : { label: typeof o === 'string' ? o : '', description: '' },
      ),
    }))
}

// 向导草稿 Hook 入口：返回 9 步全部字段的状态与 setter、已落库书引用、清空草稿函数。
export default function useWizardDraft() {
  const [DRAFT] = useState(() => readDraft())
  const [inspiration, setInspiration] = useState(DRAFT.inspiration || '')
  const [targetWords, setTargetWords] = useState(DRAFT.targetWords || '1000000')
  const [brief, setBrief] = useState(DRAFT.brief || '')
  const [clarifyQuestions, setClarifyQuestions] = useState(() => sanitizeClarifyQuestions(DRAFT.clarifyQuestions)) // 第一档④：localStorage 草稿回读也归一，防旧毒丸
  const [clarifyAnswers, setClarifyAnswers] = useState(DRAFT.clarifyAnswers || null)
  const [stylePreset, setStylePreset] = useState(DRAFT.stylePreset || '')
  const [genreNote, setGenreNote] = useState(DRAFT.genreNote || '')
  const [styleNote, setStyleNote] = useState(DRAFT.styleNote || '')
  const [styleProfile, setStyleProfile] = useState(DRAFT.styleProfile || '')
  const [styleSourceText, setStyleSourceText] = useState('')
  const [styleHabits, setStyleHabits] = useState(DRAFT.styleHabits || [])
  const [styleSamples, setStyleSamples] = useState(DRAFT.styleSamples || [])
  const [styleMetrics, setStyleMetrics] = useState(DRAFT.styleMetrics || null)
  const [styleReliable, setStyleReliable] = useState(!!DRAFT.styleReliable)
  // 第2项(avgParaLenFor 半生效)：指纹来源 'distill'(原文蒸馏)|'preset'(预设真值语料)|''；徽标据此措辞，避免选预设存了 metrics 后误报"已蒸馏"
  const [styleMetricsFrom, setStyleMetricsFrom] = useState(DRAFT.styleMetricsFrom || '')
  const [bible, setBible] = useState(DRAFT.bible || '')
  const [characters, setCharacters] = useState(DRAFT.characters || '')
  const [assetTable, setAssetTable] = useState(DRAFT.assetTable || '')
  const [outline, setOutline] = useState(DRAFT.outline || '')
  const [volumes, setVolumes] = useState(DRAFT.volumes || '')
  const [volumes2, setVolumes2] = useState(DRAFT.volumes2 || '')
  const [savedBook, setSavedBook] = useState(null)
  const [saveErr, setSaveErr] = useState('')
  const [draftSaveError, setDraftSaveError] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const loadedRef = useRef(false)
  const skipSaveRef = useRef(false)
  const userTouchedRef = useRef(false)
  const clearedRef = useRef(false)
  //   竞态：点「清空」时 window.confirm 阻塞事件循环，getById('drafts') 常在此间 resolve；clearDraft 同步跑完后其 .then 才执行，
  //   四重防复活(skipSaveRef/draftRef=null/loadedIdbSourceRef=''/del)只覆盖**写侧**，此哨兵补上**读侧**（清空后到达的回填一律丢弃）。
  const draftRef = useRef(null)
  const loadedIdbSourceRef = useRef(null)

  useEffect(() => {
    //   不提前 flush 是有意为之：pre-load 载荷的 styleSourceText 还没从 IDB 载入(为空)，此时 flush 会用空原文覆盖 IDB 里的好草稿=比缺口更严重的数据损坏。
    //   窗口很窄(仅「IDB 载入完成前输入 + 立刻刷新」)，且 userTouchedRef 保证载入完成后不覆盖用户已输入内容——权衡取「宁可不兜这段，也不冒覆盖原文的险」。
    if (!loadedRef.current) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      draftRef.current = null
      return
    }
    //   直接保存会用空值覆盖 IDB 里已存的整本原文样本(永久丢，localStorage 轻载荷不含它、无备份)。用户一旦编辑原文框即把 ref 置 ''(接管)，此兜底自动让位。末尾 ||'' 兜住 ref 仍为 null 的载入失败边角。
    const payload = { inspiration, targetWords, brief, clarifyQuestions, clarifyAnswers, stylePreset, genreNote, styleNote, styleProfile, styleHabits, styleSamples, styleSourceText: styleSourceText || loadedIdbSourceRef.current || '', styleMetrics, styleReliable, styleMetricsFrom, bible, characters, assetTable, outline, volumes, volumes2, savedBookId: savedBook?.id || '' }
    draftRef.current = payload
    const t = setTimeout(() => writeWizardDraft(payload, setDraftSaveError), 400)
    return () => clearTimeout(t)
  }, [inspiration, targetWords, brief, clarifyQuestions, clarifyAnswers, stylePreset, genreNote, styleNote, styleProfile, styleHabits, styleSamples, styleSourceText, styleMetrics, styleReliable, styleMetricsFrom, bible, characters, assetTable, outline, volumes, volumes2, savedBook])

  //   最坏场景：采纳 AI 回复(圣经/资产表/卷章)后 400ms 内切页/刷新 → 整段丢。与 ContinuePage/RevisePage/LongFormPage 的「pagehide + 卸载 flush」同构，WizardPage 是仅剩未修的一页。
  //   best-effort：pagehide 期间 IndexedDB 不保证落盘，但 localStorage(轻载荷)是同步写、多数赶得上。空 deps → 监听只挂一次。
  useEffect(() => {
    const flush = () => {
      if (draftRef.current) writeWizardDraft(draftRef.current, setDraftSaveError)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush() // 卸载(切页签)时立即补写
    }
  }, [])

  useEffect(() => {
    const mark = () => {
      userTouchedRef.current = true
    }
    window.addEventListener('input', mark, { once: true })
    return () => window.removeEventListener('input', mark)
  }, [])

  // IndexedDB 草稿覆盖 localStorage 首屏值（IndexedDB 为准，容量大）
  useEffect(() => {
    let alive = true
    const restoreSavedBook = (id) => {
      if (!id) return
      getById('books', id)
        .then((b) => {
          if (alive && !clearedRef.current && b) setSavedBook(b)
        })
        .catch(() => {})
    }
    getById('drafts', WIZARD_LS_KEY)
      .then((d) => {
        if (!alive || clearedRef.current) return
        // L⑤：仅在 ref 仍为 null(=用户尚未接管原文框)时回填。若用户在 getById resolve 前已编辑/清空过原文框(onChange/导入已把 ref 置 '')，则不回填——否则会用 IDB 旧值盖掉用户的清空、下次保存复活原文。
        //   (不用全局 userTouchedRef 判定：那只反映"碰过任意字段"，用户敲的是灵感框而非原文框时仍须回填原文，故用原文框专属的 null 哨兵。)
        if (loadedIdbSourceRef.current === null) loadedIdbSourceRef.current = (d && d.styleSourceText) || ''
        if (d && !userTouchedRef.current) {
          setInspiration(d.inspiration || '')
          setTargetWords(d.targetWords || '1000000')
          setBrief(d.brief || '')
          setClarifyQuestions(sanitizeClarifyQuestions(d.clarifyQuestions)) // 第一档④：IDB 草稿回读也归一，防旧毒丸刷新回灌崩
          setClarifyAnswers(d.clarifyAnswers || null)
          setStylePreset(d.stylePreset || '')
          setGenreNote(d.genreNote || '')
          setStyleNote(d.styleNote || '')
          setStyleProfile(d.styleProfile || '')
          setStyleHabits(d.styleHabits || [])
          setStyleSamples(d.styleSamples || [])
          setStyleSourceText(d.styleSourceText || '')
          setStyleMetrics(d.styleMetrics || null)
          setStyleReliable(!!d.styleReliable)
          setStyleMetricsFrom(d.styleMetricsFrom || '')
          setBible(d.bible || '')
          setCharacters(d.characters || '')
          setAssetTable(d.assetTable || '')
          setOutline(d.outline || '')
          setVolumes(d.volumes || '')
          setVolumes2(d.volumes2 || '')
        }
        restoreSavedBook((d && d.savedBookId) || DRAFT.savedBookId)
      })
      .catch(() => {
        restoreSavedBook(DRAFT.savedBookId)
      })
      .finally(() => {
        if (alive) {
          loadedRef.current = true
          setDraftLoaded(true)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearDraft = () => {
    if (!window.confirm('确定清空本页草稿吗？所有未落库的内容（简报/圣经/人物/资产表/大纲/卷章/文风）都会被清除，此操作不可撤销。已落库成书的书不受影响。')) return
    //   裸调会立即抛错，导致后面的 del('drafts')/skipSaveRef/21 个 setState 全不执行、点「清空」UI 毫无反应。清除失败不应阻断内存态清空。
    try {
      localStorage.removeItem(WIZARD_LS_KEY)
    } catch {
      /* localStorage 不可用：跳过持久层清除，仍继续清 IndexedDB 草稿与内存态 */
    }
    del('drafts', WIZARD_LS_KEY).catch(() => {})
    skipSaveRef.current = true
    clearedRef.current = true
    draftRef.current = null
    setDraftSaveError('')
    setInspiration('')
    setTargetWords('1000000')
    setBrief('')
    setClarifyQuestions([])
    setClarifyAnswers(null)
    setStylePreset('')
    setGenreNote('')
    setStyleNote('')
    setStyleProfile('')
    setStyleHabits([])
    setStyleSamples([])
    loadedIdbSourceRef.current = ''
    setStyleSourceText('')
    setStyleMetrics(null)
    setStyleReliable(false)
    setStyleMetricsFrom('')
    setBible('')
    setCharacters('')
    setAssetTable('')
    setOutline('')
    setVolumes('')
    setVolumes2('')
    setSavedBook(null)
    setSaveErr('')
  }

  return {
    inspiration, setInspiration,
    targetWords, setTargetWords,
    brief, setBrief,
    clarifyQuestions, setClarifyQuestions,
    clarifyAnswers, setClarifyAnswers,
    stylePreset, setStylePreset,
    genreNote, setGenreNote,
    styleNote, setStyleNote,
    styleProfile, setStyleProfile,
    styleSourceText, setStyleSourceText,
    styleHabits, setStyleHabits,
    styleSamples, setStyleSamples,
    styleMetrics, setStyleMetrics,
    styleReliable, setStyleReliable,
    styleMetricsFrom, setStyleMetricsFrom,
    bible, setBible,
    characters, setCharacters,
    assetTable, setAssetTable,
    outline, setOutline,
    volumes, setVolumes,
    volumes2, setVolumes2,
    savedBook, setSavedBook,
    saveErr, setSaveErr,
    draftSaveError,
    draftLoaded,
    loadedIdbSourceRef,
    clearDraft,
  }
}
