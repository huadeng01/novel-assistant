import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { put } from '../lib/db.js'
import { buildLinks, countByType, filterAssets, findByName, isAssetWorthSaving, mergeAssetDraft, normalizeAsset, normalizeState, perVolOf } from '../lib/assets.js'

// 资产 CRUD + links + **提交式**落库（设计 §6.3 / §1.6 M29）。
//
// 为什么不是「改一下就写一次库」：现在 AssetModal 卡内透出章输入框是 onChange 即写，每敲一位数字就整本 book put 一次
// IndexedDB（M29 按键级写风暴），且并发写会互相覆盖丢更新。这里所有变更只改内存里的 list，
// 必须显式 commit()（或用 scheduleCommit(ms) 合并连续操作）才落库一次；组件卸载时自动 flush 未提交的变更。
//
// 用法（阶段1 接线时；阶段0 无引用方也能独立自测）：
//   const A = useAssets({ book, onPersisted: () => lib.refresh() })
//   A.addAsset(draft)            // → { ok, asset?, reason?, existing? }
//   A.updateAsset(id, { ch_reveal: 41 })
//   A.addLink(id, 'located_in', '青冥山', 45)
//   A.commit()                   // 一次 put('books', ...)
//
// 不传 persist 时用内置落库：put('books', { ...book, assets })；传了则完全由调用方决定怎么写（长篇页要同步 setBooks）。
export function useAssets({ book, persist, onPersisted, idPrefix = 'mn', autoCommitMs = 0, onMessage } = {}) {
  const bookRef = useRef(book)
  useEffect(() => {
    bookRef.current = book
  }, [book])

  // 读入口统一过一遍 normalizeAsset：旧书 state:'alive' 会被迁成 v2 结构，UI 不会白屏（设计 §4.1）
  const [list, setList] = useState(() => ((book && book.assets) || []).map((a) => normalizeAsset(a, { idPrefix })))
  const [dirty, setDirty] = useState(false)
  const [msg, setMsgState] = useState('')
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
  const prevBookRef = useRef(book) // M5：切书时用于 flush 旧书未提交的资产编辑
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
    // M5：切书且有未提交变更 → 先把旧书编辑 flush 落库（直接用旧书对象 put，不走 persist——persist 绑定的是新书 bookRef），
    //   避免"切书静默覆盖丢未保存编辑"。flush 失败只提示、不阻断切书。
    if (switched && dirtyRef.current && prevBook && prevBook.id) {
      put('books', { ...prevBook, assets: listRef.current }).catch(() => setMsg('切书前保存上一本书的资产变更失败，可能丢失'))
      dirtyRef.current = false
    }
    prevBookRef.current = book
    srcRef.current = src
    setList((src || []).map((a) => normalizeAsset(a, { idPrefix })))
    if (switched) setDirty(false)
  }, [book, idPrefix, setMsg])

  const persistRef = useRef(persist)
  useEffect(() => {
    persistRef.current = persist
  }, [persist])
  const onPersistedRef = useRef(onPersisted)
  useEffect(() => {
    onPersistedRef.current = onPersisted
  }, [onPersisted])

  const doPersist = useCallback(async (next) => {
    if (persistRef.current) return persistRef.current(next)
    const b = bookRef.current
    if (!b) throw new Error('未选定书籍，无法保存资产')
    const nb = { ...b, assets: next }
    await put('books', nb)
    if (onPersistedRef.current) await onPersistedRef.current(nb)
  }, [])

  const commit = useCallback(async () => {
    const next = listRef.current
    if (!bookRef.current && !persistRef.current) {
      setMsg('未选定书籍，变更只留在本页（未落库）')
      return false
    }
    try {
      await doPersist(next)
      setDirty(false)
      setMsg('资产已保存')
      return true
    } catch (e) {
      // 写库失败必须明确提示，不能静默——否则「看起来成功、刷新回旧状态」（M28）
      setMsg('保存失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）')
      return false
    }
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
      setList(next)
      listRef.current = next
      setDirty(true)
      dirtyRef.current = true
      if (autoMsg != null) setMsg(autoMsg)
      if (autoCommitMs > 0) scheduleCommit(autoCommitMs)
    },
    [autoCommitMs, scheduleCommit, setMsg],
  )

  const perVol = useMemo(() => perVolOf(book), [book])
  const counts = useMemo(() => countByType(list, perVol), [list, perVol])

  // —— CRUD ——

  // 新增：全空不入库、重名不静默丢弃（设计 §3 需求7）。返回结果让调用方决定要不要弹「合并/仍新增」。
  const addAsset = useCallback(
    (draft, opts = {}) => {
      if (!isAssetWorthSaving(draft)) {
        return { ok: false, reason: 'empty', msg: '没填任何内容，已放弃新增' }
      }
      const asset = normalizeAsset(draft, { idPrefix: opts.idPrefix || idPrefix })
      const hit = findByName(listRef.current, asset.name)
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

  // —— links ——

  const addLink = useCallback(
    (assetId, type, toName, sinceCh = 0, opts = {}) => {
      const to = String(toName == null ? '' : toName).trim()
      if (!type || !to) return { ok: false, reason: 'invalid' }
      let added = false
      const next = listRef.current.map((a) => {
        if (a.id !== assetId) return a
        const links = [...(a.links || [])]
        // 去重：与 LongFormPage.addLink / mergeRelations 同判据（to+type 相同即跳过），连点两次不产生重复边(M48)
        if (links.some((l) => l.to === to && l.type === type)) return a
        added = true
        const since = Number(sinceCh) || 0
        links.push(since > 0 ? { type, to, since_ch: since } : { type, to })
        return { ...a, links }
      })
      if (!added) return { ok: false, reason: 'duplicate' }
      touch(next, opts.msg)
      return { ok: true }
    },
    [touch],
  )

  const delLink = useCallback(
    (assetId, linkIdx, opts = {}) => {
      touch(
        listRef.current.map((a) => (a.id === assetId ? { ...a, links: (a.links || []).filter((_, i) => i !== linkIdx) } : a)),
        opts.msg,
      )
    },
    [touch],
  )

  const updateLink = useCallback(
    (assetId, linkIdx, patch, opts = {}) => {
      touch(
        listRef.current.map((a) => (a.id === assetId ? { ...a, links: (a.links || []).map((l, i) => (i === linkIdx ? { ...l, ...patch } : l)) } : a)),
        opts.msg,
      )
    },
    [touch],
  )

  // 整表按名字共现重建（会清空现有边，与 LongFormPage.rebuildLinks 同语义 —— 只应在用户明确点「重建」时调）
  const rebuildLinks = useCallback(() => {
    touch(
      buildLinks(listRef.current.map((a) => ({ ...a, links: [] }))),
      '已按名字共现重建绑定边（原有手改的边已被清掉）',
    )
  }, [touch])

  // —— state（增量更新，不重建：inkos 原则②）——

  // patchState(id, { phys:{...}, place:{...} })：只覆盖给出来的维度，其余维度与历史 hold/rel 原样保留
  const patchState = useCallback(
    (assetId, dims, meta = {}) => {
      const next = listRef.current.map((a) => {
        if (a.id !== assetId) return a
        const st = normalizeState(a.state)
        const incoming = dims && typeof dims === 'object' ? dims : {}
        ;['phys', 'power', 'mind', 'social', 'place', 'plot'].forEach((d) => {
          if (d in incoming) st[d] = incoming[d] || null
        })
        if (Array.isArray(incoming.hold)) {
          const hold = [...(Array.isArray(st.hold) ? st.hold : [])]
          incoming.hold.forEach((h) => {
            if (h && !hold.some((x) => x.name === h.name && x.change === h.change && x.ch === h.ch)) hold.push(h)
          })
          st.hold = hold
        }
        if (Array.isArray(incoming.rel)) {
          const rel = [...(Array.isArray(st.rel) ? st.rel : [])]
          incoming.rel.forEach((r) => {
            if (r && !rel.some((x) => x.to === r.to && x.tag === r.tag && x.ch === r.ch)) rel.push(r)
          })
          st.rel = rel
        }
        st.meta = {
          updatedAt: Date.now(),
          updatedBy: meta.updatedBy || 'user',
          sourceCh: Number(meta.sourceCh) || (st.meta && st.meta.sourceCh) || 0,
        }
        // state.place 变化后同步「位于」边（改 state 自动 upsert；删边不动 state —— 设计 §3 需求6 方案2）
        return normalizeAsset({ ...a, state: st }, { idPrefix })
      })
      touch(next, meta.msg)
      return next.find((a) => a.id === assetId) || null
    },
    [idPrefix, touch],
  )

  // 资产流转（设计 §4.5）：人物侧记一条 hold，资产侧同步（损毁只标注不删除）
  const recordFlow = useCallback(
    (personId, { name, change = 'gain', ch = 0, note = '' }, opts = {}) => {
      const assetName = String(name == null ? '' : name).trim()
      if (!personId || !assetName) return { ok: false, reason: 'invalid' }
      const next = listRef.current.map((a) => {
        if (a.id === personId) {
          const st = normalizeState(a.state)
          const hold = [...(Array.isArray(st.hold) ? st.hold : [])]
          const rec = { name: assetName, change, ch: Number(ch) || 0 }
          if (note) rec.note = String(note)
          if (!hold.some((x) => x.name === rec.name && x.change === rec.change && x.ch === rec.ch)) hold.push(rec)
          st.hold = hold
          st.meta = { updatedAt: Date.now(), updatedBy: opts.updatedBy || 'user', sourceCh: Number(ch) || (st.meta && st.meta.sourceCh) || 0 }
          return normalizeAsset({ ...a, state: st }, { idPrefix })
        }
        // 资产侧：易主改 holder/held_by；损毁/消耗只标注（拍板5：不物理删除，保留「曾经有过」的审计线）
        if (a.name === assetName) {
          if (change === 'transferred' || change === 'gain') {
            const holder = opts.holder || ((listRef.current.find((x) => x.id === personId) || {}).name || '')
            return normalizeAsset({ ...a, holder }, { idPrefix })
          }
          if (change === 'broken' || change === 'consumed' || change === 'lose') {
            const st = normalizeState(a.state)
            // 一律用生理维度的 broken 标注 + 中文说明（depleted 属修为维度词表，套到道具上会显示成「灵力耗尽」）
            const noteText = note ? String(note) : change === 'consumed' ? '已耗尽' : change === 'lose' ? '已丢失' : '已损毁'
            st.phys = { tag: 'broken', note: noteText, since: Number(ch) || 0 }
            st.meta = { updatedAt: Date.now(), updatedBy: opts.updatedBy || 'user', sourceCh: Number(ch) || 0 }
            return normalizeAsset({ ...a, state: st }, { idPrefix })
          }
        }
        return a
      })
      touch(next, opts.msg)
      return { ok: true }
    },
    [idPrefix, touch],
  )

  // —— 视图辅助 ——
  const filtered = useCallback((filter) => filterAssets(list, filter, perVol), [list, perVol])
  const byName = useCallback((name) => findByName(listRef.current, name), [list])
  const reset = useCallback(() => {
    setList(((bookRef.current && bookRef.current.assets) || []).map((a) => normalizeAsset(a, { idPrefix })))
    setDirty(false)
    setMsg('已放弃未保存的变更')
  }, [idPrefix, setMsg])

  return {
    assets: list,
    perVol,
    counts,
    dirty,
    msg,
    setMsg,
    addAsset,
    updateAsset,
    deleteAsset,
    mergeAsset,
    addLink,
    delLink,
    updateLink,
    rebuildLinks,
    patchState,
    recordFlow,
    filtered,
    findByName: byName,
    commit,
    scheduleCommit,
    reset,
  }
}

export default useAssets
