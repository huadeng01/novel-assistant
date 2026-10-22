import { useRef } from 'react'
import { parseAnalyze } from '../lib/parseAssets.js'
import { findAssetByName, normalizeState, STATE_V1_MAP, dashOut, normalizeAsset, typeKeyOf } from '../lib/assets.js'

// 长篇页「分析原文」落库域：分析回复的合并与采纳、勾选后写库。
// 待落库列表与勾选状态由草稿 hook 持有（经 draft 对象读写），因为它们的持久化与恢复归属草稿。
// 落库走调用方传入的 persistBook（基于闭包 book 的直接写路径），操作守卫 runAssetOp 防同一按钮双击重复写库。
export default function useLongformApply({ book, persistBook, chapterNo, setMsg, draft }) {
  const { pendingUpdates, setPendingUpdates, pendingNew, setPendingNew, selUp, setSelUp, selNew, setSelNew } = draft

  //   ③catch fn 的 rejection 并提示(原来 runAssetOp 返回的 promise 无人 catch→未处理 rejection)。
  //     同一时刻只有一个弹窗可点；守卫只为兜"同一按钮双击"(第二次落库前 modal 未关)，per-modal 锁已足够，无需全局串行。
  const updatesOpRef = useRef(false)
  const newOpRef = useRef(false)
  const runAssetOp = async (ref, fn) => {
    if (ref.current) {
      setMsg('正在落库，请稍候…（已在处理上一次点击，避免重复写入）')
      return
    }
    ref.current = true
    try {
      await fn()
    } catch (e) {
      setMsg('落库失败：' + ((e && (e.message || e.reason)) || String(e)))
    } finally {
      ref.current = false
    }
  }

  // 采纳时直接解析该 reply 落库预览——"审核的回复=落库的回复"，避免 onAdopt 丢弃 reply 又发一次
  // （双重 LLM 调用、双倍额度、且第二次结果可能与用户审核的那次不一致）。
  //      ②默认不全选——避免一次误点「落库选中」把全部 AI 输出写进资产库，改由弹窗里的「全选」按钮显式勾选；
  //      ③追加时按名字去重(同名新资产/同内容更新只留一条)，防同一章重复分析后落库出重复资产。
  //     避免 adoptSettle 里对同一 reply 二次 parseAnalyze(结算已解析过一遍)。返回统计供调用方组织各自文案。
  const mergeAnalyzeResult = (updates, newAssets) => {
    const ch = chapterNo
    const hadPending = pendingUpdates.length > 0 || pendingNew.length > 0
    const upSeen = new Set(pendingUpdates.map((u) => `${u.name}｜${u.info}｜${u.state}`))
    const mergedUp = [...pendingUpdates]
    let dupUp = 0
    updates.forEach((u) => {
      const k = `${u.name}｜${u.info}｜${u.state}`
      if (upSeen.has(k)) {
        dupUp += 1
        return
      }
      upSeen.add(k)
      mergedUp.push({ ...u, fromCh: ch })
    })
    const newSeen = new Set([...pendingNew.map((n) => n.name), ...(((book && book.assets) || []).map((a) => a.name))])
    const mergedNew = [...pendingNew]
    let dupNew = 0
    newAssets.forEach((n) => {
      if (!n.name || newSeen.has(n.name)) {
        dupNew += 1
        return
      }
      newSeen.add(n.name)
      mergedNew.push({ ...n, fromCh: ch })
    })
    setPendingUpdates(mergedUp)
    setPendingNew(mergedNew)
    return { dupUp, dupNew, hadPending, mergedUp, mergedNew }
  }

  const adoptAnalyze = (reply) => {
    const { updates, newAssets } = parseAnalyze(reply || '')
    const r = mergeAnalyzeResult(updates, newAssets)
    const dupNote = r.dupUp + r.dupNew > 0 ? `；重复 ${r.dupUp + r.dupNew} 条已跳过` : ''
    setMsg(
      `分析完成：本次新增待落库 更新 ${updates.length - r.dupUp} 条 / 新资产 ${newAssets.length - r.dupNew} 个${dupNote}${
        r.hadPending ? `；已与上次未落库结果合并（现共 更新 ${r.mergedUp.length} 条 / 新资产 ${r.mergedNew.length} 个）` : ''
      }，请勾选后落库`
    )
  }

  const applyUpdates = () => runAssetOp(updatesOpRef, async () => {
    if (!book) return
    const ups = pendingUpdates.filter((_, i) => selUp.includes(i))
    const base = (book.assets || [])
    //   按「解析出的资产 id」聚合(比 ContinuePage 的按名聚合更稳：两个不同名解析到同一资产时合并而非后者覆盖前者)。
    const byId = new Map() // assetId -> [updates]
    let unmatched = 0
    let noName = 0
    ups.forEach((u) => {
      if (!u || !u.name) {
        noName += 1
        return
      }
      const a = findAssetByName(base, u.name)
      if (!a) {
        unmatched += 1
        return
      }
      if (!byId.has(a.id)) byId.set(a.id, [])
      byId.get(a.id).push(u)
    })
    const assets = base.map((a) => {
      const us = byId.get(a.id)
      if (!us || !us.length) return a
      const st = normalizeState(a.state)
      const lastU = us[us.length - 1]
      const word = lastU.state
      const tag = STATE_V1_MAP[word] || STATE_V1_MAP[String(word || '').toLowerCase()]
      if (tag) st.plot = { ...(st.plot || {}), tag }
      if (word) st.legacy = st.legacy || word
      //   一律用当前章会把它章分析出的状态记成本章(尤其恢复后切到别章再落库)。对齐 applyNew 的 n.reveal||n.fromCh||chapterNo 范式。
      st.meta = { updatedAt: Date.now(), updatedBy: 'analyze', sourceCh: lastU.fromCh || chapterNo }
      let detail = String(a.detail || '')
      us.forEach((u) => {
        if (u.info && !detail.includes(u.info)) detail = detail ? `${detail}｜${u.info}` : String(u.info)
      })
      return { ...a, detail, state: st }
    })
    await persistBook({ ...book, assets })
    setPendingUpdates((p) => p.filter((_, i) => !selUp.includes(i)))
    setSelUp([])
    // 与 ContinuePage 同口径：报「实写资产数」，名字未建档/无名的按条数单独提示，不再拿「勾选数」冒充「实写数」
    const skipped = unmatched + noName
    setMsg(`已落库更新 ${byId.size} 个资产` + (skipped ? `（${skipped} 条因名字未建档/无名已跳过，可先到资产库建档或核对资产名）` : ''))
  })

  const applyNew = () => runAssetOp(newOpRef, async () => {
    if (!book) return
    const news = pendingNew.filter((_, i) => selNew.includes(i))
    // 只按库内已有名字过滤会让同名条目各生成一个 id 落库成重复资产 → 这里连库内与本次选中一起按名字去重
    // L：去重键过 dashOut 归一——原来用裸 a.name，带《》/首尾空格的同名(「青云山」vs「《青云山》」)会漏判成两条重复资产。
    //   L②注(如实)：dashOut 只去《》+首尾空白、**不折叠内部空格**(normName 才折叠)，故与 findByName/isAssetWorthSaving 的 normName 口径略有出入(内部多空格的名字仍可能判不等)，但足以兜住《》/首尾空格差异。不改 dashOut(它是 assets.js 共享判据)。
    const seen = new Set((book.assets || []).map((a) => dashOut(a.name)).filter(Boolean))
    const add = []
    let skipped = 0
    news.forEach((n) => {
      const nk = dashOut(n.name)
      if (!nk || seen.has(nk)) {
        skipped += 1
        return
      }
      seen.add(nk)
      //   is_public 是只写不读的死字段(assets.js 已标注待删)，不再写入；id 显式给则保留(na_ 前缀不变)。
      add.push(
        normalizeAsset(
          {
            id: `na_${Date.now().toString(36)}_${add.length}`,
            type: typeKeyOf(n.type), // 结算/分析回复里的类型是中文词(人物/地点/…)，归一成英文枚举，否则分类筛选与图谱着色对不上
            name: n.name,
            detail: n.desc,
            tier: 'B',
            state: 'alive',
            ch_reveal: n.reveal || n.fromCh || chapterNo,
          },
          { idPrefix: 'lf' }
        )
      )
    })
    await persistBook({ ...book, assets: [...(book.assets || []), ...add] })
    setPendingNew((p) => p.filter((_, i) => !selNew.includes(i)))
    setSelNew([])
    setMsg(`已落库 ${add.length} 个新资产${skipped ? `（重复/无名 ${skipped} 个已跳过）` : ''}`)
  })

  return { mergeAnalyzeResult, adoptAnalyze, applyUpdates, applyNew, runAssetOp }
}
