// assets.js 回归网（方案甲步骤2）：把前几轮已修的状态语义行为钉成测试，防「每复检又挖一批」。
// 只测现有代码、不改 src。每条断言对应一个已修行为（决策#7/#1/#2/#5、H2/H3、M6/M10、派生边重算等）。
import { describe, it, expect } from 'vitest'
import {
  normalizeState, stateHasContent, applyStateChange, normalizeAsset,
  typeKeyOf, mergeAssetDraft, perVolOf, TYPE_SYNONYMS,
  saveEditAsset, applyFlowToAsset, rebuildDerivedEdges, stateToPromptLine,
  findAssetByName, applyFlowToRoster,
} from '../assets.js'

describe('normalizeState（决策#7：未映射词不兜底 active）', () => {
  it('v1 已映射字符串 → plot.tag + legacy 留原话', () => {
    const s = normalizeState('死亡')
    expect(s.plot).toEqual({ tag: 'dead' })
    expect(s.legacy).toBe('死亡')
    expect(normalizeState('活跃').plot.tag).toBe('active')
  })
  it('v1 未映射词（重伤）→ plot 留 null、不兜底 active，原词只进 legacy', () => {
    const s = normalizeState('重伤')
    expect(s.plot).toBeNull()
    expect(s.legacy).toBe('重伤')
  })
  it('hold/rel 字符串项保留（normDimList 走 dashOut，不再被 normDimObj 静默清空）', () => {
    expect(normalizeState({ v: 2, hold: ['青竹剑'] }).hold).toEqual([{ name: '青竹剑' }])
    expect(normalizeState({ v: 2, rel: ['李四'] }).rel).toEqual([{ name: '李四' }])
  })
  it('空壳条目被过滤（hold:[{}] → 空数组）', () => {
    expect(normalizeState({ v: 2, hold: [{}] }).hold).toEqual([])
  })
  it('null/空串 → 全空 base（plot null）', () => {
    expect(normalizeState(null).plot).toBeNull()
    expect(normalizeState('').plot).toBeNull()
  })
})

describe('stateHasContent（决策#2：hold 要 name、rel 要 to 才算内容）', () => {
  it('hold 空壳/无名 → false；有名 → true', () => {
    expect(stateHasContent({ v: 2, hold: [{}] })).toBe(false)
    expect(stateHasContent({ v: 2, hold: [{ name: '', change: 'gain' }] })).toBe(false)
    expect(stateHasContent({ v: 2, hold: [{ name: '青竹剑', change: 'gain' }] })).toBe(true)
  })
  it('rel 无 to → false（即使有 tag）；有 to → true', () => {
    expect(stateHasContent({ v: 2, rel: [{ tag: 'ally', to: '' }] })).toBe(false)
    expect(stateHasContent({ v: 2, rel: [{ to: '李四' }] })).toBe(true)
  })
  it('标量维度只有 tag/note 也算内容', () => {
    expect(stateHasContent({ v: 2, phys: { tag: 'injured' } })).toBe(true)
    expect(stateHasContent({ v: 2, power: { note: '金丹中期' } })).toBe(true)
  })
  it('plot.tag=active 单独不算内容（v1 迁移默认落点）', () => {
    expect(stateHasContent({ v: 2, plot: { tag: 'active' } })).toBe(false)
  })
})

describe('applyStateChange（H3 字段级增量 + 决策#1 hold 不猜 gain）', () => {
  it('plot 改一次不丢 firstCh/lastCh（增量合并、非整体替换）', () => {
    let st = normalizeState({ v: 2, plot: { tag: 'active', firstCh: 1, lastCh: 45, note: '主线贯穿' } })
    st = applyStateChange(st, { dimKey: 'plot', state: '退场', since: 50 }, 50)
    expect(st.plot.firstCh).toBe(1)
    expect(st.plot.lastCh).toBe(45)
    expect(st.plot.tag).toBe('offstage')
    expect(st.plot.since).toBe(50)
  })
  it('hold「失去X」→ change:lose（不再硬编码 gain 反转语义）', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'hold', state: '失去玄铁令', since: 10 }, 10)
    expect(st.hold[0].change).toBe('lose')
  })
  it('hold name 剥掉动词前缀（失去玄铁令 → 玄铁令）', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'hold', state: '失去玄铁令', since: 10 }, 10)
    expect(st.hold[0].name).toBe('玄铁令')
  })
  it('hold 判不出 change → 不猜、change 空 + 原词进 note', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'hold', state: '神秘物件', since: 5 }, 5)
    expect(st.hold[0].change).toBeUndefined()
    expect(st.hold[0].note).toBe('神秘物件')
  })
  it('place 并入 sc.note（此前 place 是唯一丢 note 的维度）', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'place', state: '在青冥山', note: '被困此处', since: 40 }, 40)
    expect(st.place.ref).toBe('青冥山')
    expect(st.place.note).toBe('被困此处')
  })
  it('place tag 未命中时保留旧 tag（被囚不被 at 覆盖）', () => {
    let st = normalizeState({ v: 2, place: { tag: 'imprisoned', ref: '天牢' } })
    st = applyStateChange(st, { dimKey: 'place', state: '', since: 41 }, 41)
    expect(st.place.tag).toBe('imprisoned')
  })
  it('dimKey 空 → 原样返回、不写 meta', () => {
    const cur = { v: 2, phys: { tag: 'injured' } }
    const st = applyStateChange(cur, { dimKey: '' }, 5)
    expect(st.meta).toBeFalsy()
  })
  it('meta 记 updatedBy=analyze + sourceCh', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'phys', state: '受伤', since: 37 }, 37)
    expect(st.meta.updatedBy).toBe('analyze')
    expect(st.meta.sourceCh).toBe(37)
  })
})

describe('typeKeyOf（决策#5：同义词 + 英文小写归一）', () => {
  it('中文同义词归一', () => {
    expect(typeKeyOf('门派')).toBe('faction')
    expect(typeKeyOf('宗门')).toBe('faction')
    expect(typeKeyOf('法宝')).toBe('item')
    expect(typeKeyOf('丹药')).toBe('item')
    expect(typeKeyOf('妖兽')).toBe('beast')
    expect(typeKeyOf('灵兽')).toBe('beast')
    expect(typeKeyOf('功法')).toBe('skill')
    expect(typeKeyOf('神通')).toBe('skill')
    expect(typeKeyOf('角色')).toBe('person')
    expect(typeKeyOf('群像')).toBe('group')
    expect(typeKeyOf('地点')).toBe('place')
  })
  it('英文 key 小写归一', () => {
    expect(typeKeyOf('Place')).toBe('place')
    expect(typeKeyOf('GROUP')).toBe('group')
    expect(typeKeyOf('item')).toBe('item')
  })
  it('未识别 → person 兜底；空 → person', () => {
    expect(typeKeyOf('未知词')).toBe('person')
    expect(typeKeyOf('')).toBe('person')
  })
  it('TYPE_SYNONYMS 表存在且含各类型', () => {
    expect(TYPE_SYNONYMS.faction).toContain('门派')
    expect(TYPE_SYNONYMS.item).toContain('法宝')
  })
})

describe('normalizeAsset（M10 updatedAt 保留 + type/tier 校验）', () => {
  it('updatedAt 保留原值（不再无条件重置为 Date.now，读入口不污染）', () => {
    expect(normalizeAsset({ name: 'x', type: 'person', updatedAt: 1000000 }).updatedAt).toBe(1000000)
  })
  it('updatedAt 缺失才落当前时间', () => {
    expect(normalizeAsset({ name: 'x', type: 'person' }).updatedAt).toBeGreaterThan(1e12)
  })
  it('type 走 typeKeyOf 归一（item12：中文标签/同义词自愈，不再静默落 person）', () => {
    expect(normalizeAsset({ name: 'x', type: 'place' }).type).toBe('place')
    expect(normalizeAsset({ name: '青云山', type: '地点' }).type).toBe('place')
    expect(normalizeAsset({ name: 'x', type: '门派' }).type).toBe('faction')
    expect(normalizeAsset({ name: 'x', type: '未知词' }).type).toBe('person')
  })
  it('tier 缺省：person/group → M', () => {
    expect(normalizeAsset({ name: 'x', type: 'person' }).tier).toBe('M')
    expect(normalizeAsset({ name: 'x', type: 'group' }).tier).toBe('M')
  })
})

describe('mergeAssetDraft（H2 type/tier 不被默认覆盖 + item3/4 派生边重算）', () => {
  it('draft 未填 type/tier → 保留已有（地点不变 person、tier 不降）', () => {
    const m = mergeAssetDraft({ id: 'a1', name: '青云山', type: 'place', tier: 'S' }, { name: '青云山', detail: '新描述' })
    expect(m.type).toBe('place')
    expect(m.tier).toBe('S')
  })
  it('draft 显式填 type/tier → 覆盖', () => {
    const m = mergeAssetDraft({ id: 'a1', name: '青云山', type: 'place', tier: 'S' }, { name: '青云山', type: 'faction', tier: 'M' })
    expect(m.type).toBe('faction')
    expect(m.tier).toBe('M')
  })
  it('道具改 holder → held_by 派生边指向新 holder、旧边剔掉（在 merged 上重算）', () => {
    const m = mergeAssetDraft(
      { id: 'i1', name: '玄铁剑', type: 'item', holder: '林凡', links: [{ type: 'held_by', to: '林凡', derived: true }] },
      { holder: '张三' },
    )
    expect(m.holder).toBe('张三')
    const held = m.links.filter((l) => l.type === 'held_by')
    expect(held).toHaveLength(1)
    expect(held[0].to).toBe('张三')
  })
  it('place.ref 旧地→新地 → located_in 单条不堆积', () => {
    const m = mergeAssetDraft(
      { id: 'p1', name: '陆沉', type: 'person', state: { v: 2, place: { tag: 'at', ref: '青冥山' } }, links: [{ type: 'located_in', to: '青冥山', derived: true }] },
      { state: { v: 2, place: { tag: 'at', ref: '京城' } } },
    )
    const loc = m.links.filter((l) => l.type === 'located_in')
    expect(loc).toHaveLength(1)
    expect(loc[0].to).toBe('京城')
  })
  it('detail 追加不吞旧、判重不重复堆', () => {
    const m = mergeAssetDraft({ id: 'a1', name: 'x', type: 'person', detail: '旧描述' }, { name: 'x', detail: '新描述' })
    expect(m.detail).toBe('旧描述｜新描述')
    const m2 = mergeAssetDraft({ id: 'a1', name: 'x', type: 'person', detail: '旧描述' }, { name: 'x', detail: '旧描述' })
    expect(m2.detail).toBe('旧描述')
  })
})

describe('存量派生边迁移（方案a：上线前落库的无标记 held_by/located_in/controlled_by 当系统派生处理）', () => {
  // 老数据形态：这三类边由 holder/state.place/controller 生成，但落库时没有 derived 标记
  const legacyPerson = {
    id: 'p1', name: '陆沉', type: 'person',
    state: { v: 2, place: { tag: 'at', ref: '青冥山', since: 3 } },
    links: [{ type: 'located_in', to: '青冥山', since_ch: 3 }],
  }
  it('读入即补 derived 标记（normalizeAsset 是读入口，useBooks/useAssets/LongFormPage 都过它）', () => {
    const a = normalizeAsset(legacyPerson, { idPrefix: 'lf' })
    expect(a.links.filter((l) => l.type === 'located_in')).toEqual([{ type: 'located_in', to: '青冥山', derived: true, since_ch: 3 }])
  })
  it('改 state.place 青冥山→京城 后只剩 located_in→京城 一条，不残留旧地点（修「图谱重复边」）', () => {
    const read = normalizeAsset(legacyPerson, { idPrefix: 'lf' })
    const edited = saveEditAsset(read, { state: { v: 2, place: { tag: 'at', ref: '京城', since: 9 } } }, { idPrefix: 'lf' })
    const loc = edited.links.filter((l) => l.type === 'located_in')
    expect(loc).toHaveLength(1)
    expect(loc[0].to).toBe('京城')
    expect(edited.links.some((l) => l.to === '青冥山')).toBe(false)
  })
  it('存量无标记 held_by：改持有者后单条指向新持有者', () => {
    const read = normalizeAsset({ id: 'i1', name: '玄铁剑', type: 'item', holder: '林凡', links: [{ type: 'held_by', to: '林凡' }] }, { idPrefix: 'lf' })
    expect(read.links.find((l) => l.type === 'held_by').derived).toBe(true)
    const edited = saveEditAsset(read, { holder: '张三' }, { idPrefix: 'lf' })
    expect(edited.links.filter((l) => l.type === 'held_by').map((l) => l.to)).toEqual(['张三'])
  })
  it('存量无标记 controlled_by（controller 不落库）：沿用不丢边，改控制方后单条、再读幂等', () => {
    const legacyPlace = { id: 'c1', name: '青云城', type: 'place', links: [{ type: 'controlled_by', to: '天庭' }] }
    const read = normalizeAsset(legacyPlace, { idPrefix: 'lf' })
    expect(read.links.filter((l) => l.type === 'controlled_by').map((l) => l.to)).toEqual(['天庭'])
    const edited = saveEditAsset(read, { controller: '天剑宗' }, { idPrefix: 'lf' })
    expect(edited.links.filter((l) => l.type === 'controlled_by').map((l) => l.to)).toEqual(['天剑宗'])
    expect(normalizeAsset(edited, { idPrefix: 'lf' }).links.filter((l) => l.type === 'controlled_by')).toHaveLength(1)
  })
  it('显式清空 controller（controller:""）→ controlled_by 不被存量边回填', () => {
    const read = normalizeAsset({ id: 'c1', name: '青云城', type: 'place', links: [{ type: 'controlled_by', to: '天庭', derived: true }] }, { idPrefix: 'lf' })
    expect(saveEditAsset(read, { controller: '' }, { idPrefix: 'lf' }).links.filter((l) => l.type === 'controlled_by')).toHaveLength(0)
  })
  it('不误伤：无字段支撑的三类边（buildLinks 名字共现 / parseRelations 关系网步）仍按手建保留', () => {
    const read = normalizeAsset({ id: 'p2', name: '李四', type: 'person', links: [{ type: 'located_in', to: '青云城' }, { type: 'related', to: '陆沉' }] }, { idPrefix: 'lf' })
    expect(read.links.find((l) => l.type === 'located_in').derived).toBeUndefined()
    const edited = saveEditAsset(read, { state: { v: 2, place: { tag: 'at', ref: '京城' } } }, { idPrefix: 'lf' })
    expect(edited.links.some((l) => l.type === 'located_in' && l.to === '青云城' && l.derived !== true)).toBe(true) // 共现边保留
    expect(edited.links.some((l) => l.type === 'located_in' && l.to === '京城' && l.derived === true)).toBe(true)  // 新派生边
    expect(edited.links.some((l) => l.type === 'related' && l.to === '陆沉')).toBe(true)
  })
})

describe('perVolOf（卷一章数单一出处）', () => {
  it('null/空对象 → 默认 40', () => {
    expect(perVolOf(null)).toBe(40)
    expect(perVolOf({})).toBe(40)
  })
  it('volOneChapters 优先', () => {
    expect(perVolOf({ volOneChapters: 25 })).toBe(25)
  })
  it('无 volOneChapters 时取 beats 最大章号，下限 40', () => {
    expect(perVolOf({ beats: [{ chapter_no: 50 }] })).toBe(50)
    expect(perVolOf({ beats: [{ chapter_no: 10 }] })).toBe(40)
  })
})

describe('档4 共享层（saveEditAsset/applyFlowToAsset/rebuildDerivedEdges + lib-M1/M3）', () => {
  it('saveEditAsset：holder/controller 全量合并生效（修 LongFormPage 白名单漏项）', () => {
    const a = saveEditAsset({ id: 'i1', name: '玄铁剑', type: 'item', holder: '林凡' }, { holder: '张三' }, { idPrefix: 'lf' })
    expect(a.holder).toBe('张三')
    expect(a.links.filter((l) => l.type === 'held_by').map((l) => l.to)).toEqual(['张三'])
    const p = saveEditAsset({ id: 'l1', name: '青云城', type: 'place' }, { controller: '天剑宗' }, { idPrefix: 'lf' })
    expect(p.links.some((l) => l.type === 'controlled_by' && l.to === '天剑宗')).toBe(true)
  })
  it('saveEditAsset：place A→B → located_in 单条（strip 旧 derived，修 LongFormPage-M3）', () => {
    const a = saveEditAsset(
      { id: 'p1', name: '陆沉', type: 'person', state: { v: 2, place: { tag: 'at', ref: '青冥山' } }, links: [{ type: 'located_in', to: '青冥山', derived: true }] },
      { state: { v: 2, place: { tag: 'at', ref: '京城' } } },
    )
    const loc = a.links.filter((l) => l.type === 'located_in')
    expect(loc).toHaveLength(1)
    expect(loc[0].to).toBe('京城')
  })
  it('rebuildDerivedEdges：保留用户手建边（无 derived），只重算派生边（修 lib-M2）', () => {
    const r = rebuildDerivedEdges(
      { id: 'c1', name: '青云城', type: 'place', links: [{ type: 'controlled_by', to: '天庭' }, { type: 'related', to: '某派' }] },
      { controller: '天剑宗' },
    )
    expect(r.links.some((l) => l.to === '天庭' && !l.derived)).toBe(true) // 手建 controlled_by 保留
    expect(r.links.some((l) => l.to === '天剑宗' && l.derived)).toBe(true) // 新派生 controlled_by
    expect(r.links.some((l) => l.type === 'related' && l.to === '某派')).toBe(true) // 手建其它边保留
  })
  it('applyFlowToAsset：gain→holder+held_by；lose→phys lost「已丢失」；broken→「已损毁」', () => {
    const g = applyFlowToAsset({ id: 'i1', name: '玄铁剑', type: 'item', holder: '' }, { person: '张三', change: 'gain', asset: '玄铁剑', ch: 5 })
    expect(g.holder).toBe('张三')
    expect(g.links.some((l) => l.type === 'held_by' && l.to === '张三')).toBe(true)
    const lo = applyFlowToAsset({ id: 'i1', name: '玄铁剑', type: 'item' }, { change: 'lose', asset: '玄铁剑', ch: 8 })
    expect(lo.state.phys.tag).toBe('lost')
    expect(stateToPromptLine({ type: 'item', state: lo.state })).toContain('已丢失')
    const br = applyFlowToAsset({ id: 'i1', name: '玄铁剑', type: 'item' }, { change: 'broken', asset: '玄铁剑', ch: 9 })
    expect(br.state.phys.tag).toBe('broken')
    expect(stateToPromptLine({ type: 'item', state: br.state })).toContain('已损毁')
    const co = applyFlowToAsset({ id: 'i1', name: '丹药', type: 'item' }, { change: 'consumed', asset: '丹药', ch: 10 })
    expect(co.state.phys.tag).toBe('consumed') // 尾批②：consumed 独立 tag，不借 broken
    expect(stateToPromptLine({ type: 'item', state: co.state })).toContain('已消耗')
  })
  it('lib-M1：默认 state「活跃」不注入「现况：活跃」；真状态仍注入', () => {
    expect(stateHasContent(normalizeState('活跃'))).toBe(false)
    expect(stateToPromptLine({ type: 'place', state: '活跃' })).toBe('')
    expect(stateToPromptLine({ type: 'person', state: '重伤' })).toContain('重伤')
  })
  it('lib-M3：rel 状态词进 note 不塞 to，注入通顺无「与与」', () => {
    const st = applyStateChange(normalizeState(null), { dimKey: 'rel', state: '与李四结盟', since: 3 }, 3)
    const line = stateToPromptLine({ type: 'person', state: st })
    expect(line).toContain('与李四结盟')
    expect(line).not.toContain('与与')
  })
  it('findAssetByName：精确 + 别名/书名号容错（D10 单一出处）', () => {
    const roster = [normalizeAsset({ id: 'i2', name: '玄铁剑', type: 'item', aliases: ['玄铁'] })]
    expect((findAssetByName(roster, '玄铁剑') || {}).id).toBe('i2')
    expect((findAssetByName(roster, '玄铁') || {}).id).toBe('i2')
    expect((findAssetByName(roster, '《玄铁剑》') || {}).id).toBe('i2')
    expect(findAssetByName(roster, '没有的')).toBeNull()
  })
  it('applyFlowToRoster：gain 全新→建 person+item(D9/D8)、不写 ch_reveal(D7)、holder+held_by(D6)、人物侧 hold', () => {
    const r = applyFlowToRoster([], { person: '张三', change: 'gain', asset: '玄铁剑', ch: 5 }, { idPrefix: 'cx' })
    expect(r.created.map((c) => c.type).sort()).toEqual(['item', 'person'])
    const sword = r.assets.find((a) => a.type === 'item')
    expect(sword.holder).toBe('张三')
    expect(sword.ch_reveal).toBe(0)
    expect(sword.links.some((l) => l.type === 'held_by' && l.to === '张三')).toBe(true)
    expect(r.assets.find((a) => a.type === 'person').state.hold).toEqual([{ name: '玄铁剑', change: 'gain', ch: 5 }])
  })
  it('applyFlowToRoster：lose 未建档→skipped 不新建；lose 已建档→phys lost', () => {
    const r1 = applyFlowToRoster([normalizeAsset({ id: 'p1', name: '张三', type: 'person' })], { person: '张三', change: 'lose', asset: '不存在物', ch: 8 })
    expect(r1.created.filter((c) => c.type === 'item')).toHaveLength(0)
    expect(r1.skipped).toContain('不存在物')
    const r2 = applyFlowToRoster([normalizeAsset({ id: 'i1', name: '玄铁剑', type: 'item', holder: '张三' })], { person: '张三', change: 'lose', asset: '玄铁剑', ch: 9 })
    expect(r2.assets.find((a) => a.id === 'i1').state.phys.tag).toBe('lost')
  })
})

describe('第二轮 H1 回归：place 裸地名/被困于 注入非空、地点不丢（M-E1 曾使其蒸发）', () => {
  const placeLine = (word, extra) => stateToPromptLine({ type: 'person', state: applyStateChange(normalizeState(null), { dimKey: 'place', state: word, ...(extra || {}), since: 5 }, 5) })
  it('B#1 裸词/动词短语 → inferred 直接渲染原词、不加「人在」（H1 曾误设 at 渲染「人在前往昆仑」）', () => {
    expect(placeLine('青冥山')).toContain('青冥山')
    expect(placeLine('青冥山')).not.toContain('人在')
    expect(placeLine('前往昆仑')).toContain('前往昆仑')
    expect(placeLine('前往昆仑')).not.toContain('人在')
  })
  it('B#1 真地名走第一路（在X）→ 人在X；inferred 不建 located_in、第一路建', () => {
    expect(placeLine('在青冥山')).toContain('人在青冥山')
    const inferred = applyStateChange(normalizeState(null), { dimKey: 'place', state: '前往昆仑', since: 5 }, 5)
    expect(inferred.place.inferred).toBe(true)
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: inferred }).links.filter((l) => l.type === 'located_in')).toHaveLength(0)
    const real = applyStateChange(normalizeState(null), { dimKey: 'place', state: '在青冥山', since: 5 }, 5)
    expect(real.place.inferred).toBeFalsy()
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: real }).links.filter((l) => l.type === 'located_in')).toHaveLength(1)
  })
  it('B#2 place.note 全分支兜底：imprisoned/exiled 无 ref 时用 note 替「某处」', () => {
    expect(placeLine('被囚', { note: '水牢' })).toContain('被囚于水牢')
    expect(placeLine('流放', { note: '岭南' })).toContain('被流放到岭南')
  })
  it('word 空 + note → placePhrase 兜底渲染 note、不注入空', () => {
    expect(placeLine('', { note: '在某处' })).toContain('在某处')
  })
  it('phys+place 混合不丢地点', () => {
    let st = applyStateChange(normalizeState(null), { dimKey: 'phys', state: '受伤', since: 5 }, 5)
    st = applyStateChange(st, { dimKey: 'place', state: '青冥山', since: 5 }, 5)
    const l = stateToPromptLine({ type: 'person', state: st })
    expect(l).toContain('受伤')
    expect(l).toContain('青冥山')
  })
  it('M-E1 原修复不回归：被流放到北境→北境、失踪→下落不明、已回到青云宗→人在青云宗', () => {
    expect(placeLine('被流放到北境')).toContain('北境')
    expect(placeLine('失踪')).toContain('下落不明')
    expect(placeLine('已回到青云宗')).toContain('人在青云宗')
  })
  it('🔴B#1 总开关：inferred 经 normalizeState 往返不丢（normDimObj 白名单保留），往返后三症状仍治住', () => {
    const st0 = applyStateChange(normalizeState(null), { dimKey: 'place', state: '前往昆仑', since: 5 }, 5)
    expect(st0.place.inferred).toBe(true)
    const st1 = normalizeState(st0) // 模拟一次读/写库往返（normalizeAsset/useBooks 都过 normalizeState→normDimObj）
    expect(st1.place.inferred).toBe(true) // 此前被 normDimObj 剥离 → B#1 持久化后失效
    expect(normalizeState(st1).place.inferred).toBe(true) // 二次往返仍不丢
    expect(stateToPromptLine({ type: 'person', state: st1 })).not.toContain('人在')
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: st1 }).links.filter((l) => l.type === 'located_in')).toHaveLength(0)
    // 对照：真地名第一路往返后 inferred 应 falsy、仍建 located_in
    const real = normalizeState(applyStateChange(normalizeState(null), { dimKey: 'place', state: '在青冥山', since: 5 }, 5))
    expect(real.place.inferred).toBeFalsy()
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: real }).links.filter((l) => l.type === 'located_in')).toHaveLength(1)
  })
})

describe('第三轮 决策4：损毁/丢失/消耗领头 + 保留其余维度', () => {
  it('item broken+place+hold → 「已损毁」领头且保留位置/持有（不再 early-return 丢维度）', () => {
    const st = normalizeState({ v: 2, phys: { tag: 'broken', note: '剑身断裂' }, place: { tag: 'at', ref: '藏剑阁' }, hold: [{ name: '剑谱', change: 'gain' }] })
    const l = stateToPromptLine({ type: 'item', state: st })
    expect(l).toContain('已损毁')
    expect(l).toContain('藏剑阁')
    expect(l).toContain('剑谱')
    expect(l.indexOf('已损毁')).toBeLessThan(l.indexOf('藏剑阁')) // 损毁领头
  })
  it('L#6 person phys=broken 不走 item 前导（渲染「损毁」而非「已损毁，不可再用」）', () => {
    const l = stateToPromptLine({ type: 'person', state: { v: 2, phys: { tag: 'broken' } } })
    expect(l).toContain('损毁')
    expect(l).not.toContain('不可再用')
  })
})

describe('第三轮 决策1：严格匹配专属用例（子串不误配，恢复双向 includes 才会误命中）', () => {
  const roster = [normalizeAsset({ id: 'i1', name: '玄铁令', type: 'item' }), normalizeAsset({ id: 'i2', name: '宝剑', type: 'item' })]
  it('「铁令」↛「玄铁令」', () => {
    expect(findAssetByName(roster, '铁令')).toBeNull()
  })
  it('单字「剑」↛「宝剑」', () => {
    expect(findAssetByName(roster, '剑')).toBeNull()
  })
  it('精确「玄铁令」命中', () => {
    expect((findAssetByName(roster, '玄铁令') || {}).id).toBe('i1')
  })
})

describe('第七轮 inferred 生命周期闭合 + M3 降级（补二次更新用例）', () => {
  it('M1 二次位置更新（推定→确定）清 inferred、恢复「人在」+ located_in', () => {
    let st = applyStateChange(normalizeState(null), { dimKey: 'place', state: '前往昆仑', since: 5 }, 5)
    expect(st.place.inferred).toBe(true)
    st = applyStateChange(st, { dimKey: 'place', state: '在青冥山', since: 6 }, 6)
    expect(st.place.inferred).toBeFalsy() // 旧 inferred 已清（此前只加不清 → 残留）
    expect(st.place.tag).toBe('at')
    expect(st.place.ref).toBe('青冥山')
    expect(stateToPromptLine({ type: 'person', state: st })).toContain('人在青冥山')
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: st }).links.filter((l) => l.type === 'located_in')).toHaveLength(1)
  })
  it('C1根 第三路不继承旧 tag（被囚于天牢→前往昆仑 不出「被囚于前往昆仑」）', () => {
    let st = applyStateChange(normalizeState(null), { dimKey: 'place', state: '被囚于天牢', since: 5 }, 5)
    expect(st.place.tag).toBe('imprisoned')
    st = applyStateChange(st, { dimKey: 'place', state: '前往昆仑', since: 6 }, 6)
    expect(st.place.inferred).toBe(true)
    expect(st.place.tag).toBeFalsy() // 不继承 imprisoned
    const l = stateToPromptLine({ type: 'person', state: st })
    expect(l).toContain('前往昆仑')
    expect(l).not.toContain('被囚于前往昆仑')
  })
  it('M2 inferred 地点的手建 located_in 边经 normalizeAsset 不被删', () => {
    const a = normalizeAsset({ id: 'p1', name: '陆沉', type: 'person', state: { v: 2, place: { tag: 'at', ref: '青冥山', inferred: true } }, links: [{ type: 'located_in', to: '青冥山' }] })
    expect(a.links.filter((l) => l.type === 'located_in')).toHaveLength(1)
  })
  it('M3 决策4 长 note 降级① 保留其余维度（lead 按 withNote=false 重算）', () => {
    const longNote = '这是一段非常长的损毁说明文字用来撑满四十字以上以触发超长降级路径看看会不会把后面的位置与持有信息整段砍掉'
    const st = normalizeState({ v: 2, phys: { tag: 'broken', note: longNote }, place: { tag: 'at', ref: '藏剑阁' }, hold: [{ name: '残卷', change: 'gain' }] })
    const l = stateToPromptLine({ type: 'item', state: st })
    expect(l).toContain('已损毁')
    expect(l).toContain('藏剑阁') // 位置保留（此前被 cutTail 整段砍）
    expect(l).toContain('残卷') // 持有保留
    expect(l).not.toContain(longNote) // 长 note 被降级①砍掉
  })
  it('审计轮6 冲突1回归：推定→纯状态词（失踪）沿用 inferred，不出「人在前往昆仑」/垃圾边（防第七轮"无条件 delete inferred"被改回）', () => {
    let st = applyStateChange(normalizeState(null), { dimKey: 'place', state: '前往昆仑', since: 5 }, 5)
    expect(st.place.inferred).toBe(true)
    st = applyStateChange(st, { dimKey: 'place', state: '失踪', since: 6 }, 6) // 纯状态词、ref='' 继承推定短语
    expect(st.place.inferred).toBe(true) // 沿用旧 inferred（第七轮曾无条件 delete → 复活语病）
    expect(st.place.ref).toBe('前往昆仑')
    const l = stateToPromptLine({ type: 'person', state: st })
    expect(l).not.toContain('人在前往昆仑') // 不复活语病
    expect(rebuildDerivedEdges({ id: 'p', name: '陆沉', type: 'person', state: st }).links.filter((x) => x.type === 'located_in')).toHaveLength(0) // 不建垃圾 located_in
  })
})
