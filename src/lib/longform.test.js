// 核心纯函数单测（vitest）：只覆盖不依赖网络/IndexedDB 的引擎函数
import { describe, it, expect } from 'vitest'
import {
  cnToNumber,
  outlineForChapter,
  outlineMaxChapter,
  parseVolumeArc,
  chunkText,
  bigramDice,
  hookCheck,
  properNounScan,
  settlementReport,
  buildCrossReviewInput,
  exportBookText,
} from './longform.js'

describe('cnToNumber 中文数字解析', () => {
  it('阿拉伯数字与单个汉字数字', () => {
    expect(cnToNumber('12')).toBe(12)
    expect(cnToNumber('三')).toBe(3)
    expect(cnToNumber('两')).toBe(2)
    expect(cnToNumber('零')).toBe(0)
  })
  it('十位与百位组合', () => {
    expect(cnToNumber('十')).toBe(10)
    expect(cnToNumber('二十三')).toBe(23)
    expect(cnToNumber('一百零五')).toBe(105)
    expect(cnToNumber('三百二十')).toBe(320)
  })
  it('无效输入返回 NaN', () => {
    expect(Number.isNaN(cnToNumber('abc'))).toBe(true)
    expect(Number.isNaN(cnToNumber(''))).toBe(true)
  })
})

describe('outlineForChapter 细纲按需注入', () => {
  const outline = ['第一章 开头', '内容A', '第二章 发展', '内容B', '第三章 转折', '内容C', '第四章 高潮', '内容D'].join('\n')
  it('只注入本章及后续窗口', () => {
    const got = outlineForChapter(outline, 2)
    expect(got).toContain('第二章')
    expect(got).toContain('第四章')
    expect(got).not.toContain('第一章')
  })
  it('细纲耗尽时返回空串而不是全量', () => {
    expect(outlineForChapter(outline, 10)).toBe('')
  })
  it('无章头细纲降级全量注入', () => {
    expect(outlineForChapter('随便写的细纲', 3)).toBe('随便写的细纲')
  })
  it('outlineMaxChapter 覆盖最大章号', () => {
    expect(outlineMaxChapter(outline)).toBe(4)
    expect(outlineMaxChapter('无章头')).toBe(0)
  })
})

describe('parseVolumeArc 卷弧线解析', () => {
  it('解析多段章号范围', () => {
    expect(parseVolumeArc('崛起（1-20）→ 争锋（21-45）')).toEqual([
      { name: '崛起', start: 1, end: 20 },
      { name: '争锋', start: 21, end: 45 },
    ])
  })
  it('不足两段或非法范围返回 null', () => {
    expect(parseVolumeArc('崛起（1-20）')).toBeNull()
    expect(parseVolumeArc('')).toBeNull()
  })
})

describe('chunkText 正文切块', () => {
  it('短段落聚合为一块', () => {
    expect(chunkText('甲段。\n乙段。', 100)).toEqual(['甲段。\n乙段。'])
  })
  it('超长段落硬切', () => {
    const chunks = chunkText('字'.repeat(25), 10)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(10)
    expect(chunks[2]).toHaveLength(5)
  })
  it('确定性：同文同切', () => {
    const text = '第一段内容。\n第二段内容。\n第三段内容。'
    expect(chunkText(text, 12)).toEqual(chunkText(text, 12))
  })
  it('空文本返回空数组', () => {
    expect(chunkText('', 400)).toEqual([])
  })
})

describe('bigramDice 二元组相似度', () => {
  it('相同文本为 1', () => {
    expect(bigramDice('他推开了门。', '他推开了门。')).toBe(1)
  })
  it('无关文本趋近 0', () => {
    expect(bigramDice('今天天气不错', '剑光如虹斩落')).toBeLessThan(0.15)
  })
  it('过短文本返回 0', () => {
    expect(bigramDice('a', 'b')).toBe(0)
  })
})

describe('hookCheck 章末钩子检查', () => {
  it('悬念标点收尾通过', () => {
    expect(hookCheck('他缓缓转过身，看到的竟然是……').ok).toBe(true)
  })
  it('平铺直叙句号收尾不通过', () => {
    const r = hookCheck('这一天过得很平静。大家都回家吃饭了。他也就这样睡下了。')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
  it('空文本直接通过', () => {
    expect(hookCheck('').ok).toBe(true)
  })
})

describe('properNounScan 专名错字扫描', () => {
  const characters = [{ name: '林峰', aliases: [] }]
  it('出现两次的一字之差变体被报出', () => {
    const text = `林峰走进大厅，${'旁白'.repeat(20)}。林锋随后也跟了进来，众人的目光都落在了林锋身上。`
    const hits = properNounScan(text, characters)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].candidate).toBe('林锋')
    expect(hits[0].likely).toBe('林峰')
    expect(hits[0].count).toBeGreaterThanOrEqual(2)
  })
  it('本名不误报、偶发单字重合不报', () => {
    expect(properNounScan(`林峰走进大厅，${'旁白'.repeat(30)}。`, characters)).toEqual([])
  })
})

describe('settlementReport 完稿对账', () => {
  const project = {
    chapters: Array.from({ length: 30 }, (_, i) => ({ chapterNo: i + 1, wordCount: 2000, createdAt: 0 })),
    foreshadows: [
      { content: '神秘玉佩', status: '未回收', plantedChapter: 5 },
      { content: '刚埋的线', status: '未回收', plantedChapter: 28 },
      { content: '已回收', status: '已回收', plantedChapter: 1 },
    ],
    storylines: [
      { name: '复仇主线', type: '主线', lastChapter: 1 },
      { name: '感情支线', type: '支线', lastChapter: 6 },
    ],
    characters: [{ name: '老王', aliases: [] }],
    chronicles: { 老王: [{ chapter: 8, text: '经历' }] },
  }
  it('超期伏笔 / 休眠支线 / 失联人物各归其位', () => {
    const r = settlementReport(project)
    expect(r.current).toBe(30)
    expect(r.overdueHooks.map((f) => f.content)).toEqual(['神秘玉佩'])
    expect(r.staleStorylines.map((s) => s.name)).toEqual(['感情支线'])
    expect(r.dormantChars.map((c) => c.name)).toEqual(['老王'])
  })
})

describe('buildCrossReviewInput 抽章交叉审核', () => {
  const mkProject = (n) => ({
    world: '世界',
    rollingSummary: '滚动摘要',
    events: [],
    characters: [],
    foreshadows: [],
    chapters: Array.from({ length: n }, (_, i) => ({ chapterNo: i + 1, summary: `摘要${i + 1}`, content: `正文${i + 1}` })),
  })
  it('章节不足 6 章返回 null', () => {
    expect(buildCrossReviewInput(mkProject(5))).toBeNull()
  })
  it('8 章时窗口 = 2 个早期抽样章 + 最近 3 章', () => {
    const input = buildCrossReviewInput(mkProject(8))
    expect(input.cross).toBe(true)
    expect(input.chapters.map((c) => c.chapterNo)).toContain(8)
    expect(input.chapters).toHaveLength(5)
    for (const no of input.sampled) expect(no).toBeLessThan(6)
  })
})

describe('exportBookText 成书导出', () => {
  const project = {
    name: '测试书',
    volumes: [{ id: 'v1', volumeNo: 1, name: '起源', startChapter: 1 }],
    chapters: [
      { chapterNo: 2, title: '第二章 风起', content: '正文二' },
      { chapterNo: 1, title: '第一章 序', content: '正文一' },
    ],
  }
  it('TXT 按章号排序、剥离章前缀、插入卷头', () => {
    const txt = exportBookText(project)
    expect(txt.indexOf('正文一')).toBeLessThan(txt.indexOf('正文二'))
    expect(txt).toContain('第1章 序')
    expect(txt).toContain('═══')
    expect(txt).toContain('第1卷 起源')
  })
  it('Markdown 含书名标题与层级', () => {
    const md = exportBookText(project, { format: 'md' })
    expect(md).toContain('# 测试书')
    expect(md).toContain('## 第1卷 起源')
    expect(md).toContain('### 第2章 风起')
  })
  it('关闭卷分隔时不插卷头', () => {
    expect(exportBookText(project, { withVolumes: false })).not.toContain('起源')
  })
})
