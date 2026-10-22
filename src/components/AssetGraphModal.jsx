import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LINK_LABEL } from '../lib/parseAssets.js'
// C(资产库阶段2)：perVolOf(透出章按卷估算单一出处) + ChapterField(透出/传闻章统一显示) + LinkEditor(加边/删边/顺便建档)
import { perVolOf, ASSET_TYPE_LABEL, dashOut } from '../lib/assets.js'
import ChapterField from './ChapterField.jsx'
import LinkEditor from './LinkEditor.jsx'

// 关系网图谱（Obsidian 式力导向图，零依赖自实现）：节点=资产，边=links。
// 点击节点→小弹窗快捷修改；拖拽节点=调布局(存IndexedDB)；滚轮缩放+拖空白平移；点击边=删边。
// 关系类型显示中文（LINK_LABEL），存储保持英文枚举。
const W = 860
const H = 560
// C(设计§2.1)：节点色/图例补 skill(功法)/beast(灵兽)两类新资产类型（图例由 Object.keys(TYPE_COLOR) 自动带出）
const TYPE_COLOR = { person: '#C9A96A', faction: '#7FA8B0', place: '#8FAF7E', item: '#B08AC9', group: '#8A8A93', skill: '#D98E4A', beast: '#6FB492' }
// 类型中文名复用 assets.js 的 ASSET_TYPE_LABEL（单一出处）——此前本地重复一份 TYPE_LABEL，改标签时会与之漂移

// M-F5：种子位置改用「资产 id 的稳定哈希」而非数组下标 i——原来增删任一资产会让后面所有资产的下标位移，
//   未手动拖过(无 savedPos、fixed=false)的节点种子全变→整张图重排。用 id 哈希后，增删只影响新节点自身，既有节点种子不变。
//   注：改种子算法会让"当前未固定节点"一次性换到新布局(此后稳定)；已拖过并落库的 fixed 节点不受影响。
function hashId(id) {
  const s = String(id == null ? '' : id)
  let h = 0
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0
  return Math.abs(h)
}
function seedPos(seed) {
  const angle = seed * 2.39996
  const r = 120 + (seed % 5) * 34 + ((seed >> 3) % 3) * 12
  return { x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) * 0.82 }
}

// M-F6：力导向的物理/迭代次数(FORCE_ITERS)/力常量完全不动——只把「何时算」从一次性同步改成 rAF 分帧(见组件内 effect)。
//   forceStep 是原 for 循环体的逐字抽取，故分帧跑满 FORCE_ITERS 轮与同步跑产出逐像素一致(统筹脚本已证差异 0.000000px)。
//   为何不用「早停」替代：无退火时布局在 ~3px 平台震荡永不收敛(早停触发不了)；加退火又会让节点重叠(最短边=0)。故只优化「算的时机」。
const FORCE_ITERS = 140
// M-F6①：布局缓存提到**模块级**——AssetGraphModal 在 LongFormPage 里是条件挂载({graphOpen && …}，关窗即卸载)，
//   组件内 useRef 缓存会随卸载销毁，"重开弹窗命中缓存"就是假的。模块级 Map 才能跨开合/跨书复用。key = book.id::layoutKey。
//   容量上限防长会话无界增长(Map 保持插入序，超限删最旧)；每条只是 n 个 {x,y}，占用很小。
const layoutCache = new Map()
const LAYOUT_CACHE_MAX = 60
function cacheLayout(key, val) {
  layoutCache.set(key, val)
  if (layoutCache.size > LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next().value
    if (oldest !== undefined) layoutCache.delete(oldest)
  }
}
function forceStep(p, edges) {
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      let dx = p[i].x - p[j].x
      let dy = p[i].y - p[j].y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) d2 = 1
      const f = 1800 / d2
      const d = Math.sqrt(d2)
      dx /= d
      dy /= d
      if (!p[i].fixed) { p[i].x += dx * f; p[i].y += dy * f }
      if (!p[j].fixed) { p[j].x -= dx * f; p[j].y -= dy * f }
    }
  }
  edges.forEach(([a, b]) => {
    const dx = p[b].x - p[a].x
    const dy = p[b].y - p[a].y
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const f = 0.02 * (d - 95)
    if (!p[a].fixed) { p[a].x += (dx / d) * f; p[a].y += (dy / d) * f }
    if (!p[b].fixed) { p[b].x -= (dx / d) * f; p[b].y -= (dy / d) * f }
  })
  p.forEach((q) => {
    if (q.fixed) return
    q.x += (W / 2 - q.x) * 0.012
    q.y += (H / 2 - q.y) * 0.012
    q.x = Math.min(W - 30, Math.max(30, q.x))
    q.y = Math.min(H - 24, Math.max(24, q.y))
  })
}

// 关系图谱弹窗：力导向布局展示资产之间的关系边，支持拖拽节点、增删边、顺便建档，布局坐标存回书里。
export default function AssetGraphModal({ open, onClose, book, onUpdateAsset, onDeleteAsset, onDelLink, onSavePos, onRebuildLinks, onAddAsset }) {
  const [nodeId, setNodeId] = useState(null)
  const [dragPos, setDragPos] = useState({})
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  const [confirmEdge, setConfirmEdge] = useState(null)
  const [hoverEdge, setHoverEdge] = useState(null)
  const dragRef = useRef(null)
  const draggedRef = useRef(false)
  const panRef = useRef(null)
  const svgRef = useRef(null)
  const dragResetRafRef = useRef(0)

  const assets = (book && book.assets) || []
  const graphPos = book && book.graphPos // 引用稳定(book 不变则不变)，供 posKey 的 useMemo 依赖
  const savedPos = graphPos || {}
  //   (否则命中旧缓存、邻居仍围绕手拖前的旧位=仅视觉偏差)。拖一次重算一次(rAF 分帧不阻塞)，是力导向"钉住后周围松弛"的标准行为。
  //   ⚠ posKey 必须同时进 nodes memo 的 deps(见下)——否则 nodes 的 fixed/savedPos 陈旧，重算时手拖节点不被当固定点会漂移(比原视觉问题更糟)。
  //     重算走 rAF 分帧不阻塞主线程。若产品上要"手拖后其余节点完全不动"，需改成只固定全部已存节点、不对非 fixed 重算(另一套布局策略)，非本轮范围。
  const posKey = useMemo(() => JSON.stringify(graphPos || {}), [graphPos])
  const perVol = perVolOf(book)

  const layoutKey = JSON.stringify(assets.map((a) => a.name))
  const nodes = useMemo(() => {
    // M-F6：本 memo 只产出「种子坐标 + 元数据」，不再在此同步跑 forceLayout——力导向改由下方 rAF 分帧 effect 计算(结果写进 forcePos)。
    return assets.map((a) => {
      const hasSaved = !!savedPos[a.id]
      const sp = savedPos[a.id] || seedPos(hashId(a.id))
      return { id: a.id, name: a.name, type: a.type, x: sp.x, y: sp.y, fixed: hasSaved }
    })
    //   同名资产换序(assets 变而名字签名不变)时 nodes 不重算、edges 重算 → 下标错配连错节点。同依赖 assets 后两者永远同序。
    //   否则下方 effect 用陈旧 nodes 重算力导向会让手拖节点漂移(比原视觉问题更糟)。eslint-disable 仅因 savedPos 是经 posKey 间接入依赖、linter 看不出来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, posKey])

  const { edges } = useMemo(() => {
    const idx = {}
    const nameIdx = {}
    assets.forEach((a, i) => {
      idx[a.id] = i
      //   边会一律连到第一个；彻底解需 links 存目标 id(数据模型改动，属 B 区)，本轮不擅改。
      const nk = dashOut(a.name)
      if (nk && !(nk in nameIdx)) nameIdx[nk] = i
    })
    const es = []
    assets.forEach((a) =>
      (a.links || []).forEach((l) => {
        // M-F3：目标名过 dashOut 归一再查(与卡片侧 isDangling 双向归一同口径)——带空格/《》的边不再漏画/漏删、头部「N 边」计数不再偏少。
        //   toName 仍存原始 l.to：删边(onDelLink→LongFormPage.delLink)按 l.to===toName 精确匹配，归一会删不掉。
        const ti = nameIdx[dashOut(l.to)]
        if (ti !== undefined) es.push({ a: idx[a.id], b: ti, fromId: a.id, type: l.type, toName: l.to })
      })
    )
    return { edges: es }
  }, [assets])

  // 不依赖只按名字签名重跑的 nodes memo，故不会陈旧，也不必为改边重跑力导向布局。
  const degMap = useMemo(() => {
    const m = {}
    edges.forEach((e) => {
      m[e.fromId] = (m[e.fromId] || 0) + 1
    })
    return m
  }, [edges])

  // ==================== M-F6：力导向 = 缓存 + rAF 分帧（物理/迭代/力常量不动，只改"何时算"）====================
  // 布局边直接复用渲染 edges 的 [a,b] 下标对：两者同源(都按 dashOut 归一名字匹配)、与旧 nodes memo 内联的 es 逐条等价。
  const layoutEdges = useMemo(() => edges.map((e) => [e.a, e.b]), [edges])
  const [forcePos, setForcePos] = useState(null) // 力导向算出的坐标(与 nodes 同序)；null=尚未算，渲染先用种子位
  // 缓存键 = book.id + layoutKey(名字签名) + posKey(graphPos 签名)：重开弹窗 / 只改透出章·详情(名字与手拖位都不变)命中缓存、零重算；
  const rafRef = useRef(0)
  // M-F6②：useLayoutEffect + 首帧同步跑一次 tick——原 useEffect 先 setForcePos(种子位)会被绘一帧，每次开弹窗都闪一下种子螺旋。
  //   useLayoutEffect 在 paint 前同步执行：首帧 tick 直接算到收敛(小图)或算满 8ms(大图)再 setForcePos，paint 出来的不是种子位、不闪。
  useLayoutEffect(() => {
    if (!open) return // 关窗不算布局，也不留 rAF
    const key = `${book && book.id}::${layoutKey}::${posKey}`
    const cached = layoutCache.get(key) // M-F6①：模块级缓存，跨开合/跨书真命中
    if (cached) {
      //   下面对 fixed 节点再用 nodes 的 savedPos 覆盖一次属防御性冗余(正常恒等)，兜住任何"缓存与当前 savedPos 不一致"的边角，成本极低。
      //   (cached 与 nodes 同序：命中意味着 layoutKey 相同=同名同序，forcePos 本就按下标与 nodes 对齐消费。)
      setForcePos(cached.map((cp, i) => (nodes[i] && nodes[i].fixed ? { x: nodes[i].x, y: nodes[i].y } : cp)))
      return
    }
    const p = nodes.map((n) => ({ x: n.x, y: n.y, fixed: !!n.fixed }))
    if (!p.length) {
      setForcePos([])
      cacheLayout(key, [])
      return
    }
    let it = 0
    const tick = () => {
      const t0 = performance.now()
      // 时间盒分帧：每帧最多算 ~8ms（给渲染留余量），大图不再一次性阻塞主线程；forceStep 与同步跑逐字一致 → 产出逐像素相同
      while (it < FORCE_ITERS) {
        forceStep(p, layoutEdges)
        it += 1
        if (performance.now() - t0 >= 8) break
      }
      const snap = p.map((q) => ({ x: q.x, y: q.y }))
      setForcePos(snap)
      if (it < FORCE_ITERS) rafRef.current = requestAnimationFrame(tick) // 未收敛：下一帧继续（渲染中间态=收敛动画）
      else cacheLayout(key, snap) // 收敛完成，缓存最终坐标
    }
    tick() // 首帧同步跑（useLayoutEffect 内、paint 前）：小图一帧收敛到位、大图至少算 8ms，都不闪种子位
    return () => cancelAnimationFrame(rafRef.current) // 关窗 / 切书 / 卸载都取消未跑完的 rAF，不泄漏
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodes, layoutEdges, layoutKey, posKey, book && book.id])

  const posMap = useMemo(() => {
    const m = new Map()
    nodes.forEach((n, i) => {
      const fp = forcePos && forcePos[i]
      m.set(n.id, fp ? { x: fp.x, y: fp.y } : { x: n.x, y: n.y })
    })
    Object.keys(dragPos).forEach((id) => {
      if (dragPos[id]) m.set(id, dragPos[id])
    })
    return m
  }, [nodes, forcePos, dragPos])
  const posOf = (id) => posMap.get(id) || { x: W / 2, y: H / 2 }
  const node = assets.find((a) => a.id === nodeId) || null

  // M-F4：抽出按 clientX/clientY 换算布局坐标，供鼠标(toLayout)与触摸(onTouchMove 拖节点)共用
  const toLayoutXY = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect()
    const sx = ((clientX - r.left) / r.width) * W
    const sy = ((clientY - r.top) / r.height) * H
    return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }
  }
  const toLayout = (e) => toLayoutXY(e.clientX, e.clientY)
  const onMove = (e) => {
    if (dragRef.current) {
      draggedRef.current = true
      const p = toLayout(e)
      setDragPos((d) => ({ ...d, [dragRef.current]: { x: Math.min(W - 30, Math.max(30, p.x)), y: Math.min(H - 24, Math.max(24, p.y)) } }))
    } else if (panRef.current) {
      const r = svgRef.current.getBoundingClientRect()
      const dx = ((e.clientX - panRef.current.x) / r.width) * W
      const dy = ((e.clientY - panRef.current.y) / r.height) * H
      setView((v) => ({ ...v, tx: panRef.current.tx + dx, ty: panRef.current.ty + dy }))
    }
  }
  const onUp = () => {
    if (dragRef.current) {
      const aliveIds = new Set(assets.map((a) => a.id))
      const merged = {}
      Object.keys(dragPos).forEach((id) => {
        if (!aliveIds.has(id)) return
        merged[id] = { x: Math.round(dragPos[id].x), y: Math.round(dragPos[id].y) }
      })
      if (Object.keys(merged).length) onSavePos && onSavePos(merged)
      dragRef.current = null
      // 拖拽松手后紧随的 click 要吞掉（否则顺带弹出编辑框）；click 在 mouseup 同步序列后触发，rAF 在其后重置
      dragResetRafRef.current = requestAnimationFrame(() => {
        draggedRef.current = false
      })
    }
    panRef.current = null
  }
  // 以锚点(mx,my 屏幕svg坐标)为中心缩放：锚点处的布局坐标缩放后仍停在原屏幕位置
  const zoomAt = (mx, my, factor) => {
    setView((v) => {
      const ns = Math.min(3, Math.max(0.4, v.scale * factor))
      const lx = (mx - v.tx) / v.scale
      const ly = (my - v.ty) / v.scale
      return { scale: ns, tx: mx - ns * lx, ty: my - ns * ly }
    })
  }
  const onWheel = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    const mx = ((e.clientX - r.left) / r.width) * W
    const my = ((e.clientY - r.top) / r.height) * H
    zoomAt(mx, my, e.deltaY < 0 ? 1.15 : 0.87)
  }
  //   触摸端的默认滚动 / 双指页面缩放由 svg 的 touchAction:'none' 一并阻止(见下)。
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      onWheel(e)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => cancelAnimationFrame(dragResetRafRef.current), [])

  const touchRef = useRef(null)
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches
      touchRef.current = { mode: 'pinch', d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale0: view.scale }
    } else if (e.touches.length === 1) {
      const t = e.touches[0]
      // M-F4：单指先判落点是否命中节点——命中则拖节点(兑现底部「拖拽节点=调布局」承诺)，落空白才平移整图。
      //   原来单指一律记 pan、节点拖拽只绑 onMouseDown(触摸端不触发)，导致平板上拖节点变成平移整图。
      const g = t.target && t.target.closest ? t.target.closest('[data-node-id]') : null
      const nid = g && g.getAttribute('data-node-id')
      if (nid) {
        dragRef.current = nid
        touchRef.current = { mode: 'drag', id: nid }
      } else {
        touchRef.current = { mode: 'pan', x: t.clientX, y: t.clientY, tx: view.tx, ty: view.ty }
      }
    }
  }
  const onTouchMove = (e) => {
    const tr = touchRef.current
    if (!tr) return
    const r = svgRef.current.getBoundingClientRect()
    if (tr.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = e.touches
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const mx = (((a.clientX + b.clientX) / 2 - r.left) / r.width) * W
      const my = (((a.clientY + b.clientY) / 2 - r.top) / r.height) * H
      const ns = Math.min(3, Math.max(0.4, (tr.scale0 * d) / tr.d0))
      setView((v) => {
        const lx = (mx - v.tx) / v.scale
        const ly = (my - v.ty) / v.scale
        return { scale: ns, tx: mx - ns * lx, ty: my - ns * ly }
      })
    } else if (tr.mode === 'drag' && e.touches.length === 1) {
      // M-F4：触摸拖节点——与鼠标 onMove 的 dragRef 分支同口径(夹到画布内、写 dragPos)
      const t = e.touches[0]
      draggedRef.current = true
      const p = toLayoutXY(t.clientX, t.clientY)
      setDragPos((d) => ({ ...d, [tr.id]: { x: Math.min(W - 30, Math.max(30, p.x)), y: Math.min(H - 24, Math.max(24, p.y)) } }))
    } else if (tr.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0]
      setView((v) => ({ ...v, tx: tr.tx + ((t.clientX - tr.x) / r.width) * W, ty: tr.ty + ((t.clientY - tr.y) / r.height) * H }))
    }
  }
  const onTouchEnd = () => {
    // M-F4：触摸拖节点松手走与鼠标 onUp 同一套提交(合并 dragPos→onSavePos、rAF 吞掉随后的 click)；onUp 内部按 dragRef 决定是否提交
    if (touchRef.current && touchRef.current.mode === 'drag') onUp()
    touchRef.current = null
  }
  const onTouchCancel = () => {
    if (touchRef.current && touchRef.current.mode === 'drag') onUp() // 拖节点被打断：提交已拖到的位置(onUp 内清 dragRef/panRef、rAF 复位 draggedRef)
    touchRef.current = null
    panRef.current = null
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="关系网图谱">
      <div className="flex max-h-[92vh] w-[min(980px,96vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="whitespace-nowrap font-semibold text-ink">关系网图谱（{assets.length} 节点 / {edges.length} 边）</span>
          <div className="flex items-center gap-3 text-[11px] text-stone-500">
            {Object.keys(TYPE_COLOR).map((t) => (
              <span key={t} className="flex items-center gap-1 whitespace-nowrap">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TYPE_COLOR[t] }} />
                {ASSET_TYPE_LABEL[t]}
              </span>
            ))}
            <button onClick={onClose} className="ml-2 text-stone-400 hover:text-stone-600" aria-label="关闭">
              ×
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-stone-200 px-5 py-1.5 text-xs text-stone-500">
          <button onClick={() => zoomAt(W / 2, H / 2, 1.2)} className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 hover:bg-stone-100">
            ＋
          </button>
          <button onClick={() => zoomAt(W / 2, H / 2, 1 / 1.2)} className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 hover:bg-stone-100">
            －
          </button>
          <button onClick={() => setView({ scale: 1, tx: 0, ty: 0 })} className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 hover:bg-stone-100">
            重置视图
          </button>
          <span>{Math.round(view.scale * 100)}%</span>
          {onRebuildLinks && (
            <button onClick={onRebuildLinks} className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 hover:bg-stone-100">
              重建绑定边
            </button>
          )}
          <span className="ml-auto hidden sm:inline">滚轮缩放 · 拖空白平移 · 拖节点调布局 · 点节点编辑 · 点边选中后底部确认删除</span>
        </div>

        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full flex-1 select-none"
          style={{ background: '#0e0e13', touchAction: 'none' }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onMouseDown={(e) => {
            panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
          }}
        >
          <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
            {edges.map((e, i) => {
              const pa = posOf(nodes[e.a].id)
              const pb = posOf(nodes[e.b].id)
              const label = `${nodes[e.a].name} —${LINK_LABEL[e.type] || e.type}→ ${e.toName}`
              const isHover = hoverEdge && hoverEdge.fromId === e.fromId && hoverEdge.toName === e.toName && hoverEdge.type === e.type
              const active = isHover || (confirmEdge && confirmEdge.fromId === e.fromId && confirmEdge.toName === e.toName && confirmEdge.type === e.type)
              const hitWidth = Math.max(8, 12 / view.scale)
              const enterH = () => {
                if (!dragRef.current) setHoverEdge({ fromId: e.fromId, toName: e.toName, type: e.type })
              }
              const leaveH = () => setHoverEdge((h) => (h && h.fromId === e.fromId && h.toName === e.toName && h.type === e.type ? null : h))
              const clickE = () => {
                if (draggedRef.current) return
                setConfirmEdge({ fromId: e.fromId, toName: e.toName, type: e.type, label })
              }
              if (e.a === e.b) {
                const nr = 6 + Math.min(8, (degMap[nodes[e.a].id] || 0) * 1.4)
                const lr = 7
                const cy = pa.y - nr - lr - 1
                return (
                  <g key={i}>
                    <title>{`${label}（自环，点击后在底部确认删除）`}</title>
                    <circle cx={pa.x} cy={cy} r={lr} fill="none" stroke={active ? '#e11d48' : '#8a8a93'} strokeOpacity={active ? 0.95 : 0.6} strokeWidth={active ? 2 : 1} pointerEvents="none" />
                    <circle cx={pa.x} cy={cy} r={lr} fill="transparent" pointerEvents="all" className="cursor-pointer" onMouseEnter={enterH} onMouseLeave={leaveH} onClick={clickE} />
                  </g>
                )
              }
              return (
                <g key={i}>
                  <title>{`${label}（点击后在底部确认删除）`}</title>
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke={active ? '#e11d48' : '#8a8a93'}
                    strokeOpacity={active ? 0.95 : 0.6}
                    strokeWidth={active ? 2 : 1}
                    pointerEvents="none"
                  />
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke="transparent"
                    strokeWidth={hitWidth}
                    pointerEvents="stroke"
                    className="cursor-pointer"
                    onMouseEnter={enterH}
                    onMouseLeave={leaveH}
                    onClick={clickE}
                  />
                </g>
              )
            })}
            {nodes.map((n) => {
              const p = posOf(n.id)
              const r = 6 + Math.min(8, (degMap[n.id] || 0) * 1.4)
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  className="cursor-pointer"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    dragRef.current = n.id
                  }}
                  onClick={() => {
                    if (draggedRef.current) return
                    setNodeId(n.id)
                  }}
                >
                  <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLOR[n.type] || '#8a8a93'} fillOpacity="0.9" stroke="#0e0e13" strokeWidth="1.5" />
                  <text x={p.x} y={p.y + r + 10} textAnchor="middle" fontSize="9" fill="#c9c9cf">
                    {n.name}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>

        {confirmEdge && (
          <div className="flex flex-wrap items-center gap-2 border-t border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900">
            <span>
              删除这条绑定边？<span className="font-medium">{confirmEdge.label}</span>
            </span>
            <button
              onClick={() => {
                onDelLink(confirmEdge.fromId, confirmEdge.toName, confirmEdge.type)
                setConfirmEdge(null)
                setHoverEdge(null)
              }}
              className="rounded border border-red-300 bg-red-700 px-2 py-0.5 text-onaccent hover:bg-red-600"
            >
              确认删除
            </button>
            <button onClick={() => setConfirmEdge(null)} className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 text-stone-600 hover:bg-stone-100">
              取消
            </button>
          </div>
        )}

        <div className="border-t border-stone-200 px-5 py-2 text-[11px] text-stone-400">
          点击节点=快捷修改；拖拽节点=调整布局(松手存 IndexedDB)；点击边=选中，再在底部确认条里删除该绑定。数据源=book.assets.links（IndexedDB books store）。
        </div>
      </div>

      {node && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation()
            setNodeId(null)
          }}
          role="dialog"
          aria-modal="true"
          aria-label="资产节点详情"
        >
          <div className="w-[min(430px,92vw)] rounded-xl bg-paper p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-ink">
                {node.name} <span className="text-xs text-stone-400">({ASSET_TYPE_LABEL[node.type] || node.type})</span>
              </span>
              <button onClick={() => setNodeId(null)} className="text-stone-400 hover:text-stone-600">
                ×
              </button>
            </div>
            <div className="mb-2 max-h-24 overflow-y-auto text-[11px] leading-relaxed text-stone-500">{String(node.detail || '').slice(0, 200)}</div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <ChapterField kind="reveal" asset={node} perVol={perVol} inline width="w-16" onChange={(n) => onUpdateAsset(node.id, { ch_reveal: n })} />
              <ChapterField kind="rumor" asset={node} perVol={perVol} inline width="w-16" onChange={(n) => onUpdateAsset(node.id, { ch_rumor: n })} />
            </div>
            {/* C(需求5/6)：只读边列表+加边区整体换 LinkEditor——按源类型分组的关系下拉、目标可输入+名册外标红「顺便建档」、起始章、去重(与 addLink 同判据)。
                受控：links 进、next 出，onChange 直接 onUpdateAsset 落库；删边走 LinkEditor 内部(onChange 去掉该条)，故不再用 onDelLink/内联删边按钮。 */}
            <div className="mb-2 max-h-44 overflow-y-auto">
              <LinkEditor
                links={node.links || []}
                onChange={(next) => {
                  setConfirmEdge(null)
                  //   在 onChange 边界拦截：next 比当前少一条=发生删边→加二次确认。取消则不 persist；LinkEditor 受控于 node.links，
                  //   不更新即回退(被删的行重新出现)，等于撤销。加边(next 变多)/改边(条数不变)不拦，保持原即时保存手感。
                  const cur = node.links || []
                  if (next.length < cur.length) {
                    const gone = cur.find((l) => !next.some((n) => n.type === l.type && n.to === l.to))
                    const desc = gone ? `「${gone.to}」这条关系` : '一条关系'
                    if (!window.confirm(`确定删除 ${desc} 绑定吗？此操作不可撤销。`)) return
                  }
                  onUpdateAsset(node.id, { links: next })
                }}
                assets={assets}
                assetType={node.type}
                selfName={node.name}
                onQuickCreate={onAddAsset}
                allowCreate={!!onAddAsset}
              />
            </div>
            <button
              onClick={() => {
                if (!window.confirm(`确定删除资产《${node.name}》吗？其绑定边会一并删除，此操作不可撤销。`)) return
                onDeleteAsset(node.id)
                setNodeId(null)
              }}
              className="text-xs text-red-400 hover:underline"
            >
              删除该资产
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
