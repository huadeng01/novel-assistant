import { useEffect, useRef, useState } from 'react'
import { getAll, put } from '../lib/db.js'
import { normalizeAsset, buildLinks, findByName } from '../lib/assets.js'

// 长篇页书库域：书库加载与选中、book 的乐观更新基准 bookRef、两条写库路径(persistBook 直接写 / mutateBook 原子更新)、
// 以及即发即忘的资产 CRUD（删/改/边/布局/顺便建档/手动新增落库）。
export default function useLongformBook({ setMsg }) {
  const [books, setBooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [bookId, setBookId] = useState('')
  const bookRef = useRef(null)

  const book = books.find((b) => b.id === bookId) || null
  useEffect(() => {
    bookRef.current = book
  }, [book])

  useEffect(() => {
    let alive = true
    setLoading(true)
    getAll('books')
      .then((bs) => {
        if (!alive) return
        //   在这层归一，下游 buckets·revealChapterOf·AssetGraphModal·composePrompt 都吃到 v2 结构。只在内存归一，不写库(非破坏)。
        setBooks((bs || []).map((b) => (b ? { ...b, assets: (b.assets || []).map((a) => normalizeAsset(a, { idPrefix: 'lf' })) } : b)))
        setLoadError('')
        if (bs && bs.length) {
          // 续写页"转长篇"会留下要打开的书号，优先选中它
          let want = null
          try {
            want = localStorage.getItem('na_open_book')
            localStorage.removeItem('na_open_book')
          } catch {
            /* 存储不可用：忽略续写页留下的书号，回落默认选中第一本 */
          }
          setBookId((cur) => cur || (want && bs.some((b) => b.id === want) ? want : bs[0].id))
        }
      })
      .catch((e) => {
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

  const persistBook = async (nb) => {
    // 并发时，后发起的 mutateBook 会读到 persistBook 之前的陈旧基准、把 persistBook 刚写的内容覆盖掉(lost update)。同步后两条写路径共用同一最新基准，堵住主窗口。
    // 放在 put 之前(同步执行)：调用 persistBook 的那一刻基准就跟上，await 期间若有 mutateBook 插入也读到最新 nb。
    const prev = bookRef.current
    bookRef.current = nb
    try {
      await put('books', nb)
      setBooks((bs) => bs.map((b) => (b.id === nb.id ? nb : b)))
    } catch (e) {
      // 否则 bookRef 领先于库，后续 mutateBook 会基于未落库的 nb 继续写。
      bookRef.current = prev
      setMsg('保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）')
    }
  }

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
      bookRef.current = cur
      setBooks((bs) => bs.map((b) => (b.id === cur.id ? cur : b)))
      setMsg('保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足，已回滚未存的改动）')
    }
  }

  const deleteAsset = (id) => mutateBook((b) => ({ ...b, assets: (b.assets || []).filter((a) => a.id !== id) }))

  const updateAsset = (id, patch) => mutateBook((b) => ({ ...b, assets: (b.assets || []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }))

  const delLink = (assetId, toName, type) =>
    mutateBook((b) => ({
      ...b,
      assets: (b.assets || []).map((a) => (a.id === assetId ? { ...a, links: (a.links || []).filter((l) => !(l.to === toName && l.type === type)) } : a)),
    }))

  const rebuildLinks = () => {
    mutateBook((b) => ({ ...b, assets: buildLinks((b.assets || []).map((a) => ({ ...a, links: [] }))) }))
    setMsg('已按名字共现重建绑定边')
  }

  const saveGraphPos = (pos) => mutateBook((b) => ({ ...b, graphPos: { ...(b.graphPos || {}), ...pos } }))

  // 故一并走 mutateBook(基于 bookRef.current 乐观更新)，不再用闭包 book 的 persistBook，堵住"乐观更新被陈旧闭包覆盖"的唯一真实窗口。
  const handleAssetSubmit = async (asset, info) => {
    if (!asset) {
      if (info && info.reason) setMsg(info.reason)
      return
    }
    if (info && info.mode === 'merge' && info.mergedFrom) {
      await mutateBook((b) => ({ ...b, assets: (b.assets || []).map((a) => (a.id === info.mergedFrom ? asset : a)) }))
      setMsg(`已合并进《${asset.name}》`)
    } else {
      await mutateBook((b) => ({ ...b, assets: [...(b.assets || []), asset] }))
      setMsg(`已新增资产《${asset.name}》`)
    }
    // 不整表 buildLinks：避免覆盖用户手改的边(设计§4.2)；新资产的显式边由 normalizeAsset 从表单/controller/holder/state.place 生成
  }

  // LinkEditor「顺便建档」/结算未建档道具：建一条最小资产(只有名字+类型)，符合"人在环路+不阻断"
  const quickCreateAsset = async ({ name, type }) => {
    if (!name) return { ok: false, msg: '没有名字', error: '没有名字' }
    //   用 bookRef.current(最新)而非闭包 book，避免快速连点漏判；返回 { ok:false, reason:'duplicate' } 让 LinkEditor 按 r.ok===false 回滚乐观标记。
    const dup = findByName((bookRef.current && bookRef.current.assets) || [], name)
    if (dup) {
      setMsg(`「${name}」已在资产库，未重复建档`)
      return { ok: false, reason: 'duplicate', existing: dup, name, msg: `「${name}」已在资产库`, error: 'duplicate' }
    }
    try {
      const minimal = normalizeAsset({ name, type: type || 'person' }, { idPrefix: 'lf' })
      await mutateBook((b) => ({ ...b, assets: [...(b.assets || []), minimal] }))
      setMsg(`已顺便建档《${name}》（只有名字，其余字段可后补）`)
      return { ok: true, name, asset: minimal }
    } catch (e) {
      const msg = (e && (e.message || e.reason)) || '建档失败'
      setMsg(`「${name}」建档未成功：${msg}`)
      return { ok: false, name, msg, error: msg }
    }
  }

  return { books, setBooks, loading, loadError, bookId, setBookId, book, bookRef, persistBook, mutateBook, deleteAsset, updateAsset, delLink, rebuildLinks, saveGraphPos, handleAssetSubmit, quickCreateAsset }
}
