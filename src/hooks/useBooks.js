import { useCallback, useEffect, useState } from 'react'
import { getAll, put, del } from '../lib/db.js'
import { uid, countWords } from '../lib/utils.js'
import { readDocumentFile, baseName } from '../lib/docio.js'

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
    // 支持 .txt / .md / .docx（docx 走 mammoth 抽取纯文本）；.doc 老式二进制会抛错提示转存 .docx
    const content = await readDocumentFile(file)
    if (countWords(content) < 100) {
      throw new Error('这个文件内容太少了，请选择至少有一定篇幅的小说文件。')
    }
    const book = {
      id: uid(),
      name: baseName(file.name) || '未命名',
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
