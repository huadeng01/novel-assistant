import { useEffect, useMemo, useRef, useState } from 'react'
import { LINK_LABEL } from '../lib/parseAssets.js'
// C(资产库阶段2)：perVolOf(透出章按卷估算单一出处) + ChapterField(透出/传闻章统一显示) + LinkEditor(加边/删边/顺便建档)
import { perVolOf } from '../lib/assets.js'
import ChapterField from './ChapterField.jsx'
import LinkEditor from './LinkEditor.jsx'

// 关系网图谱（Obsidian 式力导向图，零依赖自实现）：节点=资产，边=links。
// 点击节点→小弹窗快捷修改；拖拽节点=调布局(存IndexedDB)；滚轮缩放+拖空白平移；点击边=删边。
// 关系类型显示中文（LINK_LABEL），存储保持英文枚举。
const W = 860
const H = 560
// C(设计§2.1)：节点色/图例补 skill(功法)/beast(宠物)两类新资产类型（图例由 Object.keys(TYPE_COLOR) 自动带出）
const TYPE_COLOR = { person: '#C9A96A', faction: '#7FA8B0', place: '#8FAF7E', item: '#B08AC9', group: '#8A8A93', skill: '#D98E4A', beast: '#6FB492' }
const TYPE_LABEL = { person: '人物', faction: '势力', place: '地点', item: '道具', group: '群像', skill: '功法', beast: '宠物' }

function seedPos(i, n) {
  const angle = i * 2.39996
  const r = 120 + (i % 5) * 34 + (n % 3) * 12
  return { x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) * 0.82 }
}

function forceLayout(nodes, edges) {
  // fixed = 用户手动拖过并已存库的节点：布局时固定不动，只让新节点围绕它收敛，避免每次刷新把手动布局打散(H14)
  const p = nodes.map((n) => ({ x: n.x, y: n.y, fixed: !!n.fixed }))
  for (let it = 0; it < 140; it++) {
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
  return p
}

export default function AssetGraphModal({ open, onClose, book, onUpdateAsset, onDeleteAsset, onDelLink, onSavePos, onRebuildLinks, onAddAsset }) {
  const [nodeId, setNodeId] = useState(null)
  const [dragPos, setDragPos] = useState({})
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  // M47：点边不再立即永久删除——记下待确认的边，在底部出一条非阻塞确认条；hoverEdge 用于高亮即将操作的边
  const [confirmEdge, setConfirmEdge] = useState(null)
  const [hoverEdge, setHoverEdge] = useState(-1)
  const dragRef = useRef(null)
  const draggedRef = useRef(false)
  const panRef = useRef(null)
  const svgRef = useRef(null)

  const assets = (book && book.assets) || []
  const savedPos = (book && book.graphPos) || {}
  // C(需求4)：透出/传闻章「按卷估算」与长篇页/资产库同源(perVolOf 单一出处)，ChapterField 用它，清掉图谱原来的第三套口径(M49)
  const perVol = perVolOf(book)

  // 力导向布局只在"资产名单或书"变化时重跑：改透出章/详情/拖拽保存不触发 140 轮重算
  const layoutKey = assets.map((a) => a.name).join(',')
  const nodes = useMemo(() => {
    // C6：用 id→index 与 name→首个index 映射定位布局边，替代 assets.indexOf(每条边 O(n) 线性查找)与 find(重名时与渲染边口径不一致)
    const idx = {}
    const nameIdx = {}
    assets.forEach((a, i) => {
      idx[a.id] = i
      if (!(a.name in nameIdx)) nameIdx[a.name] = i
    })
    // C5：deg 不在此处算——本 memo 只按名字签名(layoutKey)重跑，增删边后名字不变则不重算，deg 会陈旧；
    // 节点半径改由 edges 派生的 degMap 提供(见下)，增删边即时更新且不触发 140 轮力导向重跑。
    const raw = assets.map((a, i) => {
      const hasSaved = !!savedPos[a.id]
      const sp = savedPos[a.id] || seedPos(i, assets.length)
      return { id: a.id, name: a.name, type: a.type, x: sp.x, y: sp.y, fixed: hasSaved }
    })
    const es = []
    assets.forEach((a) =>
      (a.links || []).forEach((l) => {
        const ti = nameIdx[l.to]
        if (ti !== undefined) es.push([idx[a.id], ti])
      })
    )
    const p = forceLayout(raw, es)
    return raw.map((n, i) => ({ ...n, x: p[i].x, y: p[i].y }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, book && book.id])

  const { edges } = useMemo(() => {
    const idx = {}
    assets.forEach((a, i) => {
      idx[a.id] = i
    })
    const es = []
    assets.forEach((a) =>
      (a.links || []).forEach((l, li) => {
        const t = assets.find((x) => x.name === l.to)
        if (t) es.push({ a: idx[a.id], b: idx[t.id], fromId: a.id, linkIdx: li, type: l.type, toName: l.to })
      })
    )
    return { edges: es }
  }, [assets])

  // C5：节点度数(出度)从 edges 派生——增删边后 edges(deps=[assets])重算，半径即时更新；
  // 不依赖只按名字签名重跑的 nodes memo，故不会陈旧，也不必为改边重跑力导向布局。
  const degMap = useMemo(() => {
    const m = {}
    edges.forEach((e) => {
      m[e.fromId] = (m[e.fromId] || 0) + 1
    })
    return m
  }, [edges])

  // M46：渲染前先一次性建 id→坐标 查表（只在 nodes / dragPos 变化时重建），posOf 由 O(n) 线性 find 降为 O(1) 查表。
  // 原实现每条边调 2 次 nodes.find、每个节点调 1 次，拖动时每帧 O(E·n)（300 边×200 节点=每帧 12 万次查找）明显掉帧。
  const posMap = useMemo(() => {
    const m = new Map()
    nodes.forEach((n) => m.set(n.id, n))
    Object.keys(dragPos).forEach((id) => {
      if (dragPos[id]) m.set(id, dragPos[id])
    })
    return m
  }, [nodes, dragPos])
  const posOf = (id) => posMap.get(id) || { x: W / 2, y: H / 2 }
  const node = assets.find((a) => a.id === nodeId) || null

  const toLayout = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    const sx = ((e.clientX - r.left) / r.width) * W
    const sy = ((e.clientY - r.top) / r.height) * H
    return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }
  }
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
      // 只提交实际拖动过的节点(dragPos)，不把未拖节点的力导向位置一并钉死(H14)；已存布局由 saveGraphPos 合并保留
      const merged = {}
      Object.keys(dragPos).forEach((id) => {
        merged[id] = { x: Math.round(dragPos[id].x), y: Math.round(dragPos[id].y) }
      })
      onSavePos && onSavePos(merged)
      dragRef.current = null
      // 拖拽松手后紧随的 click 要吞掉（否则顺带弹出编辑框）；click 在 mouseup 同步序列后触发，rAF 在其后重置
      requestAnimationFrame(() => {
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
  // L4：滚轮缩放时阻止页面默认滚动——React onWheel 是 passive 监听，preventDefault 无效(会告警)，须用原生 passive:false 监听手动挂。
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

  const touchRef = useRef(null)
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches
      touchRef.current = { mode: 'pinch', d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale0: view.scale }
    } else if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = { mode: 'pan', x: t.clientX, y: t.clientY, tx: view.tx, ty: view.ty }
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
    } else if (tr.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0]
      setView((v) => ({ ...v, tx: tr.tx + ((t.clientX - tr.x) / r.width) * W, ty: tr.ty + ((t.clientY - tr.y) / r.height) * H }))
    }
  }
  const onTouchEnd = () => {
    touchRef.current = null
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-[min(980px,96vw)] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="whitespace-nowrap font-semibold text-ink">关系网图谱（{assets.length} 节点 / {edges.length} 边）</span>
          <div className="flex items-center gap-3 text-[11px] text-stone-500">
            {Object.keys(TYPE_COLOR).map((t) => (
              <span key={t} className="flex items-center gap-1 whitespace-nowrap">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TYPE_COLOR[t] }} />
                {TYPE_LABEL[t]}
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
              const active = hoverEdge === i || (confirmEdge && confirmEdge.i === i)
              // M47：命中线宽度按缩放反比补偿，缩到 40% 时屏幕上仍有约 12px 可点区（原 1px 线在 40% 下只有 0.4px，基本点不到）
              const hitWidth = Math.max(8, 12 / view.scale)
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
                    onMouseEnter={() => {
                      // 拖节点时不切 hover 高亮，避免每帧多一次 state 更新(M46)
                      if (!dragRef.current) setHoverEdge(i)
                    }}
                    onMouseLeave={() => setHoverEdge((h) => (h === i ? -1 : h))}
                    onClick={() => {
                      if (draggedRef.current) return
                      // A6：confirmEdge 存稳定标识(fromId+toName+type)而非 linkIdx 下标——点边选中与确认删除之间若发生 rebuildLinks/增删边使 links 重排，按下标会删错边
                      setConfirmEdge({ i, fromId: e.fromId, toName: e.toName, type: e.type, label })
                    }}
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

        {/* M47：删边确认条（非阻塞，替代原来"点一下即永久删除"） */}
        {confirmEdge && (
          <div className="flex flex-wrap items-center gap-2 border-t border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900">
            <span>
              删除这条绑定边？<span className="font-medium">{confirmEdge.label}</span>
            </span>
            <button
              onClick={() => {
                onDelLink(confirmEdge.fromId, confirmEdge.toName, confirmEdge.type)
                setConfirmEdge(null)
                setHoverEdge(-1)
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
          点击节点=快捷修改；拖拽节点=调整布局(松手存 IndexedDB)；点击边=选中，再在上方确认条里删除该绑定。数据源=book.assets.links（IndexedDB books store）。
        </div>
      </div>

      {node && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation() // A1：节点弹窗遮罩嵌在图谱外层(onClick=onClose)内，点空白只关节点弹窗，不冒泡关掉整个图谱
            setNodeId(null)
          }}
        >
          <div className="w-[min(430px,92vw)] rounded-xl bg-paper p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-ink">
                {node.name} <span className="text-xs text-stone-400">({TYPE_LABEL[node.type] || node.type})</span>
              </span>
              <button onClick={() => setNodeId(null)} className="text-stone-400 hover:text-stone-600">
                ×
              </button>
            </div>
            <div className="mb-2 max-h-24 overflow-y-auto text-[11px] leading-relaxed text-stone-500">{String(node.detail || '').slice(0, 200)}</div>
            {/* C(需求4/M49)：透出/传闻章换 ChapterField——清掉图谱这第三套口径(原 value={node.ch_reveal||0} 显示0、无估算提示)，
                与 AssetModal/EditAssetModal 统一(输入框绑原始精确章号、未指定=空白，按卷估算放小字)；onBlur/Enter 才提交(缓解 M29)。 */}
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
                  setConfirmEdge(null) // 边列表变了，清掉可能已失效的待确认删边(M47 同源：防按下标删错)
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
