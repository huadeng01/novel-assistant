import { describe, it, expect } from 'vitest'
import {
  GENDERS,
  normalizeGender,
  gendersOf,
  listsByGender,
  normalizeRanks,
  ranksSummary,
  generatedLabel,
} from '../ranks.js'

// fixture：贴近真实产物（番茄=男频/女频混合，塔读=全部，书旗=男女频分组）
function src(platform, lists, over = {}) {
  return { platform, platformName: platform, ok: true, lists, ...over }
}
function list(listId, gender, n = 2) {
  return {
    listId,
    listName: listId,
    gender,
    category: '全部',
    books: Array.from({ length: n }, (_, i) => ({ rank: i + 1, title: `书${i + 1}`, author: `作者${i + 1}` })),
  }
}

describe('normalizeGender：频道归一化', () => {
  it('只认男频 / 女频', () => {
    expect(normalizeGender('男频')).toBe('男频')
    expect(normalizeGender('女频')).toBe('女频')
  })
  it('空值 / 全部 / 未知一律收敛为「全部」', () => {
    for (const g of ['', null, undefined, '全部', 'male', '未知', 0]) expect(normalizeGender(g)).toBe('全部')
  })
  it('去除首尾空白后再判定', () => {
    expect(normalizeGender('  男频 ')).toBe('男频')
  })
})

describe('gendersOf：平台实际出现过的频道', () => {
  it('男女频混合 → 全部 / 男频 / 女频', () => {
    expect(gendersOf(src('fq', [list('a', '男频'), list('b', '女频')]))).toEqual(['全部', '男频', '女频'])
  })
  it('只有男频 → 全部 / 男频', () => {
    expect(gendersOf(src('z', [list('a', '男频')]))).toEqual(['全部', '男频'])
  })
  it('全是「全部」→ 单元素（UI 据此隐藏过滤条）', () => {
    expect(gendersOf(src('t', [list('a', '全部'), list('b', '')]))).toEqual(['全部'])
  })
  it('null 安全', () => {
    expect(gendersOf(null)).toEqual(['全部'])
    expect(gendersOf({})).toEqual(['全部'])
  })
})

describe('listsByGender：按频道过滤榜单', () => {
  const s = src('fq', [list('m', '男频'), list('f', '女频'), list('a', '全部')])
  it('全部 → 返回所有榜', () => {
    expect(listsByGender(s, '全部').map((l) => l.listId)).toEqual(['m', 'f', 'a'])
  })
  it('男频 → 男频 + 未标频道（全部）', () => {
    expect(listsByGender(s, '男频').map((l) => l.listId)).toEqual(['m', 'a'])
  })
  it('女频 → 女频 + 全部', () => {
    expect(listsByGender(s, '女频').map((l) => l.listId)).toEqual(['f', 'a'])
  })
  it('缺省 gender 视为全部', () => {
    expect(listsByGender(s).map((l) => l.listId)).toEqual(['m', 'f', 'a'])
  })
  it('null 安全', () => {
    expect(listsByGender(null, '男频')).toEqual([])
  })
})

describe('normalizeRanks：结构归一化携带 gender', () => {
  it('lists 保留 gender，books 字段兜底', () => {
    const n = normalizeRanks({
      sources: [src('fq', [{ listId: 'm', listName: '男频阅读榜', gender: '男频', books: [{ rank: 1, title: '天渊', author: '沐潇三生' }] }])],
    })
    expect(n.sources[0].lists[0].gender).toBe('男频')
    expect(n.sources[0].lists[0].books[0]).toMatchObject({ title: '天渊', author: '沐潇三生' })
  })
  it('缺失 gender 兜底为「全部」', () => {
    const n = normalizeRanks({ sources: [src('x', [{ listId: 'a', books: [] }])] })
    expect(n.sources[0].lists[0].gender).toBe('全部')
  })
  it('非对象 / 无 sources 不抛异常', () => {
    expect(normalizeRanks(null).sources).toEqual([])
    expect(normalizeRanks({}).sources).toEqual([])
  })
})

describe('ranksSummary / generatedLabel / GENDERS', () => {
  it('统计成功平台数与书目数', () => {
    const data = normalizeRanks({ sources: [src('a', [list('l', '男频', 3)]), src('b', [], { ok: false })] })
    expect(ranksSummary(data)).toMatchObject({ platformCount: 2, okCount: 1, failCount: 1, bookCount: 3 })
  })
  it('generatedLabel 优先用 generatedAtLocal', () => {
    expect(generatedLabel({ generatedAtLocal: 'X', generatedAt: '2026-01-01T00:00:00Z' })).toBe('X')
    expect(generatedLabel(null)).toBe('')
  })
  it('GENDERS 常量顺序固定', () => {
    expect(GENDERS).toEqual(['全部', '男频', '女频'])
  })
})
