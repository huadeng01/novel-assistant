import { describe, it, expect } from 'vitest'
import {
  buildEntityIndex,
  worldEntities,
  temporalGate,
  absenceGate,
  appearanceGate,
  worldGateAll,
} from '../worldgate.js'

function makeProject(over = {}) {
  const characters = [
    { uid: 'a1', name: '林昭', aliases: ['阿昭'], alive: 'alive' },
    { uid: 'a2', name: '老周', aliases: [], alive: 'dead' },
    { uid: 'a3', name: '张三', aliases: [], alive: 'alive', departedAt: 5 },
  ]
  const bible = {
    factions: [{ id: 'f1', name: '洗髓阁', aliases: ['阁中'], firstAppearance: 4 }],
    places: [{ id: 'p1', name: '断魂崖', aliases: [], firstAppearance: 6 }],
    secrets: [],
  }
  return { id: 'bk', characters, bible, chapters: [], ...over }
}

describe('buildEntityIndex / worldEntities：地点·势力升一等实体', () => {
  it('合并 characters + factions + places，可被 matchEntities 命中', () => {
    const { entities, byUid } = buildEntityIndex(makeProject())
    const kinds = entities.map((e) => e.kind).sort()
    expect(kinds).toEqual(['character', 'character', 'character', 'faction', 'place'])
    expect(byUid.get('f1').name).toBe('洗髓阁')
    expect(byUid.get('p1').name).toBe('断魂崖')
  })
  it('势力/地点无 id 时用稳定合成键 kind:name', () => {
    const p = makeProject({ bible: { factions: [{ name: '黑风寨' }], places: [{ name: '落霞镇' }] } })
    const { byUid } = buildEntityIndex(p)
    expect(byUid.has('faction:黑风寨')).toBe(true)
    expect(byUid.has('place:落霞镇')).toBe(true)
  })
  it('worldEntities 只返回非人物实体', () => {
    const list = worldEntities(makeProject())
    expect(list.length).toBe(2)
    expect(list.every((e) => e.kind !== 'character')).toBe(true)
  })
  it('bible 为 null / 空项目不报错', () => {
    expect(buildEntityIndex({}).entities).toEqual([])
    expect(buildEntityIndex({ bible: null, characters: null }).entities).toEqual([])
  })
})

describe('temporalGate：时序门（提前登场）', () => {
  it('实体在登记首登场章之前出现 → warning', () => {
    const { warnings } = temporalGate(makeProject(), 2, '众人来到断魂崖下。')
    expect(warnings.length).toBe(1)
    expect(warnings[0].name).toBe('断魂崖')
    expect(warnings[0].kind).toContain('时序门')
    expect(warnings[0].firstAppearance).toBe(6)
  })
  it('达到/超过首登场章 → 不报', () => {
    expect(temporalGate(makeProject(), 6, '众人来到断魂崖下。').warnings).toEqual([])
    expect(temporalGate(makeProject(), 9, '洗髓阁的大门开启。').warnings).toEqual([])
  })
  it('势力也受时序门约束', () => {
    const { warnings } = temporalGate(makeProject(), 1, '洗髓阁派人前来。')
    expect(warnings.some((w) => w.name === '洗髓阁')).toBe(true)
  })
  it('空文本 / 无 chapterNo / 无 firstAppearance → 不报', () => {
    expect(temporalGate(makeProject(), 0, '断魂崖').warnings).toEqual([])
    expect(temporalGate(makeProject(), 2, '').warnings).toEqual([])
  })
})

describe('absenceGate：缺席门（死者/离场者现身活动）', () => {
  it('已死亡角色在现场做动作 → blocker', () => {
    const { blockers } = absenceGate(makeProject(), 8, '老周走进大厅，抬手一挥。')
    expect(blockers.length).toBe(1)
    expect(blockers[0].uid).toBe('a2')
    expect(blockers[0].category).toBe('物理不可能')
  })
  it('已离场角色（departedAt≤本章）现身活动 → blocker', () => {
    const { blockers } = absenceGate(makeProject(), 7, '张三跑过来拦住去路。')
    expect(blockers.length).toBe(1)
    expect(blockers[0].uid).toBe('a3')
    expect(blockers[0].category).toBe('连续性矛盾')
  })
  it('离场章之前出现 → 不报', () => {
    expect(absenceGate(makeProject(), 3, '张三跑过来。').blockers).toEqual([])
  })
  it('闪回/回忆语境 → 降级放行', () => {
    const { blockers } = absenceGate(makeProject(), 8, '他想起老周，当年老周走进大厅的情景历历在目。')
    expect(blockers.length).toBe(0)
  })
  it('只提到名字、没在现场活动 → 放行', () => {
    expect(absenceGate(makeProject(), 8, '老周这个名字，如今再无人提起。').blockers).toEqual([])
  })
  it('同一角色多处命中只报一次', () => {
    const { blockers } = absenceGate(makeProject(), 8, '老周走进来，老周又走出去。')
    expect(blockers.length).toBe(1)
  })
})

describe('appearanceGate：外貌一致性', () => {
  const withLook = (value) =>
    makeProject({ characters: [{ uid: 'a1', name: '林昭', aliases: [], alive: 'alive', appearance: [{ trait: '发色', value }] }] })

  it('正文发色与登记不符（角色名附近）→ warning', () => {
    const { warnings } = appearanceGate(withLook('黑'), 3, '林昭的白发在风中飘动。')
    expect(warnings.length).toBe(1)
    expect(warnings[0].trait).toBe('发色')
    expect(warnings[0].canonical).toBe('黑')
    expect(warnings[0].found).toBe('白')
  })
  it('发色一致 → 不报', () => {
    expect(appearanceGate(withLook('黑'), 3, '林昭的黑发在风中飘动。').warnings).toEqual([])
  })
  it('瞳色矛盾同样检出', () => {
    const p = makeProject({ characters: [{ uid: 'a1', name: '林昭', aliases: [], appearance: [{ trait: '瞳色', value: '黑' }] }] })
    const { warnings } = appearanceGate(p, 3, '林昭那双灰瞳盯着远方。')
    expect(warnings.some((w) => w.trait === '瞳色' && w.found === '灰')).toBe(true)
  })
  it('矛盾描写离该角色很远（>40字）→ 不误报到该角色', () => {
    const far = '林昭站在门口。' + '外面下着瓢泼大雨，整条长街空无一人，只有雨点敲打青石板的声音连绵不绝。' + '那白发老者缓缓走来。'
    expect(appearanceGate(withLook('黑'), 3, far).warnings).toEqual([])
  })
  it('未登记 appearance / 空文本 → 不报', () => {
    expect(appearanceGate(makeProject(), 3, '林昭的白发飘动。').warnings).toEqual([])
    expect(appearanceGate(withLook('黑'), 3, '').warnings).toEqual([])
  })
})

describe('worldGateAll：三门聚合', () => {
  it('同时聚合缺席 blocker 与时序/外貌 warning', () => {
    const p = makeProject({
      characters: [
        { uid: 'a1', name: '林昭', aliases: [], alive: 'alive', appearance: [{ trait: '发色', value: '黑' }] },
        { uid: 'a2', name: '老周', aliases: [], alive: 'dead' },
      ],
      bible: { places: [{ id: 'p1', name: '断魂崖', firstAppearance: 6 }], factions: [], secrets: [] },
    })
    const { blockers, warnings } = worldGateAll(p, 8, '老周走进大厅。林昭的白发飘动。众人提到断魂崖。')
    expect(blockers.some((b) => b.uid === 'a2')).toBe(true)
    expect(warnings.some((w) => w.kind === '外貌一致性')).toBe(true)
  })
  it('空项目 → 空结果', () => {
    const { blockers, warnings } = worldGateAll({}, 1, '任意文本')
    expect(blockers).toEqual([])
    expect(warnings).toEqual([])
  })
})
