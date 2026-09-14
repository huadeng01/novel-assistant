// 世界观库单测：八字段单一事实源、两档注入拼装、旧数据降级、内置模板字数校准
// 只测纯函数与静态数据，不碰 UI；localStorage 用 stubGlobal 造一个内存版（readLS 内部有 try/catch，
// node 环境下不 stub 时会静默降级为「无覆盖数据」，所以测降级路径必须显式 stub）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BUILTIN_WORLDVIEWS,
  WORLDVIEW_FIELDS,
  EMPTY_WORLDVIEW,
  allGenres,
  getWorldview,
  isOverridden,
  saveWorldview,
  resetWorldview,
  worldviewText,
  worldviewTropeBlock,
} from '../worldviews/index.js'

// 与 WorldviewEditor 完全同口径的字数（该组件用 String(wv[key] || '').trim().length 显示实时字数）
const len = (s) => String(s || '').trim().length

const KEYS = ['world', 'power', 'factions', 'geography', 'taboo', 'tropes', 'antiTropes', 'motifs']

// 内存版 localStorage：只实现世界观库用到的三个方法
const makeLS = (init = {}) => {
  const store = { ...init }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    _store: store,
  }
}

describe('WORLDVIEW_FIELDS 单一事实源', () => {
  it('恰好八字段，顺序与 key 与约定一致', () => {
    expect(WORLDVIEW_FIELDS.map((f) => f.key)).toEqual(KEYS)
  })

  it('每字段都带编辑器与拼装需要的完整配置', () => {
    for (const f of WORLDVIEW_FIELDS) {
      expect(f.label, `${f.key}.label`).toBeTruthy()
      expect(f.placeholder, `${f.key}.placeholder`).toBeTruthy()
      expect(f.rows, `${f.key}.rows`).toBeGreaterThan(0)
      // min/max 是「只提示不阻断」的参考区间，但必须自洽，否则编辑器的琥珀色提示会永久亮着
      expect(f.max, `${f.key}.max`).toBeGreaterThan(f.min)
    }
  })

  it('EMPTY_WORLDVIEW 覆盖全部八字段且均为空串', () => {
    expect(Object.keys(EMPTY_WORLDVIEW).sort()).toEqual([...KEYS].sort())
    for (const k of KEYS) expect(EMPTY_WORLDVIEW[k]).toBe('')
  })
})

describe('worldviewText 两档注入', () => {
  const wv = {
    world: '九州分三层，凡人居下，修士居中，仙门在上。灵石是唯一硬通货。',
    power: '炼气、筑基、金丹、元婴四阶，每阶九重，突破需渡劫。',
    factions: '宗门、世家、散修盟、朝廷钦天监四方对峙。',
    geography: '开局在青阳县城，中期入东玄州，终局登天阙。',
    taboo: '夺舍者遭天谴，寿元折半。',
    tropes: '废柴觉醒、退婚打脸、系统签到。',
    antiTropes: '主角是规则的维护者而非破坏者。',
    motifs: '丹炉、飞剑、坊市、雷劫云。',
  }

  it('brief 档只拼世界架构 + 力量体系 + 意象词库', () => {
    const t = worldviewText(wv, 'brief')
    expect(t).toContain('世界架构：')
    expect(t).toContain('力量体系：')
    expect(t).toContain('意象与专名词库：')
    // 势力/地理/禁忌/套路四维不进 brief 档——灵感选题只需要低权重参考，塞满八维会把模型往模板上钉死
    for (const label of ['势力格局', '地理与舞台分层', '禁忌与代价', '高频套路清单', '反套路切口']) {
      expect(t, `brief 不应含 ${label}`).not.toContain(label)
    }
  })

  it('默认档位就是 brief（调用方漏传 level 时不膨胀）', () => {
    expect(worldviewText(wv)).toBe(worldviewText(wv, 'brief'))
  })

  it('full 档八字段带小标题全拼，且顺序与 WORLDVIEW_FIELDS 一致', () => {
    const t = worldviewText(wv, 'full')
    for (const f of WORLDVIEW_FIELDS) expect(t, `full 应含 ${f.label}`).toContain(`${f.label}：`)
    const idx = WORLDVIEW_FIELDS.map((f) => t.indexOf(`${f.label}：`))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('空字段整块跳过，不输出空标题', () => {
    const t = worldviewText({ world: '只填了世界架构。', power: '', motifs: '  ' }, 'full')
    expect(t).toBe('世界架构：只填了世界架构。')
    expect(t).not.toContain('力量体系')
  })

  it('旧两字段数据在 full 档下的输出等同于 brief 档（零回归）', () => {
    const legacy = { world: '一个大陆。', power: '三阶体系。' }
    expect(worldviewText(legacy, 'full')).toBe(worldviewText(legacy, 'brief'))
  })

  it('空世界观与 null 都返回占位串而不是抛异常', () => {
    expect(worldviewText(null)).toBe('（暂无世界模板）')
    expect(worldviewText({})).toBe('（暂无世界模板）')
    expect(worldviewText({ world: '   ' }, 'full')).toBe('（暂无世界模板）')
  })

  it('brief 档体量显著小于 full 档（维持低权重参考定位）', () => {
    const g = getWorldview('玄幻')
    expect(len(worldviewText(g, 'brief'))).toBeLessThan(len(worldviewText(g, 'full')))
  })
})

describe('worldviewTropeBlock 套路对照块', () => {
  it('两字段都空时返回空串，调用方据此降级回原有措辞', () => {
    expect(worldviewTropeBlock(null)).toBe('')
    expect(worldviewTropeBlock({})).toBe('')
    expect(worldviewTropeBlock({ tropes: '  ', antiTropes: '' })).toBe('')
  })

  it('只填 tropes 时输出规避清单、不输出切口标题', () => {
    const t = worldviewTropeBlock({ tropes: '废柴觉醒、退婚打脸。' })
    expect(t).toContain('废柴觉醒、退婚打脸。')
    expect(t).toContain('一个都不得出现')
    expect(t).not.toContain('反套路切口')
  })

  it('两字段都填时规避清单在前、切口在后', () => {
    const t = worldviewTropeBlock({ tropes: 'AAA', antiTropes: 'BBB' })
    expect(t.indexOf('AAA')).toBeLessThan(t.indexOf('BBB'))
    expect(t).toContain('本批选题须分头落在这些方向上')
  })
})

describe('getWorldview 旧数据降级', () => {
  let ls
  beforeEach(() => {
    ls = makeLS()
    vi.stubGlobal('localStorage', ls)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('无覆盖数据时返回内置模板，八字段齐备', () => {
    const wv = getWorldview('仙侠')
    expect(wv).not.toBeNull()
    expect(Object.keys(wv).sort()).toEqual([...KEYS].sort())
    for (const k of KEYS) expect(len(wv[k]), `仙侠.${k} 应非空`).toBeGreaterThan(0)
  })

  it('旧版 localStorage 只有 world/power 两字段时，其余六字段降级为空串且不丢已存内容', () => {
    // 这是改造前落库的真实形态：{ world, power }。以 EMPTY_WORLDVIEW 打底展开，缺的字段补空串，
    // 编辑器显示为可补填的空框，拼装注入时按空跳过——不报错、不丢用户数据。
    saveWorldview('玄幻', { world: '我自己改的世界架构。', power: '我自己改的力量体系。' })
    const wv = getWorldview('玄幻')
    expect(wv.world).toBe('我自己改的世界架构。')
    expect(wv.power).toBe('我自己改的力量体系。')
    for (const k of ['factions', 'geography', 'taboo', 'tropes', 'antiTropes', 'motifs']) {
      expect(wv[k], `旧数据降级后 ${k} 应为空串`).toBe('')
    }
  })

  it('用户覆盖优先于内置模板，isOverridden 同步为真', () => {
    expect(isOverridden('都市')).toBe(false)
    saveWorldview('都市', { ...getWorldview('都市'), world: '覆盖后的世界。' })
    expect(isOverridden('都市')).toBe(true)
    expect(getWorldview('都市').world).toBe('覆盖后的世界。')
  })

  it('恢复内置模板后回到内置内容', () => {
    const before = getWorldview('科幻').world
    saveWorldview('科幻', { world: '临时覆盖。' })
    expect(getWorldview('科幻').world).toBe('临时覆盖。')
    resetWorldview('科幻')
    expect(isOverridden('科幻')).toBe(false)
    expect(getWorldview('科幻').world).toBe(before)
  })

  it('自定义新题材出现在 allGenres 尾部，内置题材不重复', () => {
    const base = allGenres()
    saveWorldview('蒸汽朋克', { ...EMPTY_WORLDVIEW, world: '自定义题材。' })
    const after = allGenres()
    expect(after).toEqual([...base, '蒸汽朋克'])
    expect(new Set(after).size).toBe(after.length)
  })

  it('未知题材返回 null（调用方据此显示「暂无世界模板」）', () => {
    expect(getWorldview('不存在的题材')).toBeNull()
  })

  it('localStorage 里存了坏 JSON 也不抛异常，降级为无覆盖', () => {
    ls.setItem('na_worldview_overrides', '{ 这不是 JSON')
    expect(getWorldview('玄幻')).not.toBeNull()
    expect(isOverridden('玄幻')).toBe(false)
  })
})

describe('20 个内置题材模板的内容校准', () => {
  const genres = Object.keys(BUILTIN_WORLDVIEWS)

  it('恰好 20 个题材', () => {
    expect(genres).toHaveLength(20)
  })

  it('每个题材八字段齐全且都非空', () => {
    for (const g of genres) {
      const wv = BUILTIN_WORLDVIEWS[g]
      for (const k of KEYS) expect(len(wv[k]), `${g}.${k} 应非空`).toBeGreaterThan(0)
    }
  })

  it('每个题材每个字段的字数都落在 WORLDVIEW_FIELDS 声明的区间内', () => {
    // 这条同时守住两件事：内容没有被截断/清空，以及 min/max 区间没有和实际内容漂移。
    // 区间是给编辑器的「参考提示」，内置模板必须自己先达标，否则用户照模板改反而被判为越界。
    const bad = []
    for (const g of genres) {
      for (const f of WORLDVIEW_FIELDS) {
        const n = len(BUILTIN_WORLDVIEWS[g][f.key])
        if (n < f.min || n > f.max) bad.push(`${g}.${f.key}=${n}（应 ${f.min}~${f.max}）`)
      }
    }
    expect(bad, `字数越界的字段：${bad.join('；')}`).toEqual([])
  })

  it('单题材全文（full 档）体量在 850~1700 字之间', () => {
    for (const g of genres) {
      const n = len(worldviewText(BUILTIN_WORLDVIEWS[g], 'full'))
      expect(n, `${g} full 档字数 ${n}`).toBeGreaterThanOrEqual(850)
      expect(n, `${g} full 档字数 ${n}`).toBeLessThanOrEqual(1700)
    }
  })

  it('tropes 与 antiTropes 不是同一段文本（否则「照单规避」失去意义）', () => {
    for (const g of genres) {
      const wv = BUILTIN_WORLDVIEWS[g]
      expect(wv.tropes, `${g} tropes/antiTropes 重复`).not.toBe(wv.antiTropes)
    }
  })

  it('motifs 是顿号分隔的词库而不是整句叙述', () => {
    for (const g of genres) {
      const m = BUILTIN_WORLDVIEWS[g].motifs
      expect(m, `${g} motifs 应以顿号分隔`).toContain('、')
      // 词库里不该出现句末标点，出现了说明写成了句子
      expect(m, `${g} motifs 混入了句子`).not.toMatch(/[。！？]/)
    }
  })
})
