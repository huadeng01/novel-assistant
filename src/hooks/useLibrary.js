import { useCallback, useEffect, useRef, useState } from 'react'
import { useBooks } from './useBooks.js'
import { getById, put } from '../lib/db.js'
import { chatJSON } from '../lib/llm.js'
import { styleAnalyzeMessages, sampleNovel } from '../lib/prompts.js'
import { distillStyleBand } from '../lib/longform.js'

// 5.3：内置题材选项（能映射到主导嗓音的 12 个）。单一出处仍是 worldviews 的 GENRE_STYLE_TABLE/benchmarkRefOf——
// 这里只给用户一份可选清单；选中值传入 resolveStyleRec 后由 benchmarkRefOf 查表，查不到（或选「不限」）安全回落默认嗓音。
// 其余 8 个内置题材（历史/都市/现实/科幻/末世/军事/轻小说/竞技）在表里没有 benchmark，选了等同「不限」，故不单列。
export const GENRE_OPTIONS = ['玄幻', '仙侠', '修真', '奇幻', '武侠', '无限流', '恐怖', '悬疑', '推理', '言情', '古代言情', '游戏']
const GENRE_KEY = 'na_genre'
const SELECTED_BOOK_KEY = 'na_selected_book' // M12：记住选中的书，切 tab / 刷新不丢（App 条件渲染会卸载重挂各页）

// 书库 + 文风档案统一管理：改写润色与新手写作两个模块共用
export function useLibrary() {
  const { books, loading, importFile, removeBook: removeBookRaw, refresh } = useBooks()
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return localStorage.getItem(SELECTED_BOOK_KEY) || null
    } catch {
      return null
    }
  })
  const [style, setStyle] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  // M11：追踪最新 style 的 ref——analyze 是长异步，期间用户可能 updateForbidden 加词；写回时用 ref 里的最新 forbidden，不整体覆盖用户新加的词
  const styleRef = useRef(style)
  useEffect(() => {
    styleRef.current = style
  }, [style])
  // 5.3：题材（genre）来源。持久化到 localStorage；绑定的书若其文风档案存过 genre，载入 effect 会用书里的 genre 覆盖。
  // M21：续写页已删除文风块（不再解析/注入文风、不消费 genre，改由 continueMessages 的 CONTINUE_STYLE_HINT 直接参照原文风格），故 genre 现仅改写润色页（RevisePage）消费——原「改写/续写两页共享、两页嗓音一致」的说明已随之失效，删去。
  const [genre, setGenreState] = useState(() => {
    try {
      return localStorage.getItem(GENRE_KEY) || ''
    } catch {
      return ''
    }
  })
  const setGenre = useCallback((g) => {
    const v = g || ''
    try {
      localStorage.setItem(GENRE_KEY, v)
    } catch {
      /* 隐私模式/配额满：仅本次会话有效 */
    }
    setGenreState(v)
  }, [])
  // 最新 selectedId 的 ref：供异步 analyze 完成时比对，防分析中切书把旧书档案上屏到新书(M15)
  const selectedIdRef = useRef(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // 切换选中书籍时加载对应文风档案
  useEffect(() => {
    let cancelled = false
    setStyle(null) // 切书先清空，避免异步窗口里持续显示上一本书的档案(M16)
    if (!selectedId) return () => {}
    getById('styles', selectedId)
      .then((rec) => {
        if (!cancelled) {
          setStyle(rec || null)
          // 5.3：书的文风档案若存过 genre，带入当前题材选择（让"同一本书两页嗓音一致"跟书走）
          if (rec && typeof rec.genre === 'string') setGenre(rec.genre)
        }
      })
      .catch(() => {
        if (!cancelled) setStyle(null) // 读取失败不留旧值、不产生未处理 rejection(M16)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, setGenre])

  const select = useCallback((id) => {
    setSelectedId(id)
    try {
      if (id) localStorage.setItem(SELECTED_BOOK_KEY, id)
      else localStorage.removeItem(SELECTED_BOOK_KEY)
    } catch {
      /* 隐私模式/配额：仅本次会话有效 */
    }
  }, [])

  const removeBook = useCallback(
    async (id) => {
      await removeBookRaw(id)
      if (selectedId === id) {
        setSelectedId(null)
        try {
          localStorage.removeItem(SELECTED_BOOK_KEY) // M12：删书同步清掉持久化的选中项，避免刷新后指向已删书
        } catch {
          /* 忽略 */
        }
      }
    },
    [removeBookRaw, selectedId],
  )

  // 参照这本小说拆分作者书写习惯；"去除 AI 味"由 AI 自身的固有规则处理，不再从用户文章里检查
  const analyze = useCallback(
    async (apiKey) => {
      const book = books.find((b) => b.id === selectedId)
      if (!book) return
      if (!String(book.content || '').trim()) {
        throw new Error('这本书没有正文（建书页落库的书只有框架），无法抽样分析文风；请导入带正文的小说文件。')
      }
      const startedId = selectedId // 发起时的书；完成时与 selectedIdRef 比对，防切书后把旧书档案上屏到新书(M15)
      setAnalyzing(true)
      try {
        const samples = sampleNovel(book.content)
        if (!samples || !samples.length) {
          throw new Error('这本书切不出足够长的样本段落（正文可能都是短行），无法分析文风。') // M17：空样本不发空请求，避免 AI 凭空编一份幻觉档案落库
        }
        const res = await chatJSON({ apiKey, messages: styleAnalyzeMessages(samples), temperature: 0.3 })
        // P1-1R 量化指纹：对采样原文蒸馏本书专属多维文体指纹 + 阈值（与 LLM 定性 profile 互补，零 Token、确定性）
        const band = distillStyleBand(samples.join('\n'))
        const record = {
          bookId: book.id,
          origin: 'user',
          profile: res.style_profile || '',
          habits: Array.isArray(res.habits) ? res.habits : [],
          // 文风范例（原样摘录的典型段落）：写作时作为 few-shot 注入，模仿效果强于纯描述；旧档案无此字段时为空
          samples: Array.isArray(res.samples) ? res.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [],
          // 禁用词改为纯用户手动管理：重新分析时保留用户已添加的词，不覆盖
          forbidden: styleRef.current?.forbidden || [], // M11：用最新 forbidden（分析期间用户可能新增了禁用词），不用闭包捕获的旧 style，避免完成写回时覆盖掉新词
          // 本书专属量化指纹（14 维）。注：原消费方 styleDriftScan 漂移门 / codeLayerAudit 自适应阈值已随暗箱流水线物理删除；
          // 这几个字段暂作为文风档案元数据保留（当前无新消费方），如需精简可后续评估删除——本轮按"注释保留不删字段"处理。
          metrics: band.metrics,
          thresholds: band.thresholds,
          bandReliable: band.reliable,
          genre, // 5.3：把当前题材选择存进档案，绑定该书时自动带回（改写页/续写页主导嗓音跟书一致）
          updatedAt: Date.now(),
        }
        // L-11：分析期间该书可能已被删除；落库 styles 前复查书是否还在，避免 put 重建一份指向已删书的孤儿档案
        const stillExists = await getById('books', book.id).catch(() => null)
        if (!stillExists) return // 书已删：丢弃分析结果，不落孤儿 styles（finally 仍会复位 analyzing）
        await put('styles', record)
        if (startedId === selectedIdRef.current) setStyle(record) // 仅当仍停在发起时那本书才上屏，否则丢弃结果(M15)
      } finally {
        setAnalyzing(false)
      }
    },
    [books, selectedId, style, genre],
  )

  // 黑名单手动增删后立即持久化
  const updateForbidden = useCallback(
    async (list) => {
      if (!style) throw new Error('请先分析出文风档案，再管理禁用词。') // M18：无档案时明确报错，不静默吞掉用户输入
      const rec = { ...style, origin: 'user', forbidden: list, updatedAt: Date.now() }
      await put('styles', rec)
      setStyle(rec)
    },
    [style],
  )

  const selectedBook = books.find((b) => b.id === selectedId) || null

  return {
    books,
    loading,
    importFile,
    removeBook,
    refresh,
    selectedId,
    selectedBook,
    select,
    style,
    analyzing,
    analyze,
    updateForbidden,
    genre,
    setGenre,
  }
}
