// 构思层 6 agent 测试：
// ① 纯函数（planPacing 节奏分配守恒 / actsToArc / volumeArcText）直接验证；
// ② LLM 编排（Storyliner 分段拼合、Structurer 解析兜底、Muse/Worldsmith/Stylist 解析）用 vi.mock 桩验证。
// mock 只覆盖 llm.js 的 chatStream/chatJSON，保留 ANTI_REPETITION 等真实常量（importOriginal 展开）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../llm.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, chatStream: vi.fn(), chatJSON: vi.fn(), glmChatJSON: vi.fn() }
})

import { chatStream, chatJSON } from '../llm.js'
import { STORYLINE_SEGMENTS } from '../prompts.js'
import { structurerAgent, planPacing, actsToArc } from '../agents/structurerAgent.js'
import { volumeArcText, outlinerAgent } from '../agents/outlinerAgent.js'
import { storylinerAgent } from '../agents/storylinerAgent.js'
import { museAgent } from '../agents/museAgent.js'
import { worldsmithAgent } from '../agents/worldsmithAgent.js'
import { stylistAgent } from '../agents/stylistAgent.js'

beforeEach(() => vi.clearAllMocks())

describe('Structurer planPacing：节奏分配守恒（§15）', () => {
  it('各卷章数之和严格 === 总章数（最大余数法，不多不少）', () => {
    const r = planPacing({ totalWords: 100, chapterWords: 2000, volumeCount: 6, rhythm: '快头肥中快尾' })
    expect(r.totalChapters).toBe(500) // 100 万字 / 2000 字每章
    expect(r.lengths.reduce((a, b) => a + b, 0)).toBe(r.totalChapters)
    expect(r.lengths).toHaveLength(6)
    expect(r.roles).toHaveLength(6)
    expect(r.volumeLength).toBeGreaterThan(0)
  })
  it('多种卷数 / 字数组合都守恒', () => {
    for (const vc of [3, 4, 7, 12]) {
      const r = planPacing({ totalWords: 200, chapterWords: 2500, volumeCount: vc, rhythm: '快头肥中快尾' })
      expect(r.lengths.reduce((a, b) => a + b, 0)).toBe(r.totalChapters)
      expect(r.lengths).toHaveLength(vc)
    }
  })
  it('未知节奏模板回退默认形状，仍守恒不崩', () => {
    const r = planPacing({ totalWords: 50, chapterWords: 2000, volumeCount: 5, rhythm: '不存在的模板' })
    expect(r.lengths.reduce((a, b) => a + b, 0)).toBe(r.totalChapters)
  })
})

describe('Structurer actsToArc / Outliner volumeArcText：arc 文案', () => {
  it('actsToArc 生成 parseVolumeArc 可反解的坐标格式', () => {
    expect(actsToArc([{ act: '起幕', start: 1, end: 5 }, { act: '发展幕', start: 6, end: 12 }]))
      .toBe('起幕(第1-5章)→发展幕(第6-12章)')
  })
  it('volumeArcText 无幕时只返回卷头', () => {
    expect(volumeArcText({ volumeNo: 2, length: 20, arc: '' })).toBe('第2卷（第1-20章，章号为卷内坐标）')
  })
  it('volumeArcText 有幕时附起承转合区间（卷内坐标）', () => {
    const t = volumeArcText({ volumeNo: 1, length: 20, arc: actsToArc([{ act: '起幕', start: 1, end: 5 }, { act: '承幕', start: 6, end: 12 }]) })
    expect(t).toContain('第1卷（第1-20章')
    expect(t).toContain('起幕=第1-5章')
    expect(t).toContain('承幕=第6-12章')
  })
})

describe('Storyliner 分段拼合（§15）', () => {
  it('按 5 段顺序生成、空行拼合、累计字数、逐段回调 onSegment', async () => {
    chatStream.mockImplementation(() => Promise.resolve('叙事段落' + 'x'.repeat(100)))
    const seen = []
    const { storyline, segments, wordCount } = await storylinerAgent.run({
      apiKey: 'k', brief: 'b', genre: '玄幻', bible: { world: 'w' }, totalWords: 100, volumeCount: 6,
      onSegment: (s) => seen.push(s),
    })
    expect(chatStream).toHaveBeenCalledTimes(STORYLINE_SEGMENTS.length)
    expect(segments).toHaveLength(STORYLINE_SEGMENTS.length)
    expect(segments.map((s) => s.id)).toEqual(STORYLINE_SEGMENTS.map((s) => s.id))
    expect(wordCount).toBe(storyline.length)
    expect(storyline.split('\n\n')).toHaveLength(STORYLINE_SEGMENTS.length)
    expect(seen).toHaveLength(STORYLINE_SEGMENTS.length)
    // onSegment 累计字数单调递增
    for (let i = 1; i < seen.length; i++) expect(seen[i].wordCount).toBeGreaterThan(seen[i - 1].wordCount)
  })
  it('后段 prompt 携带前文（prevText）以保证连贯', async () => {
    chatStream.mockImplementation(() => Promise.resolve('连贯内容' + 'y'.repeat(80)))
    await storylinerAgent.run({ apiKey: 'k', bible: {} })
    const lastMessages = chatStream.mock.calls[STORYLINE_SEGMENTS.length - 1][0].messages
    expect(JSON.stringify(lastMessages)).toContain('y'.repeat(40))
  })
  it('signal 已 abort：不发起任何生成，返回空故事线', async () => {
    const ac = new AbortController(); ac.abort()
    const { storyline, segments } = await storylinerAgent.run({ apiKey: 'k', bible: {}, signal: ac.signal })
    expect(chatStream).not.toHaveBeenCalled()
    expect(storyline).toBe('')
    expect(segments).toHaveLength(0)
  })
  it('空白段被跳过，不污染拼合结果', async () => {
    chatStream
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('   ')
      .mockResolvedValue('有效段落')
    const { segments, storyline } = await storylinerAgent.run({ apiKey: 'k', bible: {} })
    expect(segments).toHaveLength(STORYLINE_SEGMENTS.length - 2)
    expect(storyline.split('\n\n')).toHaveLength(STORYLINE_SEGMENTS.length - 2)
  })
})

describe('Structurer runVolumes / runActs：解析 + 兜底', () => {
  it('runVolumes：解析卷、emotion 兜底、startChapter 顺序累加、length 用节奏分配', async () => {
    chatJSON.mockResolvedValue({ volumes: [
      { volume_no: 1, name: '卷一', emotion: '燃' },
      { volume_no: 2, name: '卷二' }, // 缺 emotion → 兜底
    ] })
    const { volumes } = await structurerAgent.runVolumes({
      apiKey: 'k', bible: {}, mainline: 'm', volumeCount: 2, lengths: [10, 12], roles: ['开局', '发展'], genre: '玄幻', volumeLength: 20,
    })
    expect(volumes).toHaveLength(2)
    expect(volumes[0]).toMatchObject({ volumeNo: 1, startChapter: 1, length: 10, emotion: '燃' })
    expect(volumes[1].startChapter).toBe(11) // 1 + 10
    expect(volumes[1].length).toBe(12)
    expect(volumes[1].emotion).toBeTruthy() // 兜底非空
    expect(volumes[0].acts).toEqual([])
  })
  it('runActs：解析幕并回 arc/role；空数组抛错', async () => {
    chatJSON.mockResolvedValue({ acts: [{ act: '起幕', start: 1, end: 5, goal: 'g' }, { act: '承幕', start: 6, end: 12 }] })
    const { acts, arc, role } = await structurerAgent.runActs({ apiKey: 'k', volume: { volumeNo: 1 }, mainline: 'm', weights: [1, 1, 1] })
    expect(acts).toHaveLength(2)
    expect(arc).toContain('起幕(第1-5章)')
    expect(role).toBeTruthy()
    chatJSON.mockResolvedValue({ acts: [] })
    await expect(structurerAgent.runActs({ apiKey: 'k', volume: { volumeNo: 1 }, mainline: 'm', weights: [1, 1, 1] })).rejects.toThrow()
  })
})

describe('Muse run / expand', () => {
  it('run 过滤掉无 brief 的灵感项', async () => {
    chatJSON.mockResolvedValue({ ideas: [{ title: 'a', brief: 'x' }, { title: 'b' }, null, { title: 'c', brief: 'y' }] })
    const { ideas } = await museAgent.run({ apiKey: 'k', genre: '玄幻', worldview: '', tropes: [] })
    expect(ideas).toHaveLength(2)
  })
  it('expand 返回 brief 字符串', async () => {
    chatJSON.mockResolvedValue({ brief: '扩充后的 brief' })
    const { brief } = await museAgent.expand({ apiKey: 'k', brief: '原', genre: '玄幻', worldview: '' })
    expect(brief).toBe('扩充后的 brief')
  })
})

describe('Worldsmith runWorldview', () => {
  it('调 bookWorldviewMessages + chatJSON 返回解析结果', async () => {
    chatJSON.mockResolvedValue({ factions: [{ name: 'F' }], conflicts: [] })
    const res = await worldsmithAgent.runWorldview({ apiKey: 'k', brief: 'b', bible: {}, volumeCount: 6, worldviewTemplate: 't' })
    expect(res.factions).toHaveLength(1)
  })
})

describe('Stylist distillOne / blend', () => {
  const sample = Array.from({ length: 40 }, (_, i) => `第${i}段：他走进屋子，看见桌上放着一封信。窗外雨声淅沥，他坐下，缓缓拆开信封，指尖微凉。`).join('\n\n')
  it('蒸馏出含 profile/habits/metrics 的文风档案', async () => {
    chatJSON.mockResolvedValue({ style_profile: '冷峻白描', habits: ['爱用短句'], samples: ['句一', '句二', '句三', '句四'] })
    const rec = await stylistAgent.distillOne({ apiKey: 'k', text: sample, bookId: 'b1' })
    expect(rec.bookId).toBe('b1')
    expect(rec.profile).toBe('冷峻白描')
    expect(rec.origin).toBe('user')
    expect(Array.isArray(rec.habits)).toBe(true)
    expect(rec.samples.length).toBeLessThanOrEqual(3)
    expect(rec.metrics).toBeTruthy()
    expect(typeof rec.bandReliable).toBe('boolean')
    expect(typeof rec.updatedAt).toBe('number')
  })
  it('blend 是纯函数（单份原样、空返回 null）', () => {
    expect(stylistAgent.blend([])).toBeNull()
    const one = { bookId: 'x', profile: 'p', metrics: {}, habits: [] }
    expect(stylistAgent.blend([one])).toBeTruthy()
  })
})

describe('Outliner runVolumeOutline：防剧透只喂本卷骨架', () => {
  it('流式回写 onDelta 并返回 outline', async () => {
    chatStream.mockImplementation(({ onDelta }) => { onDelta && onDelta('细纲全文'); return Promise.resolve('细纲全文') })
    const deltas = []
    const { outline } = await outlinerAgent.runVolumeOutline({
      apiKey: 'k', bible: {}, volume: { volumeNo: 1, startChapter: 1, length: 5 },
      chapterSkeleton: [{ chapterNo: 1, title: 't1', task: 'x' }], skeleton: '1. t1',
      onDelta: (t) => deltas.push(t),
    })
    expect(outline).toBe('细纲全文')
    expect(deltas).toContain('细纲全文')
  })
})
