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
  splitChapters,
  anchorForeshadowResolve,
  anchorForeshadows,
  chapterTaskOf,
  reviewTruths,
  chaptersByRhythm,
  volumeRole,
  mapContextFor,
  reapplyReport,
  resampleWeights,
  aliasesOf,
  bibleMissingFields,
  dedupeScenePiece,
  fallbackVolumeEmotion,
  EMOTION_ARCS_GENRE,
  EMOTION_ARCS_TONE,
  volumeStrategyText,
} from './longform.js'
import { volumeSkeletonMessages, consistencyCheckMessages, longFormDraftMessages, chapterSummaryMessages, stateUpdateMessages, chapterRewriteMessages, bibleRationalizeMessages, scenePlanMessages, GENRES, TONES, volumesPlanMessages } from './prompts.js'

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
  it('四幕弧文本（新手写作产物）同样可解析', () => {
    expect(parseVolumeArc('起幕（1-10）→ 发展幕（11-20）→ 冲突幕（21-30）→ 高潮落幕（31-40）')).toEqual([
      { name: '起幕', start: 1, end: 10 },
      { name: '发展幕', start: 11, end: 20 },
      { name: '冲突幕', start: 21, end: 30 },
      { name: '高潮落幕', start: 31, end: 40 },
    ])
  })
  it('不足两段或非法范围返回 null', () => {
    expect(parseVolumeArc('崛起（1-20）')).toBeNull()
    expect(parseVolumeArc('')).toBeNull()
  })
})

describe('splitChapters 导入分章', () => {
  it('按中文章头切分并重排连续章号', () => {
    const text = '第一章 序\n正文一\n第三章 跳号\n正文三\n第三章 重复\n正文重'
    const chs = splitChapters(text)
    expect(chs).toHaveLength(3)
    expect(chs.map((c) => c.no)).toEqual([1, 2, 3])
    expect(chs[0].title).toBe('序')
    expect(chs[0].text).toBe('正文一')
  })
  it('兼容阿拉伯数字章号与冒号', () => {
    const chs = splitChapters('第1章：开端\n内容甲\n第2章 变局\n内容乙')
    expect(chs.map((c) => [c.no, c.title])).toEqual([[1, '开端'], [2, '变局']])
  })
  it('无章头时降级为单章', () => {
    expect(splitChapters('没有章头的纯正文')).toEqual([{ no: 1, title: '', text: '没有章头的纯正文' }])
  })
  it('空文本返回空数组、空正文章被丢弃', () => {
    expect(splitChapters('')).toEqual([])
    expect(splitChapters('第一章 空章\n第二章 有正文\n正文')).toHaveLength(1)
  })
})

describe('anchorForeshadowResolve 回收章锚定', () => {
  const volumes = [
    { volumeNo: 1, startChapter: 1, length: 40 },
    { volumeNo: 2, startChapter: 41, length: 40 },
    { volumeNo: 3, startChapter: 81, length: 40 },
  ]
  it('短层：回收卷内 70% 位置与最短间距取大', () => {
    const project = { volumes }
    expect(anchorForeshadowResolve(project, { tier: '短', plantedChapter: 1, plannedVolume: 1 })).toBe(1 + Math.max(10, Math.floor(40 * 0.7) - 1))
  })
  it('长层：层级间距与回收卷锚点取大', () => {
    const project = { volumes }
    expect(anchorForeshadowResolve(project, { tier: '长', plantedChapter: 5, plannedVolume: 2 })).toBe(Math.max(5 + 150, 41 + Math.floor(40 * 0.7) - 1))
  })
  it('终极层：锚到终卷起始章', () => {
    const project = { volumes }
    expect(anchorForeshadowResolve(project, { tier: '终极', plantedChapter: 3 })).toBe(81)
  })
  it('无卷档案时按层级间距兜底', () => {
    expect(anchorForeshadowResolve({ volumes: [] }, { tier: '中', plantedChapter: 2, plannedVolume: 1 })).toBe(52)
    expect(anchorForeshadowResolve({ volumes: [] }, { tier: '终极', plantedChapter: 2 })).toBe(152)
  })
  it('anchorForeshadows 批量锚定且已锚定的不覆盖', () => {
    const project = {
      volumes,
      foreshadows: [
        { id: 'a', tier: '短', plantedChapter: 1, plannedVolume: 1 },
        { id: 'b', tier: '长', plantedChapter: 2, plannedVolume: 2, resolveAnchored: true, minResolveChapter: 999 },
        { id: 'c', content: '未分层旧数据' },
      ],
    }
    const next = anchorForeshadows(project)
    expect(next.foreshadows[0].resolveAnchored).toBe(true)
    expect(next.foreshadows[0].minResolveChapter).toBeGreaterThan(10)
    expect(next.foreshadows[1].minResolveChapter).toBe(999)
    expect(next.foreshadows[2].resolveAnchored).toBeUndefined()
  })
})

describe('chapterTaskOf 本章核心任务', () => {
  const project = { chapterSkeleton: [{ chapterNo: 3, title: '夜探废宅', task: '发现玉佩异动但不得解释来源' }] }
  it('命中骨架时返回章名+任务', () => {
    const t = chapterTaskOf(project, 3)
    expect(t).toContain('章名：夜探废宅')
    expect(t).toContain('任务：发现玉佩异动但不得解释来源')
  })
  it('未命中（旧书无骨架）返回空串不注入', () => {
    expect(chapterTaskOf(project, 9)).toBe('')
    expect(chapterTaskOf({}, 1)).toBe('')
  })
})

describe('reviewTruths 审核真相对照', () => {
  it('真相层带终卷揭示红线', () => {
    const project = {
      bible: { truths: [{ kind: '金手指真实来源', truth: '系统其实是死去师尊的残魂' }, { kind: '空真相', truth: '' }] },
      volumes: [{ volumeNo: 1, startChapter: 1 }, { volumeNo: 2, startChapter: 100 }],
    }
    const r = reviewTruths(project)
    expect(r).toHaveLength(1)
    expect(r[0].minResolveChapter).toBe(100)
  })
  it('地图分层真相层同样进对照表（红线 = 解锁卷起始章）', () => {
    const project = {
      bible: { truths: [], mapLayers: [{ name: '大乾王朝', truth: '皇室与主角同血脉', unlockVolume: 3 }] },
      volumes: [{ volumeNo: 1, startChapter: 1 }, { volumeNo: 3, startChapter: 200 }],
    }
    const r = reviewTruths(project)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('地图分层真相·大乾王朝')
    expect(r[0].minResolveChapter).toBe(200)
  })
  it('无圣经或无卷档案时安全降级', () => {
    expect(reviewTruths({})).toEqual([])
    expect(reviewTruths({ bible: { truths: [{ kind: 'x', truth: 'y' }] } })[0].minResolveChapter).toBeNull()
  })
})

describe('chaptersByRhythm 分卷节奏切章', () => {
  it('快头肥中快尾：总和严格等于总章数且比例正确', () => {
    const lens = chaptersByRhythm(300, [1, 2, 3, 2, 1, 1])
    expect(lens.reduce((a, b) => a + b, 0)).toBe(300)
    expect(lens).toEqual([30, 60, 90, 60, 30, 30])
  })
  it('余数分配不丢章：非整除时总和仍精确', () => {
    const lens = chaptersByRhythm(167, [1, 2, 3, 2, 1, 1])
    expect(lens.reduce((a, b) => a + b, 0)).toBe(167)
    expect(Math.max(...lens)).toBeLessThanOrEqual(51)
  })
  it('空权重/异常输入安全降级', () => {
    expect(chaptersByRhythm(60, [])).toEqual([])
    expect(chaptersByRhythm(6, [0, 0]).length).toBe(2)
  })
})

describe('volumeRole 卷叙事角色', () => {
  const w = [1, 2, 3, 2, 1, 1]
  it('首卷=开卷，末两卷=收割，中间按权重分腹地深耕/扩张过渡', () => {
    expect(volumeRole(1, w)).toBe('开卷')
    expect(volumeRole(3, w)).toBe('腹地深耕')
    expect(volumeRole(2, w)).toBe('腹地深耕') // 权重 2 > 均值 1.67
    expect(volumeRole(5, w)).toBe('收割')
    expect(volumeRole(6, w)).toBe('收割')
  })
  it('中段轻卷归扩张过渡、重卷归腹地深耕', () => {
    expect(volumeRole(2, [1, 2, 3, 3, 2, 1])).toBe('扩张过渡') // 权重 2 = 均值 2，不高于即过渡
    expect(volumeRole(3, [1, 2, 3, 3, 2, 1])).toBe('腹地深耕') // 权重 3 > 均值 2
  })
  it('无权重时兜底腹地', () => {
    expect(volumeRole(2, [])).toBe('腹地')
  })
})

describe('mapContextFor 地图分层·传闻级隔离', () => {
  const project = {
    bible: {
      mapLayers: [
        { name: '青石城', summary: '开局小城' },
        { name: '云州', summary: '十三城之地', rumor: '据说云州修士如云' },
        { name: '大乾王朝', summary: '王朝腹地', rumor: '老人们说北边有走不出的荒原' },
      ],
    },
    volumes: [
      { volumeNo: 1, startChapter: 1, length: 30, unlockLayer: 1 },
      { volumeNo: 2, startChapter: 31, length: 60, unlockLayer: 2 },
    ],
  }
  it('第1卷：已解锁层可展开 + 下一层只许传闻 + 更高层为禁区，且真相不入上下文', () => {
    const ctx = mapContextFor(project, 5)
    expect(ctx).toContain('青石城：开局小城')
    expect(ctx).toContain('据说云州修士如云')
    expect(ctx).toContain('禁区')
    expect(ctx).toContain('大乾王朝')
    expect(ctx).not.toContain('王朝腹地') // 未解锁层的正式设定不得出现（真相隔离）
  })
  it('第2卷：解锁两层，第三层降为传闻', () => {
    const ctx = mapContextFor(project, 40)
    expect(ctx).toContain('云州：十三城之地')
    expect(ctx).toContain('老人们说北边有走不出的荒原')
    expect(ctx).not.toContain('王朝腹地')
  })
  it('无地图分层时返回空不注入', () => {
    expect(mapContextFor({ bible: {} }, 1)).toBe('')
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
  it('分层统计与长时未动的分层伏笔提醒', () => {
    const proj = {
      chapters: Array.from({ length: 60 }, (_, i) => ({ chapterNo: i + 1 })),
      foreshadows: [
        { content: '短线', status: '未回收', tier: '短', plantedChapter: 55 },
        { content: '长线死伏笔', status: '未回收', tier: '长', plantedChapter: 5 },
        { content: '旧数据', status: '未回收', plantedChapter: 1 },
      ],
    }
    const r = settlementReport(proj)
    expect(r.byTier).toEqual({ 短: 1, 长: 1, 未分层: 1 })
    expect(r.dormantTiered.map((f) => f.content)).toEqual(['长线死伏笔'])
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

describe('consistencyCheckMessages 一致性校验提示词', () => {
  it('明确给出被检章号并禁止猜测性判断', () => {
    const [sys, usr] = consistencyCheckMessages({ world: 'w', characters: [], outline: 'o', foreshadows: [], text: 't', chapterNo: 7 })
    expect(sys.content).toContain('禁止输出')
    expect(sys.content).toContain('本章应写的剧情节点')
    expect(sys.content).toContain('数字/持有物矛盾')
    expect(usr.content).toContain('【被检章节】第 7 章')
    expect(usr.content).toContain('【第 7 章正文】')
  })
})

describe('数字一致性闭环', () => {
  it('章摘要/状态回写要求保留关键数字', () => {
    const [sumSys] = chapterSummaryMessages({ text: 't' })
    expect(sumSys.content).toContain('关键数字')
    const [stSys] = stateUpdateMessages({ characters: [], text: 't' })
    expect(stSys.content).toContain('关键数字')
  })
  it('重写提示词注入人物当前状态（含数字）', () => {
    const [, usr] = chapterRewriteMessages({ chapterNo: 3, title: 't', content: 'c', fixPrompt: 'f', characters: [{ name: '江辰', status: '余额 80 点；临期抑制剂 1 支' }] })
    expect(usr.content).toContain('余额 80 点')
  })
})

describe('longFormDraftMessages 写章提示词', () => {
  it('含信息揭示层级与生理状态连续硬规则', () => {
    const [sys] = longFormDraftMessages({ chapterNo: 3, text: '', tail: '…' })
    expect(sys.content).toContain('信息揭示层级')
    expect(sys.content).toContain('生理与物理状态连续')
  })
})

describe('volumeSkeletonMessages 分卷骨架提示词', () => {
  const vol = { volumeNo: 4, name: '荒野重构', length: 167, startChapter: 501, theme: '荒野立足', conflict: '追杀', location: '荒野', endHook: '容器身份暴露' }
  it('锁定全局章号区间并禁止解释性文字/填充章', () => {
    const sys = volumeSkeletonMessages({ bible: { world: 'w' }, mainline: 'm', volume: vol, volumeCount: 6 })[0].content
    expect(sys).toContain('第 501 章连续编到第 667 章')
    expect(sys).toContain('共 167 章')
    expect(sys).toContain('禁止输出任何解释')
    expect(sys).toContain('严禁单字章名')
    expect(sys).toContain('严禁提前触及大结局')
  })
  it('终卷不再禁止大结局，改为结局余韵', () => {
    const last = { ...vol, volumeNo: 6, startChapter: 901 }
    const sys = volumeSkeletonMessages({ bible: {}, mainline: '', volume: last, volumeCount: 6 })[0].content
    expect(sys).not.toContain('严禁提前触及大结局')
    expect(sys).toContain('结局余韵')
  })
  it('注入上一卷末尾衔接与四幕区间', () => {
    const usr = volumeSkeletonMessages({ bible: {}, mainline: '', volume: vol, volumeCount: 6, prevTail: '第500章 断点', actsText: '起幕=第501-540章' })[1].content
    expect(usr).toContain('第500章 断点')
    expect(usr).toContain('起幕=第501-540章')
  })
})

describe('aliasesOf 别名归一', () => {
  it('数组与逗号分隔字符串都转成数组（修复 aliases.some is not a function）', () => {
    expect(aliasesOf({ aliases: ['小江', '阿辰'] })).toEqual(['小江', '阿辰'])
    expect(aliasesOf({ aliases: '小江，阿辰' })).toEqual(['小江', '阿辰'])
    expect(aliasesOf({ aliases: '小江、阿辰,老三' })).toEqual(['小江', '阿辰', '老三'])
    expect(aliasesOf({ aliases: '' })).toEqual([])
    expect(aliasesOf({})).toEqual([])
  })
})

describe('resampleWeights 节奏模板重采样', () => {
  it('长度相同原样返回', () => {
    expect(resampleWeights([1, 2, 3, 2, 1, 1], 6)).toEqual([1, 2, 3, 2, 1, 1])
  })
  it('6 卷模板采样到 4 卷保持形状且每卷至少 1', () => {
    const w = resampleWeights([1, 2, 3, 2, 1, 1], 4)
    expect(w).toHaveLength(4)
    for (const x of w) expect(x).toBeGreaterThanOrEqual(1)
    // 形状保持：中部权重不低于两端（肥中特征不丢）
    expect(Math.max(w[1], w[2])).toBeGreaterThanOrEqual(w[3])
  })
  it('采样到 8 卷时峰值卷仍是最大权重', () => {
    const w = resampleWeights([1, 2, 3, 2, 1, 1], 8)
    expect(w).toHaveLength(8)
    expect(Math.max(...w)).toBeGreaterThan(Math.min(...w))
  })
})

describe('reapplyReport 重写后重建档案', () => {
  const mkProject = () => ({
    rollingSummary: '旧摘要',
    chapters: [{ chapterNo: 3, title: '旧', content: '旧文', summary: '旧章摘要', issues: [{ type: '旧', description: '旧问题' }], issueCount: 1 }],
    characters: [{ name: '江辰', aliases: [], status: '' }],
    chronicles: {},
    events: [],
    foreshadows: [{ id: 'f1', content: '伏笔', status: '未回收' }],
    storylines: [],
  })
  it('重写版报告刷新章摘要/一致性问题', () => {
    const report = { summary: '新摘要', pov: '江辰', issues: [{ type: '设定', description: '新问题' }], updates: [], newCharacters: [], events: [], newForeshadows: [], resolved: [], mentioned: [], storylines: [], rolling: '' }
    const { project: next } = reapplyReport(mkProject(), 3, report)
    const ch = next.chapters.find((c) => c.chapterNo === 3)
    expect(ch.summary).toBe('新摘要')
    expect(ch.issues).toHaveLength(1)
    expect(ch.issues[0].description).toBe('新问题')
    expect(ch.issueCount).toBe(1)
  })
  it('人物别名为字符串时状态回写不报错（修复重写归档崩溃）', () => {
    const p = mkProject()
    p.characters = [{ name: '江辰', aliases: '小江，拾荒者', status: '' }]
    const report = { summary: 's', pov: '', issues: [], updates: [{ name: '小江', change: '获得新能力' }], newCharacters: [], events: [], newForeshadows: [], resolved: [], mentioned: [], storylines: [], rolling: '' }
    const { project: next } = reapplyReport(p, 3, report)
    expect(next.characters[0].status).toContain('获得新能力')
  })
  it('非最新章重跑不污染滚动摘要，最新章则刷新', () => {
    const base = mkProject()
    base.chapters.push({ chapterNo: 5, title: '后', content: '后文', summary: '', issues: [] })
    const report = { summary: 's', issues: [], updates: [], newCharacters: [], events: [], newForeshadows: [], resolved: [], mentioned: [], storylines: [], rolling: '新滚动' }
    expect(reapplyReport(base, 3, report).project.rollingSummary).toBe('旧摘要')
    expect(reapplyReport(base, 5, report).project.rollingSummary).toBe('新滚动')
  })
})

describe('圣经字段缺失兜底（防模型漏输出 power_rules/map_layers）', () => {
  it('缺任一字段或空数组均判不合格', () => {
    expect(bibleMissingFields(null)).toBe(true)
    expect(bibleMissingFields({ power_rules: ['规则'], map_layers: [{ name: '开局之地' }] })).toBe(false)
    expect(bibleMissingFields({ power_rules: [], map_layers: [{ name: '开局之地' }] })).toBe(true)
    expect(bibleMissingFields({ power_rules: ['规则'], map_layers: [] })).toBe(true)
    expect(bibleMissingFields({ power_rules: ['规则'], map_layers: [{ summary: '无名层' }] })).toBe(true)
  })
  it('圣经提示词带字段完整性硬要求', () => {
    const sys = bibleRationalizeMessages({ brief: '测试', truthKinds: ['世界真相'] })[0].content
    expect(sys).toContain('字段完整性')
    expect(sys).toContain('严禁输出空数组或省略字段')
  })
})

describe('场景清单下限与写章节点纪律（防单场景退化/抢情节）', () => {
  it('场景规划提示词带 3~5 个硬下限与末场景落点约束', () => {
    const sys = scenePlanMessages({ chapterNo: 3, characters: [{ name: '陆行' }] })[0].content
    expect(sys).toContain('少于 3 个视为不合格')
    expect(sys).toContain('scenes 必须为 3~5 项')
  })
  it('场景数随每章目标字数自适应：短章 2~3、默认 3~5', () => {
    expect(scenePlanMessages({ chapterNo: 3, characters: [{ name: '陆行' }], chapterWords: 1200 })[0].content).toContain('2~3 个场景')
    expect(scenePlanMessages({ chapterNo: 3, characters: [{ name: '陆行' }] })[0].content).toContain('3~5 个场景')
  })
  it('写章提示词带先写足再止步于本章最后节点的双向纪律', () => {
    const sys = longFormDraftMessages({ chapterNo: 3, tail: '前文' })[0].content
    expect(sys).toContain('先完整写到本章细纲/核心任务的最后一个剧情节点')
    expect(sys).toContain('然后止步于该节点')
    expect(sys).toContain('不得把它挪给下一章')
  })
  it('多场景段带禁止复述前文尾部的硬约束', () => {
    const multi = longFormDraftMessages({ chapterNo: 3, tail: '前', multiScene: true, scenePlan: '场景' })[0].content
    expect(multi).toContain('本段一个字都不得再现')
    const single = longFormDraftMessages({ chapterNo: 3, tail: '前' })[0].content
    expect(single).not.toContain('本段一个字都不得再现')
  })
  it('逐场景拼接去重：新段开头复述已有正文的段落被丢弃', () => {
    const base = '第一段正文内容足够长。\n\n他慢慢收回手，寒意径直钻进骨头缝里。'
    const piece = '他慢慢收回手，寒意径直钻进骨头缝里。\n\n新的剧情从这里开始展开。'
    expect(dedupeScenePiece(base, piece)).toBe('新的剧情从这里开始展开。')
    // 无重复时原样返回；空 base 不去重
    expect(dedupeScenePiece(base, '全新段落不重复。')).toBe('全新段落不重复。')
    expect(dedupeScenePiece('', piece)).toBe(piece.trim())
  })
  it('逐场景拼接去重：新段中部与已有正文完全相同的长段落也被剔除', () => {
    const longPara = '回到住处时天还没亮透，推开门屋里弥漫着一股淡淡的甜腥味，混着灰尘和陈旧木料的气息。'
    const base = `第一段内容。\n\n${longPara}`
    const piece = `新的开头段落从这里写起。\n\n${longPara}\n\n后续全新的剧情发展。`
    expect(dedupeScenePiece(base, piece)).toBe('新的开头段落从这里写起。\n\n后续全新的剧情发展。')
  })
  it('末场景段携带强制收束指令，非末场景不带', () => {
    const last = longFormDraftMessages({ chapterNo: 3, tail: '前', multiScene: true, scenePlan: '场景', lastScene: true })[1].content
    const mid = longFormDraftMessages({ chapterNo: 3, tail: '前', multiScene: true, scenePlan: '场景' })[1].content
    expect(last).toContain('末场景强制收束')
    expect(last).toContain('止步自检')
    expect(mid).not.toContain('末场景强制收束')
  })
  it('止步自检规则10与场景清单终点硬约束', () => {
    const sys = longFormDraftMessages({ chapterNo: 3, tail: '前' })[0].content
    expect(sys).toContain('落笔前止步自检')
    expect(sys).toContain('不得以静态的环境描写或被动观望收尾')
    const plan = scenePlanMessages({ chapterNo: 3, characters: [] })[0].content
    expect(plan).toContain('精确停在【本章对应细纲】的最后一个剧情节点上')
  })
  it('写章提示词带道具原名/言行守定位/章末悬念/反应义务四条约束', () => {
    const sys = longFormDraftMessages({ chapterNo: 3, tail: '前文' })[0].content
    expect(sys).toContain('必须使用细纲原名')
    expect(sys).toContain('严禁表现超出定位的能力')
    expect(sys).toContain('严禁平铺直叙收尾')
    expect(sys).toContain('反应义务')
  })
  it('重写提示词要求指令问题逐一修掉不残留', () => {
    const sys = chapterRewriteMessages({ chapterNo: 3, title: '测', content: '文', fixPrompt: '改A' })[0].content
    expect(sys).toContain('逐一修掉')
    expect(sys).toContain('不得残留指令中列出的任何问题')
  })
})

describe('卷级情感走向（题材×基调库 + 确定性兜底 + 写作注入）', () => {
  it('库覆盖全部 20 题材与 5 基调，每类 1~3 条且均为 4 拍以上（→ 分隔）', () => {
    for (const g of GENRES) {
      const list = EMOTION_ARCS_GENRE[g]
      expect(Array.isArray(list), `题材「${g}」缺情感走向`).toBe(true)
      expect(list.length).toBeGreaterThanOrEqual(1)
      expect(list.length).toBeLessThanOrEqual(3)
      for (const a of list) expect(a.split('→').length).toBeGreaterThanOrEqual(4)
    }
    for (const t of TONES) {
      const list = EMOTION_ARCS_TONE[t]
      expect(Array.isArray(list), `基调「${t}」缺情感走向`).toBe(true)
      expect(list.length).toBeGreaterThanOrEqual(1)
      expect(list.length).toBeLessThanOrEqual(3)
    }
  })
  it('兜底选择器：非空、跳过已用、卷间轮转不撞车', () => {
    const first = fallbackVolumeEmotion({ genre: '末世', volumeNo: 1 })
    expect(first).toBeTruthy()
    // 已用的不会再被选中（池子足够时）
    const second = fallbackVolumeEmotion({ genre: '末世', volumeNo: 2, used: [first] })
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    // 6 卷连续选，库内无重复（末世题材 2 条 + 默认基调池）
    const used = []
    for (let i = 1; i <= 4; i++) {
      const e = fallbackVolumeEmotion({ genre: '末世', tone: '暗黑沉重', volumeNo: i, used })
      used.push(e)
    }
    expect(new Set(used).size).toBe(used.length)
  })
  it('卷结构提示词要求逐卷生成情感走向且卷间不重复', () => {
    const sys = volumesPlanMessages({ bible: { world: '世' }, mainline: '线', volumeCount: 3, lengths: [10, 10, 10], roles: [], genre: '末世', tone: '暗黑沉重' })[0].content
    expect(sys).toContain('emotion')
    expect(sys).toContain('根据本卷自己的故事走向')
    expect(sys).toContain('各卷不得重复')
    expect(sys).toContain('题材为「末世」')
  })
  it('写章注入：卷情感走向随卷战略进入写作上下文', () => {
    const proj = { volumes: [{ volumeNo: 1, name: '卷', strategy: '战略', startChapter: 1, length: 20, emotion: '压抑→憋屈→爆发→短暂喘息' }], chapters: [], foreshadows: [], bible: null }
    const text = volumeStrategyText(proj, 3)
    expect(text).toContain('情感走向：压抑→憋屈→爆发→短暂喘息')
  })
})
