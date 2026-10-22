import { useRef } from 'react'
import { parseAnalyze, findForeshadowByTitle } from '../lib/parseAssets.js'
import { findAssetByName, normalizeState, stateLabel, applyStateChange, applyFlowToRoster } from '../lib/assets.js'

// 长篇页「结算本章状态」域：三段产出(状态变更/资产流转/伏笔推进)的采纳解析、勾选后一次性合并写库；
// 人在环路、系统零判断零拦截。待落库列表与勾选由草稿 hook 持有（经 draft 对象读写）。
// 结算提示词拼装留在页面（它依赖弹窗开关 settlePromptOpen 与编辑区正文，属 UI 层）。
export default function useLongformSettlement({ book, persistBook, chapterNo, setMsg, draft, mergeAnalyzeResult, runAssetOp }) {
  const { pendingState, setPendingState, pendingFlow, setPendingFlow, pendingHook, setPendingHook, selState, setSelState, selFlow, setSelFlow, selHook, setSelHook } = draft
  const settleOpRef = useRef(false)

  // 采纳结算回复：parseAnalyze 解析五段。stateChanges/flows/hookMoves 进结算预览；updates/newAssets 复用「分析原文」待落库列表。
  const adoptSettle = (reply) => {
    const { updates, newAssets, stateChanges, flows, hookMoves } = parseAnalyze(reply || '')
    const ch = chapterNo
    const mergeSeg = (prevArr, prevSel, incoming, keyOf) => {
      const seen = new Set(prevArr.map(keyOf))
      const merged = [...prevArr]
      const sel = [...prevSel]
      incoming.forEach((it) => {
        const k = keyOf(it)
        if (seen.has(k)) return
        seen.add(k)
        sel.push(merged.length) // 新增条目默认勾选
        merged.push({ ...it, fromCh: ch })
      })
      return { merged, sel }
    }
    const sc = mergeSeg(pendingState, selState, stateChanges, (s) => `${s.name}|${s.dimKey}|${s.state}|${s.since}`)
    const fl = mergeSeg(pendingFlow, selFlow, flows, (f) => `${f.person}|${f.change}|${f.asset}|${f.ch}`)
    const hk = mergeSeg(pendingHook, selHook, hookMoves, (h) => `${h.title}|${h.move}|${h.ch}`)
    setPendingState(sc.merged)
    setSelState(sc.sel)
    setPendingFlow(fl.merged)
    setSelFlow(fl.sel)
    setPendingHook(hk.merged)
    setSelHook(hk.sel)
    if (updates.length || newAssets.length) mergeAnalyzeResult(updates, newAssets)
    setMsg(
      `结算解析完成：本次 状态变更 ${stateChanges.length} / 资产流转 ${flows.length} / 伏笔推进 ${hookMoves.length}` +
        (updates.length || newAssets.length ? `；另有 更新 ${updates.length} / 新资产 ${newAssets.length} 已并入上方待落库` : '') +
        '，请勾选后落库'
    )
  }

  // 落库选中：一次性合并三段产出后 persistBook（不逐条写盘）。
  const applySettlement = () => runAssetOp(settleOpRef, async () => {
    if (!book) return
    let assets = (book.assets || []).map((a) => ({ ...a }))
    const foreshadows = (book.foreshadows || []).map((f) => ({ ...f }))
    // ① 状态变更：增量并入 state（保留 id 与无关维度，inkos 原则②）。
    const selSc = pendingState.filter((_, i) => selState.includes(i))
    let doneSc = 0
    selSc.forEach((sc) => {
      if (!sc.dimKey) return
      const target = findAssetByName(assets, sc.name)
      if (!target) return
      const i = assets.findIndex((a) => a.id === target.id)
      //   AI 未给生效章(sc.since 空)时用「采纳结算时所在章」fromCh 兜底(mergeSeg 采纳结算时已打)，不再恒 0；也不用当前章 chapterNo(跨刷新/切章后会记错章)。与 ContinuePage 同处对齐。
      assets[i] = { ...assets[i], state: applyStateChange(assets[i].state, sc, sc.fromCh || 0) }
      doneSc += 1
    })
    //   共享函数是纯变换、返回新名册，故逐条 reduce 累积(assets 重新赋值)；写库仍走本页 persistBook(共享函数不含 put)。
    const selFl = pendingFlow.filter((_, i) => selFlow.includes(i))
    let newItem = 0
    let newPerson = 0
    let doneFl = 0
    selFl.forEach((fl) => {
      if (!fl.asset) return // 与 ContinuePage 一致：无资产名的流转整条跳过、不计入 doneFl(计入下方 skips)
      const res = applyFlowToRoster(assets, { ...fl, ch: fl.ch || fl.fromCh || chapterNo }, { idPrefix: 'lf' })
      assets = res.assets
      res.created.forEach((c) => {
        if (c.type === 'person') newPerson += 1
        else newItem += 1
      })
      //   会在"资产未建档且动作非获得"(res.skipped 非空、但人物侧可能命中)时仍计数，与续写页漂移。skipped 的条数由下方 selFl.length-doneFl 兜住。
      if (!res.skipped) doneFl += 1
    })
    const selHk = pendingHook.filter((_, i) => selHook.includes(i))
    let doneHk = 0
    selHk.forEach((hm) => {
      const f = findForeshadowByTitle(foreshadows, hm.title)
      if (!f || !hm.move || hm.move === 'mention') return
      f.state = hm.move
      if (hm.move === 'advanced' || hm.move === 'resolved') f.lastAdvancedChapter = hm.ch || hm.fromCh || chapterNo
      if (hm.move === 'resolved' && hm.note) f.payoff_hint = hm.note
      doneHk += 1
    })
    await persistBook({ ...book, assets, foreshadows })
    setPendingState((p) => p.filter((_, i) => !selState.includes(i)))
    setPendingFlow((p) => p.filter((_, i) => !selFlow.includes(i)))
    setPendingHook((p) => p.filter((_, i) => !selHook.includes(i)))
    setSelState([])
    setSelFlow([])
    setSelHook([])
    const skips = [
      selSc.length - doneSc > 0 ? `状态变更 ${selSc.length - doneSc} 条跳过(名册无此资产或维度未识别)` : '',
      selFl.length - doneFl > 0 ? `流转 ${selFl.length - doneFl} 条跳过(无资产名 / 资产未建档且动作非获得)` : '',
      selHk.length - doneHk > 0 ? `伏笔 ${selHk.length - doneHk} 条跳过(未入库或仅提及)` : '',
    ].filter(Boolean)
    const createdNote =
      newItem || newPerson ? `（新入表 ${[newItem ? `${newItem} 个道具` : '', newPerson ? `${newPerson} 个人物` : ''].filter(Boolean).join('、')}）` : ''
    setMsg(
      `已结算落库：状态变更 ${doneSc} / 资产流转 ${doneFl}${createdNote} / 伏笔 ${doneHk}` + (skips.length ? `；${skips.join('、')}` : '')
    )
  })

  // 结算预览的只读辅助：旧值(该维度当前状态中文)、资产是否已建档、伏笔当前 state
  const oldStateWord = (sc) => {
    const a = findAssetByName((book && book.assets) || [], sc.name)
    if (!a) return '(新资产)'
    const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
    const dim = sc.dimKey
    // inferred place 不加「在」、直接返回原词(与 C 区 ContinuePage 的 oldStateWord、B 区 placePhrase 同口径)——预览与落库/注入一致，不对推定短语(前往昆仑)断言位置
    if (dim === 'place') return st.place && st.place.ref ? (st.place.inferred ? st.place.ref : `在${st.place.ref}`) : '(未记录)'
    if (dim === 'hold') return `持有 ${(st.hold || []).filter((h) => h.change === 'gain' || !h.change).map((h) => h.name).filter(Boolean).join('、') || '(无)'}`
    const o = st[dim]
    if (!o) return '(未记录)'
    return o.note || (o.tag ? stateLabel(dim, o.tag) : '(未记录)')
  }
  const assetExists = (name) => !!findAssetByName((book && book.assets) || [], name)
  //   预览显示"未入库→resolved"但落库其实模糊命中并真改了 state → 人在环路看到的与真实写入不一致。
  const foreshadowStateOf = (title) => (findForeshadowByTitle((book && book.foreshadows) || [], title) || {}).state || '未入库'

  return { adoptSettle, applySettlement, oldStateWord, assetExists, foreshadowStateOf }
}
