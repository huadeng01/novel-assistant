import { describe, it, expect } from 'vitest'
import { composeChapterPrompt } from '../composeChapterPrompt.js'

const baseBook = (over = {}) => ({
  id: 'b1',
  title: '测试书',
  brief: '框架',
  assets: [],
  foreshadows: [],
  volumes: '',
  beats: [],
  styleProfile: '',
  styleHabits: [],
  styleSamples: [],
  ...over,
})

const call = (over = {}) =>
  composeChapterPrompt({
    book: baseBook(over.book || {}),
    chapters: over.chapters || [],
    chapterNo: over.chapterNo ?? 41,
    chapterPlan: over.chapterPlan ?? '',
    buckets: over.buckets || { allow: [], rumor: [], ban: [] },
    prevSummary: over.prevSummary || '',
    targetWords: over.targetWords || '2500',
    perVol: over.perVol ?? 40,
  })

describe('composeChapterPrompt 伏笔筛选', () => {
  const foreshadows = [
    { title: '断剑', desc: '主角捡到的断剑', plant_ch: 10, payoff_volume: 2 },
    { title: '旧恩', desc: '师父旧恩', plant_ch: 5, payoff_volume: 5 },
    { title: '已收伏笔', desc: '早已兑现', plant_ch: 1, payoff_volume: 1, state: 'resolved' },
    { title: '未埋伏笔', desc: '后面才埋', plant_ch: 0, plant_volume: 9 },
  ]
  const out = call({ book: { foreshadows } })

  it('本卷应回收的伏笔进「本卷应回收」段', () => {
    expect(out).toContain('本卷应回收的伏笔')
    expect(out).toContain('断剑')
  })
  it('已埋未回收的进「活跃伏笔」段', () => {
    expect(out).toContain('仍在埋设/延续中的活跃伏笔')
    expect(out).toContain('旧恩')
  })
  it('已回收(resolved)与未埋设的伏笔都不注入', () => {
    expect(out).not.toContain('已收伏笔')
    expect(out).not.toContain('未埋伏笔')
  })
})

describe('composeChapterPrompt 资产点名匹配', () => {
  const asset = { name: '陆沉', type: 'person', detail: '剑修' }
  it('节拍点名带书名号也能匹配到资产（normName 容错）', () => {
    const out = call({
      book: { assets: [asset], beats: [{ chapter_no: 41, reveal_assets: '《陆沉》', cast: [] }] },
      buckets: { allow: [asset], rumor: [], ban: [] },
      chapterPlan: '41｜剑试',
    })
    expect(out).toContain('陆沉(person)')
  })
  it('点名全不匹配时回退「章纲原文出现资产名」判据', () => {
    const out = call({
      book: { assets: [asset], beats: [{ chapter_no: 41, reveal_assets: '查无此人', cast: [] }] },
      buckets: { allow: [asset], rumor: [], ban: [] },
      chapterPlan: '41｜陆沉夜探昆仑',
    })
    expect(out).toContain('陆沉(person)')
  })
  it('ban 桶资产不被注入点名段', () => {
    const out = call({
      book: { assets: [asset] },
      buckets: { allow: [], rumor: [], ban: [asset] },
      chapterPlan: '41｜陆沉夜探昆仑',
    })
    expect(out).not.toContain('陆沉(person)：')
  })
})

describe('composeChapterPrompt 段落带宽与文风', () => {
  it('无题材档与文风指纹时回落默认档并明示', () => {
    expect(call()).toContain('未配题材档、用默认档')
  })
  it('文风档案里的否定句被改写为正向陈述', () => {
    const out = call({ book: { styleProfile: '禁绝现代口语说法。' } })
    expect(out).not.toContain('禁绝')
    expect(out).toContain('叙述与对白的说法一律长在本书世界观里')
  })
})

describe('composeChapterPrompt 对话判定', () => {
  it('章纲含对峙词 → 要求来回对话', () => {
    expect(call({ chapterPlan: '41｜两军对峙' })).toContain('来回对话')
  })
  it('独角戏章纲 → 对话可缺省', () => {
    expect(call({ chapterPlan: '41｜独坐观星' })).toContain('独角戏')
  })
})

describe('composeChapterPrompt 前情与摘要', () => {
  it('上一章正文末尾带入前情，且从段落边界切', () => {
    const out = call({ chapters: [{ no: 40, text: '第一段半句\n第二段结尾内容' }] })
    expect(out).toContain('第二段结尾内容')
    expect(out).not.toContain('第一段半句')
  })
  it('首章无前情时给占位', () => {
    expect(call({ chapterNo: 1 })).toContain('(首章无)')
  })
})
