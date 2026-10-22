import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getById, put } from '../lib/db.js'
import { buildLinks, countByType, filterAssets, findAssetByName, isAssetWorthSaving, mergeAssetDraft, normalizeAsset, normalizeState, perVolOf } from '../lib/assets.js'

//
// 为什么不是「改一下就写一次库」：现在 AssetModal 卡内透出章输入框是 onChange 即写，每敲一位数字就整本 book put 一次
// 必须显式 commit()（或用 scheduleCommit(ms) 合并连续操作）才落库一次；组件卸载时自动 flush 未提交的变更。
//
// 用法（阶段1 接线时；阶段0 无引用方也能独立自测）：
//   const A = useAssets({ book, onPersisted: () => lib.refresh() })
//   A.addAsset(draft)            // → { ok, asset?, reason?, existing? }
//   A.updateAsset(id, { ch_reveal: 41 })
//   A.commit()                   // 一次 put('books', ...)
//   （边的增删改不在此暴露：由 LinkEditor 受控 onChange 改 draft.links，保存时 normalizeAsset 派生/去重）
//
export function useAssets({ book, onPersisted, idPrefix = 'mn', autoCommitMs = 0, onMessage } = {}) {
  const bookRef = useRef(book)
  useEffect(() => {
    bookRef.current = book
  }, [book])

  // 读入口统一过一遍 normalizeAsset：旧书 state:'alive' 会被迁成 v2 结构，UI 不会白屏（设计 §4.1）
  const [list, setList] = useState(() => ((book && book.assets) || []).map((a) => normalizeAsset(a, { idPrefix })))
  const [dirty, setDirty] = useState(false)
  const [, setMsgState] = useState('')
  const listRef = useRef(list)
  const dirtyRef = useRef(false)
  useEffect(() => {
    listRef.current = list
  }, [list])
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const setMsg = useCallback(
    (m) => {
      setMsgState(m || '')
      if (onMessage) onMessage(m || '')
    },
    [onMessage],
  )

  // 外部 book 变化时同步（切书/别的链路改了资产）；有未提交变更时不覆盖，避免把用户刚改的吞掉。
  // 另按 book.assets 的**引用**判等：调用方常在渲染里现造 book 对象（如续写页 `{...selectedBook, assets}`），
  // 若不判等，每次渲染都会 setList 一份新数组 → 渲染 → effect 再跑，形成无限重渲染。
  const bookIdRef = useRef(book && book.id)
  const srcRef = useRef((book && book.assets) || null)
  const prevBookRef = useRef(book)
  useEffect(() => {
    const id = book && book.id
    const src = (book && book.assets) || null
    const switched = id !== bookIdRef.current
    const prevBook = prevBookRef.current
    bookIdRef.current = id
    if (!switched && src === srcRef.current) {
      prevBookRef.current = book
      return
    }
    if (dirtyRef.current && !switched) {
      prevBookRef.current = book
      return // 有未提交变更：保留本地编辑，等 commit 后由外部回流
    }
    if (switched && dirtyRef.current && prevBook && prevBook.id) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const staleList = listRef.current
      dirtyRef.current = false
      getById('books', prevBook.id)
        .then((latest) => (latest ? put('books', { ...latest, assets: staleList }).then(() => true) : false))
        .then((saved) => {
          if (saved && onPersistedRef.current) onPersistedRef.current()
        })
        .catch(() => setMsg('切书前保存上一本书的资产变更失败，可能丢失'))
    }
    prevBookRef.current = book
    srcRef.current = src
    setList((src || []).map((a) => normalizeAsset(a, { idPrefix })))
    if (switched) setDirty(false)
  }, [book, idPrefix, setMsg])

  const onPersistedRef = useRef(onPersisted)
  useEffect(() => {
    onPersistedRef.current = onPersisted
  }, [onPersisted])

  const doPersist = useCallback(async (next) => {
    const b = bookRef.current
    if (!b) throw new Error('未选定书籍，无法保存资产')
    //   与同页其他写交错时会盖掉别处刚更新的非 assets 字段。latest=null（书已删）则【跳过 put 返回 false】，
    //   不再回落内存快照 b（那会 put 出一条已删的书 = 复活孤儿）；与 flush 分支「书不在就跳过」同口径。
    //   会被下游误报成"这本书已被删除"。读库异常抛出（带 readFail 标记）让 commit 据实报"读取失败请重试"并保留 dirty 以便重试；
    //   只有 getById 正常 resolve 到空（书确实不在了）才 return false。
    let latest
    try {
      latest = await getById('books', b.id)
    } catch (e) {
      const err = new Error('读取书籍数据失败，请重试（' + (e && e.message ? e.message : String(e)) + '）')
      err.readFail = true
      throw err
    }
    if (!latest) return false
    const nb = { ...latest, assets: next }
    await put('books', nb)
    if (onPersistedRef.current) await onPersistedRef.current(nb)
    return true
  }, [])

  const commitQueueRef = useRef(Promise.resolve())
  const commit = useCallback(() => {
    const task = async () => {
      const next = listRef.current // 执行时读最新，不用调用时快照
      const b = bookRef.current
      if (!b) {
        setMsg('未选定书籍，变更只留在本页（未落库）')
        return false
      }
      try {
        const ok = await doPersist(next)
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        if (ok === false) {
          setMsg('这本书已被删除，本次资产变更未保存')
          return false
        }
        setDirty(false)
        setMsg('资产已保存')
        return true
      } catch (e) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setMsg(e && e.readFail ? e.message : '保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）')
        return false
      }
    }
    const p = commitQueueRef.current.then(task, task) // 前一次无论成败都接着跑，不堵死队列
    commitQueueRef.current = p.catch(() => {})
    return p // 返回真实 promise，await commit() 的调用方照常拿到 true/false
  }, [doPersist, setMsg])

  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // 合并连续操作：ms 内多次变更只落库一次
  const timerRef = useRef(null)
  const scheduleCommit = useCallback(
    (ms) => {
      const wait = ms == null ? autoCommitMs || 600 : ms
      if (!wait || wait <= 0) return commitRef.current()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        commitRef.current()
      }, wait)
      return Promise.resolve(false)
    },
    [autoCommitMs],
  )

  // 卸载时 flush：有未提交变更就补一次落库（fire-and-forget，cleanup 里不能 await）
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (dirtyRef.current) commitRef.current()
    },
    [],
  )

  // autoCommitMs > 0 时，变更自动排队落库（仍合并成一次写，不做按键级写）
  const touch = useCallback(
    (next, autoMsg) => {
      //   会导致 updatedAt 恒等于 createdAt。这里对"被改动的条目"(与旧表同 id 但引用不同=被改；旧表无此 id=新增)统一盖章，
      const prevById = new Map((listRef.current || []).map((a) => [a && a.id, a]))
      const now = Date.now()
      const stamped = (next || []).map((a) => (a && prevById.get(a.id) !== a ? { ...a, updatedAt: now } : a))
      setList(stamped)
      listRef.current = stamped
      setDirty(true)
      dirtyRef.current = true
      if (autoMsg != null) setMsg(autoMsg)
      if (autoCommitMs > 0) scheduleCommit(autoCommitMs)
    },
    [autoCommitMs, scheduleCommit, setMsg],
  )

  const perVol = useMemo(() => perVolOf(book), [book])
  const counts = useMemo(() => countByType(list, perVol), [list, perVol])

  // 新增：全空不入库、重名不静默丢弃（设计 §3 需求7）。返回结果让调用方决定要不要弹「合并/仍新增」。
  const addAsset = useCallback(
    (draft, opts = {}) => {
      if (!isAssetWorthSaving(draft)) {
        return { ok: false, reason: 'empty', msg: '没填任何内容，已放弃新增' }
      }
      const asset = normalizeAsset(draft, { idPrefix: opts.idPrefix || idPrefix })
      //   新名撞上别人的**别名**时查不到 → 照样入库，之后结算按 findAssetByName 命中靠前那条（别名所属）= 写错条。改后别名冲突也拦成 duplicate。
      const hit = findAssetByName(listRef.current, asset.name)
      if (hit && !opts.force) return { ok: false, reason: 'duplicate', existing: hit, asset }
      // 共现建边只跑「新条目」：buildLinks 返回新数组、不改入参，这里只取最后一条的结果，
      // 其余条目原样保留 —— 避免整表重建覆盖用户手改过的边（设计 §4.2）
      const linked = buildLinks([...listRef.current, asset]).pop() || asset
      touch([...listRef.current, linked], `已新增《${linked.name || '未命名'}》`)
      return { ok: true, asset: linked }
    },
    [idPrefix, touch],
  )

  const updateAsset = useCallback(
    (id, patch, opts = {}) => {
      const next = listRef.current.map((a) => (a.id === id ? normalizeAsset({ ...a, ...patch }, { idPrefix }) : a))
      touch(next, opts.msg)
      return next.find((a) => a.id === id) || null
    },
    [idPrefix, touch],
  )

  const deleteAsset = useCallback(
    (id, opts = {}) => {
      const target = listRef.current.find((a) => a.id === id)
      touch(
        listRef.current.filter((a) => a.id !== id),
        opts.msg != null ? opts.msg : target ? `已删除《${target.name}》` : undefined,
      )
    },
    [touch],
  )

  // 重名合并：保留已有 id（否则指向它的 links 全断），detail 追加、links/state 增量合并
  const mergeAsset = useCallback(
    (existingId, draft, opts = {}) => {
      const existing = listRef.current.find((a) => a.id === existingId)
      if (!existing) return { ok: false, reason: 'not-found' }
      const merged = mergeAssetDraft(existing, draft, { idPrefix })
      touch(
        listRef.current.map((a) => (a.id === existingId ? merged : a)),
        opts.msg != null ? opts.msg : `已合并进《${merged.name}》`,
      )
      return { ok: true, asset: merged }
    },
    [idPrefix, touch],
  )

  //   （边的增删改由 LinkEditor 受控 onChange + 保存时 normalizeAsset 派生/去重承载；整表重建 LongFormPage 自带本地实现）。
  //   注：buildLinks 仍被 addAsset 的共现建边用（见上），import 保留。

  //   长篇页 LongFormPage 各自内联结算，共享纯函数 applyStateChange/typeKeyOf 住在 assets.js 单一出处）。
  //   留着只会与页面内联实现漂移：recordFlow 既有 phys 整体替换丢字段、又有 a.name===assetName 严格匹配（都不容错别名），
  //   正是续写页本轮刚修掉的两类 bug。删掉重复实现消除漂移源，比把页面内联反向改调它风险低（那会丢掉累加器批写/去重/顺便建档/holder 同步）。

  const filtered = useCallback((filter) => filterAssets(list, filter, perVol), [list, perVol])
  //   assets/counts/filtered/addAsset/updateAsset/deleteAsset/mergeAsset；byName/reset 全仓零消费（reset 的「放弃变更」UI 从未接线）。
  //   return 里的 perVol/dirty/msg/setMsg/commit/scheduleCommit 仍在本 hook 内部使用，只是不再对外暴露（一并从公开 API 收敛）。

  return {
    assets: list,
    counts,
    addAsset,
    updateAsset,
    deleteAsset,
    mergeAsset,
    filtered,
  }
}

export default useAssets
