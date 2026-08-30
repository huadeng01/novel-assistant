import { useCallback, useEffect, useState } from 'react'
import { useBooks } from './useBooks.js'
import { getById, put } from '../lib/db.js'
import { chatJSON } from '../lib/llm.js'
import { styleAnalyzeMessages, sampleNovel } from '../lib/prompts.js'

// 书库 + 文风档案统一管理：改写润色与新手写作两个模块共用
export function useLibrary() {
  const { books, loading, importFile, removeBook: removeBookRaw } = useBooks()
  const [selectedId, setSelectedId] = useState(null)
  const [style, setStyle] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)

  // 切换选中书籍时加载对应文风档案
  useEffect(() => {
    let cancelled = false
    if (!selectedId) {
      setStyle(null)
      return
    }
    getById('styles', selectedId).then((rec) => {
      if (!cancelled) setStyle(rec || null)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const select = useCallback((id) => setSelectedId(id), [])

  const removeBook = useCallback(
    async (id) => {
      await removeBookRaw(id)
      if (selectedId === id) setSelectedId(null)
    },
    [removeBookRaw, selectedId],
  )

  // 参照这本小说拆分作者书写习惯；"去除 AI 味"由 AI 自身的固有规则处理，不再从用户文章里检查
  const analyze = useCallback(
    async (apiKey) => {
      const book = books.find((b) => b.id === selectedId)
      if (!book) return
      setAnalyzing(true)
      try {
        const samples = sampleNovel(book.content)
        const res = await chatJSON({ apiKey, messages: styleAnalyzeMessages(samples), temperature: 0.3 })
        const record = {
          bookId: book.id,
          profile: res.style_profile || '',
          habits: Array.isArray(res.habits) ? res.habits : [],
          // 禁用词改为纯用户手动管理：重新分析时保留用户已添加的词，不覆盖
          forbidden: style?.forbidden || [],
          updatedAt: Date.now(),
        }
        await put('styles', record)
        setStyle(record)
      } finally {
        setAnalyzing(false)
      }
    },
    [books, selectedId, style],
  )

  // 黑名单手动增删后立即持久化
  const updateForbidden = useCallback(
    async (list) => {
      if (!style) return
      const rec = { ...style, forbidden: list, updatedAt: Date.now() }
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
    selectedId,
    selectedBook,
    select,
    style,
    analyzing,
    analyze,
    updateForbidden,
  }
}
