import { describe, it, expect } from 'vitest'
import { rrfFuse, hybridRerank, setMemoryEntry, removeMemoryEntry, applyPolishResults } from '../longform.js'
import { polishChapterMessages } from '../prompts.js'

describe('rrfFuse：检索混合重排（Reciprocal Rank Fusion）', () => {
  const d = (chapterNo, text) => ({ chapterNo, text })
  it('两路都命中的文档排名被提升（融合分最高）', () => {
    const list1 = [d(1, 'AAA'), d(2, 'BBB')]
    const list2 = [d(2, 'BBB'), d(3, 'CCC')]
    const fused = rrfFuse([list1, list2])
    expect(fused[0].text).toBe('BBB') // 两路都命中 → 排第一
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore)
    expect(fused.map((x) => x.text)).toEqual(['BBB', 'AAA', 'CCC'])
  })
  it('按 key 去重（同章同前缀视为同一文档）', () => {
    const fused = rrfFuse([[d(1, 'same text')], [d(1, 'same text')]])
    expect(fused.length).toBe(1)
  })
  it('k 参数影响融合分；空输入返回空', () => {
    expect(rrfFuse([])).toEqual([])
    expect(rrfFuse([[], []])).toEqual([])
    const a = rrfFuse([[d(1, 'x')]], { k: 0 })[0].rrfScore
    const b = rrfFuse([[d(1, 'x')]], { k: 60 })[0].rrfScore
    expect(a).toBeGreaterThan(b)
  })
})

describe('hybridRerank：关键词 + 语义两路融合入口', () => {
  const d = (chapterNo, text) => ({ chapterNo, text })
  it('两路都空 → []', () => {
    expect(hybridRerank([], [])).toEqual([])
    expect(hybridRerank(null, undefined)).toEqual([])
  })
  it('仅一路有命中 → 退化为该路排序', () => {
    const out = hybridRerank([d(1, 'kw1'), d(2, 'kw2')], [])
    expect(out.map((x) => x.text)).toEqual(['kw1', 'kw2'])
  })
  it('topN 截断', () => {
    const kw = [d(1, 'a'), d(2, 'b'), d(3, 'c')]
    expect(hybridRerank(kw, [], { topN: 2 }).length).toBe(2)
  })
})

describe('setMemoryEntry / removeMemoryEntry：记忆可编辑', () => {
  const mk = () => ({ id: 'bk', memory: [{ text: '卷一', upTo: 20 }, { text: '卷二', upTo: 40 }] })
  it('编辑指定卷志文本，其余不动', () => {
    const next = setMemoryEntry(mk(), 0, { text: '卷一·修订' })
    expect(next.memory[0].text).toBe('卷一·修订')
    expect(next.memory[1].text).toBe('卷二')
    expect(next.memory.length).toBe(2)
  })
  it('删除指定卷志', () => {
    const next = removeMemoryEntry(mk(), 0)
    expect(next.memory.length).toBe(1)
    expect(next.memory[0].text).toBe('卷二')
  })
  it('idx 越界 / 无 memory → 原样返回（同一引用，零副作用）', () => {
    const p = mk()
    expect(setMemoryEntry(p, 9, { text: 'x' })).toBe(p)
    expect(removeMemoryEntry(p, -1)).toBe(p)
    const empty = { id: 'x' }
    expect(setMemoryEntry(empty, 0, { text: 'x' })).toBe(empty)
    expect(removeMemoryEntry(empty, 0)).toBe(empty)
  })
})

describe('applyPolishResults：采用全书润色结果', () => {
  const mk = () => ({
    id: 'bk',
    chapters: [
      { chapterNo: 1, content: '旧正文一', refs: { chars: ['a1'] }, chunkEmbed: { sig: 'x', vecs: [1] } },
      { chapterNo: 2, content: '旧正文二', refs: { chars: ['a2'] } },
    ],
  })
  it('替换 changed 章节正文，并清除陈旧 refs/chunkEmbed 索引', () => {
    const results = [
      { chapterNo: 1, polished: '润色正文一', changed: true },
      { chapterNo: 2, polished: '润色正文二', changed: false },
    ]
    const next = applyPolishResults(mk(), results)
    const c1 = next.chapters.find((c) => c.chapterNo === 1)
    const c2 = next.chapters.find((c) => c.chapterNo === 2)
    expect(c1.content).toBe('润色正文一')
    expect(c1.refs).toBeUndefined()
    expect(c1.chunkEmbed).toBeUndefined()
    expect(c2.content).toBe('旧正文二') // changed=false → 不动
    expect(c2.refs).toEqual({ chars: ['a2'] })
  })
  it('无任何 changed → 原样返回（同一引用）', () => {
    const p = mk()
    expect(applyPolishResults(p, [{ chapterNo: 1, polished: 'x', changed: false }])).toBe(p)
    expect(applyPolishResults(p, [])).toBe(p)
  })
})

describe('polishChapterMessages：全书润色终 pass prompt', () => {
  it('产出 system+user 两条消息，system 含终稿润色协议、user 含前后文与正文', () => {
    const msgs = polishChapterMessages({ text: '本章正文', before: '上一章结尾', after: '下一章开头', setting: '都市悬疑' })
    expect(msgs.length).toBe(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('终稿润色')
    expect(msgs[0].content).toContain('polished_text')
    expect(msgs[1].content).toContain('本章正文')
    expect(msgs[1].content).toContain('上一章结尾')
    expect(msgs[1].content).toContain('都市悬疑')
  })
  it('无前文时给出占位，不报错', () => {
    const msgs = polishChapterMessages({ text: '开篇正文' })
    expect(msgs[1].content).toContain('开篇')
  })
})
