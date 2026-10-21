import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getById, put } from '../lib/db.js'
import { buildLinks, countByType, filterAssets, findAssetByName, isAssetWorthSaving, mergeAssetDraft, normalizeAsset, normalizeState, perVolOf } from '../lib/assets.js'

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
//   A.commit()                   // 一次 put('books', ...)
//   （边的增删改不在此暴露：由 LinkEditor 受控 onChange 改 draft.links，保存时 normalizeAsset 派生/去重）
//
// B28：删掉 persist 参数——唯一调用方 ContinuePage 从不传它（persistRef 恒 undefined），内置落库 put('books', {...latest, assets}) 是唯一路径；
//   原「传了则由调用方决定怎么写（长篇页同步 setBooks）」设想的消费方 LongFormPage 并不使用本 hook（它自带本地资产写路径），故 persist 及其死分支一并删除。
export function useAssets({ book, onPersisted, idPrefix = 'mn', autoCommitMs = 0, onMessage } = {}) {
  const bookRef = useRef(book)
  useEffect(() => {
    bookRef.current = book
  }, [book])

  // 读入口统一过一遍 normalizeAsset：旧书 state:'alive' 会被迁成 v2 结构，UI 不会白屏（设计 §4.1）
  const [list, setList] = useState(() => ((book && book.assets) || []).map((a) => normalizeAsset(a, { idPrefix })))
  const [dirty, setDirty] = useState(false)
  const [, setMsgState] = useState('') // B28：msg 值不再对外暴露（唯一调用方不读 ua.msg），只保留 setter 供内部 setMsg 用
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
    // M5：切书且有未提交变更 → 先把旧书编辑 flush 落库（用旧书对象 put），避免"切书静默覆盖丢未保存编辑"
    if (switched && dirtyRef.current && prevBook && prevBook.id) {
      // #6：先取消挂起的 debounce 定时 commit，避免它稍后落在已切走 / 已删的书上
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const staleList = listRef.current
      dirtyRef.current = false
      // #4：flush 前复查旧书是否还在（可能已被删）——不在则跳过 put，否则会用旧内存数据复活已删书；
      // #5：flush 成功后 onPersisted(=lib.refresh) 刷新内存 books，防切回旧书看到 stale 资产、再编辑覆盖掉刚 flush 的结果
      getById('books', prevBook.id)
        .then((latest) => (latest ? put('books', { ...latest, assets: staleList }).then(() => true) : false)) // M5：用 DB 最新记录做 base、只替换 assets 字段，避免用内存旧快照整条覆盖掉别处(如长篇页)刚更新的章节/正文
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
    // H5 + L-新2：用 DB 最新记录做 base、只替换 assets 字段（对齐同文件切书 flush 分支的口径）——原来用内存快照整本覆盖，
    //   与同页其他写交错时会盖掉别处刚更新的非 assets 字段。latest=null（书已删）则【跳过 put 返回 false】，
    //   不再回落内存快照 b（那会 put 出一条已删的书 = 复活孤儿）；与 flush 分支「书不在就跳过」同口径。
    // item9：区分「读库异常」与「书已删除」——原 `.catch(()=>null)` 把两者归一成 null，读库失败（IDB 被占用/事务中止）
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

  // L-新3：commit 串行队列——两次重叠 commit 若「后发先至」，会用旧的 listRef 快照覆盖 DB 里更新的资产。
  //   排队执行、且每次在【执行时】才读 listRef.current（不用调用时的快照），保证最后落库的是最新内存态（对齐 H3 禁用词队列模式）。
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
        // #6 + L-新2：书是否还在由 doPersist 内那次 getById 一并判定（latest=null→返回 false），不再单独多读一次；避免 TOCTOU
        const ok = await doPersist(next)
        if (timerRef.current) {
          clearTimeout(timerRef.current) // #6：commit 结束，取消挂起的 debounce 定时器（否则会再落一次）
          timerRef.current = null
        }
        if (ok === false) {
          // 书确实已被删除（getById 正常 resolve 到空）：变更无处落库。item9：dirty 不清（只在确认成功后清），据实提示。
          setMsg('这本书已被删除，本次资产变更未保存')
          return false
        }
        setDirty(false) // item9：移到确认成功之后——读库/写库失败时保留 dirty，用户再触发 commit 可重试，不再「失败也清 dirty 永不重试」
        setMsg('资产已保存')
        return true
      } catch (e) {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        // 写库失败必须明确提示，不能静默——否则「看起来成功、刷新回旧状态」（M28）
        // item9：读库异常（doPersist 已包成 readFail）报"读取失败请重试"，写库异常报"保存失败…（可能存储空间不足）"；两者都不清 dirty（保留以便重试）
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
      // #4：在唯一写出口 touch 集中盖 updatedAt——normalizeAsset 是只读语义(保留原 updatedAt)、各写路径又不逐个刷新，
      //   会导致 updatedAt 恒等于 createdAt。这里对"被改动的条目"(与旧表同 id 但引用不同=被改；旧表无此 id=新增)统一盖章，
      //   未改条目(引用相同)保留原值。不做按最近修改排序(决策#4)，仅供资产卡「最近编辑」显示。
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
      // C38：重名检查改用 findAssetByName（主名 + 别名，与结算 applyStateChange/流转的查名同口径）——原 findByName 只比主名，
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

  // P2/第11轮：addLink / rebuildLinks / delLink / updateLink 四个「边增删改重建」出口已全部删除——全仓零调用方
  //   （边的增删改由 LinkEditor 受控 onChange + 保存时 normalizeAsset 派生/去重承载；整表重建 LongFormPage 自带本地实现）。
  //   且 delLink/updateLink 按 links 下标定位、重排后会删错边（LongFormPage A6「按 toName+type 稳定标识而非下标」的教训）。
  //   注：buildLinks 仍被 addAsset 的共现建边用（见上），import 保留。

  // P1-8：原 patchState / recordFlow 两个「状态增量 + 资产流转」实现已删除——全仓零调用方（续写页 ContinuePage 与
  //   长篇页 LongFormPage 各自内联结算，共享纯函数 applyStateChange/typeKeyOf 住在 assets.js 单一出处）。
  //   留着只会与页面内联实现漂移：recordFlow 既有 phys 整体替换丢字段、又有 a.name===assetName 严格匹配（都不容错别名），
  //   正是续写页本轮刚修掉的两类 bug。删掉重复实现消除漂移源，比把页面内联反向改调它风险低（那会丢掉累加器批写/去重/顺便建档/holder 同步）。

  const filtered = useCallback((filter) => filterAssets(list, filter, perVol), [list, perVol])
  // B28：删掉 byName(=findByName 的对外暴露) 与 reset(放弃变更) 两个死出口——唯一调用方 ContinuePage 只用
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
