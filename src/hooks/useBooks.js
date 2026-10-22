import { useCallback, useEffect, useState } from 'react'
import { getAll, getById, put, del } from '../lib/db.js'
import { normalizeAsset } from '../lib/assets.js'
import { uid, countWords } from '../lib/utils.js'
import { readDocumentFile, baseName } from '../lib/docio.js'

// 书库数据管理：导入设备上的小说文件（电脑选磁盘、平板选「文件」App）
export function useBooks() {
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const list = await getAll('books')
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      // 阶段1(设计 §4.1)：读入口统一过 normalizeAsset——旧书 state:'alive' 等迁成 v2 结构，下游 AssetModal/EditAssetModal/useAssets 不会白屏
      setBooks(list.map((b) => (b && Array.isArray(b.assets) ? { ...b, assets: b.assets.map((a) => normalizeAsset(a)) } : b)))
      setLoadError('')
    } catch (e) {
      setLoadError((e && e.message) || String(e) || '书库读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  //   useAssets 落库时会把刚写盘的书 nb 透传给 onPersisted；连续编辑每 400ms 一次 commit，若每次都 refresh()
  //   就是「每 400ms 把整个书库读出来、把每本书的每个资产重新归一」——书多/资产多时明显卡。这里按 id 定点替换那一本。
  const syncBook = useCallback((nb) => {
    if (!nb || !nb.id) return
    const norm = Array.isArray(nb.assets) ? { ...nb, assets: nb.assets.map((a) => normalizeAsset(a)) } : nb
    setBooks((prev) => {
      const i = prev.findIndex((b) => b && b.id === nb.id)
      if (i < 0) return prev // 内存里没有这本（罕见）：不动，下次切书/删书的全量 refresh 会兜底
      const next = prev.slice()
      next[i] = norm
      return next
    })
  }, [])

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

  // 用户需求(第一档后续)：续写页粘贴的原文没有对应的书 → "分析资产"无处落库(资产 per-book、无书则按钮禁用)。
  //   提供"从文本建书"：与 importFile 同构，只是 content 来自粘贴文本而非文件；name 缺省取原文首个非空行(截断 20 字)。
  const createBookFromText = useCallback(async (text, name) => {
    const content = String(text || '')
    if (countWords(content) < 50) throw new Error('原文太少了（至少几十字），无法建档成书。')
    const firstLine = content.split('\n').map((l) => l.trim()).find((l) => l) || ''
    const book = {
      id: uid(),
      name: (String(name || '').trim() || firstLine).slice(0, 20) || '续写原文',
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
      try {
        await del('styles', id)
      } catch {
        /* 忽略 styles 清理失败 */
      }
      //   原代码只 getById/del 旧单槽键 → 分槽键永不命中 → 每本删掉的书其长篇草稿 100% 残留 IDB，还会被"导出备份"打包带走(隐私)。
      //   改为直接删本书分槽键(本书专属；删不存在的键是 no-op、不抛)；并兼容清一次旧单槽键(历史遗留数据，若指向本书)。
      try {
        await del('drafts', `lf_current:${id}`)
        const lf = await getById('drafts', 'lf_current')
        if (lf && lf.bookId === id) await del('drafts', 'lf_current')
      } catch {
        /* 忽略草稿清理失败 */
      }
    } finally {
      await refresh()
    }
  }, [refresh])

  return { books, loading, loadError, importFile, createBookFromText, removeBook, refresh, syncBook }
}
