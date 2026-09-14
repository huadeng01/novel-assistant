import { useCallback, useEffect, useState } from 'react'
import { getAll, put, del } from '../lib/db.js'
import { uid, countWords } from '../lib/utils.js'

// 书库数据管理：导入设备上的小说文件（电脑选磁盘、平板选「文件」App）
export function useBooks() {
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const list = await getAll('books')
    list.sort((a, b) => b.createdAt - a.createdAt)
    setBooks(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const importFile = useCallback(async (file) => {
    const content = await file.text()
    if (countWords(content) < 100) {
      throw new Error('这个文件内容太少了，请选择至少有一定篇幅的小说文件。')
    }
    const book = {
      id: uid(),
      name: file.name.replace(/\.(txt|md)$/i, ''),
      content,
      wordCount: countWords(content),
      createdAt: Date.now(),
    }
    await put('books', book)
    await refresh()
    return book
  }, [refresh])

  const removeBook = useCallback(async (id) => {
    await del('books', id)
    await del('styles', id)
    await refresh()
  }, [refresh])

  return { books, loading, importFile, removeBook }
}
