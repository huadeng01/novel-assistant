import { useCallback, useEffect, useState } from 'react'
import { getAll, getById, put, del } from '../lib/db.js'
import { normalizeAsset } from '../lib/assets.js'
import { uid, countWords } from '../lib/utils.js'
import { readDocumentFile, baseName } from '../lib/docio.js'

// 书库数据管理：导入设备上的小说文件（电脑选磁盘、平板选「文件」App）
export function useBooks() {
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const list = await getAll('books')
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) // createdAt 缺失兜底 0，避免 NaN 比较器(M19)
      // 阶段1(设计 §4.1)：读入口统一过 normalizeAsset——旧书 state:'alive' 等迁成 v2 结构，下游 AssetModal/EditAssetModal/useAssets 不会白屏
      setBooks(list.map((b) => (b && Array.isArray(b.assets) ? { ...b, assets: b.assets.map((a) => normalizeAsset(a)) } : b)))
    } catch {
      setBooks([]) // 读取失败也要退出加载态，否则界面永久转圈、用户得不到任何原因(M19)
    } finally {
      setLoading(false)
    }
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
    try {
      await del('books', id) // 主删除：books 是列表数据源
      // M-11：级联清理不该阻断主删除——styles 单独 try/catch，失败至多留一份孤儿档案(下次分析覆盖)，书已能从列表移除
      try {
        await del('styles', id)
      } catch {
        /* 忽略 styles 清理失败 */
      }
      // 级联清理指向这本书的长篇编辑草稿(lf_current)，避免切回时恢复到已删书(M20)
      try {
        const lf = await getById('drafts', 'lf_current')
        if (lf && lf.bookId === id) await del('drafts', 'lf_current')
      } catch {
        /* 忽略草稿清理失败 */
      }
    } finally {
      await refresh() // M-11：无论删除/清理是否抛错都刷新列表，避免书已删但列表仍显示(或反之卡在不一致态)
    }
  }, [refresh])

  return { books, loading, importFile, removeBook, refresh }
}
