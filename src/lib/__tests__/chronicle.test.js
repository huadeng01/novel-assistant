import { describe, it, expect } from 'vitest'
import { chunkText, normalizeChronicle, mergeChronicle, pickChronicleForPrompt, chronicleToText, CHRONICLE_CHUNK } from '../chronicle.js'

describe('chunkText 分段', () => {
  it('按块大小切分且覆盖全文不丢字', () => {
    const src = '甲'.repeat(CHRONICLE_CHUNK * 2 + 123)
    const chunks = chunkText(src)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe(src)
  })
  it('不在 UTF-16 代理对中间切断', () => {
    const src = 'a'.repeat(CHRONICLE_CHUNK - 1) + '𠮷' + 'b'.repeat(10)
    const chunks = chunkText(src)
    expect(chunks.join('')).toBe(src)
    chunks.forEach((c) => {
      const code = c.charCodeAt(c.length - 1)
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false)
    })
  })
  it('空原文返回空数组', () => {
    expect(chunkText('')).toEqual([])
  })
})

describe('normalizeChronicle 归一与旧时间线迁移', () => {
  it('字段强制字符串、全空条目丢弃', () => {
    const out = normalizeChronicle([{ chapter: ' 12 ', time: ' 第三年春 ', event: ' 主角入门 ' }, { time: '', event: '' }, null, { time: 5, event: 'x' }])
    expect(out).toEqual([
      { chapter: '12', time: '第三年春', event: '主角入门' },
      { chapter: '', time: '5', event: 'x' },
    ])
  })
  it('旧版 stage/summary 时间线迁移为账本条目', () => {
    const out = normalizeChronicle([{ stage: '开篇', summary: '主角入门' }, { summary: '只有一句' }])
    expect(out).toEqual([
      { chapter: '', time: '', event: '开篇：主角入门' },
      { chapter: '', time: '', event: '只有一句' },
    ])
  })
})

describe('mergeChronicle 段序拼接与跨段去重', () => {
  it('按段序拼接', () => {
    const out = mergeChronicle([[{ time: '春', event: '甲' }], [{ time: '', event: '乙' }]])
    expect(out.map((t) => t.event)).toEqual(['甲', '乙'])
  })
  it('跨段重复事件只留第一条', () => {
    const out = mergeChronicle([[{ time: '春', event: '主角 入门' }], [{ time: '', event: '主角入门' }, { time: '夏', event: '下山' }]])
    expect(out).toHaveLength(2)
    expect(out[0].time).toBe('春')
  })
})

describe('pickChronicleForPrompt 注入截取', () => {
  it('短账本原样返回', () => {
    const list = Array.from({ length: 5 }, (_, i) => ({ time: '', event: `e${i}` }))
    expect(pickChronicleForPrompt(list)).toHaveLength(5)
  })
  it('长账本取首条加末 40 条', () => {
    const list = Array.from({ length: 100 }, (_, i) => ({ time: '', event: `e${i}` }))
    const picked = pickChronicleForPrompt(list)
    expect(picked).toHaveLength(41)
    expect(picked[0].event).toBe('e0')
    expect(picked[40].event).toBe('e99')
  })
})

describe('chronicleToText 注入格式', () => {
  it('有时间带方括号、无时间直接写事件', () => {
    expect(chronicleToText([{ time: '第三年春', event: '主角入门' }, { time: '', event: '下山' }])).toBe('1. 【第三年春】主角入门\n2. 下山')
  })
  it('有章号时带第N章前缀', () => {
    expect(chronicleToText([{ chapter: '12', time: '春', event: '入门' }])).toBe('1. 第12章【春】入门')
  })
})
